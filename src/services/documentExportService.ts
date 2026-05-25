import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { DocumentBlock, ExportFormat, ExportTemplate, ExportTemplateId } from "../types/export";

const EXPORT_TEMPLATES: ExportTemplate[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Balanced serif document with traditional spacing.",
    page: { marginTop: 72, marginRight: 72, marginBottom: 72, marginLeft: 72 },
    typography: {
      titleFont: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif",
      bodyFont: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif",
      titleSize: 26,
      headingSize: { h1: 22, h2: 18, h3: 16 },
      bodySize: 12,
      lineHeight: 1.7,
    },
  },
  {
    id: "manuscript",
    label: "Manuscript",
    description: "Wider margins and generous line spacing for draft review.",
    page: { marginTop: 90, marginRight: 90, marginBottom: 90, marginLeft: 90 },
    typography: {
      titleFont: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif",
      bodyFont: "'Noto Serif SC', 'Source Han Serif SC', 'SimSun', serif",
      titleSize: 24,
      headingSize: { h1: 20, h2: 17, h3: 15 },
      bodySize: 13,
      lineHeight: 1.9,
    },
  },
  {
    id: "clean-modern",
    label: "Clean Modern",
    description: "Modern sans-serif layout with airy headings.",
    page: { marginTop: 72, marginRight: 64, marginBottom: 72, marginLeft: 64 },
    typography: {
      titleFont: "'Noto Sans SC', 'Microsoft YaHei', sans-serif",
      bodyFont: "'Noto Sans SC', 'Microsoft YaHei', sans-serif",
      titleSize: 24,
      headingSize: { h1: 20, h2: 17, h3: 15 },
      bodySize: 11,
      lineHeight: 1.65,
    },
  },
];

export function getExportTemplates() {
  return EXPORT_TEMPLATES;
}

export function getExportTemplate(templateId: ExportTemplateId) {
  return EXPORT_TEMPLATES.find((template) => template.id === templateId) ?? EXPORT_TEMPLATES[0];
}

