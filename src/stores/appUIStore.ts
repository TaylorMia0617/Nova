import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BrowserContextPayload } from "../services/fileSystemService";

interface AppUIState {
  isExplorerOpen: boolean;
  isBlueprintOpen: boolean;
  isCopilotOpen: boolean;
  isSettingsOpen: boolean;
  isBottomPanelOpen: boolean;
  browserContextQueue: BrowserContextPayload[];
  toggleExplorer: () => void;
  toggleBlueprint: () => void;
  toggleCopilot: () => void;
  openExplorer: () => void;
  openBlueprint: () => void;
  openCopilot: () => void;
  openBottomPanel: () => void;
  closeBottomPanel: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  enqueueBrowserContext: (payload: BrowserContextPayload) => void;
  consumeBrowserContexts: () => BrowserContextPayload[];
}

export const useAppUIStore = create<AppUIState>()(
  persist(
    (set) => ({
      isExplorerOpen: true,
      isBlueprintOpen: false,
      isCopilotOpen: false,
      isSettingsOpen: false,
      isBottomPanelOpen: false,
      browserContextQueue: [],
      toggleExplorer: () => set((state) => ({ isExplorerOpen: !state.isExplorerOpen, isBlueprintOpen: false })),
      toggleBlueprint: () => set((state) => ({ isBlueprintOpen: !state.isBlueprintOpen, isExplorerOpen: false })),
      toggleCopilot: () => set((state) => ({ isCopilotOpen: !state.isCopilotOpen })),
      openExplorer: () => set({ isExplorerOpen: true, isBlueprintOpen: false }),
      openBlueprint: () => set({ isBlueprintOpen: true, isExplorerOpen: false }),
      openCopilot: () => set({ isCopilotOpen: true }),
      openBottomPanel: () => set({ isBottomPanelOpen: true }),
      closeBottomPanel: () => set({ isBottomPanelOpen: false }),
      openSettings: () => set({ isSettingsOpen: true }),
      closeSettings: () => set({ isSettingsOpen: false }),
      enqueueBrowserContext: (payload) => set((state) => ({
        browserContextQueue: [...state.browserContextQueue, payload].slice(-8),
      })),
      consumeBrowserContexts: () => {
        let queue: BrowserContextPayload[] = [];
        set((state) => {
          queue = state.browserContextQueue;
          return { browserContextQueue: [] };
        });
        return queue;
      },
    }),
    {
      name: "novel-assistance-ui",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persistedState) => {
        const state = persistedState as Partial<AppUIState>;
        return {
          ...state,
          isExplorerOpen: true,
          isBlueprintOpen: false,
          isCopilotOpen: false,
          isBottomPanelOpen: false,
          isSettingsOpen: false,
        };
      },
      partialize: (state) => ({
        isExplorerOpen: state.isExplorerOpen,
      }),
    }
  )
);
