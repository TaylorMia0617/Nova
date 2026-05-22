import type { ConversationAttachment } from "../types/ai";

const MAX_SINGLE_ATTACHMENT_BYTES = 300 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 900 * 1024;

function getHost() {
  return window.novelHost;
}

export async function pickAttachments() {
  const host = getHost();
  if (!host?.pickAttachments) {
    throw new Error("Attachment selection is only available in the Electron app.");
  }

  return host.pickAttachments();
}

export async function readAttachmentText(filePath: string) {
  const host = getHost();
  if (!host?.readAttachmentText) {
    throw new Error("Attachment reading is only available in the Electron app.");
  }

  return host.readAttachmentText(filePath);
}

export async function selectTextAttachments(existing: ConversationAttachment[]) {
  const picked = await pickAttachments();
  if (!picked || picked.length === 0) return existing;

  const existingTotal = existing.reduce((sum, item) => sum + item.size, 0);
  const nextAttachments = [...existing];
  let runningTotal = existingTotal;

  for (const file of picked) {
    if (nextAttachments.some((attachment) => attachment.path === file.path)) {
      continue;
    }

    if (file.size > MAX_SINGLE_ATTACHMENT_BYTES) {
      throw new Error(`"${file.name}" exceeds the ${Math.round(MAX_SINGLE_ATTACHMENT_BYTES / 1024)}KB single-file limit.`);
    }

    if (runningTotal + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed the ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024)}KB total size limit.`);
    }

    const content = await readAttachmentText(file.path);
    nextAttachments.push({
      id: `att-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: file.name,
      path: file.path,
      size: file.size,
      mimeType: file.mimeType,
      textContent: content.textContent,
      createdAt: new Date().toISOString(),
      truncated: content.truncated,
    });
    runningTotal += file.size;
  }

  return nextAttachments;
}

export function serializeAttachmentsForPrompt(attachments: ConversationAttachment[]) {
  if (attachments.length === 0) return "";

  return attachments
    .map((attachment) => {
      const truncatedNote = attachment.truncated ? "\n[Content truncated due to size limit]" : "";
      return `Attachment: ${attachment.name}\nPath: ${attachment.path}\nContent:\n${attachment.textContent}${truncatedNote}`;
    })
    .join("\n\n---\n\n");
}
