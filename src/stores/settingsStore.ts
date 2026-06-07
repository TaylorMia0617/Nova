import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ModelProfile, SelectionPromptTemplates } from "../types/ai";
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

interface SettingsState {
  language: Locale;
  theme: AppTheme;
  backgroundImage: string | null;
  backgroundOpacity: number;
  headingColors: HeadingColors;
  modelProfiles: ModelProfile[];
  defaultChatModelId: string;
  defaultSelectionModelId: string;
  selectionPromptTemplates: SelectionPromptTemplates;
  chatMaxTokens: number;
  contextMaxLength: number;
  tavilyApiKey: string;
  webSearchLimit: number;
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
  setSelectionPromptTemplate: (key: PromptKey, value: string) => void;
  setChatMaxTokens: (value: number) => void;
  setContextMaxLength: (value: number) => void;
  setTavilyApiKey: (value: string) => void;
  setWebSearchLimit: (value: number) => void;
  getModelProfileById: (id: string | null | undefined) => ModelProfile | null;
}

const DEFAULT_PROFILE: ModelProfile = {
  id: "default-openai",
  label: "OpenAI Default",
  model: "gpt-4o-mini",
  apiKey: "",
  baseUrl: "https://api.openai.com/v1/responses",
  transportType: "sse-http",
  mcpServerUrl: "",
  headers: [],
  rememberSecrets: true,
};

const DEFAULT_PROMPTS: SelectionPromptTemplates = {
  polish: "请在不改变原意的前提下润色这段文字，提升流畅度、节奏感与表达质感，只返回修改后的文本。",
  correct: "请纠正这段文字中的错别字、病句、标点和语法问题，只返回修正后的文本。",
  stylize: "请在保留核心信息的前提下，将这段文字风格化得更有文学性和画面感，只返回改写后的文本。",
};

const DEFAULT_HEADING_COLORS: HeadingColors = {
  h1: "#e2e8f0",
  h2: "#e2e8f0",
  h3: "#e2e8f0",
};

const sanitizeProfile = (profile: ModelProfile): ModelProfile => ({
  ...profile,
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

    const hasChanges =
      JSON.stringify(parsed.modelProfiles) !== JSON.stringify(currentState.modelProfiles) ||
      JSON.stringify(parsed.selectionPromptTemplates) !==
        JSON.stringify(currentState.selectionPromptTemplates) ||
      JSON.stringify(parsed.defaultChatModelId) !==
        JSON.stringify(currentState.defaultChatModelId) ||
      JSON.stringify(parsed.defaultSelectionModelId) !==
        JSON.stringify(currentState.defaultSelectionModelId) ||
      parsed.chatMaxTokens !== currentState.chatMaxTokens ||
      parsed.contextMaxLength !== currentState.contextMaxLength ||
      parsed.tavilyApiKey !== currentState.tavilyApiKey ||
      parsed.webSearchLimit !== currentState.webSearchLimit ||
      parsed.theme !== currentState.theme ||
      parsed.backgroundImage !== currentState.backgroundImage ||
      (parsed.backgroundOpacity ?? currentState.backgroundOpacity) !== currentState.backgroundOpacity ||
      parsed.language !== currentState.language ||
      JSON.stringify(parsed.headingColors ?? DEFAULT_HEADING_COLORS) !==
        JSON.stringify(currentState.headingColors);

    if (hasChanges) {
      useSettingsStore.setState({
        ...parsed,
        headingColors: {
          ...DEFAULT_HEADING_COLORS,
          ...(parsed.headingColors ?? {}),
        },
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
      selectionPromptTemplates: state.selectionPromptTemplates,
      chatMaxTokens: state.chatMaxTokens,
      contextMaxLength: state.contextMaxLength,
      tavilyApiKey: state.tavilyApiKey,
      webSearchLimit: state.webSearchLimit,
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
      selectionPromptTemplates: DEFAULT_PROMPTS,
      chatMaxTokens: 8192,
      contextMaxLength: 5000,
      tavilyApiKey: "",
      webSearchLimit: 15,
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
          const nextProfiles = profiles.length > 0 ? profiles : [DEFAULT_PROFILE];
          const availableIds = new Set(nextProfiles.map((profile) => profile.id));
          return {
            modelProfiles: nextProfiles,
            defaultChatModelId: availableIds.has(state.defaultChatModelId)
              ? state.defaultChatModelId
              : nextProfiles[0].id,
            defaultSelectionModelId: availableIds.has(state.defaultSelectionModelId)
              ? state.defaultSelectionModelId
              : nextProfiles[0].id,
          };
        }),
      updateModelProfile: (id, patch) =>
        set((state) => ({
          modelProfiles: state.modelProfiles.map((profile) =>
            profile.id === id
              ? {
                  ...profile,
                  ...patch,
                }
              : profile
          ),
        })),
      removeModelProfile: (id) =>
        set((state) => {
          const nextProfiles = state.modelProfiles.filter((profile) => profile.id !== id);
          const safeProfiles = nextProfiles.length > 0 ? nextProfiles : [DEFAULT_PROFILE];

          return {
            modelProfiles: safeProfiles,
            defaultChatModelId:
              state.defaultChatModelId === id ? safeProfiles[0].id : state.defaultChatModelId,
            defaultSelectionModelId:
              state.defaultSelectionModelId === id
                ? safeProfiles[0].id
                : state.defaultSelectionModelId,
          };
        }),
      setDefaultChatModelId: (id) => set({ defaultChatModelId: id }),
      setDefaultSelectionModelId: (id) => set({ defaultSelectionModelId: id }),
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
        selectionPromptTemplates: state.selectionPromptTemplates,
        chatMaxTokens: state.chatMaxTokens,
        contextMaxLength: state.contextMaxLength,
        tavilyApiKey: state.tavilyApiKey,
        webSearchLimit: state.webSearchLimit,
        theme: state.theme,
        backgroundImage: state.backgroundImage,
        backgroundOpacity: state.backgroundOpacity,
        headingColors: state.headingColors,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<SettingsState> | null;
        return {
          ...currentState,
          ...(persisted ?? {}),
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
