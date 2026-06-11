import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Underline } from "@tiptap/extension-underline";
import { TextAlign } from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { FontFamily } from "@tiptap/extension-font-family";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Placeholder } from "@tiptap/extension-placeholder";
import { FontSize, LineHeight, Indent } from "./tiptap-extensions";
import { useTranslation } from "../../hooks/useTranslation";
import type { ReferenceEntry } from "../../stores/fileStore";
import "./TipTapEditor.css";

declare module "@tiptap/core" {
  interface Storage {
    markdown: {
      getMarkdown(): string;
    };
  }
}

export type TipTapEditorHandle = {
  getEditor: () => ReturnType<typeof useEditor>;
  getMarkdown: () => string;
  getHTML: () => string;
  getJSON: () => any;
  getSerializedContent: () => string;
  getText: () => string;
  getSelectionText: () => string;
  insertText: (text: string) => void;
  insertMarkdown: (markdown: string) => void;
  replaceSelection: (text: string) => void;
  focus: () => void;
  scrollToSelection: () => void;
  clearCachedSelection: () => void;
};

export type TipTapContentFormat = "markdown" | "html" | "plainText" | "docx";

export type TipTapSelectionInfo = {
  text: string;
  from: number;
  to: number;
};

export interface TipTapEditorProps {
  content: string;
  onChange?: (content: string) => void;
  onSelectionChange?: (selection: TipTapSelectionInfo | null) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  editable?: boolean;
  placeholder?: string;
  contentFormat?: TipTapContentFormat;
  pageViewMode?: boolean;
  referenceEntries?: ReferenceEntry[];
  onEditorStateChange?: (editor: Editor) => void;
  locked?: boolean;
  lockedMessage?: string;
}

type ReferenceSuggestionState = {
  token: string;
  from: number;
  to: number;
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "top" | "bottom";
  selectedIndex: number;
  items: ReferenceEntry[];
};

type SuppressedReferenceToken = {
  token: string;
  from: number;
  to: number;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sanitizeClipboardHtml = (html: string) => {
  const documentRef = window.document;
  const container = documentRef.createElement("div");
  container.innerHTML = html;

  container.querySelectorAll<HTMLElement>("*").forEach((element) => {
    element.style.removeProperty("font-family");
    element.style.removeProperty("font-size");
    element.removeAttribute("class");
    if (!element.getAttribute("style")?.trim()) {
      element.removeAttribute("style");
    }
  });

  container.querySelectorAll("span").forEach((span) => {
    if (span.attributes.length > 0) return;
    span.replaceWith(...Array.from(span.childNodes));
  });

  return container.innerHTML;
};

const getEditorSelectionClipboardContent = (view: EditorView) => {
  const { state } = view;
  const { from, to } = state.selection;
  const text = from === to ? "" : state.doc.textBetween(from, to, "\n\n", "\n");
  const fragment = state.selection.content().content;
  const container = view.dom.ownerDocument.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(state.schema).serializeFragment(fragment));
  return {
    text,
    html: sanitizeClipboardHtml(container.innerHTML),
  };
};

type CachedSelectionRange = { from: number; to: number } | null;

const cachedSelectionKey = new PluginKey<CachedSelectionRange>("cached-selection-highlight");

const CachedSelectionHighlight = Extension.create({
  name: "cachedSelectionHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<CachedSelectionRange>({
        key: cachedSelectionKey,
        state: {
          init: () => null,
          apply(transaction, previous) {
            const meta = transaction.getMeta(cachedSelectionKey) as CachedSelectionRange | undefined;
            if (meta !== undefined) return meta;
            if (transaction.docChanged) return null;
            return previous;
          },
        },
        props: {
          decorations(state) {
            const range = cachedSelectionKey.getState(state);
            if (!range || range.from === range.to) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, { class: "cached-selection-highlight" }),
            ]);
          },
        },
      }),
    ];
  },
});

