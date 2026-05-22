export type ExportFormat = "txt" | "pdf" | "docx";

export type ExportTemplateId = "classic" | "manuscript" | "clean-modern";

export interface ExportTemplate {
  id: ExportTemplateId;
  label: string;
  description: string;
  page: {
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
  };
  typography: {
    titleFont: string;
    bodyFont: string;
    titleSize: number;
    headingSize: {
      h1: number;
      h2: number;
      h3: number;
    };
    bodySize: number;
    lineHeight: number;
  };
}

export type DocumentBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "blockquote"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };
