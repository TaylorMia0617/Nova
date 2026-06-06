import {
  appendVersionSnapshot,
  listVersionSnapshots,
  pruneVersionSnapshots,
  updateVersionSnapshotPaths,
  writeFile,
  writeFileBinary,
} from "./fileSystemService";
import type {
  VersionSnapshot,
  VersionSnapshotEncoding,
  VersionSnapshotReason,
} from "../types/versionHistory";

export const VERSION_HISTORY_MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const VERSION_HISTORY_IDLE_MS = 10 * 60 * 1000;
export const VERSION_HISTORY_SIZE_TRIGGER_BYTES = 5 * 1024;

const getPathSeparator = (path: string) => (path.includes("\\") ? "\\" : "/");

export function getRelativePath(rootPath: string | null, filePath: string) {
  if (!rootPath || !filePath.startsWith(rootPath)) return filePath;
  const relative = filePath.slice(rootPath.length).replace(/^[/\\]+/, "");
  return relative || filePath.split(/[/\\]/).pop() || filePath;
}

export function getMimeKind(filePath: string): VersionSnapshot["mimeKind"] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".markdown")) return "text";
  return "binary";
}

export function estimateBase64Bytes(base64: string) {
  const clean = base64.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function estimateContentBytes(content: string, encoding: VersionSnapshotEncoding) {
  if (encoding === "base64") return estimateBase64Bytes(content);
  return new TextEncoder().encode(content).byteLength;
}

export async function readHistory() {
  return listVersionSnapshots();
}

export async function pruneHistory() {
  return pruneVersionSnapshots();
}

export async function recordSnapshot(options: {
  rootPath: string | null;
  path: string;
  reason: VersionSnapshotReason;
  encoding: VersionSnapshotEncoding;
  content: string;
  mimeKind?: VersionSnapshot["mimeKind"];
}) {
  const sizeBytes = estimateContentBytes(options.content, options.encoding);
  const isContentStored = sizeBytes <= VERSION_HISTORY_MAX_CONTENT_BYTES;
  const snapshot: VersionSnapshot = {
    id: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    path: options.path,
    relativePath: getRelativePath(options.rootPath, options.path),
    timestamp: new Date().toISOString(),
    reason: options.reason,
    encoding: options.encoding,
    content: isContentStored ? options.content : undefined,
    sizeBytes,
    mimeKind: options.mimeKind ?? getMimeKind(options.path),
    isContentStored,
  };
  await appendVersionSnapshot(snapshot);
  return snapshot;
}

export async function updateSnapshotPaths(oldPath: string, newPath: string) {
  return updateVersionSnapshotPaths(oldPath, newPath);
}

export async function restoreSnapshot(snapshot: VersionSnapshot) {
  if (!snapshot.isContentStored || snapshot.content === undefined) {
    throw new Error("This version is too large to restore because its content was not stored.");
  }
  if (snapshot.encoding === "base64") {
    await writeFileBinary(snapshot.path, snapshot.content);
  } else {
    await writeFile(snapshot.path, snapshot.content);
  }
}

export function getPathDirectory(filePath: string) {
  const separator = getPathSeparator(filePath);
  const index = filePath.lastIndexOf(separator);
  return index <= 0 ? "" : filePath.slice(0, index);
}
