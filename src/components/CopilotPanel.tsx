import React, { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, MessageSquarePlus, Paperclip, Send, Settings, Sparkles, Trash2, X } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useAppUIStore } from "../stores/appUIStore";
import { useTranslation } from "../hooks/useTranslation";
import { callAI, callEditorRoleReview, reviewEditFileContent } from "../services/aiService";
import {
  deleteConversation,
  ensureWorkspaceConversationStore,
  listConversationSummaries,
  readConversation,
  writeConversation,
} from "../services/conversationService";
import { selectTextAttachments } from "../services/attachmentService";
import { getEditorContent, getEditorSerializedContent, insertTextIntoEditor } from "../services/editorInsertionService";
import { runLocalTool } from "../services/mcpService";
import {
  applyMemoryCandidates,
  buildMemoryPrompt,
  ensureMemoryFiles,
  extractMemoryCandidates,
  loadMemoryContext,
  stripMemoryCandidates,
} from "../services/memoryService";
import {
  readFile,
  type ReferenceListData,
  type WorkspaceNode,
} from "../services/fileSystemService";
import { calculateTextStats } from "../utils/textStats";
import type { AgentMode, ChatSkills, ConversationAttachment, ConversationMessage, ConversationRecord, ConversationSummary, ConversationWorkItem, EditReviewDebug, FileChange, FileContentCache, MultiFileContext, PromptDebugBreakdown, PromptDebugEntry } from "../types/ai";
import "./CopilotPanel.css";

// 构建目录结构字符串（隐藏 .novel-assistance/conversations/）
function buildDirectoryTreeString(nodes: WorkspaceNode[], prefix: string = ""): string {
  const lines: string[] = [];
  
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const childPrefix = isLast ? "    " : "│   ";
    
    if (node.type === "folder") {
      // 如果是 .novel-assistance 文件夹，需要特殊处理子目录
      if (node.name === ".novel-assistance") {
        lines.push(`${prefix}${connector}${node.name}/`);
        if (node.children) {
          // 过滤掉 conversations 目录
          const filteredChildren = node.children.filter(child => child.name !== "conversations");
          if (filteredChildren.length > 0) {
            lines.push(buildDirectoryTreeString(filteredChildren, prefix + childPrefix));
          }
        }
      } else {
        lines.push(`${prefix}${connector}${node.name}/`);
        if (node.children) {
          lines.push(buildDirectoryTreeString(node.children, prefix + childPrefix));
        }
      }
    } else {
      lines.push(`${prefix}${connector}${node.name}`);
    }
  }
  return lines.join("\n");
}

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

const DEFAULT_CHAT_SKILLS: ChatSkills = {
  enableWebSearch: false,
  agentMode: "writer",
  agentSubMode: "plan",
  forcePlanMode: false,
  enableEditReview: true,
};

function serializeReferenceListsForReview(lists: ReferenceListData[], maxLength = 16000) {
  const content = lists
    .map((list) => {
      const items = list.items
        .filter((item) => item.key.trim())
        .map((item) => {
          const head = `{{${item.key.trim()}}}${item.value?.trim() ? ` "${item.value.trim()}"` : ""}`;
          return item.body?.trim() ? `${head}\n${item.body.trim()}` : head;
        })
        .join("\n\n");
      return items ? `# ${list.name}\n${items}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return content.length > maxLength
    ? `${content.slice(0, maxLength)}\n\n...[reference/config database truncated]...`
    : content;
}

function buildRelevantReferenceContext(
  lists: ReferenceListData[],
  requestContent: string,
  documentContext: string,
  maxLength = 8000
) {
  const haystack = `${requestContent}\n${documentContext}`.toLowerCase();
  const scoredEntries: Array<{ listName: string; key: string; value: string; body: string; score: number }> = [];
  for (const list of lists) {
    const isCharacterList = /^(人物|characters?)$/i.test(list.name.trim());
    for (const item of list.items) {
      const key = item.key.trim();
      if (!key) continue;
      const keyHit = haystack.includes(key.toLowerCase());
      const dynamicHit = /current_desire|current_fear|current_emotion|current_bias|当前欲望|当前恐惧|当前情绪|当前偏见/i.test(item.body ?? "");
      const score = (keyHit ? 10 : 0) + (isCharacterList ? 2 : 0) + (dynamicHit ? 1 : 0);
      if (score <= 0) continue;
      scoredEntries.push({
        listName: list.name,
        key,
        value: item.value?.trim() ?? "",
        body: item.body?.trim() ?? "",
        score,
      });
    }
  }

  const selected = scoredEntries
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (selected.length === 0) return "";

  const content = selected
    .map((item) => {
      const head = `## ${item.listName} / ${item.key}${item.value ? ` - ${item.value}` : ""}`;
      return item.body ? `${head}\n${truncateContextText(item.body, 900)}` : head;
    })
    .join("\n\n");
  return content.length > maxLength
    ? `${content.slice(0, maxLength)}\n\n...[relevant reference entries truncated]...`
    : content;
}

const PLAN_REQUIRED_PATTERNS = [
  /先.*(计划|方案|大纲|确认)|制定.*(计划|方案|大纲)|输出.*(计划|方案|大纲)|计划.*确认|确认.*计划/i,
  /长篇规划|世界观|角色弧|主线|伏笔|多文件|结构性重写|重构.*结构|蓝图方案/i,
  /第[一二三四五六七八九十百千万\d]+章.*(正文|创作|生成|写作|蓝图)|整章.*(正文|创作|生成|写作)/i,
  /plan first|confirm.*plan|outline first|multi-file|long[-\s]?form|worldbuilding|chapter.*(draft|generate|write|blueprint)/i,
];

const PROJECT_MEMORY_PATTERNS = [
  /小说|写作|剧情|蓝图|大纲|章节|正文|伏笔|主线|设定|世界观|角色|人物|创作|故事|幕|卷/i,
  /novel|story|plot|blueprint|outline|chapter|draft|character|worldbuilding|foreshadow/i,
];

const ARCHITECT_PLAN_PATTERNS = [
  /世界观|人设|人物设定|角色设定|立意|主题|作者风格|作者画像|作者偏好|作者偏执|写作习惯|叙事习惯|主题执念|反感项|小说方向|故事方向|重构|重新设计|架构/i,
  /worldbuilding|character\s+design|character\s+setting|theme|premise|author\s+voice|author\s+profile|author\s+habit|obsession|rebuild|redesign|rework/i,
];

const ARCHITECT_REBUILD_PATTERNS = [
  /推倒重来|全部推翻|全部重写|不要旧设定|不要沿用旧设定|从零开始|换方向|重构世界观|重做人设|重新做人设|重新设计|彻底重构/i,
  /start\s+over|from\s+scratch|throw\s+.*away|rebuild\s+from\s+zero|full\s+rebuild|do\s+not\s+keep\s+old/i,
];

const FILE_CREATION_PATTERNS = [
  /创建|保存|写入|生成文件|新建|建一个|另存|存成|存为/i,
  /create|save|write (?:a )?file|new file/i,
];

const CHAPTER_DRAFT_PATTERNS = [
  /章节|正文|第一章|第二章|第三章|第四章|第五章|第六章|第七章|第八章|第九章|第十章|序章|终章|番外/i,
  /第[一二三四五六七八九十百千万\d]+章|EP[_-]?\d+|chapter|episode|prologue|epilogue/i,
];

function normalizeChatSkills(skills?: Partial<ChatSkills> | null): ChatSkills {
  const rawMode = skills?.agentMode as unknown;
  const agentMode: AgentMode = rawMode === "editor" || rawMode === "architect" ? rawMode : "writer";
  return {
    ...DEFAULT_CHAT_SKILLS,
    ...skills,
    agentMode,
  };
}

function isProjectMemoryRelevant(content: string): boolean {
  return PROJECT_MEMORY_PATTERNS.some((pattern) => pattern.test(content));
}

function isArchitectPlanRelevant(content: string): boolean {
  return ARCHITECT_PLAN_PATTERNS.some((pattern) => pattern.test(content))
    || ARCHITECT_REBUILD_PATTERNS.some((pattern) => pattern.test(content));
}

function isArchitectRebuildRequest(content: string): boolean {
  return ARCHITECT_REBUILD_PATTERNS.some((pattern) => pattern.test(content));
}

function shouldForceCreateFile(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/你没有创建|没有实际创建|依旧没有创建|没创建|补上文件|实际创建/i.test(trimmed)) return true;
  return FILE_CREATION_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function shouldDefaultChapterToDocx(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/\.(?:docx|md|markdown|txt)\b/i.test(trimmed)) return false;
  return shouldForceCreateFile(trimmed) && CHAPTER_DRAFT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isCharacterSheetRequest(content: string): boolean {
  return /人设|人物设定|角色设定|角色档案|人物档案|生成人物|创建人物|创建角色|重新做人设|设计人物|设计角色|男主|女主|主角|配角|反派|character\s+(?:sheet|profile|design|setting)|persona/i.test(content);
}

function isCharacterSheetPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? normalized;
  return /人设|人物|角色|男主|女主|主角|配角|反派|character|persona/i.test(normalized)
    || /^角色[-_]/i.test(fileName)
    || /^人物[-_]/i.test(fileName);
}

function shouldNeedPlan(content: string, mode: AgentMode): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (mode === "architect" && isArchitectPlanRelevant(trimmed)) return true;
  if (shouldForceCreateFile(trimmed)) return false;
  if (PLAN_REQUIRED_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (trimmed.length > 3000) return true;
  if (mode === "writer") {
    return trimmed.length > 1800 && isProjectMemoryRelevant(trimmed);
  }
  if (mode === "architect") {
    return trimmed.length > 600 || isProjectMemoryRelevant(trimmed);
  }
  return false;
}

function isClarificationResponse(content: string): boolean {
  return /(^|\n)##\s*Clarification Needed\b/i.test(content) || parseClarificationQuestions(content).length > 0;
}

function extractClarificationJson(content: string): string | null {
  const fenced = content.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
  if (fenced?.[1] && /"questions"\s*:/.test(fenced[1])) return fenced[1].trim();
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = trimmed.slice(start, index + 1);
          if (/"questions"\s*:/.test(candidate)) return candidate;
          break;
        }
      }
    }
  }

  return null;
}

function parseClarificationQuestions(content: string): Array<{ id: string; question: string; options: string[]; allowCustom: boolean }> {
  const json = extractClarificationJson(content);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as {
      questions?: Array<{
        id?: unknown;
        question?: unknown;
        options?: unknown;
        allow_custom?: unknown;
        allowCustom?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.questions)) return [];
    return parsed.questions
      .map((item, index) => ({
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `q${index + 1}`,
        question: typeof item.question === "string" ? item.question.trim() : "",
        options: Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === "string") : [],
        allowCustom: Boolean(item.allow_custom ?? item.allowCustom),
      }))
      .filter((item) => item.question);
  } catch {
    return [];
  }
}

function createConversation(modelId: string | null, contextFilePath?: string | null): ConversationRecord {
  const now = new Date().toISOString();
  return {
    id: createId("conv"),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    modelId,
    messages: [],
    contextFilePath: contextFilePath ?? null,
    draftInput: "",
    lastInsertedText: null,
  };
}

function buildTitleFromMessage(content: string) {
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length > 32 ? `${singleLine.slice(0, 32)}...` : singleLine || "New conversation";
}

type WriteToolMetadata = {
  ok?: boolean;
  action?: "create_file" | "edit_file" | "edit_docx";
  relativePath?: string;
  absolutePath?: string;
  fileType?: "text" | "docx";
  bytes?: number;
  edits?: number;
};

type ContextStrategy = "none" | "metadata" | "history-delta" | "snippet" | "full" | "structured";

type PlannedDocumentContext = {
  content: string;
  strategy: ContextStrategy;
  reason: string;
  rawChars: number;
  sentChars: number;
  promptDebug: PromptDebugBreakdown;
};

function normalizeWorkspacePath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function isInternalWorkspaceDataPath(path: string) {
  const normalized = normalizeWorkspacePath(path).toLowerCase();
  return normalized === ".novel-assistance" || normalized.startsWith(".novel-assistance/");
}

function joinWorkspacePath(rootPath: string, relativePath: string) {
  const separator = rootPath.includes("\\") ? "\\" : "/";
  return `${rootPath.replace(/[/\\]+$/, "")}${separator}${normalizeWorkspacePath(relativePath).replace(/\//g, separator)}`;
}

