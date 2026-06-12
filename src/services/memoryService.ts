import {
  ensureWorkspaceHabits,
  readGlobalHabits,
  readProjectAuthorVoice,
  readProjectCacheMemory,
  readProjectImportant,
  readProjectObsessions,
  readProjectSnapshot,
  writeGlobalHabits,
  writeProjectAuthorVoice,
  writeProjectCacheMemory,
  writeProjectImportant,
  writeProjectObsessions,
  writeProjectSnapshot,
} from "./fileSystemService";

export interface MemoryContext {
  globalHabits: string;
  projectAuthorVoice: string;
  projectObsessions: string;
  projectImportant: string;
  projectSnapshot: string;
  projectCache: string;
}

interface LoadMemoryOptions {
  includeStableProjectMemory?: boolean;
  includeAuthorProjectMemory?: boolean;
  includeShortTermMemory?: boolean;
  includeCacheMemory?: boolean;
  includeProjectImportant?: boolean;
  includeProjectSnapshot?: boolean;
}

export type MemoryCandidateType = "important" | "nova" | "cache" | "snapshot" | "author_voice" | "obsession";

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
const smartTruncate = (content: string, maxLength: number) =>
  content.length <= maxLength ? content : `${content.slice(0, maxLength)}\n\n...[truncated]...`;
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_ -]*):\s*(.*)$/;
const NOVA_EVIDENCE_KEY = "nova.preferenceEvidence.v1";
const NOVA_CONFIDENCE_THRESHOLD = 0.8;
const NOVA_EVIDENCE_THRESHOLD = 5;
const EMPTY_GLOBAL_HABITS = "(No confirmed global user preferences yet. Ignore the default Nova.md template as user preference evidence.)";