const setCachedSelectionHighlight = (editor: Editor | null | undefined, range: CachedSelectionRange) => {
  if (!editor) return;
  editor.view.dispatch(editor.state.tr.setMeta(cachedSelectionKey, range));
};

export const plainTextToEditorHtml = (value: string) => {
  const normalized = value.replace(/\r\n?/g, "\n");
  if (!normalized) return "";

  return normalized
    .split("\n")
    .map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
    .join("");
};

const parseJsonContent = (value: string) => {
  try {
    return JSON.parse(value);
  } catch {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
};

const getEditorContent = (value: string, format: TipTapContentFormat) => {
  if (format === "plainText" || format === "markdown") return plainTextToEditorHtml(value);
  if (format === "docx") return parseJsonContent(value);
  return value;
};

type ProseMirrorJsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: ProseMirrorJsonNode[];
};

const textFromNode = (node: ProseMirrorJsonNode): string => {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (!Array.isArray(node.content)) return "";
  return node.content.map(textFromNode).join("");
};

export const serializeEditorPlainText = (editor: ReturnType<typeof useEditor>) => {
  if (!editor) return "";
  const json = editor.getJSON();
  if (!Array.isArray(json.content)) return "";

  return json.content
    .map((node: any) => textFromNode(node))
    .join("\n");
};

const escapeMarkdownTableCell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

const renderInlineMarkdown = (node: ProseMirrorJsonNode): string => {
  if (!node) return "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "text") {
    let text = node.text ?? "";
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") text = `**${text}**`;
      if (mark.type === "italic") text = `*${text}*`;
      if (mark.type === "strike") text = `~~${text}~~`;
      if (mark.type === "code") text = `\`${text.replace(/`/g, "\\`")}\``;
      if (mark.type === "link" && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`;
    }
    return text;
  }
  if (!Array.isArray(node.content)) return "";
  return node.content.map(renderInlineMarkdown).join("");
};

const renderListMarkdown = (node: ProseMirrorJsonNode, ordered: boolean) => {
  if (!Array.isArray(node.content)) return "";
  return node.content.map((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const content = (item.content ?? [])
      .map((child) => serializeMarkdownBlock(child))
      .join("\n")
      .split("\n")
      .map((line, lineIndex) => (lineIndex === 0 ? `${marker}${line}` : `  ${line}`))
      .join("\n");
    return content;
  }).join("\n");
};

const serializeMarkdownBlock = (node: ProseMirrorJsonNode): string => {
  if (!node) return "";
  if (node.type === "paragraph") return Array.isArray(node.content) ? node.content.map(renderInlineMarkdown).join("") : "";
  if (node.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
    return `${"#".repeat(level)} ${Array.isArray(node.content) ? node.content.map(renderInlineMarkdown).join("") : ""}`;
  }
  if (node.type === "blockquote") {
    const content = (node.content ?? []).map(serializeMarkdownBlock).join("\n");
    return content.split("\n").map((line) => `> ${line}`).join("\n");
  }
  if (node.type === "codeBlock") return `\`\`\`\n${textFromNode(node)}\n\`\`\``;
  if (node.type === "bulletList" || node.type === "taskList") return renderListMarkdown(node, false);
  if (node.type === "orderedList") return renderListMarkdown(node, true);
  if (node.type === "horizontalRule") return "---";
  if (node.type === "image") return `![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`;
  if (node.type === "table") {
    const rows = node.content ?? [];
    return rows.map((row, rowIndex) => {
      const cells = (row.content ?? []).map((cell) => ` ${escapeMarkdownTableCell(textFromNode(cell))} `);
      const line = `|${cells.join("|")}|`;
      if (rowIndex !== 0) return line;
      return `${line}\n|${cells.map(() => " --- ").join("|")}|`;
    }).join("\n");
  }
  return textFromNode(node);
};

export const serializeEditorMarkdown = (editor: ReturnType<typeof useEditor>) => {
  if (!editor) return "";
  const json = editor.getJSON();
  if (!Array.isArray(json.content)) return "";
  return json.content.map((node: ProseMirrorJsonNode) => serializeMarkdownBlock(node)).join("\n");
};

