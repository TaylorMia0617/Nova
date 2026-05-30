import { useSettingsStore } from "../stores/settingsStore";

interface TavilySearchResult {
  results: Array<{
    title: string;
    content: string;
    url: string;
  }>;
}

export async function searchWithTavily(query: string): Promise<string> {
  const { tavilyApiKey } = useSettingsStore.getState();

  if (!tavilyApiKey.trim()) {
    throw new Error("请在设置中配置 Tavily API Key");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: tavilyApiKey,
      query,
      max_results: 5,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`搜索失败: ${error}`);
  }

  const data: TavilySearchResult = await response.json();

  if (!data.results || data.results.length === 0) {
    return "未找到相关结果";
  }

  return data.results
    .map((result, index) => `[${index + 1}] ${result.title}\n${result.content}\n来源: ${result.url}`)
    .join("\n\n");
}
