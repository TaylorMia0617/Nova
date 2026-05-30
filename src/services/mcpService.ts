import type { ModelProfile } from "../types/ai";

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