const getMarkdownFromStorage = (editor: ReturnType<typeof useEditor>) => {
  if (!editor) return "";
  return editor.storage.markdown?.getMarkdown?.() ?? serializeEditorMarkdown(editor);
};

const serializeEditorContent = (
  editor: ReturnType<typeof useEditor>,
  format: TipTapContentFormat
) => {
  if (!editor) return "";
  if (format === "plainText") return serializeEditorPlainText(editor);
  if (format === "markdown") return serializeEditorMarkdown(editor);
  if (format === "html") return editor.getHTML();
  if (format === "docx") return JSON.stringify(editor.getJSON());
  return getMarkdownFromStorage(editor);
};

const TOKEN_PATTERN = /[\p{Script=Han}A-Za-z0-9_-]+$/u;

const getReferenceToken = (editor: ReturnType<typeof useEditor>) => {
  if (!editor) return null;
  const { from, to } = editor.state.selection;
  if (from !== to) return null;
  const textBefore = editor.state.doc.textBetween(Math.max(0, from - 80), from, "\n", "\n");
  const match = textBefore.match(TOKEN_PATTERN);
  if (!match?.[0]) return null;
  const token = match[0];
  return {
    token,
    from: from - token.length,
    to: from,
  };
};

const matchReferenceEntries = (entries: ReferenceEntry[], token: string) => {
  const query = token.trim().toLowerCase();
  if (!query) return [];
  const unique = new Map<string, ReferenceEntry>();
  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name || unique.has(name)) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith(query) || lower.includes(query)) {
      unique.set(name, entry);
    }
  }
  return [...unique.values()]
    .sort((left, right) => {
      const leftName = left.name.toLowerCase();
      const rightName = right.name.toLowerCase();
      const leftPrefix = leftName.startsWith(query) ? 0 : 1;
      const rightPrefix = rightName.startsWith(query) ? 0 : 1;
      if (leftPrefix !== rightPrefix) return leftPrefix - rightPrefix;
      return left.name.localeCompare(right.name);
    })
    .slice(0, 8);
};

