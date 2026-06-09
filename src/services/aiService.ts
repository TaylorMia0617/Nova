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
  const fence = "```";
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
- All file paths must be relative to the workspace root. Never use absolute paths, drive-letter paths, or ".."
- Do not use edit_file on existing .docx files. To create a .docx file, use create_file with plain text content
- Always read a file before editing it (to understand current content)
- When editing, specify precise line numbers (startLine, endLine)
- Keep prose concise, but do not artificially limit structured outputs such as blueprints
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

  const webSearchGuidance = enableWebSearch
    ? `\n\n## Web Search Policy\n- Use web_search proactively when the user asks for current facts, external references, market/background research, historical/cultural details you are unsure about, or any claim that may depend on up-to-date information.\n- Do not search for pure prose rewriting, local file analysis, or when the user explicitly asks you not to use the web.\n- After searching, summarize the useful evidence in your own words and continue the task.`
    : `\n\n## Web Search Policy\n- Web search is currently disabled. Do not call web_search.\n- If the task clearly needs external or current information, say that web search needs to be enabled.`;

  const blueprintGuidance = `\n\n## Blueprint Guide\nBlueprints are story-structure graphs. A BlueprintDocument has { id, name, updatedAt, nodes, edges, viewport }.\n- nodes are story elements. Common fields: id, kind, layer, nodeType, x, y, title, summary, linkedChapters, typedData, customFields.\n- edges connect nodes with from/to ids and optional role. Use edges for narrative flow, structure flow, reveal/logic links, branch/merge paths.\n- chapter nodes use nodeType="chapter" and typedData.summary / typedData.chapterTitle. linkedChapters binds a node to workspace file names or heading titles.\n- typedData.mountLinks on a chapter node mounts child blueprints under that chapter.\n- Use list_blueprints and read_blueprint before analyzing existing blueprints.\n- In Build mode, use create_blueprint to generate a new blueprint. Place nodes on a readable grid, give every node a clear title and summary, and create edges that tell the story structure.\n- Never cap a generated blueprint to a fixed number of nodes. Use as many content-derived nodes as the source needs: chapter beats, hooks, characters, conflicts, clues, reveals, emotional turns, scene blocks, and structural summary nodes.\n- A chapter-to-blueprint workflow should read the source chapter first, derive a TODO-style construction plan, create the complete blueprint, then summarize what was created.`;

  const todoWorkflowGuidance = taskType === "chat"
    ? `\n\n## TODO Workflow\n- For multi-step requests, make a compact TODO plan before acting. For example: locate file, read content, analyze beats, create blueprint, summarize result.\n- If a TODO step needs a tool, output the tool_call block in the same response. Do not stop after saying you will use a tool.\n- After each Tool Results message, continue the TODO workflow: either call the next needed tool or provide the final answer.\n- For requests like "read chapter one and create a blueprint", use this sequence unless the needed content is already in context: list_directory when the path is unknown, read_file for the chapter, create_blueprint with all needed nodes and edges, then summarize.\n- You may show a short visible TODO list before tool_call blocks, but the tool_call blocks must still be present when tools are needed.`
    : "";

  const buildOnlyTools = agentSubMode === "build"
    ? `
- create_blueprint: Create or replace a blueprint from nodes and edges.
- edit_file: Edit a file with line-level precision. Provide path and edits array with startLine, endLine, and newContent.
- create_file: Create a new file with optional initial content.`
    : "";

  const buildOnlyExamples = agentSubMode === "build"
    ? `
or
${fence}tool_call
{"name":"create_blueprint","arguments":{"name":"Three Act Blueprint","nodes":[{"id":"chapter-1","kind":"custom","layer":"structure","nodeType":"chapter","x":120,"y":120,"title":"第一章","summary":"章节核心内容摘要","typedData":{"summary":"章节核心内容摘要","chapterTitle":"第一章"}}],"edges":[]}}
${fence}
or
${fence}tool_call
{"name":"edit_file","arguments":{"path":"chapter-4.txt","edits":[{"startLine":10,"endLine":15,"newContent":"new text here"}]}}
${fence}
or
${fence}tool_call
{"name":"create_file","arguments":{"path":"new-chapter.txt","content":"initial content here"}}
${fence}

IMPORTANT: When writing file or blueprint content, do not use Base64 encoding. Output plain text or plain JSON. The blueprint example above is only a format example; real blueprint creation must include all nodes and edges needed by the source, not a fixed or minimal count.`
    : "";

  const toolInfo = taskType === "chat"
    ? `

You have access to these tools:
- list_directory: List workspace files and folders. Use path="" for the root.
- read_file: Read file content, max 50KB. Use workspace-relative paths only.
${enableWebSearch ? "- web_search: Search the internet. Use automatically when the Web Search Policy says external/current facts are needed.\n" : ""}- list_blueprints: List all story blueprints with compact summaries.
- read_blueprint: Read a blueprint by id or name before analyzing it.${buildOnlyTools}

Path rules:
- Always use workspace-relative paths.
- Never use absolute paths, drive-letter paths, /tmp paths, or paths containing "..".
- Existing .docx files cannot be edited with edit_file. To create a .docx file, call create_file with plain text content.

Tool call format: when you need tools, respond with one or more fenced blocks whose info string is tool_call and whose body is JSON. Do not merely describe that you will use a tool. If you say you will inspect, read, search, list, or create something, include the matching tool_call block in the same response.
Examples:
${fence}tool_call
{"name":"list_directory","arguments":{"path":"","recursive":true}}
${fence}
or
${fence}tool_call
{"name":"read_file","arguments":{"path":"chapter-4.txt"}}
${fence}
${enableWebSearch ? `or\n${fence}tool_call\n{"name":"web_search","arguments":{"query":"search terms"}}\n${fence}\n` : ""}or
${fence}tool_call
{"name":"list_blueprints","arguments":{}}
${fence}
or
${fence}tool_call
{"name":"read_blueprint","arguments":{"name":"Main Story Structure"}}
${fence}${buildOnlyExamples}`
    : `\n\n${selectionPrompt || ""}\nReturn only the rewritten text.`;
  const directoryInfo = directoryTree
    ? `\n\nWorkspace directory structure:\n\`\`\`\n${directoryTree}\n\`\`\``
    : "";

  const taskSpecificInfo = taskType === "chat"
    ? "\n\nWhen relevant, use the browsing or search context that has already been retrieved from MCP tools."
    : "";

  return `${base}${metaInfo}${workspaceInfo}${otherBoundFilesInfo}${allBoundFilesInfo}${webSearchGuidance}${blueprintGuidance}${todoWorkflowGuidance}${toolInfo}${directoryInfo}${taskSpecificInfo}
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
