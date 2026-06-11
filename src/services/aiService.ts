import type { AiTaskType, ChatSkills, ConversationAttachment, ConversationMessage, DocumentMeta, FileChange, ModelProfile, MultiFileContext } from "../types/ai";
import { serializeAttachmentsForPrompt } from "./attachmentService";

const HUMANIZE_REWRITE_GUIDANCE = `\n\n## Chinese Rewrite And Authorial Voice Rules
- Apply these rules when the user asks for polishing, rewriting, removing AI-like phrasing, strengthening authorial voice, or when the task is polish/stylize.
- Preserve the original meaning, information density, and basic structure. Do not add new story facts or settings on your own.
- Reduce templated phrasing. Avoid mechanical connectors such as "first", "second", "in conclusion", and "it is worth noting".
- Make sentences feel like they were written by a human author: vary sentence length, allow small pauses, and use natural turns.
- Preserve a measured personal judgment and tone. Do not make the prose overly objective, overly smooth, or manual-like.
- Remove empty boilerplate. Replace it with more specific, visual, or author-positioned phrasing.
- Do not make the prose overly ornate. Do not stack metaphors. Do not use web-novel cliches.
- If the original text has emotion, preserve it. If it is rational, keep it restrained without making it stiff.
- AVOID overusing em dashes, like "——".
- Allow a small amount of imperfect colloquial expression so the prose feels naturally written rather than machine-polished into excessive smoothness.
- For pure rewrite tasks, output only the rewritten body text and do not explain the revision process.`;

const ANTI_AI_FICTION_GUIDANCE = `\n\n## Fiction Naturalness Rules
- Do not force every paragraph to advance the plot.
- Important information may be delayed, withheld, or partially understood.
- Characters can misjudge, miss details, contradict themselves, or understand events incorrectly.
- Do not immediately explain abnormal phenomena.
- Present scenes through the character's senses and attention, not authorial exposition.
- Allow non-functional details when they make the moment feel lived-in.
- Dialogue should first express emotion, pressure, stance, avoidance, or desire; it should not primarily deliver setting information.
- Even when a character knows the answer, they do not have to say it immediately.
- Reveal information more slowly than your first instinct.
- Prioritize character experience over plot efficiency.`;

const CHARACTER_CONTINUITY_GUIDANCE = `\n\n## Character Continuity And OOC Guard
Use this schema as the standard format for character facts in plans, blueprints, and Memory Candidate content:

\`\`\`yaml
character:
  basic:
    name:
    age:
    identity:

  appearance:
    hair:
    eyes:

  personality:
    surface:
    core_belief:
    desire:
    fear:

  history:
    events:

  behavior:
    danger:
    pressure:
    conflict:

  relationships:

  arc:
    start:
    end:
\`\`\`

- When a task involves a character, first rely on Importants.md, blueprint character nodes, current document content, and files you have read.
- Store durable per-character facts in the project's reference/config list mechanism, preferably a list named "人物" or "Characters": the suggestion key is the character name, the annotation is the short note, and the structured body uses the schema above.
- Reference/config export format should be: {{CharacterName}} "short note" on the first line, followed by editable schema lines such as {basic}, [age]:, {personality}, [desire]:. The {{ }}, { }, and [ ] keys are user-editable and may be added, removed, or renamed.
- Use Importants.md for project-level summaries and major canon changes, not as a full character database.
- Do not change a character's name, age, identity, appearance, core belief, desire, fear, relationships, behavior pattern, or arc unless the user explicitly asks for a canon change.
- Psychological change must have a visible trigger, emotional transition, and behavioral evidence. Do not make a character suddenly mature, forgive, collapse, turn cruel, become affectionate, change loyalties, or speak in a new voice without setup.
- Keep reactions consistent with the character's behavior under danger, pressure, and conflict.
- If character facts are missing and the task depends on them, output exactly a "## Clarification Needed" section with the structured questions format instead of inventing age, gender, personality, backstory, trauma, romance, or relationships.
- When the user explicitly changes character canon, treat it as a project-state change and provide a Memory Candidate using action: add_character, update_character, update_relationship, or update_character_arc.`;

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
  memoryContext?: string;
  temperature?: number;
}

interface EditFileReviewOptions {
  modelProfile: ModelProfile;
  filePath: string;
  originalContent: string;
  proposedContent: string;
  referenceContext?: string;
  maxTokens?: number;
}

