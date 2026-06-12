import type { ModelProfile } from "../types/ai";
import type { McpTool, McpToolResult } from "../types/ai";
import { getReferenceList, getReferenceLists, readFile, readDirectory, readFileBinary, saveReferenceList, writeFile, writeFileBinary, createFile, listBlueprints, saveBlueprint } from "./fileSystemService";
import type { ReferenceListData, WorkspaceNode } from "./fileSystemService";
import type { BlueprintDocument, BlueprintEdge, BlueprintNode } from "../types/blueprint";
import { createDocxBase64FromPlainText, parseDocxBase64, serializeDocxBase64, type ProseMirrorNode } from "./docxOoxmlService";
import { searchWithTavily } from "./searchService";
import { autoLayoutBlueprint } from "../utils/blueprintAutoLayout";

type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: T;
  error?: {
    code: number;
    message: string;
  };
};

let requestCounter = 0;

const MAX_FILE_SIZE = 50 * 1024; // 50KB
const isDocxPath = (path: string) => path.trim().toLowerCase().endsWith(".docx");
const newBlueprintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function sanitizeContentForDocxCreate(value: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(value)) {
    return value;
  }

  return decodeCommonHtmlEntities(value)
    .replace(/<span\b[^>]*>/gi, "")
    .replace(/<\/span>/gi, "")
    .replace(/\sstyle=(["'])[\s\S]*?\1/gi, "")
    .replace(/\sclass=(["'])[\s\S]*?\1/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<p\b[^>]*>/gi, "")
    .replace(/<\/h([1-6])\s*>/gi, "\n\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_match, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/<\/?strong\b[^>]*>/gi, "")
    .replace(/<\/?b\b[^>]*>/gi, "")
    .replace(/<\/?em\b[^>]*>/gi, "")
    .replace(/<\/?i\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type ResolvedWorkspacePath = {
  relativePath: string;
  absolutePath: string;
  separator: string;
};

type WriteToolSuccess = {
  ok: true;
  action: "create_file" | "edit_file" | "edit_docx" | "upsert_reference_entries";
  relativePath?: string;
  absolutePath?: string;
  fileType?: "text" | "docx" | "reference";
  listName?: string;
  listId?: string;
  existed?: boolean;
  bytes?: number;
  edits?: number;
  insertions?: number;
  upserted?: number;
};

function formatPathError(path: string): string {
  return `Invalid path "${path}". Use a workspace-relative path such as "章节/测试.docx".`;
}

function resolveWorkspacePath(workspaceRoot: string, rawPath: string): ResolvedWorkspacePath {
  const input = String(rawPath ?? "").trim();
  if (!input) {
    throw new Error("path is required");
  }

  const normalized = input
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");

  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(formatPathError(rawPath));
  }

  const relativePath = normalized.replace(/^\/+/, "");
  if (!relativePath) {
    throw new Error("path is required");
  }

  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = workspaceRoot.replace(/[/\\]+$/, "");
  const absolutePath = `${normalizedRoot}${separator}${relativePath.replace(/\//g, separator)}`;
  return { relativePath, absolutePath, separator };
}

function parentPathOf(path: string, separator: string): string {
  return path.substring(0, path.lastIndexOf(separator));
}

function makeWriteSuccess(result: WriteToolSuccess): string {
  return JSON.stringify(result, null, 2);
}

const LOCAL_FILESYSTEM_TOOLS: McpTool[] = [
  {
    name: "list_directory",
    description: "列出指定目录下的所有文件和文件夹（支持递归）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要列出的目录路径（相对于工作区根目录），留空表示根目录"
        },
        recursive: {
          type: "boolean",
          description: "是否递归列出子目录，默认 false"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "read_file",
    description: "读取指定文件的内容（限制50KB）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "要读取的文件路径（相对于工作区根目录）"
        }
      },
      required: ["path"]
    }
  },
  {
    name: "web_search",
    description: "搜索互联网获取信息（需要用户启用联网搜索）",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "list_blueprints",
    description: "List existing story blueprints with node, edge, chapter, and mount summaries.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  },
  {
    name: "read_blueprint",
    description: "Read a blueprint by id or name. Use this before analyzing or modifying a blueprint.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Blueprint id" },
        name: { type: "string", description: "Blueprint name" }
      },
      required: []
    }
  },
  {
    name: "create_blueprint",
    description: "Create or replace a blueprint using the current BlueprintDocument structure.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Blueprint name" },
        blueprint: { type: "object", description: "Optional full BlueprintDocument draft" },
        nodes: { type: "array", description: "Blueprint nodes when blueprint is omitted" },
        edges: { type: "array", description: "Blueprint edges when blueprint is omitted" }
      },
      required: ["name"]
    }
  },
  {
    name: "upsert_reference_entries",
    description: "Create or update structured reference entries in the workspace reference database. Use this for AI-generated character sheets and other structured setting records; character sheets should default to listName=\"人物\".",
    inputSchema: {
      type: "object",
      properties: {
        listName: {
          type: "string",
          description: "Reference list name. Use 人物 for character sheets unless the user asks otherwise."
        },
        items: {
          type: "array",
          description: "Reference entries to insert or update by key.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description: "Entry key, usually the character name."
              },
              value: {
                type: "string",
                description: "Short annotation shown in reference suggestions."
              },
              body: {
                type: "string",
                description: "Structured body. Character entries should include current_desire, current_fear, current_emotion, and current_bias."
              }
            },
            required: ["key", "value", "body"]
          }
        }
      },
      required: ["items"]
    }
  },
  {
    name: "edit_file",
    description: "对指定文件进行行级编辑（支持替换、插入、删除操作）",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于工作区根目录）"
        },
        edits: {
          type: "array",
          description: "编辑操作列表，按顺序执行",
          items: {
            type: "object",
            properties: {
              startLine: {
                type: "number",
                description: "起始行号（1-based）"
              },
              endLine: {
                type: "number",
                description: "结束行号（含，1-based）"
              },
              newContent: {
                type: "string",
                description: "新内容（删除时留空或省略）"
              }
            },
            required: ["startLine", "endLine"]
          }
        }
      },
      required: ["path", "edits"]
    }
  },
  {
    name: "edit_docx",
    description: "Safely edit an existing DOCX by inserting plain-text paragraphs before or after matched text, or appending to the end. Use this for local changes in existing .docx files; do not use create_file to overwrite an existing DOCX.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Existing .docx file path relative to the workspace root."
        },
        operations: {
          type: "array",
          description: "DOCX paragraph insertion operations, applied in order.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "append_after_text inserts after the matching paragraph; insert_before_text inserts before it; append_to_end appends to the end and does not need matchText."
              },
              matchText: {
                type: "string",
                description: "Plain text to find in a paragraph. The first matching paragraph is used."
              },
              insertText: {
                type: "string",
                description: "Plain text to insert. Blank lines create separate paragraphs."
              }
            },
            required: ["type", "insertText"]
          }
        }
      },
      required: ["path", "operations"]
    }
  },
  {
    name: "create_file",
    description: "创建新文件并写入内容",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对于工作区根目录）"
        },
        content: {
          type: "string",
          description: "文件初始内容（可选，默认为空）"
        }
      },
      required: ["path"]
    }
  }
];

