export type VersionSnapshotReason = "manual" | "idle" | "size";

export type VersionSnapshotEncoding = "utf8" | "base64";

export interface VersionSnapshot {
  id: string;
  path: string;
  relativePath: string;
  timestamp: string;
  reason: VersionSnapshotReason;
  encoding: VersionSnapshotEncoding;
  content?: string;
  sizeBytes: number;
  mimeKind: "text" | "docx" | "binary";
  isContentStored: boolean;
}
