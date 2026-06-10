import React, { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, MessageSquarePlus, Paperclip, Send, Settings, Sparkles, Trash2, X } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useTranslation } from "../hooks/useTranslation";
import { callAI, reviewEditFileContent } from "../services/aiService";
import {
  deleteConversation,
  ensureWorkspaceConversationStore,
  listConversationSummaries,
  readConversation,
  writeConversation,
} from "../services/conversationService";
import { selectTextAttachments } from "../services/attachmentService";
import { getEditorContent, insertTextIntoEditor } from "../services/editorInsertionService";
import { runLocalTool } from "../services/mcpService";
import {
  applyMemoryCandidate,
  buildMemoryPrompt,
  ensureMemoryFiles,
  extractMemoryCandidate,
  loadMemoryContext,
  stripMemoryCandidate,
} from "../services/memoryService";
import { readFile, type WorkspaceNode } from "../services/fileSystemService";
import { calculateTextStats } from "../utils/textStats";
import type { AgentMode, ChatSkills, ConversationAttachment, ConversationMessage, ConversationRecord, ConversationSummary, ConversationWorkItem, FileChange, FileContentCache, MultiFileContext } from "../types/ai";
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
  agentMode: "smart",
  agentSubMode: "plan",
  forcePlanMode: false,
};

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

const FILE_CREATION_PATTERNS = [
  /创建|保存|写入|生成文件|新建|建一个|另存|存成|存为/i,
  /create|save|write (?:a )?file|new file/i,
];

const CHAPTER_DRAFT_PATTERNS = [
  /章节|正文|第一章|第二章|第三章|第四章|第五章|第六章|第七章|第八章|第九章|第十章|序章|终章|番外/i,
  /第[一二三四五六七八九十百千万\d]+章|EP[_-]?\d+|chapter|episode|prologue|epilogue/i,
];

function normalizeChatSkills(skills?: Partial<ChatSkills> | null): ChatSkills {
  return {
    ...DEFAULT_CHAT_SKILLS,
    ...skills,
  };
}