export function parseDocumentStructure(content: string): DocumentBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: DocumentBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      const ordered = Boolean(orderedMatch);
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index].trim();
        const nextMatch = ordered ? candidate.match(/^\d+\.\s+(.+)$/) : candidate.match(/^[-*]\s+(.+)$/);
        if (!nextMatch) break;
        items.push(nextMatch[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next) break;
      if (
        /^(#{1,3})\s+/.test(next) ||
        next.startsWith(">") ||
        next.startsWith("```") ||
        /^[-*]\s+/.test(next) ||
        /^\d+\.\s+/.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toDocxParagraph(block: DocumentBlock, template: ExportTemplate) {
  if (block.type === "heading") {
    const size = template.typography.headingSize[`h${block.level}` as "h1" | "h2" | "h3"];
    return new Paragraph({
      heading:
        block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
      spacing: { before: 260, after: 140 },
      children: [
        new TextRun({
          text: block.text,
          font: "Noto Serif SC",
          size: size * 2,
          bold: true,
        }),
      ],
    });
  }

  if (block.type === "blockquote") {
    return new Paragraph({
      indent: { left: 420 },
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({
          text: block.text,
          italics: true,
          font: "Noto Serif SC",
          size: template.typography.bodySize * 2,
        }),
      ],
    });
  }

  if (block.type === "code") {
    return new Paragraph({
      spacing: { before: 120, after: 120 },
      children: [
        new TextRun({
          text: block.text,
          font: "Courier New",
          size: (template.typography.bodySize - 1) * 2,
        }),
      ],
    });
  }

  if (block.type === "list") {
    return new Paragraph({
      spacing: { before: 100, after: 100 },
      children: [
        new TextRun({
          text: block.items
            .map((item, index) => `${block.ordered ? `${index + 1}.` : "•"} ${item}`)
            .join("\n"),
          font: "Noto Serif SC",
          size: template.typography.bodySize * 2,
        }),
      ],
    });
  }

  return new Paragraph({
    spacing: { before: 110, after: 110, line: Math.round(template.typography.lineHeight * 240) },
    children: [
      new TextRun({
        text: block.text,
        font: "Noto Serif SC",
        size: template.typography.bodySize * 2,
      }),
    ],
  });
}

async function exportAsDocx(filename: string, title: string, blocks: DocumentBlock[], template: ExportTemplate) {
  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: template.page.marginTop * 20,
              right: template.page.marginRight * 20,
              bottom: template.page.marginBottom * 20,
              left: template.page.marginLeft * 20,
            },
          },
        },
        children: [
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: title,
                font: "Noto Serif SC",
                size: template.typography.titleSize * 2,
                bold: true,
              }),
            ],
          }),
          ...blocks.map((block) => toDocxParagraph(block, template)),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(document);
  saveBlob(filename, blob);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlockHtml(block: DocumentBlock) {
  if (block.type === "heading") {
    return `<h${block.level}>${escapeHtml(block.text)}</h${block.level}>`;
  }

  if (block.type === "blockquote") {
    return `<blockquote>${escapeHtml(block.text).replace(/\n/g, "<br/>")}</blockquote>`;
  }

  if (block.type === "code") {
    return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
  }

  if (block.type === "list") {
    const tag = block.ordered ? "ol" : "ul";
    return `<${tag}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
  }

  return `<p>${escapeHtml(block.text)}</p>`;
}

function buildExportHtml(title: string, blocks: DocumentBlock[], template: ExportTemplate) {
  return `
    <div style="
      width: 794px;
      background: white;
      color: #121826;
      padding: ${template.page.marginTop}px ${template.page.marginRight}px ${template.page.marginBottom}px ${template.page.marginLeft}px;
      font-family: ${template.typography.bodyFont};
      font-size: ${template.typography.bodySize}pt;
      line-height: ${template.typography.lineHeight};
      box-sizing: border-box;
    ">
      <h1 style="
        font-family: ${template.typography.titleFont};
        font-size: ${template.typography.titleSize}pt;
        margin: 0 0 28px 0;
      ">${escapeHtml(title)}</h1>
      <style>
        h1, h2, h3 { font-family: ${template.typography.titleFont}; margin: 20px 0 10px; }
        h1 { font-size: ${template.typography.headingSize.h1}pt; }
        h2 { font-size: ${template.typography.headingSize.h2}pt; }
        h3 { font-size: ${template.typography.headingSize.h3}pt; }
        p { margin: 0 0 12px 0; }
        blockquote {
          margin: 14px 0;
          padding-left: 18px;
          border-left: 4px solid #a0aec0;
          color: #334155;
        }
        pre {
          margin: 14px 0;
          padding: 14px 16px;
          background: #f3f6fb;
          border-radius: 10px;
          overflow: hidden;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: 'Cascadia Code', 'Consolas', monospace;
        }
        ul, ol { margin: 10px 0 14px 24px; padding: 0; }
        li { margin: 6px 0; }
      </style>
      ${blocks.map((block) => renderBlockHtml(block)).join("")}
    </div>
  `;
}

async function exportAsPdf(filename: string, title: string, blocks: DocumentBlock[], template: ExportTemplate) {
  const [{ default: jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas")]);

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-100000px";
  container.style.top = "0";
  container.style.zIndex = "-1";
  container.innerHTML = buildExportHtml(title, blocks, template);
  document.body.appendChild(container);

  try {
    const target = container.firstElementChild as HTMLElement | null;
    if (!target) {
      throw new Error("Failed to render export preview.");
    }

    const canvas = await html2canvas(target, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
    });

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF({
      unit: "pt",
      format: "a4",
    });

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    let position = 0;

    pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }

    pdf.save(filename);
  } finally {
    document.body.removeChild(container);
  }
}

export async function exportDocument(options: {
  format: ExportFormat;
  templateId: ExportTemplateId;
  title: string;
  content: string;
  filenameBase: string;
}) {
  const { format, templateId, title, content, filenameBase } = options;
  const template = getExportTemplate(templateId);

  if (format === "txt") {
    saveBlob(`${filenameBase}.txt`, new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" }));
    return;
  }

  const blocks = parseDocumentStructure(content);
  if (format === "docx") {
    await exportAsDocx(`${filenameBase}.docx`, title, blocks, template);
    return;
  }

  await exportAsPdf(`${filenameBase}.pdf`, title, blocks, template);
}
