import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { useTranslation } from "../../hooks/useTranslation";
import "./FindReplacePanel.css";

const searchHighlightKey = new PluginKey("searchHighlight");

function createSearchHighlightPlugin() {
  return new Plugin({
    key: searchHighlightKey,
    state: {
      init() {
        return DecorationSet.empty;
      },
      apply(tr, old) {
        const meta = tr.getMeta(searchHighlightKey);
        if (meta) return meta;
        if (tr.docChanged) return old.map(tr.mapping, tr.doc);
        if (tr.selectionSet) return old;
        return old;
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function updateDecorations(editor: Editor, matches: { from: number; to: number }[], currentIndex: number) {
  const decorations = matches.map((match, index) => {
    const className = index === currentIndex - 1 ? "search-highlight-current" : "search-highlight";
    return Decoration.inline(match.from, match.to, { class: className });
  });

  const decorationSet = DecorationSet.create(editor.state.doc, decorations);
  const tr = editor.state.tr.setMeta(searchHighlightKey, decorationSet);
  editor.view.dispatch(tr);
}

function clearDecorations(editor: Editor) {
  const tr = editor.state.tr.setMeta(searchHighlightKey, DecorationSet.empty);
  editor.view.dispatch(tr);
}

export interface FindReplacePanelProps {
  editor: Editor | null;
  onClose: () => void;
}

export function FindReplacePanel({ editor, onClose }: FindReplacePanelProps) {
  const { t } = useTranslation();
  const [searchText, setSearchText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [showReplace, setShowReplace] = useState(false);
  const [matches, setMatches] = useState<{ from: number; to: number }[]>([]);
  const pluginRef = useRef<Plugin | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editor) return;

    const existingPlugin = editor.state.plugins.find(
      (p) => p.spec.key === searchHighlightKey
    );

    if (!existingPlugin) {
      const plugin = createSearchHighlightPlugin();
      pluginRef.current = plugin;
      editor.registerPlugin(plugin);
    }

    return () => {
      if (editor && pluginRef.current) {
        clearDecorations(editor);
        try {
          editor.unregisterPlugin(searchHighlightKey);
        } catch {
          // Plugin might already be unregistered
        }
        pluginRef.current = null;
      }
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    if (matches.length > 0 && searchText) {
      updateDecorations(editor, matches, currentMatch);
    } else {
      clearDecorations(editor);
    }
  }, [editor, matches, currentMatch, searchText]);

  const findMatches = useCallback(() => {
    if (!editor || !searchText) {
      setMatchCount(0);
      setCurrentMatch(0);
      return [];
    }

    const doc = editor.state.doc;
    const matches: { from: number; to: number }[] = [];
    const lowerSearch = searchText.toLowerCase();
    const fullText = doc.textContent;
    let pos = 0;

    while (pos < fullText.length) {
      const index = fullText.toLowerCase().indexOf(lowerSearch, pos);
      if (index === -1) break;

      const from = index;
      const to = index + searchText.length;

      let pmFrom = 0;
      let pmTo = 0;
      let charCount = 0;

      doc.nodesBetween(0, doc.content.size, (node, nodePos) => {
        if (node.isText && node.text) {
          const nodeStart = charCount;
          const nodeEnd = charCount + node.text.length;

          if (from >= nodeStart && from < nodeEnd) {
            pmFrom = nodePos + (from - nodeStart);
          }
          if (to > nodeStart && to <= nodeEnd) {
            pmTo = nodePos + (to - nodeStart);
          }

          charCount += node.text.length;
        }
        return true;
      });

      if (pmFrom !== pmTo) {
        matches.push({ from: pmFrom, to: pmTo });
      }

      pos = index + 1;
    }

    setMatchCount(matches.length);
    return matches;
  }, [editor, searchText]);

  useEffect(() => {
    const m = findMatches();
    setMatches(m);
    if (m.length > 0) {
      setCurrentMatch(1);
    } else {
      setCurrentMatch(0);
    }
  }, [searchText, findMatches]);

  const goToMatch = useCallback(
    (index: number) => {
      if (!editor || matches.length === 0) return;
      const match = matches[index - 1];
      if (!match) return;

      editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();
      setCurrentMatch(index);
    },
    [editor, matches]
  );

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    const next = currentMatch >= matches.length ? 1 : currentMatch + 1;
    goToMatch(next);
  }, [currentMatch, matches.length, goToMatch]);

  const goToPrev = useCallback(() => {
    if (matches.length === 0) return;
    const prev = currentMatch <= 1 ? matches.length : currentMatch - 1;
    goToMatch(prev);
  }, [currentMatch, matches.length, goToMatch]);

  const replaceCurrent = useCallback(() => {
    if (!editor || matches.length === 0) return;
    const match = matches[currentMatch - 1];
    if (!match) return;

    editor
      .chain()
      .focus()
      .deleteRange({ from: match.from, to: match.to })
      .insertContentAt(match.from, replaceText)
      .run();

    const newMatches = findMatches();
    setMatches(newMatches);
    if (newMatches.length > 0) {
      const nextIndex = currentMatch > newMatches.length ? 1 : currentMatch;
      setCurrentMatch(nextIndex);
      goToMatch(nextIndex);
    } else {
      setCurrentMatch(0);
    }
  }, [editor, matches, currentMatch, replaceText, findMatches, goToMatch]);

  const replaceAll = useCallback(() => {
    if (!editor || matches.length === 0) return;

    let offset = 0;
    for (const match of matches) {
      const from = match.from + offset;
      const to = match.to + offset;
      editor.chain().deleteRange({ from, to }).insertContentAt(from, replaceText).run();
      offset += replaceText.length - (match.to - match.from);
    }

    const newMatches = findMatches();
    setMatches(newMatches);
    setCurrentMatch(0);
  }, [editor, matches, replaceText, findMatches]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        goToNext();
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        goToPrev();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, goToNext, goToPrev]);

  return (
    <div className="find-replace-panel">
      <div className="find-replace-row">
        <input
          ref={inputRef}
          type="text"
          className="find-input"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={t("editor.findReplace.findPlaceholder")}
        />
        <span className="match-count">
          {searchText ? (matchCount > 0 ? `${currentMatch}/${matchCount}` : t("editor.findReplace.noMatches")) : ""}
        </span>
        <button className="find-btn" onClick={goToPrev} disabled={matchCount === 0} title={t("editor.findReplace.previous")}>
          ↑
        </button>
        <button className="find-btn" onClick={goToNext} disabled={matchCount === 0} title={t("editor.findReplace.next")}>
          ↓
        </button>
        <button
          className="find-btn toggle"
          onClick={() => setShowReplace(!showReplace)}
          title={t("editor.findReplace.toggleReplace")}
        >
          {showReplace ? "▲" : "▼"}
        </button>
        <button className="find-btn close" onClick={onClose} title={t("editor.findReplace.close")}>
          ✕
        </button>
      </div>
      {showReplace && (
        <div className="find-replace-row">
          <input
            type="text"
            className="find-input"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder={t("editor.findReplace.replacePlaceholder")}
          />
          <button className="find-btn" onClick={replaceCurrent} disabled={matchCount === 0} title={t("editor.findReplace.replace")}>
            {t("editor.findReplace.replace")}
          </button>
          <button className="find-btn" onClick={replaceAll} disabled={matchCount === 0} title={t("editor.findReplace.replaceAll")}>
            {t("editor.findReplace.all")}
          </button>
        </div>
      )}
    </div>
  );
}
