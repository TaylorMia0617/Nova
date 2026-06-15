import {
  ensureWorkspaceHabits,
  readGlobalHabits,
  readProjectAuthorTemplate,
  readProjectDescriptionStats,
  readProjectProseStyle,
  readProjectRealtimeDatabase,
  readProjectStoryDatabase,
  writeGlobalHabits,
  writeProjectAuthorTemplate,
  writeProjectDescriptionStats,
  writeProjectProseStyle,
  writeProjectRealtimeDatabase,
  writeProjectStoryDatabase,
} from "./fileSystemService";

export interface MemoryContext {
  globalHabits: string;
  authorTemplate: string;
  proseStyle: string;
  descriptionStats: string;
  storyDatabase: string;
  realtimeDatabase: string;
  includedLightweightState: boolean;
}

interface LoadMemoryOptions {
  includeStableProjectMemory?: boolean;
  includeAuthorProjectMemory?: boolean;
  includeShortTermMemory?: boolean;
  includeCacheMemory?: boolean;
  includeProjectImportant?: boolean;
  includeProjectSnapshot?: boolean;
}

export type MemoryCandidateType =
  | "nova"
  | "author_template"
  | "prose_style"
  | "description_stats"
  | "story_database"
  | "realtime_database"
  | "blueprint";

export interface ParsedMemoryCandidate {
  type: MemoryCandidateType;
  projectChanged: boolean;
  action: string;
  confidence: number;
  evidenceCount: number;
  source: string;
  content: string;
  raw: string;
}

export interface MemoryApplyOptions {
  hasSuccessfulCreateFile?: boolean;
  isConfirmedPlanExecution?: boolean;
}

export interface MemoryApplyResult {
  applied: boolean;
  target: MemoryCandidateType | "none";
  reason: string;
}

const MEMORY_CANDIDATE_HEADING = /(?:^|\n)#{1,3}\s*Memory Candidate\s*\n/i;
const NEXT_HEADING = /\n#{1,3}\s+\S/g;
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/;
const NOVA_EVIDENCE_KEY = "nova.preferenceEvidence.v1";
const NOVA_CONFIDENCE_THRESHOLD = 0.8;
const NOVA_EVIDENCE_THRESHOLD = 5;
const EMPTY_GLOBAL_HABITS = "(No confirmed global user preferences yet. Ignore the default Nova.md template as user preference evidence.)";

const SUPPORTED_TYPES: MemoryCandidateType[] = [
  "nova",
  "author_template",
  "prose_style",
  "description_stats",
  "story_database",
  "realtime_database",
  "blueprint",
];

const PROJECT_TYPES = new Set<MemoryCandidateType>([
  "author_template",
  "prose_style",
  "description_stats",
  "story_database",
  "realtime_database",
]);

const NON_PROJECT_ACTIONS = new Set([
  "review",
  "critique",
  "polish",
  "rewrite",
  "explain",
  "analyze",
  "evaluate",
  "answer_question",
]);

const smartTruncate = (content: string, maxLength: number) =>
  content.length <= maxLength ? content : `${content.slice(0, maxLength)}\n\n...[truncated]...`;

function isTemplateGlobalHabits(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return true;
  return /template:\s*true/i.test(normalized) && /confirmed_by_user:\s*false/i.test(normalized);
}

function globalHabitsForPrompt(content: string): string {
  return isTemplateGlobalHabits(content) ? EMPTY_GLOBAL_HABITS : content;
}

function markGlobalHabitsConfirmed(content: string): string {
  if (/^---\s*[\s\S]*?\s*---/.test(content)) {
    return content
      .replace(/template:\s*true/i, "template: false")
      .replace(/confirmed_by_user:\s*false/i, "confirmed_by_user: true");
  }
  return content;
}

export async function ensureMemoryFiles(): Promise<void> {
  await Promise.all([readGlobalHabits(), ensureWorkspaceHabits()]);
}

