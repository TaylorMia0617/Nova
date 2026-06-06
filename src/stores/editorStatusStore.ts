import { create } from "zustand";

export type HeadingState = "body" | "h1" | "h2" | "h3";

export type ActiveFormatState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  blockquote: boolean;
  codeBlock: boolean;
  taskList: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
};

export const DEFAULT_ACTIVE_FORMATS: ActiveFormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  blockquote: false,
  codeBlock: false,
  taskList: false,
  alignLeft: false,
  alignCenter: false,
  alignRight: false,
};

interface EditorStatusState {
  cursorPosition: { line: number; column: number };
  selectionLength: number;
  wordWrap: "on" | "off";
  activeHeadingState: HeadingState;
  activeFormats: ActiveFormatState;
  setCursorPosition: (pos: { line: number; column: number }) => void;
  setSelectionLength: (len: number) => void;
  setWordWrap: (wrap: "on" | "off") => void;
  toggleWordWrap: () => void;
  setActiveHeadingState: (state: HeadingState) => void;
  setActiveFormats: (formats: ActiveFormatState) => void;
}

export const useEditorStatusStore = create<EditorStatusState>((set) => ({
  cursorPosition: { line: 1, column: 1 },
  selectionLength: 0,
  wordWrap: "on",
  activeHeadingState: "body",
  activeFormats: DEFAULT_ACTIVE_FORMATS,
  setCursorPosition: (pos) => set({ cursorPosition: pos }),
  setSelectionLength: (len) => set({ selectionLength: len }),
  setWordWrap: (wrap) => set({ wordWrap: wrap }),
  toggleWordWrap: () => set((s) => ({ wordWrap: s.wordWrap === "on" ? "off" : "on" })),
  setActiveHeadingState: (state) => set({ activeHeadingState: state }),
  setActiveFormats: (formats) => set({ activeFormats: formats }),
}));