function isProjectMemoryRelevant(content: string): boolean {
  return PROJECT_MEMORY_PATTERNS.some((pattern) => pattern.test(content));
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

function shouldNeedPlan(content: string, mode: AgentMode): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (shouldForceCreateFile(trimmed)) return false;
  if (PLAN_REQUIRED_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  if (trimmed.length > 3000) return true;
  if (mode === "architect") {
    return trimmed.length > 1200 && isProjectMemoryRelevant(trimmed);
  }
  if (mode === "smart") {
    return trimmed.length > 1800 && isProjectMemoryRelevant(trimmed);
  }
  return false;
}

function isClarificationResponse(content: string): boolean {
  return /(^|\n)##\s*Clarification Needed\b/i.test(content);
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
  action?: "create_file" | "edit_file";
  relativePath?: string;
  absolutePath?: string;
  fileType?: "text" | "docx";
  bytes?: number;
  edits?: number;
};

function normalizeWorkspacePath(path: string) {
  return path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
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

function stripToolCalls(content: string) {
  return content.replace(/```tool_?call\s*\n[\s\S]*?\n```/g, "").trim();
}

function getToolWorkKind(toolName: string): ConversationWorkItem["kind"] {
  if (toolName === "web_search") return "search";
  if (toolName.includes("blueprint")) return "blueprint";
  if (toolName === "read_file" || toolName === "list_directory") return "file";
  if (toolName === "edit_file" || toolName === "create_file" || toolName === "create_blueprint") return "write";
  return "tool";
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>) {
  if (toolName === "web_search") return String(args.query ?? "");
  if (toolName === "read_file" || toolName === "list_directory" || toolName === "edit_file" || toolName === "create_file") {
    return String(args.path ?? "workspace");
  }
  if (toolName === "read_blueprint") return String(args.name ?? args.id ?? "blueprint");
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
  const refreshLoadedWorkspace = useFileStore((state) => state.refreshLoadedWorkspace);
  const { loadBlueprints } = useBlueprintStore();
  const { modelProfiles, defaultChatModelId, getModelProfileById, chatMaxTokens, setChatMaxTokens, contextMaxLength, webSearchLimit } = useSettingsStore();
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

  const currentModel = useMemo(
    () => getModelProfileById(activeConversation?.modelId || defaultChatModelId),
    [activeConversation?.modelId, defaultChatModelId, getModelProfileById, modelProfiles]
  );

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

  const buildMultiFileContext = (): MultiFileContext | undefined => {
    const { activeFile, getOpenTabs } = useFileStore.getState();
    if (!activeFile) return undefined;

    const currentContent = activeFile.content;
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
    const activeCachedContent = activeFileCache?.content ?? null;

    const activeChanges = activeCachedContent
      ? calculateChanges(activeCachedContent, currentContent)
      : [];

    // 同步更新缓存
    updateFileCache(activeFile.path, currentContent);

    // 使用 ref 构建 otherBoundFiles
    const otherBoundFiles = Array.from(fileCachesRef.current.entries())
      .filter(([path]) => path !== activeFile.path)
      .slice(0, 5)
      .map(([path, cache]) => {
        const tab = getOpenTabs().find(t => t.path === path);
        const tabContent = tab?.content ?? cache.content;
        const tabStats = calculateTextStats(tabContent);

        return {
          meta: {
            fileName: path.split(/[/\\]/).pop() || path,
            filePath: path,
            charCount: tabStats.characters,
            lineCount: tabStats.lines,
            wordCount: tabStats.words,
          },
          recentChanges: calculateChanges(cache.content, tabContent),
        };
      });

    // 使用 ref 构建 allBoundFiles
    const allBoundFiles = Array.from(fileCachesRef.current.values()).map(cache => {
      const cacheStats = calculateTextStats(cache.content);
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

  const loadConversation = async (conversationId: string, expectedRootPath = rootPath) => {
    const record = await readConversation(conversationId);
    if (expectedRootPath !== useFileStore.getState().rootPath) return;
    if (!record) return;
    setActiveConversation(record);
    setInput(record.draftInput || "");
    setDraftAttachments([]);
  };

  const persistConversation = async (record: ConversationRecord) => {
    const nextSummaries = await writeConversation(record);
    setConversationSummaries(nextSummaries);
    setActiveConversation(record);
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
    const emptyCaches = new Map<string, FileContentCache>();
    fileCachesRef.current = emptyCaches;
    setFileCaches(emptyCaches);
    setConversationSummaries([]);
    setActiveConversation(null);
    setInput("");
    setDraftAttachments([]);
    setCurrentAssistantText("");
    setCurrentAssistantWorkItems([]);
    setAgentTodo(null);
    setIsLoading(false);
    setIsAgentModeMenuOpen(false);
  };

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
    const next = createConversation(defaultChatModelId, useFileStore.getState().activeFile?.path);
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
  }) => {
    const messageContent = (override?.content ?? input).trim();
    const requestAttachments = override?.attachments ?? draftAttachments;
    let requestSkills = normalizeChatSkills(override?.skills ?? chatSkills);
    const forceCreateFile = shouldForceCreateFile(messageContent);
    const defaultChapterToDocx = shouldDefaultChapterToDocx(messageContent);
    if (!override) {
      const hasPendingClarification = Boolean(activeConversation?.pendingClarification);
      const needPlan = shouldNeedPlan(messageContent, requestSkills.agentMode);
      requestSkills = {
        ...requestSkills,
        agentSubMode: requestSkills.forcePlanMode || hasPendingClarification
          ? "plan"
          : forceCreateFile ? "build" : needPlan ? "plan" : "build",
      };
    }
    if (!messageContent || !activeConversation || !currentModel || isLoading) return;
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

    const nextMessages = [...activeConversation.messages, userMessage];
    const pendingClarification = !override ? activeConversation.pendingClarification ?? null : null;
    const draftRecord: ConversationRecord = {
      ...activeConversation,
      title: activeConversation.messages.length === 0 ? buildTitleFromMessage(userMessage.content) : activeConversation.title,
      updatedAt: new Date().toISOString(),
      contextFilePath: useFileStore.getState().activeFile?.path ?? activeConversation.contextFilePath ?? null,
      messages: nextMessages,
      draftInput: "",
      pendingPlan: override?.clearPendingPlan ? null : activeConversation.pendingPlan ?? null,
      pendingClarification: activeConversation.pendingClarification ?? null,
    };

    if (!override) {
      setInput("");
      setDraftAttachments([]);
    }
    setIsLoading(true);
    setStatusText("");
    setCurrentAssistantText("");
    setCurrentAssistantWorkItems([]);
    const fileSnapshotAtStart = useFileStore.getState();
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

      // 更新文件缓存
      if (activeFileAtStart) {
        updateFileCache(activeFileAtStart.path, activeFileAtStart.content);
      }
      if (!isWorkspaceCurrent()) return;

      const multiFileContext = buildMultiFileContext();

      // 构建目录结构字符串
      const directoryTree = buildDirectoryTreeString(filesAtStart);
      const shouldRequestPlan =
        !override && requestSkills.agentSubMode === "plan";
      const shouldIncludeProjectMemory =
        shouldRequestPlan || override?.clearPendingPlan || isProjectMemoryRelevant(userMessage.content);
      const memoryPrompt = buildMemoryPrompt(await loadMemoryContext({
        includeProjectImportant: shouldIncludeProjectMemory,
        includeProjectSnapshot: shouldIncludeProjectMemory,
      }));

      if (shouldRequestPlan) {
        const planSkills: ChatSkills = {
          ...requestSkills,
          agentSubMode: "plan",
        };
        const basePlanRequest = pendingClarification
          ? `The user is answering a previous clarification question. Continue planning from the original request and the new answer.\n\n## Original Request\n${pendingClarification.userMessage.content}\n\n## Clarification Question\n${pendingClarification.promptContent}\n\n## User Answer\n${userMessage.content}\n\nNow produce the formal plan if enough information is available. If information is still missing, output a new "## Clarification Needed" section and ask only the missing questions.`
          : userMessage.content;
        const planRequest = requestSkills.agentMode === "architect"
          ? `${basePlanRequest}\n\nNeedPlan 已触发。请先输出执行计划，并额外进行一次 Plan Review：检查故事逻辑、伏笔、风险、缺失信息和验证方式。现在不要写文件、不要生成正文。\n\nIf essential information is missing, do not pretend this is a plan. Output exactly a "## Clarification Needed" section with the questions instead.`
          : `${basePlanRequest}\n\nNeedPlan 已触发。请先输出执行计划，等待用户确认后再生成蓝图、正文或修改文件。现在不要写文件。\n\nIf essential information is missing, do not pretend this is a plan. Output exactly a "## Clarification Needed" section with the questions instead.`;

        const planResponse = await callAI({
          modelProfile: currentModel,
          taskType: "chat",
          userMessage: planRequest,
          documentContext: multiFileContext?.activeFile.content || activeFileAtStart?.content || getEditorContent() || "",
          documentFileName: activeFileAtStart?.name,
          maxTokens: chatMaxTokens,
          conversationHistory: nextMessages.slice(-6, -1),
          attachments: requestAttachments,
          multiFileContext,
          contextMaxLength,
          skills: planSkills,
          workspaceRoot: rootPath ?? undefined,
          directoryTree,
          memoryContext: memoryPrompt,
        });
        if (!isWorkspaceCurrent()) return;

        const assistantMessage: ConversationMessage = {
          id: createId("msg"),
          role: "assistant",
          content: stripToolCalls(planResponse),
          createdAt: new Date().toISOString(),
        };
        const isClarification = isClarificationResponse(assistantMessage.content);
        const finalRecord: ConversationRecord = {
          ...draftRecord,
          updatedAt: new Date().toISOString(),
          messages: [...draftRecord.messages, assistantMessage],
          chatSkills: planSkills,
          pendingClarification: isClarification
            ? {
                messageId: assistantMessage.id,
                userMessage: pendingClarification?.userMessage ?? userMessage,
                promptContent: assistantMessage.content,
                agentMode: requestSkills.agentMode,
                createdAt: new Date().toISOString(),
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
        return;
      }

      const withCreateFileDirective = (content: string) => {
        if (!forceCreateFile) return content;
        return `${content}\n\n## 文件创建强制要求\n用户这次要求实际创建/保存文件。你必须在本轮输出 create_file 工具调用，不能只输出正文，不能只说“我会创建”。${defaultChapterToDocx ? "这是章节正文创建请求；如果用户没有明确指定 .md/.txt/.docx，文件路径必须使用 .docx。" : ""}如果之前已经写出正文但没有创建文件，本轮优先补 create_file。`;
      };

      let response = await callAI({
        modelProfile: currentModel,
        taskType: "chat",
        userMessage: override?.clearPendingPlan
          ? `用户已确认以下计划，请按计划执行。先生成或更新蓝图，再生成正文或完成必要文件操作${activeConversation.pendingPlan?.agentMode === "architect" ? "，然后进行一致性检查并根据检查结果做必要精修" : ""}，最后输出 Memory Candidate。\n\n## 原始需求\n${activeConversation.pendingPlan?.userMessage.content ?? userMessage.content}\n\n## 已确认计划\n${activeConversation.pendingPlan?.planContent ?? ""}\n\n## 本次指令\n${userMessage.content}`
          : withCreateFileDirective(userMessage.content),
        documentContext: multiFileContext?.activeFile.content || activeFileAtStart?.content || getEditorContent() || "",
        documentFileName: activeFileAtStart?.name,
        maxTokens: undefined,
        conversationHistory: nextMessages.slice(-6, -1),
        attachments: requestAttachments,
        multiFileContext,
        contextMaxLength,
        skills: requestSkills,
        workspaceRoot: rootPath ?? undefined,
        directoryTree,
        memoryContext: memoryPrompt,
      });
      if (!isWorkspaceCurrent()) return;

      // 实现多轮工具调用循环
      let currentResponse = response;
      const maxIterations = 100;
      const WRITE_TOOLS = new Set(["edit_file", "create_file", "create_blueprint"]);
      let hasSuccessfulCreateFile = false;
      let createFileRecoveryAttempted = false;

      const extractToolCalls = (text: string): Array<{ fullMatch: string; json: string }> => {
        const results: Array<{ fullMatch: string; json: string }> = [];
        const startPattern = /```(?:tool[_-]?call|json)\s*\n/g;
        let startMatch: RegExpExecArray | null;
        while ((startMatch = startPattern.exec(text)) !== null) {
          const startIndex = startMatch.index + startMatch[0].length;
          const endMarker = text.indexOf('\n```', startIndex);
          if (endMarker === -1) break;
          const json = text.substring(startIndex, endMarker);
          if (!/"(?:name|tool)"\s*:/.test(json)) continue;
          const fullMatch = text.substring(startMatch.index, endMarker + 4);
          results.push({ fullMatch, json });
        }
        return results;
      };

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

        await refreshLoadedWorkspace(absolutePath);

        const latestStore = useFileStore.getState();
        const node = findWorkspaceNode(latestStore.files, absolutePath);
        if (node?.type === "file") {
          await latestStore.openFile(absolutePath, latestStore.activeGroupId);
          setStatusText(`${name === "create_file" ? "已创建" : "已更新"}：${relativePath}`);
          return;
        }

        setStatusText(`文件已写入 ${absolutePath}，但工作区树未刷新到该路径`);
      };

      const MAX_EDIT_REVIEW_CONTENT_LENGTH = 8000;
      const reviewEditFileArgs = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        if (requestSkills.agentSubMode === "plan") return args;
        const path = typeof args.path === "string" ? args.path : "";
        const edits = args.edits;
        if (!path || !Array.isArray(edits) || edits.length === 0 || !rootPath || !currentModel) return args;

        let originalContent = "";
        try {
          originalContent = await readFile(joinWorkspacePath(rootPath, path));
        } catch {
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
            reviewedEdits.push(edit);
            continue;
          }

          const startLine = Number(typedEdit.startLine);
          const endLine = Number(typedEdit.endLine);
          const originalSnippet = Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine
            ? originalLines.slice(startLine - 1, endLine).join("\n")
            : "";

          try {
            setStatusText(`AI编辑审核中：${path}`);
            const reviewedContent = await reviewEditFileContent({
              modelProfile: currentModel,
              filePath: path,
              originalContent: originalSnippet,
              proposedContent: newContent,
              maxTokens: Math.min(Math.max(chatMaxTokens, 1024), 4096),
            });
            if (!isWorkspaceCurrent()) return args;
            reviewedEdits.push({
              ...typedEdit,
              newContent: reviewedContent.trim() ? reviewedContent : newContent,
            });
          } catch {
            reviewedEdits.push(edit);
          }
        }

        return {
          ...args,
          edits: reviewedEdits,
        };
      };

      const MAX_CONTINUATION_RETRIES = 3;
      let continuationCount = 0;
      let toolFormatRetryCount = 0;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (!isWorkspaceCurrent()) return;
        const extractedCalls = extractToolCalls(currentResponse);
        if (extractedCalls.length === 0 || !rootPath) {
          if (rootPath && forceCreateFile && !hasSuccessfulCreateFile && !createFileRecoveryAttempted) {
            appendAssistantText(currentResponse);
            createFileRecoveryAttempted = true;
            setStatusText("需要实际创建文件，正在要求 AI 补充 create_file...");
            currentResponse = await callAI({
              modelProfile: currentModel,
              taskType: "chat",
              userMessage: withCreateFileDirective(`用户要求实际创建或保存文件，但你上一轮没有调用 create_file。请现在只输出必要的 create_file 工具调用，path 使用工作区相对路径，content 使用完整正文纯文本。${defaultChapterToDocx ? "这是章节正文文件，除非用户明确指定其他扩展名，否则必须使用 .docx。" : ""}`),
              documentContext: multiFileContext?.activeFile.content || activeFileAtStart?.content || getEditorContent() || "",
              documentFileName: activeFileAtStart?.name,
              maxTokens: undefined,
              conversationHistory: nextMessages.slice(-6, -1),
              attachments: requestAttachments,
              multiFileContext,
              contextMaxLength,
              skills: requestSkills,
              workspaceRoot: rootPath ?? undefined,
              directoryTree: directoryTree,
              memoryContext: memoryPrompt,
            });
            if (!isWorkspaceCurrent()) return;
            continue;
          }
          break;
        }
        appendAssistantText(currentResponse);

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
                modelProfile: currentModel,
                taskType: "chat",
                userMessage: `Your previous edit_file response was truncated. Here's your progress:\n\n${JSON.stringify(todoInfo, null, 2)}\n\nPlease continue the edit_file operation for "${partial.path}". Apply only the remaining edits that were not completed.`,
                documentContext: multiFileContext?.activeFile.content || activeFileAtStart?.content || getEditorContent() || "",
                documentFileName: activeFileAtStart?.name,
                maxTokens: undefined,
                conversationHistory: nextMessages.slice(-6, -1),
                attachments: requestAttachments,
                multiFileContext,
                contextMaxLength,
                skills: requestSkills,
                workspaceRoot: rootPath ?? undefined,
                directoryTree: directoryTree,
                memoryContext: memoryPrompt,
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

            if (WRITE_TOOLS.has(parsed.name) && !toolResult.result.startsWith("Error")) {
              if (parsed.name === "create_file") {
                hasSuccessfulCreateFile = true;
              }
              await handleWriteToolSuccess(parsed.name, toolResult.result, toolArgs?.path as string ?? "");
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
          const toolContext = toolResults.map(r => `Tool: ${r.name}\nResult: ${r.result}`).join("\n\n");

          setStatusText(`Processing tool results (iteration ${iteration + 1})...`);

          const hasFormatError = toolResults.some((result) => result.name === "tool_call_format_error");
          if (hasFormatError) {
            toolFormatRetryCount += 1;
          }
          if (hasFormatError && toolFormatRetryCount > 2) {
            break;
          }

          currentResponse = await callAI({
            modelProfile: currentModel,
            taskType: "chat",
            userMessage: `Tool Results:\n\n${toolContext}\n\nContinue the user's TODO workflow. If the next TODO needs a tool, output only valid fenced tool_call JSON blocks in this response. Do not stop at a prose statement that you will use a tool. If you have enough information, provide the final answer. For blueprint creation, use create_blueprint before summarizing, and do not limit the blueprint to a fixed number of nodes; create the content-derived nodes and edges the source actually needs.`,
            documentContext: multiFileContext?.activeFile.content || activeFileAtStart?.content || getEditorContent() || "",
            documentFileName: activeFileAtStart?.name,
            maxTokens: undefined,
            conversationHistory: nextMessages.slice(-6, -1),
            attachments: requestAttachments,
            multiFileContext,
            contextMaxLength,
            skills: requestSkills,
            workspaceRoot: rootPath ?? undefined,
            directoryTree: directoryTree,
            memoryContext: memoryPrompt,
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
      const memoryCandidate = extractMemoryCandidate(response);
      if (memoryCandidate) {
        const memoryResult = await applyMemoryCandidate(memoryCandidate, {
          hasSuccessfulCreateFile,
          isConfirmedPlanExecution: Boolean(override?.clearPendingPlan),
        });
        if (!isWorkspaceCurrent()) return;
        response = stripMemoryCandidate(response);
        if (memoryResult.applied) {
          const targetName = memoryResult.target === "important"
            ? "Importants.md"
            : memoryResult.target === "nova"
              ? "Nova.md"
              : memoryResult.target === "snapshot"
                ? "Snapshot.md"
                : "Cache.md";
          setStatusText(`已更新 ${targetName}`);
        }
      }

      await persistFileCaches();
      if (!isWorkspaceCurrent()) return;

      const assistantMessage: ConversationMessage = {
        id: createId("msg"),
        role: "assistant",
        content: response,
        createdAt: new Date().toISOString(),
        searchCount: requestSearchCount > 0 ? requestSearchCount : undefined,
        workItems: workItems.length > 0 ? workItems : undefined,
      };
      const finalRecord: ConversationRecord = {
        ...draftRecord,
        updatedAt: new Date().toISOString(),
        messages: [...draftRecord.messages, assistantMessage],
        chatSkills: requestSkills,
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
      agentMode: pendingPlan.agentMode,
      agentSubMode: "build",
    };

    await handleSendMessage({
      content: "确认计划，请开始执行。",
      attachments: pendingPlan.userMessage.attachments ?? [],
      skills: buildSkills,
      clearPendingPlan: true,
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
                <div className="message-text">
                  <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                </div>
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
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (activeConversation) {
                  setActiveConversation({
                    ...activeConversation,
                    draftInput: e.target.value,
                  });
                }
              }}
              onKeyDown={handleKeyPress}
              placeholder={currentModel ? t("copilot.askAI") : t("copilot.configureModel")}
              disabled={!currentModel || isLoading}
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

            </div>

            <button
              onClick={() => void handleSendMessage()}
              disabled={!input.trim() || !currentModel || isLoading}
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
              {(["quick", "smart", "architect"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={chatSkills.agentMode === mode ? "active" : ""}
                  onClick={() => {
                    updateChatSkills(prev => ({
                      ...prev,
                      agentMode: mode,
                      agentSubMode: mode === "quick" ? "build" : prev.agentSubMode,
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