function normalizeToolForPrompt(tool: McpTool): McpTool {
  if (tool.name !== "create_file") return tool;
  return {
    ...tool,
    description: "创建新文件并写入内容。章节正文默认使用 .docx；传入纯文本 content，工具会自动生成真正的 DOCX 文件。",
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        path: {
          ...tool.inputSchema.properties.path,
          description: "文件路径（相对于工作区根目录）。章节正文建议使用 .docx；大纲、设定、摘要可使用 .md。",
        },
        content: {
          ...tool.inputSchema.properties.content,
          description: "文件初始内容。创建 .docx 时仍然传纯文本，工具会转换为 Word 文档。",
        },
      },
    },
  };
}

export function getLocalTools(agentSubMode?: "plan" | "build"): McpTool[] {
  const tools = agentSubMode === "plan"
    ? LOCAL_FILESYSTEM_TOOLS.filter(t => t.name !== "edit_file" && t.name !== "create_file" && t.name !== "create_blueprint" && t.name !== "upsert_reference_entries")
    : LOCAL_FILESYSTEM_TOOLS;
  return tools.map(normalizeToolForPrompt);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function findNodeByPath(nodes: WorkspaceNode[], targetPath: string): WorkspaceNode | null {
  const normalizedTarget = normalizePath(targetPath);
  for (const node of nodes) {
    if (normalizePath(node.path) === normalizedTarget) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function buildDirectoryTree(nodes: WorkspaceNode[], basePath: string = ""): Array<{ name: string; type: string; path: string }> {
  const result: Array<{ name: string; type: string; path: string }> = [];
  for (const node of nodes) {
    const relativePath = basePath ? `${basePath}/${node.name}` : node.name;
    result.push({
      name: node.name,
      type: node.type === "folder" ? "directory" : "file",
      path: relativePath
    });
    if (node.children) {
      result.push(...buildDirectoryTree(node.children, relativePath));
    }
  }
  return result;
}

function summarizeBlueprint(blueprint: BlueprintDocument) {
  const chapters = blueprint.nodes.filter((node) => node.nodeType === "chapter");
  const mounted = chapters.flatMap((node) => Array.isArray(node.typedData?.mountLinks) ? node.typedData.mountLinks : []);
  return {
    id: blueprint.id,
    name: blueprint.name,
    nodes: blueprint.nodes.length,
    edges: blueprint.edges.length,
    chapters: chapters.map((node) => ({
      id: node.id,
      title: node.title || node.typedData?.chapterTitle || "Untitled chapter",
      summary: node.typedData?.summary ?? node.summary ?? "",
      mounts: Array.isArray(node.typedData?.mountLinks) ? node.typedData.mountLinks.length : 0,
    })),
    mounts: mounted.map((link) => ({
      label: link.label,
      blueprintId: link.blueprintId,
      blueprintName: link.blueprintName,
      kind: link.kind ?? "mount",
    })),
  };
}

function normalizeBlueprintDraft(args: Record<string, unknown>): BlueprintDocument {
  const fullDraft = args.blueprint && typeof args.blueprint === "object" ? args.blueprint as Partial<BlueprintDocument> : null;
  const name = String(args.name ?? fullDraft?.name ?? "AI Blueprint").trim() || "AI Blueprint";
  const now = new Date().toISOString();
  const nodes = (fullDraft?.nodes ?? args.nodes ?? []) as BlueprintNode[];
  const edges = (fullDraft?.edges ?? args.edges ?? []) as BlueprintEdge[];
  return autoLayoutBlueprint({
    id: String(fullDraft?.id ?? newBlueprintId("blueprint")),
    name,
    updatedAt: now,
    nodes: nodes.map((node, index) => ({
      ...node,
      id: String(node.id || newBlueprintId("node")),
      kind: node.kind ?? "custom",
      x: Number.isFinite(node.x) ? node.x : 120 + index * 260,
      y: Number.isFinite(node.y) ? node.y : 120 + (index % 3) * 170,
      title: String(node.title || node.characterName || node.typedData?.chapterTitle || `Node ${index + 1}`),
      linkedChapters: Array.isArray(node.linkedChapters) ? node.linkedChapters : [],
    })),
    edges: edges
      .filter((edge) => edge.from && edge.to && edge.from !== edge.to)
      .map((edge) => ({ ...edge, id: String(edge.id || newBlueprintId("edge")) })),
    viewport: fullDraft?.viewport ?? { x: 0, y: 0, zoom: 1 },
  });
}

function proseMirrorToPlainText(node: ProseMirrorNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";

  const childText = (node.content ?? []).map(proseMirrorToPlainText).join("");
  if (["paragraph", "heading"].includes(node.type)) {
    return childText.trim() ? `${childText}\n` : "";
  }
  if (node.type === "tableRow") {
    return `${(node.content ?? []).map(proseMirrorToPlainText).map((text) => text.trim()).filter(Boolean).join(" | ")}\n`;
  }
  if (node.type === "table" || node.type === "doc") {
    return childText;
  }
  return childText;
}

function nodeInlineText(node: ProseMirrorNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(nodeInlineText).join("");
}

function normalizeMatchText(value: string): string {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

function docxMatchParts(value: string): string[] {
  const rawLines = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map(normalizeMatchText)
    .filter(Boolean);
  if (rawLines.length > 1) return rawLines;

  const normalized = normalizeMatchText(value);
  if (!normalized) return [];
  const titleWithSeparator = normalized.match(/^(.{4,}?)\s+([—-])$/);
  if (titleWithSeparator) {
    return [normalizeMatchText(titleWithSeparator[1]), "—"];
  }
  return [normalized];
}

function isDocxTextBlock(node: ProseMirrorNode | null | undefined) {
  return Boolean(node && ["paragraph", "heading"].includes(node.type));
}

function findDocxMatchRange(content: ProseMirrorNode[], matchText: string): { startIndex: number; endIndex: number } | null {
  const parts = docxMatchParts(matchText);
  if (parts.length === 0) return null;

  const entries = content
    .map((node, index) => ({ index, text: isDocxTextBlock(node) ? normalizeMatchText(nodeInlineText(node)) : "" }))
    .filter((entry) => entry.text);

  for (let start = 0; start < entries.length; start += 1) {
    if (!entries[start].text.includes(parts[0])) continue;

    let cursor = start;
    let ok = true;
    for (let partIndex = 1; partIndex < parts.length; partIndex += 1) {
      const next = entries.findIndex((entry, entryIndex) => entryIndex > cursor && entry.text.includes(parts[partIndex]));
      if (next < 0) {
        ok = false;
        break;
      }
      cursor = next;
    }

    if (ok) {
      return {
        startIndex: entries[start].index,
        endIndex: entries[cursor].index,
      };
    }
  }

  return null;
}

function plainTextToDocxParagraphs(value: string): ProseMirrorNode[] {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  return normalized
    .split(/\n{2,}|\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({
      type: "paragraph",
      content: [{ type: "text", text: line }],
    }));
}

function isEmptyDocxParagraph(node: ProseMirrorNode | undefined) {
  if (!node || node.type !== "paragraph") return false;
  const text = (node.content ?? []).map(child => child.text ?? "").join("").trim();
  return text.length === 0;
}

type DocxEditOperation = {
  type?: unknown;
  matchText?: unknown;
  insertText?: unknown;
};

async function editDocxByTextInsertions(resolved: ResolvedWorkspacePath, rawOperations: unknown): Promise<{ base64: string; insertions: number }> {
  if (!isDocxPath(resolved.relativePath)) {
    throw new Error("edit_docx only supports existing .docx files.");
  }
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    throw new Error("operations array is required and must not be empty.");
  }

  const parsed = await parseDocxBase64(await readFileBinary(resolved.absolutePath));
  const docJson: ProseMirrorNode = {
    ...parsed.docJson,
    content: [...(parsed.docJson.content ?? [])],
  };
  let insertions = 0;

  for (const operation of rawOperations as DocxEditOperation[]) {
    const type = String(operation?.type ?? "").trim();
    const matchText = String(operation?.matchText ?? "");
    const normalizedMatchText = normalizeMatchText(matchText);
    const insertParagraphs = plainTextToDocxParagraphs(String(operation?.insertText ?? ""));
    if (!["append_after_text", "insert_before_text", "append_to_end"].includes(type)) {
      throw new Error(`Unsupported edit_docx operation type: ${type || "(empty)"}`);
    }
    if (type !== "append_to_end" && !normalizedMatchText) {
      throw new Error("matchText is required for edit_docx operations.");
    }
    if (insertParagraphs.length === 0) {
      throw new Error("insertText must contain at least one non-empty paragraph.");
    }

    if (type === "append_to_end") {
      const currentContent = docJson.content ?? [];
      const baseContent = currentContent.length === 1 && isEmptyDocxParagraph(currentContent[0]) ? [] : currentContent;
      docJson.content = [...baseContent, ...insertParagraphs];
      insertions += insertParagraphs.length;
      continue;
    }

    const range = findDocxMatchRange(docJson.content ?? [], matchText);
    if (!range) {
      throw new Error(`Match text not found in ${resolved.relativePath}: ${normalizedMatchText.slice(0, 120)}`);
    }

    const insertionIndex = type === "append_after_text" ? range.endIndex + 1 : range.startIndex;
    docJson.content = [
      ...(docJson.content ?? []).slice(0, insertionIndex),
      ...insertParagraphs,
      ...(docJson.content ?? []).slice(insertionIndex),
    ];
    insertions += insertParagraphs.length;
  }

  return {
    base64: await serializeDocxBase64(docJson, parsed.packageState),
    insertions,
  };
}

async function readWorkspaceFileContent(resolved: ResolvedWorkspacePath): Promise<string> {
  if (isDocxPath(resolved.relativePath)) {
    const parsed = await parseDocxBase64(await readFileBinary(resolved.absolutePath));
    return proseMirrorToPlainText(parsed.docJson).trim();
  }
  return readFile(resolved.absolutePath);
}

function createReferenceListId(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "")
    .slice(0, 32) || "reference";
  return `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function upsertReferenceEntries(args: Record<string, unknown>): Promise<{
  list: ReferenceListData;
  upserted: number;
}> {
  const listName = String(args.listName ?? "人物").trim() || "人物";
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("items array is required and must not be empty.");
  }

  const items = rawItems.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`items[${index}] must be an object.`);
    }
    const typed = item as { key?: unknown; value?: unknown; body?: unknown };
    const key = String(typed.key ?? "").trim();
    const value = String(typed.value ?? "").trim();
    const body = String(typed.body ?? "").trim();
    if (!key) throw new Error(`items[${index}].key is required.`);
    if (!value) throw new Error(`items[${index}].value is required.`);
    if (!body) throw new Error(`items[${index}].body is required.`);
    return { key, value, body };
  });

  const index = await getReferenceLists();
  const existingIndex = index.find((list) => list.name === listName);
  const existingList = existingIndex ? await getReferenceList(existingIndex.id) : null;
  const list: ReferenceListData = existingList ?? {
    id: createReferenceListId(listName),
    name: listName,
    items: [],
  };

  const nextItems = [...list.items];
  for (const item of items) {
    const existingItemIndex = nextItems.findIndex((entry) => entry.key === item.key);
    if (existingItemIndex >= 0) {
      nextItems[existingItemIndex] = item;
    } else {
      nextItems.push(item);
    }
  }

  const saved = await saveReferenceList({
    ...list,
    name: listName,
    items: nextItems,
  });
  return { list: saved, upserted: items.length };
}

export async function runLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  workspaceNodes: WorkspaceNode[],
  options?: { enableWebSearch?: boolean; searchCount?: number; searchLimit?: number; agentSubMode?: "plan" | "build" }
): Promise<McpToolResult> {
  try {
    if ((toolName === "edit_file" || toolName === "edit_docx" || toolName === "create_file" || toolName === "upsert_reference_entries") && options?.agentSubMode === "plan") {
      return { toolName, result: `Error: ${toolName} is not available in Plan mode. Switch to Build mode to make edits.` };
    }

    switch (toolName) {
      case "list_directory": {
        const rawPath = (args.path as string) || "";
        const recursive = (args.recursive as boolean) || false;
        
        // 如果 relativePath 为空，直接列出根目录内容
        if (!rawPath.trim()) {
          if (recursive) {
            const tree = buildDirectoryTree(workspaceNodes, "");
            return { toolName, result: JSON.stringify(tree, null, 2) };
          } else {
            const entries = workspaceNodes.map(node => ({
              name: node.name,
              type: node.type === "folder" ? "directory" : "file",
              path: node.name
            }));
            return { toolName, result: JSON.stringify(entries, null, 2) };
          }
        }
        
        // 如果 relativePath 不为空，查找目标节点
        let resolved: ResolvedWorkspacePath;
        try {
          resolved = resolveWorkspacePath(workspaceRoot, rawPath);
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }
        const targetNode = findNodeByPath(workspaceNodes, resolved.absolutePath);
        
        if (!targetNode) {
          return { toolName, result: `Error: Directory not found: ${resolved.relativePath}` };
        }
        
        if (targetNode.type !== "folder") {
          return { toolName, result: `Error: ${resolved.relativePath} is not a directory` };
        }
        
        // 如果节点没有加载子节点，需要先加载
        if (!targetNode.children) {
          return { toolName, result: `Error: Directory not loaded yet. Please try again.` };
        }
        
        if (recursive) {
          const tree = buildDirectoryTree(targetNode.children, resolved.relativePath);
          return { toolName, result: JSON.stringify({ relativePath: resolved.relativePath, absolutePath: resolved.absolutePath, entries: tree }, null, 2) };
        } else {
          const entries = targetNode.children.map(node => ({
            name: node.name,
            type: node.type === "folder" ? "directory" : "file",
            path: resolved.relativePath ? `${resolved.relativePath}/${node.name}` : node.name
          }));
          return { toolName, result: JSON.stringify({ relativePath: resolved.relativePath, absolutePath: resolved.absolutePath, entries }, null, 2) };
        }
      }
      case "read_file": {
        let resolved: ResolvedWorkspacePath;
        try {
          resolved = resolveWorkspacePath(workspaceRoot, args.path as string);
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }
        
        // 构建完整路径，使用正确的分隔符
        
        // 尝试读取文件
        try {
          console.log("[read_file] relativePath:", resolved.relativePath);
          console.log("[read_file] absolutePath:", resolved.absolutePath);
          const content = await readWorkspaceFileContent(resolved);
          if (content.length > MAX_FILE_SIZE) {
            return { toolName, result: `Error: File size (${content.length} bytes) exceeds the 50KB limit.` };
          }
          return { toolName, result: content };
        } catch (error) {
          // 如果读取失败，可能是因为文件句柄未注册
          // 尝试加载父目录来注册文件句柄
          const parentPath = parentPathOf(resolved.absolutePath, resolved.separator);
          if (parentPath) {
            try {
              await readDirectory(parentPath);
              // 再次尝试读取文件
              const content = await readWorkspaceFileContent(resolved);
              if (content.length > MAX_FILE_SIZE) {
                return { toolName, result: `Error: File size (${content.length} bytes) exceeds the 50KB limit.` };
              }
              return { toolName, result: content };
            } catch (retryError) {
              return { toolName, result: `Error reading file: ${retryError instanceof Error ? retryError.message : String(retryError)}` };
            }
          }
          return { toolName, result: `Error reading file: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "web_search": {
        if (!options?.enableWebSearch) {
          return { toolName, result: "Error: Web search is not enabled. Please enable it first." };
        }
        if (options?.searchCount !== undefined && options?.searchLimit !== undefined && options.searchCount >= options.searchLimit) {
          return { toolName, result: `Error: Search limit reached (${options.searchLimit}). Please increase the limit in settings.` };
        }
        const query = args.query as string;
        if (!query) {
          return { toolName, result: "Error: query is required" };
        }
        try {
          const result = await searchWithTavily(query);
          return { toolName, result };
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "list_blueprints": {
        const blueprints = await listBlueprints();
        return {
          toolName,
          result: JSON.stringify(blueprints.map(summarizeBlueprint), null, 2),
        };
      }
      case "read_blueprint": {
        const blueprints = await listBlueprints();
        const id = String(args.id ?? "").trim();
        const name = String(args.name ?? "").trim();
        const blueprint = blueprints.find((item) => item.id === id)
          ?? blueprints.find((item) => item.name === name)
          ?? null;
        if (!blueprint) {
          return { toolName, result: `Error: Blueprint not found${id ? ` id=${id}` : name ? ` name=${name}` : ""}` };
        }
        return {
          toolName,
          result: JSON.stringify({
            summary: summarizeBlueprint(blueprint),
            blueprint,
          }, null, 2),
        };
      }
      case "create_blueprint": {
        if (options?.agentSubMode === "plan") {
          return { toolName, result: "Error: create_blueprint is not available in Plan mode. Switch to Build mode to create blueprints." };
        }
        const blueprint = normalizeBlueprintDraft(args);
        const saved = await saveBlueprint(blueprint);
        return {
          toolName,
          result: JSON.stringify({
            ok: true,
            action: "create_blueprint",
            summary: summarizeBlueprint(saved),
          }, null, 2),
        };
      }
      case "upsert_reference_entries": {
        try {
          const { list, upserted } = await upsertReferenceEntries(args);
          return {
            toolName,
            result: makeWriteSuccess({
              ok: true,
              action: "upsert_reference_entries",
              fileType: "reference",
              listName: list.name,
              listId: list.id,
              upserted,
            }),
          };
        } catch (error) {
          return { toolName, result: `Error updating reference entries: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "edit_file": {
        let resolved: ResolvedWorkspacePath;
        try {
          resolved = resolveWorkspacePath(workspaceRoot, args.path as string);
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }
        const edits = args.edits as Array<{ startLine: number; endLine: number; newContent?: string }>;
        if (!Array.isArray(edits) || edits.length === 0) {
          return { toolName, result: "Error: edits array is required and must not be empty" };
        }

        const MAX_CONTENT_SIZE = 100 * 1024;
        for (const edit of edits) {
          if (edit.newContent && edit.newContent.length > MAX_CONTENT_SIZE) {
            return { toolName, result: `Error: Edit content too large (${edit.newContent.length} bytes). Maximum is ${MAX_CONTENT_SIZE} bytes.` };
          }
        }

        console.log("[edit_file] workspaceRoot:", workspaceRoot);
        console.log("[edit_file] relativePath:", resolved.relativePath);
        console.log("[edit_file] absolutePath:", resolved.absolutePath);
        console.log("[edit_file] edits count:", edits.length);

        if (isDocxPath(resolved.relativePath)) {
          return {
            toolName,
            result: "Error: DOCX files are binary packages and cannot be edited with line-based text edits. Open the DOCX in the editor and use the app's DOCX save path instead.",
          };
        }

        const tryReadFile = async (path: string): Promise<string> => {
          try {
            return await readFile(path);
          } catch {
            const parentPath = parentPathOf(path, resolved.separator);
            if (parentPath) {
              await readDirectory(parentPath);
              return await readFile(path);
            }
            throw new Error(`Could not find file: ${resolved.relativePath}`);
          }
        };

        const tryWriteFile = async (path: string, content: string): Promise<void> => {
          try {
            await writeFile(path, content);
          } catch (writeError) {
            console.error("[edit_file] writeFile failed:", writeError);
            const parentPath = parentPathOf(path, resolved.separator);
            if (parentPath) {
              await readDirectory(parentPath);
              await writeFile(path, content);
              return;
            }
            throw new Error(`Could not write file: ${resolved.relativePath}`);
          }
        };

        try {
          const content = await tryReadFile(resolved.absolutePath);
          const lines = content.split("\n");

          const sortedEdits = [...edits].sort((a, b) => b.startLine - a.startLine);

          for (const edit of sortedEdits) {
            const { startLine, endLine, newContent } = edit;
            if (startLine < 1 || endLine < startLine || endLine > lines.length) {
              return { toolName, result: `Error: Invalid line range ${startLine}-${endLine} for file with ${lines.length} lines` };
            }
            const newLines = newContent ? newContent.split("\n") : [];
            lines.splice(startLine - 1, endLine - startLine + 1, ...newLines);
          }

          await tryWriteFile(resolved.absolutePath, lines.join("\n"));
          console.log("[edit_file] writeFile succeeded");

          const verifyContent = await tryReadFile(resolved.absolutePath);
          const expectedContent = lines.join("\n");
          console.log("[edit_file] verifyContent length:", verifyContent.length);
          if (verifyContent !== expectedContent) {
            console.error("[edit_file] Verification failed! Expected", expectedContent.length, "bytes but got", verifyContent.length, "bytes");
            return { toolName, result: `Error: File content verification failed for ${resolved.relativePath}. Expected ${expectedContent.length} bytes but got ${verifyContent.length} bytes.` };
          }

          return {
            toolName,
            result: makeWriteSuccess({
              ok: true,
              action: "edit_file",
              relativePath: resolved.relativePath,
              absolutePath: resolved.absolutePath,
              fileType: "text",
              bytes: expectedContent.length,
              edits: edits.length,
            }),
          };
        } catch (error) {
          console.error("[edit_file] Error:", error);
          return { toolName, result: `Error editing file: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "edit_docx": {
        let resolved: ResolvedWorkspacePath;
        try {
          resolved = resolveWorkspacePath(workspaceRoot, args.path as string);
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }

        try {
          const { base64, insertions } = await editDocxByTextInsertions(resolved, args.operations);
          await writeFileBinary(resolved.absolutePath, base64);
          return {
            toolName,
            result: makeWriteSuccess({
              ok: true,
              action: "edit_docx",
              relativePath: resolved.relativePath,
              absolutePath: resolved.absolutePath,
              fileType: "docx",
              insertions,
              bytes: base64.length,
            }),
          };
        } catch (error) {
          return { toolName, result: `Error editing DOCX: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      case "create_file": {
        let resolved: ResolvedWorkspacePath;
        try {
          resolved = resolveWorkspacePath(workspaceRoot, args.path as string);
        } catch (error) {
          return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
        }
        const content = (args.content as string) || "";

        const MAX_CREATE_CONTENT_SIZE = 100 * 1024;
        if (content.length > MAX_CREATE_CONTENT_SIZE) {
          return { toolName, result: `Error: Content too large (${content.length} bytes). Maximum is ${MAX_CREATE_CONTENT_SIZE} bytes.` };
        }

        console.log("[create_file] workspaceRoot:", workspaceRoot);
        console.log("[create_file] relativePath:", resolved.relativePath);
        console.log("[create_file] absolutePath:", resolved.absolutePath);
        console.log("[create_file] content length:", content.length);
        console.log("[create_file] content preview:", content.substring(0, 100));
        const isDocx = isDocxPath(resolved.relativePath);
        const contentForWrite = isDocx ? sanitizeContentForDocxCreate(content) : content;

        const tryReadFile = async (path: string): Promise<string> => {
          try {
            return await readFile(path);
          } catch {
            const parentPath = parentPathOf(path, resolved.separator);
            if (parentPath) {
              await readDirectory(parentPath);
              return await readFile(path);
            }
            throw new Error(`Could not read file: ${resolved.relativePath}`);
          }
        };

        const tryWriteFile = async (path: string, data: string): Promise<void> => {
          try {
            await writeFile(path, data);
          } catch (writeError) {
            console.error("[create_file] writeFile failed:", writeError);
            const parentPath = parentPathOf(path, resolved.separator);
            if (parentPath) {
              await readDirectory(parentPath);
              await writeFile(path, data);
              return;
            }
            throw new Error(`Could not write file: ${resolved.relativePath}`);
          }
        };

        try {
          let existed = false;
          try {
            await createFile(resolved.absolutePath);
            console.log("[create_file] createFile succeeded");
          } catch (createError) {
            const errorMsg = createError instanceof Error ? createError.message : String(createError);
            if (errorMsg.includes("already exists")) {
              existed = true;
              console.log("[create_file] File already exists, skipping creation");
              if (isDocx) {
                return {
                  toolName,
                  result: `Error: ${resolved.relativePath} already exists. Do not overwrite an existing DOCX with create_file; use edit_docx for local DOCX changes.`,
                };
              }
            } else {
              throw createError;
            }
          }

          if (isDocx) {
            const docxBase64 = await createDocxBase64FromPlainText(contentForWrite);
            await writeFileBinary(resolved.absolutePath, docxBase64);
            console.log("[create_file] writeFileBinary DOCX succeeded");
            return {
              toolName,
              result: makeWriteSuccess({
                ok: true,
                action: "create_file",
                relativePath: resolved.relativePath,
                absolutePath: resolved.absolutePath,
                fileType: "docx",
                existed,
                bytes: docxBase64.length,
              }),
            };
          } else if (content) {
            await tryWriteFile(resolved.absolutePath, content);
            console.log("[create_file] writeFile succeeded");
          }

          const verifyContent = await tryReadFile(resolved.absolutePath);
          console.log("[create_file] verifyContent length:", verifyContent.length);
          console.log("[create_file] verifyContent preview:", verifyContent.substring(0, 100));

          if (content && verifyContent !== content) {
            console.error("[create_file] Verification failed! Expected", content.length, "bytes but got", verifyContent.length, "bytes");
            return { toolName, result: `Error: File content verification failed for ${resolved.relativePath}. Expected ${content.length} bytes but got ${verifyContent.length} bytes.` };
          }

          return {
            toolName,
            result: makeWriteSuccess({
              ok: true,
              action: "create_file",
              relativePath: resolved.relativePath,
              absolutePath: resolved.absolutePath,
              fileType: "text",
              existed,
              bytes: verifyContent.length,
            }),
          };
        } catch (error) {
          console.error("[create_file] Error:", error);
          return { toolName, result: `Error creating file: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      default:
        return { toolName, result: `Error: Unknown tool: ${toolName}` };
    }
  } catch (error) {
    return { toolName, result: `Error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function readResponsePayload<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`MCP server error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error("MCP server returned an empty response.");
  }

  // Handle SSE format
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    const lastData = dataLines[dataLines.length - 1];
    if (!lastData) {
      throw new Error("MCP server did not stream any payload.");
    }

    return JSON.parse(lastData) as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`Failed to parse MCP response: ${text.slice(0, 200)}`);
  }
}

async function sendJsonRpc<T>(
  profile: ModelProfile,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  if (!profile.mcpServerUrl.trim()) {
    throw new Error("This model profile does not have an MCP server URL.");
  }

  // Build payload with config included for stateless proxy
  const payload = {
    jsonrpc: "2.0" as const,
    id: ++requestCounter,
    method,
    params,
    // Include config for stateless proxy design
    base_url: profile.baseUrl,
    api_key: profile.apiKey,
  };

  let response: Response;
  try {
    response = await fetch(profile.mcpServerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error: any) {
    // Provide more helpful error messages for common issues
    if (error.message?.includes("Failed to fetch") || error.message?.includes("NetworkError")) {
      throw new Error(
        `Failed to connect to MCP server at ${profile.mcpServerUrl}. ` +
        `This could be due to: CORS restrictions, server unavailable, or invalid URL.`
      );
    }
    throw error;
  }

  const data = await readResponsePayload<JsonRpcResponse<T>>(response);
  if (data.error) {
    throw new Error(data.error.message || "MCP server request failed.");
  }

  if (typeof data.result === "undefined") {
    throw new Error("MCP server response did not include a result.");
  }

  return data.result;
}

export async function testMcpConnection(profile: ModelProfile) {
  return sendJsonRpc<{ tools?: Array<{ name: string; description?: string }> }>(profile, "tools/list");
}

function extractToolText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;

  const content = (result as { content?: Array<{ text?: string; type?: string }> }).content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || "")
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(result, null, 2);
}

export async function runMcpSearch(profile: ModelProfile, query: string) {
  const toolsResult = await sendJsonRpc<{ tools?: Array<{ name: string; description?: string }> }>(profile, "tools/list");
  const tools = toolsResult.tools ?? [];
  const preferredTool =
    tools.find((tool) => /search|web|browse|fetch|internet/i.test(tool.name)) ??
    tools.find((tool) => /search|web|browse|fetch|internet/i.test(tool.description || "")) ??
    tools[0];

  if (!preferredTool) {
    throw new Error("No MCP tools are available on the configured server.");
  }

  const result = await sendJsonRpc<unknown>(profile, "tools/call", {
    name: preferredTool.name,
    arguments: {
      query,
      q: query,
      prompt: query,
      input: query,
    },
  });

  return {
    toolName: preferredTool.name,
    text: extractToolText(result),
  };
}
