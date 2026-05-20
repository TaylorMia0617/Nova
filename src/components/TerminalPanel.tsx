import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TerminalSquare, X } from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import {
  disposeTerminal,
  isTerminalAvailable,
  onTerminalData,
  onTerminalExit,
  resizeTerminal,
  startTerminal,
  writeTerminal,
} from "../services/terminalService";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

interface TerminalPanelProps {
  height: number;
}

const TerminalPanel: React.FC<TerminalPanelProps> = ({ height }) => {
  const rootPath = useFileStore((state) => state.rootPath);
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [isOpen, setIsOpen] = useState(true);
  const [status, setStatus] = useState<"idle" | "starting" | "ready" | "unavailable" | "exited">("idle");

  useEffect(() => {
    if (!isOpen || !terminalElementRef.current) return;

    if (!isTerminalAvailable()) {
      setStatus("unavailable");
      return;
    }

    if (terminalRef.current) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
      return;
    }

    const terminal = new XTerm({
      cursorBlink: true,
      fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      convertEol: true,
      theme: {
        background: "#111111",
        foreground: "#d7d7d7",
        cursor: "#ffffff",
        selectionBackground: "#264f78",
        black: "#1e1e1e",
        red: "#f87171",
        green: "#8fdc8f",
        yellow: "#f8d66d",
        blue: "#6ad7ff",
        magenta: "#d6a3ff",
        cyan: "#7dd3fc",
        white: "#d7d7d7",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElementRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    setStatus("starting");

    requestAnimationFrame(async () => {
      fitAddon.fit();
      try {
        const terminalId = await startTerminal({
          cwd: rootPath ?? undefined,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        terminalIdRef.current = terminalId;
        setStatus("ready");
        terminal.writeln("");
        terminal.writeln("PowerShell ready. Try: where.exe opencode");
        terminal.writeln("");
        terminal.focus();
      } catch (error) {
        setStatus("unavailable");
        terminal.writeln(error instanceof Error ? error.message : "Failed to start terminal.");
      }
    });

    const dataDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        void writeTerminal(terminalId, data);
      }
    });

    const resize = () => {
      fitAddon.fit();
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        void resizeTerminal(terminalId, terminal.cols, terminal.rows);
      }
    };

    window.addEventListener("resize", resize);
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(terminalElementRef.current);

    const disposeData = onTerminalData(({ terminalId, data }) => {
      if (terminalId === terminalIdRef.current) {
        terminal.write(data);
      }
    });

    const disposeExit = onTerminalExit(({ terminalId }) => {
      if (terminalId === terminalIdRef.current) {
        setStatus("exited");
        terminal.writeln("");
        terminal.writeln("[terminal exited]");
      }
    });

    return () => {
      window.removeEventListener("resize", resize);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      disposeData();
      disposeExit();
      const terminalId = terminalIdRef.current;
      if (terminalId) {
        void disposeTerminal(terminalId);
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminalIdRef.current = null;
    };
  }, [isOpen, rootPath]);

  if (!isOpen) {
    return (
      <button className="terminal-restore" onClick={() => setIsOpen(true)} title="Show Terminal">
        <TerminalSquare size={15} />
        <span>Terminal</span>
      </button>
    );
  }

  return (
    <section className="terminal-panel" style={{ height }}>
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalSquare size={15} />
          <span>PowerShell</span>
          <span className={`terminal-status ${status}`}>{status}</span>
        </div>
        <button onClick={() => setIsOpen(false)} title="Hide Terminal">
          <X size={14} />
        </button>
      </div>
      <div className="terminal-body" ref={terminalElementRef} />
    </section>
  );
};

export default TerminalPanel;
