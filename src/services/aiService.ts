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
  directoryTree?: string,
  agentSubMode?: "plan" | "build"
) {
  const base = agentSubMode === "plan"
    ? `You are in PLAN mode. Your job is to analyze the workspace and create detailed implementation plans.

## Your Role
- Read and understand the existing files and project structure
- Analyze the user's request and break it down into actionable steps
- Provide a clear, detailed plan with specific file paths and line numbers
- Identify potential issues, dependencies, and risks

## Workflow (MUST follow this order)
1. FIRST: Use list_directory to understand the workspace structure
2. THEN: Use read_file to examine relevant files (current content, related files, etc.)
3. FINALLY: Provide a detailed plan with:
   - Specific files to create/modify
   - Exact content changes (with line numbers for edits)
   - Order of operations
   - Potential risks or considerations

## Important Rules
- Do NOT write or edit any files - you can only read and analyze
- Always read files before planning changes to them
- Be specific: include file paths, line numbers, and exact content
- If unsure about something, ask the user for clarification`
    : agentSubMode === "build"
    ? `You are in BUILD mode. Your job is to actively implement changes in the workspace.

## Your Role
- Execute the user's requests by reading, writing, and editing files
- Follow any existing plan (from Plan mode) or the user's direct instructions
- Take initiative: if the request is clear, execute it directly
- Make reasonable creative decisions when details are unclear

## Workflow (MUST follow this order)
1. FIRST: Use list_directory and read_file to understand the current state
2. THEN: Use create_file or edit_file to implement changes
3. FINALLY: Confirm what you've done and explain any decisions you made

## Tool Priority
1. read_file - Always read before writing to understand current content
2. edit_file - Prefer editing existing files over creating new ones
3. create_file - Only when a new file is needed

## Important Rules
- Do NOT use Base64 encoding - output content as plain text
- Always read a file before editing it (to understand current content)
- When editing, specify precise line numbers (startLine, endLine)
- Keep content concise - avoid generating excessively long text
- If the user provides a plan, follow it step by step`
    : `You are a creative writing assistant helping a novelist.

## Your Role
- Analyze the current document and provide actionable suggestions
- Help brainstorm ideas, develop characters, and refine prose
- Use markdown formatting (bold, italic, headings, lists, tables) to structure your responses

## Tool Usage
- Use list_directory and read_file to explore the workspace when needed
- Do NOT write or edit files unless explicitly asked by the user
- Focus on analysis and suggestions rather than direct modifications`;

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
- read_file: Read file content (max 50KB). Use relative path from workspace root (e.g., "第四章.txt" or "notes/characters.txt").${enableWebSearch ? '\n- web_search: Search the internet for information. Use when you need external knowledge.' : ''}${agentSubMode === "build" ? '\n- edit_file: Edit a file with line-level precision. Provide path and edits array with startLine, endLine, and newContent (plain text).\n- create_file: Create a new file with optional initial content. Provide path and content (plain text).' : ''}

Use these tools when you need to read files that are not currently bound to this conversation. You can call them by responding with a JSON block like:
\`\`\`tool_call
{"name": "list_directory", "arguments": {"path": "", "recursive": true}}
\`\`\`
or
\`\`\`tool_call
{"name": "read_file", "arguments": {"path": "第四章.txt"}}
\`\`\`${enableWebSearch ? '\nor\n```tool_call\n{"name": "web_search", "arguments": {"query": "search terms"}}\n```' : ''}${agentSubMode === "build" ? '\nor\n```tool_call\n{"name": "edit_file", "arguments": {"path": "第四章.txt", "edits": [{"startLine": 10, "endLine": 15, "newContent": "new text here"}]}}\n```' : ''}${agentSubMode === "build" ? '\nor\n```tool_call\n{"name": "create_file", "arguments": {"path": "新章节.txt", "content": "initial content here"}}\n```' : ''}${agentSubMode === "build" ? '\n\nIMPORTANT: When writing file content, do NOT use Base64 encoding. Output the content as plain text in the "content" or "newContent" field. The system will handle special characters automatically.' : ''}`
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
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
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
      ...(options.maxTokens ? { [tokenLimitKey]: options.maxTokens } : {}),
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
    directoryTree,
    skills?.agentSubMode
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
