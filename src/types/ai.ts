export type ModelTransportType =
  | "openai-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "openai-compatible"
  | "sse-http";

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
  promptDebug?: PromptDebugBreakdown;
  editReviewDebug?: EditReviewDebug;
  clarificationAnswers?: ClarificationAnswer[];
}

export interface PromptDebugEntry {
  label: string;
  chars: number;
  rawChars?: number;
  sentChars?: number;
  estimatedTokens: number;
  dynamic: boolean;
  cacheFriendly: "high" | "medium" | "low";
  strategy?: "none" | "metadata" | "history-delta" | "snippet" | "full" | "structured" | "stable" | "summary" | "omitted";
  reason?: string;
  fromWorkingSet?: boolean;
}

export interface PromptDebugBreakdown {
  createdAt: string;
  totalChars: number;
  totalEstimatedTokens: number;
  dynamicChars: number;
  entries: PromptDebugEntry[];
}

export interface EditReviewDebug {
  createdAt: string;
  enabled: boolean;
  triggered: boolean;
  modelLabel?: string;
  modelId?: string;
  filePath?: string;
  editCount: number;
  reviewedCount: number;
  skippedCount: number;
  originalChars: number;
  reviewedChars: number;
  durationMs: number;
  skipReasons: string[];
  fallbackReasons: string[];
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
  workingSet?: WorkingSetEntry[];
  chatSkills?: ChatSkills;
  pendingPlan?: PendingPlanConfirmation | null;
  pendingClarification?: PendingClarification | null;
}

export interface WorkingSetEntry {
  filePath: string;
  fileName: string;
  contentHash: string;
  charCount: number;
  wordCount: number;
  lineCount: number;
  snippet: string;
  summary: string;
  source: "active" | "tool" | "write";
  updatedAt: string;
  lastUsedAt: string;
}

export type AgentMode = "writer" | "editor";

export interface PendingPlanConfirmation {
  planMessageId: string;
  userMessage: ConversationMessage;
  planContent: string;
  agentMode: AgentMode;
  createdAt: string;
}

export interface PendingClarification {
  messageId: string;
  userMessage: ConversationMessage;
  promptContent: string;
  agentMode: AgentMode;
  createdAt: string;
  questions?: ClarificationQuestion[];
  currentIndex?: number;
  answers?: ClarificationAnswer[];
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
}

export interface ClarificationAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface ChatSkills {
  enableWebSearch: boolean;
  agentMode: AgentMode;
  agentSubMode: "plan" | "build";
  forcePlanMode: boolean;
  enableEditReview: boolean;
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