function isPathInsideRoot(path: string, rootPath: string | null) {
  if (!rootPath) return false;
  const normalizedPath = normalizeWorkspacePath(path).toLowerCase();
  const normalizedRoot = normalizeWorkspacePath(rootPath).replace(/\/$/, "").toLowerCase();
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function findWorkspaceNode(nodes: WorkspaceNode[], targetPath: string): WorkspaceNode | null {
  const normalizedTarget = normalizeWorkspacePath(targetPath);
  for (const node of nodes) {
    if (normalizeWorkspacePath(node.path) === normalizedTarget) return node;
    if (node.children) {
      const found = findWorkspaceNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function parseWriteToolMetadata(result: string): WriteToolMetadata | null {
  try {
    const parsed = JSON.parse(result) as WriteToolMetadata;
    if (parsed?.ok && parsed.relativePath && parsed.absolutePath) return parsed;
  } catch {
    return null;
  }
  return null;
}

type ExtractedToolCall = { fullMatch: string; json: string; index: number };

function scanJsonObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function extractToolCallsFromText(text: string): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = [];
  const occupied: Array<{ start: number; end: number }> = [];
  const addCall = (start: number, fullMatch: string, json: string) => {
    if (!/"(?:name|tool)"\s*:/.test(json)) return;
    if (!/"(?:name|tool)"\s*:\s*"(?:create_file|edit_file|edit_docx|create_blueprint|upsert_reference_entries|read_file|search_file|list_directory|web_search|list_blueprints|read_blueprint|list_blueprint_templates)"/.test(json)) return;
    const end = start + fullMatch.length;
    if (occupied.some((range) => start < range.end && end > range.start)) return;
    occupied.push({ start, end });
    results.push({ fullMatch, json: json.trim(), index: start });
  };

  const fencedPattern = /```(?:tool[_-]?call|json)\s*\n/g;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = fencedPattern.exec(text)) !== null) {
    const jsonStart = startMatch.index + startMatch[0].length;
    const endMarker = text.indexOf("\n```", jsonStart);
    if (endMarker === -1) break;
    const json = text.slice(jsonStart, endMarker);
    addCall(startMatch.index, text.slice(startMatch.index, endMarker + 4), json);
  }

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const json = scanJsonObjectAt(text, start);
    if (!json) continue;
    addCall(start, json, json);
  }

  return results.sort((a, b) => a.index - b.index);
}

function stripToolCalls(content: string) {
  const stripped = extractToolCallsFromText(content)
    .reduceRight((text, call) => text.slice(0, call.index) + text.slice(call.index + call.fullMatch.length), content)
    .replace(/```(?:tool[_-]?call|json)\s*\n[\s\S]*"name"\s*:\s*"(?:create_file|edit_file|edit_docx|create_blueprint|upsert_reference_entries|read_file|search_file|list_directory|web_search|list_blueprints|read_blueprint|list_blueprint_templates)"[\s\S]*$/i, "")
    .replace(/\{\s*"name"\s*:\s*"(?:create_file|edit_file|edit_docx|create_blueprint|upsert_reference_entries|read_file|search_file|list_directory|web_search|list_blueprints|read_blueprint|list_blueprint_templates)"[\s\S]*$/i, "");
  return stripped.trim();
}

function getToolWorkKind(toolName: string): ConversationWorkItem["kind"] {
  if (toolName === "web_search") return "search";
  if (toolName.includes("blueprint")) return "blueprint";
  if (toolName === "read_file" || toolName === "search_file" || toolName === "list_directory") return "file";
  if (toolName === "edit_file" || toolName === "edit_docx" || toolName === "create_file" || toolName === "create_blueprint" || toolName === "upsert_reference_entries") return "write";
  return "tool";
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>) {
  if (toolName === "web_search") return String(args.query ?? "");
  if (toolName === "read_file" || toolName === "search_file" || toolName === "list_directory" || toolName === "edit_file" || toolName === "edit_docx" || toolName === "create_file") {
    return String(args.path ?? "workspace");
  }
  if (toolName === "upsert_reference_entries") return String(args.listName ?? "人物");
  if (toolName === "read_blueprint") return String(args.name ?? args.id ?? "blueprint");
  if (toolName === "list_blueprint_templates") return "blueprint templates";
  if (toolName === "create_blueprint") return String(args.name ?? (args.blueprint as { name?: string } | undefined)?.name ?? "blueprint");
  return toolName;
}

function summarizeToolResult(result: string) {
  if (result.startsWith("Error")) return result.slice(0, 220);
  try {
    const parsed = JSON.parse(result) as any;
    if (parsed?.summary?.name) {
      return `${parsed.summary.name}: ${parsed.summary.nodes ?? 0} nodes, ${parsed.summary.edges ?? 0} edges`;
    }
    if (Array.isArray(parsed)) return `${parsed.length} item(s)`;
    if (parsed?.relativePath) return parsed.relativePath;
  } catch {
    // Plain text tool results are summarized below.
  }
  return result.replace(/\s+/g, " ").slice(0, 220);
}

function summarizeToolResultForModel(name: string, result: string) {
  if (name !== "read_file" || result.startsWith("Error")) return result;
  const compact = result.trim();
  if (!compact) {
    return JSON.stringify({
      ok: true,
      tool: "read_file",
      empty: true,
      chars: 0,
      content: "",
    }, null, 2);
  }
  if (compact.length <= 2400) return compact;
  return JSON.stringify({
    ok: true,
    tool: "read_file",
    chars: result.length,
    summary: "Large file content was read successfully. Full text is not repeated in tool history; use the provided head/tail snippets and request a targeted read if exact lines are needed.",
    head: compact.slice(0, 1200),
    tail: compact.slice(-900),
  }, null, 2);
}

function createEditReviewDebug(enabled: boolean): EditReviewDebug {
  return {
    createdAt: new Date().toISOString(),
    enabled,
    triggered: false,
    editCount: 0,
    reviewedCount: 0,
    skippedCount: 0,
    originalChars: 0,
    reviewedChars: 0,
    durationMs: 0,
    skipReasons: [],
    fallbackReasons: [],
  };
}

function addEditReviewDebugReason(items: string[], reason: string) {
  if (!items.includes(reason)) items.push(reason);
}

function estimatePromptTokens(chars: number) {
  return Math.ceil(chars / 3.2);
}

function truncateContextText(content: string, maxLength: number) {
  if (content.length <= maxLength) return content;
  const headLength = Math.floor(maxLength * 0.45);
  const tailLength = Math.max(0, maxLength - headLength - 90);
  return `${content.slice(0, headLength)}\n\n...[context truncated: ${content.length - maxLength} chars omitted]...\n\n${content.slice(-tailLength)}`;
}

function buildLocalSnippet(content: string, maxLength = 2400) {
  return truncateContextText(content, maxLength);
}

type ProseMirrorJsonNode = {
  type?: string;
  text?: string;
  content?: ProseMirrorJsonNode[];
};

function proseMirrorJsonToText(node: ProseMirrorJsonNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  const childText = (node.content ?? []).map(proseMirrorJsonToText).join("");
  if (["paragraph", "heading", "blockquote", "listItem"].includes(node.type ?? "")) {
    return `${childText.trim()}\n`;
  }
  if (["bulletList", "orderedList", "doc"].includes(node.type ?? "")) {
    return (node.content ?? []).map(proseMirrorJsonToText).join("\n");
  }
  return childText;
}

function contentToAiReadableText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{")) return content;
  try {
    const parsed = JSON.parse(trimmed) as ProseMirrorJsonNode;
    if (!parsed || parsed.type !== "doc") return content;
    return proseMirrorJsonToText(parsed)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return content;
  }
}

function summarizeFileChanges(changes: FileChange[], maxChanges = 5) {
  return changes.slice(-maxChanges).map((change, index) => {
    const oldPart = truncateContextText(contentToAiReadableText(change.oldContent) || "(empty)", 500);
    const newPart = truncateContextText(contentToAiReadableText(change.newContent) || "(empty)", 700);
    return `Change ${index + 1} at ${change.timestamp}\nLines ${change.startLine}-${change.endLine}\nBefore:\n${oldPart}\nAfter:\n${newPart}`;
  }).join("\n\n");
}

function hasExplicitFullContextRequest(content: string) {
  return /全文|整章|全章|完整章节|完整上下文|完整续写参考|全文分析|整章结构|检查整章|生成蓝图|蓝图|全文检查|full\s+chapter|whole\s+chapter|entire\s+chapter|blueprint|complete\s+context/i.test(content);
}

function createPromptDebugBreakdown(entries: PromptDebugEntry[]): PromptDebugBreakdown {
  const totalChars = entries.reduce((sum, entry) => sum + entry.chars, 0);
  const dynamicChars = entries.filter((entry) => entry.dynamic).reduce((sum, entry) => sum + entry.chars, 0);
  return {
    createdAt: new Date().toISOString(),
    totalChars,
    totalEstimatedTokens: estimatePromptTokens(totalChars),
    dynamicChars,
    entries,
  };
}

function addMemoryDebugEntry(
  entries: PromptDebugEntry[],
  label: string,
  rawContent: string,
  maxSentChars: number,
  strategy: "stable" | "summary",
  reason: string
) {
  const rawChars = rawContent.length;
  const sentChars = Math.min(rawChars, maxSentChars);
  if (rawChars === 0 && label !== "Nova.md") return;
  entries.push({
    label,
    chars: sentChars,
    rawChars,
    sentChars,
    estimatedTokens: estimatePromptTokens(sentChars),
    dynamic: strategy !== "stable",
    cacheFriendly: strategy === "stable" ? "high" : "medium",
    strategy,
    reason,
  });
}

const CopilotActiveFileContextLabel = React.memo(function CopilotActiveFileContextLabel() {
  const activeFileName = useFileStore((state) => state.activeFile?.name ?? null);
  const { t } = useTranslation();
  return (
    <span>
      {activeFileName ? `${t("copilot.context")}: ${activeFileName}` : t("copilot.noActiveFileContext")}
    </span>
  );
});

const CopilotPanel: React.FC = () => {
  const rootPath = useFileStore((state) => state.rootPath);
  const referenceLists = useFileStore((state) => state.referenceLists);
  const loadReferenceLists = useFileStore((state) => state.loadReferenceLists);
  const refreshLoadedWorkspace = useFileStore((state) => state.refreshLoadedWorkspace);
  const consumeBrowserContexts = useAppUIStore((state) => state.consumeBrowserContexts);
  const browserContextQueueLength = useAppUIStore((state) => state.browserContextQueue.length);
  const { loadBlueprints } = useBlueprintStore();
  const { modelProfiles, defaultChatModelId, defaultEditReviewModelId, getModelProfileById, chatMaxTokens, setChatMaxTokens, contextMaxLength, webSearchLimit } = useSettingsStore();
  const { t } = useTranslation();
  const [conversationSummaries, setConversationSummaries] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationRecord | null>(null);
  const [input, setInput] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<ConversationAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; x: number; y: number } | null>(null);
  const [statusText, setStatusText] = useState("");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isAgentModeMenuOpen, setIsAgentModeMenuOpen] = useState(false);
  const [agentModeMenuPosition, setAgentModeMenuPosition] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const [tempMaxTokens, setTempMaxTokens] = useState(String(chatMaxTokens));
  const [, setFileCaches] = useState<Map<string, FileContentCache>>(new Map());
  const fileCachesRef = useRef<Map<string, FileContentCache>>(new Map());
  const [chatSkills, setChatSkills] = useState<ChatSkills>(DEFAULT_CHAT_SKILLS);
  const [, setWebSearchCount] = useState(0);
  const [currentAssistantText, setCurrentAssistantText] = useState("");
  const [currentAssistantWorkItems, setCurrentAssistantWorkItems] = useState<ConversationWorkItem[]>([]);
  const [clarificationDraftAnswers, setClarificationDraftAnswers] = useState<Record<string, string>>({});
  const [submittedClarificationIds, setSubmittedClarificationIds] = useState<Set<string>>(new Set());
  const [agentTodo, setAgentTodo] = useState<{
    tool: string;
    path: string;
    completedEdits: number;
    totalEdits: number;
    status: "running" | "truncated" | "continuing";
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const agentModeButtonRef = useRef<HTMLButtonElement>(null);
  const lastDefaultChatModelIdRef = useRef(defaultChatModelId);
  const workspaceLoadRequestRef = useRef(0);
  const activeConversationRef = useRef<ConversationRecord | null>(null);
  const draftInputRef = useRef("");
  const inputTextareaRef = useRef<HTMLTextAreaElement>(null);
  const draftSaveTimerRef = useRef<number | null>(null);
  const lastPersistedDraftRef = useRef<{ conversationId: string; value: string } | null>(null);

  const currentModel = useMemo(
    () => getModelProfileById(activeConversation?.modelId || defaultChatModelId),
    [activeConversation?.modelId, defaultChatModelId, getModelProfileById, modelProfiles]
  );
  const editReviewModel = useMemo(
    () => getModelProfileById(defaultEditReviewModelId) || getModelProfileById(defaultChatModelId),
    [defaultChatModelId, defaultEditReviewModelId, getModelProfileById, modelProfiles]
  );
  const activeInputModel = chatSkills.agentMode === "editor" ? editReviewModel : currentModel;

  useEffect(() => {
    activeConversationRef.current = activeConversation;
  }, [activeConversation]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const MAX_FILE_CACHE_SIZE = 10 * 1024 * 1024;

  const shouldCacheFile = (content: string): boolean => {
    return content.length <= MAX_FILE_CACHE_SIZE;
  };

  const getFileSizeWarning = (content: string): string | null => {
    if (content.length > MAX_FILE_CACHE_SIZE) {
      const sizeMB = (content.length / 1024 / 1024).toFixed(2);
      return `文件大小 ${sizeMB}MB 超过缓存限制（10MB），AI将无法追踪此文件的变更`;
    }
    return null;
  };

  const updateFileCache = (filePath: string, content: string) => {
    const newCache = {
      filePath,
      content,
      lastSentAt: new Date().toISOString(),
    };
    // 同步更新 ref
    fileCachesRef.current = new Map(fileCachesRef.current);
    fileCachesRef.current.set(filePath, newCache);
    // 异步更新 state（用于 UI 显示）
    setFileCaches(fileCachesRef.current);
  };

  const calculateChanges = (oldContent: string, newContent: string): FileChange[] => {
    if (oldContent === newContent) return [];

    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    const changes: FileChange[] = [];

    let startLine = 0;
    while (startLine < Math.min(oldLines.length, newLines.length) &&
           oldLines[startLine] === newLines[startLine]) {
      startLine++;
    }

    let endLine = Math.max(oldLines.length, newLines.length);
    while (endLine > startLine &&
           oldLines[endLine - 1] === newLines[endLine - 1]) {
      endLine--;
    }

    if (startLine < endLine) {
      changes.push({
        startLine: startLine + 1,
        endLine,
        oldContent: oldLines.slice(startLine, endLine).join('\n'),
        newContent: newLines.slice(startLine, endLine).join('\n'),
        timestamp: new Date().toISOString(),
      });
    }

    return changes;
  };

  const syncActiveEditorContentForRequest = () => {
    const store = useFileStore.getState();
    const activeFile = store.activeFile;
    if (!activeFile || activeFile.isReadOnly) return store;
    const serializedContent = getEditorSerializedContent();
    if (!serializedContent || serializedContent === activeFile.content) return store;
    store.updateFileContent(activeFile.path, serializedContent);
    return useFileStore.getState();
  };

  const buildMultiFileContext = (): MultiFileContext | undefined => {
    const { activeFile, getOpenTabs } = useFileStore.getState();
    if (!activeFile) return undefined;

    const currentContent = contentToAiReadableText(activeFile.content);
    const currentStats = calculateTextStats(currentContent);

    if (!shouldCacheFile(currentContent)) {
      return {
        activeFile: {
          meta: {
            fileName: activeFile.name,
            filePath: activeFile.path,
            charCount: currentStats.characters,
            lineCount: currentStats.lines,
            wordCount: currentStats.words,
          },
          content: currentContent,
          cachedContent: null,
          recentChanges: [],
        },
        otherBoundFiles: [],
        allBoundFiles: [],
      };
    }

    // 使用 ref 获取最新的缓存
    const activeFileCache = fileCachesRef.current.get(activeFile.path);
    const activeCachedContent = activeFileCache ? contentToAiReadableText(activeFileCache.content) : null;

    const cacheChanges = activeCachedContent
      ? calculateChanges(activeCachedContent, currentContent)
      : [];
    const trackedChanges = useFileStore.getState().getFileChanges(activeFile.path);
    const activeChanges = [...trackedChanges, ...cacheChanges].slice(-8);

    // 同步更新缓存
    updateFileCache(activeFile.path, currentContent);

    // 使用 ref 构建 otherBoundFiles
    const otherBoundFiles = Array.from(fileCachesRef.current.entries())
      .filter(([path]) => path !== activeFile.path)
      .slice(0, 5)
      .map(([path, cache]) => {
        const tab = getOpenTabs().find(t => t.path === path);
        const tabContent = contentToAiReadableText(tab?.content ?? cache.content);
        const tabStats = calculateTextStats(tabContent);

        return {
          meta: {
            fileName: path.split(/[/\\]/).pop() || path,
            filePath: path,
            charCount: tabStats.characters,
            lineCount: tabStats.lines,
            wordCount: tabStats.words,
          },
          recentChanges: [
            ...useFileStore.getState().getFileChanges(path),
            ...calculateChanges(contentToAiReadableText(cache.content), tabContent),
          ].slice(-8),
        };
      });

    // 使用 ref 构建 allBoundFiles
    const allBoundFiles = Array.from(fileCachesRef.current.values()).map(cache => {
      const cacheStats = calculateTextStats(contentToAiReadableText(cache.content));
      return {
        meta: {
          fileName: cache.filePath.split(/[/\\]/).pop() || cache.filePath,
          filePath: cache.filePath,
          charCount: cacheStats.characters,
          lineCount: cacheStats.lines,
          wordCount: cacheStats.words,
        },
        lastUsed: cache.lastSentAt,
      };
    });

    return {
      activeFile: {
        meta: {
          fileName: activeFile.name,
          filePath: activeFile.path,
          charCount: currentStats.characters,
          lineCount: currentStats.lines,
          wordCount: currentStats.words,
        },
        content: currentContent,
        cachedContent: activeCachedContent,
        recentChanges: activeChanges,
      },
      otherBoundFiles,
      allBoundFiles,
    };
  };

  const buildPlannedDocumentContext = (
    requestContent: string,
    multiFileContext: MultiFileContext | undefined,
    conversationHistory: ConversationMessage[],
    forceFull = false
  ): PlannedDocumentContext => {
    const active = multiFileContext?.activeFile;
    const rawContent = active?.content ?? "";
    const recentTurns = conversationHistory
      .slice(-5)
      .map((message) => `${message.role}: ${truncateContextText(message.content, 500)}`)
      .join("\n\n");
    const recentTurnsBlock = recentTurns ? `\n\n## Recent Short History\n${recentTurns}` : "";

    let strategy: ContextStrategy = "none";
    let reason = "No active document context.";
    let body = "";

    if (active) {
      const metaBlock = `## Current File Metadata\nFile: ${active.meta.fileName}\nPath: ${active.meta.filePath}\nStats: ${active.meta.charCount} chars, ${active.meta.lineCount} lines, ${active.meta.wordCount} words`;
      const fullRequested = forceFull || hasExplicitFullContextRequest(requestContent);
      if (fullRequested) {
        strategy = "full";
        reason = forceFull ? "Plan or workflow explicitly requested full context." : "User explicitly requested full-chapter or blueprint-level context.";
        body = `${metaBlock}\n\n## Full Current File\n${rawContent}`;
      } else if (active.recentChanges.length > 0) {
        strategy = "history-delta";
        reason = "Ordinary follow-up uses recent History deltas instead of the full document.";
        body = `${metaBlock}\n\n## Current File History Delta\n${summarizeFileChanges(active.recentChanges)}`;
        const snippet = buildLocalSnippet(rawContent, 1600);
        if (snippet.trim()) {
          body += `\n\n## Local Snippet\n${snippet}`;
        }
      } else if (rawContent.trim()) {
        strategy = "snippet";
        reason = "No recent History delta is available, so a bounded snippet is used.";
        body = `${metaBlock}\n\n## Current File Snippet\n${buildLocalSnippet(rawContent)}`;
      } else {
        strategy = "metadata";
        reason = "The active file is empty or unavailable; only metadata is useful.";
        body = metaBlock;
      }
    }

    const content = `${body}${recentTurnsBlock}`.trim();
    const sentChars = content.length;
    const entries: PromptDebugEntry[] = [
      {
        label: "Stable system / workflow rules",
        chars: 0,
        sentChars: 0,
        estimatedTokens: 0,
        dynamic: false,
        cacheFriendly: "high",
        strategy: "stable",
      },
    ];

    if (active) {
      entries.push({
        label: active.meta.fileName,
        chars: sentChars,
        rawChars: rawContent.length,
        sentChars,
        estimatedTokens: estimatePromptTokens(sentChars),
        dynamic: true,
        cacheFriendly: strategy === "full" ? "low" : strategy === "history-delta" ? "medium" : "high",
        strategy,
        reason,
      });
    } else {
      entries.push({
        label: "Current file",
        chars: 0,
        rawChars: 0,
        sentChars: 0,
        estimatedTokens: 0,
        dynamic: true,
        cacheFriendly: "high",
        strategy,
        reason,
      });
    }

    if (recentTurnsBlock) {
      entries.push({
        label: "Recent 5 turns",
        chars: recentTurnsBlock.length,
        sentChars: recentTurnsBlock.length,
        estimatedTokens: estimatePromptTokens(recentTurnsBlock.length),
        dynamic: true,
        cacheFriendly: "medium",
        strategy: "structured",
      });
    }

    return {
      content,
      strategy,
      reason,
      rawChars: rawContent.length,
      sentChars,
      promptDebug: createPromptDebugBreakdown(entries),
    };
  };

  const clearDraftSaveTimer = () => {
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
  };

  const persistDraftInput = async (
    value = draftInputRef.current,
    conversation = activeConversationRef.current,
    expectedRootPath = rootPath
  ) => {
    if (!conversation) return;
    const normalizedValue = value ?? "";
    const lastPersisted = lastPersistedDraftRef.current;
    if (
      conversation.draftInput === normalizedValue &&
      lastPersisted?.conversationId === conversation.id &&
      lastPersisted.value === normalizedValue
    ) {
      return;
    }

    const updatedAt = new Date().toISOString();
    const record: ConversationRecord = {
      ...conversation,
      draftInput: normalizedValue,
      updatedAt,
    };
    const nextSummaries = await writeConversation(record);
    if (expectedRootPath !== useFileStore.getState().rootPath) return;
    lastPersistedDraftRef.current = { conversationId: record.id, value: normalizedValue };
    setConversationSummaries(nextSummaries);
    setActiveConversation((current) => current?.id === record.id
      ? (() => {
        const next = { ...current, draftInput: normalizedValue, updatedAt };
        activeConversationRef.current = next;
        return next;
      })()
      : current);
  };

  const loadConversation = async (conversationId: string, expectedRootPath = rootPath) => {
    const currentConversation = activeConversationRef.current;
    if (currentConversation && currentConversation.id !== conversationId) {
      clearDraftSaveTimer();
      await persistDraftInput(draftInputRef.current, currentConversation, expectedRootPath);
    }
    const record = await readConversation(conversationId);
    if (expectedRootPath !== useFileStore.getState().rootPath) return;
    if (!record) return;
    const nextDraft = record.draftInput || "";
    draftInputRef.current = nextDraft;
    lastPersistedDraftRef.current = { conversationId: record.id, value: nextDraft };
    activeConversationRef.current = record;
    setActiveConversation(record);
    setInput(nextDraft);
    setDraftAttachments([]);
    setClarificationDraftAnswers({});
    setSubmittedClarificationIds(new Set());
  };

  const persistConversation = async (record: ConversationRecord) => {
    const draftInput = activeConversationRef.current?.id === record.id ? draftInputRef.current : record.draftInput || "";
    const recordToWrite = { ...record, draftInput };
    const nextSummaries = await writeConversation(recordToWrite);
    draftInputRef.current = draftInput;
    lastPersistedDraftRef.current = { conversationId: recordToWrite.id, value: draftInput };
    setConversationSummaries(nextSummaries);
    activeConversationRef.current = recordToWrite;
    setActiveConversation(recordToWrite);
  };

  const persistFileCaches = async () => {
    if (!activeConversation) return;

    const cachesArray = Array.from(fileCachesRef.current.values());
    const updatedRecord = {
      ...activeConversation,
      boundFileCaches: cachesArray,
      updatedAt: new Date().toISOString(),
    };

    await persistConversation(updatedRecord);
  };

  const updateChatSkills = (updater: (current: ChatSkills) => ChatSkills) => {
    setChatSkills((current) => {
      const nextSkills = normalizeChatSkills(updater(current));
      if (activeConversation) {
        const updatedRecord: ConversationRecord = {
          ...activeConversation,
          chatSkills: nextSkills,
          updatedAt: new Date().toISOString(),
        };
        setActiveConversation(updatedRecord);
        void persistConversation(updatedRecord);
      }
      return nextSkills;
    });
  };

  const resetCopilotRuntimeState = () => {
    clearDraftSaveTimer();
    const emptyCaches = new Map<string, FileContentCache>();
    fileCachesRef.current = emptyCaches;
    setFileCaches(emptyCaches);
    setConversationSummaries([]);
    setActiveConversation(null);
    activeConversationRef.current = null;
    draftInputRef.current = "";
    lastPersistedDraftRef.current = null;
    setInput("");
    setDraftAttachments([]);
    setCurrentAssistantText("");
    setCurrentAssistantWorkItems([]);
    setClarificationDraftAnswers({});
    setSubmittedClarificationIds(new Set());
    setAgentTodo(null);
    setIsLoading(false);
    setIsAgentModeMenuOpen(false);
  };

  useEffect(() => {
    const conversationId = activeConversation?.id;
    if (!conversationId || isLoading) return;
    if (lastPersistedDraftRef.current?.conversationId === conversationId && lastPersistedDraftRef.current.value === input) return;

    clearDraftSaveTimer();
    draftSaveTimerRef.current = window.setTimeout(() => {
      const currentConversation = activeConversationRef.current;
      if (!currentConversation || currentConversation.id !== conversationId) return;
      void persistDraftInput(input, currentConversation);
    }, 650);

    return clearDraftSaveTimer;
  }, [activeConversation?.id, input, isLoading]);

  useEffect(() => {
    return clearDraftSaveTimer;
  }, []);

  useEffect(() => {
    if (!activeConversation || !defaultChatModelId) {
      lastDefaultChatModelIdRef.current = defaultChatModelId;
      return;
    }

    const defaultModelChanged = lastDefaultChatModelIdRef.current !== defaultChatModelId;
    lastDefaultChatModelIdRef.current = defaultChatModelId;

    const selectedModelExists =
      !activeConversation.modelId || modelProfiles.some((profile) => profile.id === activeConversation.modelId);

    if ((!defaultModelChanged && selectedModelExists) || activeConversation.modelId === defaultChatModelId) {
      return;
    }

    void persistConversation({
      ...activeConversation,
      modelId: defaultChatModelId,
      updatedAt: new Date().toISOString(),
    });
  }, [activeConversation?.id, activeConversation?.modelId, defaultChatModelId, modelProfiles]);

  useEffect(() => {
    scrollToBottom();
  }, [activeConversation?.messages, isLoading]);

  useEffect(() => {
    if (activeConversation?.boundFileCaches) {
      const cachesMap = new Map<string, FileContentCache>();
      activeConversation.boundFileCaches.forEach(cache => {
        if (isPathInsideRoot(cache.filePath, rootPath)) {
          cachesMap.set(cache.filePath, cache);
        }
      });
      fileCachesRef.current = cachesMap;
      setFileCaches(cachesMap);
    } else {
      const emptyCaches = new Map<string, FileContentCache>();
      fileCachesRef.current = emptyCaches;
      setFileCaches(emptyCaches);
    }
  }, [activeConversation?.id, rootPath]);

  useEffect(() => {
    if (activeConversation?.chatSkills) {
      setChatSkills(normalizeChatSkills(activeConversation.chatSkills));
    } else {
      setChatSkills(DEFAULT_CHAT_SKILLS);
    }
  }, [activeConversation?.id]);

  useEffect(() => {
    const queuedContexts = consumeBrowserContexts();
    if (queuedContexts.length === 0) return;

    let nextInput = draftInputRef.current.trim();
    for (const detail of queuedContexts) {
      if (!detail?.url) continue;
      const selection = detail.selection?.trim();
      const sourceLabel = detail.source === "system-browser" ? "系统浏览器" : "Nova 内置浏览器";
      const contextText = [
        "请参考当前网页：",
        `来源：${sourceLabel}`,
        `标题：${detail.title || "未命名网页"}`,
        `URL：${detail.url}`,
        selection ? `选中文本：\n${selection}` : "页面说明：用户未选择具体文本，请只根据标题和 URL 判断是否需要继续询问或联网检索。",
      ].join("\n");
      nextInput = nextInput ? `${nextInput}\n\n${contextText}` : contextText;
    }

    draftInputRef.current = nextInput;
    setInput(nextInput);
  }, [browserContextQueueLength, consumeBrowserContexts]);

  useEffect(() => {
    workspaceLoadRequestRef.current += 1;
    const requestId = workspaceLoadRequestRef.current;
    resetCopilotRuntimeState();

    const bootstrap = async () => {
      if (!rootPath) {
        setStatusText(t("copilot.openWorkspace"));
        return;
      }

      try {
        await ensureWorkspaceConversationStore();
        await ensureMemoryFiles();
        const summaries = await listConversationSummaries();
        if (requestId !== workspaceLoadRequestRef.current || rootPath !== useFileStore.getState().rootPath) return;
        setConversationSummaries(summaries);
        if (summaries[0]) {
          await loadConversation(summaries[0].id, rootPath);
          if (requestId !== workspaceLoadRequestRef.current || rootPath !== useFileStore.getState().rootPath) return;
          return;
        }

        const draft = createConversation(defaultChatModelId, useFileStore.getState().activeFile?.path);
        if (requestId !== workspaceLoadRequestRef.current || rootPath !== useFileStore.getState().rootPath) return;
        setActiveConversation(draft);
      } catch (error) {
        if (requestId !== workspaceLoadRequestRef.current) return;
        setStatusText(error instanceof Error ? error.message : "Failed to load conversations.");
      }
    };

    void bootstrap();
  }, [defaultChatModelId, rootPath]);

  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      if (!text) {
        setSelectionToolbar(null);
        return;
      }

      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range) {
        setSelectionToolbar(null);
        return;
      }

      const container = range.commonAncestorContainer;
      const parentElement = container instanceof Element ? container : container.parentElement;
      const messageNode = parentElement?.closest(".message-text");
      if (!messageNode) {
        setSelectionToolbar(null);
        return;
      }

      const rect = range.getBoundingClientRect();
      setSelectionToolbar({
        text,
        x: rect.left + rect.width / 2,
        y: rect.top - 8,
      });
    };

    document.addEventListener("mouseup", handleMouseUp);
    return () => document.removeEventListener("mouseup", handleMouseUp);
  }, []);

  const handleNewConversation = async () => {
    clearDraftSaveTimer();
    await persistDraftInput(draftInputRef.current, activeConversationRef.current);
    const next = createConversation(defaultChatModelId, useFileStore.getState().activeFile?.path);
    draftInputRef.current = "";
    lastPersistedDraftRef.current = { conversationId: next.id, value: "" };
    activeConversationRef.current = next;
    setActiveConversation(next);
    setInput("");
    setDraftAttachments([]);
    setStatusText("");
    await persistConversation(next);
  };

  const handleSendMessage = async (override?: {
    content: string;
    attachments?: ConversationAttachment[];
    skills?: ChatSkills;
    clearPendingPlan?: boolean;
    conversation?: ConversationRecord;
    answeredClarification?: {
      messageId: string;
      answers: Array<{ questionId: string; question: string; answer: string }>;
    };
  }) => {
    const messageContent = (override?.content ?? input).trim();
    const requestAttachments = override?.attachments ?? draftAttachments;
    const targetConversation = override?.conversation ?? activeConversation;
    let requestSkills = normalizeChatSkills(override?.skills ?? chatSkills);
    const forceCreateFile = shouldForceCreateFile(messageContent);
    const defaultChapterToDocx = shouldDefaultChapterToDocx(messageContent);
    if (!override) {
      const hasPendingClarification = Boolean(activeConversation?.pendingClarification);
      const needPlan = requestSkills.agentMode === "editor" ? false : shouldNeedPlan(messageContent, requestSkills.agentMode);
      requestSkills = {
        ...requestSkills,
        agentSubMode: requestSkills.agentMode === "editor"
          ? "build"
          : requestSkills.forcePlanMode || hasPendingClarification
          ? "plan"
          : forceCreateFile ? "build" : needPlan ? "plan" : "build",
      };
    }
    const requestModel = requestSkills.agentMode === "editor" ? editReviewModel : currentModel;
    if (!messageContent || !targetConversation || !requestModel || isLoading) return;
    clearDraftSaveTimer();
    if (!override) draftInputRef.current = "";
    const rootPathAtStart = rootPath;
    const isWorkspaceCurrent = () => rootPathAtStart === useFileStore.getState().rootPath;

    // 重置搜索计数
    setWebSearchCount(0);

    const userMessage: ConversationMessage = {
      id: createId("msg"),
      role: "user",
      content: messageContent,
      createdAt: new Date().toISOString(),
      attachments: requestAttachments,
      skills: requestSkills,
    };

    const baseMessages = override?.answeredClarification
      ? targetConversation.messages.map((message) => message.id === override.answeredClarification?.messageId
          ? { ...message, clarificationAnswers: override.answeredClarification.answers }
          : message)
      : targetConversation.messages;
    const nextMessages = [...baseMessages, userMessage];
    const pendingClarification = !override || override.answeredClarification
      ? targetConversation.pendingClarification ?? null
      : null;
    const nextPendingClarification = targetConversation.pendingClarification && override?.answeredClarification?.messageId === targetConversation.pendingClarification.messageId
      ? {
          ...targetConversation.pendingClarification,
          answers: override.answeredClarification.answers,
        }
      : targetConversation.pendingClarification ?? null;
    const requestFileSnapshot = syncActiveEditorContentForRequest();
    const draftRecord: ConversationRecord = {
      ...targetConversation,
      title: targetConversation.messages.length === 0 ? targetConversation.title || buildTitleFromMessage(userMessage.content) : targetConversation.title,
      updatedAt: new Date().toISOString(),
      contextFilePath: requestFileSnapshot.activeFile?.path ?? targetConversation.contextFilePath ?? null,
      messages: nextMessages,
      draftInput: "",
      pendingPlan: override?.clearPendingPlan ? null : targetConversation.pendingPlan ?? null,
      pendingClarification: nextPendingClarification,
    };

    if (!override) {
      setInput("");
      setDraftAttachments([]);
    }
    setIsLoading(true);
    setStatusText("");
    setCurrentAssistantText("");
    setCurrentAssistantWorkItems([]);
    const fileSnapshotAtStart = requestFileSnapshot;
    const activeFileAtStart = fileSnapshotAtStart.activeFile;
    const filesAtStart = fileSnapshotAtStart.files;
    await persistConversation(draftRecord);
    if (!isWorkspaceCurrent()) return;

    try {
      const assistantTextParts: string[] = [];
      let workItems: ConversationWorkItem[] = [];
      let requestSearchCount = 0;
      const appendAssistantText = (text: string) => {
        const cleaned = stripToolCalls(text);
        if (!cleaned) return;
        if (assistantTextParts[assistantTextParts.length - 1] === cleaned) return;
        assistantTextParts.push(cleaned);
        setCurrentAssistantText(assistantTextParts.join("\n\n"));
      };
      const appendWorkItem = (item: ConversationWorkItem) => {
        workItems = [...workItems, item];
        setCurrentAssistantWorkItems(workItems);
      };
      const updateWorkItem = (id: string, patch: Partial<ConversationWorkItem>) => {
        workItems = workItems.map((item) => item.id === id ? { ...item, ...patch } : item);
        setCurrentAssistantWorkItems(workItems);
      };

      const fileSizeWarning = activeFileAtStart ? getFileSizeWarning(activeFileAtStart.content) : null;
      if (fileSizeWarning) {
        setStatusText(fileSizeWarning);
      }

      if (requestSkills.agentMode === "editor") {
        const editorMemoryContext = await loadMemoryContext({
          includeStableProjectMemory: true,
          includeAuthorProjectMemory: true,
          includeShortTermMemory: true,
          includeCacheMemory: true,
        });
        const referenceContext = [
          buildMemoryPrompt(editorMemoryContext),
          serializeReferenceListsForReview(referenceLists),
        ].filter(Boolean).join("\n\n");
        const targetContent = getEditorContent() || (activeFileAtStart ? contentToAiReadableText(activeFileAtStart.content) : "");
        const startedAt = performance.now();
        setStatusText("AI编辑审核中...");
        const editorResponse = await callEditorRoleReview({
          modelProfile: requestModel,
          userInstruction: userMessage.content,
          targetContent,
          filePath: activeFileAtStart?.path,
          referenceContext,
          maxTokens: Math.min(Math.max(chatMaxTokens, 1024), 4096),
        });
        if (!isWorkspaceCurrent()) return;
        const assistantMessage: ConversationMessage = {
          id: createId("msg"),
          role: "assistant",
          content: editorResponse || "编辑审核未返回内容。",
          createdAt: new Date().toISOString(),
          editReviewDebug: {
            ...createEditReviewDebug(true),
            triggered: true,
            modelLabel: requestModel.label,
            modelId: requestModel.id,
            filePath: activeFileAtStart?.path,
            editCount: 1,
            reviewedCount: 1,
            originalChars: targetContent.length,
            reviewedChars: editorResponse.length,
            durationMs: Math.round(performance.now() - startedAt),
          },
        };
        const finalRecord: ConversationRecord = {
          ...draftRecord,
          updatedAt: new Date().toISOString(),
          messages: [...draftRecord.messages, assistantMessage],
          chatSkills: requestSkills,
          pendingPlan: null,
        };
        await persistConversation(finalRecord);
        return;
      }

      const multiFileContext = buildMultiFileContext();
      const plannedContext = buildPlannedDocumentContext(
        userMessage.content,
        multiFileContext,
        nextMessages.slice(-6, -1)
      );

      // 构建目录结构字符串
      const directoryTree = buildDirectoryTreeString(filesAtStart);
      const shouldRequestPlan =
        !override && requestSkills.agentSubMode === "plan";
      const memoryContext = await loadMemoryContext({
        includeStableProjectMemory: true,
        includeAuthorProjectMemory: false,
        includeShortTermMemory: false,
        includeCacheMemory: false,
      });
      const memoryPrompt = buildMemoryPrompt(memoryContext);
      const relevantReferenceContext = buildRelevantReferenceContext(referenceLists, userMessage.content, plannedContext.content);
      const runtimeContext = [
        memoryPrompt,
        relevantReferenceContext ? `## Relevant Reference Entries\n${relevantReferenceContext}` : "",
      ].filter(Boolean).join("\n\n");
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "Nova.md",
        memoryContext.globalHabits,
        memoryContext.globalHabits.length,
        "stable",
        "Durable global user preferences."
      );
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "AuthorTemplate.md",
        memoryContext.authorTemplate,
        1800,
        "stable",
        "Author philosophy, theology, desire, why this novel exists, and novel core."
      );
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "ProseStyle.md",
        memoryContext.proseStyle,
        1800,
        "stable",
        "Prose rhythm, POV, sentence habits, dialogue habits, and avoided patterns."
      );
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "DescriptionStats.md",
        memoryContext.descriptionStats,
        2000,
        "stable",
        "Scene, time, and character description habits with usage counts."
      );
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "StoryDatabase.md",
        memoryContext.storyDatabase,
        2400,
        "stable",
        "Static people, geography, factions, items, effects, owners, and backstory."
      );
      addMemoryDebugEntry(
        plannedContext.promptDebug.entries,
        "RealtimeDatabase.md",
        memoryContext.realtimeDatabase,
        2200,
        "stable",
        "Changing holders, locations, relationship/faction states, and time-node state."
      );
      if (relevantReferenceContext) {
        plannedContext.promptDebug.entries.push({
          label: "Relevant reference entries",
          chars: relevantReferenceContext.length,
          sentChars: relevantReferenceContext.length,
          estimatedTokens: estimatePromptTokens(relevantReferenceContext.length),
          dynamic: true,
          cacheFriendly: "medium",
          strategy: "structured",
          reason: "Matched reference database entries for this request/document.",
        });
      }
      plannedContext.promptDebug = createPromptDebugBreakdown(plannedContext.promptDebug.entries);

      if (shouldRequestPlan) {
        const planSkills: ChatSkills = {
          ...requestSkills,
          agentSubMode: "plan",
        };
        const basePlanRequest = pendingClarification
          ? `The user is answering a previous clarification question. Continue planning from the original request and the new answer.\n\n## Original Request\n${pendingClarification.userMessage.content}\n\n## Clarification Question\n${pendingClarification.promptContent}\n\n## User Answer\n${userMessage.content}\n\nNow produce the formal plan if enough information is available. If information is still missing, output a new "## Clarification Needed" section and ask only the missing questions.`
          : userMessage.content;
        const architectPlanRequest = requestSkills.agentMode === "architect"
          ? `\n\n## Architect Plan Protocol\n- First clarify AuthorTemplate: philosophy, theology, desire, why this novel exists, and novel core.\n- If the author core, premise, rebuild direction, or database scope is not clear enough, output exactly "## Clarification Needed" followed by the supported JSON questions object. Do not output a plan in the same message.\n- If this is a rebuild/start-over request (${isArchitectRebuildRequest(basePlanRequest) ? "yes" : "no"}), do not preserve old worldbuilding by default. Ask again what to keep or discard, the new core genre/direction, protagonist vs ensemble preference, author core, and desired prose texture.\n- Once enough answers exist, output a change plan with: 作者模板判断, 当前信息缺口, 旧设定保留/废弃清单, 新方向设计原则, 蓝图改动, StoryDatabase/RealtimeDatabase 改动, ProseStyle/DescriptionStats 改动, and suggested Memory Candidate targets.\n- Do not write chapter prose or modify files in Architect plan mode.`
          : "";
        const planRequest = `${basePlanRequest}\n\nNeedPlan 已触发。请先输出执行计划，等待用户确认后再生成蓝图、正文或修改文件。现在不要写文件。\n\nIf essential information is missing, do not pretend this is a plan. Output exactly a "## Clarification Needed" section with the questions instead.${architectPlanRequest}`;

        const planResponse = await callAI({
          modelProfile: requestModel,
          taskType: "chat",
          userMessage: planRequest,
          documentContext: plannedContext.content,
          documentFileName: activeFileAtStart?.name,
          maxTokens: chatMaxTokens,
          conversationHistory: nextMessages.slice(-6, -1),
          attachments: requestAttachments,
          multiFileContext,
          contextMaxLength,
          skills: planSkills,
          workspaceRoot: rootPath ?? undefined,
          directoryTree,
          memoryContext: runtimeContext,
        });
        if (!isWorkspaceCurrent()) return;

        const assistantMessage: ConversationMessage = {
          id: createId("msg"),
          role: "assistant",
          content: stripToolCalls(planResponse),
          createdAt: new Date().toISOString(),
          promptDebug: plannedContext.promptDebug,
        };
        const isClarification = isClarificationResponse(assistantMessage.content);
        const clarificationQuestions = parseClarificationQuestions(assistantMessage.content);
        const finalPlanSkills: ChatSkills = isClarification
          ? planSkills
          : {
              ...planSkills,
              forcePlanMode: false,
            };
        const finalRecord: ConversationRecord = {
          ...draftRecord,
          updatedAt: new Date().toISOString(),
          messages: [...draftRecord.messages, assistantMessage],
          chatSkills: finalPlanSkills,
          pendingClarification: isClarification
            ? {
                messageId: assistantMessage.id,
                userMessage: pendingClarification?.userMessage ?? userMessage,
                promptContent: assistantMessage.content,
                agentMode: requestSkills.agentMode,
                createdAt: new Date().toISOString(),
                questions: clarificationQuestions,
                currentIndex: 0,
                answers: [],
              }
            : null,
          pendingPlan: isClarification
            ? null
            : {
                planMessageId: assistantMessage.id,
                userMessage: pendingClarification?.userMessage ?? userMessage,
                planContent: assistantMessage.content,
                agentMode: requestSkills.agentMode,
                createdAt: new Date().toISOString(),
              },
        };
        await persistConversation(finalRecord);
        setChatSkills(finalPlanSkills);
        return;
      }

      const withCreateFileDirective = (content: string) => {
        if (!forceCreateFile) return content;
        return `${content}\n\n## 文件创建强制要求\n用户这次要求实际创建/保存文件。你必须在本轮输出 create_file 工具调用，不能只输出正文，不能只说“我会创建”。${defaultChapterToDocx ? "这是章节正文创建请求；如果用户没有明确指定 .md/.txt/.docx，文件路径必须使用 .docx。" : ""}如果之前已经写出正文但没有创建文件，本轮优先补 create_file。`;
      };
      const withCharacterDualWriteDirective = (content: string) => {
        if (!isCharacterSheetRequest(content)) return content;
        return `${content}\n\n## 人设双写强制要求\n这次涉及创建或更新人物/角色/人设。你必须同时完成两类写入：\n1. 先调用 upsert_reference_entries，listName 必须使用 "人物"，body 必须包含 current_desire/current_fear/current_emotion/current_bias。\n2. 再调用 create_file 或 edit_file 写入人类可读的 .md 人设档案。\n不能只写 .md，也不能只写参考条目数据库。`;
      };

      let response = await callAI({
        modelProfile: requestModel,
        taskType: "chat",
        userMessage: override?.clearPendingPlan
          ? withCharacterDualWriteDirective(`用户已确认以下计划，请直接按计划执行，不要重新制定计划。若计划已经给出明确文件、位置和插入文本，请优先调用对应写入工具，不要为了重复确认而重读全文。执行完成后简要说明结果；只有项目状态确实变化时才输出 Memory Candidate。\n\n## 原始需求\n${targetConversation.pendingPlan?.userMessage.content ?? userMessage.content}\n\n## 已确认计划\n${targetConversation.pendingPlan?.planContent ?? ""}\n\n## 本次指令\n${userMessage.content}`)
          : withCharacterDualWriteDirective(withCreateFileDirective(userMessage.content)),
        documentContext: plannedContext.content,
        documentFileName: activeFileAtStart?.name,
        maxTokens: undefined,
        conversationHistory: nextMessages.slice(-6, -1),
        attachments: requestAttachments,
        multiFileContext,
        contextMaxLength,
        skills: requestSkills,
        workspaceRoot: rootPath ?? undefined,
        directoryTree,
        memoryContext: runtimeContext,
      });
      if (!isWorkspaceCurrent()) return;

      // 实现多轮工具调用循环
      let currentResponse = response;
      const maxIterations = 100;
      const WRITE_TOOLS = new Set(["edit_file", "edit_docx", "create_file", "create_blueprint", "upsert_reference_entries"]);
      let hasSuccessfulCreateFile = false;
      let hasSuccessfulCharacterMdWrite = false;
      let hasSuccessfulReferenceUpsert = false;
      let createFileRecoveryAttempted = false;
      let characterDualWriteRecoveryAttempted = false;

      const extractToolCalls = extractToolCallsFromText;

      const isLikelyCompleteJson = (s: string): boolean => {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (const ch of s) {
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') inString = !inString;
          if (!inString) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
          }
        }
        return depth === 0 && !inString;
      };

      const extractField = (json: string, fieldName: string): string => {
        const match = new RegExp(`"${fieldName}"\\s*:\\s*"`).exec(json);
        if (!match) return '';
        const valueStart = match.index + match[0].length;
        let endIdx = valueStart;
        while (endIdx < json.length) {
          if (json[endIdx] === '\\') {
            endIdx += 2;
            continue;
          }
          if (json[endIdx] === '"') break;
          endIdx++;
        }
        return json.substring(valueStart, endIdx)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      };

      const parseToolCall = (json: string): { name: string; args: Record<string, unknown> } | null => {
        try {
          const parsed = JSON.parse(json);
          const parsedName = parsed.name ?? parsed.tool;
          if (!parsedName) return null;
          return { name: String(parsedName), args: parsed.arguments ?? parsed.args ?? {} };
        } catch {
          // Fallback below handles truncated or malformed tool calls.
        }

        const name = extractField(json, 'name') || extractField(json, 'tool');
        if (!name) return null;

        const path = extractField(json, 'path');

        if (name === 'edit_file' && !/"arguments"\s*:|\"args\"\s*:/.test(json)) {
          const editsMatch = json.match(/"edits"\s*:\s*\[/);
          if (!editsMatch) return { name, args: { path, edits: [] } };

          const editsStart = editsMatch.index! + editsMatch[0].length;
          const editsJson = json.substring(editsStart);
          const edits: Array<{ startLine: number; endLine: number; newContent: string }> = [];

          const editRegex = /\{\s*"startLine"\s*:\s*(\d+)\s*,\s*"endLine"\s*:\s*(\d+)\s*,\s*"newContent"\s*:\s*"/g;
          let editMatch;
          while ((editMatch = editRegex.exec(editsJson)) !== null) {
            const startLine = parseInt(editMatch[1], 10);
            const endLine = parseInt(editMatch[2], 10);
            const contentStart = editMatch.index + editMatch[0].length;
            let contentEnd = contentStart;
            while (contentEnd < editsJson.length) {
              if (editsJson[contentEnd] === '\\') {
                contentEnd += 2;
                continue;
              }
              if (editsJson[contentEnd] === '"') break;
              contentEnd++;
            }
            const newContent = editsJson.substring(contentStart, contentEnd)
              .replace(/\\n/g, '\n')
              .replace(/\\r/g, '\r')
              .replace(/\\t/g, '\t')
              .replace(/\\"/g, '"')
              .replace(/\\\\/g, '\\');
            edits.push({ startLine, endLine, newContent });
          }
          return { name, args: { path, edits } };
        }

        if (name === 'create_file') {
          const content = extractField(json, 'content');
          return { name, args: { path, content } };
        }
        return { name, args: { path } };
      };

      const extractPartialEditFile = (json: string): {
        path: string;
        completedEdits: Array<{ startLine: number; endLine: number; newContent: string }>;
        lastPartialEdit: { startLine: number; endLine: number; partialContent: string } | null;
        estimatedTotalEdits: number;
      } | null => {
        const path = extractField(json, 'path');
        if (!path) return null;

        const editsMatch = json.match(/"edits"\s*:\s*\[/);
        if (!editsMatch) return { path, completedEdits: [], lastPartialEdit: null, estimatedTotalEdits: 0 };

        const editsStart = editsMatch.index! + editsMatch[0].length;
        const editsJson = json.substring(editsStart);
        const completedEdits: Array<{ startLine: number; endLine: number; newContent: string }> = [];

        const editRegex = /\{\s*"startLine"\s*:\s*(\d+)\s*,\s*"endLine"\s*:\s*(\d+)\s*,\s*"newContent"\s*:\s*"/g;
        let editMatch;
        while ((editMatch = editRegex.exec(editsJson)) !== null) {
          const startLine = parseInt(editMatch[1], 10);
          const endLine = parseInt(editMatch[2], 10);
          const contentStart = editMatch.index + editMatch[0].length;
          let contentEnd = contentStart;
          while (contentEnd < editsJson.length) {
            if (editsJson[contentEnd] === '\\') { contentEnd += 2; continue; }
            if (editsJson[contentEnd] === '"') break;
            contentEnd++;
          }

          if (contentEnd < editsJson.length) {
            const newContent = editsJson.substring(contentStart, contentEnd)
              .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
              .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            completedEdits.push({ startLine, endLine, newContent });
          } else {
            return {
              path,
              completedEdits,
              lastPartialEdit: { startLine, endLine, partialContent: editsJson.substring(contentStart) },
              estimatedTotalEdits: completedEdits.length + 1
            };
          }
        }

        return { path, completedEdits, lastPartialEdit: null, estimatedTotalEdits: completedEdits.length };
      };

      const handleWriteToolSuccess = async (name: string, result: string, fallbackPath: string) => {
        const metadata = parseWriteToolMetadata(result);
        const relativePath = metadata?.relativePath ?? normalizeWorkspacePath(fallbackPath);
        const absolutePath = metadata?.absolutePath ?? (rootPath && relativePath ? joinWorkspacePath(rootPath, relativePath) : "");
        if (!relativePath || !absolutePath) return;
        const previousContent = fileCachesRef.current.get(absolutePath)?.content
          ?? (activeFileAtStart?.path === absolutePath ? activeFileAtStart.content : "");

        await refreshLoadedWorkspace(absolutePath);

        const latestStore = useFileStore.getState();
        await latestStore.recordExternalFileSnapshot(absolutePath, "manual").catch(() => undefined);
        const node = findWorkspaceNode(latestStore.files, absolutePath);
        if (node?.type === "file") {
          await latestStore.openFile(absolutePath, latestStore.activeGroupId);
          const openedTab = useFileStore.getState().getOpenTabs().find((tab) => tab.path === absolutePath);
          if (openedTab) {
            if (previousContent !== openedTab.content) {
              useFileStore.getState().trackFileChange(absolutePath, previousContent, openedTab.content);
            }
            updateFileCache(absolutePath, openedTab.content);
          }
          setStatusText(`${name === "create_file" ? "已创建" : "已更新"}：${relativePath}`);
          return;
        }

        setStatusText(`文件已写入 ${absolutePath}，但工作区树未刷新到该路径`);
      };

      const MAX_EDIT_REVIEW_CONTENT_LENGTH = 8000;
      const editReviewDebug = createEditReviewDebug(requestSkills.enableEditReview);
      if (requestSkills.agentSubMode === "plan") {
        addEditReviewDebugReason(editReviewDebug.skipReasons, "Plan mode skips edit_file auto review.");
      }
      const reviewEditFileArgs = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const startedAt = performance.now();
        if (requestSkills.agentSubMode === "plan") {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "Plan mode skips edit_file auto review.");
          return args;
        }
        if (!requestSkills.enableEditReview) {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "Auto review is disabled.");
          return args;
        }
        const path = typeof args.path === "string" ? args.path : "";
        const edits = args.edits;
        if (!path || !Array.isArray(edits) || edits.length === 0) {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "edit_file args are missing path or edits.");
          return args;
        }
        if (isInternalWorkspaceDataPath(path)) {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "Internal .novel-assistance files skip edit review.");
          editReviewDebug.skippedCount += edits.length;
          return args;
        }
        editReviewDebug.editCount += edits.length;
        editReviewDebug.filePath = path;
        editReviewDebug.modelLabel = editReviewModel?.label;
        editReviewDebug.modelId = editReviewModel?.id;
        if (!rootPath || !editReviewModel) {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "Workspace or edit review model is unavailable.");
          editReviewDebug.skippedCount += edits.length;
          return args;
        }

        let originalContent = "";
        try {
          originalContent = await readFile(joinWorkspacePath(rootPath, path));
        } catch {
          addEditReviewDebugReason(editReviewDebug.skipReasons, "Could not read original file content.");
          editReviewDebug.skippedCount += edits.length;
          return args;
        }
        if (!isWorkspaceCurrent()) return args;

        const originalLines = originalContent.split("\n");
        const reviewedEdits = [];

        for (const edit of edits) {
          if (!edit || typeof edit !== "object") {
            reviewedEdits.push(edit);
            continue;
          }

          const typedEdit = edit as { startLine?: unknown; endLine?: unknown; newContent?: unknown };
          const newContent = typeof typedEdit.newContent === "string" ? typedEdit.newContent : "";
          if (!newContent.trim() || newContent.length > MAX_EDIT_REVIEW_CONTENT_LENGTH) {
            addEditReviewDebugReason(editReviewDebug.skipReasons, !newContent.trim() ? "Empty edit content skipped." : "Edit content exceeds auto review length limit.");
            editReviewDebug.skippedCount += 1;
            reviewedEdits.push(edit);
            continue;
          }

          const startLine = Number(typedEdit.startLine);
          const endLine = Number(typedEdit.endLine);
          const originalSnippet = Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine
            ? originalLines.slice(startLine - 1, endLine).join("\n")
            : "";

          try {
            editReviewDebug.triggered = true;
            editReviewDebug.originalChars += newContent.length;
            setStatusText(`AI编辑审核中：${path}`);
            const reviewedContent = await reviewEditFileContent({
              modelProfile: editReviewModel,
              filePath: path,
              originalContent: originalSnippet,
              proposedContent: newContent,
              referenceContext: serializeReferenceListsForReview(referenceLists),
              maxTokens: Math.min(Math.max(chatMaxTokens, 1024), 4096),
            });
            if (!isWorkspaceCurrent()) return args;
            const finalContent = reviewedContent.trim() ? reviewedContent : newContent;
            reviewedEdits.push({
              ...typedEdit,
              newContent: finalContent,
            });
            editReviewDebug.reviewedCount += 1;
            editReviewDebug.reviewedChars += finalContent.length;
          } catch {
            addEditReviewDebugReason(editReviewDebug.fallbackReasons, "Review model failed; original edit content was used.");
            editReviewDebug.skippedCount += 1;
            reviewedEdits.push(edit);
          }
        }
        editReviewDebug.durationMs += Math.round(performance.now() - startedAt);

        return {
          ...args,
          edits: reviewedEdits,
        };
      };

      const MAX_CONTINUATION_RETRIES = 3;
      let continuationCount = 0;
      let toolFormatRetryCount = 0;
      let readFileCount = 0;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (!isWorkspaceCurrent()) return;
        const extractedCalls = extractToolCalls(currentResponse);
        if (extractedCalls.length === 0 || !rootPath) {
          const needsCharacterDualWrite = isCharacterSheetRequest(userMessage.content)
            || isCharacterSheetRequest(targetConversation.pendingPlan?.userMessage.content ?? "")
            || isCharacterSheetRequest(targetConversation.pendingPlan?.planContent ?? "")
            || hasSuccessfulCharacterMdWrite
            || hasSuccessfulReferenceUpsert;
          if (
            rootPath
            && needsCharacterDualWrite
            && (!hasSuccessfulReferenceUpsert || !hasSuccessfulCharacterMdWrite)
            && !characterDualWriteRecoveryAttempted
          ) {
            appendAssistantText(currentResponse);
            characterDualWriteRecoveryAttempted = true;
            const missingParts = [
              !hasSuccessfulReferenceUpsert ? "upsert_reference_entries 写入人物参考条目数据库" : "",
              !hasSuccessfulCharacterMdWrite ? "create_file 或 edit_file 写入 .md 人设档案" : "",
            ].filter(Boolean).join(" 和 ");
            setStatusText("人设需要数据库和 md 双写，正在要求 AI 补齐...");
            currentResponse = await callAI({
              modelProfile: requestModel,
              taskType: "chat",
              userMessage: `上一轮涉及人物/角色/人设，但没有完成数据库和 .md 双写。请现在只输出缺失的工具调用，补齐：${missingParts}。\n\n要求：\n- 数据库工具必须使用 upsert_reference_entries，listName 使用 "人物"，items[].body 必须包含 current_desire/current_fear/current_emotion/current_bias。\n- .md 档案必须使用工作区相对路径，建议放在 Settings/Characters/ 或使用清晰的 角色-姓名.md。\n- 不要输出解释文字，只输出必要的 fenced tool_call JSON。`,
              documentContext: plannedContext.content,
              documentFileName: activeFileAtStart?.name,
              maxTokens: undefined,
              conversationHistory: nextMessages.slice(-6, -1),
              attachments: requestAttachments,
              multiFileContext,
              contextMaxLength,
              skills: requestSkills,
              workspaceRoot: rootPath ?? undefined,
              directoryTree: directoryTree,
              memoryContext: runtimeContext,
            });
            if (!isWorkspaceCurrent()) return;
            continue;
          }
          if (rootPath && forceCreateFile && !hasSuccessfulCreateFile && !createFileRecoveryAttempted) {
            appendAssistantText(currentResponse);
            createFileRecoveryAttempted = true;
            setStatusText("需要实际创建文件，正在要求 AI 补充 create_file...");
            currentResponse = await callAI({
              modelProfile: requestModel,
              taskType: "chat",
              userMessage: withCreateFileDirective(`用户要求实际创建或保存文件，但你上一轮没有调用 create_file。请现在只输出必要的 create_file 工具调用，path 使用工作区相对路径，content 使用完整正文纯文本。${defaultChapterToDocx ? "这是章节正文文件，除非用户明确指定其他扩展名，否则必须使用 .docx。" : ""}`),
              documentContext: plannedContext.content,
              documentFileName: activeFileAtStart?.name,
              maxTokens: undefined,
              conversationHistory: nextMessages.slice(-6, -1),
              attachments: requestAttachments,
              multiFileContext,
              contextMaxLength,
              skills: requestSkills,
              workspaceRoot: rootPath ?? undefined,
              directoryTree: directoryTree,
              memoryContext: runtimeContext,
            });
            if (!isWorkspaceCurrent()) return;
            continue;
          }
          break;
        }
        const visibleBeforeTools = stripToolCalls(currentResponse);
        if (visibleBeforeTools && !extractedCalls.some((call) => WRITE_TOOLS.has((parseToolCall(call.json)?.name ?? "")))) {
          appendAssistantText(visibleBeforeTools);
        }

        const toolResults: Array<{ name: string; result: string }> = [];

        for (const call of extractedCalls) {
          if (!isWorkspaceCurrent()) return;
          if (!isLikelyCompleteJson(call.json)) {
            console.warn("tool_call incomplete, attempting continuation:", call.json.substring(0, 100));

            if (continuationCount >= MAX_CONTINUATION_RETRIES) {
              console.warn("Max continuation retries reached, skipping");
              setAgentTodo(null);
              currentResponse = currentResponse.replace(call.fullMatch, "");
              continue;
            }

            const partial = extractPartialEditFile(call.json);
            if (partial && partial.completedEdits.length > 0) {
              setAgentTodo({
                tool: "edit_file",
                path: partial.path,
                completedEdits: partial.completedEdits.length,
                totalEdits: partial.estimatedTotalEdits,
                status: "truncated"
              });

              const partialArgs = await reviewEditFileArgs({ path: partial.path, edits: partial.completedEdits });
              const workItem: ConversationWorkItem = {
                id: createId("work"),
                kind: "write",
                label: `edit_file: ${partial.path}`,
                status: "running",
                detail: `completed ${partial.completedEdits.length}/${partial.estimatedTotalEdits}`,
                createdAt: new Date().toISOString(),
              };
              appendWorkItem(workItem);
              if (!isWorkspaceCurrent()) return;
              const toolResult = await runLocalTool("edit_file", partialArgs, rootPath, filesAtStart, {
                enableWebSearch: requestSkills.enableWebSearch,
                searchCount: requestSearchCount,
                searchLimit: webSearchLimit,
                agentSubMode: requestSkills.agentSubMode,
              });
              if (!isWorkspaceCurrent()) return;
              updateWorkItem(workItem.id, {
                status: toolResult.result.startsWith("Error") ? "error" : "done",
                resultSummary: summarizeToolResult(toolResult.result),
              });
              toolResults.push({ name: "edit_file", result: toolResult.result });
              if (!toolResult.result.startsWith("Error")) {
                await handleWriteToolSuccess("edit_file", toolResult.result, partial.path);
              }

              const todoInfo = {
                tool: "edit_file",
                path: partial.path,
                completedEditLines: partial.completedEdits.map(e => `${e.startLine}-${e.endLine}`).join(", "),
                lastPartialEdit: partial.lastPartialEdit
              };

              setStatusText(`Continuing edit on ${partial.path} (attempt ${continuationCount + 1})...`);
              setAgentTodo(prev => prev ? { ...prev, status: "continuing" } : null);

              currentResponse = await callAI({
                modelProfile: requestModel,
                taskType: "chat",
                userMessage: `Your previous edit_file response was truncated. Here's your progress:\n\n${JSON.stringify(todoInfo, null, 2)}\n\nPlease continue the edit_file operation for "${partial.path}". Apply only the remaining edits that were not completed.`,
                documentContext: plannedContext.content,
                documentFileName: activeFileAtStart?.name,
                maxTokens: undefined,
                conversationHistory: nextMessages.slice(-6, -1),
                attachments: requestAttachments,
                multiFileContext,
                contextMaxLength,
                skills: requestSkills,
                workspaceRoot: rootPath ?? undefined,
                directoryTree: directoryTree,
                memoryContext: runtimeContext,
              });
              if (!isWorkspaceCurrent()) return;

              continuationCount++;
              currentResponse = currentResponse.replace(call.fullMatch, "");
            } else {
              toolResults.push({
                name: "tool_call_format_error",
                result: "Error: Tool call JSON was incomplete. Please retry with a complete fenced tool_call JSON block.",
              });
              setAgentTodo(null);
              currentResponse = currentResponse.replace(call.fullMatch, "");
            }
            continue;
          }

          try {
            const parsed = parseToolCall(call.json);
            if (!parsed) {
              console.error("Failed to extract tool_call fields:", call.json.substring(0, 100));
              toolResults.push({
                name: "tool_call_format_error",
                result: `Error: Could not parse tool call JSON. Use {"name":"tool_name","arguments":{...}}. Received: ${call.json.slice(0, 500)}`,
              });
              currentResponse = currentResponse.replace(call.fullMatch, "");
              continue;
            }

            const workItem: ConversationWorkItem = {
              id: createId("work"),
              kind: getToolWorkKind(parsed.name),
              label: `${parsed.name}: ${summarizeToolArgs(parsed.name, parsed.args)}`,
              status: "running",
              createdAt: new Date().toISOString(),
            };
            appendWorkItem(workItem);
            if (!isWorkspaceCurrent()) return;
            if (parsed.name === "read_file") {
              readFileCount += 1;
              if (readFileCount > 2) {
                const limitedResult = "Error: read_file limit reached for this turn (max 2 calls). Use search_file or a smaller startLine/endLine range instead.";
                updateWorkItem(workItem.id, {
                  status: "error",
                  resultSummary: limitedResult,
                });
                toolResults.push({ name: parsed.name, result: limitedResult });
                currentResponse = currentResponse.replace(call.fullMatch, "");
                continue;
              }
            }
            const toolArgs = parsed.name === "edit_file"
              ? await reviewEditFileArgs(parsed.args)
              : parsed.args;
            if (!isWorkspaceCurrent()) return;
            const toolResult = await runLocalTool(parsed.name, toolArgs, rootPath, filesAtStart, {
              enableWebSearch: requestSkills.enableWebSearch,
              searchCount: requestSearchCount,
              searchLimit: webSearchLimit,
              agentSubMode: requestSkills.agentSubMode,
            });
            if (!isWorkspaceCurrent()) return;
            updateWorkItem(workItem.id, {
              status: toolResult.result.startsWith("Error") ? "error" : "done",
              resultSummary: summarizeToolResult(toolResult.result),
            });

            if (parsed.name === "web_search" && !toolResult.result.startsWith("Error")) {
              requestSearchCount += 1;
              setWebSearchCount(requestSearchCount);
            }

            if (parsed.name === "create_blueprint" && !toolResult.result.startsWith("Error")) {
              void loadBlueprints();
            }

            if (parsed.name === "upsert_reference_entries" && !toolResult.result.startsWith("Error")) {
              hasSuccessfulReferenceUpsert = true;
              await loadReferenceLists().catch(() => undefined);
              setStatusText("已更新参考条目");
            }

            if (WRITE_TOOLS.has(parsed.name) && !toolResult.result.startsWith("Error")) {
              if (parsed.name === "create_file") {
                hasSuccessfulCreateFile = true;
                const createdPath = typeof toolArgs?.path === "string" ? toolArgs.path : "";
                if (/\.md$/i.test(createdPath) && isCharacterSheetPath(createdPath)) {
                  hasSuccessfulCharacterMdWrite = true;
                }
              }
              if (parsed.name === "edit_file") {
                const editedPath = typeof toolArgs?.path === "string" ? toolArgs.path : "";
                if (/\.md$/i.test(editedPath) && isCharacterSheetPath(editedPath)) {
                  hasSuccessfulCharacterMdWrite = true;
                }
              }
              if (parsed.name !== "upsert_reference_entries") {
                await handleWriteToolSuccess(parsed.name, toolResult.result, toolArgs?.path as string ?? "");
              }
            }

            toolResults.push({ name: parsed.name, result: toolResult.result });
            currentResponse = currentResponse.replace(call.fullMatch, "");
          } catch (parseError) {
            console.error("Failed to parse tool_call:", call.json.substring(0, 100), parseError);
            toolResults.push({
              name: "tool_call_format_error",
              result: `Error: ${parseError instanceof Error ? parseError.message : String(parseError)}. Please retry with valid tool_call JSON.`,
            });
            currentResponse = currentResponse.replace(call.fullMatch, "");
          }
        }

        if (toolResults.length > 0) {
          const toolContext = toolResults
            .map(r => `Tool: ${r.name}\nResult: ${summarizeToolResultForModel(r.name, r.result)}`)
            .join("\n\n");

          setStatusText(`Processing tool results (iteration ${iteration + 1})...`);

          const hasFormatError = toolResults.some((result) => result.name === "tool_call_format_error");
          if (hasFormatError) {
            toolFormatRetryCount += 1;
          }
          if (hasFormatError && toolFormatRetryCount > 2) {
            break;
          }

          currentResponse = await callAI({
            modelProfile: requestModel,
            taskType: "chat",
            userMessage: `Tool Results:\n\n${toolContext}\n\nContinue the user's TODO workflow. If the next TODO needs a tool, output only valid fenced tool_call JSON blocks in this response. Do not stop at a prose statement that you will use a tool. If you have enough information, provide the final answer. For blueprint creation, call list_blueprint_templates before create_blueprint, prefer templateId/templateName on nodes, and do not limit the blueprint to a fixed number of nodes; create the content-derived nodes and edges the source actually needs.`,
            documentContext: plannedContext.content,
            documentFileName: activeFileAtStart?.name,
            maxTokens: undefined,
            conversationHistory: nextMessages.slice(-6, -1),
            attachments: requestAttachments,
            multiFileContext,
            contextMaxLength,
            skills: requestSkills,
            workspaceRoot: rootPath ?? undefined,
            directoryTree: directoryTree,
            memoryContext: runtimeContext,
          });
          if (!isWorkspaceCurrent()) return;

          if (
            extractToolCalls(currentResponse).length === 0 &&
            (!forceCreateFile || hasSuccessfulCreateFile || createFileRecoveryAttempted)
          ) {
            break;
          }
        }
      }

      setAgentTodo(null);
      if (!isWorkspaceCurrent()) return;
      
      // 组合最终响应（只显示 AI 的最终回复）
      appendAssistantText(currentResponse);
      response = assistantTextParts.join("\n\n") || stripToolCalls(currentResponse) || currentResponse;
      const memoryCandidates = extractMemoryCandidates(response);
      if (memoryCandidates.length > 0) {
        const memoryResults = await applyMemoryCandidates(memoryCandidates, {
          hasSuccessfulCreateFile,
          isConfirmedPlanExecution: Boolean(override?.clearPendingPlan),
        });
        if (!isWorkspaceCurrent()) return;
        response = stripMemoryCandidates(response);
        const targetNames = Array.from(new Set(memoryResults
          .filter((result) => result.applied)
          .map((result) => {
            if (result.target === "nova") return "Nova.md";
            if (result.target === "author_template") return "AuthorTemplate.md";
            if (result.target === "prose_style") return "ProseStyle.md";
            if (result.target === "description_stats") return "DescriptionStats.md";
            if (result.target === "story_database") return "StoryDatabase.md";
            if (result.target === "realtime_database") return "RealtimeDatabase.md";
            return "";
          })
          .filter(Boolean)));
        if (targetNames.length > 0) {
          setStatusText(`已更新 ${targetNames.join("、")}`);
        }
      }

      await persistFileCaches();
      if (!isWorkspaceCurrent()) return;

      if (editReviewDebug.enabled && editReviewDebug.editCount === 0 && requestSkills.agentSubMode !== "plan") {
        addEditReviewDebugReason(editReviewDebug.skipReasons, "No edit_file tool call was executed.");
      }
      const assistantMessage: ConversationMessage = {
        id: createId("msg"),
        role: "assistant",
        content: response,
        createdAt: new Date().toISOString(),
        searchCount: requestSearchCount > 0 ? requestSearchCount : undefined,
        workItems: workItems.length > 0 ? workItems : undefined,
        promptDebug: plannedContext.promptDebug,
        editReviewDebug: editReviewDebug.enabled || editReviewDebug.editCount > 0 ? editReviewDebug : undefined,
      };
      const finalClarificationQuestions = parseClarificationQuestions(assistantMessage.content);
      const isFinalClarification = finalClarificationQuestions.length > 0;
      const finalRecord: ConversationRecord = {
        ...draftRecord,
        updatedAt: new Date().toISOString(),
        messages: [...draftRecord.messages, assistantMessage],
        chatSkills: isFinalClarification
          ? {
              ...requestSkills,
              agentSubMode: "plan",
              forcePlanMode: true,
            }
          : requestSkills,
        pendingClarification: isFinalClarification
          ? {
              messageId: assistantMessage.id,
              userMessage,
              promptContent: assistantMessage.content,
              agentMode: requestSkills.agentMode,
              createdAt: new Date().toISOString(),
              questions: finalClarificationQuestions,
              currentIndex: 0,
              answers: [],
            }
          : null,
        pendingPlan: null,
      };
      await persistConversation(finalRecord);
    } catch (error) {
      if (!isWorkspaceCurrent()) return;
      setStatusText(error instanceof Error ? error.message : "Failed to get AI response.");
    } finally {
      if (isWorkspaceCurrent()) setIsLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    setIsDeleteConfirmOpen(false);
    if (!activeConversation) return;
    clearDraftSaveTimer();

    try {
      const summaries = await deleteConversation(activeConversation.id);
      setConversationSummaries(summaries);
      const emptyCaches = new Map<string, FileContentCache>();
      fileCachesRef.current = emptyCaches;
      setFileCaches(emptyCaches);

      if (summaries[0]) {
        await loadConversation(summaries[0].id);
        return;
      }

      const draft = createConversation(defaultChatModelId, useFileStore.getState().activeFile?.path);
      draftInputRef.current = "";
      lastPersistedDraftRef.current = { conversationId: draft.id, value: "" };
      activeConversationRef.current = draft;
      setActiveConversation(draft);
      setInput("");
      setDraftAttachments([]);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Failed to delete conversation.");
    }
  };

  const handleConfirmPlan = async () => {
    const pendingPlan = activeConversation?.pendingPlan;
    if (!pendingPlan) return;

    const buildSkills: ChatSkills = {
      ...normalizeChatSkills(activeConversation?.chatSkills ?? chatSkills),
        agentMode: pendingPlan.agentMode === "editor" ? "editor" : pendingPlan.agentMode === "architect" ? "architect" : "writer",
      agentSubMode: "build",
      forcePlanMode: false,
    };

    await handleSendMessage({
      content: "确认计划，请开始执行。",
      attachments: pendingPlan.userMessage.attachments ?? [],
      skills: buildSkills,
      clearPendingPlan: true,
    });
  };

  const handleSubmitClarificationAnswers = async (source?: {
    messageId: string;
    promptContent: string;
    questions: Array<{ id: string; question: string; options: string[]; allowCustom: boolean }>;
  }) => {
    if (!activeConversation) return;
    const pendingClarification = activeConversation.pendingClarification;
    const sourceMessage = source
      ? activeConversation.messages.find((message) => message.id === source.messageId)
      : null;
    const messageId = pendingClarification?.messageId ?? source?.messageId;
    if (!messageId) return;
    if (submittedClarificationIds.has(messageId) || (pendingClarification?.answers?.length ?? 0) > 0 || (sourceMessage?.clarificationAnswers?.length ?? 0) > 0) {
      setStatusText("这组问题已经提交过答案。");
      return;
    }
    const questions = pendingClarification?.questions?.length
      ? pendingClarification.questions
      : source?.questions?.length
        ? source.questions
        : parseClarificationQuestions(source?.promptContent ?? pendingClarification?.promptContent ?? "");
    if (questions.length === 0) return;

    const missing = questions.find((question) => !clarificationDraftAnswers[question.id]?.trim());
    if (missing) {
      setStatusText(`请先回答：${missing.question}`);
      return;
    }

    const answers = questions.map((question) => ({
      questionId: question.id,
      question: question.question,
      answer: clarificationDraftAnswers[question.id].trim(),
    }));
    const answerText = answers
      .map((answer) => `- ${answer.questionId} ${answer.question}\n  答：${answer.answer}`)
      .join("\n");
    const previousUserMessage = pendingClarification?.userMessage
      ?? [...activeConversation.messages].reverse().find((message) => message.role === "user")
      ?? {
        id: createId("msg"),
        role: "user" as const,
        content: "",
        createdAt: new Date().toISOString(),
      };
    setSubmittedClarificationIds((current) => new Set(current).add(messageId));
    setClarificationDraftAnswers({});
    await handleSendMessage({
      content: `以下是对澄清问题的回答：\n${answerText}`,
      attachments: previousUserMessage.attachments ?? [],
      skills: {
        ...normalizeChatSkills(activeConversation?.chatSkills ?? chatSkills),
        agentMode: pendingClarification?.agentMode === "editor" ? "editor" : pendingClarification?.agentMode === "architect" ? "architect" : "writer",
        agentSubMode: "plan",
        forcePlanMode: true,
      },
      answeredClarification: {
        messageId,
        answers,
      },
    });
  };

  const handleInsertToEditor = (content: string) => {
    const inserted = insertTextIntoEditor(content);
    if (!inserted) {
      setStatusText("No active editor cursor was found, so the content could not be inserted.");
      return;
    }

    if (activeConversation) {
      void persistConversation({
        ...activeConversation,
        lastInsertedText: content,
        updatedAt: new Date().toISOString(),
      });
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSendMessage();
    }
  };

  const selectedConversationId = activeConversation?.id ?? "";

  return (
    <div className="copilot-panel">
      <div className="panel-header copilot-header">
        <div className="copilot-header-main">
          <h2>{t("copilot.title")}</h2>
          <span>{activeConversation?.title || t("copilot.conversation")}</span>
        </div>
        <div className="panel-actions">
          <button onClick={() => void handleNewConversation()} title={t("copilot.newConversation")}>
            <MessageSquarePlus size={16} />
          </button>
          <button onClick={() => setIsDeleteConfirmOpen(true)} title={t("copilot.deleteConversation")} disabled={!activeConversation}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="copilot-toolbar">
        <select
          className="copilot-select"
          title={
            conversationSummaries.find((summary) => summary.id === selectedConversationId)?.title ||
            t("copilot.noSavedConversations")
          }
          value={selectedConversationId}
          onChange={(event) => void loadConversation(event.target.value)}
          disabled={conversationSummaries.length === 0}
        >
          {conversationSummaries.length === 0 && <option value="">{t("copilot.noSavedConversations")}</option>}
          {conversationSummaries.map((summary) => (
            <option key={summary.id} value={summary.id} title={summary.title}>
              {summary.title}
            </option>
          ))}
        </select>
        <select
          className="copilot-select"
          title={
            modelProfiles.find((profile) => profile.id === (activeConversation?.modelId || defaultChatModelId))
              ?.label || t("copilot.noModelSelected")
          }
          value={activeConversation?.modelId || defaultChatModelId}
          onChange={(event) => {
            if (!activeConversation) return;
            void persistConversation({
              ...activeConversation,
              modelId: event.target.value,
              updatedAt: new Date().toISOString(),
            });
          }}
        >
          {modelProfiles.map((profile) => (
            <option key={profile.id} value={profile.id} title={profile.label}>
              {profile.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chat-container">
        <div className="messages">
          {(activeConversation?.messages.length ?? 0) === 0 && (
            <div className="empty-chat">
              <p>{t("copilot.startConversation")}</p>
              <p className="hint">{t("copilot.workspaceHint")}</p>
            </div>
          )}
          {activeConversation?.messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-content">
                <div className="message-role">
                  {msg.role === "user" && <span>{msg.role}</span>}
                  <time>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </div>
                {msg.role === "assistant" && msg.workItems && msg.workItems.length > 0 && (
                  <details className="message-work-items" open>
                    <summary>已执行工作</summary>
                    <div className="message-work-list">
                      {msg.workItems.map((item) => (
                        <div key={item.id} className={`message-work-item ${item.status}`}>
                          <span>{item.label}</span>
                          {item.resultSummary && <small>{item.resultSummary}</small>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {(() => {
                  const clarificationQuestions = msg.role === "assistant" ? parseClarificationQuestions(msg.content) : [];
                  const isActiveClarification = activeConversation?.pendingClarification?.messageId === msg.id && clarificationQuestions.length > 0;
                  const latestClarificationMessageId = [...(activeConversation?.messages ?? [])]
                    .reverse()
                    .find((message) => message.role === "assistant" && parseClarificationQuestions(message.content).length > 0)?.id;
                  const isRecoverableClarification = !activeConversation?.pendingClarification
                    && latestClarificationMessageId === msg.id
                    && clarificationQuestions.length > 0
                    && !msg.clarificationAnswers?.length;
                  if (clarificationQuestions.length === 0) {
                    return (
                      <div className="message-text">
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                      </div>
                    );
                  }
                  const savedAnswers = msg.clarificationAnswers
                    ?? (isActiveClarification ? activeConversation?.pendingClarification?.answers : undefined)
                    ?? [];
                  const isAnsweredClarification = savedAnswers.length > 0 || submittedClarificationIds.has(msg.id);
                  const canSubmitClarification = (isActiveClarification || isRecoverableClarification) && !isAnsweredClarification;
                  return (
                    <div className={`clarification-card ${isAnsweredClarification ? "answered" : !isActiveClarification ? "inactive" : ""}`}>
                      <div className="clarification-title">
                        {isAnsweredClarification ? "已提交的补充信息" : isActiveClarification ? "需要补充几个选择" : "历史澄清问题"}
                      </div>
                      {clarificationQuestions.map((question, questionIndex) => (
                        <div key={question.id} className="clarification-question">
                          <div className="clarification-question-title">
                            {questionIndex + 1}. {question.question}
                          </div>
                          {isAnsweredClarification && (
                            <div className="clarification-answer">
                              {savedAnswers.find((answer) => answer.questionId === question.id)?.answer || "已提交"}
                            </div>
                          )}
                          {question.options.length > 0 && (
                            <div className="clarification-options">
                              {question.options.map((option) => (
                                <button
                                  key={option}
                                  type="button"
                                  className={[
                                    clarificationDraftAnswers[question.id] === option ? "active" : "",
                                    savedAnswers.find((answer) => answer.questionId === question.id)?.answer === option ? "answered" : "",
                                  ].filter(Boolean).join(" ")}
                                  onClick={() => setClarificationDraftAnswers((current) => ({
                                    ...current,
                                    [question.id]: option,
                                  }))}
                                  disabled={isLoading || !canSubmitClarification}
                                >
                                  {option}
                                </button>
                              ))}
                            </div>
                          )}
                          {question.allowCustom && canSubmitClarification && (
                            <input
                              className="clarification-custom-input"
                              value={clarificationDraftAnswers[question.id] ?? ""}
                              onChange={(event) => setClarificationDraftAnswers((current) => ({
                                ...current,
                                [question.id]: event.target.value,
                              }))}
                              placeholder="也可以直接输入自定义答案"
                              disabled={isLoading}
                            />
                          )}
                        </div>
                      ))}
                      {canSubmitClarification ? (
                        <div className="clarification-actions">
                          <button
                            className="plan-confirm-button"
                            onClick={() => void handleSubmitClarificationAnswers({
                              messageId: msg.id,
                              promptContent: msg.content,
                              questions: clarificationQuestions,
                            })}
                            disabled={isLoading || clarificationQuestions.some((question) => !clarificationDraftAnswers[question.id]?.trim())}
                          >
                            提交回答并继续
                          </button>
                        </div>
                      ) : (
                        <div className="clarification-note">
                          {isAnsweredClarification ? "这组问题已经提交过答案。" : "这组历史问题已不再等待提交。"}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="message-attachments">
                    {msg.attachments.map((attachment) => (
                      <span key={attachment.id} className="message-attachment-chip">
                        {attachment.name}
                      </span>
                    ))}
                  </div>
                )}
                {msg.role === "assistant" && (
                  <button className="insert-button" onClick={() => handleInsertToEditor(msg.content)}>
                    {t("copilot.insertToEditor")}
                  </button>
                )}
                {msg.role === "assistant" && activeConversation?.pendingPlan?.planMessageId === msg.id && (
                  <div className="plan-confirm-actions">
                    <button className="plan-confirm-button" onClick={() => void handleConfirmPlan()} disabled={isLoading}>
                      {t("copilot.confirmPlan")}
                    </button>
                  </div>
                )}
                {msg.role === "assistant" && msg.searchCount && msg.searchCount > 0 && (
                  <div className="message-search-count">
                    {t("copilot.searchCount", { count: msg.searchCount, limit: webSearchLimit })}
                  </div>
                )}
                {msg.role === "assistant" && msg.promptDebug && (
                  <details className="prompt-debug">
                    <summary>
                      上下文调试：{msg.promptDebug.totalChars.toLocaleString()} chars / ~{msg.promptDebug.totalEstimatedTokens.toLocaleString()} tokens
                    </summary>
                    <div className="prompt-debug-list">
                      {msg.promptDebug.entries.map((entry, index) => (
                        <div key={`${msg.id}-prompt-${index}`} className={`prompt-debug-row ${entry.cacheFriendly === "low" ? "high" : entry.cacheFriendly === "medium" ? "medium" : "low"}`}>
                          <span>{entry.label}</span>
                          <strong>{entry.strategy || "structured"}</strong>
                          <small>
                            raw {entry.rawChars?.toLocaleString() ?? "-"} / sent {(entry.sentChars ?? entry.chars).toLocaleString()} chars
                            {" · "}
                            ~{entry.estimatedTokens.toLocaleString()} tokens
                            {entry.reason ? ` · ${entry.reason}` : ""}
                          </small>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {msg.role === "assistant" && msg.editReviewDebug && (
                  <details className="prompt-debug edit-review-debug">
                    <summary>
                      自动审核调试：{msg.editReviewDebug.triggered ? "已触发" : "未触发"}
                      {msg.editReviewDebug.durationMs > 0 ? `，${msg.editReviewDebug.durationMs}ms` : ""}
                    </summary>
                    <div className="prompt-debug-list">
                      <div className={`prompt-debug-row ${msg.editReviewDebug.triggered ? "high" : "medium"}`}>
                        <span>{msg.editReviewDebug.filePath || "本轮请求"}</span>
                        <strong>{msg.editReviewDebug.reviewedCount}/{msg.editReviewDebug.editCount} 段</strong>
                        <small>
                          模型：{msg.editReviewDebug.modelLabel || "未使用"}
                          {" · "}
                          字符：{msg.editReviewDebug.originalChars.toLocaleString()} → {msg.editReviewDebug.reviewedChars.toLocaleString()}
                        </small>
                      </div>
                      {msg.editReviewDebug.skipReasons.map((reason) => (
                        <div key={`${msg.id}-skip-${reason}`} className="prompt-debug-row medium">
                          <span>跳过原因</span>
                          <small>{reason}</small>
                        </div>
                      ))}
                      {msg.editReviewDebug.fallbackReasons.map((reason) => (
                        <div key={`${msg.id}-fallback-${reason}`} className="prompt-debug-row low">
                          <span>回退原因</span>
                          <small>{reason}</small>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="message assistant">
              <div className="message-content">
                {currentAssistantWorkItems.length > 0 && (
                  <details className="message-work-items" open>
                    <summary>正在执行工作</summary>
                    <div className="message-work-list">
                      {currentAssistantWorkItems.map((item) => (
                        <div key={item.id} className={`message-work-item ${item.status}`}>
                          <span>{item.label}</span>
                          {item.resultSummary && <small>{item.resultSummary}</small>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {currentAssistantText && (
                  <div className="message-text">
                    <Markdown remarkPlugins={[remarkGfm]}>{currentAssistantText}</Markdown>
                  </div>
                )}
                <div className="message-text loading">{statusText || t("copilot.thinking")}</div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
        {selectionToolbar && (
          <button
            className="chat-selection-insert"
            style={{ left: selectionToolbar.x, top: selectionToolbar.y }}
            onClick={() => {
              handleInsertToEditor(selectionToolbar.text);
              setSelectionToolbar(null);
            }}
          >
            <Sparkles size={14} />
            <span>{t("copilot.insertSelection")}</span>
          </button>
        )}
        {agentTodo && (
          <div className="agent-todo">
            <div className="agent-todo-header">
              <span className="agent-todo-icon">📝</span>
              <span className="agent-todo-title">Agent 进度</span>
            </div>
            <div className="agent-todo-content">
              <span className="agent-todo-tool">{agentTodo.tool}</span>
              <span className="agent-todo-path">{agentTodo.path}</span>
            </div>
            <div className="agent-todo-progress">
              <div className="agent-todo-bar">
                <div
                  className="agent-todo-bar-fill"
                  style={{ width: `${(agentTodo.completedEdits / agentTodo.totalEdits) * 100}%` }}
                />
              </div>
              <span className="agent-todo-count">
                {agentTodo.completedEdits}/{agentTodo.totalEdits} edits
              </span>
            </div>
            <div className={`agent-todo-status agent-todo-status-${agentTodo.status}`}>
              {agentTodo.status === "running" && "执行中..."}
              {agentTodo.status === "truncated" && "响应截断，正在续写..."}
              {agentTodo.status === "continuing" && "续写中..."}
            </div>
          </div>
        )}
        <div className="input-area">
          <div className="input-toolbar">
            <button
              type="button"
              className="attach-button"
              onClick={async () => {
                try {
                  const next = await selectTextAttachments(draftAttachments);
                  setDraftAttachments(next);
                  setStatusText("");
                } catch (error) {
                  setStatusText(error instanceof Error ? error.message : "Failed to attach files.");
                }
              }}
              disabled={isLoading}
            >
              <Paperclip size={14} />
              <span>{t("copilot.attachFile")}</span>
            </button>
            {draftAttachments.length > 0 && (
              <button
                type="button"
                className="clear-attachments-button"
                onClick={() => setDraftAttachments([])}
                disabled={isLoading}
              >
                {t("copilot.clearAttachments")}
              </button>
            )}
          </div>
          <div className="input-textbox-wrapper">
            <textarea
              ref={inputTextareaRef}
              value={input}
              onChange={(e) => {
                const nextInput = e.target.value;
                draftInputRef.current = nextInput;
                setInput(nextInput);
              }}
              onKeyDown={handleKeyPress}
                placeholder={activeInputModel ? t("copilot.askAI") : t("copilot.configureModel")}
                disabled={!activeInputModel || isLoading}
              rows={4}
            />
            {draftAttachments.length > 0 && (
              <div className="draft-attachments-inline">
                {draftAttachments.map((attachment) => (
                  <button
                    key={attachment.id}
                    type="button"
                    className="draft-attachment-icon"
                    onClick={() => setDraftAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                    disabled={isLoading}
                    title={attachment.name}
                  >
                    <Paperclip size={12} />
                    <span className="draft-attachment-name">{attachment.name}</span>
                    <X size={10} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="input-footer">
            <div
              className="skills-toolbar"
              onWheel={(event) => {
                if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
                event.currentTarget.scrollLeft += event.deltaY;
              }}
            >
              <div className="agent-mode-picker">
                <button
                  ref={agentModeButtonRef}
                  type="button"
                  className={`agent-mode-menu-button ${isAgentModeMenuOpen ? "active" : ""}`}
                  onClick={() => {
                    const rect = agentModeButtonRef.current?.getBoundingClientRect();
                    if (rect) {
                      setAgentModeMenuPosition({
                        left: rect.left,
                        bottom: window.innerHeight - rect.top + 8,
                        width: Math.max(rect.width, 128),
                      });
                    }
                    setIsAgentModeMenuOpen(prev => !prev);
                  }}
                  aria-haspopup="menu"
                  aria-expanded={isAgentModeMenuOpen}
                >
                  <span>{t(`copilot.${chatSkills.agentMode}`)}</span>
                  <ChevronDown size={13} />
                </button>
              </div>

              <button
                type="button"
                className={`skill-pill ${chatSkills.enableWebSearch ? "active" : ""}`}
                onClick={() => updateChatSkills(prev => ({
                  ...prev,
                  enableWebSearch: !prev.enableWebSearch,
                }))}
              >
                {t("copilot.search")}
              </button>

              <button
                type="button"
                className={`skill-pill ${chatSkills.forcePlanMode ? "active" : ""}`}
                onClick={() => updateChatSkills(prev => ({
                  ...prev,
                  forcePlanMode: !prev.forcePlanMode,
                  agentSubMode: !prev.forcePlanMode ? "plan" : prev.agentSubMode,
                }))}
              >
                {t("copilot.planMode")}
              </button>

              <button
                type="button"
                className={`skill-pill ${chatSkills.enableEditReview ? "active" : ""}`}
                onClick={() => updateChatSkills(prev => ({
                  ...prev,
                  enableEditReview: !prev.enableEditReview,
                }))}
              >
                {t("copilot.autoReview")}
              </button>

            </div>

            <button
              onClick={() => void handleSendMessage()}
                disabled={!input.trim() || !activeInputModel || isLoading}
              className="send-button"
            >
              <Send size={16} />
            </button>
          </div>
          {isAgentModeMenuOpen && agentModeMenuPosition && (
            <div
              className="agent-mode-menu"
              style={{
                left: agentModeMenuPosition.left,
                bottom: agentModeMenuPosition.bottom,
                minWidth: agentModeMenuPosition.width,
              }}
              role="menu"
            >
              {(["writer", "editor", "architect"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={chatSkills.agentMode === mode ? "active" : ""}
                  onClick={() => {
                    updateChatSkills(prev => ({
                      ...prev,
                      agentMode: mode,
                      agentSubMode: mode === "editor" ? "build" : prev.agentSubMode,
                    }));
                    setIsAgentModeMenuOpen(false);
                  }}
                  role="menuitemradio"
                  aria-checked={chatSkills.agentMode === mode}
                >
                  {chatSkills.agentMode === mode ? `[${t(`copilot.${mode}`)}]` : t(`copilot.${mode}`)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="copilot-footer-note">
          <span>{currentModel ? `${t("copilot.model")}: ${currentModel.label}` : t("copilot.noModelSelected")}</span>
          <CopilotActiveFileContextLabel />
          <button
            className="copilot-settings-button"
            onClick={() => {
              setTempMaxTokens(String(chatMaxTokens));
              setIsSettingsOpen(true);
            }}
            title={t("copilot.settings")}
          >
            <Settings size={12} />
          </button>
        </div>
        {isSettingsOpen && (
          <div className="copilot-settings-backdrop" onClick={() => setIsSettingsOpen(false)}>
            <div className="copilot-settings-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="copilot-settings-header">
                <h3>{t("copilot.settings")}</h3>
                <button onClick={() => setIsSettingsOpen(false)}>
                  <X size={16} />
                </button>
              </div>
              <label className="copilot-settings-field">
                <span>{t("copilot.maxTokens")}</span>
                <input
                  type="number"
                  min={256}
                  max={128000}
                  step={256}
                  value={tempMaxTokens}
                  onChange={(e) => setTempMaxTokens(e.target.value)}
                />
              </label>
              <div className="copilot-settings-actions">
                <button
                  className="secondary"
                  onClick={() => setIsSettingsOpen(false)}
                >
                  {t("copilot.cancel")}
                </button>
                <button
                  onClick={() => {
                    const value = parseInt(tempMaxTokens, 10);
                    if (!isNaN(value) && value >= 256 && value <= 128000) {
                      setChatMaxTokens(value);
                    }
                    setIsSettingsOpen(false);
                  }}
                >
                  {t("copilot.save")}
                </button>
              </div>
            </div>
          </div>
        )}
        {isDeleteConfirmOpen && (
          <div className="copilot-settings-backdrop" onClick={() => setIsDeleteConfirmOpen(false)}>
            <div className="copilot-settings-dialog" onClick={(e) => e.stopPropagation()}>
              <div className="copilot-settings-header">
                <h3>{t("copilot.deleteConfirmTitle")}</h3>
                <button onClick={() => setIsDeleteConfirmOpen(false)}>
                  <X size={16} />
                </button>
              </div>
              <p className="delete-confirm-message">{t("copilot.deleteConfirmMessage")}</p>
              <div className="copilot-settings-actions">
                <button
                  className="secondary"
                  onClick={() => setIsDeleteConfirmOpen(false)}
                >
                  {t("copilot.cancel")}
                </button>
                <button
                  className="danger-button"
                  onClick={() => void handleConfirmDelete()}
                >
                  {t("copilot.deleteConversation")}
                </button>
              </div>
            </div>
          </div>
        )}
        {statusText && <div className="copilot-status">{statusText}</div>}
      </div>
    </div>
  );
};

export default CopilotPanel;

