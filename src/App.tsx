import { lazy, Suspense, useEffect, useState } from "react";
import AssetsPanel from "./components/AssetsPanel";
import Header from "./components/Header";
import MenuBar from "./components/MenuBar";
import { useTranslation } from "./hooks/useTranslation";

const EditorPanel = lazy(() => import("./components/EditorPanel"));
const CopilotPanel = lazy(() => import("./components/CopilotPanel"));
const TerminalPanel = lazy(() => import("./components/TerminalPanel"));

type DragTarget = "left" | "right" | "terminal" | null;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const MIN_EDITOR_HEIGHT = 120;
const MIN_TERMINAL_HEIGHT = 120;

function App() {
  const [leftWidth, setLeftWidth] = useState(280);
  const [rightWidth, setRightWidth] = useState(350);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const { t } = useTranslation();

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
    <div className={`app-container ${dragTarget ? "is-resizing" : ""}`}>
      <MenuBar />
      <Header />
      <div className="main-content">
        <div className="resizable-pane left-pane" style={{ width: leftWidth }}>
          <AssetsPanel />
        </div>
        <div
          className="resize-handle vertical"
          onPointerDown={(event) => {
            event.preventDefault();
            setDragTarget("left");
          }}
        />
        <div className="workspace-center">
          <Suspense fallback={<div className="panel-loading">{t("editor.loading")}</div>}>
            <EditorPanel />
          </Suspense>
          <div
            className="resize-handle horizontal"
            onPointerDown={(event) => {
              event.preventDefault();
              setDragTarget("terminal");
            }}
          />
          <Suspense fallback={<div className="panel-loading terminal-loading">{t("terminal.loading")}</div>}>
            <TerminalPanel height={terminalHeight} />
          </Suspense>
        </div>
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
      </div>
    </div>
  );
}

export default App;
