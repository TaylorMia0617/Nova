import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";

export type ProseMirrorNode = {
  type: string;
  attrs?: Record<string, any>;
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: ProseMirrorNode[];
};

export type DocxPackageState = {
  originalBase64: string;
};

export type ParsedDocxDocument = {
  docJson: ProseMirrorNode;
  packageState: DocxPackageState;
};

export class InvalidDocxZipError extends Error {
  constructor(message = "This file is not a valid DOCX zip package.") {
    super(message);
    this.name = "InvalidDocxZipError";
  }
}

export function isInvalidDocxZipLike(error: unknown) {
  if (error instanceof InvalidDocxZipError) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    error.name === "InvalidDocxZipError" ||
    message.includes("central directory") ||
    message.includes("is this a zip file") ||
    message.includes("corrupted zip") ||
    message.includes("can't find end")
  );
}

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const parser = new DOMParser();
const serializer = new XMLSerializer();

async function zipFromBase64(base64: string) {
  try {
    return await JSZip.loadAsync(base64, { base64: true });
  } catch (error) {
    throw new InvalidDocxZipError();
  }
}

function parseXml(xml: string) {
  return parser.parseFromString(xml, "application/xml");
}

function localName(node: Node) {
  return node.nodeName.includes(":") ? node.nodeName.split(":").pop() ?? node.nodeName : node.nodeName;
}

function childrenByName(node: Node, name: string) {
  return Array.from(node.childNodes).filter((child) => localName(child) === name) as Element[];
}

function firstChildByName(node: Node, name: string) {
  return childrenByName(node, name)[0] ?? null;
}

function attr(element: Element | null, name: string) {
  if (!element) return null;
  return element.getAttribute(`w:${name}`) ?? element.getAttribute(name);
}

function styleValue(element: Element | null) {
  return attr(element, "val");
}

function normalizeHexColor(value: string | null) {
  if (!value || value === "auto") return null;
  return value.startsWith("#") ? value : `#${value}`;
}

function stripHash(value: string | null | undefined) {
  if (!value) return null;
  return value.replace(/^#/, "").toUpperCase();
}

function twipsToEm(twips: string | null) {
  const value = Number(twips);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.round(value / 480));
}

function halfPointsToPx(halfPoints: number) {
  const points = halfPoints / 2;
  return Math.max(1, Math.round(points * (96 / 72)));
}

function fontSizeToHalfPoints(value: unknown) {
  const match = String(value ?? "").match(/([\d.]+)\s*(px|pt)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? "pt").toLowerCase();
  const points = unit === "px" ? amount * (72 / 96) : amount;
  const halfPoints = Math.round(points * 2);
  return halfPoints > 0 ? halfPoints : null;
}

function parseParagraphAttrs(paragraph: Element) {
  const props = firstChildByName(paragraph, "pPr");
  const style = styleValue(firstChildByName(props ?? paragraph, "pStyle"));
  const justification = styleValue(firstChildByName(props ?? paragraph, "jc"));
  const spacing = firstChildByName(props ?? paragraph, "spacing");
  const indent = firstChildByName(props ?? paragraph, "ind");
  const attrs: Record<string, any> = {};

  if (/heading\s*1/i.test(style ?? "") || style === "Title") {
    attrs.level = 1;
  } else if (/heading\s*2/i.test(style ?? "")) {
    attrs.level = 2;
  } else if (/heading\s*3/i.test(style ?? "")) {
    attrs.level = 3;
  }

  if (justification && ["left", "center", "right", "justify"].includes(justification)) {
    attrs.textAlign = justification === "justify" ? "left" : justification;
  }

  const line = spacing?.getAttribute("w:line") ?? spacing?.getAttribute("line");
  if (line) {
    const lineValue = Number(line);
    if (Number.isFinite(lineValue) && lineValue > 0) {
      attrs.lineHeight = String(Math.round((lineValue / 240) * 100) / 100);
    }
  }

  const firstLine = indent?.getAttribute("w:firstLine") ?? indent?.getAttribute("firstLine");
  const left = indent?.getAttribute("w:left") ?? indent?.getAttribute("left");
  const indentLevel = twipsToEm(firstLine) || twipsToEm(left);
  if (indentLevel) attrs.indent = indentLevel;

  return attrs;
}

function parseRunMarks(run: Element) {
  const props = firstChildByName(run, "rPr");
  const marks: ProseMirrorNode["marks"] = [];
  if (!props) return marks;

  if (firstChildByName(props, "b")) marks.push({ type: "bold" });
  if (firstChildByName(props, "i")) marks.push({ type: "italic" });
  if (firstChildByName(props, "u")) marks.push({ type: "underline" });
  if (firstChildByName(props, "strike") || firstChildByName(props, "dstrike")) marks.push({ type: "strike" });

  const textStyle: Record<string, any> = {};
  const color = normalizeHexColor(styleValue(firstChildByName(props, "color")));
  if (color) textStyle.color = color;
  const size = Number(styleValue(firstChildByName(props, "sz")));
  if (Number.isFinite(size) && size > 0) textStyle.fontSize = `${halfPointsToPx(size)}px`;
  const fonts = firstChildByName(props, "rFonts");
  const fontFamily =
    fonts?.getAttribute("w:ascii") ??
    fonts?.getAttribute("ascii") ??
    fonts?.getAttribute("w:eastAsia") ??
    fonts?.getAttribute("eastAsia");
  if (fontFamily) textStyle.fontFamily = fontFamily;
  if (Object.keys(textStyle).length) {
    marks.push({ type: "textStyle", attrs: textStyle });
  }

  const highlight = styleValue(firstChildByName(props, "highlight"));
  if (highlight) {
    marks.push({ type: "highlight", attrs: { color: highlight } });
  }

  return marks;
}

