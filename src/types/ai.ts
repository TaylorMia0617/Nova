export type ModelTransportType = "sse-http";

export interface ModelProfile {
  id: string;
  label: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  transportType: ModelTransportType;
  mcpServerUrl: string;
  headers: Array<{ key: string; value: string }>;
  rememberSecrets: boolean;
}

export interface SelectionPromptTemplates {
  polish: string;
  correct: string;
  stylize: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ConversationAttachment[];
  skills?: ChatSkills;
  searchCount?: number;
  workItems?: ConversationWorkItem[];
}

export interface ConversationWorkItem {
  id: string;
  kind: "tool" | "search" | "file" | "blueprint" | "write" | "thinking";
  label: string;
  status: "running" | "done" | "error";
  detail?: string;
  resultSummary?: string;
  createdAt: string;
}

export interface ConversationAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  mimeType: string;
  textContent: string;
  createdAt: string;
  truncated?: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  modelId: string | null;
}

export interface ConversationRecord extends ConversationSummary {
  messages: ConversationMessage[];
  draftInput?: string;
  contextFilePath?: string | null;
  lastInsertedText?: string | null;
  boundFileCaches?: FileContentCache[];
  chatSkills?: ChatSkills;
}

export interface ChatSkills {
  enableWebSearch: boolean;
  thinkingDepth: "off" | "low" | "medium" | "high";
  agentSubMode: "plan" | "build";
}

export type AiTaskType = "chat" | "polish" | "correct" | "stylize";

export interface SelectionRequest {
  mode: Exclude<AiTaskType, "chat">;
  selectedText: string;
  documentContext: string;
}

export interface DocumentMeta {
  fileName: string;
  filePath: string;
  charCount: number;
  lineCount: number;
  wordCount: number;
}

export interface FileChange {
  startLine: number;
  endLine: number;
  oldContent: string;
  newContent: string;
  timestamp: string;
}

export interface FileContentCache {
  filePath: string;
  content: string;
  lastSentAt: string;
}

export interface MultiFileContext {
  activeFile: {
    meta: DocumentMeta;
    content: string;
    cachedContent: string | null;
    recentChanges: FileChange[];
  };
  otherBoundFiles: Array<{
    meta: DocumentMeta;
    recentChanges: FileChange[];
  }>;
  allBoundFiles: Array<{
    meta: DocumentMeta;
    lastUsed: string;
  }>;
}

export interface McpToolProperty {
  type: string;
  description?: string;
  items?: McpToolProperty;
  properties?: Record<string, McpToolProperty>;
  required?: string[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, McpToolProperty>;
    required: string[];
  };
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  toolName: string;
  result: string;
}
