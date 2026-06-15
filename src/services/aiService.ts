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

const CHARACTER_FIRST_GUIDANCE = `\n\n## Character First
- Characters are more important than plot efficiency.
- Characters may make wrong decisions, misunderstand others, avoid questions, fail to communicate, and keep false beliefs for a long time.
- Characters do not need to cooperate with the plot, immediately grow, explain themselves, or solve every conflict.
- Scenes may end without a clear gain, a solved conflict, or an obvious relationship improvement.
- Foreshadowing may stay unresolved for a long time.
- Build scene plans from character goal and conflict first, then plot outcome.`;

const ANTI_AI_FICTION_GUIDANCE = `\n\n## Anti AI Writing
- Do not force every paragraph to advance the plot.
- Important information may be delayed, withheld, or partially understood.
- Characters can misjudge, miss details, contradict themselves, or understand events incorrectly.
- Do not immediately explain abnormal phenomena.
- Present scenes through the character's senses and attention, not authorial exposition.
- Allow non-functional details when they make the moment feel lived-in.
- Dialogue should first express emotion, pressure, stance, avoidance, or desire; it should not primarily deliver setting information.
- Even when a character knows the answer, they do not have to say it immediately.
- Reveal information more slowly than your first instinct.
- Do not make every line of dialogue informative.
- Do not make every scene meaningful, every memory produce growth, every interaction improve a relationship, or every chapter ending elevate the theme.
- Avoid forced aphorisms, slogan-like lines, and polished closing morals.`;

const NARRATIVE_VARIANCE_GUIDANCE = `\n\n## Narrative Variance
- AuthorTemplate and ProseStyle define tendencies, not templates. Do not reuse the same scene structure, sentence rhythm, emotional arc, or symbolic move just because it matches the profile.
- Avoid repeated sentence patterns. Vary sentence length, openings, rhythm, subject order, punctuation, dialogue beats, and paragraph shape so the prose has real syntactic variety.
- Let characters produce friction, digressions, small talk, half-answers, irrelevant observations, and non-optimal reactions when their current desire, fear, emotion, or bias would push them there.
- Include occasional lived-in details that do not explain lore, solve plot, foreshadow, or prove theme.
- Do not make every character serve plot efficiency. A character may protect ego, save face, misunderstand, delay, refuse, ramble, or notice the wrong thing.`;

const NARRATIVE_MECHANICS_WRITER_V2_GUIDANCE = `\n\n## NarrativeMechanics Writer V2
Pipeline roles:
- Blueprints: source of truth for story order, actual timeline, scene beats, and payoff/fulfillment state.
- StoryDatabase: static facts for people, geography, factions, items, ownership lore, effects, and manifestations.
- RealtimeDatabase: changing facts such as current holders, locations, faction status, and time-node state.
- AuthorTemplate, ProseStyle, and DescriptionStats: prose taste, author intent, description habits, and rhetoric statistics.
- Writer: generate localized prose as momentary lived experience.

Writer boundaries:
- Do not summarize events or chapters inside prose.
- Do not explain narrative meaning, story structure, or theme.
- Do not explain character psychology directly.
- Do not produce recap, labels, balanced scene diagrams, or explanatory afterword inside generated prose.
- If planning or data extraction is needed, keep it outside the prose.

When writing prose:
- Write momentary lived experience, not story summary.
- Use observation mode: movement, sound, texture, light, interruption, silence, and physical action.
- No Explanation: replace abstract feeling labels with action, sensory detail, silence, or interruption.
- Attention Drift: every 5-12 lines, let attention shift naturally without explaining the shift.
- Information Imbalance: do not distribute information evenly.
- No Full Resolution: do not rush to resolve emotional tension, mysteries, unusual phenomena, or relationship conflict.
- Burstiness: vary sentence length and paragraph shape.
- Use AuthorTemplate/ProseStyle/DescriptionStats as constraints, not copyable templates.`;