function parseRunContent(run: Element, extraMarks: ProseMirrorNode["marks"] = []) {
  const marks = [...parseRunMarks(run), ...extraMarks];
  const nodes: ProseMirrorNode[] = [];

  for (const child of Array.from(run.childNodes)) {
    const name = localName(child);
    if (name === "t") {
      const text = child.textContent ?? "";
      if (text) nodes.push({ type: "text", text, ...(marks.length ? { marks } : {}) });
    } else if (name === "tab") {
      nodes.push({ type: "text", text: "\t", ...(marks.length ? { marks } : {}) });
    } else if (name === "br") {
      nodes.push({ type: "hardBreak" });
    }
  }

  return nodes;
}

function parseInlineContent(parent: Element) {
  const content: ProseMirrorNode[] = [];

  for (const child of Array.from(parent.childNodes)) {
    const name = localName(child);
    if (name === "r") {
      content.push(...parseRunContent(child as Element));
    } else if (name === "hyperlink") {
      const linkMarks = [{ type: "link", attrs: { href: "#" } }];
      for (const run of childrenByName(child, "r")) {
        content.push(...parseRunContent(run, linkMarks));
      }
    }
  }

  return content;
}

function parseParagraph(paragraph: Element): ProseMirrorNode | null {
  const attrs = parseParagraphAttrs(paragraph);
  const content = parseInlineContent(paragraph);
  const nodeType = attrs.level ? "heading" : "paragraph";
  if (!content.length && nodeType === "paragraph") return { type: "paragraph" };
  return {
    type: nodeType,
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(content.length ? { content } : {}),
  };
}

function parseTableCell(cell: Element, header: boolean): ProseMirrorNode {
  const content = childrenByName(cell, "p")
    .map(parseParagraph)
    .filter((node): node is ProseMirrorNode => Boolean(node));
  return {
    type: header ? "tableHeader" : "tableCell",
    attrs: { colspan: 1, rowspan: 1 },
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

function parseTable(table: Element): ProseMirrorNode {
  const rows = childrenByName(table, "tr").map((row, rowIndex) => {
    const isHeaderRow = Boolean(firstChildByName(firstChildByName(row, "trPr") ?? row, "tblHeader")) || rowIndex === 0;
    return {
      type: "tableRow",
      content: childrenByName(row, "tc").map((cell) => parseTableCell(cell, isHeaderRow)),
    };
  });
  return { type: "table", content: rows };
}

export async function parseDocxBase64(base64: string): Promise<ParsedDocxDocument> {
  const zip = await zipFromBase64(base64);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) throw new Error("DOCX file is missing word/document.xml.");

  const xml = parseXml(documentXml);
  const body = Array.from(xml.getElementsByTagName("w:body"))[0] ?? Array.from(xml.getElementsByTagName("body"))[0];
  if (!body) throw new Error("DOCX document body could not be read.");

  const content: ProseMirrorNode[] = [];
  for (const child of Array.from(body.childNodes)) {
    const name = localName(child);
    if (name === "p") {
      const paragraph = parseParagraph(child as Element);
      if (paragraph) content.push(paragraph);
    } else if (name === "tbl") {
      content.push(parseTable(child as Element));
    }
  }

  return {
    docJson: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] },
    packageState: { originalBase64: base64 },
  };
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to encode DOCX."));
    reader.readAsDataURL(blob);
  });
}

export async function createDocxBase64FromPlainText(text: string) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const paragraphs = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .map((line) =>
      new Paragraph({
        spacing: { after: 120, line: 360 },
        children: line ? [new TextRun({ text: line, font: "Noto Serif SC", size: 24 })] : [],
      })
    );

  const document = new Document({
    sections: [
      {
        children: paragraphs.length ? paragraphs : [new Paragraph("")],
      },
    ],
  });

  return blobToBase64(await Packer.toBlob(document));
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runPropsFromMarks(marks: ProseMirrorNode["marks"] = []) {
  const props: string[] = [];
  for (const mark of marks) {
    if (mark.type === "bold") props.push("<w:b/>");
    if (mark.type === "italic") props.push("<w:i/>");
    if (mark.type === "underline") props.push('<w:u w:val="single"/>');
    if (mark.type === "strike") props.push("<w:strike/>");
    if (mark.type === "textStyle") {
      const color = stripHash(mark.attrs?.color);
      const fontSize = fontSizeToHalfPoints(mark.attrs?.fontSize);
      const fontFamily = mark.attrs?.fontFamily;
      if (color) props.push(`<w:color w:val="${escapeXml(color)}"/>`);
      if (fontSize) props.push(`<w:sz w:val="${fontSize}"/>`);
      if (fontFamily) props.push(`<w:rFonts w:ascii="${escapeXml(fontFamily)}" w:eastAsia="${escapeXml(fontFamily)}"/>`);
    }
    if (mark.type === "highlight" && mark.attrs?.color) {
      props.push(`<w:highlight w:val="${escapeXml(String(mark.attrs.color).replace(/^#/, ""))}"/>`);
    }
  }
  return props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
}

