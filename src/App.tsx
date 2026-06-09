import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Bot, FolderTree, GitBranch, History, Settings, X } from "lucide-react";
import AssetsPanel from "./components/AssetsPanel";
import Header from "./components/Header";
import MenuBar from "./components/MenuBar";
import { useTranslation } from "./hooks/useTranslation";
import { useAppUIStore } from "./stores/appUIStore";
import { useSettingsStore } from "./stores/settingsStore";

const EditorPanel = lazy(() => import("./components/EditorPanel"));
const BlueprintPanel = lazy(() => import("./components/BlueprintPanel"));
const CopilotPanel = lazy(() => import("./components/CopilotPanel"));
const SettingsModal = lazy(() => import("./components/SettingsModal"));
const VersionHistoryPanel = lazy(() => import("./components/VersionHistoryPanel"));

type DragTarget = "left" | "right" | "bottom" | null;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const MIN_EDITOR_HEIGHT = 120;
const MIN_BOTTOM_PANEL_HEIGHT = 120;

function BottomPanelTabs() {
  const {
    isBottomPanelOpen,
    closeBottomPanel,
    openBottomPanel,
  } = useAppUIStore();
  const toggleHistory = () => {
    if (isBottomPanelOpen) {
      closeBottomPanel();
    } else {
      openBottomPanel();
    }
  };

  return (
    <div className={`bottom-panel-tabs ${isBottomPanelOpen ? "" : "compact"}`}>
      <div className="bottom-panel-tab-list">
        <button
          type="button"
          className={`bottom-panel-tab ${isBottomPanelOpen ? "active" : ""}`}
          onClick={toggleHistory}
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
  const [bottomPanelHeight, setBottomPanelHeight] = useState(220);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const { t } = useTranslation();
  const {
    isExplorerOpen,
    isBlueprintOpen,
    isCopilotOpen,
    isSettingsOpen,
    isBottomPanelOpen,
    toggleExplorer,
    toggleBlueprint,
    toggleCopilot,
    openSettings,
    closeSettings,
  } = useAppUIStore();
  const { theme, backgroundImage, backgroundOpacity, headingColors } = useSettingsStore();
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

      if (dragTarget === "bottom") {
        const headerElement = document.querySelector(".header");
        const headerHeight = headerElement instanceof HTMLElement ? headerElement.offsetHeight : 0;
        const maxBottomPanelHeight = Math.max(
          MIN_BOTTOM_PANEL_HEIGHT,
          window.innerHeight - headerHeight - MIN_EDITOR_HEIGHT
        );

        setBottomPanelHeight(clamp(window.innerHeight - event.clientY, MIN_BOTTOM_PANEL_HEIGHT, maxBottomPanelHeight));
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
          "--editor-heading-h1-color": headingColors.h1,
          "--editor-heading-h2-color": headingColors.h2,
          "--editor-heading-h3-color": headingColors.h3,
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
              {isBlueprintOpen ? (
                <Suspense fallback={<div className="panel-loading">蓝图加载中...</div>}>
                  <BlueprintPanel />
                </Suspense>
              ) : (
                <AssetsPanel />
              )}
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
                setDragTarget("bottom");
              }}
            />
          )}
          {isBottomPanelOpen ? (
            <div className="bottom-panel" style={{ height: bottomPanelHeight }}>
              <BottomPanelTabs />
              <div className="bottom-panel-content">
                <div className="bottom-panel-view active">
                  <Suspense fallback={<div className="panel-loading">Loading history...</div>}>
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
      {isSettingsOpen && (
        <Suspense fallback={<div className="panel-loading">{t("header.settings")}</div>}>
          <SettingsModal isOpen={isSettingsOpen} onClose={closeSettings} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