const LIGHTWEIGHT_STATE_WORKFLOW_GUIDANCE = `\n\n## Lightweight Project Data Workflow
- Default long-term project data is only: AuthorTemplate, ProseStyle, DescriptionStats, StoryDatabase, RealtimeDatabase, and blueprints.
- Do not ask for, read, write, or rely on old project memory files.
- Blueprints are mandatory for story planning and writing. Use or update blueprint state before prose when the task changes plot, timeline, scene beats, or payoff state.
- AuthorTemplate records philosophy, theology, desire, why the author writes this novel, and the novel core. These must come from user confirmation; if missing, ask with the supported clarification-card JSON.
- ProseStyle records prose rhythm, POV, sentence habits, dialogue habits, and avoided patterns.
- DescriptionStats records scene/time/person description tendencies and usage counts such as uses/appearances.
- StoryDatabase records static people, geography, factions, items, effects, manifestations, owners, and backstory.
- RealtimeDatabase records changing story state, such as item holders at different time nodes.

Writing sequence:
1. Prompt: understand the user request.
2. Blueprint: read/create/update story nodes and payoff status.
3. Prose: draft the final prose from the blueprint and project data.

Rules:
- Final chapter/document content must contain Prose only.
- For extraction or project data updates, cite file + startLine + endLine + brief evidence, or use source: user_confirmed.
- If any required data is missing, ask with the clarification-card JSON instead of inventing facts.`;

