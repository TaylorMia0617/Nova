import { runMcpSearch } from "./mcpService";
import type { AiTaskType, ConversationAttachment, ConversationMessage, DocumentMeta, FileChange, ModelProfile, MultiFileContext } from "../types/ai";
import { serializeAttachmentsForPrompt } from "./attachmentService";

interface AiRequestOptions {
  modelProfile: ModelProfile;
  taskType: AiTaskType;
  userMessage: string;
  documentContext: string;
  documentFileName?: string;
  maxTokens?: number;
  conversationHistory: ConversationMessage[];
  selectionPrompt?: string;
  attachments?: ConversationAttachment[];
  multiFileContext?: MultiFileContext;
  contextMaxLength?: number;
}

function smartTruncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  const headLength = Math.floor(maxLength * 0.1);
  const tailLength = maxLength - headLength - 80;

  return content.slice(0, headLength) +
    `\n\n... [truncated ${content.length - maxLength} characters] ...\n\n` +
    content.slice(-tailLength);
}

function buildChangesContext(
  fullContent: string,
  changes: FileChange[],
  maxLength: number
): string {
  if (fullContent.length <= maxLength) {
    return fullContent;
  }

  const changesSummary = changes.map(change => {
    const lineInfo = `Lines ${change.startLine}-${change.endLine}`;
    return `[${lineInfo}]\n${change.newContent}`;
  }).join('\n\n');

  const headLength = Math.floor(maxLength * 0.2);
  const head = fullContent.slice(0, headLength);

  return `${head}\n\n... [showing recent changes] ...\n\n${changesSummary}`;
}

function buildDocumentContext(
  content: string,
  recentChanges: FileChange[],
  maxLength: number
): string {
  if (content.length <= maxLength) {
    return content;
  }

  if (recentChanges.length > 0) {
    return buildChangesContext(content, recentChanges, maxLength);
  }

  return smartTruncate(content, maxLength);
}

function buildSystemPrompt(
  taskType: AiTaskType,
  context: string,
  meta?: DocumentMeta,
  otherFiles?: Array<{ meta: DocumentMeta; preview: string }>,
  conversationFiles?: Array<{ meta: DocumentMeta; lastUsed: string }>,
  selectionPrompt?: string
) {
  const base = `You are a creative writing assistant helping a novelist.
You help with structure, scene writing, line editing, continuity, and narrative clarity.
You may use markdown formatting (bold, italic, headings, lists, tables, code blocks) to structure your response when appropriate.`;

  const metaInfo = meta ? `
Current file: ${meta.fileName}
Path: ${meta.filePath}
Stats: ${meta.charCount} characters, ${meta.lineCount} lines, ${meta.wordCount} words
` : "";

  const otherFilesInfo = otherFiles?.length
    ? `\nOther open files:\n${otherFiles.map(f =>
        `- ${f.meta.fileName} (${f.meta.charCount} chars): ${f.preview}...`
      ).join('\n')}`
    : "";

  const conversationFilesInfo = conversationFiles?.length
    ? `\nFiles discussed in this conversation:\n${conversationFiles.map(f =>
        `- ${f.meta.fileName} (last used: ${new Date(f.lastUsed).toLocaleString()})`
      ).join('\n')}`
    : "";

  const taskSpecificInfo = taskType === "chat"
    ? "\n\nWhen relevant, use the browsing or search context that has already been retrieved from MCP tools."
    : `\n\n${selectionPrompt || ""}\nReturn only the rewritten text.`;

  return `${base}${metaInfo}${otherFilesInfo}${conversationFilesInfo}${taskSpecificInfo}
Current document content:
${context}`;
}

function buildOpenAIResponsesInput(userMessage: string, conversationHistory: ConversationMessage[]) {
  return [
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: [{ type: "input_text" as const, text: msg.content }],
    })),
    {
      role: "user" as const,
      content: [{ type: "input_text" as const, text: userMessage }],
    },
  ];
}

function buildChatCompletionMessages(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: ConversationMessage[]
) {
  return [
    {
      role: "system" as const,
      content: systemPrompt,
    },
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    {
      role: "user" as const,
      content: userMessage,
    },
  ];
}

