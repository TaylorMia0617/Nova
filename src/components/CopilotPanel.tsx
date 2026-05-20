import React, { useState, useRef, useEffect } from "react";
import { Send, Sparkles, Trash2 } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import { useFileStore } from "../stores/fileStore";
import { callAI } from "../services/aiService";
import "./CopilotPanel.css";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const CopilotPanel: React.FC = () => {
  const { apiKey, provider } = useSettingsStore();
  const { activeFile, updateFileContent } = useFileStore();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async () => {
    if (!input.trim() || !apiKey) return;

    const userMessage = input.trim();
    const nextMessages = [...messages, { role: "user" as const, content: userMessage }];
    setInput("");
    setMessages(nextMessages);
    setIsLoading(true);

    try {
      const context = activeFile?.content || "";
      const response = await callAI(
        provider,
        apiKey,
        userMessage,
        context,
        nextMessages.slice(-4, -1)
      );

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: response },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Failed to get response"}`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExpandText = async () => {
    if (!activeFile?.content || !apiKey) return;

    const selectedText = window.getSelection()?.toString() || activeFile.content;
    const lastParagraph = selectedText.slice(-500);

    setInput(`Continue writing from this point: "${lastParagraph}"`);
  };

  const handleClearChat = () => {
    setMessages([]);
  };

  const handleInsertToEditor = (content: string) => {
    if (activeFile) {
      const newContent = activeFile.content + "\n\n" + content;
      updateFileContent(activeFile.path, newContent);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className="copilot-panel">
      <div className="panel-header">
        <h2>AI Copilot</h2>
        <div className="panel-actions">
          <button onClick={handleExpandText} title="AI Expand" disabled={!activeFile || !apiKey}>
            <Sparkles size={16} />
          </button>
          <button onClick={handleClearChat} title="Clear Chat">
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="chat-container">
        <div className="messages">
          {messages.length === 0 && (
            <div className="empty-chat">
              <p>Start a conversation with AI</p>
              <p className="hint">
                {apiKey ? "Type your message below" : "Enter your API key in the header"}
              </p>
            </div>
          )}
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}`}>
              <div className="message-content">
                <div className="message-role">{msg.role}</div>
                <div className="message-text">{msg.content}</div>
                {msg.role === "assistant" && (
                  <button
                    className="insert-button"
                    onClick={() => handleInsertToEditor(msg.content)}
                  >
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
        <div className="input-area">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={
              apiKey ? "Ask AI to help with your writing..." : "Enter API key first"
            }
            disabled={!apiKey || isLoading}
            rows={3}
          />
          <button
            onClick={handleSendMessage}
            disabled={!input.trim() || !apiKey || isLoading}
            className="send-button"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CopilotPanel;
