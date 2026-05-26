import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Download,
  Heading1,
  Heading2,
  Heading3,
  Save,
  Type,
  WrapText,
  X,
} from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import { useSettingsStore } from "../stores/settingsStore";
import { callAI } from "../services/aiService";
import { readFile, type WorkspaceNode } from "../services/fileSystemService";
import {
  applySelectionPreview,
  registerEditorBridge,
} from "../services/editorInsertionService";
import { exportDocument, getExportTemplates } from "../services/documentExportService";
import type { ExportFormat, ExportTemplateId } from "../types/export";
import { onWorkspaceChanged, unwatchWorkspace, watchWorkspace } from "../services/terminalService";
import { compareNodeNames } from "../../shared/workspaceSort.js";
import "./EditorPanel.css";

const CHARACTER_FILE_NAME = "\u4eba\u7269\u5217\u8868.txt";
const PLACE_FILE_NAME = "\u5730\u7406\u540d\u79f0.txt";
const ITEM_FILE_NAME = "\u9053\u5177\u540d\u79f0.txt";
const SKILL_FILE_NAME = "\u62db\u5f0f\u5217\u8868.txt";
const WORLD_FILE_NAME = "\u4e16\u754c\u89c2.txt";
const EDITOR_THEME = "novel-assistance-dark";
const DESCRIPTION_LIMIT = 20;
const TYPING_SUGGEST_DELAY_MS = 300;
const IDLE_SUGGEST_DELAY_MS = 5000;
const SUGGEST_COOLDOWN_MS = 300000;
const AUTO_SAVE_DELAY_MS = 3000;
const DEFAULT_EDITOR_FONT_FAMILY = "'Noto Serif SC', 'Source Han Serif SC', Georgia, serif";
const DEFAULT_EDITOR_FONT_SIZE = 14;
const TXT_MERGE_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);

type HeadingState = "body" | "h1" | "h2" | "h3";
type AlignmentMode = "center" | "right";
type SelectionAction = "polish" | "correct" | "stylize";

type AlignmentBlock = {
  startLine: number;
  endLine: number;
  alignment: AlignmentMode;
};

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

let markdownFoldingProviderRegistered = false;

const getHeadingLevel = (lineContent: string): 1 | 2 | 3 | null => {
  const match = lineContent.match(/^(#{1,3})\s+\S/);
  if (!match) return null;
  return match[1].length as 1 | 2 | 3;
};

const normalizeHeadingState = (lineContent: string): HeadingState => {
  const level = getHeadingLevel(lineContent);
  if (level === 1) return "h1";
  if (level === 2) return "h2";
  if (level === 3) return "h3";
  return "body";
};

const clampAlignmentBlocks = (blocks: AlignmentBlock[], lineCount: number) =>
  blocks
    .map((block) => ({
      ...block,
      startLine: Math.max(1, Math.min(block.startLine, lineCount)),
      endLine: Math.max(1, Math.min(block.endLine, lineCount)),
    }))
    .filter((block) => block.startLine <= block.endLine);

const mergeAlignmentBlocks = (blocks: AlignmentBlock[]) => {
  const sorted = blocks
    .slice()
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
  const merged: AlignmentBlock[] = [];

  sorted.forEach((block) => {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.alignment === block.alignment &&
      previous.endLine + 1 >= block.startLine
    ) {
      previous.endLine = Math.max(previous.endLine, block.endLine);
      return;
    }
    merged.push({ ...block });
  });

  return merged;
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

const registerMarkdownHeadingFolding = (monaco: any) => {
  if (markdownFoldingProviderRegistered) return;

  monaco.languages.registerFoldingRangeProvider("markdown", {
    provideFoldingRanges(model: any) {
      const headings: Array<{ lineNumber: number; level: 1 | 2 | 3 }> = [];

      for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
        const level = getHeadingLevel(model.getLineContent(lineNumber));
        if (level) headings.push({ lineNumber, level });
      }

      return headings
        .map((heading, index) => {
          let end = model.getLineCount();
          for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
            const nextHeading = headings[nextIndex];
            if (nextHeading.level <= heading.level) {
              end = nextHeading.lineNumber - 1;
              break;
            }
          }

          while (end > heading.lineNumber && !model.getLineContent(end).trim()) {
            end -= 1;
          }

          if (end <= heading.lineNumber) return null;

          return {
            start: heading.lineNumber,
            end,
            kind: monaco.languages.FoldingRangeKind.Region,
          };
        })
        .filter(Boolean);
    },
  });

  markdownFoldingProviderRegistered = true;
};

