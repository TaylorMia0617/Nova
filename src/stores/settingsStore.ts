import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ModelProfile, SelectionPromptTemplates } from "../types/ai";

type PromptKey = keyof SelectionPromptTemplates;

interface SettingsState {
  modelProfiles: ModelProfile[];
  defaultChatModelId: string;
  defaultSelectionModelId: string;
  selectionPromptTemplates: SelectionPromptTemplates;
  setModelProfiles: (profiles: ModelProfile[]) => void;
  updateModelProfile: (id: string, patch: Partial<ModelProfile>) => void;
  removeModelProfile: (id: string) => void;
  setDefaultChatModelId: (id: string) => void;
  setDefaultSelectionModelId: (id: string) => void;
  setSelectionPromptTemplate: (key: PromptKey, value: string) => void;
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
  rememberSecrets: false,
};

const DEFAULT_PROMPTS: SelectionPromptTemplates = {
  polish: "请在不改变原意的前提下润色这段文字，提升流畅度、节奏感与表达质感，只返回修改后的文本。",
  correct: "请纠正这段文字中的错别字、病句、标点和语法问题，只返回修正后的文本。",
  stylize: "请在保留核心信息的前提下，将这段文字风格化得更有文学性和画面感，只返回改写后的文本。",
};

const sanitizeProfile = (profile: ModelProfile): ModelProfile => ({
  ...profile,
  apiKey: profile.rememberSecrets ? profile.apiKey : "",
  headers: profile.rememberSecrets ? profile.headers : [],
});

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      modelProfiles: [DEFAULT_PROFILE],
      defaultChatModelId: DEFAULT_PROFILE.id,
      defaultSelectionModelId: DEFAULT_PROFILE.id,
      selectionPromptTemplates: DEFAULT_PROMPTS,
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
              state.defaultSelectionModelId === id ? safeProfiles[0].id : state.defaultSelectionModelId,
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
      getModelProfileById: (id) => {
        if (!id) return null;
        return get().modelProfiles.find((profile) => profile.id === id) ?? null;
      },
    }),
    {
      name: "novel-assistance-settings",
      partialize: (state) => ({
        modelProfiles: state.modelProfiles.map(sanitizeProfile),
        defaultChatModelId: state.defaultChatModelId,
        defaultSelectionModelId: state.defaultSelectionModelId,
        selectionPromptTemplates: state.selectionPromptTemplates,
      }),
    }
  )
);