const PROJECT_CHANGING_ACTIONS = new Set([
  "add_character",
  "delete_character",
  "update_character",
  "update_character_state",
  "add_setting",
  "update_setting",
  "modify_worldbuilding",
  "update_worldbuilding",
  "update_project_summary",
  "update_current_progress",
  "determine_mainline",
  "update_mainline",
  "add_foreshadowing",
  "resolve_foreshadowing",
  "complete_chapter",
  "complete_scene",
  "update_direction",
  "update_outline",
  "create_blueprint",
  "update_blueprint",
  "update_author_voice",
  "update_obsession",
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

const IMPORTANT_LABELS = [
  "名称：",
  "当前进度：",
  "核心主线：",
  "重要设定：",
  "未回收伏笔：",
  "当前创作方向：",
];

function isTemplateGlobalHabits(content: string): boolean {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return true;
  if (/template:\s*true/i.test(normalized) && /confirmed_by_user:\s*false/i.test(normalized)) return true;
  return normalized === `# 用户偏好

## 写作

- 偏好西幻
- 偏好轻小说风格
- 喜欢长篇规划
- 喜欢先大纲后正文

## 代码

- 默认 Typescript
- 默认 Vue3
- 默认 Tailwind

## Agent

- 默认 Smart Mode
- 超过3000字自动进入 Plan 模式

## 输出习惯

- 中文回答
- 使用Markdown`.trim();
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
  await Promise.all([
    readGlobalHabits(),
    ensureWorkspaceHabits(),
  ]);
}

export async function loadMemoryContext(options: LoadMemoryOptions = {}): Promise<MemoryContext> {
  const includeStableProjectMemory = options.includeStableProjectMemory ?? options.includeProjectImportant ?? true;
  const includeAuthorProjectMemory = options.includeAuthorProjectMemory ?? includeStableProjectMemory;
  const includeShortTermMemory = options.includeShortTermMemory ?? options.includeProjectSnapshot ?? false;
  const includeCacheMemory = options.includeCacheMemory ?? includeShortTermMemory;
  const [globalHabits, projectImportant, projectAuthorVoice, projectObsessions, projectSnapshot, projectCache] = await Promise.all([
    readGlobalHabits(),
    includeStableProjectMemory
      ? ensureWorkspaceHabits().then(() => readProjectImportant())
      : Promise.resolve(""),
    includeAuthorProjectMemory
      ? ensureWorkspaceHabits().then(() => readProjectAuthorVoice())
      : Promise.resolve(""),
    includeAuthorProjectMemory
      ? ensureWorkspaceHabits().then(() => readProjectObsessions())
      : Promise.resolve(""),
    includeShortTermMemory
      ? ensureWorkspaceHabits().then(() => readProjectSnapshot())
      : Promise.resolve(""),
    includeCacheMemory
      ? ensureWorkspaceHabits().then(() => readProjectCacheMemory())
      : Promise.resolve(""),
  ]);

  return {
    globalHabits: globalHabits ?? "",
    projectAuthorVoice: projectAuthorVoice ?? "",
    projectObsessions: projectObsessions ?? "",
    projectImportant: projectImportant ?? "",
    projectSnapshot: projectSnapshot ?? "",
    projectCache: projectCache ?? "",
  };
}

export function buildMemoryPrompt(context: MemoryContext): string {
  const compactProjectImportant = smartTruncate(context.projectImportant.trim(), 5200);
  const compactAuthorVoice = smartTruncate(context.projectAuthorVoice.trim(), 3600);
  const compactObsessions = smartTruncate(context.projectObsessions.trim(), 2800);
  const compactProjectSnapshot = smartTruncate(context.projectSnapshot.trim(), 2600);
  const compactProjectCache = smartTruncate(context.projectCache.trim(), 2200);
  const sections = [
    "## Nova Memory",
    "Read these memories before answering. Nova.md contains durable global preferences. Importants.md is the cross-conversation project ledger: what the user has done, current project state, confirmed decisions, major canon changes, and progress. AuthorVoice.md contains author habits and disliked patterns. Obsessions.md contains recurring themes. Snapshot.md is short-term project/session state. Cache.md is volatile runtime memory. Do not treat Importants.md as a full character database.",
    "",
    "### Global User Preferences (~/.config/nova/Nova.md)",
    globalHabitsForPrompt(context.globalHabits),
  ];

  if (compactAuthorVoice) {
    sections.push(
      "",
      "### Author Voice (.novel-assistance/habits/AuthorVoice.md)",
      compactAuthorVoice
    );
  }

  if (compactObsessions) {
    sections.push(
      "",
      "### Author Obsessions (.novel-assistance/habits/Obsessions.md)",
      compactObsessions
    );
  }

  if (compactProjectImportant) {
    sections.push(
      "",
      "### Project Important (.novel-assistance/habits/Importants.md)",
      compactProjectImportant
    );
  }

  if (compactProjectSnapshot) {
    sections.push(
      "",
      "### Project Snapshot (.novel-assistance/habits/Snapshot.md)",
      compactProjectSnapshot
    );
  }

  if (compactProjectCache) {
    sections.push(
      "",
      "### Project Cache (.novel-assistance/habits/Cache.md)",
      compactProjectCache
    );
  }

  return sections.join("\n");
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

function stripFence(value: string): string {
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
  if (/^(true|yes|1|是|changed)$/i.test(value.trim())) return true;
  if (/^(false|no|0|否|unchanged)$/i.test(value.trim())) return false;
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
    .join("\n")
    .trim();
}

function parseCandidateObject(value: Record<string, unknown>, raw: string): ParsedMemoryCandidate {
  const typeValue = String(value.type ?? "important").toLowerCase();
  const type = (["important", "nova", "cache", "snapshot", "author_voice", "obsession"].includes(typeValue)
    ? typeValue
    : "important") as MemoryCandidateType;
  const action = String(value.action ?? "update_setting").trim() || "update_setting";
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
    fields.set(currentKey, currentValue.join("\n").trim());
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
  const action = scalar(fields.get("action") || "update_setting");
  const typeValue = scalar(fields.get("type") || "important").toLowerCase();
  const type = (["important", "nova", "cache", "snapshot", "author_voice", "obsession"].includes(typeValue)
    ? typeValue
    : "important") as MemoryCandidateType;

  return {
    type,
    projectChanged: parseBoolean(fields.get("project_changed"), inferProjectChanged(action, content)),
    action,
    confidence: Math.max(0, Math.min(1, parseNumber(fields.get("confidence"), 1))),
    evidenceCount: Math.max(1, Math.floor(parseNumber(fields.get("evidence_count"), 1))),
    source: scalar(fields.get("source") || fields.get("evidence_source") || ""),
    content: content.trim(),
    raw,
  };
}

function inferProjectChanged(action: string, content: string): boolean {
  const normalizedAction = action.trim().toLowerCase();
  if (PROJECT_CHANGING_ACTIONS.has(normalizedAction)) return true;
  if (NON_PROJECT_ACTIONS.has(normalizedAction)) return false;
  return /新增|删除|修改|确定|完成|保存|加入主线|新增伏笔|回收伏笔|世界观|角色状态|主线|当前进度|已创建|已更新|已完成|改为|确认|决定|设定为|加入|移除|add_|update_|complete_|resolve_|create_/i.test(content);
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
    type: "important",
    projectChanged: inferProjectChanged("update_setting", raw),
    action: inferProjectChanged("update_setting", raw) ? "update_setting" : "analyze",
    confidence: 1,
    evidenceCount: 1,
    source: "",
    content: raw,
    raw,
  }];
}

export function shouldApplyMemoryCandidate(
  candidate: ParsedMemoryCandidate,
  options: MemoryApplyOptions = {}
): MemoryApplyResult {
  if (!candidate.content.trim()) {
    return { applied: false, target: "none", reason: "empty candidate" };
  }

  if (candidate.type === "important") {
    const action = candidate.action.toLowerCase();
    if (!candidate.projectChanged || NON_PROJECT_ACTIONS.has(action)) {
      return { applied: false, target: "none", reason: "project state unchanged" };
    }
    if (!PROJECT_CHANGING_ACTIONS.has(action) && !inferProjectChanged(action, candidate.content)) {
      return { applied: false, target: "none", reason: "not a durable project-state action" };
    }
    if (
      /complete_chapter|complete_scene/i.test(action) &&
      !options.hasSuccessfulCreateFile &&
      !options.isConfirmedPlanExecution
    ) {
      return { applied: false, target: "none", reason: "chapter completion was not confirmed by file creation or plan execution" };
    }
    return { applied: true, target: "important", reason: "project state changed" };
  }

  if (candidate.type === "nova") {
    if (candidate.confidence < NOVA_CONFIDENCE_THRESHOLD) {
      return { applied: false, target: "none", reason: "nova confidence below threshold" };
    }
    return { applied: true, target: "nova", reason: "durable preference evidence accepted" };
  }

  if (candidate.type === "author_voice") {
    if (candidate.confidence < 0.6) {
      return { applied: false, target: "none", reason: "author voice confidence below threshold" };
    }
    if (!hasDurableAuthorEvidence(candidate)) {
      return { applied: false, target: "none", reason: "author voice needs source or repeated evidence" };
    }
    return { applied: true, target: "author_voice", reason: "author voice evidence accepted" };
  }

  if (candidate.type === "obsession") {
    if (candidate.confidence < 0.6) {
      return { applied: false, target: "none", reason: "obsession confidence below threshold" };
    }
    if (!hasDurableAuthorEvidence(candidate)) {
      return { applied: false, target: "none", reason: "obsession needs source or repeated evidence" };
    }
    return { applied: true, target: "obsession", reason: "author obsession evidence accepted" };
  }

  if (candidate.type === "snapshot" || candidate.type === "cache") {
    return { applied: true, target: candidate.type, reason: "short-term memory candidate" };
  }

  return { applied: false, target: "none", reason: "unsupported candidate type" };
}

function hasDurableAuthorEvidence(candidate: ParsedMemoryCandidate): boolean {
  if (candidate.evidenceCount >= 2) return true;
  return Boolean(candidate.source.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionPattern(label: string): RegExp {
  const nextLabels = IMPORTANT_LABELS
    .filter((item) => item !== label)
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(${escapeRegExp(label)}\\s*\\n)([\\s\\S]*?)(?=\\n(?:${nextLabels})|\\n##\\s|$)`);
}

function normalizeBulletText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("；")
    .replace(/^[-*]\s*/, "")
    .trim();
}

function appendToImportantSection(content: string, label: string, value: string): string {
  const text = normalizeBulletText(value);
  if (!text) return content;

  const pattern = sectionPattern(label);
  const match = content.match(pattern);
  const bullet = `- ${text}`;
  if (!match) {
    return `${content.trim()}\n\n${label}\n${bullet}\n`;
  }

  const body = match[2].trim();
  if (body.includes(text)) return content;
  const nextBody = !body || body === "..." || body === "待整理"
    ? bullet
    : `${body}\n${bullet}`;
  return content.replace(pattern, `$1${nextBody}\n`);
}

function targetImportantLabel(action: string): string {
  const normalized = action.toLowerCase();
  if (/complete_chapter|complete_scene|current_progress/.test(normalized)) return "当前进度：";
  if (/mainline/.test(normalized)) return "核心主线：";
  if (/foreshadowing/.test(normalized)) return "未回收伏笔：";
  if (/direction|outline|blueprint|project_summary/.test(normalized)) return "当前创作方向：";
  return "重要设定：";
}

export async function mergeProjectImportantCandidate(candidate: ParsedMemoryCandidate): Promise<void> {
  const current = (await readProjectImportant()) ?? "";
  const label = targetImportantLabel(candidate.action);
  const value = candidate.action.toLowerCase() === "resolve_foreshadowing"
    ? `已回收：${candidate.content}`
    : candidate.content;
  await writeProjectImportant(appendToImportantSection(current, label, value));
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
    ? current.replace(new RegExp(`(${escapeRegExp(section)}\\s*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`), (_match, head, body) => {
        const currentBody = String(body).trim();
        const nextBody = !currentBody || currentBody === "待观察"
          ? bullet
          : `${currentBody}\n${bullet}`;
        return `${head}${nextBody}\n`;
      })
    : `${current.trim()}\n\n${section}\n\n${bullet}\n`;
  await writeGlobalHabits(next);
  return { applied: true, target: "nova", reason: "nova preference threshold reached" };
}

async function appendShortTermMemory(candidate: ParsedMemoryCandidate): Promise<void> {
  const now = new Date().toLocaleString();
  const entry = [`### ${now}`, "", `action: ${candidate.action}`, "", candidate.content.trim(), ""].join("\n");
  if (candidate.type === "cache") {
    const current = (await readProjectCacheMemory()) ?? "# Cache\n\n";
    await writeProjectCacheMemory(`${current.trim()}\n\n${entry}`);
    return;
  }

  const current = (await readProjectSnapshot()) ?? "# Snapshot\n\n";
  await writeProjectSnapshot(`${current.trim()}\n\n${entry}`);
}

async function appendDurableProjectMemory(candidate: ParsedMemoryCandidate): Promise<void> {
  const now = new Date().toLocaleString();
  const bullet = `- ${normalizeBulletText(candidate.content)} (${candidate.action}, ${now})`;
  if (candidate.type === "author_voice") {
    const current = (await readProjectAuthorVoice()) ?? "# AuthorVoice\n\n";
    if (current.includes(normalizeBulletText(candidate.content))) return;
    await writeProjectAuthorVoice(`${current.trim()}\n${bullet}\n`);
    return;
  }
  if (candidate.type === "obsession") {
    const current = (await readProjectObsessions()) ?? "# Obsessions\n\n";
    if (current.includes(normalizeBulletText(candidate.content))) return;
    await writeProjectObsessions(`${current.trim()}\n${bullet}\n`);
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

  if (decision.target === "important") {
    await mergeProjectImportantCandidate(candidate);
    return decision;
  }
  if (decision.target === "nova") {
    return applyNovaCandidate(candidate);
  }
  if (decision.target === "author_voice" || decision.target === "obsession") {
    await appendDurableProjectMemory(candidate);
    return decision;
  }
  if (decision.target === "cache" || decision.target === "snapshot") {
    await appendShortTermMemory(candidate);
    return decision;
  }

  return decision;
}

export async function applyMemoryCandidates(
  rawCandidates: string[] | string,
  options: MemoryApplyOptions = {}
): Promise<MemoryApplyResult[]> {
  const rawList = Array.isArray(rawCandidates) ? rawCandidates : [rawCandidates];
  const parsedCandidates = rawList.flatMap((candidate) => parseMemoryCandidates(candidate));
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

    if (decision.target === "important") {
      await mergeProjectImportantCandidate(candidate);
      results.push(decision);
      continue;
    }
    if (decision.target === "nova") {
      results.push(await applyNovaCandidate(candidate));
      continue;
    }
    if (decision.target === "author_voice" || decision.target === "obsession") {
      await appendDurableProjectMemory(candidate);
      results.push(decision);
      continue;
    }
    if (decision.target === "cache" || decision.target === "snapshot") {
      await appendShortTermMemory(candidate);
      results.push(decision);
      continue;
    }

    results.push(decision);
  }
  return results;
}

export async function appendProjectMemoryCandidate(candidate: string): Promise<MemoryApplyResult> {
  return applyMemoryCandidate(candidate);
}
