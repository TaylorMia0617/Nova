import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Activity, ExternalLink, Play, RefreshCw, TerminalSquare } from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import {
  diagnoseTerminal,
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

const TerminalPanel: React.FC = () => {
  const rootPath = useFileStore((state) => state.rootPath);
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
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

  const handleDiagnose = async () => {
    const terminal = terminalRef.current;

    try {
      const diagnosis = await diagnoseTerminal({ cwd: rootPath ?? undefined });
      const lines = [
        "",
        "=== Terminal Diagnosis ===",
        `packaged: ${diagnosis.isPackaged}`,
        `platform: ${diagnosis.platform} ${diagnosis.arch}`,
        `cwd: ${diagnosis.cwd}`,
        `shell: ${diagnosis.shell.label}`,
        `shell path: ${diagnosis.shell.command}`,
        diagnosis.shell.args?.length ? `shell args: ${diagnosis.shell.args.join(" ")}` : "shell args: (none)",
        "",
        "command lookup:",
        ...Object.entries(diagnosis.commands).map(([name, value]) => `  ${name}: ${value ?? "not found"}`),
        "",
        "opencode config:",
        diagnosis.opencodeConfig
          ? `  ${diagnosis.opencodeConfig.path}: ${diagnosis.opencodeConfig.exists ? diagnosis.opencodeConfig.kind : "missing"}`
          : "  unavailable",
        "",
        "probes:",
        ...Object.entries(diagnosis.probes).flatMap(([name, probe]) => [
          `  ${name}: ${probe.ok ? "ok" : "failed"} status=${probe.status ?? "n/a"}`,
          probe.resolvedCommand ? `    resolved: ${probe.resolvedCommand}` : "",
          probe.launcher ? `    launcher: ${probe.launcher}` : "",
          probe.invocation ? `    invocation: ${probe.invocation}` : "",
          probe.stdout ? `    stdout: ${probe.stdout}` : "",
          probe.stderr ? `    stderr: ${probe.stderr}` : "",
          probe.error ? `    error: ${probe.error}` : "",
          ...(probe.details ?? []).map((detail) => `    detail: ${detail}`),
        ]).filter(Boolean),
        "",
        "PATH entries:",
        ...diagnosis.pathEntries.map((entry) => `  ${entry}`),
        "=== End Diagnosis ===",
        "",
      ];

      terminal?.writeln(lines.join("\r\n"));
    } catch (error) {
      terminal?.writeln(error instanceof Error ? error.message : "Failed to diagnose terminal.");
    }
  };

  useEffect(() => {
    if (!terminalElementRef.current) return;

    if (!isTerminalAvailable()) {
      setStatus("unavailable");
      return;
    }

    if (terminalRef.current) {
      requestAnimationFrame(() => fitAddonRef.current?.fit());
      return;
    }

    const terminal = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: "Cascadia Mono, Consolas, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      convertEol: true,
      windowsPty: {
        backend: "conpty",
        buildNumber: 19045,
      },
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
        terminal.writeln(`${info?.label ?? "Shell"} ready. Try: where opencode`);
        terminal.writeln("Windows CLI commands now run through Command Prompt for better npm/.cmd compatibility.");
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

    const binaryDisposable = terminal.onBinary((data) => {
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
      binaryDisposable.dispose();
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
  }, [rootPath, sessionKey]);

  return (
    <section className="terminal-panel">
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalSquare size={15} />
          <span>Terminal</span>
          <span className="terminal-tab active">{shellInfo?.label ?? "Auto Shell"}</span>
          <span className={`terminal-status ${status}`}>{status}</span>
        </div>
        <div className="terminal-actions">
          <button onClick={() => void handleDiagnose()} title="Diagnose Terminal">
            <Activity size={14} />
          </button>
          <button onClick={restartTerminal} title="Restart Terminal">
            <RefreshCw size={14} />
          </button>
          <button onClick={() => void handleOpenOpencode()} title="Run opencode in External Terminal">
            <Play size={14} />
          </button>
          <button onClick={() => void handleOpenExternal()} title="Open External Terminal Here">
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
      <div className="terminal-body" ref={terminalElementRef} />
    </section>
  );
};

export default TerminalPanel;