function textNodeToRun(node: ProseMirrorNode) {
  if (node.type === "hardBreak") return "<w:r><w:br/></w:r>";
  if (node.type !== "text") return "";
  const preserveSpace = /^\s|\s$/.test(node.text ?? "");
  return `<w:r>${runPropsFromMarks(node.marks)}<w:t${preserveSpace ? ' xml:space="preserve"' : ""}>${escapeXml(node.text ?? "")}</w:t></w:r>`;
}

function paragraphProps(node: ProseMirrorNode) {
  const attrs = node.attrs ?? {};
  const props: string[] = [];
  if (node.type === "heading") props.push(`<w:pStyle w:val="Heading${attrs.level ?? 1}"/>`);
  if (attrs.textAlign) props.push(`<w:jc w:val="${escapeXml(attrs.textAlign)}"/>`);
  if (attrs.lineHeight) {
    const line = Math.round(Number(attrs.lineHeight) * 240);
    if (Number.isFinite(line)) props.push(`<w:spacing w:line="${line}" w:lineRule="auto"/>`);
  }
  if (attrs.indent) props.push(`<w:ind w:firstLine="${Number(attrs.indent) * 480}"/>`);
  return props.length ? `<w:pPr>${props.join("")}</w:pPr>` : "";
}

function paragraphToXml(node: ProseMirrorNode) {
  const runs = (node.content ?? []).map(textNodeToRun).join("");
  return `<w:p>${paragraphProps(node)}${runs}</w:p>`;
}

function cellToXml(node: ProseMirrorNode) {
  const isHeader = node.type === "tableHeader";
  const props = isHeader ? '<w:tcPr><w:shd w:fill="E5E7EB"/></w:tcPr>' : "";
  const paragraphs = (node.content ?? [{ type: "paragraph" }]).map((child) =>
    child.type === "paragraph" || child.type === "heading" ? paragraphToXml(child) : ""
  ).join("");
  return `<w:tc>${props}${paragraphs || "<w:p/>"}</w:tc>`;
}

function tableToXml(node: ProseMirrorNode) {
  const rows = (node.content ?? []).map((row) => {
    const isHeaderRow = row.content?.some((cell) => cell.type === "tableHeader");
    const rowProps = isHeaderRow ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
    return `<w:tr>${rowProps}${(row.content ?? []).map(cellToXml).join("")}</w:tr>`;
  }).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D1D5DB"/><w:left w:val="single" w:sz="4" w:color="D1D5DB"/><w:bottom w:val="single" w:sz="4" w:color="D1D5DB"/><w:right w:val="single" w:sz="4" w:color="D1D5DB"/><w:insideH w:val="single" w:sz="4" w:color="D1D5DB"/><w:insideV w:val="single" w:sz="4" w:color="D1D5DB"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
}

function nodeToXml(node: ProseMirrorNode) {
  if (node.type === "paragraph" || node.type === "heading") return paragraphToXml(node);
  if (node.type === "table") return tableToXml(node);
  return "";
}

function buildDocumentXml(docJson: ProseMirrorNode, originalDocumentXml: string) {
  const xml = parseXml(originalDocumentXml);
  const body = Array.from(xml.getElementsByTagName("w:body"))[0] ?? Array.from(xml.getElementsByTagName("body"))[0];
  const sectionProps = body ? firstChildByName(body, "sectPr") : null;
  const sectionXml = sectionProps ? serializer.serializeToString(sectionProps) : "<w:sectPr/>";
  const contentXml = (docJson.content ?? [])
    .map(nodeToXml)
    .join("");

  return `${XML_DECLARATION}<w:document xmlns:w="${WORD_NS}" xmlns:r="${REL_NS}"><w:body>${contentXml || "<w:p/>"}${sectionXml}</w:body></w:document>`;
}

export async function serializeDocxBase64(docJson: ProseMirrorNode, packageState: DocxPackageState) {
  const zip = await zipFromBase64(packageState.originalBase64);
  const originalDocumentXml = await zip.file("word/document.xml")?.async("text");
  if (!originalDocumentXml) throw new Error("DOCX file is missing word/document.xml.");

  zip.file("word/document.xml", buildDocumentXml(docJson, originalDocumentXml));
  return zip.generateAsync({ type: "base64" });
}
