import type { ModelProfile } from "../types/ai";
import type { McpTool, McpToolResult } from "../types/ai";
import { readFile, readDirectory } from "./fileSystemService";
import type { WorkspaceNode } from "./fileSystemService";
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
  }
];

export function getLocalTools(): McpTool[] {
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
  options?: { enableWebSearch?: boolean; searchCount?: number; searchLimit?: number }
): Promise<McpToolResult> {
  try {
    switch (toolName) {
      case "list_directory": {
        const relativePath = (args.path as string) || "";
        const recursive = (args.recursive as boolean) || false;
        
        // 如果 relativePath 为空，直接列出根目录内容
        if (!relativePath) {
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
        const targetPath = `${workspaceRoot}/${relativePath}`;
        const targetNode = findNodeByPath(workspaceNodes, targetPath);
        
        if (!targetNode) {
          return { toolName, result: `Error: Directory not found: ${relativePath}` };
        }
        
        if (targetNode.type !== "folder") {
          return { toolName, result: `Error: ${relativePath} is not a directory` };
        }
        
        // 如果节点没有加载子节点，需要先加载
        if (!targetNode.children) {
          return { toolName, result: `Error: Directory not loaded yet. Please try again.` };
        }
        
        if (recursive) {
          const tree = buildDirectoryTree(targetNode.children, relativePath);
          return { toolName, result: JSON.stringify(tree, null, 2) };
        } else {
          const entries = targetNode.children.map(node => ({
            name: node.name,
            type: node.type === "folder" ? "directory" : "file",
            path: relativePath ? `${relativePath}/${node.name}` : node.name
          }));
          return { toolName, result: JSON.stringify(entries, null, 2) };
        }
      }
      case "read_file": {
        const relativePath = args.path as string;
        if (!relativePath) {
          return { toolName, result: "Error: path is required" };
        }
        
        // 构建完整路径，使用正确的分隔符
        const separator = workspaceRoot.includes("\\") ? "\\" : "/";
        const targetPath = `${workspaceRoot}${separator}${relativePath.replace(/[/\\]/g, separator)}`;
        
        // 尝试读取文件
        try {
          const content = await readFile(targetPath);
          if (content.length > MAX_FILE_SIZE) {
            return { toolName, result: `Error: File size (${content.length} bytes) exceeds the 50KB limit.` };
          }
          return { toolName, result: content };
        } catch (error) {
          // 如果读取失败，可能是因为文件句柄未注册
          // 尝试加载父目录来注册文件句柄
          const parentPath = targetPath.substring(0, targetPath.lastIndexOf(separator));
          if (parentPath) {
            try {
              await readDirectory(parentPath);
              // 再次尝试读取文件
              const content = await readFile(targetPath);
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
