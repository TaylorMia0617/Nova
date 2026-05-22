import React, { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus, Paperclip, Send, Sparkles, Trash2, X } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
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
import type { ConversationAttachment, ConversationMessage, ConversationRecord, ConversationSummary } from "../types/ai";
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
  const { activeFile, rootPath } = useFileStore();
  const { modelProfiles, defaultChatModelId, getModelProfileById } = useSettingsStore();
  const [conversationSummaries, setConversationSummaries] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationRecord | null>(null);
  const [input, setInput] = useState("");
  const [draftAttachments, setDraftAttachments] = useState<ConversationAttachment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{ text: string; x: number; y: number } | null>(null);
  const [statusText, setStatusText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const currentModel = useMemo(
    () => getModelProfileById(activeConversation?.modelId || defaultChatModelId),
    [activeConversation?.modelId, defaultChatModelId, getModelProfileById]
  );

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
    scrollToBottom();
  }, [activeConversation?.messages, isLoading]);

  useEffect(() => {
    const bootstrap = async () => {
      if (!rootPath) {
        setConversationSummaries([]);
        setActiveConversation(null);
        setInput("");
        setDraftAttachments([]);
        setStatusText("Open a workspace to enable saved conversations.");
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
      const response = await callAI({
        modelProfile: currentModel,
        taskType: "chat",
        userMessage: userMessage.content,
        documentContext: activeFile?.content || getEditorContent() || "",
        conversationHistory: nextMessages.slice(-6, -1),
        attachments: draftAttachments,
      });

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

  const handleDeleteConversation = async () => {
    if (!activeConversation) return;
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
          <h2>AI Copilot</h2>
          <span>{activeConversation?.title || "Conversation"}</span>
        </div>
        <div className="panel-actions">
          <button onClick={() => void handleNewConversation()} title="New conversation">
            <MessageSquarePlus size={16} />
          </button>
          <button onClick={handleDeleteConversation} title="Delete conversation" disabled={!activeConversation}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="copilot-toolbar">
        <select
          value={selectedConversationId}
          onChange={(event) => void loadConversation(event.target.value)}
          disabled={conversationSummaries.length === 0}
        >
          {conversationSummaries.length === 0 && <option value="">No saved conversations</option>}
          {conversationSummaries.map((summary) => (
            <option key={summary.id} value={summary.id}>
              {summary.title}
            </option>
          ))}
        </select>
        <select
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
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </div>
      <div className="chat-container">
        <div className="messages">
          {(activeConversation?.messages.length ?? 0) === 0 && (
            <div className="empty-chat">
              <p>Start a conversation with your writing copilot</p>
              <p className="hint">Each workspace saves its own conversations inside `.novel-assistance`.</p>
            </div>
          )}
          {activeConversation?.messages.map((msg) => (
            <div key={msg.id} className={`message ${msg.role}`}>
              <div className="message-content">
                <div className="message-role">
                  <span>{msg.role}</span>
                  <time>{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                </div>
                <div className="message-text">{msg.content}</div>
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
                    Insert to Editor
                  </button>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="message assistant">
              <div className="message-content">
                <div className="message-role">assistant</div>
                <div className="message-text loading">Thinking...</div>
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
            <span>Insert selection into editor</span>
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
              <span>Attach File</span>
            </button>
            {draftAttachments.length > 0 && (
              <button
                type="button"
                className="clear-attachments-button"
                onClick={() => setDraftAttachments([])}
                disabled={isLoading}
              >
                Clear Attachments
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
            placeholder={currentModel ? "Ask AI to help with your writing..." : "Configure a model first"}
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
          <span>{currentModel ? `Model: ${currentModel.label}` : "No model selected"}</span>
          <span>{activeFile ? `Context: ${activeFile.name}` : "No active file context"}</span>
        </div>
        {statusText && <div className="copilot-status">{statusText}</div>}
      </div>
    </div>
  );
};

export default CopilotPanel;
