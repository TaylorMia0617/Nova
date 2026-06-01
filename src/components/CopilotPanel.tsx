import React, { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquarePlus, Paperclip, Send, Settings, Sparkles, Trash2, X } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import { useTranslation } from "../hooks/useTranslation";
import { callAI } from "../services/aiService";
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
import type { WorkspaceNode } from "../services/fileSystemService";
import type { ChatSkills, ConversationAttachment, ConversationMessage, ConversationRecord, ConversationSummary, FileChange, FileContentCache, MultiFileContext } from "../types/ai";
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

const CopilotPanel: React.FC = () => {
  const { activeFile, rootPath, openTabs, files } = useFileStore();
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
  const [tempMaxTokens, setTempMaxTokens] = useState(String(chatMaxTokens));
  const [fileCaches, setFileCaches] = useState<Map<string, FileContentCache>>(new Map());
  const fileCachesRef = useRef<Map<string, FileContentCache>>(new Map());
  const [chatSkills, setChatSkills] = useState<ChatSkills>({
    enableWebSearch: false,
    thinkingDepth: "off",
  });
  const [webSearchCount, setWebSearchCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastDefaultChatModelIdRef = useRef(defaultChatModelId);

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
    if (!activeFile) return undefined;

    const currentContent = activeFile.content;

    if (!shouldCacheFile(currentContent)) {
      return {
        activeFile: {
          meta: {
            fileName: activeFile.name,
            filePath: activeFile.path,
            charCount: currentContent.length,
            lineCount: currentContent.split('\n').length,
            wordCount: currentContent.length,
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
        const tab = openTabs.find(t => t.path === path);
        const tabContent = tab?.content ?? cache.content;

        return {
          meta: {
            fileName: path.split(/[/\\]/).pop() || path,
            filePath: path,
            charCount: tabContent.length,
            lineCount: tabContent.split('\n').length,
            wordCount: tabContent.length,
          },
          recentChanges: calculateChanges(cache.content, tabContent),
        };
      });

    // 使用 ref 构建 allBoundFiles
    const allBoundFiles = Array.from(fileCachesRef.current.values()).map(cache => ({
      meta: {
        fileName: cache.filePath.split(/[/\\]/).pop() || cache.filePath,
        filePath: cache.filePath,
        charCount: cache.content.length,
        lineCount: cache.content.split('\n').length,
        wordCount: cache.content.length,
      },
      lastUsed: cache.lastSentAt,
    }));

    return {
      activeFile: {
        meta: {
          fileName: activeFile.name,
          filePath: activeFile.path,
          charCount: currentContent.length,
          lineCount: currentContent.split('\n').length,
          wordCount: currentContent.length,
        },
        content: currentContent,
        cachedContent: activeCachedContent,
        recentChanges: activeChanges,
      },
      otherBoundFiles,
      allBoundFiles,
    };
  };

  const loadConversation = async (conversationId: string) => {
    const record = await readConversation(conversationId);
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

    const cachesArray = Array.from(fileCaches.values());
    const updatedRecord = {
      ...activeConversation,
      boundFileCaches: cachesArray,
      updatedAt: new Date().toISOString(),
    };

    await persistConversation(updatedRecord);
  };

  const persistChatSkills = async () => {
    if (!activeConversation) return;

    const updatedRecord = {
      ...activeConversation,
      chatSkills,
      updatedAt: new Date().toISOString(),
    };

    await persistConversation(updatedRecord);
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
        cachesMap.set(cache.filePath, cache);
      });
      setFileCaches(cachesMap);
    } else {
      setFileCaches(new Map());
    }
  }, [activeConversation?.id]);

  useEffect(() => {
    if (activeConversation?.chatSkills) {
      setChatSkills(activeConversation.chatSkills);
    } else {
      setChatSkills({
        enableWebSearch: false,
        thinkingDepth: "off",
      });
    }
  }, [activeConversation?.id]);

  useEffect(() => {
    const bootstrap = async () => {
      if (!rootPath) {
        setConversationSummaries([]);
        setActiveConversation(null);
        setInput("");
        setDraftAttachments([]);
        setStatusText(t("copilot.openWorkspace"));
        return;
      }

      try {
        await ensureWorkspaceConversationStore();
        const summaries = await listConversationSummaries();
        setConversationSummaries(summaries);
        if (summaries[0]) {
          await loadConversation(summaries[0].id);
          return;
        }

        const draft = createConversation(defaultChatModelId, activeFile?.path);
        setActiveConversation(draft);
      } catch (error) {
        setStatusText(error instanceof Error ? error.message : "Failed to load conversations.");
      }
    };

    void bootstrap();
  }, [activeFile?.path, defaultChatModelId, rootPath]);

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
    const next = createConversation(defaultChatModelId, activeFile?.path);
    setActiveConversation(next);
    setInput("");
    setDraftAttachments([]);
    setStatusText("");
    await persistConversation(next);
  };

  const handleSendMessage = async () => {
    if (!input.trim() || !activeConversation || !currentModel || isLoading) return;

    // 重置搜索计数
    setWebSearchCount(0);

    const userMessage: ConversationMessage = {
      id: createId("msg"),
      role: "user",
      content: input.trim(),
      createdAt: new Date().toISOString(),
      attachments: draftAttachments,
      skills: chatSkills,
    };

    const nextMessages = [...activeConversation.messages, userMessage];
    const draftRecord: ConversationRecord = {
      ...activeConversation,
      title: activeConversation.messages.length === 0 ? buildTitleFromMessage(userMessage.content) : activeConversation.title,
      updatedAt: new Date().toISOString(),
      contextFilePath: activeFile?.path ?? activeConversation.contextFilePath ?? null,
      messages: nextMessages,
      draftInput: "",
    };

    setInput("");
    setDraftAttachments([]);
    setIsLoading(true);
    setStatusText("");
    await persistConversation(draftRecord);

    try {
      const fileSizeWarning = activeFile ? getFileSizeWarning(activeFile.content) : null;
      if (fileSizeWarning) {
        setStatusText(fileSizeWarning);
      }

      // 更新文件缓存
      if (activeFile) {
        updateFileCache(activeFile.path, activeFile.content);
      }

      const multiFileContext = buildMultiFileContext();

      // 构建目录结构字符串
      const directoryTree = buildDirectoryTreeString(files);

      let response = await callAI({
        modelProfile: currentModel,
        taskType: "chat",
        userMessage: userMessage.content,
        documentContext: multiFileContext?.activeFile.content || activeFile?.content || getEditorContent() || "",
        documentFileName: activeFile?.name,
        maxTokens: chatMaxTokens,
        conversationHistory: nextMessages.slice(-6, -1),
        attachments: draftAttachments,
        multiFileContext,
        contextMaxLength,
        skills: chatSkills,
        workspaceRoot: rootPath ?? undefined,
        directoryTree: directoryTree,
      });

      // 实现多轮工具调用循环
      let currentResponse = response;
      const maxIterations = 100; // 最多100轮工具调用

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        let toolCallMatch = currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/);
        if (!toolCallMatch || !rootPath) break;
        
        const toolResults: Array<{ name: string; result: string }> = [];
        
        // 执行当前轮次的所有工具调用
        while (toolCallMatch) {
          try {
            const toolCall = JSON.parse(toolCallMatch[1]);
            const toolResult = await runLocalTool(
              toolCall.name,
              toolCall.arguments,
              rootPath,
              files,
              {
                enableWebSearch: chatSkills.enableWebSearch,
                searchCount: webSearchCount,
                searchLimit: webSearchLimit
              }
            );
            
            // 更新搜索计数
            if (toolCall.name === "web_search" && !toolResult.result.startsWith("Error")) {
              setWebSearchCount(prev => prev + 1);
            }
            
            // 记录工具调用结果
            toolResults.push({ name: toolCall.name, result: toolResult.result });
            
            // 移除已处理的工具调用
            currentResponse = currentResponse.replace(toolCallMatch[0], '');
            toolCallMatch = currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/);
          } catch (error) {
            console.error("Tool call error:", error);
            break;
          }
        }
        
        // 如果有工具调用结果，将结果反馈给 AI 让它继续处理
        if (toolResults.length > 0) {
          const toolContext = toolResults.map(r => `Tool: ${r.name}\nResult: ${r.result}`).join("\n\n");
          
          // 更新中间结果显示
          setStatusText(`Processing tool results (iteration ${iteration + 1})...`);
          
          currentResponse = await callAI({
            modelProfile: currentModel,
            taskType: "chat",
            userMessage: `Based on the tool results below, please continue with your task:\n\n${toolContext}`,
            documentContext: multiFileContext?.activeFile.content || activeFile?.content || getEditorContent() || "",
            documentFileName: activeFile?.name,
            maxTokens: chatMaxTokens,
            conversationHistory: nextMessages.slice(-6, -1),
            attachments: draftAttachments,
            multiFileContext,
            contextMaxLength,
            skills: chatSkills,
            workspaceRoot: rootPath ?? undefined,
            directoryTree: directoryTree,
          });
          
          // 检查 AI 的回复是否包含更多工具调用
          if (!currentResponse.match(/```tool_call\s*\n([\s\S]*?)\n```/)) {
            // AI 不再调用工具，显示最终回复
            break;
          }
        }
      }
      
      // 组合最终响应（只显示 AI 的最终回复）
      response = currentResponse;

      await persistFileCaches();
      await persistChatSkills();

      const assistantMessage: ConversationMessage = {
        id: createId("msg"),
        role: "assistant",
        content: response,
        createdAt: new Date().toISOString(),
        searchCount: webSearchCount > 0 ? webSearchCount : undefined,
      };
      const finalRecord: ConversationRecord = {
        ...draftRecord,
        updatedAt: new Date().toISOString(),
        messages: [...draftRecord.messages, assistantMessage],
      };
      await persistConversation(finalRecord);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Failed to get AI response.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    setIsDeleteConfirmOpen(false);
    if (!activeConversation) return;

    try {
      const summaries = await deleteConversation(activeConversation.id);
      setConversationSummaries(summaries);
      setFileCaches(new Map());

      if (summaries[0]) {
        await loadConversation(summaries[0].id);
        return;
      }

      const draft = createConversation(defaultChatModelId, activeFile?.path);
      setActiveConversation(draft);
      setInput("");
      setDraftAttachments([]);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Failed to delete conversation.");
    }
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
                  <span>{msg.role}</span>
                  <time>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </div>
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
                <div className="message-role">assistant</div>
                <div className="message-text loading">{t("copilot.thinking")}</div>
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
          {draftAttachments.length > 0 && (
            <div className="draft-attachments">
              {draftAttachments.map((attachment) => (
                <div key={attachment.id} className="draft-attachment-chip">
                  <div>
                    <strong>{attachment.name}</strong>
                    <span>{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
                  </div>
                  <button type="button" onClick={() => setDraftAttachments((current) => current.filter((item) => item.id !== attachment.id))} disabled={isLoading}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
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
          <div className="input-footer">
            <div className="skills-toolbar">
              <button
                type="button"
                className={`skill-pill ${chatSkills.enableWebSearch ? "active" : ""}`}
                onClick={() => setChatSkills(prev => ({
                  ...prev,
                  enableWebSearch: !prev.enableWebSearch,
                }))}
              >
                {t("copilot.search")}
              </button>

              <div className="skill-select">
                <span>{t("copilot.thinkingDepth")}</span>
                <select
                  value={chatSkills.thinkingDepth}
                  onChange={(e) => setChatSkills(prev => ({
                    ...prev,
                    thinkingDepth: e.target.value as ChatSkills["thinkingDepth"],
                  }))}
                >
                  <option value="off">{t("copilot.off")}</option>
                  <option value="low">{t("copilot.low")}</option>
                  <option value="medium">{t("copilot.medium")}</option>
                  <option value="high">{t("copilot.high")}</option>
                </select>
              </div>
            </div>

            <button
              onClick={() => void handleSendMessage()}
              disabled={!input.trim() || !currentModel || isLoading}
              className="send-button"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
        <div className="copilot-footer-note">
          <span>{currentModel ? `${t("copilot.model")}: ${currentModel.label}` : t("copilot.noModelSelected")}</span>
          <span>{activeFile ? `${t("copilot.context")}: ${activeFile.name}` : t("copilot.noActiveFileContext")}</span>
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