interface EditorRoleReviewOptions {
  modelProfile: ModelProfile;
  userInstruction: string;
  targetContent: string;
  filePath?: string;
  referenceContext?: string;
  maxTokens?: number;
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
  // Always return the full available content, truncated to maxLength.
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
  agentSubMode?: "plan" | "build",
  agentMode?: ChatSkills["agentMode"],
  memoryContext?: string
) {
  const fence = "```";
  const base = agentSubMode === "plan"
    ? `You are in PLAN mode. Your job is to analyze the workspace and create a clear, executable plan.

## Your Role
- Read and understand the existing files and project structure.
- Analyze the user's request and break it into actionable steps.
- Provide a clear, specific plan, including file paths and line numbers when useful.
- Identify likely issues, dependencies, and risks.

## Workflow
1. Use list_directory first to understand the workspace structure.
2. Use read_file to inspect relevant files.
3. Then output a plan that explains:
   - Which files need to be created or modified.
   - What content should change, with line numbers when needed.
   - The execution order.
   - Risks and considerations.

## Important Rules
- Do not write or edit files in PLAN mode. Only read and analyze.
- Always read relevant files before planning changes to them.
- Make the plan specific, not vague.
- For character, chapter, rewrite, or blueprint tasks, include a character continuity / OOC check in the plan.
- If required information is missing, output exactly a "## Clarification Needed" section with structured questions instead of pretending to have a complete plan.
- Ask only essential blocking questions. Prefer 1 question; use at most 3 questions.
- Use this exact parseable JSON format and do not include a formal plan in the same response:
  ## Clarification Needed
  \`\`\`json
  {
    "questions": [
      {
        "id": "q1",
        "question": "The question text",
        "options": ["Option A", "Option B"],
        "allow_custom": true
      }
    ]
  }
  \`\`\`
- Do not write the questions as Markdown bullets. Do not put id/question/options on the same Markdown list line.`
    : agentSubMode === "build"
    ? `You are in BUILD mode. Your job is to actually execute the user's request in the workspace.

## Your Role
- Complete the request by reading, creating, and editing files.
- Follow an existing plan when one is provided; otherwise execute clear direct instructions.
- Move proactively when the request is clear.
- Make reasonable decisions when details are incomplete and the risk is low.

## Workflow
1. Use list_directory and read_file to understand the current state.
2. Use edit_docx, edit_file, or create_file to implement the change.
3. Confirm what was completed and briefly explain key decisions.

## Tool Priority
1. read_file: read before writing so you understand current content.
2. edit_docx: use this for local paragraph insertions in existing .docx files.
3. edit_file: prefer editing existing text files.
4. create_file: use it when a new file is actually needed.

## Important Rules
- Do not use Base64 encoding. File content must be plain text.
- All paths must be relative to the workspace root. Do not use absolute paths, drive-letter paths, or "..".
- Do not edit existing .docx files with edit_file. Use edit_docx for local insertions in existing .docx files.
- Do not use create_file to overwrite an existing .docx. create_file is only for new files.
- For edit_docx matchText, use exact visible DOCX text, not Markdown syntax. Do not add "#" before headings. If matching a heading plus a separator, put each paragraph on its own line in matchText.
- Always read a file before editing it.
- Before generating prose or editing fiction that involves named characters, read the relevant character facts from memory, blueprints, or source text when available.
- When editing, specify exact startLine and endLine values.
- Keep responses concise, but do not artificially limit structured outputs such as blueprints.
- If the user provides a plan, follow it step by step.`
    : `You are a Chinese creative writing assistant helping a novelist.

## Your Role
- Analyze the current document and provide actionable suggestions.
- Help the user develop plots, characters, settings, blueprints, and prose.
- When rewriting, prioritize authorial voice, tone, and natural rhythm. Do not write like a manual.
- Answer in Chinese Markdown by default unless the user explicitly requests another language or format.

## Tool Usage
- Use list_directory and read_file when you need to understand the workspace.
- Do not write or edit files unless the user explicitly asks you to.
- For ordinary chat, prioritize analysis and suggestions instead of modifying files on your own.`;

  const metaInfo = meta ? `
Current file: ${meta.fileName}
Path: ${meta.filePath}
Stats: ${meta.charCount} characters, ${meta.lineCount} lines, ${meta.wordCount} words
` : "";

  const workspaceInfo = workspaceRoot 
    ? `\n\nWorkspace root directory: ${workspaceRoot}`
    : "";
  const memoryInfo = memoryContext
    ? `\n\n${memoryContext}`
    : "";
  const novaWorkflowGuidance = `\n\n## Nova Writing Workflow
- Always answer in Chinese Markdown unless the user explicitly asks otherwise.
- Use explicit, non-template preferences from Nova.md as durable user context. Ignore default Nova.md placeholder text as preference evidence. Use Importants.md as the project state when it is provided.
- Current role: ${agentMode === "editor" ? "editor" : "writer"}.
- If the frontend routes a request to PLAN mode, treat that as mandatory: do not build, write files, generate final prose, or call write tools until the user confirms the plan.
- If information is missing in PLAN mode, output only "## Clarification Needed" with the JSON questions block. Do not ask several free-form paragraphs of questions, do not use Markdown bullets for questions, and do not combine clarification with a plan.
- Writer role: use the normal writing/copilot workflow, including tools when needed.
- Editor role is handled by an isolated frontend review call. If this prompt still reaches you with editor role, focus on editing/reviewing prose and do not call tools.
- For confirmed complex writing work, follow this order: generate or update the blueprint, generate prose, then provide a Memory Candidate that can update Importants.md.
- Memory is event-driven. Nova.md is long-term user preference, Importants.md is durable novel project state, Snapshot.md is short-term project/session state, and Cache.md is volatile runtime/cache summary.
- Do not produce a Memory Candidate for critique, explanation, analysis, ordinary Q&A, or prose polishing unless the user explicitly changes the project canon.
- When a task may change memory, end with a "## Memory Candidate" section using YAML-like fields: type, project_changed, action, confidence, content.
- Example: type: important; project_changed: true; action: add_character; confidence: 0.9; content: "路易加入主线，定位为反派，当前状态存活。"
- Use type: important only for durable project changes such as adding/removing/updating characters, settings, mainline, foreshadowing, chapter completion, or creative direction.
- For character changes, use action: add_character, update_character, update_relationship, or update_character_arc, and express content with the Character Continuity schema when possible.
- Use type: nova only for durable user preference evidence with confidence >= 0.8; never write one-off project taste or temporary genre choices as Nova preferences.
- Use type: snapshot or type: cache for short-term state and runtime/cache summaries.
- When the user asks to create, save, write, generate a file, or create a chapter, you must actually call create_file in the same response. Do not only output prose and do not only say you will create it.
- Chapter prose files should default to .docx unless the user explicitly asks for .md, .txt, or another extension. Use .md for outlines, settings, notes, and summaries.
- Ordinary follow-up edits should rely on History deltas, recent changes, tool summaries, and local snippets when provided. Do not demand or assume the full chapter is available unless the user explicitly asks for full-chapter analysis, full-structure work, a blueprint, whole-chapter checking, or complete continuation reference.`;

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
- edit_docx: Insert plain-text paragraphs before or after matched text in an existing DOCX. Use this for small local changes in existing .docx files.
- create_file: Create a new file with optional initial content. For chapter prose, use a .docx path by default and pass plain text content; the tool will create a real DOCX package.`
    : "";

  const buildOnlyExamples = agentSubMode === "build"
    ? `
or
${fence}tool_call
{"name":"create_blueprint","arguments":{"name":"Three Act Blueprint","nodes":[{"id":"chapter-1","kind":"custom","layer":"structure","nodeType":"chapter","x":120,"y":120,"title":"Chapter One","summary":"Core chapter summary","typedData":{"summary":"Core chapter summary","chapterTitle":"Chapter One"}}],"edges":[]}}
${fence}
or
${fence}tool_call
{"name":"edit_file","arguments":{"path":"chapter-4.txt","edits":[{"startLine":10,"endLine":15,"newContent":"new text here"}]}}
${fence}
or
${fence}tool_call
{"name":"edit_docx","arguments":{"path":"第七章.docx","operations":[{"type":"append_after_text","matchText":"没过多久，一旁的树林间传来一阵窸窸窣窣的声音。艾莉丝举目定睛一看，胸口猛地一跳，随即绽开了笑颜。","insertText":"——\n同一日，帝国北境，红土荒原。"}]}}
${fence}
or
${fence}tool_call
{"name":"create_file","arguments":{"path":"Chapter_One_The_Cove.docx","content":"# Chapter One: The Cove\n\nChapter prose..."}}
${fence}

IMPORTANT: When writing file or blueprint content, do not use Base64 encoding. Output plain text or plain JSON. The blueprint example above is only a format example; real blueprint creation must include all nodes and edges needed by the source, not a fixed or minimal count.`
    : "";

  const toolInfo = taskType === "chat"
    ? `

You have access to these tools:
- list_directory: List workspace files and folders. Use path="" for the root.
- read_file: Read file content, max 50KB. Use workspace-relative paths only.
${enableWebSearch ? "- web_search: Search the internet. Use automatically when the Web Search Policy says external/current facts are needed.\n" : ""}- list_blueprints: List all story blueprints with compact summaries.
- read_blueprint: Read a blueprint by id or name before analyzing it.
- edit_docx: Insert plain-text paragraphs before or after matched text in an existing DOCX.${buildOnlyTools}

Path rules:
- Always use workspace-relative paths.
- Never use absolute paths, drive-letter paths, /tmp paths, or paths containing "..".
- Existing .docx files cannot be edited with edit_file. For local changes in existing DOCX files, call edit_docx. To create a new .docx file, call create_file with plain text content; the app will convert it into a real DOCX package.
- Do not use create_file to overwrite an existing .docx file. If a DOCX already exists and only needs a local insertion, use edit_docx.
- For edit_docx, match the visible DOCX text exactly. Do not include Markdown heading prefixes such as "#". For title + separator matches, use a multi-line matchText such as "第八章：灰烬与遗书\n—".
- For chapter prose creation, default to .docx when the user did not specify an extension. Respect explicit .md/.txt/.docx paths from the user.

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
    : `\n\n${selectionPrompt || ""}\nReturn only the processed body text. Do not explain the revision process.`;
  const directoryInfo = directoryTree
    ? `\n\nWorkspace directory structure:\n\`\`\`\n${directoryTree}\n\`\`\``
    : "";

  const taskSpecificInfo = taskType === "chat"
    ? "\n\nWhen relevant, use the browsing or search context that has already been retrieved from MCP tools."
    : "";

  const rewriteGuidance = taskType === "chat" || taskType === "polish" || taskType === "stylize"
    ? HUMANIZE_REWRITE_GUIDANCE
    : "";

  return `${base}${novaWorkflowGuidance}${CHARACTER_CONTINUITY_GUIDANCE}${ANTI_AI_FICTION_GUIDANCE}${rewriteGuidance}${webSearchGuidance}${blueprintGuidance}${todoWorkflowGuidance}${toolInfo}${taskSpecificInfo}${workspaceInfo}${metaInfo}${memoryInfo}${otherBoundFilesInfo}${allBoundFilesInfo}${directoryInfo}
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

function resolveTransportType(modelProfile: ModelProfile) {
  if (modelProfile.transportType && modelProfile.transportType !== "sse-http") {
    return modelProfile.transportType;
  }

  const baseUrl = modelProfile.baseUrl.trim().toLowerCase();
  const model = modelProfile.model.trim().toLowerCase();
  if (baseUrl.includes("anthropic.com") || model.startsWith("claude-")) {
    return "anthropic-messages" as const;
  }
  if (isResponsesUrl(baseUrl)) {
    return "openai-responses" as const;
  }
  if (/\/chat\/completions\/?$/i.test(baseUrl)) {
    return "openai-chat-completions" as const;
  }
  return "openai-compatible" as const;
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

function buildAnthropicHeaders(modelProfile: ModelProfile) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": modelProfile.apiKey,
    "anthropic-version": "2023-06-01",
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

function buildAnthropicSystemBlocks(systemPrompt: string) {
  const documentMarker = "\nCurrent document content:\n";
  const documentIndex = systemPrompt.indexOf(documentMarker);
  if (documentIndex === -1) {
    return [
      {
        type: "text" as const,
        text: systemPrompt,
        cache_control: { type: "ephemeral" as const },
      },
    ];
  }

  const stableText = systemPrompt.slice(0, documentIndex).trim();
  const dynamicText = systemPrompt.slice(documentIndex + 1).trim();
  return [
    stableText
      ? {
          type: "text" as const,
          text: stableText,
          cache_control: { type: "ephemeral" as const },
        }
      : null,
    dynamicText
      ? {
          type: "text" as const,
          text: dynamicText,
        }
      : null,
  ].filter(Boolean);
}

function buildAnthropicMessages(userMessage: string, conversationHistory: ConversationMessage[]) {
  return [
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: [{ type: "text" as const, text: msg.content }],
    })),
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: userMessage }],
    },
  ];
}

async function callResponsesApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, conversationHistory } = options;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      instructions: systemPrompt,
      input: buildOpenAIResponsesInput(finalUserMessage, conversationHistory),
      ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
      temperature: options.temperature ?? 0.7,
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

async function callAnthropicMessagesApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, conversationHistory } = options;
  const endpoint = !modelProfile.baseUrl || /api\.openai\.com/i.test(modelProfile.baseUrl)
    ? "https://api.anthropic.com/v1/messages"
    : modelProfile.baseUrl;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildAnthropicHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      system: buildAnthropicSystemBlocks(systemPrompt),
      messages: buildAnthropicMessages(finalUserMessage, conversationHistory),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.7,
    }),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    if (response.status === 400 && /cache_control|anthropic-version|x-api-key|system|messages/i.test(message)) {
      throw new Error(`${message} If this endpoint is an OpenAI-compatible Anthropic proxy, switch the model profile API Format to OpenAI Compatible.`);
    }
    throw new Error(message);
  }

  const data = await response.json();
  const outputText = Array.isArray(data.content)
    ? data.content
        .map((item: any) => (item?.type === "text" && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("")
    : "";

  if (!outputText.trim()) {
    throw new Error("AI response did not include any Anthropic text output.");
  }

  return outputText.trim();
}

async function callChatCompletionsApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, conversationHistory } = options;
  const tokenLimitKey = isMimoModel(modelProfile.model) ? "max_completion_tokens" : "max_tokens";

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: buildRequestHeaders(modelProfile),
    body: JSON.stringify({
      model: modelProfile.model,
      messages: buildChatCompletionMessages(systemPrompt, finalUserMessage, conversationHistory),
      ...(options.maxTokens ? { [tokenLimitKey]: options.maxTokens } : {}),
      temperature: options.temperature ?? 0.7,
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
  const { taskType, userMessage, selectionPrompt, attachments = [], modelProfile, multiFileContext, contextMaxLength = 5000, skills, workspaceRoot, directoryTree, memoryContext } = options;

  const documentContext = buildDocumentContext(options.documentContext, contextMaxLength);

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
    skills?.agentSubMode,
    skills?.agentMode,
    memoryContext
  );
  const finalUserMessage = getFinalUserMessage(userMessage, mcpContext, attachments);

  const transportType = resolveTransportType(modelProfile);
  if (transportType === "anthropic-messages") {
    return callAnthropicMessagesApi(options, systemPrompt, finalUserMessage);
  }
  if (transportType === "openai-responses") {
    return callResponsesApi(options, systemPrompt, finalUserMessage);
  }

  return callChatCompletionsApi(options, systemPrompt, finalUserMessage);
}

export async function callAI(options: AiRequestOptions): Promise<string> {
  // Automatic search is handled outside this service; call the AI directly here.
  return callOpenAiCompatible(options);
}

function stripEditorWrapper(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```$/);
  return (fenced?.[1] ?? trimmed).trim();
}

