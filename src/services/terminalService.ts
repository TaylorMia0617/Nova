export interface TerminalDataPayload {
  terminalId: string;
  data: string;
}

export interface TerminalExitPayload {
  terminalId: string;
  exitCode: number;
}

export interface TerminalProbe {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  resolvedCommand?: string;
  launcher?: string;
  invocation?: string;
  details?: string[];
}

export interface TerminalPathInspection {
  path: string;
  exists: boolean;
  kind: string;
}

export interface TerminalDiagnosis {
  isPackaged: boolean;
  platform: string;
  arch: string;
  cwd: string;
  shell: {
    label: string;
    command: string;
    args: string[];
  };
  commands: Record<string, string | null>;
  pathEntries: string[];
  opencodeConfig?: TerminalPathInspection;
  probes: Record<string, TerminalProbe>;
}

export interface WorkspaceChangePayload {
  rootPath: string;
  changedPath: string | null;
}

function getHost() {
  return window.novelHost;
}

export function isTerminalAvailable(): boolean {
  return Boolean(getHost()?.startTerminal);
}

export async function startTerminal(options: { cwd?: string; cols?: number; rows?: number }): Promise<string> {
  const host = getHost();
  if (!host?.startTerminal) {
    throw new Error("Integrated terminal is only available in the Electron desktop app.");
  }
  return host.startTerminal(options);
}

export async function getTerminalShellInfo(): Promise<{ label: string; command: string } | null> {
  return getHost()?.getTerminalShellInfo?.() ?? null;
}

export async function openExternalTerminal(options: { cwd?: string; command?: string }): Promise<void> {
  const host = getHost();
  if (!host?.openExternalTerminal) {
    throw new Error("External terminal is only available in the Electron desktop app.");
  }
  await host.openExternalTerminal(options);
}

export async function diagnoseTerminal(options: { cwd?: string }): Promise<TerminalDiagnosis> {
  const host = getHost();
  if (!host?.diagnoseTerminal) {
    throw new Error("Terminal diagnosis is only available in the Electron desktop app.");
  }
  return host.diagnoseTerminal(options) as Promise<TerminalDiagnosis>;
}

export async function writeTerminal(terminalId: string, data: string): Promise<void> {
  await getHost()?.writeTerminal?.(terminalId, data);
}

export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await getHost()?.resizeTerminal?.(terminalId, cols, rows);
}

export async function disposeTerminal(terminalId: string): Promise<void> {
  await getHost()?.disposeTerminal?.(terminalId);
}

export function onTerminalData(callback: (payload: TerminalDataPayload) => void): () => void {
  return getHost()?.onTerminalData?.(callback) ?? (() => undefined);
}

export function onTerminalExit(callback: (payload: TerminalExitPayload) => void): () => void {
  return getHost()?.onTerminalExit?.(callback) ?? (() => undefined);
}

export async function watchWorkspace(rootPath: string): Promise<void> {
  await getHost()?.watchWorkspace?.(rootPath);
}

export async function unwatchWorkspace(rootPath: string): Promise<void> {
  await getHost()?.unwatchWorkspace?.(rootPath);
}

export function onWorkspaceChanged(callback: (payload: WorkspaceChangePayload) => void): () => void {
  return getHost()?.onWorkspaceChanged?.(callback) ?? (() => undefined);
}
