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
import type { ConversationAttachment, ConversationMessage, ConversationRecord, ConversationSummary, DocumentMeta, MultiFileContext } from "../types/ai";
import "./CopilotPanel.css";

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
  const { activeFile, rootPath, getFileChanges, openTabs } = useFileStore();
  const { modelProfiles, defaultChatModelId, getModelProfileById, chatMaxTokens, setChatMaxTokens, contextMaxLength } = useSettingsStore();
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
  const [conversationFileHistory, setConversationFileHistory] = useState<
    Array<{ meta: DocumentMeta; lastUsed: string }>
  >([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastDefaultChatModelIdRef = useRef(defaultChatModelId);

  const currentModel = useMemo(
    () => getModelProfileById(activeConversation?.modelId || defaultChatModelId),
    [activeConversation?.modelId, defaultChatModelId, getModelProfileById, modelProfiles]
  );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const buildMultiFileContext = (): MultiFileContext | undefined => {
    if (!activeFile) return undefined;

    const activeMeta: DocumentMeta = {
      fileName: activeFile.name,
      filePath: activeFile.path,
      charCount: activeFile.savedContent.length,
      lineCount: activeFile.savedContent.split('\n').length,
      wordCount: activeFile.savedContent.length,
    };

    const otherFiles = openTabs
      .filter(tab => tab.path !== activeFile.path)
      .slice(0, 5)
      .map(tab => ({
        meta: {
          fileName: tab.name,
          filePath: tab.path,
          charCount: tab.savedContent.length,
          lineCount: tab.savedContent.split('\n').length,
          wordCount: tab.savedContent.length,
        },
        preview: tab.savedContent.slice(0, 500),
      }));

    const fileChanges = getFileChanges(activeFile.path);

    return {
      activeFile: {
        meta: activeMeta,
        content: activeFile.savedContent,
        recentChanges: fileChanges,
      },
      otherOpenFiles: otherFiles,
      conversationFiles: conversationFileHistory,
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

    const userMessage: ConversationMessage = {
      id: createId("msg"),
      role: "user",
      content: input.trim(),
      createdAt: new Date().toISOString(),
      attachments: draftAttachments,
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
      const multiFileContext = buildMultiFileContext();

      const response = await callAI({
        modelProfile: currentModel,
        taskType: "chat",
        userMessage: userMessage.content,
        documentContext: activeFile?.content || getEditorContent() || "",
        documentFileName: activeFile?.name,
        maxTokens: chatMaxTokens,
        conversationHistory: nextMessages.slice(-6, -1),
        attachments: draftAttachments,
        multiFileContext,
        contextMaxLength,
      });

      if (activeFile) {
        const existing = conversationFileHistory.find(f => f.meta.filePath === activeFile.path);
        if (existing) {
          setConversationFileHistory(prev =>
            prev.map(f =>
              f.meta.filePath === activeFile.path
                ? { ...f, lastUsed: new Date().toISOString() }
                : f
            )
          );
        } else {
          setConversationFileHistory(prev => [
            ...prev,
            {
              meta: {
                fileName: activeFile.name,
                filePath: activeFile.path,
                charCount: activeFile.savedContent.length,
                lineCount: activeFile.savedContent.split('\n').length,
                wordCount: activeFile.savedContent.length,
              },
              lastUsed: new Date().toISOString(),
            }
          ]);
        }
      }

      const assistantMessage: ConversationMessage = {
        id: createId("msg"),
        role: "assistant",
        content: response,
        createdAt: new Date().toISOString(),
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
          <button
            onClick={() => void handleSendMessage()}
            disabled={!input.trim() || !currentModel || isLoading}
            className="send-button"
          >
            <Send size={16} />
          </button>
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