export async function reviewEditFileContent(options: EditFileReviewOptions): Promise<string> {
  const proposed = options.proposedContent;
  if (!proposed.trim()) return proposed;

  const systemPrompt = `You are Nova's pre-write fiction editor for edit_file.

Your task is to audit and lightly process AI-written replacement text before it is written into a novel file.

Rules:
- Return only the final replacement text. No explanation, labels, Markdown wrappers, or code fences.
- Preserve meaning, plot facts, speaker intent, character motivation, names, chronology, and information density.
- Preserve character continuity: age, identity, appearance, core belief, desire, fear, relationships, voice, behavior under danger, behavior under pressure, behavior in conflict, and current arc.
- Do not add new settings, plot events, emotions, backstory, or lore.
- Use the provided reference/config database for character facts when available.
- Do not audit worldbuilding correctness. Do not rewrite just because magic systems, history, factions, geography, technology, or lore seem unusual.
- If character facts are not present in the reference/config database or original text, do not invent them; only perform general prose naturalness review.
- Do not add undocumented trauma, romance, family ties, age facts, gender facts, identity changes, relationship changes, or psychological breakthroughs.
- If a character suddenly becomes too gentle, cruel, clever, foolish, sentimental, preachy, forgiving, hostile, mature, broken, or otherwise unlike the established context, revise the text back toward the existing character facts.
- Psychological movement must have a visible trigger, transition, and behavioral evidence. Compress unsupported emotional explanation instead of inventing it.
- If the proposed text is already restrained and natural, return it almost unchanged.
- Remove or compress empty expansion: extra words without new information.
- Avoid five-sense stacking, surveillance-camera action breakdowns, repeated gestures, direct emotion labels, synonym piling, excessive internal analysis, explanatory dialogue, over-explaining, repeated summaries, ornamental metaphors, slogan-like parallelism, and narrative em-dash overuse.
- Prefer concrete action, dialogue, reaction, and scene-relevant detail over abstract explanation.
- Keep rhythm natural. A little imperfection is better than over-polished AI prose.${ANTI_AI_FICTION_GUIDANCE}`;

  const userMessage = `File path: ${options.filePath}

Reference/config database:
<<<REFERENCE
${options.referenceContext?.trim() || "(none provided)"}
REFERENCE

Original text being replaced:
<<<ORIGINAL
${options.originalContent}
ORIGINAL

Proposed replacement text:
<<<PROPOSED
${proposed}
PROPOSED

Return only the revised replacement text.`;

  const request: AiRequestOptions = {
    modelProfile: options.modelProfile,
    taskType: "chat",
    userMessage,
    documentContext: "",
    maxTokens: options.maxTokens,
    conversationHistory: [],
    temperature: 0.3,
  };

  const transportType = resolveTransportType(options.modelProfile);
  const result = transportType === "anthropic-messages"
    ? await callAnthropicMessagesApi(request, systemPrompt, userMessage)
    : transportType === "openai-responses"
      ? await callResponsesApi(request, systemPrompt, userMessage)
      : await callChatCompletionsApi(request, systemPrompt, userMessage);

  const reviewed = stripEditorWrapper(result);
  return reviewed || proposed;
}

