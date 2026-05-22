type EditorRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type EditorApplyOptions = {
  mode?: "replaceSelection" | "insertAfterSelection" | "insertAtCursor" | "appendToDocument";
  text: string;
};

type EditorBridge = {
  getSelectionText: () => string;
  getSelectionRange: () => EditorRange | null;
  getContent: () => string;
  applyText: (options: EditorApplyOptions) => void;
  focus: () => void;
};

let editorBridge: EditorBridge | null = null;

export function registerEditorBridge(bridge: EditorBridge | null) {
  editorBridge = bridge;
}

export function getEditorSelectionText() {
  return editorBridge?.getSelectionText() ?? "";
}

export function getEditorContent() {
  return editorBridge?.getContent() ?? "";
}

export function insertTextIntoEditor(text: string) {
  if (!editorBridge) return false;
  editorBridge.applyText({ mode: "insertAtCursor", text });
  editorBridge.focus();
  return true;
}

export function applySelectionPreview(mode: "replaceSelection" | "insertAfterSelection", text: string) {
  if (!editorBridge) return false;
  editorBridge.applyText({ mode, text });
  editorBridge.focus();
  return true;
}

export function hasEditorBridge() {
  return Boolean(editorBridge);
}