const EditorPanel: React.FC = () => {
  const {
    files,
    activeFile,
    openTabs,
    referenceEntries,
    rootPath,
    setActiveFile,
    closeTab,
    updateFileContent,
    saveFile,
    saveAllFiles,
    refreshWorkspace,
  } = useFileStore();
  const { defaultSelectionModelId, selectionPromptTemplates, getModelProfileById } = useSettingsStore();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const completionDisposableRef = useRef<Array<{ dispose: () => void }>>([]);
  const suggestionTimeoutRef = useRef<number | null>(null);
  const suggestionCooldownUntilRef = useRef<number>(0);
  const idleTimeoutRef = useRef<number | null>(null);
  const autoSaveTimeoutRef = useRef<number | null>(null);
  const alignmentBlocksByPathRef = useRef<Record<string, AlignmentBlock[]>>({});
  const alignmentDecorationIdsRef = useRef<string[]>([]);
  const alignmentDecorationModesRef = useRef<Record<string, AlignmentMode>>({});
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionLength, setSelectionLength] = useState(0);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [lastSavedAt, setLastSavedAt] = useState<string>("Not saved yet");
  const [activeHeadingState, setActiveHeadingState] = useState<HeadingState>("body");
  const [selectionPopup, setSelectionPopup] = useState<SelectionPopupState | null>(null);
  const [selectionPreview, setSelectionPreview] = useState<SelectionPreviewState | null>(null);
  const [selectionLoading, setSelectionLoading] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("pdf");
  const [exportTemplateId, setExportTemplateId] = useState<ExportTemplateId>("classic");
  const [exportError, setExportError] = useState("");
  const exportTemplates = getExportTemplates();

  const isReferenceFile =
    activeFile?.name === CHARACTER_FILE_NAME ||
    activeFile?.name === PLACE_FILE_NAME ||
    activeFile?.name === ITEM_FILE_NAME ||
    activeFile?.name === SKILL_FILE_NAME ||
    activeFile?.name === WORLD_FILE_NAME;

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case "character":
        return "\u4eba\u7269";
      case "place":
        return "\u5730\u540d";
      case "item":
        return "\u9053\u5177";
      case "skill":
        return "\u62db\u5f0f";
      default:
        return "\u540d\u79f0";
    }
  };

  const getCompletionKind = (monaco: any, category: string) => {
    switch (category) {
      case "character":
        return monaco.languages.CompletionItemKind.Variable;
      case "place":
        return monaco.languages.CompletionItemKind.Reference;
      case "item":
        return monaco.languages.CompletionItemKind.Folder;
      case "skill":
        return monaco.languages.CompletionItemKind.Function;
      default:
        return monaco.languages.CompletionItemKind.Text;
    }
  };

  const getShortDescription = (description: string) => {
    const trimmed = description.trim();
    if (trimmed.length <= DESCRIPTION_LIMIT) return trimmed;
    return `${trimmed.slice(0, DESCRIPTION_LIMIT)}...`;
  };

  const ensureMonacoTheme = (monaco: any) => {
    monaco.editor.defineTheme(EDITOR_THEME, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "symbolIcon.variableForeground": "#ffb86c",
        "symbolIcon.referenceForeground": "#6ad7ff",
        "symbolIcon.folderForeground": "#9effa1",
      },
    });
  };

  const getSuggestionContext = (model: any, position: any) => {
    const lineContent = model.getLineContent(position.lineNumber);
    const beforeCursor = lineContent.slice(0, Math.max(position.column - 1, 0));
    const braceMatch = beforeCursor.match(/\{\{([^}\n]*)$/);

    if (braceMatch) {
      return {
        partial: braceMatch[1].trim().toLowerCase(),
        insertMode: "brace" as const,
        startColumn: beforeCursor.lastIndexOf("{{") + 1,
      };
    }

    if (isReferenceFile) return null;

    // Include middle dot (· U+00B7, U+30FB) for names like "艾莉丝·玛丽亚·弗里尔"
    const plainMatch = beforeCursor.match(/[A-Za-z0-9_\u4e00-\u9fff\u00b7\u30fb-]+$/);
    const token = plainMatch ? plainMatch[0] : "";

    // Find shortest suffix of token that matches a reference entry prefix
    // e.g. token="他觉得艾" → try "艾"→✓ → partial="艾"
    let partial = "";
    if (token) {
      for (let i = token.length - 1; i >= 0; i--) {
        const suffix = token.slice(i).toLowerCase();
        if (referenceEntries.some((entry) => entry.name.toLowerCase().startsWith(suffix))) {
          partial = token.slice(i);
          break;
        }
      }
    }

    if (!partial) return null;

    return {
      partial: partial.toLowerCase(),
      insertMode: "plain" as const,
      startColumn: position.column - partial.length,
    };
  };

  const getSuggestionScore = (entryName: string, partial: string) => {
    if (!partial) return 1000;
    const normalizedName = entryName.toLowerCase();
    if (normalizedName === partial) return 4000;
    if (normalizedName.startsWith(partial)) return 3000 - normalizedName.length;
    const index = normalizedName.indexOf(partial);
    if (index >= 0) return 2000 - index;
    return 100;
  };

  const triggerReferenceSuggestions = () => {
    const editor = editorRef.current;
    if (!editor || referenceEntries.length === 0 || isReferenceFile) return;
    const model = editor.getModel();
    const position = editor.getPosition();
    if (!model || !position) return;
    const context = getSuggestionContext(model, position);
    if (!context) return;
    editor.trigger("reference-suggestions", "editor.action.triggerSuggest", {});
  };

  const registerReferenceCompletionProvider = (monaco: any) => {
    completionDisposableRef.current.forEach((disposable) => disposable.dispose());
    completionDisposableRef.current = [];

    const register = (language: string) =>
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ["{"],
        provideCompletionItems: (model: any, position: any) => {
          const context = getSuggestionContext(model, position);
          if (!context || !context.partial) {
            return { suggestions: [] };
          }

          const range = new monaco.Range(
            position.lineNumber,
            context.startColumn,
            position.lineNumber,
            position.column
          );

          const matchingEntries = referenceEntries.filter((entry) =>
            entry.name.toLowerCase().startsWith(context.partial)
          );

          const candidateEntries = matchingEntries.filter(
            (entry) => entry.name.toLowerCase() !== context.partial
          );

          if (candidateEntries.length === 0) {
            return { suggestions: [] };
          }

          const suggestions = candidateEntries
            .slice()
            .sort((left, right) => {
              const scoreDifference =
                getSuggestionScore(right.name, context.partial) - getSuggestionScore(left.name, context.partial);
              if (scoreDifference !== 0) return scoreDifference;
              return left.name.localeCompare(right.name, "zh-Hans-CN", { sensitivity: "base" });
            })
            .map((entry) => ({
              label: entry.name,
              kind: getCompletionKind(monaco, entry.category),
              insertText: context.insertMode === "brace" ? `{{${entry.name}}}` : entry.name,
              filterText: entry.name,
              detail: `${getCategoryLabel(entry.category)} ${getShortDescription(entry.description)}`,
              documentation: getShortDescription(entry.description),
              range,
            }));

          return { suggestions };
        },
      });

    completionDisposableRef.current = [register("markdown"), register("plaintext")];
  };

  const relayoutEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    requestAnimationFrame(() => {
      editor.layout();
      editor.render(true);
    });
  };

  const syncHeadingState = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || isReferenceFile) {
      setActiveHeadingState("body");
      return;
    }
    const selection = editor.getSelection();
    const lineNumber = selection?.startLineNumber ?? editor.getPosition()?.lineNumber ?? 1;
    setActiveHeadingState(normalizeHeadingState(model.getLineContent(lineNumber)));
  };

  const snapshotAlignmentBlocks = (path = activeFile?.path) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!path || !model) return;
    const lineCount = model.getLineCount();
    const blocks = alignmentDecorationIdsRef.current
      .map((decorationId) => {
        const range = model.getDecorationRange(decorationId);
        const alignment = alignmentDecorationModesRef.current[decorationId];
        if (!range || !alignment) return null;
        return {
          startLine: range.startLineNumber,
          endLine: range.endLineNumber,
          alignment,
        };
      })
      .filter(Boolean) as AlignmentBlock[];
    alignmentBlocksByPathRef.current[path] = mergeAlignmentBlocks(clampAlignmentBlocks(blocks, lineCount));
  };

  const applyAlignmentDecorations = (path = activeFile?.path) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const monaco = monacoRef.current;
    if (!editor || !model || !monaco || !path) return;
    const lineCount = model.getLineCount();
    const blocks = mergeAlignmentBlocks(
      clampAlignmentBlocks(alignmentBlocksByPathRef.current[path] ?? [], lineCount)
    );

    const nextModes: Record<string, AlignmentMode> = {};
    const nextDecorationIds = editor.deltaDecorations(
      alignmentDecorationIdsRef.current,
      blocks.map((block) => ({
        range: new monaco.Range(block.startLine, 1, block.endLine, 1),
        options: {
          isWholeLine: true,
          wholeLineClassName:
            block.alignment === "center" ? "editor-align-center" : "editor-align-right",
        },
      }))
    );

    nextDecorationIds.forEach((decorationId: string, index: number) => {
      nextModes[decorationId] = blocks[index].alignment;
    });

    alignmentDecorationIdsRef.current = nextDecorationIds;
    alignmentDecorationModesRef.current = nextModes;
    alignmentBlocksByPathRef.current[path] = blocks;
  };

  const updateAlignmentBlocks = (alignment: "left" | AlignmentMode) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !activeFile?.path) return;

    snapshotAlignmentBlocks(activeFile.path);
    const lineCount = model.getLineCount();
    const selections = editor.getSelections() ?? [];
    let nextBlocks = alignmentBlocksByPathRef.current[activeFile.path] ?? [];

    selections.forEach((selection: any) => {
      const startLine = Math.max(1, Math.min(selection.startLineNumber, lineCount));
      const endLine = Math.max(1, Math.min(selection.endLineNumber, lineCount));
      const preservedBlocks = nextBlocks.flatMap((block) => {
        if (block.endLine < startLine || block.startLine > endLine) return [block];
        const updated: AlignmentBlock[] = [];
        if (block.startLine < startLine) updated.push({ ...block, endLine: startLine - 1 });
        if (block.endLine > endLine) updated.push({ ...block, startLine: endLine + 1 });
        return updated;
      });

      nextBlocks = preservedBlocks;
      if (alignment !== "left") {
        nextBlocks.push({ startLine, endLine, alignment });
      }
    });

    alignmentBlocksByPathRef.current[activeFile.path] = mergeAlignmentBlocks(
      clampAlignmentBlocks(nextBlocks, lineCount)
    );
    applyAlignmentDecorations(activeFile.path);
    editor.focus();
  };

  const applyEdits = (edits: Array<{ range: any; text: string }>, source = "format-toolbar") => {
    const editor = editorRef.current;
    if (!editor || edits.length === 0) return;
    editor.executeEdits(source, edits);
    requestAnimationFrame(() => {
      syncHeadingState();
      relayoutEditor();
    });
    editor.focus();
  };

  const transformSelectedBlocks = (transform: (text: string) => string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const monaco = monacoRef.current;
    if (!editor || !model || !monaco) return;

    const edits = (editor.getSelections() ?? []).map((selection: any) => {
      const startLine = selection.startLineNumber;
      const endLine = selection.endLineNumber;
      const range = new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
      return {
        range,
        text: transform(model.getValueInRange(range)),
      };
    });

    applyEdits(edits);
  };

  const applyHeading = (level: 1 | 2 | 3) => {
    const marker = `${"#".repeat(level)} `;
    transformSelectedBlocks((text) =>
      text
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          return marker + trimmed.replace(/^#{1,6}\s+/, "");
        })
        .join("\n")
    );
  };

  const applyBodyText = () => {
    const editor = editorRef.current;
    editor?.trigger("format-toolbar", "editor.unfold", null);
    transformSelectedBlocks((text) =>
      text
        .split("\n")
        .map((line) => line.replace(/^#{1,6}\s+/, ""))
        .join("\n")
    );
    requestAnimationFrame(() => {
      editor?.trigger("format-toolbar", "editor.unfold", null);
    });
  };

  const applyAlignment = (alignment: "left" | AlignmentMode) => {
    updateAlignmentBlocks(alignment);
  };

  const handleSelectionAi = async (mode: SelectionAction) => {
    const modelProfile = getModelProfileById(defaultSelectionModelId);
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selectedText = editor?.getModel()?.getValueInRange(editor.getSelection())?.trim() ?? "";
    if (!modelProfile || !editor || !model || !selectedText) return;

    setSelectionLoading(true);
    setSelectionError("");
    try {
      const prompt = selectionPromptTemplates[mode];
      const result = await callAI({
        modelProfile,
        taskType: mode,
        userMessage: selectedText,
        documentContext: model.getValue(),
        documentFileName: activeFile?.name,
        conversationHistory: [],
        selectionPrompt: prompt,
      });

      setSelectionPreview({
        mode,
        original: selectedText,
        result,
      });
      setSelectionPopup(null);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "AI request failed.");
    } finally {
      setSelectionLoading(false);
    }
  };

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    ensureMonacoTheme(monaco);
    registerMarkdownHeadingFolding(monaco);
    monaco.editor.setTheme(EDITOR_THEME);
    registerReferenceCompletionProvider(monaco);
    applyAlignmentDecorations(activeFile?.path);
    syncHeadingState();

    registerEditorBridge({
      getSelectionText: () => editor.getModel()?.getValueInRange(editor.getSelection()) ?? "",
      getSelectionRange: () => editor.getSelection() ?? null,
      getContent: () => editor.getModel()?.getValue() ?? "",
      applyText: ({ mode, text }) => {
        const selection = editor.getSelection();
        const model = editor.getModel();
        if (!selection || !model) return;
        const monacoRange = new monaco.Range(
          selection.startLineNumber,
          selection.startColumn,
          selection.endLineNumber,
          selection.endColumn
        );

        if (mode === "replaceSelection") {
          applyEdits([{ range: monacoRange, text }], "selection-preview");
          return;
        }

        if (mode === "insertAfterSelection") {
          const range = new monaco.Range(
            selection.endLineNumber,
            selection.endColumn,
            selection.endLineNumber,
            selection.endColumn
          );
          applyEdits([{ range, text: `\n${text}` }], "selection-preview");
          return;
        }

        if (selection.isEmpty()) {
          applyEdits([{ range: monacoRange, text }], "editor-insert");
        } else {
          applyEdits([{ range: monacoRange, text }], "editor-insert");
        }
      },
      focus: () => editor.focus(),
    });

    editor.onDidChangeCursorPosition((event: any) => {
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
      syncHeadingState();
    });

    editor.onDidChangeCursorSelection((event: any) => {
      const selectedText = editor.getModel()?.getValueInRange(event.selection) ?? "";
      setSelectionLength(editor.getModel()?.getValueLengthInRange(event.selection) ?? 0);
      syncHeadingState();

      if (isReferenceFile || !selectedText.trim()) {
        setSelectionPopup(null);
        return;
      }

      const selections = editor.getSelections() ?? [];
      if (selections.length !== 1) {
        setSelectionPopup(null);
        return;
      }

      const visibleRanges = editor.getScrolledVisiblePosition({
        lineNumber: event.selection.endLineNumber,
        column: event.selection.endColumn,
      });

      const editorRect = editor.getDomNode()?.getBoundingClientRect();
      if (!visibleRanges || !editorRect) return;

      setSelectionPopup({
        text: selectedText,
        left: editorRect.left + visibleRanges.left,
        top: editorRect.top + visibleRanges.top - 10,
      });
    });

    editor.onDidBlurEditorText(() => {
      window.setTimeout(() => {
        setSelectionPopup((current) => current);
      }, 0);
    });

    editor.onKeyDown((e: any) => {
      if (e.keyCode === monaco.KeyCode.Escape) {
        const editorDom = editor.getDomNode();
        const suggestWidget = editorDom?.querySelector(".suggest-widget");
        if (suggestWidget && suggestWidget.classList.contains("visible")) {
          suggestionCooldownUntilRef.current = Date.now() + SUGGEST_COOLDOWN_MS;
        }
      }
    });

    editor.onDidChangeModelContent(() => {
      if (suggestionTimeoutRef.current) window.clearTimeout(suggestionTimeoutRef.current);
      if (idleTimeoutRef.current) window.clearTimeout(idleTimeoutRef.current);

      // Typing trigger: short delay, check if partial matches entries
      suggestionTimeoutRef.current = window.setTimeout(() => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        const position = editor?.getPosition();
        if (!model || !position) return;
        const context = getSuggestionContext(model, position);
        if (context && context.partial) {
          const hasMatch = referenceEntries.some(
            (entry) =>
              entry.name.toLowerCase().startsWith(context.partial) &&
              entry.name.toLowerCase() !== context.partial
          );
          if (hasMatch) {
            suggestionCooldownUntilRef.current = 0;
            triggerReferenceSuggestions();
          }
        }
      }, TYPING_SUGGEST_DELAY_MS);

      // Idle trigger: 5 seconds, respects cooldown
      idleTimeoutRef.current = window.setTimeout(() => {
        if (Date.now() < suggestionCooldownUntilRef.current) return;
        const editor = editorRef.current;
        const model = editor?.getModel();
        const position = editor?.getPosition();
        if (!model || !position) return;
        const context = getSuggestionContext(model, position);
        if (context && context.partial) {
          const hasMatch = referenceEntries.some(
            (entry) =>
              entry.name.toLowerCase().startsWith(context.partial) &&
              entry.name.toLowerCase() !== context.partial
          );
          if (hasMatch) {
            triggerReferenceSuggestions();
          }
        }
      }, IDLE_SUGGEST_DELAY_MS);

      syncHeadingState();
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (activeFile && value !== undefined) {
      updateFileContent(activeFile.path, value);
    }
  };

  const handleSave = async () => {
    if (!activeFile) return;
    await saveFile(activeFile.path);
    setLastSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  };

  useEffect(() => {
    if (monacoRef.current) registerReferenceCompletionProvider(monacoRef.current);
  }, [referenceEntries, isReferenceFile, activeFile?.path]);

  useEffect(() => {
    if (!editorContainerRef.current) return;
    const resizeObserver = new ResizeObserver(() => {
      relayoutEditor();
    });
    resizeObserver.observe(editorContainerRef.current);
    return () => resizeObserver.disconnect();
  }, [activeFile?.path]);

  useEffect(() => {
    if (autoSaveTimeoutRef.current) window.clearTimeout(autoSaveTimeoutRef.current);
    if (!activeFile?.isDirty) return;

    autoSaveTimeoutRef.current = window.setTimeout(() => {
      void saveAllFiles().then(() => {
        setLastSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      });
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (autoSaveTimeoutRef.current) window.clearTimeout(autoSaveTimeoutRef.current);
    };
  }, [activeFile?.content, activeFile?.isDirty, activeFile?.path, saveAllFiles]);

  useEffect(() => {
    if (!rootPath) return;

    void watchWorkspace(rootPath);
    const disposeWorkspaceChanged = onWorkspaceChanged(({ rootPath: changedRootPath }) => {
      if (changedRootPath === rootPath) void refreshWorkspace();
    });

    const handleFocus = () => {
      void refreshWorkspace();
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
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
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFile]);

  useEffect(() => {
    return () => {
      completionDisposableRef.current.forEach((disposable) => disposable.dispose());
      if (suggestionTimeoutRef.current) window.clearTimeout(suggestionTimeoutRef.current);
      if (idleTimeoutRef.current) window.clearTimeout(idleTimeoutRef.current);
      if (autoSaveTimeoutRef.current) window.clearTimeout(autoSaveTimeoutRef.current);
      registerEditorBridge(null);
    };
  }, []);

  useEffect(() => {
    return () => {
      snapshotAlignmentBlocks(activeFile?.path);
    };
  }, [activeFile?.path]);

  useEffect(() => {
    if (!activeFile?.path || !editorRef.current) {
      alignmentDecorationIdsRef.current = [];
      alignmentDecorationModesRef.current = {};
      setActiveHeadingState("body");
      return;
    }
    applyAlignmentDecorations(activeFile.path);
    syncHeadingState();
  }, [activeFile?.path, isReferenceFile]);

  const handleExport = async () => {
    if (!activeFile) {
      setExportError("There is no content to export.");
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
          throw new Error("No text files were found in this folder to merge and export.");
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
          setExportError("There is no content to export.");
          return;
        }

        const filenameBase = activeFile.name.replace(/\.[^/.]+$/, "");
        await exportDocument({
          format: exportFormat,
          templateId: exportTemplateId,
          title: filenameBase || activeFile.name,
          content: activeFile.content,
          filenameBase: filenameBase || "document",
        });
      }
      setExportError("");
      setIsExportDialogOpen(false);
      setIsExportMenuOpen(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Failed to export document.");
    }
  };

  const toolbarButtonClass = (isActive = false) => `toolbar-button${isActive ? " active" : ""}`;

  const fileStats = useMemo(() => {
    const content = activeFile?.content || "";
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return {
      characters: content.length,
      words,
      language: isReferenceFile ? "Plain Text" : "Markdown",
    };
  }, [activeFile, isReferenceFile]);

  return (
    <div className="editor-panel">
      <div className="tabs-bar">
        {openTabs.length > 0 ? (
          openTabs.map((tab) => (
            <button
              key={tab.path}
              className={`tab-button ${activeFile?.path === tab.path ? "active" : ""}`}
              onClick={() => setActiveFile(tab.path)}
            >
              <span>{tab.name}</span>
              {tab.isDirty && <span className="dirty-dot" />}
              <span
                className="close-tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.path);
                }}
              >
                <X size={12} />
              </span>
            </button>
          ))
        ) : (
          <div className="tabs-empty">No open editors</div>
        )}
      </div>
      <div className="panel-header">
        <div className="editor-title-group">
          <h2>{activeFile ? activeFile.name : "No file selected"}</h2>
          {activeFile && (
            <span className="save-indicator">
              {activeFile.isDirty ? "Unsaved changes" : `Last saved ${lastSavedAt}`}
            </span>
          )}
        </div>
        <div className="panel-actions">
          <div className="format-toolbar">
            <button
              className={toolbarButtonClass(activeHeadingState === "h1")}
              onClick={() => applyHeading(1)}
              title="Heading 1"
              disabled={!activeFile || isReferenceFile}
            >
              <Heading1 size={16} />
            </button>
            <button
              className={toolbarButtonClass(activeHeadingState === "h2")}
              onClick={() => applyHeading(2)}
              title="Heading 2"
              disabled={!activeFile || isReferenceFile}
            >
              <Heading2 size={16} />
            </button>
            <button
              className={toolbarButtonClass(activeHeadingState === "h3")}
              onClick={() => applyHeading(3)}
              title="Heading 3"
              disabled={!activeFile || isReferenceFile}
            >
              <Heading3 size={16} />
            </button>
            <button
              className={toolbarButtonClass(activeHeadingState === "body")}
              onClick={applyBodyText}
              title="Body Text"
              disabled={!activeFile || isReferenceFile}
            >
              <Type size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={() => applyAlignment("left")} title="Align Left" disabled={!activeFile}>
              <AlignLeft size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={() => applyAlignment("center")} title="Align Center" disabled={!activeFile}>
              <AlignCenter size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={() => applyAlignment("right")} title="Align Right" disabled={!activeFile}>
              <AlignRight size={16} />
            </button>
          </div>
          <button onClick={() => void handleSave()} title="Save" disabled={!activeFile}>
            <Save size={16} />
          </button>
          <button
            onClick={() => setWordWrap((current) => (current === "on" ? "off" : "on"))}
            title="Toggle Word Wrap"
            disabled={!activeFile}
          >
            <WrapText size={16} />
          </button>
          <div className="export-menu-wrap">
            <button
              onClick={() => setIsExportMenuOpen((current) => !current)}
              title="Export"
              disabled={!activeFile}
            >
              <Download size={16} />
              <ChevronDown size={14} />
            </button>
            {isExportMenuOpen && activeFile && (
              <div className="export-menu">
                <button
                  type="button"
                  onClick={() => {
                    setExportFormat("txt");
                    setIsExportDialogOpen(true);
                    setIsExportMenuOpen(false);
                  }}
                >
                  Export as TXT
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportFormat("pdf");
                    setIsExportDialogOpen(true);
                    setIsExportMenuOpen(false);
                  }}
                >
                  Export as PDF
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setExportFormat("docx");
                    setIsExportDialogOpen(true);
                    setIsExportMenuOpen(false);
                  }}
                >
                  Export as DOCX
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="editor-container" ref={editorContainerRef}>
        {activeFile ? (
          <Editor
            key={activeFile.path}
            height="100%"
            defaultLanguage={isReferenceFile ? "plaintext" : "markdown"}
            value={activeFile.content}
            onChange={handleEditorChange}
            onMount={(editor: any, monaco: any) => handleEditorDidMount(editor, monaco)}
            theme={EDITOR_THEME}
            options={{
              minimap: { enabled: true },
              fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
              fontSize: DEFAULT_EDITOR_FONT_SIZE,
              lineNumbers: "on",
              scrollBeyondLastLine: true,
              automaticLayout: true,
              wordWrap,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
              folding: !isReferenceFile,
              showFoldingControls: "mouseover",
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              acceptSuggestionOnEnter: "off",
              formatOnPaste: true,
              formatOnType: true,
              smoothScrolling: true,
              cursorBlinking: "smooth",
            }}
          />
        ) : (
          <div className="empty-state">
            <p>Open a file from Explorer to start editing</p>
          </div>
        )}
      </div>
      {selectionPopup && !selectionPreview && (
        <div className="selection-popup" style={{ left: selectionPopup.left, top: selectionPopup.top }}>
          <button onClick={() => void handleSelectionAi("polish")} disabled={selectionLoading}>润色</button>
          <button onClick={() => void handleSelectionAi("correct")} disabled={selectionLoading}>纠错</button>
          <button onClick={() => void handleSelectionAi("stylize")} disabled={selectionLoading}>风格化</button>
        </div>
      )}
      {selectionPreview && (
        <div className="selection-preview-backdrop" onClick={() => setSelectionPreview(null)}>
          <div className="selection-preview-card" onClick={(event) => event.stopPropagation()}>
            <h3>AI 文本处理预览</h3>
            <div className="selection-preview-grid">
              <div>
                <h4>原文</h4>
                <pre>{selectionPreview.original}</pre>
              </div>
              <div>
                <h4>结果</h4>
                <pre>{selectionPreview.result}</pre>
              </div>
            </div>
            <div className="selection-preview-actions">
              <button
                className="secondary"
                onClick={() => {
                  setSelectionPreview(null);
                  setSelectionError("");
                }}
              >
                取消
              </button>
              <button
                className="secondary"
                onClick={() => {
                  applySelectionPreview("insertAfterSelection", selectionPreview.result);
                  setSelectionPreview(null);
                }}
              >
                插入到后方
              </button>
              <button
                onClick={() => {
                  applySelectionPreview("replaceSelection", selectionPreview.result);
                  setSelectionPreview(null);
                }}
              >
                替换原文
              </button>
            </div>
          </div>
        </div>
      )}
      {selectionError && <div className="selection-error-banner">{selectionError}</div>}
      {isExportDialogOpen && activeFile && (
        <div className="selection-preview-backdrop" onClick={() => setIsExportDialogOpen(false)}>
          <div className="selection-preview-card export-dialog-card" onClick={(event) => event.stopPropagation()}>
            <h3>Export Document</h3>
            <div className="export-dialog-fields">
              <label>
                <span>Format</span>
                <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                  <option value="txt">TXT</option>
                  <option value="pdf">PDF</option>
                  <option value="docx">DOCX</option>
                </select>
              </label>
              {exportFormat !== "txt" && (
                <label>
                  <span>Template</span>
                  <select
                    value={exportTemplateId}
                    onChange={(event) => setExportTemplateId(event.target.value as ExportTemplateId)}
                  >
                    {exportTemplates.map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
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
              <button className="secondary" onClick={() => setIsExportDialogOpen(false)}>
                Cancel
              </button>
              <button onClick={() => void handleExport()}>
                Export
              </button>
            </div>
            {exportError && <div className="selection-error-inline">{exportError}</div>}
          </div>
        </div>
      )}
      <div className="editor-statusbar">
        <span>{fileStats.language}</span>
        <span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
        <span>{selectionLength > 0 ? `${selectionLength} selected` : `${fileStats.words} words`}</span>
        <span>{fileStats.characters} chars</span>
        <span>{wordWrap === "on" ? "Wrap On" : "Wrap Off"}</span>
      </div>
    </div>
  );
};

export default EditorPanel;
