import type { ModelProfile } from "../types/ai";
import type { McpTool, McpToolResult } from "../types/ai";
import { readFile, readDirectory, writeFile, writeFileBinary, createFile } from "./fileSystemService";
import type { WorkspaceNode } from "./fileSystemService";
import { createDocxBase64FromPlainText } from "./docxOoxmlService";
import { searchWithTavily } from "./searchService";

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

type ResolvedWorkspacePath = {
  relativePath: string;
  absolutePath: string;
  separator: string;
};

type WriteToolSuccess = {
  ok: true;
  action: "create_file" | "edit_file";
  relativePath: string;
  absolutePath: string;
  fileType: "text" | "docx";
  existed?: boolean;
  bytes?: number;
  edits?: number;
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

export function getLocalTools(agentSubMode?: "plan" | "build"): McpTool[] {
  if (agentSubMode === "plan") {
    return LOCAL_FILESYSTEM_TOOLS.filter(t => t.name !== "edit_file" && t.name !== "create_file");
  }
  return LOCAL_FILESYSTEM_TOOLS;
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

export async function runLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  workspaceNodes: WorkspaceNode[],
  options?: { enableWebSearch?: boolean; searchCount?: number; searchLimit?: number; agentSubMode?: "plan" | "build" }
): Promise<McpToolResult> {
  try {
    if ((toolName === "edit_file" || toolName === "create_file") && options?.agentSubMode === "plan") {
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
          const content = await readFile(resolved.absolutePath);
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
              const content = await readFile(resolved.absolutePath);
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
            } else {
              throw createError;
            }
          }

          if (isDocx) {
            const docxBase64 = await createDocxBase64FromPlainText(content);
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