export async function callEditorRoleReview(options: EditorRoleReviewOptions): Promise<string> {
  const target = options.targetContent.trim();
  const instruction = options.userInstruction.trim();
  if (!instruction && !target) return "";

  const systemPrompt = `You are Nova's isolated editor role.

Your task is to review and revise fiction text according to the user's instruction.

Rules:
- Answer in Chinese unless the user explicitly asks otherwise.
- Return the edited/reviewed result directly. Keep explanations brief only when the user asks for review rather than rewrite.
- Use only the target text, user instruction, file name, and reference/config database provided in this request.
- Do not use or assume chat history, tool results, working set, directory tree, or prior plan context.
- Focus on prose reasonableness, character continuity/OOC, reducing AI-like writing, action/psychology/dialogue naturalness, rhythm, and clarity.
- Do not audit worldbuilding correctness. Do not rewrite because lore, magic systems, factions, geography, technology, or history seem unusual.
- If character facts are missing, do not invent age, gender, identity, relationships, backstory, trauma, romance, or personality facts.
- Preserve plot facts, names, chronology, point of view, information density, and character motivation unless the user explicitly asks to change them.
- Prefer concrete action, dialogue, reaction, and scene-relevant detail over abstract explanation.${ANTI_AI_FICTION_GUIDANCE}`;

  const userMessage = `User instruction:
<<<INSTRUCTION
${instruction || "请以编辑身份审核并处理下面文本。"}
INSTRUCTION

File path: ${options.filePath || "(current document)"}

Reference/config database:
<<<REFERENCE
${options.referenceContext?.trim() || "(none provided)"}
REFERENCE

Target text:
<<<TEXT
${target || "(no active document text provided)"}
TEXT`;

  const request: AiRequestOptions = {
    modelProfile: options.modelProfile,
    taskType: "chat",
    userMessage,
    documentContext: "",
    maxTokens: options.maxTokens,
    conversationHistory: [],
    temperature: 0.3,
  };

  const transportType = resolveTransportType(options.modelProfile);
  const result = transportType === "anthropic-messages"
    ? await callAnthropicMessagesApi(request, systemPrompt, userMessage)
    : transportType === "openai-responses"
      ? await callResponsesApi(request, systemPrompt, userMessage)
      : await callChatCompletionsApi(request, systemPrompt, userMessage);

  return stripEditorWrapper(result);
}
