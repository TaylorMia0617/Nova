import type { AiTaskType, ChatSkills, ConversationAttachment, ConversationMessage, DocumentMeta, FileChange, ModelProfile, MultiFileContext } from "../types/ai";
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
  skills?: ChatSkills;
  workspaceRoot?: string;
  directoryTree?: string;
}

function smartTruncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  const headLength = Math.floor(maxLength * 0.1);
  const tailLength = maxLength - headLength - 80;

  return content.slice(0, headLength) +
    `\n\n... [truncated ${content.length - maxLength} characters] ...\n\n` +
    content.slice(-tailLength);
}

function buildDocumentContext(
  content: string,
  maxLength: number
): string {
  // 始终返回完整内容（截断到 maxLength）
  return smartTruncate(content, maxLength);
}

function buildSystemPrompt(
  taskType: AiTaskType,
  context: string,
  meta?: DocumentMeta,
  otherBoundFiles?: Array<{ meta: DocumentMeta; recentChanges: FileChange[] }>,
  allBoundFiles?: Array<{ meta: DocumentMeta; lastUsed: string }>,
  selectionPrompt?: string,
  enableWebSearch: boolean = false,
  workspaceRoot?: string,
  directoryTree?: string
) {
  const base = `You are a creative writing assistant helping a novelist.
You help with structure, scene writing, line editing, continuity, and narrative clarity.
You may use markdown formatting (bold, italic, headings, lists, tables, code blocks) to structure your response when appropriate.`;

  const metaInfo = meta ? `
Current file: ${meta.fileName}
Path: ${meta.filePath}
Stats: ${meta.charCount} characters, ${meta.lineCount} lines, ${meta.wordCount} words
` : "";

  const workspaceInfo = workspaceRoot 
    ? `\n\nWorkspace root directory: ${workspaceRoot}`
    : "";

  const otherBoundFilesInfo = otherBoundFiles?.length
    ? `\nOther bound files with changes:\n${otherBoundFiles.map(f => {
        if (f.recentChanges.length === 0) return null;
        const changesText = f.recentChanges.map(c =>
          `  Lines ${c.startLine}-${c.endLine}: ${c.newContent.slice(0, 100)}...`
        ).join('\n');
        return `- ${f.meta.fileName}:\n${changesText}`;
      }).filter(Boolean).join('\n')}`
    : "";

  const allBoundFilesInfo = allBoundFiles?.length
    ? `\nAll files bound to this conversation:\n${allBoundFiles.map(f =>
        `- ${f.meta.fileName} (last used: ${new Date(f.lastUsed).toLocaleString()})`
      ).join('\n')}`
    : "";

  const toolInfo = taskType === "chat"
    ? `\n\nYou have access to the following tools to explore the workspace:
- list_directory: List files and folders in a directory (supports recursive listing). Use path="" for root directory.
- read_file: Read file content (max 50KB). Use relative path from workspace root (e.g., "第四章.txt" or "notes/characters.txt").${enableWebSearch ? '\n- web_search: Search the internet for information. Use when you need external knowledge.' : ''}

Use these tools when you need to read files that are not currently bound to this conversation. You can call them by responding with a JSON block like:
\`\`\`tool_call
{"name": "list_directory", "arguments": {"path": "", "recursive": true}}
\`\`\`
or
\`\`\`tool_call
{"name": "read_file", "arguments": {"path": "第四章.txt"}}
\`\`\`${enableWebSearch ? '\nor\n```tool_call\n{"name": "web_search", "arguments": {"query": "search terms"}}\n```' : ''}`
    : `\n\n${selectionPrompt || ""}\nReturn only the rewritten text.`;

  const directoryInfo = directoryTree
    ? `\n\nWorkspace directory structure:\n\`\`\`\n${directoryTree}\n\`\`\``
    : "";

  const taskSpecificInfo = taskType === "chat"
    ? "\n\nWhen relevant, use the browsing or search context that has already been retrieved from MCP tools."
    : "";

  return `${base}${metaInfo}${workspaceInfo}${otherBoundFilesInfo}${allBoundFilesInfo}${toolInfo}${directoryInfo}${taskSpecificInfo}
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
  const { modelProfile, conversationHistory, skills } = options;

  const temperature = skills?.thinkingDepth === "low" ? 0.3
                    : skills?.thinkingDepth === "high" ? 1.0
                    : skills?.thinkingDepth === "off" ? 0.7
                    : 0.7;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      instructions: systemPrompt,
      input: buildOpenAIResponsesInput(finalUserMessage, conversationHistory),
      max_output_tokens: options.maxTokens || 8192,
      temperature,
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
  const { modelProfile, conversationHistory, skills } = options;
  const tokenLimitKey = isMimoModel(modelProfile.model) ? "max_completion_tokens" : "max_tokens";

  const temperature = skills?.thinkingDepth === "low" ? 0.3
                    : skills?.thinkingDepth === "high" ? 1.0
                    : skills?.thinkingDepth === "off" ? 0.7
                    : 0.7;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      messages: buildChatCompletionMessages(systemPrompt, finalUserMessage, conversationHistory),
      [tokenLimitKey]: options.maxTokens || 8192,
      temperature,
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
  const { taskType, userMessage, selectionPrompt, attachments = [], modelProfile, multiFileContext, contextMaxLength = 5000, skills, workspaceRoot, directoryTree } = options;

  let documentContext = options.documentContext;
  if (multiFileContext) {
    documentContext = buildDocumentContext(
      multiFileContext.activeFile.content,
      contextMaxLength
    );
  }

  const systemPrompt = buildSystemPrompt(
    taskType,
    documentContext,
    multiFileContext?.activeFile.meta,
    multiFileContext?.otherBoundFiles,
    multiFileContext?.allBoundFiles,
    selectionPrompt,
    skills?.enableWebSearch ?? false,
    workspaceRoot,
    directoryTree
  );
  const finalUserMessage = getFinalUserMessage(userMessage, mcpContext, attachments);

  if (!isMimoModel(modelProfile.model) && isResponsesUrl(modelProfile.baseUrl)) {
    return callResponsesApi(options, systemPrompt, finalUserMessage);
  }

  return callChatCompletionsApi(options, systemPrompt, finalUserMessage);
}

export async function callAI(options: AiRequestOptions): Promise<string> {
  // 移除自动搜索逻辑，直接调用 AI
  return callOpenAiCompatible(options);
}
