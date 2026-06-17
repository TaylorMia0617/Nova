import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ModelProfile, ModelTransportType, SelectionPromptTemplates } from "../types/ai";
import { readGlobalApiConfig, writeGlobalApiConfig } from "../services/fileSystemService";
import type { Locale } from "../i18n";
import { setLocale } from "../i18n";

type PromptKey = keyof SelectionPromptTemplates;
export type AppTheme = "dark" | "light";
export type HeadingColors = {
  h1: string;
  h2: string;
  h3: string;
};

export type ProxySettings = {
  proxyEnabled: boolean;
  proxyUrl: string;
  proxyBypassRules: string;
};

const DEFAULT_REASONING_DEPTH = 3;

interface SettingsState {
  language: Locale;
  theme: AppTheme;
  backgroundImage: string | null;
  backgroundOpacity: number;
  headingColors: HeadingColors;
  modelProfiles: ModelProfile[];
  defaultChatModelId: string;
  defaultSelectionModelId: string;
  defaultEditReviewModelId: string;
  selectionPromptTemplates: SelectionPromptTemplates;
  chatMaxTokens: number;
  contextMaxLength: number;
  tavilyApiKey: string;
  webSearchLimit: number;
  proxyEnabled: boolean;
  proxyUrl: string;
  proxyBypassRules: string;
  setLanguage: (locale: Locale) => void;
  setTheme: (theme: AppTheme) => void;
  setBackgroundImage: (value: string) => void;
  clearBackgroundImage: () => void;
  setBackgroundOpacity: (value: number) => void;
  setHeadingColor: (level: keyof HeadingColors, color: string) => void;
  setModelProfiles: (profiles: ModelProfile[]) => void;
  updateModelProfile: (id: string, patch: Partial<ModelProfile>) => void;
  removeModelProfile: (id: string) => void;
  setDefaultChatModelId: (id: string) => void;
  setDefaultSelectionModelId: (id: string) => void;
  setDefaultEditReviewModelId: (id: string) => void;
  setSelectionPromptTemplate: (key: PromptKey, value: string) => void;
  setChatMaxTokens: (value: number) => void;
  setContextMaxLength: (value: number) => void;
  setTavilyApiKey: (value: string) => void;
  setWebSearchLimit: (value: number) => void;
  setProxySettings: (settings: ProxySettings) => void;
  getModelProfileById: (id: string | null | undefined) => ModelProfile | null;
}

const DEFAULT_PROFILE: ModelProfile = {
  id: "default-openai",
  label: "OpenAI Default",
  model: "gpt-4o-mini",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1/responses",
  transportType: "openai-responses",
  mcpServerUrl: "",
  headers: [],
  rememberSecrets: true,
  reasoningDepth: DEFAULT_REASONING_DEPTH,
};

const inferTransportType = (profile: Partial<ModelProfile>): ModelTransportType => {
  const explicit = profile.transportType;
  if (
    explicit === "openai-responses" ||
    explicit === "openai-chat-completions" ||
    explicit === "anthropic-messages" ||
    explicit === "openai-compatible"
  ) {
    return explicit;
  }

  const baseUrl = (profile.baseUrl ?? "").trim().toLowerCase();
  const model = (profile.model ?? "").trim().toLowerCase();
  if (baseUrl.includes("anthropic.com") || model.startsWith("claude-")) {
    return "anthropic-messages";
  }
  if (/\/responses\/?$/i.test(baseUrl)) {
    return "openai-responses";
  }
  if (/\/chat\/completions\/?$/i.test(baseUrl)) {
    return "openai-chat-completions";
  }
  return "openai-compatible";
};

