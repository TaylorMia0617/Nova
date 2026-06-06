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
                {blueprintMatches.map((match) => (
                  <button
                    key={`${match.blueprintId}-${match.nodeId}`}
                    className={`outline-blueprint-item level-${item.level}`}
                    onClick={() => onBlueprintMatchClick?.(match)}
                    title={match.blueprintName}
                  >
                    {match.nodeTitle}
                  </button>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
