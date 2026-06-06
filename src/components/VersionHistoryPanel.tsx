import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { Clock, Eye, FileClock, GitCompareArrows, RotateCcw } from "lucide-react";
import { useFileStore } from "../stores/fileStore";
import { parseDocxBase64, type ProseMirrorNode } from "../services/docxOoxmlService";
import { readHistory } from "../services/versionHistoryService";
import type { VersionSnapshot } from "../types/versionHistory";
import { useTranslation } from "../hooks/useTranslation";
import "./VersionHistoryPanel.css";

function formatTime(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function collectText(node: ProseMirrorNode): string {
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(collectText).join("\n");
}

async function getPreview(snapshot: VersionSnapshot, t: (key: string, params?: Record<string, string | number>) => string) {
  if (!snapshot.isContentStored || snapshot.content === undefined) {
    return t("history.contentNotStored");
  }
  if (snapshot.mimeKind === "binary") {
    return t("history.binaryStored", { size: formatSize(snapshot.sizeBytes) });
  }
  if (snapshot.mimeKind === "docx") {
    try {
      const parsed = await parseDocxBase64(snapshot.content);
      const text = collectText(parsed.docJson);
      return text || t("history.docxEmpty");
    } catch {
      return t("history.docxPreviewFailed");
    }
  }
  return snapshot.content || t("history.emptyFile");
}

export default function VersionHistoryPanel() {
  const { t } = useTranslation();
  const { restoreVersionSnapshot, openHistorySnapshotPreview, openHistorySnapshotCompare } = useFileStore();
  const [snapshots, setSnapshots] = useState<VersionSnapshot[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void readHistory()
      .then((items) => {
        if (cancelled) return;
        const sorted = [...items].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
        setSnapshots(sorted);
        setSelectedPath((current) => current ?? sorted[0]?.path ?? null);
        setSelectedSnapshotId((current) => current ?? sorted[0]?.id ?? null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, VersionSnapshot[]>();
    for (const snapshot of snapshots) {
      const list = map.get(snapshot.path) ?? [];
      list.push(snapshot);
      map.set(snapshot.path, list);
    }
    return [...map.entries()].map(([path, items]) => ({
      path,
      relativePath: items[0]?.relativePath ?? path,
      items,
      latest: items[0],
    }));
  }, [snapshots]);

  const selectedItems = grouped.find((group) => group.path === selectedPath)?.items ?? [];
  const selectedSnapshot =
    selectedItems.find((snapshot) => snapshot.id === selectedSnapshotId) ?? selectedItems[0] ?? null;

  useEffect(() => {
    if (!selectedSnapshot) {
      setPreview("");
      return;
    }
    let cancelled = false;
    setPreview(t("history.loadingPreview"));
    void getPreview(selectedSnapshot, t).then((content) => {
      if (!cancelled) setPreview(content);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSnapshot]);

  const canUseSnapshotContent = (snapshot: VersionSnapshot) =>
    snapshot.isContentStored && snapshot.content !== undefined && snapshot.mimeKind !== "binary";

  const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, snapshotId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelectedSnapshotId(snapshotId);
  };

  return (
      <section className="history-panel">
        <header className="history-header">
          <div className="history-title">
            <FileClock size={18} />
            <div>
              <h2>{t("history.title")}</h2>
              <span>{t("history.subtitle")}</span>
            </div>
          </div>
        </header>
        <div className="history-body">
          <aside className="history-files">
            {isLoading && <p className="history-empty">{t("history.loading")}</p>}
            {!isLoading && grouped.length === 0 && <p className="history-empty">{t("history.empty")}</p>}
            {grouped.map((group) => (
              <button
                type="button"
                key={group.path}
                className={`history-file-item ${group.path === selectedPath ? "active" : ""}`}
                onClick={() => {
                  setSelectedPath(group.path);
                  setSelectedSnapshotId(group.items[0]?.id ?? null);
                }}
              >
                <span>{group.relativePath}</span>
                <small>{t("history.versions", { count: group.items.length })} · {formatTime(group.latest.timestamp)}</small>
              </button>
            ))}
          </aside>
          <main className="history-detail">
            {selectedSnapshot ? (
              <>
                <div className="history-graph">
                  {selectedItems.map((snapshot, index) => {
                    const canOpen = canUseSnapshotContent(snapshot);
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        key={snapshot.id}
                        className={`history-graph-row ${snapshot.id === selectedSnapshot.id ? "active" : ""} ${!snapshot.isContentStored ? "muted" : ""}`}
                        onClick={() => setSelectedSnapshotId(snapshot.id)}
                        onKeyDown={(event) => handleRowKeyDown(event, snapshot.id)}
                      >
                        <span className="history-graph-lane" aria-hidden="true">
                          {index > 0 && <span className="history-graph-line top" />}
                          <span className="history-graph-dot" />
                          {index < selectedItems.length - 1 && <span className="history-graph-line bottom" />}
                        </span>
                        <span className="history-graph-content">
                          <span className="history-graph-title">
                            <Clock size={13} />
                            {formatTime(snapshot.timestamp)}
                          </span>
                          <span className="history-graph-meta">
                            {t(`history.${snapshot.reason}Save`)} · {formatSize(snapshot.sizeBytes)} · {snapshot.mimeKind.toUpperCase()}
                            {!snapshot.isContentStored ? ` · ${t("history.contentNotStoredBadge")}` : ""}
                          </span>
                        </span>
                        <span className="history-graph-actions">
                          <button
                            type="button"
                            disabled={!canOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedSnapshotId(snapshot.id);
                              void openHistorySnapshotPreview(snapshot);
                            }}
                          >
                            <Eye size={13} />
                            {t("history.browse")}
                          </button>
                          <button
                            type="button"
                            disabled={!canOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedSnapshotId(snapshot.id);
                              void restoreVersionSnapshot(snapshot);
                            }}
                          >
                            <RotateCcw size={13} />
                            {t("history.undo")}
                          </button>
                          <button
                            type="button"
                            disabled={!canOpen}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedSnapshotId(snapshot.id);
                              void openHistorySnapshotCompare(snapshot);
                            }}
                          >
                            <GitCompareArrows size={13} />
                            {t("history.compare")}
                          </button>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="history-preview-meta">
                  <span>{selectedSnapshot.relativePath}</span>
                  <span>{formatSize(selectedSnapshot.sizeBytes)}</span>
                  <span>{selectedSnapshot.mimeKind.toUpperCase()}</span>
                  {!selectedSnapshot.isContentStored && <span>{t("history.contentNotStoredBadge")}</span>}
                </div>
                <pre className="history-preview">{preview}</pre>
              </>
            ) : (
              <p className="history-empty">{t("history.selectFile")}</p>
            )}
          </main>
        </div>
      </section>
  );
}
