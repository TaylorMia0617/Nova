import { runMcpSearch } from "./mcpService";
import type { AiTaskType, ConversationAttachment, ConversationMessage, ModelProfile } from "../types/ai";
import { serializeAttachmentsForPrompt } from "./attachmentService";

interface AiRequestOptions {
  modelProfile: ModelProfile;
  taskType: AiTaskType;
  userMessage: string;
  documentContext: string;
  conversationHistory: ConversationMessage[];
  selectionPrompt?: string;
  attachments?: ConversationAttachment[];
}

function buildSystemPrompt(taskType: AiTaskType, context: string, selectionPrompt?: string) {
  const base = `You are a creative writing assistant helping a novelist.
You help with structure, scene writing, line editing, continuity, and narrative clarity.
Always return plain text with no surrounding markdown fences.
Current document context:
${context.slice(-3000)}`;

  if (taskType === "chat") {
    return `${base}

When relevant, use the browsing or search context that has already been retrieved from MCP tools.`;
  }

  return `${base}

${selectionPrompt || ""}
Return only the rewritten text.`;
}

function buildOpenAIResponsesInput(userMessage: string, conversationHistory: ConversationMessage[]) {
  return [
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: [{ type: "input_text" as const, text: msg.content }],
    })),
    {
      role: "user" as const,
      content: [{ type: "input_text" as const, text: userMessage }],
    },
  ];
}

function buildChatCompletionMessages(
  systemPrompt: string,
  userMessage: string,
  conversationHistory: ConversationMessage[]
) {
  return [
    {
      role: "system" as const,
      content: systemPrompt,
    },
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    {
      role: "user" as const,
      content: userMessage,
    },
  ];
}

function getFinalUserMessage(userMessage: string, mcpContext: string, attachments: ConversationAttachment[]) {
  const attachmentContext = serializeAttachmentsForPrompt(attachments);
  const composedContexts = [
    mcpContext ? `External research context:\n${mcpContext}` : "",
    attachmentContext ? `Attached file context:\n${attachmentContext}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return composedContexts ? `${userMessage}\n\n${composedContexts}` : userMessage;
}

function isChatCompletionsUrl(url: string) {
  return /\/chat\/completions\/?$/i.test(url);
}

async function parseErrorMessage(response: Response) {
  try {
    const error = await response.json();
    return error.error?.message || error.message || `AI request failed: ${response.status} ${response.statusText}`;
  } catch {
    return `AI request failed: ${response.status} ${response.statusText}`;
  }
}

async function callResponsesApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, taskType, conversationHistory } = options;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelProfile.apiKey}`,
    },
    body: JSON.stringify({
      model: modelProfile.model,
      instructions: systemPrompt,
      input: buildOpenAIResponsesInput(finalUserMessage, conversationHistory),
      max_output_tokens: 1200,
      temperature: taskType === "chat" ? 0.7 : 0.45,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = await response.json();
  const outputText =
    typeof data.output_text === "string"
      ? data.output_text
      : data.output
          ?.flatMap((item: any) =>
            item.type === "message"
              ? item.content
                  ?.filter((content: any) => content.type === "output_text")
                  .map((content: any) => content.text) ?? []
              : []
          )
          .join("");

  if (!outputText) {
    throw new Error("AI response did not include any text output.");
  }

  return outputText.trim();
}

async function callChatCompletionsApi(options: AiRequestOptions, systemPrompt: string, finalUserMessage: string) {
  const { modelProfile, taskType, conversationHistory } = options;

  const response = await fetch(modelProfile.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelProfile.apiKey}`,
    },
    body: JSON.stringify({
      model: modelProfile.model,
      messages: buildChatCompletionMessages(systemPrompt, finalUserMessage, conversationHistory),
      max_tokens: 1200,
      temperature: taskType === "chat" ? 0.7 : 0.45,
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = await response.json();
  const outputText = data.choices?.[0]?.message?.content;

  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  if (Array.isArray(outputText)) {
    const merged = outputText
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("");
    if (merged.trim()) {
      return merged.trim();
    }
  }

  throw new Error("AI response did not include any chat completion text.");
}

async function callOpenAiCompatible(options: AiRequestOptions, mcpContext = "") {
  const { taskType, userMessage, documentContext, selectionPrompt, attachments = [], modelProfile } = options;
  const systemPrompt = buildSystemPrompt(taskType, documentContext, selectionPrompt);
  const finalUserMessage = getFinalUserMessage(userMessage, mcpContext, attachments);

  if (isChatCompletionsUrl(modelProfile.baseUrl)) {
    return callChatCompletionsApi(options, systemPrompt, finalUserMessage);
  }

  return callResponsesApi(options, systemPrompt, finalUserMessage);
}

export async function callAI(options: AiRequestOptions): Promise<string> {
  const { modelProfile, taskType, userMessage } = options;

  let mcpContext = "";
  if (modelProfile.mcpServerUrl.trim()) {
    try {
      const result = await runMcpSearch(modelProfile, userMessage);
      if (result.text.trim()) {
        mcpContext = `Tool: ${result.toolName}\n${result.text.trim()}`;
      }
    } catch (error) {
      if (taskType === "chat") {
        throw error;
      }
    }
  }

  return callOpenAiCompatible(options, mcpContext);
}
