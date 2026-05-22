import type { ModelProfile } from "../types/ai";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

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

function buildHeaders(profile: ModelProfile, extra?: Record<string, string>) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  };

  profile.headers.forEach((header) => {
    if (header.key.trim()) {
      headers[header.key.trim()] = header.value;
    }
  });

  if (profile.apiKey.trim()) {
    headers.Authorization = `Bearer ${profile.apiKey.trim()}`;
  }

  return headers;
}

async function readResponsePayload<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error("MCP server returned an empty response.");
  }

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

  return JSON.parse(text) as T;
}

async function sendJsonRpc<T>(
  profile: ModelProfile,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  if (!profile.mcpServerUrl.trim()) {
    throw new Error("This model profile does not have an MCP server URL.");
  }

  const payload: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: ++requestCounter,
    method,
    params,
  };

  const response = await fetch(profile.mcpServerUrl, {
    method: "POST",
    headers: buildHeaders(profile),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`MCP server error: ${response.status} ${response.statusText}`);
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
