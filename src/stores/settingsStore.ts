import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  apiKey: string;
  provider: "openai" | "gemini";
  setApiKey: (key: string) => void;
  setProvider: (provider: "openai" | "gemini") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: "",
      provider: "openai",
      setApiKey: (key) => set({ apiKey: key }),
      setProvider: (provider) => set({ provider }),
    }),
    {
      name: "novel-assistance-settings",
      partialize: (state) => ({
        provider: state.provider,
      }),
    }
  )
);
