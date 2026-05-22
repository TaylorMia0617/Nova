import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Download,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Save,
  Strikethrough,
  Type,
  Underline,
  WrapText,
  X,
} from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import "./EditorPanel.css";

const CHARACTER_FILE_NAME = "\u4eba\u7269\u5217\u8868.txt";
const PLACE_FILE_NAME = "\u5730\u7406\u540d\u79f0.txt";
const ITEM_FILE_NAME = "\u9053\u5177\u540d\u79f0.txt";
const SKILL_FILE_NAME = "\u62db\u5f0f\u5217\u8868.txt";
const WORLD_FILE_NAME = "\u4e16\u754c\u89c2.txt";
const EDITOR_THEME = "novel-assistance-dark";
const DESCRIPTION_LIMIT = 20;
const TYPING_SUGGEST_DELAY_MS = 1000;
const PUNCTUATION_SUGGEST_DELAY_MS = 2000;
const AUTO_SAVE_DELAY_MS = 3000;
const PROJECT_REFRESH_INTERVAL_MS = 5000;
const REFERENCE_PUNCTUATION = /[\u3002\uFF01\uFF1F!?\uFF1B;\uFF1A:\uFF0C,\u3001]$/;
const EDITOR_FONT_FAMILIES = [
  { label: "Serif", value: "'Noto Serif SC', 'Source Han Serif SC', Georgia, serif" },
  { label: "Sans", value: "'Noto Sans SC', 'Source Han Sans SC', 'Segoe UI', sans-serif" },
  { label: "Mono", value: "'Cascadia Mono', Consolas, 'Courier New', monospace" },
] as const;
const EDITOR_FONT_SIZES = [12, 14, 16, 18, 20, 24] as const;
const EDITOR_FONT_FAMILY_VALUES = EDITOR_FONT_FAMILIES.map((option) => option.value);

type HeadingState = "body" | "h1" | "h2" | "h3";
type AlignmentMode = "center" | "right";
type EditorFontFamily = (typeof EDITOR_FONT_FAMILIES)[number]["value"];

