import { compareNodeNames } from "../../shared/workspaceSort.js";

export interface WorkspaceNode {
  path: string;
  name: string;
  type: "folder" | "file";
  hasChildren?: boolean;
  isLoaded?: boolean;
  children?: WorkspaceNode[];
}

export interface WorkspaceSnapshot {
  rootPath: string;
  rootName: string;
  nodes: WorkspaceNode[];
}

interface NovelHostApi {
  isElectron: true;
  // Window controls
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  createNewWindow: () => Promise<void>;
  // File system
  pickWorkspace: () => Promise<string | null>;
  loadWorkspace: (rootPath: string, options?: { recursive?: boolean }) => Promise<WorkspaceSnapshot>;
  readDirectory: (directoryPath: string, options?: { recursive?: boolean }) => Promise<WorkspaceNode[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  readFileBinary: (path: string) => Promise<string>;
  writeFileBinary: (path: string, base64Content: string) => Promise<void>;
  createFile: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  renamePath: (path: string, newName: string) => Promise<string>;
  deletePath: (path: string) => Promise<void>;
  duplicateFile: (path: string) => Promise<string>;
  movePath: (sourcePath: string, destinationFolderPath: string) => Promise<string>;
  ensureWorkspaceAppData?: () => Promise<{ rootPath: string; dataPath: string; conversationsPath: string }>;
  listConversationSummaries?: () => Promise<import("../types/ai").ConversationSummary[]>;
  readConversation?: (conversationId: string) => Promise<import("../types/ai").ConversationRecord | null>;
  writeConversation?: (
    record: import("../types/ai").ConversationRecord
  ) => Promise<import("../types/ai").ConversationSummary[]>;
  deleteConversation?: (conversationId: string) => Promise<import("../types/ai").ConversationSummary[]>;
  listVersionSnapshots?: () => Promise<import("../types/versionHistory").VersionSnapshot[]>;
  appendVersionSnapshot?: (
    snapshot: import("../types/versionHistory").VersionSnapshot
  ) => Promise<import("../types/versionHistory").VersionSnapshot[]>;
  updateVersionSnapshotPaths?: (
    oldPath: string,
    newPath: string
  ) => Promise<import("../types/versionHistory").VersionSnapshot[]>;
  pruneVersionSnapshots?: () => Promise<import("../types/versionHistory").VersionSnapshot[]>;
  listBlueprints?: () => Promise<import("../types/blueprint").BlueprintDocument[]>;
  saveBlueprint?: (
    blueprint: import("../types/blueprint").BlueprintDocument
  ) => Promise<import("../types/blueprint").BlueprintDocument>;
  deleteBlueprint?: (blueprintId: string) => Promise<import("../types/blueprint").BlueprintDocument[]>;
  renameBlueprint?: (
    blueprintId: string,
    name: string
  ) => Promise<import("../types/blueprint").BlueprintDocument | null>;
  listBlueprintTemplates?: () => Promise<import("../types/blueprint").BlueprintNodeTemplate[]>;
  saveBlueprintTemplate?: (
    template: import("../types/blueprint").BlueprintNodeTemplate
  ) => Promise<import("../types/blueprint").BlueprintNodeTemplate>;
  deleteBlueprintTemplate?: (templateId: string) => Promise<import("../types/blueprint").BlueprintNodeTemplate[]>;
  testMcpConnection?: (profile: import("../types/ai").ModelProfile) => Promise<unknown>;
  pickAttachments?: () => Promise<Array<{ path: string; name: string; size: number; mimeType: string }>>;
  readAttachmentText?: (filePath: string) => Promise<{ textContent: string; truncated: boolean }>;
  startTerminal?: (options: { cwd?: string; cols?: number; rows?: number }) => Promise<string>;
  getTerminalShellInfo?: () => Promise<{ label: string; command: string }>;
  openExternalTerminal?: (options: { cwd?: string; command?: string }) => Promise<void>;
  diagnoseTerminal?: (options: { cwd?: string }) => Promise<unknown>;
  writeTerminal?: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal?: (terminalId: string, cols: number, rows: number) => Promise<void>;
  disposeTerminal?: (terminalId: string) => Promise<void>;
  onTerminalData?: (callback: (payload: { terminalId: string; data: string }) => void) => () => void;
  onTerminalExit?: (callback: (payload: { terminalId: string; exitCode: number }) => void) => () => void;
  watchWorkspace?: (rootPath: string) => Promise<void>;
  unwatchWorkspace?: (rootPath: string) => Promise<void>;
  onWorkspaceChanged?: (callback: (payload: { rootPath: string; changedPath: string | null }) => void) => () => void;
  readGlobalApiConfig?: () => Promise<string>;
  writeGlobalApiConfig?: (content: string) => Promise<void>;
  // 参考列表管理
  getReferenceLists?: () => Promise<ReferenceListIndex[]>;
  getReferenceList?: (listId: string) => Promise<ReferenceListData | null>;
  saveReferenceList?: (list: ReferenceListData) => Promise<ReferenceListData>;
  deleteReferenceList?: (listId: string) => Promise<void>;
}

export interface ReferenceListIndex {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceListData {
  id: string;
  name: string;
  items: Array<{
    key: string;
    value: string;
  }>;
}

type AnyDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

type AnyFileHandle = FileSystemFileHandle;
type PermissionCapableHandle = FileSystemHandle & {
  queryPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

const directoryHandleRegistry = new Map<string, AnyDirectoryHandle>();
const fileHandleRegistry = new Map<string, AnyFileHandle>();
const SKIPPED_WORKSPACE_DIRECTORIES = new Set([
  ".git",
  ".novel-assistance",
  "node_modules",
  "dist",
  "release-dev",
  "build",
  ".cache",
]);

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    novelHost?: NovelHostApi;
  }
}

function getHostApi(): NovelHostApi | null {
  return window.novelHost?.isElectron ? window.novelHost : null;
}

function assertFileSystemSupport(): void {
  if (!window.showDirectoryPicker) {
    throw new Error("This browser does not support local directory access. Please use a recent Chromium-based browser.");
  }
}

function pathParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function joinPath(basePath: string, name: string): string {
  return basePath ? `${basePath}/${name}` : name;
}

function getParentPath(path: string): string | null {
  const parts = pathParts(path);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

function registerDirectoryHandle(path: string, handle: AnyDirectoryHandle): void {
  directoryHandleRegistry.set(path, handle);
}

function registerFileHandle(path: string, handle: AnyFileHandle): void {
  fileHandleRegistry.set(path, handle);
}

function asDirectoryHandle(handle: FileSystemHandle | FileSystemDirectoryHandle): AnyDirectoryHandle {
  return handle as AnyDirectoryHandle;
}

function asFileHandle(handle: FileSystemHandle | FileSystemFileHandle): AnyFileHandle {
  return handle as AnyFileHandle;
}

async function buildTree(
  directoryHandle: AnyDirectoryHandle,
  parentPath = "",
  recursive = false
): Promise<WorkspaceNode[]> {
  const entries: WorkspaceNode[] = [];

  for await (const [, rawEntry] of directoryHandle.entries()) {
    const entry = rawEntry as FileSystemHandle;
    if (entry.name.startsWith(".")) continue;

    const entryPath = joinPath(parentPath, entry.name);

    if (entry.kind === "directory") {
      if (SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name)) continue;
      const childDirectory = asDirectoryHandle(entry);
      registerDirectoryHandle(entryPath, childDirectory);
      entries.push({
        path: entryPath,
        name: entry.name,
        type: "folder",
        hasChildren: true,
        isLoaded: recursive,
        children: recursive ? await buildTree(childDirectory, entryPath, true) : undefined,
      });
    } else {
      registerFileHandle(entryPath, asFileHandle(entry));
      entries.push({
        path: entryPath,
        name: entry.name,
        type: "file",
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return compareNodeNames(a.name, b.name);
  });

  return entries;
}

function rebuildRegistryForRename(oldPath: string, newPath: string): void {
  const directoryEntries = [...directoryHandleRegistry.entries()];
  const fileEntries = [...fileHandleRegistry.entries()];

  for (const [path, handle] of directoryEntries) {
    if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      directoryHandleRegistry.delete(path);
      directoryHandleRegistry.set(path.replace(oldPath, newPath), handle);
    }
  }

  for (const [path, handle] of fileEntries) {
    if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      fileHandleRegistry.delete(path);
      fileHandleRegistry.set(path.replace(oldPath, newPath), handle);
    }
  }
}

function removeFromRegistry(path: string): void {
  for (const key of [...directoryHandleRegistry.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) {
      directoryHandleRegistry.delete(key);
    }
  }

  for (const key of [...fileHandleRegistry.keys()]) {
    if (key === path || key.startsWith(`${path}/`)) {
      fileHandleRegistry.delete(key);
    }
  }
}

async function ensurePermission(handle: FileSystemHandle): Promise<void> {
  const permissionHandle = handle as PermissionCapableHandle;

  if (permissionHandle.queryPermission) {
    const query = await permissionHandle.queryPermission({ mode: "readwrite" });
    if (query === "granted") return;
  }

  if (permissionHandle.requestPermission) {
    const request = await permissionHandle.requestPermission({ mode: "readwrite" });
    if (request === "granted") return;
  }

  throw new Error("Local folder permission was denied.");
}

export async function pickWorkspace(): Promise<string | null> {
  const host = getHostApi();
  if (host) {
    return host.pickWorkspace();
  }

  assertFileSystemSupport();

  const handle = await window.showDirectoryPicker?.({ mode: "readwrite" });
  if (!handle) return null;

  const directoryHandle = asDirectoryHandle(handle);
  await ensurePermission(directoryHandle);
  directoryHandleRegistry.clear();
  fileHandleRegistry.clear();
  registerDirectoryHandle(directoryHandle.name, directoryHandle);
  return directoryHandle.name;
}

export async function loadWorkspace(rootPath: string): Promise<WorkspaceSnapshot> {
  const host = getHostApi();
  if (host) {
    return host.loadWorkspace(rootPath, { recursive: false });
  }

  const rootHandle = directoryHandleRegistry.get(rootPath);
  if (!rootHandle) {
    throw new Error("The selected workspace is no longer available. Please open it again.");
  }

  await ensurePermission(rootHandle);
  const nodes = await buildTree(rootHandle, rootPath, false);

  return {
    rootPath,
    rootName: rootHandle.name,
    nodes,
  };
}

export async function loadWorkspaceTree(rootPath: string): Promise<WorkspaceSnapshot> {
  const host = getHostApi();
  if (host) {
    return host.loadWorkspace(rootPath, { recursive: true });
  }

  const rootHandle = directoryHandleRegistry.get(rootPath);
  if (!rootHandle) {
    throw new Error("The selected workspace is no longer available. Please open it again.");
  }

  await ensurePermission(rootHandle);
  const nodes = await buildTree(rootHandle, rootPath, true);

  return {
    rootPath,
    rootName: rootHandle.name,
    nodes,
  };
}

export async function readDirectory(
  directoryPath: string,
  options?: { recursive?: boolean }
): Promise<WorkspaceNode[]> {
  const recursive = options?.recursive ?? false;
  const host = getHostApi();
  if (host) {
    return host.readDirectory(directoryPath, { recursive });
  }

  const directoryHandle = directoryHandleRegistry.get(directoryPath);
  if (!directoryHandle) {
    throw new Error("Could not find that folder in the current workspace.");
  }

  await ensurePermission(directoryHandle);
  return buildTree(directoryHandle, directoryPath, recursive);
}

export async function readFile(path: string): Promise<string> {
  const host = getHostApi();
  if (host) {
    return host.readFile(path);
  }

  const handle = fileHandleRegistry.get(path);
  if (!handle) {
    throw new Error("Could not find that file in the current workspace.");
  }

  const file = await handle.getFile();
  return file.text();
}

export async function readFileBinary(path: string): Promise<string> {
  const host = getHostApi();
  if (host) {
    return host.readFileBinary(path);
  }

  const handle = fileHandleRegistry.get(path);
  if (!handle) {
    throw new Error("Could not find that file in the current workspace.");
  }

  const file = await handle.getFile();
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

export async function writeFile(path: string, content: string): Promise<void> {
  const host = getHostApi();
  if (host) {
    await host.writeFile(path, content);
    return;
  }

  const handle = fileHandleRegistry.get(path);
  if (!handle) {
    throw new Error("Could not find that file in the current workspace.");
  }

  await ensurePermission(handle);
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function writeFileBinary(path: string, base64Content: string): Promise<void> {
  const host = getHostApi();
  if (host) {
    await host.writeFileBinary(path, base64Content);
    return;
  }

  const handle = fileHandleRegistry.get(path);
  if (!handle) {
    throw new Error("Could not find that file in the current workspace.");
  }

  await ensurePermission(handle);
  const binary = atob(base64Content);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

export async function createFile(path: string): Promise<void> {
  const host = getHostApi();
  if (host) {
    await host.createFile(path);
    return;
  }

  const parentPath = getParentPath(path);
  if (!parentPath) {
    throw new Error("Cannot create a file without a target folder.");
  }

  const parentHandle = directoryHandleRegistry.get(parentPath);
  if (!parentHandle) {
    throw new Error("Could not find the destination folder.");
  }

  await ensurePermission(parentHandle);
  const parts = pathParts(path);
  const name = parts[parts.length - 1];
  if (!name) throw new Error("Invalid file name.");
  const fileHandle = await parentHandle.getFileHandle(name, { create: true });
  registerFileHandle(path, fileHandle);
}

export async function createFolder(path: string): Promise<void> {
  const host = getHostApi();
  if (host) {
    await host.createFolder(path);
    return;
  }

  const parentPath = getParentPath(path);
  if (!parentPath) {
    throw new Error("Cannot create a folder without a target folder.");
  }

  const parentHandle = directoryHandleRegistry.get(parentPath);
  if (!parentHandle) {
    throw new Error("Could not find the destination folder.");
  }

  await ensurePermission(parentHandle);
  const parts = pathParts(path);
  const name = parts[parts.length - 1];
  if (!name) throw new Error("Invalid folder name.");
  const directoryHandle = await parentHandle.getDirectoryHandle(name, { create: true });
  registerDirectoryHandle(path, asDirectoryHandle(directoryHandle));
}

export async function renamePath(path: string, newName: string): Promise<string> {
  const host = getHostApi();
  if (host) {
    return host.renamePath(path, newName);
  }

  const parentPath = getParentPath(path);
  if (!parentPath) {
    throw new Error("Cannot rename the workspace root.");
  }

  const nextPath = joinPath(parentPath, newName);
  const parentHandle = directoryHandleRegistry.get(parentPath);
  if (!parentHandle) {
    throw new Error("Could not find the parent folder.");
  }

  if (fileHandleRegistry.has(path)) {
    const sourceFile = await fileHandleRegistry.get(path)!.getFile();
    const nextHandle = await parentHandle.getFileHandle(newName, { create: true });
    const writable = await nextHandle.createWritable();
    await writable.write(await sourceFile.arrayBuffer());
    await writable.close();
    const parts = pathParts(path);
    await parentHandle.removeEntry(parts[parts.length - 1] as string);
    fileHandleRegistry.delete(path);
    registerFileHandle(nextPath, nextHandle);
    return nextPath;
  }

  const sourceHandle = directoryHandleRegistry.get(path);
  if (!sourceHandle) {
    throw new Error("Could not find the folder to rename.");
  }

  const nextHandle = await parentHandle.getDirectoryHandle(newName, { create: true });
  registerDirectoryHandle(nextPath, asDirectoryHandle(nextHandle));
  await copyDirectoryContents(sourceHandle, asDirectoryHandle(nextHandle), path, nextPath);
  const parts = pathParts(path);
  await parentHandle.removeEntry(parts[parts.length - 1] as string, { recursive: true });
  removeFromRegistry(path);
  rebuildRegistryForRename(path, nextPath);
  registerDirectoryHandle(nextPath, asDirectoryHandle(nextHandle));
  return nextPath;
}

export async function deletePath(path: string): Promise<void> {
  const host = getHostApi();
  if (host) {
    await host.deletePath(path);
    return;
  }

  const parentPath = getParentPath(path);
  if (!parentPath) {
    throw new Error("Cannot delete the workspace root.");
  }

  const parentHandle = directoryHandleRegistry.get(parentPath);
  if (!parentHandle) {
    throw new Error("Could not find the parent folder.");
  }

  await ensurePermission(parentHandle);
  const parts = pathParts(path);
  await parentHandle.removeEntry(parts[parts.length - 1] as string, {
    recursive: directoryHandleRegistry.has(path),
  });
  removeFromRegistry(path);
}

export async function duplicateFile(path: string): Promise<string> {
  const host = getHostApi();
  if (host) {
    return host.duplicateFile(path);
  }

  const parentPath = getParentPath(path);
  if (!parentPath) {
    throw new Error("Cannot duplicate that file.");
  }

  const parentHandle = directoryHandleRegistry.get(parentPath);
  const fileHandle = fileHandleRegistry.get(path);
  if (!parentHandle || !fileHandle) {
    throw new Error("Could not find that file.");
  }

  const sourceFile = await fileHandle.getFile();
  const parts = pathParts(path);
  const originalName = parts[parts.length - 1] as string;
  const dotIndex = originalName.lastIndexOf(".");
  const baseName = dotIndex === -1 ? originalName : originalName.slice(0, dotIndex);
  const extension = dotIndex === -1 ? "" : originalName.slice(dotIndex);

  for (let index = 1; index < 1000; index += 1) {
    const candidateName = index === 1 ? `${baseName} Copy${extension}` : `${baseName} Copy ${index}${extension}`;
    const candidatePath = joinPath(parentPath, candidateName);

    if (!fileHandleRegistry.has(candidatePath)) {
      const nextHandle = await parentHandle.getFileHandle(candidateName, { create: true });
      const writable = await nextHandle.createWritable();
      await writable.write(await sourceFile.arrayBuffer());
      await writable.close();
      registerFileHandle(candidatePath, nextHandle);
      return candidatePath;
    }
  }

  throw new Error("Could not create a duplicate file name.");
}

async function copyDirectoryContents(
  sourceHandle: AnyDirectoryHandle,
  targetHandle: AnyDirectoryHandle,
  sourcePath: string,
  targetPath: string
): Promise<void> {
  for await (const [, rawEntry] of sourceHandle.entries()) {
    const entry = rawEntry as FileSystemHandle;
    const sourceEntryPath = joinPath(sourcePath, entry.name);
    const targetEntryPath = joinPath(targetPath, entry.name);

    if (entry.kind === "file") {
      const file = await asFileHandle(entry).getFile();
      const nextHandle = await targetHandle.getFileHandle(entry.name, { create: true });
      const writable = await nextHandle.createWritable();
      await writable.write(await file.arrayBuffer());
      await writable.close();
      registerFileHandle(targetEntryPath, nextHandle);
    } else {
      const nextDirectoryHandle = await targetHandle.getDirectoryHandle(entry.name, { create: true });
      registerDirectoryHandle(targetEntryPath, asDirectoryHandle(nextDirectoryHandle));
      await copyDirectoryContents(
        asDirectoryHandle(entry),
        asDirectoryHandle(nextDirectoryHandle),
        sourceEntryPath,
        targetEntryPath
      );
    }
  }
}

export async function movePath(sourcePath: string, destinationFolderPath: string): Promise<string> {
  const host = getHostApi();
  if (host) {
    return host.movePath(sourcePath, destinationFolderPath);
  }

  const destinationHandle = directoryHandleRegistry.get(destinationFolderPath);
  if (!destinationHandle) {
    throw new Error("Could not find the destination folder.");
  }

  const parts = pathParts(sourcePath);
  const name = parts[parts.length - 1];
  if (!name) throw new Error("Invalid source path.");

  const nextPath = joinPath(destinationFolderPath, name);
  if (fileHandleRegistry.has(sourcePath)) {
    const sourceFile = await fileHandleRegistry.get(sourcePath)!.getFile();
    const nextHandle = await destinationHandle.getFileHandle(name, { create: true });
    const writable = await nextHandle.createWritable();
    await writable.write(await sourceFile.arrayBuffer());
    await writable.close();
    registerFileHandle(nextPath, nextHandle);
    await deletePath(sourcePath);
    return nextPath;
  }

  const sourceDirectory = directoryHandleRegistry.get(sourcePath);
  if (!sourceDirectory) {
    throw new Error("Could not find the source folder.");
  }

  const nextDirectory = await destinationHandle.getDirectoryHandle(name, { create: true });
  registerDirectoryHandle(nextPath, asDirectoryHandle(nextDirectory));
  await copyDirectoryContents(sourceDirectory, asDirectoryHandle(nextDirectory), sourcePath, nextPath);
  await deletePath(sourcePath);
  rebuildRegistryForRename(sourcePath, nextPath);
  registerDirectoryHandle(nextPath, asDirectoryHandle(nextDirectory));
  return nextPath;
}

export async function readGlobalApiConfig(): Promise<string | null> {
  const host = getHostApi();
  if (host?.readGlobalApiConfig) {
    const content = await host.readGlobalApiConfig();
    return content || null;
  }
  return null;
}

export async function writeGlobalApiConfig(content: string): Promise<void> {
  const host = getHostApi();
  if (host?.writeGlobalApiConfig) {
    await host.writeGlobalApiConfig(content);
  }
}

// 参考列表管理函数
export async function getReferenceLists(): Promise<ReferenceListIndex[]> {
  const host = getHostApi();
  if (host?.getReferenceLists) {
    return host.getReferenceLists();
  }
  return [];
}

export async function getReferenceList(listId: string): Promise<ReferenceListData | null> {
  const host = getHostApi();
  if (host?.getReferenceList) {
    return host.getReferenceList(listId);
  }
  return null;
}

export async function saveReferenceList(list: ReferenceListData): Promise<ReferenceListData> {
  const host = getHostApi();
  if (host?.saveReferenceList) {
    return host.saveReferenceList(list);
  }
  throw new Error("Reference list management is not available.");
}

export async function deleteReferenceList(listId: string): Promise<void> {
  const host = getHostApi();
  if (host?.deleteReferenceList) {
    return host.deleteReferenceList(listId);
  }
  throw new Error("Reference list management is not available.");
}

export async function listBlueprints(): Promise<import("../types/blueprint").BlueprintDocument[]> {
  const host = getHostApi();
  if (host?.listBlueprints) {
    return host.listBlueprints();
  }
  return [];
}

export async function saveBlueprint(
  blueprint: import("../types/blueprint").BlueprintDocument
): Promise<import("../types/blueprint").BlueprintDocument> {
  const host = getHostApi();
  if (host?.saveBlueprint) {
    return host.saveBlueprint(blueprint);
  }
  throw new Error("Blueprint management is not available.");
}

export async function deleteBlueprint(
  blueprintId: string
): Promise<import("../types/blueprint").BlueprintDocument[]> {
  const host = getHostApi();
  if (host?.deleteBlueprint) {
    return host.deleteBlueprint(blueprintId);
  }
  throw new Error("Blueprint management is not available.");
}

export async function renameBlueprint(
  blueprintId: string,
  name: string
): Promise<import("../types/blueprint").BlueprintDocument | null> {
  const host = getHostApi();
  if (host?.renameBlueprint) {
    return host.renameBlueprint(blueprintId, name);
  }
  throw new Error("Blueprint management is not available.");
}

export async function listBlueprintTemplates(): Promise<import("../types/blueprint").BlueprintNodeTemplate[]> {
  const host = getHostApi();
  if (host?.listBlueprintTemplates) {
    return host.listBlueprintTemplates();
  }
  return [];
}

export async function saveBlueprintTemplate(
  template: import("../types/blueprint").BlueprintNodeTemplate
): Promise<import("../types/blueprint").BlueprintNodeTemplate> {
  const host = getHostApi();
  if (host?.saveBlueprintTemplate) {
    return host.saveBlueprintTemplate(template);
  }
  throw new Error("Blueprint template management is not available.");
}

export async function deleteBlueprintTemplate(
  templateId: string
): Promise<import("../types/blueprint").BlueprintNodeTemplate[]> {
  const host = getHostApi();
  if (host?.deleteBlueprintTemplate) {
    return host.deleteBlueprintTemplate(templateId);
  }
  throw new Error("Blueprint template management is not available.");
}

export async function listVersionSnapshots(): Promise<import("../types/versionHistory").VersionSnapshot[]> {
  const host = getHostApi();
  if (host?.listVersionSnapshots) {
    return host.listVersionSnapshots();
  }
  return [];
}

export async function appendVersionSnapshot(
  snapshot: import("../types/versionHistory").VersionSnapshot
): Promise<import("../types/versionHistory").VersionSnapshot[]> {
  const host = getHostApi();
  if (host?.appendVersionSnapshot) {
    return host.appendVersionSnapshot(snapshot);
  }
  return [snapshot];
}

export async function updateVersionSnapshotPaths(
  oldPath: string,
  newPath: string
): Promise<import("../types/versionHistory").VersionSnapshot[]> {
  const host = getHostApi();
  if (host?.updateVersionSnapshotPaths) {
    return host.updateVersionSnapshotPaths(oldPath, newPath);
  }
  return [];
}

export async function pruneVersionSnapshots(): Promise<import("../types/versionHistory").VersionSnapshot[]> {
  const host = getHostApi();
  if (host?.pruneVersionSnapshots) {
    return host.pruneVersionSnapshots();
  }
  return [];
}