function getFinalUserMessage(userMessage: string, mcpContext: string, attachments: ConversationAttachment[]) {
  const attachmentContext = serializeAttachmentsForPrompt(attachments);
  const composedContexts = [
    mcpContext ? `External research context:\n${mcpContext}` : "",
    attachmentContext ? `Attached file context:\n${attachmentContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return composedContexts ? `${userMessage}\n\n${composedContexts}` : userMessage;
}

function isResponsesUrl(url: string) {
  return /\/responses\/?$/i.test(url);
}

function isMimoModel(model: string) {
  return model.trim().toLowerCase().startsWith("mimo");
}

async function parseErrorMessage(response: Response) {
  try {
    const error = await response.json();
    return error.error?.message || error.message || `AI request failed: ${response.status} ${response.statusText}`;
  } catch {
    return `AI request failed: ${response.status} ${response.statusText}`;
  }
}

function buildRequestHeaders(modelProfile: ModelProfile) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${modelProfile.apiKey}`,
  };
  if (modelProfile.headers?.length) {
    for (const h of modelProfile.headers) {
      if (h.key.trim()) {
        headers[h.key.trim()] = h.value;
      }
    }
  }
  return headers;
}

async function callResponsesApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, taskType, conversationHistory } = options;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      instructions: systemPrompt,
      input: buildOpenAIResponsesInput(finalUserMessage, conversationHistory),
      max_output_tokens: options.maxTokens || 8192,
      temperature: taskType === "chat" ? 0.7 : 0.45,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = await response.json();
  const outputText =
    typeof data.output_text === "string"
      ? data.output_text
      : data.output
          ?.flatMap((item: any) =>
            item.type === "message"
              ? item.content
                  ?.filter((content: any) => content.type === "output_text")
                  .map((content: any) => content.text) ?? []
              : []
          )
          .join("");

  if (!outputText) {
    throw new Error("AI response did not include any text output.");
  }

  return outputText.trim();
}

async function callChatCompletionsApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, taskType, conversationHistory } = options;
  const tokenLimitKey = isMimoModel(modelProfile.model) ? "max_completion_tokens" : "max_tokens";

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      messages: buildChatCompletionMessages(systemPrompt, finalUserMessage, conversationHistory),
      [tokenLimitKey]: options.maxTokens || 8192,
      temperature: taskType === "chat" ? 0.7 : 0.45,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = await response.json();
  const outputText = data.choices?.[0]?.message?.content;

  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  if (Array.isArray(outputText)) {
    const merged = outputText
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("");
    if (merged.trim()) {
      return merged.trim();
    }
  }

  throw new Error("AI response did not include any chat completion text.");
}

async function callOpenAiCompatible(options: AiRequestOptions, mcpContext = "") {
  const { taskType, userMessage, selectionPrompt, attachments = [], modelProfile, multiFileContext, contextMaxLength = 5000 } = options;

  let documentContext = options.documentContext;
  if (multiFileContext) {
    documentContext = buildDocumentContext(
      multiFileContext.activeFile.content,
      multiFileContext.activeFile.recentChanges,
      contextMaxLength
    );
  }

  const systemPrompt = buildSystemPrompt(
    taskType,
    documentContext,
    multiFileContext?.activeFile.meta,
    multiFileContext?.otherOpenFiles,
    multiFileContext?.conversationFiles,
    selectionPrompt
  );
  const finalUserMessage = getFinalUserMessage(userMessage, mcpContext, attachments);

  if (!isMimoModel(modelProfile.model) && isResponsesUrl(modelProfile.baseUrl)) {
    return callResponsesApi(options, systemPrompt, finalUserMessage);
  }

  return callChatCompletionsApi(options, systemPrompt, finalUserMessage);
}

export async function callAI(options: AiRequestOptions): Promise<string> {
  const { modelProfile, taskType, userMessage } = options;

  let mcpContext = "";
  if (modelProfile.mcpServerUrl.trim()) {
    try {
      const result = await runMcpSearch(modelProfile, userMessage);
      if (result.text.trim()) {
        mcpContext = `Tool: ${result.toolName}\n${result.text.trim()}`;
      }
    } catch (error) {
      if (taskType === "chat") {
        throw error;
      }
    }
  }

  return callOpenAiCompatible(options, mcpContext);
}
