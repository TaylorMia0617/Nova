import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "../../hooks/useTranslation";
import "./OutlinePanel.css";

interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

const MIN_OUTLINE_WIDTH = 220;
const MAX_OUTLINE_WIDTH = 520;

export interface OutlineBlueprintMatch {
  blueprintId: string;
  nodeId: string;
  blueprintName: string;
  nodeTitle: string;
  nodeKind: string;
  nodeKindLabel: string;
  summaryLines: string[];
  children?: OutlineBlueprintMatch[];
}

export interface OutlinePanelProps {
  editor: Editor | null;
  visible: boolean;
  getBlueprintMatches?: (headingText: string) => OutlineBlueprintMatch[];
  onBlueprintMatchClick?: (match: OutlineBlueprintMatch) => void;
}

export function OutlinePanel({ editor, visible, getBlueprintMatches, onBlueprintMatchClick }: OutlinePanelProps) {
  const { t } = useTranslation();
  const [items, setItems] = useState<OutlineItem[]>([]);
  const [expandedBlueprintItems, setExpandedBlueprintItems] = useState<Set<string>>(() => new Set());
  const [expandedChildItems, setExpandedChildItems] = useState<Set<string>>(() => new Set());
  const [outlineWidth, setOutlineWidth] = useState(260);
  const [isResizing, setIsResizing] = useState(false);

  const extractHeadings = useCallback(() => {
    if (!editor) {
      setItems([]);
      return;
    }

    const headings: OutlineItem[] = [];
    const doc = editor.state.doc;

    doc.descendants((node, pos) => {
      if (node.type.name === "heading" && node.attrs.level >= 1 && node.attrs.level <= 3) {
        headings.push({
          level: node.attrs.level as number,
          text: node.textContent,
          pos,
        });
      }
    });

    setItems(headings);
  }, [editor]);

  useEffect(() => {
    extractHeadings();
  }, [extractHeadings, editor?.state]);

  useEffect(() => {
    if (!editor) return;
    const handler = () => extractHeadings();
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, extractHeadings]);

  const scrollToHeading = (pos: number) => {
    if (!editor) return;
    editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
  };

  const toggleBlueprintItem = (key: string) => {
    setExpandedBlueprintItems((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleChildItem = (key: string) => {
    setExpandedChildItems((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = outlineWidth;
    setIsResizing(true);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(MAX_OUTLINE_WIDTH, Math.max(MIN_OUTLINE_WIDTH, startWidth + moveEvent.clientX - startX));
      setOutlineWidth(nextWidth);
    };
    const stopResize = () => {
      setIsResizing(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize, { once: true });
  };

  if (!visible) return null;

  return (
    <div className={`outline-panel ${isResizing ? "is-resizing" : ""}`} style={{ width: outlineWidth, flexBasis: outlineWidth }}>
      <div className="outline-header">{t("editor.outline.title")}</div>
      <div className="outline-list">
        {items.length === 0 ? (
          <div className="outline-empty">{t("editor.outline.empty")}</div>
        ) : (
          items.map((item, index) => {
            const blueprintMatches = getBlueprintMatches?.(item.text) ?? [];
            return (
              <div key={index} className="outline-entry">
                <button
                  className={`outline-item level-${item.level}`}
                  onClick={() => scrollToHeading(item.pos)}
                  title={item.text}
                >
                  {item.text}
                </button>
                {blueprintMatches.map((match) => {
                  const matchKey = `${match.blueprintId}-${match.nodeId}`;
                  const isExpanded = expandedBlueprintItems.has(matchKey);
                  return (
                    <div
                      key={matchKey}
                      className={`outline-blueprint-card level-${item.level} ${isExpanded ? "expanded" : ""}`}
                    >
                      <div className="outline-blueprint-card-row">
                        <button
                          type="button"
                          className="outline-blueprint-toggle"
                          onClick={() => toggleBlueprintItem(matchKey)}
                          title={isExpanded ? t("editor.outline.collapseBlueprint") : t("editor.outline.expandBlueprint")}
                        >
                          {isExpanded ? "-" : "+"}
                        </button>
                        <button
                          type="button"
                          className="outline-blueprint-title"
                          onClick={() => onBlueprintMatchClick?.(match)}
                          title={match.blueprintName}
                        >
                          <span>{match.nodeTitle}</span>
                          <small>{match.blueprintName} · {match.nodeKindLabel}</small>
                        </button>
                      </div>
                      {isExpanded && (
                        <div className="outline-blueprint-summary">
                          {match.summaryLines.map((line, lineIndex) => (
                            <p key={`${matchKey}-line-${lineIndex}`}>{line}</p>
                          ))}
                          {match.children && match.children.length > 0 && (
                            <div className="outline-blueprint-children">
                              {match.children.map((child) => {
                                const childKey = `${matchKey}-${child.blueprintId}-${child.nodeId}`;
                                const isChildExpanded = expandedChildItems.has(childKey);
                                return (
                                  <div key={childKey} className={`outline-blueprint-child-card ${isChildExpanded ? "expanded" : ""}`}>
                                    <div className="outline-blueprint-child-row">
                                      <button
                                        type="button"
                                        className="outline-blueprint-child-toggle"
                                        onClick={() => toggleChildItem(childKey)}
                                        title={isChildExpanded ? t("editor.outline.collapseBlueprint") : t("editor.outline.expandBlueprint")}
                                      >
                                        {isChildExpanded ? "-" : "+"}
                                      </button>
                                      <button
                                        type="button"
                                        className="outline-blueprint-child"
                                        onClick={() => onBlueprintMatchClick?.(child)}
                                        title={`${child.blueprintName} · ${child.nodeKindLabel}`}
                                      >
                                        <span>{child.nodeTitle}</span>
                                        <small>{child.blueprintName}</small>
                                      </button>
                                    </div>
                                    {isChildExpanded && (
                                      <div className="outline-blueprint-child-summary">
                                        {child.summaryLines.map((line, lineIndex) => (
                                          <p key={`${childKey}-summary-${lineIndex}`}>{line}</p>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
      <button
        type="button"
        className="outline-resize-handle"
        onPointerDown={startResize}
        aria-label="Resize outline"
      />
    </div>
  );
}
