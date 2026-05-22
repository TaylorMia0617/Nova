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
}

export type AiTaskType = "chat" | "polish" | "correct" | "stylize";

export interface SelectionRequest {
  mode: Exclude<AiTaskType, "chat">;
  selectedText: string;
  documentContext: string;
}
