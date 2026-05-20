import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Download, Save, WrapText, X } from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import "./EditorPanel.css";

const CHARACTER_FILE_NAME = "\u4eba\u7269\u5217\u8868.txt";
const PLACE_FILE_NAME = "\u5730\u7406\u540d\u79f0.txt";
const ITEM_FILE_NAME = "\u9053\u5177\u540d\u79f0.txt";
const EDITOR_THEME = "novel-assistance-dark";
const DESCRIPTION_LIMIT = 20;

const EditorPanel: React.FC = () => {
  const {
    activeFile,
    openTabs,
    referenceEntries,
    setActiveFile,
    closeTab,
    updateFileContent,
    saveFile,
  } = useFileStore();
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const completionDisposableRef = useRef<Array<{ dispose: () => void }>>([]);
  const suggestionTimeoutRef = useRef<number | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [selectionLength, setSelectionLength] = useState(0);
  const [wordWrap, setWordWrap] = useState<"on" | "off">("on");
  const [lastSavedAt, setLastSavedAt] = useState<string>("Not saved yet");

  const isReferenceFile =
    activeFile?.name === CHARACTER_FILE_NAME ||
    activeFile?.name === PLACE_FILE_NAME ||
    activeFile?.name === ITEM_FILE_NAME;

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case "character":
        return "\u4eba\u7269";
      case "place":
        return "\u5730\u540d";
      case "item":
        return "\u9053\u5177";
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

          const suggestions = referenceEntries
            .filter((entry) => !context.partial || entry.name.toLowerCase().includes(context.partial))
            .map((entry) => ({
              label: entry.name,
              kind: getCompletionKind(monaco, entry.category),
              insertText: context.insertMode === "brace" ? `{{${entry.name}}}` : entry.name,
              detail: `${getCategoryLabel(entry.category)} ${getShortDescription(entry.description)}`,
              documentation: getShortDescription(entry.description),
              range,
            }));

          return { suggestions };
        },
      });

    completionDisposableRef.current = [register("markdown"), register("plaintext")];
  };

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    ensureMonacoTheme(monaco);
    monaco.editor.setTheme(EDITOR_THEME);
    registerReferenceCompletionProvider(monaco);

    editor.onDidChangeCursorPosition((event: any) => {
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    editor.onDidChangeCursorSelection((event: any) => {
      setSelectionLength(editor.getModel()?.getValueLengthInRange(event.selection) ?? 0);
    });

    editor.onDidChangeModelContent(() => {
      if (suggestionTimeoutRef.current) {
        window.clearTimeout(suggestionTimeoutRef.current);
      }

      suggestionTimeoutRef.current = window.setTimeout(() => {
        triggerReferenceSuggestions();
      }, 1000);
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
      if (suggestionTimeoutRef.current) {
        window.clearTimeout(suggestionTimeoutRef.current);
      }
    };
  }, []);

  const handleExport = () => {
    if (activeFile?.content) {
      const hasExt = /\.[^/.]+$/.test(activeFile.name);
      const ext = hasExt ? activeFile.name.split(".").pop()?.toLowerCase() : "md";
      const mime = ext === "txt" ? "text/plain" : "text/markdown";
      const blob = new Blob([activeFile.content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filename = hasExt ? activeFile.name : `${activeFile.name}.md`;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const fileStats = useMemo(() => {
    const content = activeFile?.content || "";
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    return {
      characters: content.length,
      words,
      language: activeFile?.name.endsWith(".txt") ? "Plain Text" : "Markdown",
    };
  }, [activeFile]);

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
      <div className="editor-container">
        {activeFile ? (
          <Editor
            key={activeFile.path}
            height="100%"
            defaultLanguage={
              activeFile.name.endsWith(".md")
                ? "markdown"
                : activeFile.name.endsWith(".txt")
                  ? "plaintext"
                  : "markdown"
            }
            value={activeFile.content}
            onChange={handleEditorChange}
            onMount={(editor: any, monaco: any) => handleEditorDidMount(editor, monaco)}
            theme={EDITOR_THEME}
            options={{
              minimap: { enabled: true },
              fontSize: 14,
              lineNumbers: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
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