export async function loadMemoryContext(options: LoadMemoryOptions = {}): Promise<MemoryContext> {
  const includeProjectMemory = options.includeStableProjectMemory ?? options.includeProjectImportant ?? true;
  const [
    globalHabits,
    authorTemplate,
    proseStyle,
    descriptionStats,
    storyDatabase,
    realtimeDatabase,
  ] = await Promise.all([
    readGlobalHabits(),
    includeProjectMemory ? ensureWorkspaceHabits().then(() => readProjectAuthorTemplate()) : Promise.resolve(""),
    includeProjectMemory ? ensureWorkspaceHabits().then(() => readProjectProseStyle()) : Promise.resolve(""),
    includeProjectMemory ? ensureWorkspaceHabits().then(() => readProjectDescriptionStats()) : Promise.resolve(""),
    includeProjectMemory ? ensureWorkspaceHabits().then(() => readProjectStoryDatabase()) : Promise.resolve(""),
    includeProjectMemory ? ensureWorkspaceHabits().then(() => readProjectRealtimeDatabase()) : Promise.resolve(""),
  ]);

  return {
    globalHabits: globalHabits ?? "",
    authorTemplate: authorTemplate ?? "",
    proseStyle: proseStyle ?? "",
    descriptionStats: descriptionStats ?? "",
    storyDatabase: storyDatabase ?? "",
    realtimeDatabase: realtimeDatabase ?? "",
    includedLightweightState: includeProjectMemory,
  };
}

export function buildMemoryPrompt(context: MemoryContext): string {
  const sections = [
    "## Nova Lightweight Project Data",
    "Default long-term project data is limited to AuthorTemplate, ProseStyle, DescriptionStats, StoryDatabase, RealtimeDatabase, and blueprints.",
    "Do not ask for, read, write, or rely on old project memory files. Blueprints are the source of truth for timeline, story order, and payoff/fulfillment state.",
    "If AuthorTemplate lacks philosophy, theology, desire, why the novel exists, or the novel core, ask the user with the supported clarification-card JSON before treating any guess as canon.",
    "When information is insufficient in ordinary chat, writing, editing, blueprint work, or database cleanup, use the clarification-card JSON format instead of inventing facts.",
    "For writing, follow Prompt -> Blueprint -> Prose. Blueprint records what happens; Prose is the final scene text only.",
    "Memory extraction must cite file + startLine + endLine + brief evidence unless the source is explicitly user_confirmed.",
    "",
    "### Global User Preferences (~/.config/nova/Nova.md)",
    globalHabitsForPrompt(context.globalHabits),
  ];

  if (context.includedLightweightState) {
    const files: Array<[string, string, number]> = [
      ["AuthorTemplate (.novel-assistance/habits/AuthorTemplate.md)", context.authorTemplate, 1800],
      ["ProseStyle (.novel-assistance/habits/ProseStyle.md)", context.proseStyle, 1800],
      ["DescriptionStats (.novel-assistance/habits/DescriptionStats.md)", context.descriptionStats, 2000],
      ["StoryDatabase (.novel-assistance/habits/StoryDatabase.md)", context.storyDatabase, 2400],
      ["RealtimeDatabase (.novel-assistance/habits/RealtimeDatabase.md)", context.realtimeDatabase, 2200],
    ];

    for (const [label, fileContent, maxLength] of files) {
      sections.push("", `### ${label}`, smartTruncate(fileContent.trim(), maxLength) || "(empty: not established yet)");
    }
  } else {
    sections.push("", "### Lightweight Project Data", "(not included for this request)");
  }

  return sections.join("\n").trim();
}

export function extractMemoryCandidate(content: string): string | null {
  return extractMemoryCandidates(content)[0] ?? null;
}

export function extractMemoryCandidates(content: string): string[] {
  const candidates: string[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const segment = content.slice(cursor);
    const match = MEMORY_CANDIDATE_HEADING.exec(segment);
    if (!match) break;

    const headingStart = cursor + match.index;
    const bodyStart = headingStart + match[0].length;
    const rest = content.slice(bodyStart);
    NEXT_HEADING.lastIndex = 0;
    const nextHeading = NEXT_HEADING.exec(rest);
    const bodyEnd = nextHeading ? bodyStart + nextHeading.index : content.length;
    const candidate = content.slice(bodyStart, bodyEnd).trim();
    if (candidate) candidates.push(candidate);
    cursor = bodyEnd;
  }

  return candidates;
}

