import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Bot, FolderTree, GitBranch, History, Settings, TerminalSquare, X } from "lucide-react";
import AssetsPanel from "./components/AssetsPanel";
import BlueprintPanel from "./components/BlueprintPanel";
import Header from "./components/Header";
import MenuBar from "./components/MenuBar";
import SettingsModal from "./components/SettingsModal";
import { useTranslation } from "./hooks/useTranslation";
import { useAppUIStore } from "./stores/appUIStore";
import { useSettingsStore } from "./stores/settingsStore";

const EditorPanel = lazy(() => import("./components/EditorPanel"));
const CopilotPanel = lazy(() => import("./components/CopilotPanel"));
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));
const VersionHistoryPanel = lazy(() => import("./components/VersionHistoryPanel"));

type DragTarget = "left" | "right" | "terminal" | null;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const MIN_EDITOR_HEIGHT = 120;
const MIN_TERMINAL_HEIGHT = 120;

function BottomPanelTabs() {
  const {
    bottomPanelTab,
    isBottomPanelOpen,
    closeBottomPanel,
    setBottomPanelTab,
    openBottomPanel,
  } = useAppUIStore();
  const selectTab = (tab: "terminal" | "history") => {
    if (isBottomPanelOpen) {
      setBottomPanelTab(tab);
    } else {
      openBottomPanel(tab);
    }
  };

  return (
    <div className={`bottom-panel-tabs ${isBottomPanelOpen ? "" : "compact"}`}>
      <div className="bottom-panel-tab-list">
        <button
          type="button"
          className={`bottom-panel-tab ${bottomPanelTab === "terminal" && isBottomPanelOpen ? "active" : ""}`}
          onClick={() => selectTab("terminal")}
        >
          <TerminalSquare size={14} />
          <span>Terminal</span>
        </button>
        <button
          type="button"
          className={`bottom-panel-tab ${bottomPanelTab === "history" && isBottomPanelOpen ? "active" : ""}`}
          onClick={() => selectTab("history")}
        >
          <History size={14} />
          <span>History</span>
        </button>
      </div>
      {isBottomPanelOpen && (
        <button type="button" className="bottom-panel-close" onClick={closeBottomPanel} title="Close bottom panel">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function App() {
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(350);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const { t } = useTranslation();
  const {
    isExplorerOpen,
    isBlueprintOpen,
    isCopilotOpen,
    isSettingsOpen,
    isBottomPanelOpen,
    bottomPanelTab,
    toggleExplorer,
    toggleBlueprint,
    toggleCopilot,
    openSettings,
    closeSettings,
  } = useAppUIStore();
  const { theme, backgroundImage, backgroundOpacity } = useSettingsStore();
  const backgroundVisibility = Math.min(100, Math.max(0, backgroundOpacity)) / 100;
  const surfaceOpacity = Math.max(0.42, Math.min(0.96, 0.96 - backgroundVisibility * 0.42));
  const headerOpacity = Math.max(0.5, Math.min(0.96, 0.94 - backgroundVisibility * 0.32));
  const editorOpacity = Math.max(0.38, Math.min(0.86, 0.84 - backgroundVisibility * 0.42));

  useEffect(() => {
    if (!dragTarget) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (dragTarget === "left") {
        setLeftWidth(clamp(event.clientX, 200, 520));
      }

      if (dragTarget === "right") {
        setRightWidth(clamp(window.innerWidth - event.clientX, 260, 620));
      }

      if (dragTarget === "terminal") {
        const headerElement = document.querySelector(".header");
        const headerHeight = headerElement instanceof HTMLElement ? headerElement.offsetHeight : 0;
        const maxTerminalHeight = Math.max(
          MIN_TERMINAL_HEIGHT,
          window.innerHeight - headerHeight - MIN_EDITOR_HEIGHT
        );

        setTerminalHeight(clamp(window.innerHeight - event.clientY, MIN_TERMINAL_HEIGHT, maxTerminalHeight));
      }
    };

    const handlePointerUp = () => setDragTarget(null);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragTarget]);

  return (
    <div
      className={`app-container ${dragTarget ? "is-resizing" : ""}`}
      data-theme={theme}
      style={
        {
          "--background-visibility": backgroundVisibility,
          "--surface-opacity": surfaceOpacity,
          "--header-opacity": headerOpacity,
          "--editor-opacity": editorOpacity,
        } as CSSProperties
      }
    >
      <div
        className="app-background"
        style={
          {
            backgroundImage: backgroundImage ? `url("${backgroundImage}")` : "none",
          } as CSSProperties
        }
      />
      <MenuBar />
      <Header />
      <div className="main-content">
        <aside className="activity-bar" aria-label={t("layout.activityBar")}>
          <button
            type="button"
            className={`activity-button ${isExplorerOpen ? "active" : ""}`}
            onClick={toggleExplorer}
            title={t(isExplorerOpen ? "layout.closeExplorer" : "layout.openExplorer")}
          >
            <FolderTree size={18} />
          </button>
          <button
            type="button"
            className={`activity-button ${isBlueprintOpen ? "active" : ""}`}
            onClick={toggleBlueprint}
            title={t(isBlueprintOpen ? "layout.closeBlueprint" : "layout.openBlueprint")}
          >
            <GitBranch size={18} />
          </button>
          <button
            type="button"
            className={`activity-button ${isCopilotOpen ? "active" : ""}`}
            onClick={toggleCopilot}
            title={t(isCopilotOpen ? "layout.closeCopilot" : "layout.openCopilot")}
          >
            <Bot size={18} />
          </button>
          <button
            type="button"
            className="activity-button activity-button-bottom"
            onClick={openSettings}
            title={t("header.settings")}
          >
            <Settings size={18} />
          </button>
        </aside>
        {(isExplorerOpen || isBlueprintOpen) && (
          <>
            <div className="resizable-pane left-pane" style={{ width: leftWidth }}>
              {isBlueprintOpen ? <BlueprintPanel /> : <AssetsPanel />}
            </div>
            <div
              className="resize-handle vertical"
              onPointerDown={(event) => {
                event.preventDefault();
                setDragTarget("left");
              }}
            />
          </>
        )}
        <div className="workspace-center">
          <Suspense fallback={<div className="panel-loading">{t("editor.loading")}</div>}>
            <EditorPanel />
          </Suspense>
          {isBottomPanelOpen && (
            <div
              className="resize-handle horizontal"
              onPointerDown={(event) => {
                event.preventDefault();
                setDragTarget("terminal");
              }}
            />
          )}
          {isBottomPanelOpen ? (
            <div className="bottom-panel" style={{ height: terminalHeight }}>
              <BottomPanelTabs />
              <div className="bottom-panel-content">
                <div className={`bottom-panel-view ${bottomPanelTab === "terminal" ? "active" : ""}`}>
                  <Suspense fallback={<div className="panel-loading terminal-loading">{t("terminal.loading")}</div>}>
                    <TerminalPanel />
                  </Suspense>
                </div>
                <div className={`bottom-panel-view ${bottomPanelTab === "history" ? "active" : ""}`}>
                  <Suspense fallback={<div className="panel-loading terminal-loading">Loading history...</div>}>
                    <VersionHistoryPanel />
                  </Suspense>
                </div>
              </div>
            </div>
          ) : (
            <BottomPanelTabs />
          )}
        </div>
        {isCopilotOpen && (
          <>
            <div
              className="resize-handle vertical"
              onPointerDown={(event) => {
                event.preventDefault();
                setDragTarget("right");
              }}
            />
            <div className="resizable-pane right-pane" style={{ width: rightWidth }}>
              <Suspense fallback={<div className="panel-loading">{t("copilot.title")}</div>}>
                <CopilotPanel />
              </Suspense>
            </div>
          </>
        )}
      </div>
      <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />
    </div>
  );
}

export default App;