const CHARACTER_CONTINUITY_GUIDANCE = `\n\n## Character Continuity And OOC Guard
Use StoryDatabase as the durable source of static character facts and RealtimeDatabase as the source of changing character state.

Character data should include, when known:
- basic: name, age, identity
- appearance: hair, eyes, notable body/visual markers
- personality: surface, core_belief, desire, fear
- current_state: current_desire, current_fear, current_emotion, current_bias, known_information, location
- history: important events
- behavior: danger, pressure, conflict
- relationships
- arc

Rules:
- When a task involves a character, first rely on StoryDatabase, RealtimeDatabase, reference/config database entries, blueprint character nodes, current document content, and files you have read.
- Character reference/config entries are editing aids; StoryDatabase and RealtimeDatabase are the long-term project data sources.
- Do not change a character's name, age, identity, appearance, core belief, desire, fear, relationships, behavior pattern, or arc unless the user explicitly asks for a canon change.
- Do not change current desire, current fear, current emotion, current bias, known information, or location unless the user explicitly asks for a state change or the scene provides a visible trigger.
- Psychological change must have a visible trigger, emotional transition, and behavioral evidence.
- If character facts are missing and the task depends on them, output exactly a "## Clarification Needed" section with the supported JSON questions format instead of inventing facts.
- When the user explicitly changes character canon, provide Memory Candidate entries for story_database or realtime_database, or update a blueprint when the change belongs to timeline/fulfillment.`;

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
- For chapter or scene generation, plan in this order: Plan (why this chapter/scene exists), Blueprint (what happens), then Prose (how it is written). Characters drive the scene; plot outcome follows.
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
- Do not write the questions as Markdown bullets. Do not put id/question/options on the same Markdown list line.
- When asking clarification questions, output only the heading and the JSON block above. Do not add prose before or after it.`
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
2. edit_docx: use this for paragraph insertions, append_to_end, replacements, deletions, or between-boundary replacements in existing .docx files.
3. edit_file: prefer editing existing text files.
4. create_file: use it when a new file is actually needed.

## Important Rules
- Do not use Base64 encoding. File content must be plain text.
- All paths must be relative to the workspace root. Do not use absolute paths, drive-letter paths, or "..".
- Do not edit existing .docx files with edit_file. Use edit_docx for local insertions, replacements, and deletions in existing .docx files.
- Do not use create_file to overwrite an existing .docx. create_file is only for new files.
- For edit_docx matchText/startText/endText, use exact visible DOCX text, not Markdown syntax. Do not add "#" before headings. If matching a heading plus a separator, put each paragraph on its own line in matchText. When the same delimiter appears many times, use matchOccurrence/startOccurrence/endOccurrence.
- Always read a file before editing it.
- Before generating prose or editing fiction that involves named characters, read the relevant character facts from memory, blueprints, or source text when available.
- For long chapter drafting, work scene by scene. Establish Plan and Blueprint before drafting Prose; final written files should contain Prose only.
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
- Use list_directory, search_file, and line-bounded read_file when you need to understand the workspace.
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
- Current role: writer, editor, or architect according to the frontend mode.
- The only long-term project data sources are AuthorTemplate, ProseStyle, DescriptionStats, StoryDatabase, RealtimeDatabase, and blueprints.
- Do not ask for, read, write, mention, or rely on old project memory files.
- Blueprints are the source of truth for story timeline, actual event order, scene structure, and payoff/fulfillment status.
- Before plot-changing writing, create/read/update a blueprint. For prose-only polishing, use the current text and project data.
- AuthorTemplate stores philosophy, theology, desire, why the author writes this novel, and the novel core. If any of these are needed and missing, ask the user with clarification-card JSON instead of inventing them.
- In any mode, if essential information is missing, output exactly "## Clarification Needed" with the supported JSON object. Do not combine the questions with a plan or prose.
- Writing workflow is Prompt -> Blueprint -> Prose. File content for chapters must contain Prose only.
- Memory Candidate entries may only use these project types: author_template, prose_style, description_stats, story_database, realtime_database, blueprint, or nova.
- Use source: user_confirmed for direct user confirmations; otherwise include file/startLine/endLine evidence in source or content.
- Use type: author_template for confirmed author philosophy/theology/desire/novel core.
- Use type: prose_style for prose rhythm, syntax, POV, dialogue, and avoided patterns.
- Use type: description_stats for scene/time/person description habits and usage-count observations.
- Use type: story_database for static people, geography, factions, items, effects, manifestations, owners, and backstory.
- Use type: realtime_database for changing state such as current holders, locations, relationship state, faction state, and time-node state.
- Use type: blueprint only to request a blueprint tool update; do not write blueprint changes as markdown memory.
- Do not produce a Memory Candidate for critique, explanation, analysis, ordinary Q&A, or prose polishing unless durable project data actually changed.
- When the user asks to create, save, write, generate a file, or create a chapter, you must actually call create_file in the same response when tools are available.
- Chapter prose files should default to .docx unless the user explicitly asks for .md, .txt, or another extension. Use .md for outlines, settings, notes, and summaries.
- Reference lists are editing/import helpers for static database entries, not an independent long-term memory system.`;
  const mandatoryWorkChecklist = taskType === "chat"
    ? `\n\n## Mandatory Work Checklist
Before every non-trivial project response, silently run this checklist:
1. Project data audit: use AuthorTemplate, ProseStyle, DescriptionStats, StoryDatabase, RealtimeDatabase, and relevant blueprints.
2. Blueprint audit: if the task changes plot, timeline, scene beats, or payoff state, read or update the blueprint before prose.
3. Clarification audit: if author core, canon facts, current state, or payoff status are missing, ask with the supported clarification-card JSON.
4. Action audit: if you say you will create, update, search, inspect, read, or record something, include the matching tool_call when tools are available.
5. Data audit after work: if durable project data changed, output Memory Candidate entries using only the new project data types.`
    : "";
  const memoryUpgradeProtocol = "";
  const lightweightMemoryUpgradeProtocol = "";
  const architectGuidance = agentMode === "architect"
    ? `\n\n## Architect Mode
- Your job is novel architecture diagnosis and reconstruction, not ordinary drafting.
- AuthorTemplate first: clarify philosophy, theology, desire, why this novel exists, and the novel core.
- If unclear, ask with the supported clarification-card JSON. Do not combine questions with a plan.
- Use blueprints for timeline/structure/payoff state, StoryDatabase for static canon, RealtimeDatabase for changing state, ProseStyle for writing mechanics, and DescriptionStats for description habits.
- Do not draft chapter prose or modify files unless the user explicitly asks after the architecture plan is confirmed.
- Memory Candidate Routing: author_template, prose_style, description_stats, story_database, realtime_database, or blueprint only.`
    : "";
  const writerLayerGuidance = agentMode === "writer" || !agentMode
    ? LIGHTWEIGHT_STATE_WORKFLOW_GUIDANCE
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

  const blueprintGuidance = `\n\n## Blueprint Guide
Blueprints are story-structure graphs and the source of truth for timeline, actual event order, scene structure, and payoff/fulfillment status. A BlueprintDocument has { id, name, updatedAt, nodes, edges, viewport }.
- nodes are story elements. Common fields: id, kind, layer, nodeType, x, y, title, summary, linkedChapters, typedData, customFields.
- storyEvents may include time, content, foreshadowing, and fulfilled. fulfilled marks whether a story promise/worldline/payoff has been realized.
- edges connect nodes with from/to ids and optional role. Use edges for narrative flow, structure flow, reveal/logic links, branch/merge paths.
- chapter nodes use nodeType="chapter" and typedData.summary / typedData.chapterTitle. linkedChapters binds a node to workspace file names or heading titles.
- typedData.mountLinks on a chapter node mounts child blueprints under that chapter.
- Use list_blueprints and read_blueprint before analyzing existing blueprints.
- Before creating or updating blueprints, call list_blueprint_templates and use the user's existing node templates. Prefer templateId or exact templateName on every node; do not invent a custom schema when a template fits.
- In Build mode, use create_blueprint to generate a new blueprint. Place nodes on a readable grid, give every node a clear title and summary, and create edges that tell the story structure.
- Only use kind="custom" when none of the listed templates match the intended node. If a template exists for story/character/timeline/database/payoff work, use that template.
- Never cap a generated blueprint to a fixed number of nodes. Use as many content-derived nodes as the source needs.
- For new chapter writing, create/update blueprint nodes that cover chapter purpose, key scenes, character interactions, conflict, emotional movement, static database changes, realtime state changes, and payoff/fulfillment changes.`;

  const todoWorkflowGuidance = taskType === "chat"
    ? `\n\n## TODO Workflow\n- For multi-step requests, make a compact TODO plan before acting. For example: locate file, read content, analyze beats, list blueprint templates, create blueprint, summarize result.\n- If a TODO step needs a tool, output the tool_call block in the same response. Do not stop after saying you will use a tool.\n- After each Tool Results message, continue the TODO workflow: either call the next needed tool or provide the final answer.\n- For requests like "read chapter one and create a blueprint", use this sequence unless the needed content is already in context: list_directory when the path is unknown, read_file for the chapter, list_blueprint_templates, create_blueprint with all needed template-backed nodes and edges, then summarize.\n- You may show a short visible TODO list before tool_call blocks, but the tool_call blocks must still be present when tools are needed.`
    : "";

  const buildOnlyTools = agentSubMode === "build"
    ? `
- create_blueprint: Create or replace a blueprint from nodes and edges. Use templateId/templateName from list_blueprint_templates on nodes whenever possible.
- upsert_reference_entries: Create or update structured reference database entries. Use listName "人物" for character sheets and include current_desire/current_fear/current_emotion/current_bias in the body.
- edit_file: Edit a file with line-level precision. Provide path and edits array with startLine, endLine, and newContent.
- edit_docx: Insert, append, replace, or delete plain-text paragraphs in an existing DOCX. Use append_to_end for empty DOCX files or simple end appends. Use replace_text/delete_text/replace_between_text/delete_between_text for direct replacements and removals; do not insert deletion markers for the user to clean up.
- create_file: Create a new file with optional initial content. For chapter prose, use a .docx path by default and pass plain text content; the tool will create a real DOCX package.`
    : "";

  const buildOnlyExamples = agentSubMode === "build"
    ? `
or
${fence}tool_call
{"name":"list_blueprint_templates","arguments":{}}
${fence}
then
${fence}tool_call
{"name":"create_blueprint","arguments":{"name":"Three Act Blueprint","nodes":[{"id":"event-1","templateName":"Use the exact template name returned by list_blueprint_templates","x":120,"y":120,"title":"Chapter One promise","summary":"Core chapter summary","storyEvents":[{"id":"event-1-a","time":"story time","content":"promised event","foreshadowing":"setup clue","fulfilled":false}]}],"edges":[]}}
${fence}
or
${fence}tool_call
{"name":"upsert_reference_entries","arguments":{"listName":"人物","items":[{"key":"主角名","value":"一句话人物定位","body":"# 主角名\n\n## core\n身份/背景摘要。\n\n## current_state\ncurrent_desire: 当前最想得到或避免的东西\ncurrent_fear: 当前最害怕发生的事\ncurrent_emotion: 当前主导情绪\ncurrent_bias: 当前偏见、误判或固执看法\n\n## voice\n说话习惯与行动倾向。"}]}}
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
{"name":"edit_docx","arguments":{"path":"第八章.docx","operations":[{"type":"replace_between_text","startText":"——","startOccurrence":3,"endText":"——","endOccurrence":4,"replaceText":"新的第三段场景内容。"}]}}
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
- search_file: Search inside one file and return matching line numbers plus context. Prefer this before broad reads.
- read_file: Read numbered file lines, max 5000 characters per call. Use startLine/endLine whenever possible. At most 2 read_file calls are allowed per turn.
${enableWebSearch ? "- web_search: Search the internet. Use automatically when the Web Search Policy says external/current facts are needed.\n" : ""}- list_blueprints: List all story blueprints with compact summaries.
- read_blueprint: Read a blueprint by id or name before analyzing it.
- list_blueprint_templates: List reusable blueprint node templates. Call before create_blueprint and prefer these templates over custom nodes.
- upsert_reference_entries: In Build mode, create or update structured reference database entries. Use listName "人物" for generated character sheets.
- edit_docx: Insert, append, replace, or delete plain-text paragraphs in an existing DOCX.${buildOnlyTools}

Path rules:
- Always use workspace-relative paths.
- Never use absolute paths, drive-letter paths, /tmp paths, or paths containing "..".
- Existing .docx files cannot be edited with edit_file. For local insertions, replacements, or deletions in existing DOCX files, call edit_docx. To create a new .docx file, call create_file with plain text content; the app will convert it into a real DOCX package.
- Do not use create_file to overwrite an existing .docx file. If a DOCX already exists and only needs a local insertion, use edit_docx.
- For edit_docx append_after_text/insert_before_text, match the visible DOCX text exactly. Do not include Markdown heading prefixes such as "#". For title + separator matches, use a multi-line matchText such as "第八章：灰烬与遗书\n—". For an empty DOCX or simple end append, use {"type":"append_to_end","insertText":"..."} without matchText.
- edit_docx also supports direct replacement and deletion: replace_text, delete_text, replace_between_text, delete_between_text. For repeated delimiters, use matchOccurrence/startOccurrence/endOccurrence. For replacing the content between the 3rd and 4th separator, use {"type":"replace_between_text","startText":"——","startOccurrence":3,"endText":"——","endOccurrence":4,"replaceText":"..."}; boundaries are kept unless includeBoundaries is true. Do not insert manual deletion markers when a replace/delete operation can do the edit directly.
- For chapter prose creation, default to .docx when the user did not specify an extension. Respect explicit .md/.txt/.docx paths from the user.
- For generated character sheets, call upsert_reference_entries with listName "人物" and include current_desire/current_fear/current_emotion/current_bias in body; also create a .md file unless the user explicitly says not to.

Tool call format: when you need tools, respond with one or more fenced blocks whose info string is tool_call and whose body is JSON. Do not merely describe that you will use a tool. If you say you will inspect, read, search, list, or create something, include the matching tool_call block in the same response.
Examples:
${fence}tool_call
{"name":"list_directory","arguments":{"path":"","recursive":true}}
${fence}
or
${fence}tool_call
{"name":"search_file","arguments":{"path":"chapter-4.txt","query":"blue necklace","contextLines":2}}
${fence}
or
${fence}tool_call
{"name":"read_file","arguments":{"path":"chapter-4.txt","startLine":120,"endLine":180,"maxChars":5000}}
${fence}
${enableWebSearch ? `or\n${fence}tool_call\n{"name":"web_search","arguments":{"query":"search terms"}}\n${fence}\n` : ""}or
${fence}tool_call
{"name":"list_blueprints","arguments":{}}
${fence}
or
${fence}tool_call
{"name":"read_blueprint","arguments":{"name":"Main Story Structure"}}
${fence}
or
${fence}tool_call
{"name":"list_blueprint_templates","arguments":{}}
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

  return `${base}${novaWorkflowGuidance}${mandatoryWorkChecklist}${memoryUpgradeProtocol}${lightweightMemoryUpgradeProtocol}${architectGuidance}${writerLayerGuidance}${CHARACTER_CONTINUITY_GUIDANCE}${CHARACTER_FIRST_GUIDANCE}${ANTI_AI_FICTION_GUIDANCE}${NARRATIVE_VARIANCE_GUIDANCE}${rewriteGuidance}${webSearchGuidance}${blueprintGuidance}${todoWorkflowGuidance}${toolInfo}${taskSpecificInfo}${workspaceInfo}${metaInfo}${memoryInfo}${otherBoundFilesInfo}${allBoundFilesInfo}${directoryInfo}
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
- Preserve character continuity: age, identity, appearance, core belief, desire, fear, current desire, current fear, current emotion, current bias, relationships, voice, behavior under danger, behavior under pressure, behavior in conflict, and current arc.
- Do not add new settings, plot events, emotions, backstory, or lore.
- Use the provided reference/config database for character facts when available.
- If current_desire/current_fear/current_emotion/current_bias are provided, check whether the proposed text actually reflects them in attention, avoidance, speech, silence, misunderstanding, and action.
- Do not audit worldbuilding correctness. Do not rewrite just because magic systems, history, factions, geography, technology, or lore seem unusual.
- If character facts are not present in the reference/config database or original text, do not invent them; only perform general prose naturalness review.
- Do not add undocumented trauma, romance, family ties, age facts, gender facts, identity changes, relationship changes, or psychological breakthroughs.
- If a character suddenly becomes too gentle, cruel, clever, foolish, sentimental, preachy, forgiving, hostile, mature, broken, or otherwise unlike the established context, revise the text back toward the existing character facts.
- Psychological movement must have a visible trigger, transition, and behavioral evidence. Compress unsupported emotional explanation instead of inventing it.
- If the proposed text is already restrained and natural, return it almost unchanged.
- Remove or compress empty expansion: extra words without new information.
- Avoid five-sense stacking, surveillance-camera action breakdowns, repeated gestures, direct emotion labels, synonym piling, excessive internal analysis, explanatory dialogue, over-explaining, repeated summaries, ornamental metaphors, slogan-like parallelism, and narrative em-dash overuse.
- Prefer concrete action, dialogue, reaction, and scene-relevant detail over abstract explanation.
- Check structural AI smell: characters becoming too cooperative, dialogue carrying too much information, emotions changing too smoothly, conflicts resolving too quickly, and every scene feeling overly purposeful.
- Check NarrativeMechanics Writer V2 smell: recap-like summary, direct psychological explanation, evenly distributed information, symmetrical paragraph structure, missing attention drift, stated theme, fully resolved tension, and prose that feels constructed rather than observed.
- Prefer fixes that delete explanation, break symmetry, add localized sensory interruption, preserve unanswered pressure, and make attention drift naturally. Do not make the text smoother just to sound polished.
- Prefer fixing scene structure and character behavior over merely polishing sentences.
- Keep rhythm natural. A little imperfection is better than over-polished AI prose.${NARRATIVE_MECHANICS_WRITER_V2_GUIDANCE}${CHARACTER_FIRST_GUIDANCE}${ANTI_AI_FICTION_GUIDANCE}`;

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
- If reference entries include current_desire/current_fear/current_emotion/current_bias, use them as active scene constraints and flag or revise text that ignores them.
- Prefer concrete action, dialogue, reaction, and scene-relevant detail over abstract explanation.
- Check whether characters are too smart, too cooperative, too quick to explain, or too quick to resolve conflict.
- Check whether the prose is too summary-like, too explanatory, too evenly paced, too symmetrical, too thematically explicit, or missing attention drift.
- Prefer structural notes or targeted rewrites that remove explanation, lower structure-feel, vary density, and preserve unresolved pressure over generic sentence polishing.${NARRATIVE_MECHANICS_WRITER_V2_GUIDANCE}${CHARACTER_FIRST_GUIDANCE}${ANTI_AI_FICTION_GUIDANCE}`;

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
