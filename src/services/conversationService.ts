import type { ConversationRecord, ConversationSummary } from "../types/ai";

function getHost() {
  return window.novelHost;
}

export async function ensureWorkspaceConversationStore() {
  const host = getHost();
  if (!host?.ensureWorkspaceAppData) {
    throw new Error("Conversation storage is only available in the Electron app.");
  }

  return host.ensureWorkspaceAppData();
}

export async function listConversationSummaries(): Promise<ConversationSummary[]> {
  const host = getHost();
  if (!host?.listConversationSummaries) {
    return [];
  }

  return host.listConversationSummaries();
}

export async function readConversation(conversationId: string): Promise<ConversationRecord | null> {
  const host = getHost();
  if (!host?.readConversation) {
    return null;
  }

  return host.readConversation(conversationId);
}

export async function writeConversation(record: ConversationRecord): Promise<ConversationSummary[]> {
  const host = getHost();
  if (!host?.writeConversation) {
    throw new Error("Conversation storage is only available in the Electron app.");
  }

  return host.writeConversation(record);
}

export async function deleteConversation(conversationId: string): Promise<ConversationSummary[]> {
  const host = getHost();
  if (!host?.deleteConversation) {
    throw new Error("Conversation storage is only available in the Electron app.");
  }

  return host.deleteConversation(conversationId);
}
