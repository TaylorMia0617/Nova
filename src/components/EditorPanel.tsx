import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  FolderOpen,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
  X,
} from "lucide-react";
import { MAX_EDITOR_GROUPS, useFileStore, type HistoryDiffPart } from "../stores/fileStore";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useSettingsStore } from "../stores/settingsStore";
import { callAI } from "../services/aiService";
import { readFile, type WorkspaceNode } from "../services/fileSystemService";
import {
  applySelectionPreview,
  registerEditorBridge,
} from "../services/editorInsertionService";
import { exportDocument, getExportTemplates } from "../services/documentExportService";
import type { ExportFormat, ExportTemplateId } from "../types/export";
import { useEditorUIStore } from "../stores/editorUIStore";
import { DEFAULT_ACTIVE_FORMATS, useEditorStatusStore } from "../stores/editorStatusStore";
import { onWorkspaceChanged, unwatchWorkspace, watchWorkspace } from "../services/terminalService";
import { compareNodeNames } from "../../shared/workspaceSort.js";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { TipTapEditor } from "./TipTapEditor";
import type { TipTapContentFormat, TipTapEditorHandle } from "./TipTapEditor";
import { FindReplacePanel } from "./TipTapEditor/FindReplacePanel";
import { OutlinePanel } from "./TipTapEditor/OutlinePanel";
import type { OutlineBlueprintMatch } from "./TipTapEditor/OutlinePanel";
import type { BlueprintNode } from "../types/blueprint";
import { EditorToolbar } from "./EditorToolbar";
import BlueprintEditor from "./BlueprintEditor";
import { useTranslation } from "../hooks/useTranslation";
import "./EditorPanel.css";

const TXT_MERGE_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);
const EDITOR_FILE_DRAG_TYPE = "application/x-novel-file-path";
const EDITOR_TAB_DRAG_TYPE = "application/x-novel-tab-path";

const getEditorContentFormat = (fileMode?: string): TipTapContentFormat => {
  if (fileMode === "markdown") return "markdown";
  if (fileMode === "docx") return "docx";
  return "plainText";
};

const isBlueprintTab = (tab: { fileMode?: string; blueprintId?: string } | null | undefined) =>
  tab?.fileMode === "blueprint" && Boolean(tab.blueprintId);

const isNonTextPreviewTab = (tab: { fileMode?: string } | null | undefined) =>
  tab?.fileMode === "blueprint" || tab?.fileMode === "image" || tab?.fileMode === "unsupported";

const parseHistoryDiffParts = (content: string): HistoryDiffPart[] => {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((part): part is HistoryDiffPart =>
      part &&
      (part.type === "same" || part.type === "added" || part.type === "removed") &&
      typeof part.text === "string"
    );
  } catch {
    return [];
  }
};

function HistoryDiffView({ content }: { content: string }) {
  const { t } = useTranslation();
  const parts = parseHistoryDiffParts(content);
  return (
    <div className="history-diff-view">
      {parts.length === 0 ? (
        <div className="history-diff-empty">{t("history.compareEmpty")}</div>
      ) : (
        parts.map((part, index) => (
          <div key={`${part.type}-${index}`} className={`history-diff-line ${part.type}`}>
            <span className="history-diff-marker">
              {part.type === "added" ? "+" : part.type === "removed" ? "-" : " "}
            </span>
            <span>{part.text || " "}</span>
          </div>
        ))
      )}
    </div>
  );
}

type SelectionAction = "polish" | "correct" | "stylize";

type SelectionPopupState = {
  text: string;
  top: number;
  left: number;
};

type SelectionPreviewState = {
  mode: SelectionAction;
  original: string;
  result: string;
};

const getPathSeparator = (path: string) => (path.includes("\\") ? "\\" : "/");

const getParentPath = (path: string): string => {
  const separator = getPathSeparator(path);
  const lastIndex = path.lastIndexOf(separator);
  return lastIndex <= 0 ? path : path.slice(0, lastIndex);
};

const getFileExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return "";
  return name.slice(dotIndex).toLowerCase();
};

