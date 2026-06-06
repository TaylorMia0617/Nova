import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type BottomPanelTab = "terminal" | "history";

interface AppUIState {
  isExplorerOpen: boolean;
  isBlueprintOpen: boolean;
  isCopilotOpen: boolean;
  isSettingsOpen: boolean;
  isBottomPanelOpen: boolean;
  bottomPanelTab: BottomPanelTab;
  toggleExplorer: () => void;
  toggleBlueprint: () => void;
  toggleCopilot: () => void;
  openExplorer: () => void;
  openBlueprint: () => void;
  openCopilot: () => void;
  openBottomPanel: (tab: BottomPanelTab) => void;
  closeBottomPanel: () => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

export const useAppUIStore = create<AppUIState>()(
  persist(
    (set) => ({
      isExplorerOpen: true,
      isBlueprintOpen: false,
      isCopilotOpen: true,
      isSettingsOpen: false,
      isBottomPanelOpen: true,
      bottomPanelTab: "terminal",
      toggleExplorer: () => set((state) => ({ isExplorerOpen: !state.isExplorerOpen, isBlueprintOpen: false })),
      toggleBlueprint: () => set((state) => ({ isBlueprintOpen: !state.isBlueprintOpen, isExplorerOpen: false })),
      toggleCopilot: () => set((state) => ({ isCopilotOpen: !state.isCopilotOpen })),
      openExplorer: () => set({ isExplorerOpen: true, isBlueprintOpen: false }),
      openBlueprint: () => set({ isBlueprintOpen: true, isExplorerOpen: false }),
      openCopilot: () => set({ isCopilotOpen: true }),
      openBottomPanel: (tab) => set({ isBottomPanelOpen: true, bottomPanelTab: tab }),
      closeBottomPanel: () => set({ isBottomPanelOpen: false }),
      setBottomPanelTab: (tab) => set({ isBottomPanelOpen: true, bottomPanelTab: tab }),
      openSettings: () => set({ isSettingsOpen: true }),
      closeSettings: () => set({ isSettingsOpen: false }),
    }),
    {
      name: "novel-assistance-ui",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        isExplorerOpen: state.isExplorerOpen,
        isBlueprintOpen: state.isBlueprintOpen,
        isCopilotOpen: state.isCopilotOpen,
        isBottomPanelOpen: state.isBottomPanelOpen,
        bottomPanelTab: state.bottomPanelTab,
      }),
    }
  )
);