export function stripMemoryCandidate(content: string): string {
  return stripMemoryCandidates(content);
}

export function stripMemoryCandidates(content: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < content.length) {
    const segment = content.slice(cursor);
    const match = MEMORY_CANDIDATE_HEADING.exec(segment);
    if (!match) {
      result += segment;
      break;
    }

    const headingStart = cursor + match.index;
    result += content.slice(cursor, headingStart);
    const bodyStart = headingStart + match[0].length;
    const rest = content.slice(bodyStart);
    NEXT_HEADING.lastIndex = 0;
    const nextHeading = NEXT_HEADING.exec(rest);
    cursor = nextHeading ? bodyStart + nextHeading.index : content.length;
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function stripFence(value: string) {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json|yaml|yml)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  if (/^(true|yes|1|是|已变更)$/i.test(value.trim())) return true;
  if (/^(false|no|0|否|未变更)$/i.test(value.trim())) return false;
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return String(value ?? "").trim();
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key}: ${contentToText(entry)}`)
    .join("; ")
    .trim();
}

function typeFromValue(value: unknown): MemoryCandidateType {
  const raw = String(value ?? "story_database").toLowerCase().replace(/[-\s]+/g, "_");
  const aliases: Record<string, MemoryCandidateType> = {
    author: "author_template",
    style: "prose_style",
    prose: "prose_style",
    description: "description_stats",
    descriptions: "description_stats",
    stats: "description_stats",
    database: "story_database",
    static_database: "story_database",
    realtime: "realtime_database",
    real_time_database: "realtime_database",
  };
  const typeValue = aliases[raw] ?? raw;
  return SUPPORTED_TYPES.includes(typeValue as MemoryCandidateType)
    ? (typeValue as MemoryCandidateType)
    : "story_database";
}

function inferProjectChanged(action: string, content: string): boolean {
  const normalizedAction = action.trim().toLowerCase();
  if (NON_PROJECT_ACTIONS.has(normalizedAction)) return false;
  return /新增|删除|修改|确定|完成|保存|加入|更新|已创建|已更新|已完成|add_|update_|complete_|resolve_|create_/i.test(`${normalizedAction}\n${content}`);
}

function parseCandidateObject(value: Record<string, unknown>, raw: string): ParsedMemoryCandidate {
  const type = typeFromValue(value.type);
  const action = String(value.action ?? "update_project_data").trim() || "update_project_data";
  const content = contentToText(value.content ?? value.summary ?? value.note ?? raw);

  return {
    type,
    projectChanged: parseBoolean(value.project_changed ?? value.projectChanged, inferProjectChanged(action, content)),
    action,
    confidence: Math.max(0, Math.min(1, parseNumber(value.confidence, 1))),
    evidenceCount: Math.max(1, Math.floor(parseNumber(value.evidence_count ?? value.evidenceCount, 1))),
    source: contentToText(value.source ?? value.evidence_source ?? value.evidenceSource ?? "").trim(),
    content,
    raw,
  };
}

function parseYamlLikeCandidate(raw: string): ParsedMemoryCandidate | null {
  const fields = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  const commit = () => {
    if (!currentKey) return;
    fields.set(normalizeKey(currentKey), currentValue.join("\n").trim());
  };

  for (const line of lines) {
    const match = line.match(TOP_LEVEL_KEY);
    if (match && !/^\s/.test(line)) {
      commit();
      currentKey = normalizeKey(match[1]);
      currentValue = [match[2] ?? ""];
    } else if (currentKey) {
      currentValue.push(line.replace(/^\s{2,}/, ""));
    }
  }
  commit();

  if (fields.size === 0) return null;

  const content = fields.get("content") || fields.get("summary") || fields.get("note") || raw;
  const action = scalar(fields.get("action") || "update_project_data");

  return {
    type: typeFromValue(scalar(fields.get("type") || "story_database")),
    projectChanged: parseBoolean(fields.get("project_changed") ?? fields.get("projectChanged"), inferProjectChanged(action, content)),
    action,
    confidence: Math.max(0, Math.min(1, parseNumber(fields.get("confidence"), 1))),
    evidenceCount: Math.max(1, Math.floor(parseNumber(fields.get("evidence_count") ?? fields.get("evidenceCount"), 1))),
    source: scalar(fields.get("source") || fields.get("evidence_source") || fields.get("evidenceSource") || ""),
    content: content.trim(),
    raw,
  };
}

export function parseMemoryCandidate(candidate: string): ParsedMemoryCandidate | null {
  return parseMemoryCandidates(candidate)[0] ?? null;
}

export function parseMemoryCandidates(candidate: string): ParsedMemoryCandidate[] {
  const raw = stripFence(candidate);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => parseCandidateObject(entry, JSON.stringify(entry)));
    }
    if (parsed && typeof parsed === "object") {
      return [parseCandidateObject(parsed as Record<string, unknown>, raw)];
    }
  } catch {
    // Fall through to the YAML-like parser.
  }

  const yamlCandidate = parseYamlLikeCandidate(raw);
  if (yamlCandidate) return [yamlCandidate];

  return [{
    type: "story_database",
    projectChanged: inferProjectChanged("update_project_data", raw),
    action: inferProjectChanged("update_project_data", raw) ? "update_project_data" : "analyze",
    confidence: 1,
    evidenceCount: 1,
    source: "",
    content: raw,
    raw,
  }];
}

function hasSourceLineEvidence(candidate: ParsedMemoryCandidate): boolean {
  const evidenceText = `${candidate.source}\n${candidate.content}`;
  return /user_confirmed|user confirmed|用户确认/i.test(evidenceText) || (
    /\b(file|path|source)\s*:/i.test(evidenceText) &&
    /\b(startLine|line|lines?)\s*[:=]?\s*\d+/i.test(evidenceText) &&
    /\b(endLine|line|lines?)\s*[:=]?\s*\d+/i.test(evidenceText)
  );
}

export function shouldApplyMemoryCandidate(
  candidate: ParsedMemoryCandidate,
  _options: MemoryApplyOptions = {}
): MemoryApplyResult {
  if (!candidate.content.trim()) {
    return { applied: false, target: "none", reason: "empty candidate" };
  }

  if (candidate.type === "blueprint") {
    return { applied: false, target: "none", reason: "blueprint updates must use blueprint tools" };
  }

  if (candidate.type === "nova") {
    if (candidate.confidence < NOVA_CONFIDENCE_THRESHOLD) {
      return { applied: false, target: "none", reason: "nova confidence below threshold" };
    }
    return { applied: true, target: "nova", reason: "durable preference evidence accepted" };
  }

  if (PROJECT_TYPES.has(candidate.type)) {
    if (!candidate.projectChanged || NON_PROJECT_ACTIONS.has(candidate.action.toLowerCase())) {
      return { applied: false, target: "none", reason: "project data unchanged" };
    }
    if (!hasSourceLineEvidence(candidate)) {
      return { applied: false, target: "none", reason: "project data needs source lines or user confirmation" };
    }
    return { applied: true, target: candidate.type, reason: "project data evidence accepted" };
  }

  return { applied: false, target: "none", reason: "unsupported candidate type" };
}

function normalizeBulletText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ")
    .replace(/^[-*]\s*/, "")
    .trim();
}

function getPreferenceEvidence(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(NOVA_EVIDENCE_KEY) || "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function setPreferenceEvidence(value: Record<string, number>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(NOVA_EVIDENCE_KEY, JSON.stringify(value));
}

function preferenceKey(candidate: ParsedMemoryCandidate): string {
  return normalizeBulletText(candidate.content).toLowerCase().slice(0, 160);
}

async function applyNovaCandidate(candidate: ParsedMemoryCandidate): Promise<MemoryApplyResult> {
  const key = preferenceKey(candidate);
  if (!key) return { applied: false, target: "none", reason: "empty nova preference" };

  const evidence = getPreferenceEvidence();
  const nextCount = (evidence[key] ?? 0) + candidate.evidenceCount;
  evidence[key] = nextCount;
  setPreferenceEvidence(evidence);

  if (nextCount < NOVA_EVIDENCE_THRESHOLD) {
    return { applied: false, target: "none", reason: `nova evidence ${nextCount}/${NOVA_EVIDENCE_THRESHOLD}` };
  }

  const current = markGlobalHabitsConfirmed((await readGlobalHabits()) ?? "");
  const bullet = `- ${normalizeBulletText(candidate.content)}`;
  if (current.includes(normalizeBulletText(candidate.content))) {
    return { applied: false, target: "none", reason: "nova preference already exists" };
  }

  const section = "## 自动识别偏好";
  const next = current.includes(section)
    ? current.replace(new RegExp(`(${section}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`), (_match, head, body) => {
        const currentBody = String(body).trim();
        const nextBody = !currentBody || currentBody === "待整理"
          ? bullet
          : `${currentBody}\n${bullet}`;
        return `${head}${nextBody}\n`;
      })
    : `${current.trim()}\n\n${section}\n\n${bullet}\n`;
  await writeGlobalHabits(next);
  return { applied: true, target: "nova", reason: "nova preference threshold reached" };
}

async function appendProjectData(candidate: ParsedMemoryCandidate): Promise<void> {
  const now = new Date().toLocaleString();
  const normalized = normalizeBulletText(candidate.content);
  const entry = `- ${normalized} (${candidate.action}, ${now})`;
  const appendUnique = async (current: string | null, fallback: string, write: (content: string) => Promise<void>) => {
    const base = current ?? fallback;
    if (base.includes(normalized)) return;
    await write(`${base.trim()}\n${entry}\n`);
  };

  if (candidate.type === "author_template") {
    await appendUnique(await readProjectAuthorTemplate(), "# AuthorTemplate\n\n", writeProjectAuthorTemplate);
    return;
  }
  if (candidate.type === "prose_style") {
    await appendUnique(await readProjectProseStyle(), "# ProseStyle\n\n", writeProjectProseStyle);
    return;
  }
  if (candidate.type === "description_stats") {
    await appendUnique(await readProjectDescriptionStats(), "# DescriptionStats\n\n", writeProjectDescriptionStats);
    return;
  }
  if (candidate.type === "story_database") {
    await appendUnique(await readProjectStoryDatabase(), "# StoryDatabase\n\n", writeProjectStoryDatabase);
    return;
  }
  if (candidate.type === "realtime_database") {
    await appendUnique(await readProjectRealtimeDatabase(), "# RealtimeDatabase\n\n", writeProjectRealtimeDatabase);
  }
}

export async function applyMemoryCandidate(
  rawCandidate: string,
  options: MemoryApplyOptions = {}
): Promise<MemoryApplyResult> {
  const candidate = parseMemoryCandidate(rawCandidate);
  if (!candidate) return { applied: false, target: "none", reason: "invalid candidate" };

  const decision = shouldApplyMemoryCandidate(candidate, options);
  if (!decision.applied) return decision;

  if (decision.target === "nova") {
    return applyNovaCandidate(candidate);
  }
  if (PROJECT_TYPES.has(decision.target as MemoryCandidateType)) {
    await appendProjectData(candidate);
  }

  return decision;
}

export async function applyMemoryCandidates(
  rawCandidates: string[],
  options: MemoryApplyOptions = {}
): Promise<MemoryApplyResult[]> {
  const parsedCandidates = rawCandidates.flatMap((rawCandidate) => parseMemoryCandidates(rawCandidate));
  if (parsedCandidates.length === 0) {
    return [{ applied: false, target: "none", reason: "invalid candidate" }];
  }

  const results: MemoryApplyResult[] = [];
  for (const candidate of parsedCandidates) {
    const decision = shouldApplyMemoryCandidate(candidate, options);
    if (!decision.applied) {
      results.push(decision);
      continue;
    }
    if (decision.target === "nova") {
      results.push(await applyNovaCandidate(candidate));
      continue;
    }
    if (PROJECT_TYPES.has(decision.target as MemoryCandidateType)) {
      await appendProjectData(candidate);
      results.push(decision);
      continue;
    }
    results.push(decision);
  }

  return results;
}