type AlignmentBlock = {
  startLine: number;
  endLine: number;
  alignment: AlignmentMode;
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

const registerMarkdownHeadingFolding = (monaco: any) => {
  if (markdownFoldingProviderRegistered) return;

  monaco.languages.registerFoldingRangeProvider("markdown", {
    provideFoldingRanges(model: any) {
      const headings: Array<{ lineNumber: number; level: 1 | 2 | 3 }> = [];

      for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
        const level = getHeadingLevel(model.getLineContent(lineNumber));
        if (level) {
          headings.push({ lineNumber, level });
        }
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

          if (end <= heading.lineNumber) {
            return null;
          }

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
    activeFile,
    openTabs,
    referenceEntries,
    setActiveFile,
    closeTab,
    updateFileContent,
    saveFile,
    saveAllFiles,
    refreshWorkspace,
  } = useFileStore();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const completionDisposableRef = useRef<Array<{ dispose: () => void }>>([]);
  const suggestionTimeoutRef = useRef<number | null>(null);
  const autoSaveTimeoutRef = useRef<number | null>(null);
  const refreshIntervalRef = useRef<number | null>(null);
  const alignmentBlocksByPathRef = useRef<Record<string, AlignmentBlock[]>>({});
  const alignmentDecorationIdsRef = useRef<string[]>([]);
  const alignmentDecorationModesRef = useRef<Record<string, AlignmentMode>>({});
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionLength, setSelectionLength] = useState(0);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [lastSavedAt, setLastSavedAt] = useState<string>("Not saved yet");
  const [fontFamily, setFontFamily] = useState<EditorFontFamily>(EDITOR_FONT_FAMILIES[0].value);
  const [fontSize, setFontSize] = useState<number>(14);
  const [activeHeadingState, setActiveHeadingState] = useState<HeadingState>("body");

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

    if (isReferenceFile) {
      return null;
    }

    const plainMatch = beforeCursor.match(/[A-Za-z0-9_\u4e00-\u9fff-]+$/);
    const partial = plainMatch ? plainMatch[0] : "";

    return {
      partial: partial.toLowerCase(),
      insertMode: "plain" as const,
      startColumn: position.column - partial.length,
    };
  };

  const getInsertedTextFromChanges = (changes: Array<{ text: string }>) => changes.map((change) => change.text).join("");

  const getSuggestionDelay = (insertedText: string) => {
    const trimmed = insertedText.trimEnd();
    if (!trimmed) return TYPING_SUGGEST_DELAY_MS;
    return REFERENCE_PUNCTUATION.test(trimmed) ? PUNCTUATION_SUGGEST_DELAY_MS : TYPING_SUGGEST_DELAY_MS;
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
          if (!context || (context.insertMode === "plain" && referenceEntries.length === 0)) {
            return { suggestions: [] };
          }

          const range = new monaco.Range(
            position.lineNumber,
            context.startColumn,
            position.lineNumber,
            position.column
          );

          const matchingEntries = context.partial
            ? referenceEntries.filter((entry) => entry.name.toLowerCase().includes(context.partial))
            : referenceEntries;
          const candidateEntries = matchingEntries.length > 0 ? matchingEntries : referenceEntries;

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
              filterText:
                matchingEntries.length > 0 || !context.partial ? entry.name : `${context.partial} ${entry.name}`,
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
        if (block.endLine < startLine || block.startLine > endLine) {
          return [block];
        }

        const updated: AlignmentBlock[] = [];
        if (block.startLine < startLine) {
          updated.push({
            ...block,
            endLine: startLine - 1,
          });
        }
        if (block.endLine > endLine) {
          updated.push({
            ...block,
            startLine: endLine + 1,
          });
        }
        return updated;
      });

      nextBlocks = preservedBlocks;
      if (alignment !== "left") {
        nextBlocks.push({
          startLine,
          endLine,
          alignment,
        });
      }
    });

    alignmentBlocksByPathRef.current[activeFile.path] = mergeAlignmentBlocks(
      clampAlignmentBlocks(nextBlocks, lineCount)
    );
    applyAlignmentDecorations(activeFile.path);
    editor.focus();
  };

  const applyEdits = (edits: Array<{ range: any; text: string }>) => {
    const editor = editorRef.current;
    if (!editor || edits.length === 0) return;
    editor.executeEdits("format-toolbar", edits);
    requestAnimationFrame(() => {
      syncHeadingState();
      relayoutEditor();
    });
    editor.focus();
  };

  const wrapSelection = (prefix: string, suffix = prefix) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const edits = (editor.getSelections() ?? []).map((selection: any) => {
      const selectedText = model.getValueInRange(selection);
      return {
        range: selection,
        text: `${prefix}${selectedText || "\u6587\u672c"}${suffix}`,
      };
    });

    applyEdits(edits);
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

  const handleFontFamilyChange = (value: string) => {
    if (EDITOR_FONT_FAMILY_VALUES.includes(value as EditorFontFamily)) {
      setFontFamily(value as EditorFontFamily);
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

    editor.onDidChangeCursorPosition((event: any) => {
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
      syncHeadingState();
    });

    editor.onDidChangeCursorSelection((event: any) => {
      setSelectionLength(editor.getModel()?.getValueLengthInRange(event.selection) ?? 0);
      syncHeadingState();
    });

    editor.onDidChangeModelContent((event: any) => {
      if (suggestionTimeoutRef.current) {
        window.clearTimeout(suggestionTimeoutRef.current);
      }

      const insertedText = getInsertedTextFromChanges(event.changes ?? []);
      suggestionTimeoutRef.current = window.setTimeout(() => {
        const trimmed = insertedText.trimEnd();
        if (!trimmed || REFERENCE_PUNCTUATION.test(trimmed) || /[A-Za-z0-9_\u4e00-\u9fff-]+$/.test(trimmed)) {
          triggerReferenceSuggestions();
        }
      }, getSuggestionDelay(insertedText));

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
    if (monacoRef.current) {
      registerReferenceCompletionProvider(monacoRef.current);
    }
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
    if (autoSaveTimeoutRef.current) {
      window.clearTimeout(autoSaveTimeoutRef.current);
    }

    if (!activeFile?.isDirty) return;

    autoSaveTimeoutRef.current = window.setTimeout(() => {
      void saveAllFiles();
      setLastSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }, AUTO_SAVE_DELAY_MS);

    return () => {
      if (autoSaveTimeoutRef.current) {
        window.clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [activeFile?.content, activeFile?.isDirty, activeFile?.path, saveAllFiles]);

  useEffect(() => {
    refreshIntervalRef.current = window.setInterval(() => {
      void refreshWorkspace();
    }, PROJECT_REFRESH_INTERVAL_MS);

    return () => {
      if (refreshIntervalRef.current) {
        window.clearInterval(refreshIntervalRef.current);
      }
    };
  }, [refreshWorkspace]);

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
      if (autoSaveTimeoutRef.current) window.clearTimeout(autoSaveTimeoutRef.current);
      if (refreshIntervalRef.current) window.clearInterval(refreshIntervalRef.current);
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

  const handleExport = () => {
    if (!activeFile?.content) return;
    const hasExt = /\.[^/.]+$/.test(activeFile.name);
    const ext = hasExt ? activeFile.name.split(".").pop()?.toLowerCase() : "md";
    const mime = ext === "txt" ? "text/plain" : "text/markdown";
    const blob = new Blob([activeFile.content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = hasExt ? activeFile.name : `${activeFile.name}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toolbarButtonClass = (isActive = false) =>
    `toolbar-button${isActive ? " active" : ""}`;

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
            <select
              className="toolbar-select"
              value={fontFamily}
              onChange={(event) => handleFontFamilyChange(event.target.value)}
              title="Font Family"
              disabled={!activeFile}
            >
              {EDITOR_FONT_FAMILIES.map((option) => (
                <option key={option.label} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className="toolbar-select toolbar-size"
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
              title="Font Size"
              disabled={!activeFile}
            >
              {EDITOR_FONT_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
            <button className={toolbarButtonClass()} onClick={() => wrapSelection("**")} title="Bold" disabled={!activeFile}>
              <Bold size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={() => wrapSelection("*")} title="Italic" disabled={!activeFile}>
              <Italic size={16} />
            </button>
            <button
              className={toolbarButtonClass()}
              onClick={() => wrapSelection("<u>", "</u>")}
              title="Underline"
              disabled={!activeFile}
            >
              <Underline size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={() => wrapSelection("~~")} title="Strikethrough" disabled={!activeFile}>
              <Strikethrough size={16} />
            </button>
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
          <button onClick={handleExport} title="Export" disabled={!activeFile}>
            <Download size={16} />
          </button>
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
              fontFamily,
              fontSize,
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
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: "smart",
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
