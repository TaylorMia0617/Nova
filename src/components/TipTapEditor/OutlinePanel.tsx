import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useTranslation } from "../../hooks/useTranslation";
import "./OutlinePanel.css";

interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

export interface OutlineBlueprintMatch {
  blueprintId: string;
  nodeId: string;
  blueprintName: string;
  nodeTitle: string;
  nodeKind: string;
  nodeKindLabel: string;
  summaryLines: string[];
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

  if (!visible) return null;

  return (
    <div className="outline-panel">
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
    </div>
  );
}
