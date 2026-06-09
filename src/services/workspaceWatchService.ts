export interface WorkspaceChangePayload {
  rootPath: string;
  changedPath: string | null;
}

function getHost() {
  return window.novelHost;
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
