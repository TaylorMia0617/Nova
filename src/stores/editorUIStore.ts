import { create } from "zustand";
import type { ExportFormat, ExportTemplateId } from "../types/export";

export type HeadingState = "body" | "h1" | "h2" | "h3";

interface EditorUIState {
  isFindReplaceOpen: boolean;
  isOutlineOpen: boolean;
  isPageViewMode: boolean;
  isFocusMode: boolean;
  isLinkDialogOpen: boolean;
  linkUrl: string;
  linkText: string;
  isExportDialogOpen: boolean;
  exportFormat: ExportFormat;
  exportTemplateId: ExportTemplateId;
  exportError: string;
  setFindReplaceOpen: (open: boolean) => void;
  toggleOutline: () => void;
  togglePageViewMode: () => void;
  toggleFocusMode: () => void;
  openLinkDialog: (text?: string) => void;
  closeLinkDialog: () => void;
  setLinkUrl: (url: string) => void;
  setLinkText: (text: string) => void;
  openExportDialog: (format: ExportFormat) => void;
  closeExportDialog: () => void;
  setExportFormat: (format: ExportFormat) => void;
  setExportTemplateId: (id: ExportTemplateId) => void;
  setExportError: (error: string) => void;
}

export const useEditorUIStore = create<EditorUIState>((set) => ({
  isFindReplaceOpen: false,
  isOutlineOpen: false,
  isPageViewMode: false,
  isFocusMode: false,
  isLinkDialogOpen: false,
  linkUrl: "",
  linkText: "",
  isExportDialogOpen: false,
  exportFormat: "pdf",
  exportTemplateId: "classic",
  exportError: "",
  setFindReplaceOpen: (open) => set({ isFindReplaceOpen: open }),
  toggleOutline: () => set((s) => ({ isOutlineOpen: !s.isOutlineOpen })),
  togglePageViewMode: () => set((s) => ({ isPageViewMode: !s.isPageViewMode })),
  toggleFocusMode: () => set((s) => ({ isFocusMode: !s.isFocusMode })),
  openLinkDialog: (text) => set({ isLinkDialogOpen: true, linkText: text ?? "" }),
  closeLinkDialog: () => set({ isLinkDialogOpen: false, linkUrl: "", linkText: "" }),
  setLinkUrl: (url) => set({ linkUrl: url }),
  setLinkText: (text) => set({ linkText: text }),
  openExportDialog: (format) => set({ isExportDialogOpen: true, exportFormat: format }),
  closeExportDialog: () => set({ isExportDialogOpen: false, exportError: "" }),
  setExportFormat: (format) => set({ exportFormat: format }),
  setExportTemplateId: (id) => set({ exportTemplateId: id }),
  setExportError: (error) => set({ exportError: error }),
}));