const normalizeModelProfile = (profile: Partial<ModelProfile>): ModelProfile => ({
  ...DEFAULT_PROFILE,
  ...profile,
  id: profile.id || `model-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  label: profile.label || "Untitled Model",
  model: profile.model ?? "",
  apiKey: profile.apiKey ?? "",
  baseUrl: profile.baseUrl || DEFAULT_PROFILE.baseUrl,
  transportType: inferTransportType(profile),
  mcpServerUrl: profile.mcpServerUrl ?? "",
  headers: Array.isArray(profile.headers) ? profile.headers : [],
  rememberSecrets: profile.rememberSecrets ?? true,
  reasoningDepth: Math.min(10, Math.max(0, Number(profile.reasoningDepth ?? DEFAULT_REASONING_DEPTH) || DEFAULT_REASONING_DEPTH)),
});

const normalizeModelProfiles = (profiles?: Partial<ModelProfile>[] | null): ModelProfile[] => {
  const normalized = (profiles ?? []).map(normalizeModelProfile);
  return normalized.length > 0 ? normalized : [DEFAULT_PROFILE];
};

const DEFAULT_PROMPTS: SelectionPromptTemplates = {
  polish: `请你对下面文本进行“去AI味、增强作者味”的改写。

要求：
1. 保留原意、信息量和基本结构，不要擅自新增设定。
2. 减少模板化表达，避免“首先、其次、总之、值得注意的是”等机械连接词。
3. 让句子更像真人作者写作：有长短句变化，有轻微停顿，有自然转折。
4. 保留适度个人判断和语气，不要写得过度客观、圆滑、像说明书。
5. 删除空泛套话，改成更具体、更有画面感或更有作者立场的表达。
6. 不要过度华丽，不要堆比喻，不要网文腔。
7. 如果原文有情绪，请保留情绪；如果原文偏理性，请保持克制但别僵硬。
8. 减少“——”的滥用。
9. 允许保留少量不完美的口语化表达，让文本看起来像作者自然写出来的，而不是被机器打磨到过度平滑。
10. 输出只给改写后的正文，不要解释修改过程。`,
  correct: "请纠正这段文字中的错别字、病句、标点和语法问题，只返回修正后的文本。",
  stylize: "请在保留核心信息的前提下，将这段文字改写得更有文学性和画面感，但不要过度华丽、不要堆比喻、不要网文腔。只返回改写后的正文。",
};

const LEGACY_DEFAULT_PROMPTS: SelectionPromptTemplates = {
  polish: "请在不改变原意的前提下润色这段文字，提升流畅度、节奏感与表达质感，只返回修改后的文本。",
  correct: "请纠正这段文字中的错别字、病句、标点和语法问题，只返回修正后的文本。",
  stylize: "请在保留核心信息的前提下，将这段文字风格化得更有文学性和画面感，只返回改写后的文本。",
};

const DEFAULT_HEADING_COLORS: HeadingColors = {
  h1: "#e2e8f0",
  h2: "#e2e8f0",
  h3: "#e2e8f0",
};

export const DEFAULT_PROXY_SETTINGS: ProxySettings = {
  proxyEnabled: false,
  proxyUrl: "",
  proxyBypassRules: "localhost,127.0.0.1,::1",
};

const normalizeSelectionPromptTemplates = (
  prompts?: Partial<SelectionPromptTemplates> | null
): SelectionPromptTemplates => {
  const merged = {
    ...DEFAULT_PROMPTS,
    ...(prompts ?? {}),
  };

  return {
    polish: merged.polish === LEGACY_DEFAULT_PROMPTS.polish ? DEFAULT_PROMPTS.polish : merged.polish,
    correct: merged.correct === LEGACY_DEFAULT_PROMPTS.correct ? DEFAULT_PROMPTS.correct : merged.correct,
    stylize: merged.stylize === LEGACY_DEFAULT_PROMPTS.stylize ? DEFAULT_PROMPTS.stylize : merged.stylize,
  };
};

const resolveModelId = (
  profiles: ModelProfile[],
  preferredId?: string | null,
  fallbackId?: string | null
) => {
  const safeProfiles = profiles.length > 0 ? profiles : [DEFAULT_PROFILE];
  const availableIds = new Set(safeProfiles.map((profile) => profile.id));
  if (preferredId && availableIds.has(preferredId)) return preferredId;
  if (fallbackId && availableIds.has(fallbackId)) return fallbackId;
  return safeProfiles[0].id;
};

const sanitizeProfile = (profile: ModelProfile): ModelProfile => ({
  ...normalizeModelProfile(profile),
  apiKey: profile.rememberSecrets ? profile.apiKey : "",
  headers: profile.rememberSecrets ? profile.headers : [],
});

const SETTINGS_STORAGE_NAME = "novel-assistance-settings";
const fallbackSettingsStorage = new Map<string, string>();

const getGlobalSettingsHost = () =>
  typeof window === "undefined"
    ? null
    : ((window as typeof window & {
        novelHost?: {
          readGlobalSettings?: (name: string) => Promise<string | null>;
          writeGlobalSettings?: (name: string, content: string) => Promise<void>;
          deleteGlobalSettings?: (name: string) => Promise<void>;
          readGlobalApiConfig?: () => Promise<string>;
          writeGlobalApiConfig?: (content: string) => Promise<void>;
        };
      }).novelHost ?? null);

const globalSettingsStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const host = getGlobalSettingsHost();
    if (host?.readGlobalSettings) {
      const appSettings = await host.readGlobalSettings(name);
      if (appSettings) return appSettings;
      if (host.readGlobalApiConfig) {
        return host.readGlobalApiConfig();
      }
      return null;
    }

    return fallbackSettingsStorage.get(name) ?? null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const host = getGlobalSettingsHost();
    if (host?.writeGlobalSettings) {
      await host.writeGlobalSettings(name, value);
    } else {
      fallbackSettingsStorage.set(name, value);
    }

  },
  removeItem: async (name: string): Promise<void> => {
    const host = getGlobalSettingsHost();
    if (host?.deleteGlobalSettings) {
      await host.deleteGlobalSettings(name);
      return;
    }

    fallbackSettingsStorage.delete(name);
  },
};

export async function syncFromFile(): Promise<boolean> {
  try {
    const fileContent = await readGlobalApiConfig();
    if (!fileContent) return false;

    const parsed = JSON.parse(fileContent);
    const currentState = useSettingsStore.getState();
    const parsedProfiles = normalizeModelProfiles(parsed.modelProfiles);

    const hasChanges =
      JSON.stringify(parsedProfiles) !== JSON.stringify(currentState.modelProfiles) ||
      JSON.stringify(parsed.selectionPromptTemplates) !==
        JSON.stringify(currentState.selectionPromptTemplates) ||
      JSON.stringify(parsed.defaultChatModelId) !==
        JSON.stringify(currentState.defaultChatModelId) ||
      JSON.stringify(parsed.defaultSelectionModelId) !==
        JSON.stringify(currentState.defaultSelectionModelId) ||
      JSON.stringify(parsed.defaultEditReviewModelId) !==
        JSON.stringify(currentState.defaultEditReviewModelId) ||
      parsed.chatMaxTokens !== currentState.chatMaxTokens ||
      parsed.contextMaxLength !== currentState.contextMaxLength ||
      parsed.tavilyApiKey !== currentState.tavilyApiKey ||
      parsed.webSearchLimit !== currentState.webSearchLimit ||
      (parsed.proxyEnabled ?? currentState.proxyEnabled) !== currentState.proxyEnabled ||
      (parsed.proxyUrl ?? currentState.proxyUrl) !== currentState.proxyUrl ||
      (parsed.proxyBypassRules ?? currentState.proxyBypassRules) !== currentState.proxyBypassRules ||
      parsed.theme !== currentState.theme ||
      parsed.backgroundImage !== currentState.backgroundImage ||
      (parsed.backgroundOpacity ?? currentState.backgroundOpacity) !== currentState.backgroundOpacity ||
      parsed.language !== currentState.language ||
      JSON.stringify(parsed.headingColors ?? DEFAULT_HEADING_COLORS) !==
        JSON.stringify(currentState.headingColors);

    if (hasChanges) {
      useSettingsStore.setState({
        ...parsed,
        modelProfiles: parsedProfiles,
        defaultChatModelId: resolveModelId(parsedProfiles, parsed.defaultChatModelId),
        defaultSelectionModelId: resolveModelId(
          parsedProfiles,
          parsed.defaultSelectionModelId,
          parsed.defaultChatModelId ?? currentState.defaultChatModelId
        ),
        defaultEditReviewModelId: resolveModelId(
          parsedProfiles,
          parsed.defaultEditReviewModelId,
          parsed.defaultSelectionModelId ?? currentState.defaultSelectionModelId
        ),
        selectionPromptTemplates: normalizeSelectionPromptTemplates(parsed.selectionPromptTemplates),
        headingColors: {
          ...DEFAULT_HEADING_COLORS,
          ...(parsed.headingColors ?? {}),
        },
        proxyEnabled: parsed.proxyEnabled ?? DEFAULT_PROXY_SETTINGS.proxyEnabled,
        proxyUrl: parsed.proxyUrl ?? DEFAULT_PROXY_SETTINGS.proxyUrl,
        proxyBypassRules: parsed.proxyBypassRules ?? DEFAULT_PROXY_SETTINGS.proxyBypassRules,
      });
      return true;
    }
    return false;
  } catch (error) {
    console.warn("Failed to sync settings from global config file:", error);
    return false;
  }
}

export async function exportToFile(): Promise<boolean> {
  try {
    const state = useSettingsStore.getState();
    let existing: Record<string, unknown> = {};
    const existingContent = await readGlobalApiConfig();
    if (existingContent) {
      try {
        existing = JSON.parse(existingContent);
      } catch {
        existing = {};
      }
    }
    const dataToExport = {
      ...existing,
      language: state.language,
      modelProfiles: state.modelProfiles.map(sanitizeProfile),
      defaultChatModelId: state.defaultChatModelId,
      defaultSelectionModelId: state.defaultSelectionModelId,
      defaultEditReviewModelId: state.defaultEditReviewModelId,
      selectionPromptTemplates: state.selectionPromptTemplates,
      chatMaxTokens: state.chatMaxTokens,
      contextMaxLength: state.contextMaxLength,
      tavilyApiKey: state.tavilyApiKey,
      webSearchLimit: state.webSearchLimit,
      proxyEnabled: state.proxyEnabled,
      proxyUrl: state.proxyUrl,
      proxyBypassRules: state.proxyBypassRules,
      theme: state.theme,
      backgroundImage: state.backgroundImage,
      backgroundOpacity: state.backgroundOpacity,
      headingColors: state.headingColors,
    };
    await writeGlobalApiConfig(JSON.stringify(dataToExport, null, 2));
    return true;
  } catch (error) {
    console.warn("Failed to export settings to global config file:", error);
    return false;
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      language: "zh-CN" as Locale,
      theme: "dark",
      backgroundImage: null,
      backgroundOpacity: 35,
      headingColors: DEFAULT_HEADING_COLORS,
      modelProfiles: [DEFAULT_PROFILE],
      defaultChatModelId: DEFAULT_PROFILE.id,
      defaultSelectionModelId: DEFAULT_PROFILE.id,
      defaultEditReviewModelId: DEFAULT_PROFILE.id,
      selectionPromptTemplates: DEFAULT_PROMPTS,
      chatMaxTokens: 8192,
      contextMaxLength: 5000,
      tavilyApiKey: "",
      webSearchLimit: 15,
      proxyEnabled: DEFAULT_PROXY_SETTINGS.proxyEnabled,
      proxyUrl: DEFAULT_PROXY_SETTINGS.proxyUrl,
      proxyBypassRules: DEFAULT_PROXY_SETTINGS.proxyBypassRules,
      setLanguage: (locale) => {
        setLocale(locale);
        set({ language: locale });
      },
      setTheme: (theme) => set({ theme }),
      setBackgroundImage: (value) => set({ backgroundImage: value }),
      clearBackgroundImage: () => set({ backgroundImage: null }),
      setBackgroundOpacity: (value) => set({ backgroundOpacity: Math.min(100, Math.max(0, value)) }),
      setHeadingColor: (level, color) =>
        set((state) => ({
          headingColors: {
            ...state.headingColors,
            [level]: color,
          },
        })),
      setModelProfiles: (profiles) =>
        set((state) => {
          const nextProfiles = normalizeModelProfiles(profiles);
          const nextChatModelId = resolveModelId(nextProfiles, state.defaultChatModelId);
          const nextSelectionModelId = resolveModelId(nextProfiles, state.defaultSelectionModelId, nextChatModelId);
          return {
            modelProfiles: nextProfiles,
            defaultChatModelId: nextChatModelId,
            defaultSelectionModelId: nextSelectionModelId,
            defaultEditReviewModelId: resolveModelId(nextProfiles, state.defaultEditReviewModelId, nextSelectionModelId),
          };
        }),
      updateModelProfile: (id, patch) =>
        set((state) => ({
          modelProfiles: state.modelProfiles.map((profile) =>
            profile.id === id
              ? normalizeModelProfile({
                  ...profile,
                  ...patch,
                })
              : profile
          ),
        })),
      removeModelProfile: (id) =>
        set((state) => {
          const nextProfiles = state.modelProfiles.filter((profile) => profile.id !== id);
          const safeProfiles = nextProfiles.length > 0 ? nextProfiles : [DEFAULT_PROFILE];

          return {
            modelProfiles: safeProfiles,
            defaultChatModelId: resolveModelId(safeProfiles, state.defaultChatModelId === id ? null : state.defaultChatModelId),
            defaultSelectionModelId: resolveModelId(safeProfiles, state.defaultSelectionModelId === id ? null : state.defaultSelectionModelId),
            defaultEditReviewModelId: resolveModelId(
              safeProfiles,
              state.defaultEditReviewModelId === id ? null : state.defaultEditReviewModelId,
              state.defaultSelectionModelId === id ? null : state.defaultSelectionModelId
            ),
          };
        }),
      setDefaultChatModelId: (id) => set({ defaultChatModelId: id }),
      setDefaultSelectionModelId: (id) => set({ defaultSelectionModelId: id }),
      setDefaultEditReviewModelId: (id) => set({ defaultEditReviewModelId: id }),
      setSelectionPromptTemplate: (key, value) =>
        set((state) => ({
          selectionPromptTemplates: {
            ...state.selectionPromptTemplates,
            [key]: value,
          },
        })),
      setChatMaxTokens: (value) => set({ chatMaxTokens: value }),
      setContextMaxLength: (value) => set({ contextMaxLength: value }),
      setTavilyApiKey: (value) => set({ tavilyApiKey: value }),
      setWebSearchLimit: (value) => set({ webSearchLimit: value }),
      setProxySettings: (settings) => set({
        proxyEnabled: settings.proxyEnabled,
        proxyUrl: settings.proxyUrl,
        proxyBypassRules: settings.proxyBypassRules,
      }),
      getModelProfileById: (id) => {
        if (!id) return null;
        return get().modelProfiles.find((profile) => profile.id === id) ?? null;
      },
    }),
    {
      name: SETTINGS_STORAGE_NAME,
      storage: createJSONStorage(() => globalSettingsStorage),
      partialize: (state) => ({
        language: state.language,
        modelProfiles: state.modelProfiles.map(sanitizeProfile),
        defaultChatModelId: state.defaultChatModelId,
        defaultSelectionModelId: state.defaultSelectionModelId,
        defaultEditReviewModelId: state.defaultEditReviewModelId,
        selectionPromptTemplates: state.selectionPromptTemplates,
        chatMaxTokens: state.chatMaxTokens,
        contextMaxLength: state.contextMaxLength,
        tavilyApiKey: state.tavilyApiKey,
        webSearchLimit: state.webSearchLimit,
        proxyEnabled: state.proxyEnabled,
        proxyUrl: state.proxyUrl,
        proxyBypassRules: state.proxyBypassRules,
        theme: state.theme,
        backgroundImage: state.backgroundImage,
        backgroundOpacity: state.backgroundOpacity,
        headingColors: state.headingColors,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<SettingsState> | null;
        const persistedProfiles = normalizeModelProfiles(persisted?.modelProfiles);
        return {
          ...currentState,
          ...(persisted ?? {}),
          modelProfiles: persistedProfiles,
          defaultChatModelId: resolveModelId(persistedProfiles, persisted?.defaultChatModelId),
          defaultSelectionModelId: resolveModelId(
            persistedProfiles,
            persisted?.defaultSelectionModelId,
            persisted?.defaultChatModelId ?? currentState.defaultChatModelId
          ),
          defaultEditReviewModelId: resolveModelId(
            persistedProfiles,
            persisted?.defaultEditReviewModelId,
            persisted?.defaultSelectionModelId ?? currentState.defaultSelectionModelId
          ),
          selectionPromptTemplates: normalizeSelectionPromptTemplates(persisted?.selectionPromptTemplates),
          proxyEnabled: persisted?.proxyEnabled ?? DEFAULT_PROXY_SETTINGS.proxyEnabled,
          proxyUrl: persisted?.proxyUrl ?? DEFAULT_PROXY_SETTINGS.proxyUrl,
          proxyBypassRules: persisted?.proxyBypassRules ?? DEFAULT_PROXY_SETTINGS.proxyBypassRules,
          headingColors: {
            ...DEFAULT_HEADING_COLORS,
            ...(persisted?.headingColors ?? {}),
          },
        };
      },
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (!error) {
            const currentLanguage = useSettingsStore.getState().language;
            setLocale(currentLanguage);
          }
        };
      },
    }
  )
);
