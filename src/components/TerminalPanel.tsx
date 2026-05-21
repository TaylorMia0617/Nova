import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ExternalLink, Play, RefreshCw, TerminalSquare, X } from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import {
  disposeTerminal,
  getTerminalShellInfo,
  isTerminalAvailable,
  onTerminalData,
  onTerminalExit,
  openExternalTerminal,
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
  const [sessionKey, setSessionKey] = useState(0);
  const [shellInfo, setShellInfo] = useState<{ label: string; command: string } | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "ready" | "unavailable" | "exited">("idle");

  const restartTerminal = () => {
    setSessionKey((current) => current + 1);
  };

  const handleOpenExternal = async () => {
    try {
      await openExternalTerminal({ cwd: rootPath ?? undefined });
    } catch (error) {
      terminalRef.current?.writeln(error instanceof Error ? error.message : "Failed to open external terminal.");
    }
  };

  const handleOpenOpencode = async () => {
    try {
      await openExternalTerminal({ cwd: rootPath ?? undefined, command: "opencode" });
    } catch (error) {
      terminalRef.current?.writeln(error instanceof Error ? error.message : "Failed to open opencode.");
    }
  };

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
        const info = await getTerminalShellInfo();
        setShellInfo(info);
        const terminalId = await startTerminal({
          cwd: rootPath ?? undefined,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        terminalIdRef.current = terminalId;
        setStatus("ready");
        terminal.writeln("");
        terminal.writeln(`${info?.label ?? "Shell"} ready. Try: where.exe opencode`);
        terminal.writeln("If the embedded shell misses a CLI, use the external terminal button.");
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
  }, [isOpen, rootPath, sessionKey]);

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
          <span>Terminal</span>
          <span className="terminal-tab active">{shellInfo?.label ?? "Auto Shell"}</span>
          <span className={`terminal-status ${status}`}>{status}</span>
        </div>
        <div className="terminal-actions">
          <button onClick={restartTerminal} title="Restart Terminal">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => void handleOpenOpencode()} title="Run opencode in External Terminal">
            <Play size={14} />
          </button>
          <button onClick={() => void handleOpenExternal()} title="Open External Terminal Here">
            <ExternalLink size={14} />
          </button>
          <button onClick={() => setIsOpen(false)} title="Hide Terminal">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-body" ref={terminalElementRef} />
    </section>
  );
};

export default TerminalPanel;