const findFolderNodeByPath = (nodes: WorkspaceNode[], path: string): WorkspaceNode | null => {
  for (const node of nodes) {
    if (node.type === "folder" && node.path === path) return node;
    if (node.children) {
      const found = findFolderNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const EditorPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    files,
    activeFile,
    getOpenTabs,
    editorGroups,
    activeGroupId,
    rootPath,
    recentWorkspaces,
    referenceEntries,
    setErrorMessage,
    openFile,
    openFileInNewGroup,
    openBlueprintTab,
    setActiveFile,
    closeTab,
    updateFileContent,
    saveFile,
    refreshWorkspace,
    openRecentWorkspace,
    clearRecentWorkspaces,
    splitEditor,
    closeGroup,
    setActiveGroup,
    moveTabToGroup,
    moveTabToNewGroup,
  } = useFileStore();
  const { blueprints, loadBlueprints, focusNode: focusBlueprintNode } = useBlueprintStore();
  const { defaultSelectionModelId, selectionPromptTemplates, getModelProfileById } = useSettingsStore();
  const tiptapRef = useRef<TipTapEditorHandle>(null);
  const workspaceRefreshTimeoutRef = useRef<number | null>(null);
  const editorStatesRef = useRef<Map<string, { scrollTop: number }>>(new Map());
  const loadedFilePathRef = useRef<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string>("");
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopupState | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<SelectionPreviewState | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabPath: string } | null>(null);
  const [isEditorDragActive, setIsEditorDragActive] = useState(false);
  const [editorDragKind, setEditorDragKind] = useState<"file" | "tab" | null>(null);
  const [editorDropTarget, setEditorDropTarget] = useState<{ type: "group"; groupId: string } | { type: "new" } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (rootPath) void loadBlueprints();
  }, [rootPath, loadBlueprints]);

  const {
    isFindReplaceOpen, isOutlineOpen, isPageViewMode, isFocusMode,
    isExportDialogOpen, exportFormat, exportTemplateId, exportError,
    isLinkDialogOpen, linkUrl, linkText,
    setFindReplaceOpen, toggleOutline, togglePageViewMode, toggleFocusMode,
    openLinkDialog, closeLinkDialog,
    setLinkUrl, setLinkText,
    openExportDialog, closeExportDialog,
    setExportFormat, setExportTemplateId,
  } = useEditorUIStore();

  const {
    cursorPosition, selectionLength, wordWrap,
    toggleWordWrap,
  } = useEditorStatusStore();

  const isReferenceFile = false;

  const syncEditorStatus = useCallback((editor: Editor | null | undefined) => {
    const statusStore = useEditorStatusStore.getState();
    if (!editor || isReferenceFile) {
      statusStore.setCursorPosition({ line: 1, column: 1 });
      statusStore.setSelectionLength(0);
      statusStore.setActiveHeadingState("body");
      statusStore.setActiveFormats(DEFAULT_ACTIVE_FORMATS);
      return;
    }

    const { $from, from, to } = editor.state.selection;
    const textBefore = editor.state.doc.textBetween(0, $from.pos, "\n");
    const lines = textBefore.split("\n");
    const selectionLength = from === to ? 0 : editor.state.doc.textBetween(from, to).length;
    const alignCenter = editor.isActive({ textAlign: "center" });
    const alignRight = editor.isActive({ textAlign: "right" });

    statusStore.setCursorPosition({
      line: lines.length,
      column: lines[lines.length - 1].length + 1,
    });
    statusStore.setSelectionLength(selectionLength);
    statusStore.setActiveHeadingState(
      editor.isActive("heading", { level: 1 })
        ? "h1"
        : editor.isActive("heading", { level: 2 })
          ? "h2"
          : editor.isActive("heading", { level: 3 })
            ? "h3"
            : "body"
    );
    statusStore.setActiveFormats({
      bold: editor.isActive("bold"),
      italic: editor.isActive("italic"),
      underline: editor.isActive("underline"),
      strike: editor.isActive("strike"),
      blockquote: editor.isActive("blockquote"),
      codeBlock: editor.isActive("codeBlock"),
      taskList: editor.isActive("taskList"),
      alignLeft: editor.isActive({ textAlign: "left" }) || (!alignCenter && !alignRight),
      alignCenter,
      alignRight,
    });
  }, [isReferenceFile]);

  const handleSelectionAi = async (mode: SelectionAction) => {
    const modelProfile = getModelProfileById(defaultSelectionModelId);
    const handle = tiptapRef.current;
    if (!modelProfile || !handle) return;

    const selectedText = handle.getSelectionText().trim();
    if (!selectedText) return;

    setSelectionLoading(true);
    setSelectionError("");
    try {
      const prompt = selectionPromptTemplates[mode];
      const result = await callAI({
        modelProfile,
        taskType: mode,
        userMessage: selectedText,
        documentContext: handle.getMarkdown(),
        documentFileName: activeFile?.name,
        conversationHistory: [],
        selectionPrompt: prompt,
      });

      setSelectionPreview({ mode, original: selectedText, result });
      setSelectionPopup(null);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "AI request failed.");
    } finally {
      setSelectionLoading(false);
    }
  };

  const insertImageFromFile = (file: File) => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      editor.chain().focus().setImage({ src: dataUrl }).run();
    };
    reader.readAsDataURL(file);
  };

  const handleImageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      insertImageFromFile(file);
      e.target.value = "";
    }
  };

  const insertLink = () => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor || !linkUrl.trim()) return;
    if (linkText.trim()) {
      editor.chain().focus().insertContent(`<a href="${linkUrl.trim()}">${linkText.trim()}</a>`).run();
    } else {
      editor.chain().focus().setLink({ href: linkUrl.trim() }).run();
    }
    closeLinkDialog();
  };

  const handleContentChange = useCallback((content: string) => {
    if (activeFile?.isReadOnly) return;
    const path = loadedFilePathRef.current;
    if (path) {
      updateFileContent(path, content);
    }
  }, [activeFile?.isReadOnly, updateFileContent]);

  const handleSelectionChange = useCallback((text: string) => {
    if (text.trim()) {
      useEditorStatusStore.getState().setSelectionLength(text.length);
      const handle = tiptapRef.current;
      const editor = handle?.getEditor();
      if (editor) {
        const { to } = editor.state.selection;
        const selection = window.getSelection();
        const rangeRect =
          selection && selection.rangeCount > 0
            ? selection.getRangeAt(0).getBoundingClientRect()
            : null;
        const coords = editor.view.coordsAtPos(to);
        const hasRangeRect =
          rangeRect &&
          Number.isFinite(rangeRect.left) &&
          Number.isFinite(rangeRect.bottom) &&
          (rangeRect.width > 0 || rangeRect.height > 0);
        const anchorLeft = hasRangeRect ? rangeRect.left + rangeRect.width / 2 : coords.left;
        const anchorTop = hasRangeRect ? rangeRect.bottom + 8 : coords.bottom + 8;

        setSelectionPopup({
          text,
          left: clamp(anchorLeft, 120, Math.max(120, window.innerWidth - 120)),
          top: clamp(anchorTop, 8, Math.max(8, window.innerHeight - 56)),
        });
      }
    } else {
      useEditorStatusStore.getState().setSelectionLength(0);
      setSelectionPopup(null);
    }
  }, []);

  const handleUpdateCursor = useCallback(() => {
    const handle = tiptapRef.current;
    const editor = handle?.getEditor();
    syncEditorStatus(editor);
  }, [syncEditorStatus]);

  const handleEditorStateChange = useCallback((editor: Editor) => {
    syncEditorStatus(editor);
  }, [syncEditorStatus]);

  useEffect(() => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor || !activeFile) return;
    if (loadedFilePathRef.current === activeFile.path) return;
    if (activeFile.historyViewMode === "compare") {
      loadedFilePathRef.current = activeFile.path;
      return;
    }

    if (loadedFilePathRef.current && wrapperRef.current) {
      editorStatesRef.current.set(loadedFilePathRef.current, {
        scrollTop: wrapperRef.current.scrollTop,
      });
    }

    const contentFormat = getEditorContentFormat(activeFile.fileMode);
    const nextContent = contentFormat === "docx" ? JSON.parse(activeFile.content) : activeFile.content;
    editor.commands.setContent(nextContent, { emitUpdate: false });
    loadedFilePathRef.current = activeFile.path;

    const saved = editorStatesRef.current.get(activeFile.path);
    if (saved && wrapperRef.current) {
      requestAnimationFrame(() => {
        wrapperRef.current!.scrollTop = saved.scrollTop;
      });
    } else if (wrapperRef.current) {
      requestAnimationFrame(() => {
        wrapperRef.current!.scrollTop = 0;
      });
    }

    syncEditorStatus(editor);
  }, [activeFile?.path, syncEditorStatus]);

  const handleSave = async () => {
    if (!activeFile || activeFile.isReadOnly) return;
    await saveFile(activeFile.path);
    setLastSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  };

  useEffect(() => {
    if (!rootPath) return;
    void watchWorkspace(rootPath);
    const disposeWorkspaceChanged = onWorkspaceChanged(({ rootPath: changedRootPath }) => {
      if (changedRootPath !== rootPath) return;
      if (workspaceRefreshTimeoutRef.current) window.clearTimeout(workspaceRefreshTimeoutRef.current);
      workspaceRefreshTimeoutRef.current = window.setTimeout(() => {
        void refreshWorkspace();
      }, 500);
    });
    return () => {
      if (workspaceRefreshTimeoutRef.current) window.clearTimeout(workspaceRefreshTimeoutRef.current);
      disposeWorkspaceChanged();
      void unwatchWorkspace(rootPath);
    };
  }, [refreshWorkspace, rootPath]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindReplaceOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
        e.preventDefault();
        setFindReplaceOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFile]);

  useEffect(() => {
    return () => {
      registerEditorBridge(null);
    };
  }, []);

  useEffect(() => {
    const handle = tiptapRef.current;
    if (!handle || !activeFile?.path) return;
    const editor = handle.getEditor();
    if (!editor) return;

    registerEditorBridge({
      getSelectionText: () => handle.getSelectionText(),
      getSelectionRange: () => {
        const { from, to } = editor.state.selection;
        return { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0, from, to } as any;
      },
      getContent: () => handle.getMarkdown(),
      applyText: ({ mode, text }) => {
        if (mode === "replaceSelection") {
          handle.replaceSelection(text);
        } else if (mode === "insertAfterSelection") {
          handle.insertText(`\n${text}`);
        } else {
          handle.insertText(text);
        }
      },
      focus: () => handle.focus(),
    });
  }, [activeFile?.path]);

  useEffect(() => {
    const tabsBars = document.querySelectorAll('.tabs-bar');
    if (tabsBars.length === 0) return;
    const handleWheel = (e: Event) => {
      const we = e as WheelEvent;
      if (Math.abs(we.deltaY) > Math.abs(we.deltaX)) {
        we.preventDefault();
        (we.currentTarget as HTMLElement).scrollLeft += we.deltaY;
      }
    };
    tabsBars.forEach((bar) => bar.addEventListener('wheel', handleWheel, { passive: false }));
    return () => tabsBars.forEach((bar) => bar.removeEventListener('wheel', handleWheel));
  }, []);

  const handleExport = async () => {
    const { exportFormat, exportTemplateId, setExportError, closeExportDialog } = useEditorUIStore.getState();
    if (!activeFile) {
      setExportError(t("editor.errors.noContentToExport"));
      return;
    }
    try {
      if (exportFormat === "txt") {
        const parentPath = getParentPath(activeFile.path);
        const parentFolder = findFolderNodeByPath(files, parentPath);
        const siblingFiles = (parentFolder?.children ?? [])
          .filter((node): node is WorkspaceNode => node.type === "file")
          .filter((node) => TXT_MERGE_EXTENSIONS.has(getFileExtension(node.name)))
          .sort((left, right) => compareNodeNames(left.name, right.name));

        if (siblingFiles.length === 0) {
          throw new Error(t("editor.errors.noTextFilesToExport"));
        }

        const mergedContents = await Promise.all(
          siblingFiles.map(async (fileNode) => {
            const text = await readFile(fileNode.path);
            return text.replace(/\s+$/, "");
          })
        );

        const mergedContent = mergedContents.join("\n\n");
        const filenameBase = `${parentFolder?.name || activeFile.name.replace(/\.[^/.]+$/, "")}-merged`;

        await exportDocument({
          format: "txt",
          templateId: exportTemplateId,
          title: filenameBase,
          content: mergedContent,
          filenameBase: filenameBase || "document-merged",
        });
      } else {
        if (!activeFile.content.trim()) {
          setExportError(t("editor.errors.noContentToExport"));
          return;
        }
        const filenameBase = activeFile.name.replace(/\.[^/.]+$/, "");
        await exportDocument({
          format: exportFormat,
          templateId: exportTemplateId,
          title: filenameBase || activeFile.name,
          content: activeFile.content,
          filenameBase: filenameBase || "document",
          docJson: tiptapRef.current?.getJSON(),
          docxPackageState: activeFile.docxPackageState,
        });
      }
      setExportError("");
      closeExportDialog();
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t("editor.errors.exportFailed"));
    }
  };

  const fileStats = useMemo(() => {
    const content = activeFile?.content || "";
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const charsNoSpace = content.replace(/\s/g, "").length;
    const paragraphs = content.trim() ? content.trim().split(/\n\s*\n/).length : 0;
    const lines = content.trim() ? content.trim().split(/\n/).length : 0;
    const readingTimeMin = Math.max(1, Math.ceil(words / 200));
    return {
      characters: content.length,
      charsNoSpace,
      words,
      paragraphs,
      lines,
      readingTime: readingTimeMin,
      language: isReferenceFile
        ? t("editor.status.plainText")
        : activeFile?.fileMode === "docx"
          ? "DOCX"
          : activeFile?.fileMode === "markdown"
            ? "Markdown"
            : t("editor.status.plainText"),
    };
  }, [activeFile, isReferenceFile, t]);

  const getBlueprintNodeKindLabel = useCallback((node: BlueprintNode) => {
    if (node.kind === "story") return t("blueprint.story");
    if (node.kind === "character") return t("blueprint.character");
    return t("blueprint.customNode");
  }, [t]);

  const getBlueprintNodeSummaryLines = useCallback((node: BlueprintNode) => {
    const lines: string[] = [];
    if (node.kind === "story") {
      if (node.summary) lines.push(node.summary);
      if (node.linkedChapters?.length) lines.push(`${t("blueprint.linkedChapter")}: ${node.linkedChapters.slice(0, 2).join(" / ")}`);
      for (const event of node.storyEvents ?? []) {
        const text = [event.time, event.content, event.foreshadowing].filter(Boolean).join(" · ");
        if (text) lines.push(text);
      }
    } else if (node.kind === "character") {
      if (node.characterName || node.identity) lines.push([node.characterName, node.identity].filter(Boolean).join(" · "));
      for (const relationship of node.relationships ?? []) {
        const text = [relationship.relation, relationship.name, relationship.identity].filter(Boolean).join(" · ");
        if (text) lines.push(text);
      }
      for (const event of node.characterEvents ?? []) {
        const text = [event.time, event.story, event.location].filter(Boolean).join(" · ");
        if (text) lines.push(text);
      }
    } else {
      for (const field of node.customFields ?? []) {
        if (field.showInCard === false) continue;
        const value = (field.values?.length ? field.values : [field.value]).filter(Boolean).join(" / ");
        const text = [field.key, value].filter(Boolean).join(": ");
        if (text) lines.push(text);
      }
    }
    return (lines.length ? lines : [t("blueprint.emptyNode")]).slice(0, 4);
  }, [t]);

  const getBlueprintMatchesForHeading = useCallback((headingText: string): OutlineBlueprintMatch[] => {
    if (!activeFile || isBlueprintTab(activeFile)) return [];
    const fileName = activeFile.name.toLowerCase();
    const heading = headingText.trim().toLowerCase();
    if (!heading) return [];

    const matches: OutlineBlueprintMatch[] = [];
    for (const blueprint of blueprints) {
      for (const node of blueprint.nodes) {
        const terms = [
          node.title,
          ...(node.linkedChapters ?? []),
          ...(node.storyEvents ?? []).flatMap((event) => [event.content, event.foreshadowing]),
          node.characterName,
          node.identity,
          ...(node.relationships ?? []).flatMap((relationship) => [relationship.relation, relationship.name, relationship.identity]),
          ...(node.keywords ?? []),
        ]
          .map((term) => term?.trim().toLowerCase())
          .filter((term): term is string => Boolean(term));
        const hitsHeading = terms.some((term) => heading.includes(term) || term.includes(heading));
        const hitsFile = terms.some((term) => fileName.includes(term) || term.includes(fileName.replace(/\.[^.]+$/, "")));
        if (hitsHeading || hitsFile) {
          matches.push({
            blueprintId: blueprint.id,
            nodeId: node.id,
            blueprintName: blueprint.name,
            nodeTitle: node.title || node.characterName || t("blueprint.untitledNode"),
            nodeKind: node.kind,
            nodeKindLabel: getBlueprintNodeKindLabel(node),
            summaryLines: getBlueprintNodeSummaryLines(node),
          });
        }
      }
    }
    return matches;
  }, [activeFile, blueprints, getBlueprintNodeKindLabel, getBlueprintNodeSummaryLines, t]);

  const handleOutlineBlueprintClick = useCallback((match: OutlineBlueprintMatch) => {
    focusBlueprintNode(match.blueprintId, match.nodeId);
    openBlueprintTab(match.blueprintId, match.blueprintName, match.nodeId);
  }, [focusBlueprintNode, openBlueprintTab]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabPath: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, tabPath });
  }, []);

  const getEditorDragKind = (event: React.DragEvent): "file" | "tab" | null => {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(EDITOR_TAB_DRAG_TYPE)) return "tab";
    if (types.includes(EDITOR_FILE_DRAG_TYPE)) return "file";
    return null;
  };

  const getEditorDraggedFilePath = (event: React.DragEvent) =>
    event.dataTransfer.getData(EDITOR_FILE_DRAG_TYPE);

  const getEditorDraggedTabPath = (event: React.DragEvent) =>
    event.dataTransfer.getData(EDITOR_TAB_DRAG_TYPE);

  const handleTabDragStart = useCallback((event: React.DragEvent, tabPath: string) => {
    event.dataTransfer.setData(EDITOR_TAB_DRAG_TYPE, tabPath);
    event.dataTransfer.effectAllowed = "move";
    setIsEditorDragActive(true);
    setEditorDragKind("tab");
  }, []);

  const handleTabDragEnd = useCallback(() => {
    setIsEditorDragActive(false);
    setEditorDragKind(null);
    setEditorDropTarget(null);
  }, []);

  const handleEditorDragOver = useCallback((event: React.DragEvent, target: { type: "group"; groupId: string } | { type: "new" }) => {
    const dragKind = getEditorDragKind(event);
    if (!dragKind) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragKind === "tab" ? "move" : target.type === "new" && editorGroups.length >= MAX_EDITOR_GROUPS ? "none" : "copy";
    setIsEditorDragActive(true);
    setEditorDragKind(dragKind);
    setEditorDropTarget(target);
  }, [editorGroups.length]);

  const handleEditorDragLeave = useCallback((event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsEditorDragActive(false);
    setEditorDragKind(null);
    setEditorDropTarget(null);
  }, []);

  const handleDropOnEditorGroup = useCallback(async (event: React.DragEvent, groupId: string) => {
    const dragKind = getEditorDragKind(event);
    if (!dragKind) return;
    event.preventDefault();
    event.stopPropagation();
    setIsEditorDragActive(false);
    setEditorDragKind(null);
    setEditorDropTarget(null);
    setActiveGroup(groupId);
    if (dragKind === "tab") {
      const tabPath = getEditorDraggedTabPath(event);
      if (tabPath) moveTabToGroup(tabPath, groupId);
      return;
    }
    const filePath = getEditorDraggedFilePath(event);
    if (filePath) await openFile(filePath, groupId);
  }, [moveTabToGroup, openFile, setActiveGroup]);

  const handleDropOnNewEditorGroup = useCallback(async (event: React.DragEvent) => {
    const dragKind = getEditorDragKind(event);
    if (!dragKind) return;
    event.preventDefault();
    event.stopPropagation();
    setIsEditorDragActive(false);
    setEditorDragKind(null);
    setEditorDropTarget(null);
    if (dragKind === "tab") {
      const tabPath = getEditorDraggedTabPath(event);
      if (tabPath) {
        if (editorGroups.length >= MAX_EDITOR_GROUPS) {
          setErrorMessage(t("editor.dragDrop.maxWindows"));
        }
        moveTabToNewGroup(tabPath);
      }
      return;
    }
    const filePath = getEditorDraggedFilePath(event);
    if (!filePath) return;
    if (editorGroups.length >= MAX_EDITOR_GROUPS) {
      setErrorMessage(t("editor.dragDrop.maxWindows"));
      await openFile(filePath, activeGroupId);
      return;
    }
    await openFileInNewGroup(filePath);
  }, [activeGroupId, editorGroups.length, moveTabToNewGroup, openFile, openFileInNewGroup, setErrorMessage, t]);

  const getContextMenuItems = useCallback((tabPath: string): ContextMenuItem[] => {
    const otherGroups = editorGroups.filter((g) => g.id !== activeGroupId);
    return [
      ...(editorGroups.length < MAX_EDITOR_GROUPS
        ? [
            { label: t("editor.context.splitRight"), icon: <SplitSquareHorizontal size={14} />, action: () => splitEditor("horizontal") },
            { label: t("editor.context.splitDown"), icon: <SplitSquareVertical size={14} />, action: () => splitEditor("vertical") },
          ]
        : []),
      ...(otherGroups.length > 0
        ? [
            { label: "", separator: true, action: () => {} },
            ...otherGroups.map((g) => ({
              label: t("editor.context.moveTo", {
                target: g.id === "primary" ? t("editor.context.primaryGroup") : t("editor.context.splitGroup", { index: editorGroups.indexOf(g) }),
              }),
              action: () => moveTabToGroup(tabPath, g.id),
            })),
          ]
        : []),
    ];
  }, [editorGroups, activeGroupId, splitEditor, moveTabToGroup, t]);

  const exportTemplates = useMemo(() => getExportTemplates(), []);

  const handleToolbarToggleHeading = useCallback((level: 1 | 2 | 3) => {
    tiptapRef.current?.getEditor()?.chain().focus().toggleHeading({ level }).run();
  }, []);

  const handleToolbarToggleBodyText = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().setParagraph().run();
  }, []);

  const handleToolbarToggleFormat = useCallback((format: "bold" | "italic" | "underline" | "strike") => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor) return;
    const cmd = format === "bold" ? "toggleBold" : format === "italic" ? "toggleItalic" : format === "underline" ? "toggleUnderline" : "toggleStrike";
    editor.chain().focus()[cmd]().run();
  }, []);

  const handleToolbarSetAlignment = useCallback((alignment: "left" | "center" | "right") => {
    tiptapRef.current?.getEditor()?.chain().focus().setTextAlign(alignment).run();
  }, []);

  const handleToolbarApplyColor = useCallback((color: string) => {
    tiptapRef.current?.getEditor()?.chain().focus().setColor(color).run();
  }, []);

  const handleToolbarApplyHighlight = useCallback((color: string) => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor) return;
    if (color) {
      editor.chain().focus().toggleHighlight({ color }).run();
    } else {
      editor.chain().focus().unsetHighlight().run();
    }
  }, []);

  const handleToolbarApplyFontFamily = useCallback((font: string) => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor) return;
    if (font) {
      editor.chain().focus().setFontFamily(font).run();
    } else {
      editor.chain().focus().unsetFontFamily().run();
    }
  }, []);

  const handleToolbarApplyLineHeight = useCallback((height: string) => {
    tiptapRef.current?.getEditor()?.chain().focus().setLineHeight(height).run();
  }, []);

  const handleToolbarToggleBlockquote = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().toggleBlockquote().run();
  }, []);

  const handleToolbarToggleCodeBlock = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().toggleCodeBlock().run();
  }, []);

  const handleToolbarToggleTaskList = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().toggleTaskList().run();
  }, []);

  const handleToolbarInsertHorizontalRule = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().setHorizontalRule().run();
  }, []);

  const handleToolbarInsertTable = useCallback((rows: number, cols: number) => {
    tiptapRef.current?.getEditor()?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
  }, []);

  const handleToolbarTableAction = useCallback((action: string) => {
    const editor = tiptapRef.current?.getEditor();
    if (!editor) return;
    switch (action) {
      case "addColumnBefore": editor.chain().focus().addColumnBefore().run(); break;
      case "addColumnAfter": editor.chain().focus().addColumnAfter().run(); break;
      case "addRowBefore": editor.chain().focus().addRowBefore().run(); break;
      case "addRowAfter": editor.chain().focus().addRowAfter().run(); break;
      case "deleteColumn": editor.chain().focus().deleteColumn().run(); break;
      case "deleteRow": editor.chain().focus().deleteRow().run(); break;
      case "deleteTable": editor.chain().focus().deleteTable().run(); break;
      case "mergeCells": editor.chain().focus().mergeCells().run(); break;
      case "splitCell": editor.chain().focus().splitCell().run(); break;
      case "toggleHeaderRow": editor.chain().focus().toggleHeaderRow().run(); break;
    }
  }, []);

  const handleToolbarIndent = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().indent().run();
  }, []);

  const handleToolbarOutdent = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().outdent().run();
  }, []);

  const handleToolbarUndo = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().undo().run();
  }, []);

  const handleToolbarRedo = useCallback(() => {
    tiptapRef.current?.getEditor()?.chain().focus().redo().run();
  }, []);

  const handleToolbarToggleWordWrap = useCallback(() => {
    toggleWordWrap();
  }, []);

  const handleToolbarToggleOutline = useCallback(() => {
    toggleOutline();
  }, []);

  const handleToolbarTogglePageView = useCallback(() => {
    togglePageViewMode();
  }, []);

  const handleToolbarToggleFocusMode = useCallback(() => {
    toggleFocusMode();
  }, []);

  const handleToolbarSave = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleToolbarExport = useCallback((format: ExportFormat) => {
    openExportDialog(format);
  }, []);

  const handleToolbarInsertImage = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleToolbarInsertLink = useCallback(() => {
    const editor = tiptapRef.current?.getEditor();
    let text = "";
    if (editor) {
      const { from, to } = editor.state.selection;
      if (from !== to) {
        text = editor.state.doc.textBetween(from, to);
      }
    }
    openLinkDialog(text);
  }, []);

  return (
    <div className="editor-panel">
      {editorGroups.length > 1 ? (
        <div
          className={`editor-groups-container split-${editorGroups.length > 2 ? "both" : editorGroups[1] ? "horizontal" : "vertical"}`}
          onDragLeave={handleEditorDragLeave}
        >
          {editorGroups.map((group) => (
            <div
              key={group.id}
              className={`editor-group ${group.id === activeGroupId ? "active" : ""}${editorDropTarget?.type === "group" && editorDropTarget.groupId === group.id ? " drop-active" : ""}`}
              onClick={() => setActiveGroup(group.id)}
              onDragOver={(event) => handleEditorDragOver(event, { type: "group", groupId: group.id })}
              onDrop={(event) => void handleDropOnEditorGroup(event, group.id)}
            >
              <div className="tabs-bar">
                {group.tabs.length > 0 ? (
                  group.tabs.map((tab) => (
                    <button
                      key={tab.path}
                      className={`tab-button ${group.activeTabPath === tab.path ? "active" : ""}`}
                      draggable
                      onDragStart={(event) => handleTabDragStart(event, tab.path)}
                      onDragEnd={handleTabDragEnd}
                      onClick={() => { setActiveGroup(group.id); setActiveFile(tab.path); }}
                      onContextMenu={(e) => handleTabContextMenu(e, tab.path)}
                    >
                      <span>{tab.name}</span>
                      {tab.isDirty && <span className="dirty-dot" />}
                      <span className="close-tab" onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>
                        <X size={12} />
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="tabs-empty">{t("editor.tabs.noOpenEditors")}</div>
                )}
                {editorGroups.length > 1 && (
                  <button className="close-group-btn" onClick={() => closeGroup(group.id)} title={t("editor.context.closeSplit")}>
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="editor-container">
                {editorDropTarget?.type === "group" && editorDropTarget.groupId === group.id && (
                  <div className="editor-drop-overlay">
                    {editorDragKind === "tab" ? t("editor.dragDrop.moveHere") : t("editor.dragDrop.openHere")}
                  </div>
                )}
                {(() => {
                  const groupActiveTab = group.tabs.find((t) => t.path === group.activeTabPath);
                  if (!groupActiveTab) {
                    return (
                      <div className="empty-state">
                        <p>{t("editor.empty.openFile")}</p>
                      </div>
                    );
                  }
                  if (isBlueprintTab(groupActiveTab)) {
                    return <BlueprintEditor blueprintId={groupActiveTab.blueprintId!} />;
                  }
                  if (groupActiveTab.fileMode === "image") {
                    return (
                      <div className="image-preview">
                        <img src={groupActiveTab.content} alt={groupActiveTab.name} />
                        <span>{groupActiveTab.name}</span>
                      </div>
                    );
                  }
                  if (groupActiveTab.fileMode === "unsupported") {
                    return (
                      <div className="empty-state">
                        <p>{t("editor.unsupportedPreview")}</p>
                      </div>
                    );
                  }
                  if (groupActiveTab.historyViewMode === "compare") {
                    return <HistoryDiffView content={groupActiveTab.content} />;
                  }
                  return (
                    <TipTapEditor
                      key={group.activeTabPath}
                      ref={tiptapRef}
                      content={groupActiveTab.content}
                      onChange={groupActiveTab.isReadOnly ? undefined : handleContentChange}
                      onSelectionChange={handleSelectionChange}
                      onEditorStateChange={handleEditorStateChange}
                      onFocus={handleUpdateCursor}
                      onBlur={() => setSelectionPopup((c) => c)}
                      contentFormat={getEditorContentFormat(groupActiveTab.fileMode)}
                      pageViewMode={isPageViewMode}
                      referenceEntries={referenceEntries}
                      editable={!groupActiveTab.isReadOnly}
                    />
                  );
                })()}
              </div>
            </div>
          ))}
          {isEditorDragActive && (
            <div
              className={`editor-new-group-drop-zone ${editorGroups.length >= MAX_EDITOR_GROUPS ? "disabled" : ""}${editorDropTarget?.type === "new" ? " drop-active" : ""}`}
              onDragOver={(event) => handleEditorDragOver(event, { type: "new" })}
              onDrop={(event) => void handleDropOnNewEditorGroup(event)}
            >
              {editorGroups.length >= MAX_EDITOR_GROUPS
                ? t("editor.dragDrop.maxWindows")
                : editorDragKind === "tab"
                  ? t("editor.dragDrop.moveToNewWindow")
                  : t("editor.dragDrop.openNewWindow")}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="tabs-bar">
            {getOpenTabs().length > 0 ? (
              getOpenTabs().map((tab) => (
                <button
                  key={tab.path}
                  className={`tab-button ${activeFile?.path === tab.path ? "active" : ""}`}
                  draggable
                  onDragStart={(event) => handleTabDragStart(event, tab.path)}
                  onDragEnd={handleTabDragEnd}
                  onClick={() => setActiveFile(tab.path)}
                  onContextMenu={(e) => handleTabContextMenu(e, tab.path)}
                >
                  <span>{tab.name}</span>
                  {tab.isDirty && <span className="dirty-dot" />}
                  <span className="close-tab" onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}>
                    <X size={12} />
                  </span>
                </button>
              ))
            ) : (
              <div className="tabs-empty">{t("editor.tabs.noOpenEditors")}</div>
            )}
          </div>
          {!isNonTextPreviewTab(activeFile) && (
            <div className="panel-header">
              <div className="file-info-row">
                <h2>{activeFile ? activeFile.name : t("editor.header.noFileSelected")}</h2>
                {activeFile && (
                  <span className="save-indicator">
                    {activeFile.isReadOnly
                      ? t("history.readOnly")
                      : activeFile.isDirty
                      ? t("editor.header.unsavedChanges")
                      : lastSavedAt
                        ? t("editor.header.lastSaved", { time: lastSavedAt })
                        : t("editor.header.notSavedYet")}
                  </span>
                )}
              </div>
              <EditorToolbar
                editor={tiptapRef.current?.getEditor() ?? null}
                activeFile={activeFile ? { name: activeFile.name, isDirty: activeFile.isDirty, fileMode: activeFile.fileMode, isReadOnly: activeFile.isReadOnly } : null}
                onToggleFormat={handleToolbarToggleFormat}
                onToggleHeading={handleToolbarToggleHeading}
                onToggleBodyText={handleToolbarToggleBodyText}
                onSetAlignment={handleToolbarSetAlignment}
                onApplyColor={handleToolbarApplyColor}
                onApplyHighlight={handleToolbarApplyHighlight}
                onApplyFontFamily={handleToolbarApplyFontFamily}
                onApplyLineHeight={handleToolbarApplyLineHeight}
                onToggleBlockquote={handleToolbarToggleBlockquote}
                onToggleCodeBlock={handleToolbarToggleCodeBlock}
                onToggleTaskList={handleToolbarToggleTaskList}
                onInsertHorizontalRule={handleToolbarInsertHorizontalRule}
                onInsertTable={handleToolbarInsertTable}
                onTableAction={handleToolbarTableAction}
                onIndent={handleToolbarIndent}
                onOutdent={handleToolbarOutdent}
                onUndo={handleToolbarUndo}
                onRedo={handleToolbarRedo}
                onToggleWordWrap={handleToolbarToggleWordWrap}
                onToggleOutline={handleToolbarToggleOutline}
                onTogglePageView={handleToolbarTogglePageView}
                onToggleFocusMode={handleToolbarToggleFocusMode}
                onSave={handleToolbarSave}
                onExport={handleToolbarExport}
                onInsertImage={handleToolbarInsertImage}
                onInsertLink={handleToolbarInsertLink}
              />
            </div>
          )}
          <div className="editor-main-layout" onDragLeave={handleEditorDragLeave}>
            {isOutlineOpen && activeFile && !isNonTextPreviewTab(activeFile) && (
              <OutlinePanel
                editor={tiptapRef.current?.getEditor() ?? null}
                visible={isOutlineOpen}
                getBlueprintMatches={getBlueprintMatchesForHeading}
                onBlueprintMatchClick={handleOutlineBlueprintClick}
              />
            )}
            <div
              className={`editor-container${isFocusMode ? " focus-mode" : ""}${isPageViewMode ? " page-view-mode" : ""}${editorDropTarget?.type === "group" && editorDropTarget.groupId === activeGroupId ? " drop-active" : ""}`}
              ref={wrapperRef}
              style={{ position: "relative" }}
              onDragOver={(event) => handleEditorDragOver(event, { type: "group", groupId: activeGroupId })}
              onDrop={(event) => void handleDropOnEditorGroup(event, activeGroupId)}
            >
              {editorDropTarget?.type === "group" && editorDropTarget.groupId === activeGroupId && (
                <div className="editor-drop-overlay">
                  {editorDragKind === "tab" ? t("editor.dragDrop.moveHere") : t("editor.dragDrop.openHere")}
                </div>
              )}
              {isFindReplaceOpen && activeFile && !isNonTextPreviewTab(activeFile) && (
                <FindReplacePanel
                  editor={tiptapRef.current?.getEditor() ?? null}
                  onClose={() => setFindReplaceOpen(false)}
                />
              )}
              {isBlueprintTab(activeFile) ? (
                <BlueprintEditor blueprintId={activeFile!.blueprintId!} />
              ) : activeFile?.fileMode === "image" ? (
                <div className="image-preview">
                  <img src={activeFile.content} alt={activeFile.name} />
                  <span>{activeFile.name}</span>
                </div>
              ) : activeFile?.fileMode === "unsupported" ? (
                <div className="empty-state">
                  <p>{t("editor.unsupportedPreview")}</p>
                </div>
              ) : activeFile?.historyViewMode === "compare" ? (
                <HistoryDiffView content={activeFile.content} />
              ) : activeFile ? (
                <TipTapEditor
                  ref={tiptapRef}
                  content={activeFile.content}
                  onChange={activeFile.isReadOnly ? undefined : handleContentChange}
                  onSelectionChange={handleSelectionChange}
                  onEditorStateChange={handleEditorStateChange}
                  onFocus={handleUpdateCursor}
                  onBlur={() => setSelectionPopup((c) => c)}
                  contentFormat={getEditorContentFormat(activeFile.fileMode)}
                  pageViewMode={isPageViewMode}
                  referenceEntries={referenceEntries}
                  editable={!activeFile.isReadOnly}
                />
              ) : rootPath ? (
                <div className="empty-state">
                  <p>{t("editor.empty.openFile")}</p>
                </div>
              ) : recentWorkspaces.length > 0 ? (
                <div className="empty-state">
                  <div className="recent-workspaces">
                  <h3>{t("editor.empty.recentWorkspaces")}</h3>
                  <ul>
                    {recentWorkspaces.map((workspacePath) => {
                      const name = workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? workspacePath;
                      return (
                        <li key={workspacePath} onClick={() => void openRecentWorkspace(workspacePath)} title={workspacePath}>
                          <FolderOpen size={14} />
                          <span className="recent-workspace-name">{name}</span>
                          <span className="recent-workspace-path">{workspacePath}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <button className="clear-recent-btn" onClick={clearRecentWorkspaces}>
                    <Trash2 size={12} />
                    {t("editor.empty.clearRecent")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <p>{t("editor.empty.openFile")}</p>
              </div>
            )}
          </div>
            {isEditorDragActive && (
              <div
                className={`editor-new-group-drop-zone ${editorGroups.length >= MAX_EDITOR_GROUPS ? "disabled" : ""}${editorDropTarget?.type === "new" ? " drop-active" : ""}`}
                onDragOver={(event) => handleEditorDragOver(event, { type: "new" })}
                onDrop={(event) => void handleDropOnNewEditorGroup(event)}
              >
                {editorGroups.length >= MAX_EDITOR_GROUPS
                  ? t("editor.dragDrop.maxWindows")
                  : editorDragKind === "tab"
                    ? t("editor.dragDrop.moveToNewWindow")
                    : t("editor.dragDrop.openNewWindow")}
              </div>
            )}
          </div>
        </>
      )}
      {selectionPopup && !selectionPreview && (
        <div className="selection-popup" style={{ left: selectionPopup.left, top: selectionPopup.top }}>
          <button onClick={() => void handleSelectionAi("polish")} disabled={selectionLoading}>{t("editor.selection.polish")}</button>
          <button onClick={() => void handleSelectionAi("correct")} disabled={selectionLoading}>{t("editor.selection.correct")}</button>
          <button onClick={() => void handleSelectionAi("stylize")} disabled={selectionLoading}>{t("editor.selection.stylize")}</button>
        </div>
      )}
      {selectionPreview && (
        <div className="selection-preview-backdrop" onClick={() => setSelectionPreview(null)}>
          <div className="selection-preview-card" onClick={(event) => event.stopPropagation()}>
            <h3>{t("editor.selection.previewTitle")}</h3>
            <div className="selection-preview-grid">
              <div><h4>{t("editor.selection.original")}</h4><pre>{selectionPreview.original}</pre></div>
              <div><h4>{t("editor.selection.result")}</h4><pre>{selectionPreview.result}</pre></div>
            </div>
            <div className="selection-preview-actions">
              <button className="secondary" onClick={() => { setSelectionPreview(null); setSelectionError(""); }}>{t("editor.common.cancel")}</button>
              <button className="secondary" onClick={() => { applySelectionPreview("insertAfterSelection", selectionPreview.result); setSelectionPreview(null); }}>{t("editor.selection.insertAfter")}</button>
              <button onClick={() => { applySelectionPreview("replaceSelection", selectionPreview.result); setSelectionPreview(null); }}>{t("editor.selection.replaceOriginal")}</button>
            </div>
          </div>
        </div>
      )}
      {selectionError && <div className="selection-error-banner">{selectionError}</div>}
      {isExportDialogOpen && activeFile && (
        <div className="selection-preview-backdrop" onClick={closeExportDialog}>
          <div className="selection-preview-card export-dialog-card" onClick={(event) => event.stopPropagation()}>
            <h3>{t("editor.export.title")}</h3>
            <div className="export-dialog-fields">
              <label>
                  <span>{t("editor.export.format")}</span>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                  <option value="txt">TXT</option>
                  <option value="pdf">PDF</option>
                  <option value="docx">DOCX</option>
                </select>
              </label>
              {exportFormat !== "txt" && (
                <label>
                  <span>{t("editor.export.template")}</span>
                  <select value={exportTemplateId} onChange={(event) => setExportTemplateId(event.target.value as ExportTemplateId)}>
                    {exportTemplates.map((template) => (
                      <option key={template.id} value={template.id}>{template.label}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {exportFormat !== "txt" && (
              <div className="export-template-list">
                {exportTemplates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={`export-template-card ${exportTemplateId === template.id ? "active" : ""}`}
                    onClick={() => setExportTemplateId(template.id)}
                  >
                    <strong>{template.label}</strong>
                    <span>{template.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="selection-preview-actions">
              <button className="secondary" onClick={closeExportDialog}>{t("editor.common.cancel")}</button>
              <button onClick={() => void handleExport()}>{t("editor.export.action")}</button>
            </div>
            {exportError && <div className="selection-error-inline">{exportError}</div>}
          </div>
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleImageInputChange}
      />
      {isLinkDialogOpen && (
        <div className="selection-preview-backdrop" onClick={closeLinkDialog}>
          <div className="selection-preview-card insert-dialog-card" onClick={(event) => event.stopPropagation()}>
            <h3>{t("editor.link.title")}</h3>
            <div className="insert-dialog-fields">
              <label>
                <span>{t("editor.link.text")}</span>
                <input
                  type="text"
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                  placeholder={t("editor.link.textPlaceholder")}
                />
              </label>
              <label>
                <span>{t("editor.link.url")}</span>
                <input
                  type="text"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="https://example.com"
                  onKeyDown={(e) => { if (e.key === "Enter") insertLink(); }}
                />
              </label>
            </div>
            <div className="selection-preview-actions">
              <button className="secondary" onClick={closeLinkDialog}>{t("editor.common.cancel")}</button>
              <button onClick={insertLink} disabled={!linkUrl.trim()}>{t("editor.link.insert")}</button>
            </div>
          </div>
        </div>
      )}
      <div className="editor-statusbar">
        <span>{fileStats.language}</span>
        <span>{t("editor.status.position", { line: cursorPosition.line, column: cursorPosition.column })}</span>
        <span>{selectionLength > 0 ? t("editor.status.selected", { count: selectionLength }) : t("editor.status.words", { count: fileStats.words })}</span>
        <span>{t("editor.status.characters", { count: fileStats.characters })}</span>
        <span>{t("editor.status.paragraphs", { count: fileStats.paragraphs })}</span>
        <span>{t("editor.status.readingTime", { count: fileStats.readingTime })}</span>
        <span>{wordWrap === "on" ? t("editor.status.wrapOn") : t("editor.status.wrapOff")}</span>
      </div>
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.tabPath)}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

export default EditorPanel;
