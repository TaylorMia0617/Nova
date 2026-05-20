interface Message {
  role: "user" | "assistant";
  content: string;
}

export async function callAI(
  provider: "openai" | "gemini",
  apiKey: string,
  userMessage: string,
  context: string,
  conversationHistory: Message[]
): Promise<string> {
  if (provider === "openai") {
    return callOpenAI(apiKey, userMessage, context, conversationHistory);
  } else {
    return callGemini(apiKey, userMessage, context, conversationHistory);
  }
}

async function callOpenAI(
  apiKey: string,
  userMessage: string,
  context: string,
  conversationHistory: Message[]
): Promise<string> {
  const systemPrompt = `You are a creative writing assistant helping a novelist. 
You help with character development, plot progression, dialogue, and narrative flow.
When asked to continue or expand text, maintain consistency with the existing style and tone.
Context from the current document:
${context.slice(-2000)}`;

  const input = [
    ...conversationHistory.map((msg) => ({
      role: msg.role,
      content: [
        {
          type: "input_text" as const,
          text: msg.content,
        },
      ],
    })),
    {
      role: "user" as const,
      content: [
        {
          type: "input_text" as const,
          text: userMessage,
        },
      ],
    },
  ];

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      instructions: systemPrompt,
      input,
      max_output_tokens: 1000,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "OpenAI API error");
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
    throw new Error("OpenAI response did not include any text output");
  }

  return outputText;
}

async function callGemini(
  apiKey: string,
  userMessage: string,
  context: string,
  conversationHistory: Message[]
): Promise<string> {
  const systemPrompt = `You are a creative writing assistant helping a novelist. 
You help with character development, plot progression, dialogue, and narrative flow.
When asked to continue or expand text, maintain consistency with the existing style and tone.
Context from the current document:
${context.slice(-2000)}`;

  const historyText = conversationHistory
    .map((msg) => `${msg.role}: ${msg.content}`)
    .join("\n");

  const prompt = `${systemPrompt}\n\n${historyText}\n\nuser: ${userMessage}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1000,
          temperature: 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Gemini API error");
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}