export const TipTapEditor = forwardRef<TipTapEditorHandle, TipTapEditorProps>(
  function TipTapEditor(
    {
      content,
      onChange,
      onSelectionChange,
      onFocus,
      onBlur,
      editable = true,
      placeholder,
      contentFormat = "markdown",
      pageViewMode = false,
      referenceEntries = [],
      onEditorStateChange,
      locked = false,
      lockedMessage,
    },
    ref
  ) {
    const { t } = useTranslation();
    const wrapperRef = useRef<HTMLDivElement>(null);
    const lastContentRef = useRef<string>(content);
    const contentFormatRef = useRef<TipTapContentFormat>(contentFormat);
    const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isComposingRef = useRef(false);
    const suppressedReferenceTokenRef = useRef<SuppressedReferenceToken | null>(null);
    const [referenceSuggestion, setReferenceSuggestion] = useState<ReferenceSuggestionState | null>(null);

    const resolvedPlaceholder = placeholder ?? t("editor.placeholder");
    contentFormatRef.current = contentFormat;
    const initialContent = useMemo(
      () => getEditorContent(content, contentFormat),
      [content, contentFormat]
    );

    const extensions = useMemo(
      () => [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: false,
          underline: false,
        }),
        Markdown.configure({
          html: true,
          tightLists: true,
          bulletListMarker: "-",
          transformPastedText: true,
          transformCopiedText: true,
        }),
        Underline,
        TextAlign.configure({
          types: ["heading", "paragraph"],
        }),
        TextStyle,
        Color,
        Highlight.configure({ multicolor: true }),
        FontFamily,
        FontSize,
        LineHeight,
        Indent,
        CachedSelectionHighlight,
        Image.configure({
          inline: false,
          allowBase64: true,
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
        }),
        Table.configure({
          resizable: true,
        }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        Placeholder.configure({
          placeholder: resolvedPlaceholder,
        }),
      ],
      [resolvedPlaceholder]
    );

    const editor = useEditor({
      extensions,
      content: initialContent,
      editable,
      editorProps: {
        attributes: {
          class: "tiptap-editor-prose",
        },
        handleDOMEvents: {
          copy: (view, event) => {
            if (!event.clipboardData || view.state.selection.empty) return false;
            const { text, html } = getEditorSelectionClipboardContent(view);
            event.clipboardData.setData("text/plain", text);
            event.clipboardData.setData("text/html", html);
            event.preventDefault();
            return true;
          },
        },
      },
      onUpdate: ({ editor: ed }) => {
        const serialized = serializeEditorContent(ed, contentFormatRef.current);
        lastContentRef.current = serialized;
        onChange?.(serialized);
        onEditorStateChange?.(ed);
      },
      onSelectionUpdate: ({ editor: ed }) => {
        onEditorStateChange?.(ed);
        if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = setTimeout(() => {
          const { from, to } = ed.state.selection;
          if (from !== to) {
            const text = ed.state.doc.textBetween(from, to);
            setCachedSelectionHighlight(ed, { from, to });
            onSelectionChange?.({ text, from, to });
          } else {
            onSelectionChange?.(null);
          }
        }, 50);
      },
      onFocus: ({ editor: ed }) => {
        onEditorStateChange?.(ed);
        onFocus?.();
      },
      onBlur: () => onBlur?.(),
    });

    const closeReferenceSuggestion = () => setReferenceSuggestion(null);

    const updateReferenceSuggestion = () => {
      if (!editor || !editable || isComposingRef.current || referenceEntries.length === 0) {
        closeReferenceSuggestion();
        return;
      }

      const tokenInfo = getReferenceToken(editor);
      if (!tokenInfo) {
        suppressedReferenceTokenRef.current = null;
        closeReferenceSuggestion();
        return;
      }

      const suppressed = suppressedReferenceTokenRef.current;
      if (
        suppressed &&
        suppressed.token === tokenInfo.token &&
        suppressed.from === tokenInfo.from &&
        suppressed.to === tokenInfo.to
      ) {
        closeReferenceSuggestion();
        return;
      }
      if (
        suppressed &&
        (suppressed.token !== tokenInfo.token || suppressed.from !== tokenInfo.from || suppressed.to !== tokenInfo.to)
      ) {
        suppressedReferenceTokenRef.current = null;
      }

      const items = matchReferenceEntries(referenceEntries, tokenInfo.token);
      if (items.length === 0) {
        closeReferenceSuggestion();
        return;
      }

      try {
        const coords = editor.view.coordsAtPos(tokenInfo.to);
        const wrapperRect = wrapperRef.current?.getBoundingClientRect();
        if (!wrapperRect) {
          closeReferenceSuggestion();
          return;
        }
        const desiredWidth = Math.min(280, Math.max(180, wrapperRect.width - 16));
        const desiredHeight = Math.min(220, items.length * 34 + 8);
        const spaceBelow = window.innerHeight - coords.bottom - 12;
        const spaceAbove = coords.top - 12;
        const placement: "top" | "bottom" =
          spaceBelow < desiredHeight && spaceAbove > spaceBelow ? "top" : "bottom";
        const availableHeight = Math.max(84, (placement === "top" ? spaceAbove : spaceBelow) - 12);
        const maxHeight = Math.min(desiredHeight, availableHeight);
        const rawLeft = coords.left - wrapperRect.left;
        const left = Math.max(8, Math.min(rawLeft, wrapperRect.width - desiredWidth - 8));
        const top = placement === "top"
          ? Math.max(8, coords.top - wrapperRect.top - maxHeight - 6)
          : Math.min(wrapperRect.height - maxHeight - 8, coords.bottom - wrapperRect.top + 6);

        setReferenceSuggestion({
          ...tokenInfo,
          items,
          selectedIndex: 0,
          left,
          top,
          width: desiredWidth,
          maxHeight,
          placement,
        });
      } catch {
        closeReferenceSuggestion();
      }
    };

    const applyReferenceSuggestion = (entry: ReferenceEntry) => {
      if (!editor || !referenceSuggestion) return;
      suppressedReferenceTokenRef.current = {
        token: entry.name,
        from: referenceSuggestion.from,
        to: referenceSuggestion.from + entry.name.length,
      };
      editor
        .chain()
        .focus()
        .deleteRange({ from: referenceSuggestion.from, to: referenceSuggestion.to })
        .insertContent(entry.name)
        .run();
      closeReferenceSuggestion();
    };

    useEffect(() => {
      if (!editor) return;
      if (lastContentRef.current !== content) {
        editor.commands.setContent(getEditorContent(content, contentFormat), { emitUpdate: false });
        lastContentRef.current = content;
        onEditorStateChange?.(editor);
      }
    }, [editor, content, contentFormat, onEditorStateChange]);

    useEffect(() => {
      if (editor) editor.setEditable(editable && !locked);
    }, [editable, locked, editor]);

    useEffect(() => {
      if (!editor) return;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setCachedSelectionHighlight(editor, null);
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [editor]);

    const stopLockedEvent = useCallback((event: React.SyntheticEvent) => {
      if (!locked) return;
      event.preventDefault();
      event.stopPropagation();
    }, [locked]);

    useEffect(() => {
      if (!editor) return;
      const refresh = () => window.setTimeout(updateReferenceSuggestion, 0);
      editor.on("update", refresh);
      editor.on("selectionUpdate", refresh);
      return () => {
        editor.off("update", refresh);
        editor.off("selectionUpdate", refresh);
      };
    }, [editor, editable, referenceEntries]);

    useEffect(() => {
      if (!referenceSuggestion) return;
      const items = matchReferenceEntries(referenceEntries, referenceSuggestion.token);
      if (items.length === 0) {
        closeReferenceSuggestion();
        return;
      }
      setReferenceSuggestion((current) =>
        current
          ? {
              ...current,
              items,
              selectedIndex: Math.min(current.selectedIndex, items.length - 1),
            }
          : current
      );
    }, [referenceEntries, referenceSuggestion?.token]);

    useEffect(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper || !editor) return;

      const observer = new ResizeObserver(() => {
        editor.view.dispatchEvent(new Event("resize"));
      });
      observer.observe(wrapper);

      return () => observer.disconnect();
    }, [editor]);

    useEffect(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper || !pageViewMode === undefined) return;

      const handleMouseMove = (e: MouseEvent) => {
        if (!wrapper.classList.contains("focus-mode")) return;
        const prosemirror = wrapper.querySelector(".ProseMirror");
        if (!prosemirror) return;

        const allNodes = prosemirror.children;
        for (let i = 0; i < allNodes.length; i++) {
          allNodes[i].classList.remove("focus-active", "focus-near");
        }

        const target = (e.target as HTMLElement).closest(".ProseMirror > *");
        if (target) {
          target.classList.add("focus-active");
          if (target.previousElementSibling) target.previousElementSibling.classList.add("focus-near");
          if (target.nextElementSibling) target.nextElementSibling.classList.add("focus-near");
        }
      };

      wrapper.addEventListener("mousemove", handleMouseMove);
      return () => wrapper.removeEventListener("mousemove", handleMouseMove);
    }, [pageViewMode]);

    useEffect(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper || !editor) return;

      const handleCompositionStart = () => {
        isComposingRef.current = true;
        closeReferenceSuggestion();
      };
      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        window.setTimeout(updateReferenceSuggestion, 0);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (!referenceSuggestion) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          closeReferenceSuggestion();
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          setReferenceSuggestion((current) =>
            current ? { ...current, selectedIndex: (current.selectedIndex + 1) % current.items.length } : current
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          setReferenceSuggestion((current) =>
            current
              ? { ...current, selectedIndex: (current.selectedIndex - 1 + current.items.length) % current.items.length }
              : current
          );
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          const entry = referenceSuggestion.items[referenceSuggestion.selectedIndex];
          if (entry) applyReferenceSuggestion(entry);
        }
      };

      wrapper.addEventListener("compositionstart", handleCompositionStart);
      wrapper.addEventListener("compositionend", handleCompositionEnd);
      wrapper.addEventListener("keydown", handleKeyDown, { capture: true });
      return () => {
        wrapper.removeEventListener("compositionstart", handleCompositionStart);
        wrapper.removeEventListener("compositionend", handleCompositionEnd);
        wrapper.removeEventListener("keydown", handleKeyDown, { capture: true });
      };
    }, [editor, referenceSuggestion]);

    useEffect(() => {
      return () => {
        if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      };
    }, []);

    useImperativeHandle(ref, () => ({
      getEditor: () => editor,
      getMarkdown: () => (
        contentFormat === "plainText"
          ? serializeEditorPlainText(editor)
          : contentFormat === "markdown"
            ? serializeEditorMarkdown(editor)
            : getMarkdownFromStorage(editor)
      ),
      getHTML: () => editor?.getHTML() ?? "",
      getJSON: () => editor?.getJSON() ?? { type: "doc", content: [{ type: "paragraph" }] },
      getSerializedContent: () => serializeEditorContent(editor, contentFormat),
      getText: () => editor?.state.doc.textContent ?? "",
      getSelectionText: () => {
        if (!editor) return "";
        const { from, to } = editor.state.selection;
        return from === to ? "" : editor.state.doc.textBetween(from, to);
      },
      insertText: (text: string) => {
        if (!editor) return;
        editor.chain().focus().insertContent(text).run();
      },
      insertMarkdown: (markdown: string) => {
        if (!editor) return;
        editor.chain().focus().insertContent(markdown).run();
      },
      replaceSelection: (text: string) => {
        if (!editor) return;
        editor.chain().focus().deleteSelection().insertContent(text).run();
      },
      focus: () => editor?.commands.focus(),
      scrollToSelection: () => {
        if (!editor) return;
        const { from } = editor.state.selection;
        const coords = editor.view.coordsAtPos(from);
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          wrapper.scrollTop += coords.top - rect.top - rect.height / 2;
        }
      },
      clearCachedSelection: () => setCachedSelectionHighlight(editor, null),
    }));

    return (
      <div
        className={`tiptap-editor-wrapper${pageViewMode ? " page-view-mode" : ""}${locked ? " is-locked" : ""}`}
        ref={wrapperRef}
        aria-busy={locked}
        onBeforeInputCapture={stopLockedEvent}
        onKeyDownCapture={stopLockedEvent}
        onPasteCapture={stopLockedEvent}
        onDropCapture={stopLockedEvent}
        onWheelCapture={stopLockedEvent}
        onTouchMoveCapture={stopLockedEvent}
      >
        <EditorContent editor={editor} className="tiptap-editor-content" />
        {locked && <div className="tiptap-editor-lock">{lockedMessage ?? t("editor.selection.locked")}</div>}
        {referenceSuggestion && (
          <div
            className={`reference-suggestion-popover ${referenceSuggestion.placement}`}
            style={{
              left: referenceSuggestion.left,
              top: referenceSuggestion.top,
              width: referenceSuggestion.width,
              maxHeight: referenceSuggestion.maxHeight,
            }}
          >
            {referenceSuggestion.items.map((entry, index) => (
              <button
                key={`${entry.sourceList ?? "reference"}-${entry.name}`}
                type="button"
                className={`reference-suggestion-item ${index === referenceSuggestion.selectedIndex ? "active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyReferenceSuggestion(entry);
                }}
              >
                <span className="reference-suggestion-name">{entry.name}</span>
                {(entry.description || entry.body) && (
                  <span className="reference-suggestion-description">
                    {[entry.description, entry.body ? "含结构数据" : ""].filter(Boolean).join(" · ")}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }
);
