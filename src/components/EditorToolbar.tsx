import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code,
  Download,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Indent,
  Italic,
  Link,
  ListChecks,
  Minus,
  Outdent,
  Palette,
  Quote,
  Redo,
  Save,
  Strikethrough,
  Table as TableIcon,
  Type,
  Underline,
  Undo,
  WrapText,
} from "lucide-react";
import type { Editor } from "@tiptap/react";
import type { ExportFormat } from "../types/export";
import { useEditorUIStore } from "../stores/editorUIStore";
import { useEditorStatusStore } from "../stores/editorStatusStore";
import { useTranslation } from "../hooks/useTranslation";
import "./EditorToolbar.css";

interface EditorToolbarProps {
  editor: Editor | null;
  activeFile: {
    name: string;
    isDirty: boolean;
    isReadOnly?: boolean;
    fileMode?: "txt" | "markdown" | "docx" | "blueprint" | "image" | "unsupported";
  } | null;
  onToggleFormat: (format: "bold" | "italic" | "underline" | "strike") => void;
  onToggleHeading: (level: 1 | 2 | 3) => void;
  onToggleBodyText: () => void;
  onSetAlignment: (alignment: "left" | "center" | "right") => void;
  onApplyColor: (color: string) => void;
  onApplyHighlight: (color: string) => void;
  onApplyFontFamily: (font: string) => void;
  onApplyFontSize: (size: string) => void;
  onApplyLineHeight: (height: string) => void;
  onToggleBlockquote: () => void;
  onToggleCodeBlock: () => void;
  onToggleTaskList: () => void;
  onInsertHorizontalRule: () => void;
  onInsertTable: (rows: number, cols: number) => void;
  onTableAction: (action: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleWordWrap: () => void;
  onToggleOutline: () => void;
  onTogglePageView: () => void;
  onToggleFocusMode: () => void;
  onSave: () => void;
  onExport: (format: ExportFormat) => void;
  onInsertImage: () => void;
  onInsertLink: () => void;
}

const COLORS = [
  { labelKey: "editor.colors.default", value: "#e2e8f0" },
  { labelKey: "editor.colors.red", value: "#fc5c65" },
  { labelKey: "editor.colors.orange", value: "#fd9644" },
  { labelKey: "editor.colors.yellow", value: "#f7b731" },
  { labelKey: "editor.colors.green", value: "#26de81" },
  { labelKey: "editor.colors.blue", value: "#45aaf2" },
  { labelKey: "editor.colors.purple", value: "#a55eea" },
  { labelKey: "editor.colors.pink", value: "#fd79a8" },
  { labelKey: "editor.colors.gray", value: "#a0aec0" },
  { labelKey: "editor.colors.white", value: "#ffffff" },
];

const HIGHLIGHT_COLORS = [
  { labelKey: "editor.colors.none", value: "" },
  { labelKey: "editor.colors.yellow", value: "#fef3c7" },
  { labelKey: "editor.colors.green", value: "#d1fae5" },
  { labelKey: "editor.colors.blue", value: "#dbeafe" },
  { labelKey: "editor.colors.purple", value: "#ede9fe" },
  { labelKey: "editor.colors.pink", value: "#fce7f3" },
  { labelKey: "editor.colors.red", value: "#fee2e2" },
  { labelKey: "editor.colors.orange", value: "#ffedd5" },
];

const FONT_FAMILIES = [
  { labelKey: "editor.fonts.default", value: "" },
  { labelKey: "editor.fonts.simsun", value: "SimSun, serif" },
  { labelKey: "editor.fonts.simhei", value: "SimHei, sans-serif" },
  { labelKey: "editor.fonts.microsoftYahei", value: "Microsoft YaHei, sans-serif" },
  { labelKey: "editor.fonts.kaiti", value: "KaiTi, serif" },
  { labelKey: "editor.fonts.fangsong", value: "FangSong, serif" },
  { labelKey: "editor.fonts.arial", value: "Arial, sans-serif" },
  { labelKey: "editor.fonts.timesNewRoman", value: "Times New Roman, serif" },
  { labelKey: "editor.fonts.courierNew", value: "Courier New, monospace" },
];

const FONT_SIZES = [
  { label: "", value: "" },
  { label: "12", value: "12px" },
  { label: "14", value: "14px" },
  { label: "16", value: "16px" },
  { label: "18", value: "18px" },
  { label: "20", value: "20px" },
  { label: "24", value: "24px" },
  { label: "28", value: "28px" },
  { label: "32", value: "32px" },
  { label: "36", value: "36px" },
  { label: "48", value: "48px" },
];

const LINE_HEIGHTS = [
  { label: "1.0", value: "1" },
  { label: "1.15", value: "1.15" },
  { label: "1.5", value: "1.5" },
  { label: "1.75", value: "1.75" },
  { label: "2.0", value: "2" },
  { label: "2.5", value: "2.5" },
  { label: "3.0", value: "3" },
];

export const EditorToolbar = memo(function EditorToolbar({
  activeFile,
  onToggleFormat,
  onToggleHeading,
  onToggleBodyText,
  onSetAlignment,
  onApplyColor,
  onApplyHighlight,
  onApplyFontFamily,
  onApplyFontSize,
  onApplyLineHeight,
  onToggleBlockquote,
  onToggleCodeBlock,
  onToggleTaskList,
  onInsertHorizontalRule,
  onInsertTable,
  onTableAction,
  onIndent,
  onOutdent,
  onUndo,
  onRedo,
  onToggleWordWrap,
  onToggleOutline,
  onTogglePageView,
  onToggleFocusMode,
  onSave,
  onExport,
  onInsertImage,
  onInsertLink,
}: EditorToolbarProps) {
  const { t } = useTranslation();
  const isOutlineOpen = useEditorUIStore((s) => s.isOutlineOpen);
  const isPageViewMode = useEditorUIStore((s) => s.isPageViewMode);
  const isFocusMode = useEditorUIStore((s) => s.isFocusMode);
  const activeHeadingState = useEditorStatusStore((s) => s.activeHeadingState);
  const activeFormats = useEditorStatusStore((s) => s.activeFormats);

  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isHighlightPickerOpen, setIsHighlightPickerOpen] = useState(false);
  const [isTableMenuOpen, setIsTableMenuOpen] = useState(false);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [fontSizeInput, setFontSizeInput] = useState("");

  useEffect(() => {
    setFontSizeInput(activeFormats.fontSize.replace(/px$/i, ""));
  }, [activeFormats.fontSize]);

  const closeAllDropdowns = useCallback(() => {
    setIsColorPickerOpen(false);
    setIsHighlightPickerOpen(false);
    setIsTableMenuOpen(false);
  }, []);

  const toggleColorPicker = useCallback(() => {
    setIsColorPickerOpen(prev => !prev);
    setIsHighlightPickerOpen(false);
    setIsTableMenuOpen(false);
  }, []);

  const toggleHighlightPicker = useCallback(() => {
    setIsHighlightPickerOpen(prev => !prev);
    setIsColorPickerOpen(false);
    setIsTableMenuOpen(false);
  }, []);

  const toggleTableMenu = useCallback(() => {
    setIsTableMenuOpen(prev => !prev);
    setIsColorPickerOpen(false);
    setIsHighlightPickerOpen(false);
  }, []);

  const applyFontSizeInput = useCallback(() => {
    const normalized = fontSizeInput.trim();
    if (!normalized) {
      onApplyFontSize("");
      return;
    }
    const numericValue = Number(normalized);
    if (!Number.isFinite(numericValue) || numericValue <= 0) return;
    const clampedValue = Math.min(200, Math.max(1, numericValue));
    const nextValue = String(clampedValue);
    setFontSizeInput(nextValue);
    onApplyFontSize(`${nextValue}px`);
  }, [fontSizeInput, onApplyFontSize]);

  const handleFontSizeKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyFontSizeInput();
    }
    if (event.key === "Escape") {
      setFontSizeInput("");
      onApplyFontSize("");
    }
  }, [applyFontSizeInput, onApplyFontSize]);

  const handleFontSizePreset = useCallback((value: string) => {
    if (!value) {
      setFontSizeInput("");
      onApplyFontSize("");
      return;
    }
    const numericValue = value.replace(/px$/, "");
    setFontSizeInput(numericValue);
    onApplyFontSize(value);
  }, [onApplyFontSize]);

  const toolbarButtonClass = (active = false) => `toolbar-button${active ? " active" : ""}`;

  const disabled = !activeFile || activeFile.isReadOnly || activeFile.fileMode === "txt" || activeFile.fileMode === "blueprint" || activeFile.fileMode === "image" || activeFile.fileMode === "unsupported";
  const fileActionDisabled = !activeFile || activeFile.isReadOnly;
  const [activeTab, setActiveTab] = useState<"home" | "insert" | "view" | "file">("home");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const tabClass = (tab: string) => `toolbar-tab${activeTab === tab ? " active" : ""}`;

  return (
    <div className="panel-actions">
      <div className="toolbar-header">
        <div className="toolbar-tabs">
          <button className={tabClass("home")} onClick={() => setActiveTab("home")}>{t("editor.toolbar.tabs.home")}</button>
          <button className={tabClass("insert")} onClick={() => setActiveTab("insert")}>{t("editor.toolbar.tabs.insert")}</button>
          <button className={tabClass("view")} onClick={() => setActiveTab("view")}>{t("editor.toolbar.tabs.view")}</button>
          <button className={tabClass("file")} onClick={() => setActiveTab("file")}>{t("editor.toolbar.tabs.file")}</button>
        </div>
      </div>
      <div className="format-toolbar" ref={scrollRef}>
        <div className="format-toolbar-inner">
        {activeTab === "home" && (
          <>
            <button className={toolbarButtonClass(activeHeadingState === "h1")} onClick={() => onToggleHeading(1)} title={t("editor.toolbar.heading1")} disabled={disabled}>
              <Heading1 size={16} />
            </button>
            <button className={toolbarButtonClass(activeHeadingState === "h2")} onClick={() => onToggleHeading(2)} title={t("editor.toolbar.heading2")} disabled={disabled}>
              <Heading2 size={16} />
            </button>
            <button className={toolbarButtonClass(activeHeadingState === "h3")} onClick={() => onToggleHeading(3)} title={t("editor.toolbar.heading3")} disabled={disabled}>
              <Heading3 size={16} />
            </button>
            <button className={toolbarButtonClass(activeHeadingState === "body")} onClick={onToggleBodyText} title={t("editor.toolbar.bodyText")} disabled={disabled}>
              <Type size={16} />
            </button>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass(activeFormats.bold)} onClick={() => onToggleFormat("bold")} title={t("editor.toolbar.bold")} disabled={disabled}>
              <Bold size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.italic)} onClick={() => onToggleFormat("italic")} title={t("editor.toolbar.italic")} disabled={disabled}>
              <Italic size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.underline)} onClick={() => onToggleFormat("underline")} title={t("editor.toolbar.underline")} disabled={disabled}>
              <Underline size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.strike)} onClick={() => onToggleFormat("strike")} title={t("editor.toolbar.strike")} disabled={disabled}>
              <Strikethrough size={16} />
            </button>
            <span className="toolbar-divider" />
            <div className="toolbar-dropdown-wrap">
              <button className={toolbarButtonClass(isColorPickerOpen)} onClick={toggleColorPicker} title={t("editor.toolbar.textColor")} disabled={disabled}>
                <Palette size={16} />
              </button>
              {isColorPickerOpen && (
                <div className="toolbar-dropdown color-picker">
                  {COLORS.map((c) => (
                    <button key={c.value} className="color-swatch" style={{ backgroundColor: c.value }} onClick={() => { onApplyColor(c.value); closeAllDropdowns(); }} title={t(c.labelKey)} />
                  ))}
                </div>
              )}
            </div>
            <div className="toolbar-dropdown-wrap">
              <button className={toolbarButtonClass(isHighlightPickerOpen)} onClick={toggleHighlightPicker} title={t("editor.toolbar.highlight")} disabled={disabled}>
                <Highlighter size={16} />
              </button>
              {isHighlightPickerOpen && (
                <div className="toolbar-dropdown color-picker">
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button key={c.value} className="color-swatch" style={{ backgroundColor: c.value || "#00000000" }} onClick={() => { onApplyHighlight(c.value); closeAllDropdowns(); }} title={t(c.labelKey)} />
                  ))}
                </div>
              )}
            </div>
            <span className="toolbar-divider" />
            <div className="toolbar-control-wrap">
              <select
                className="toolbar-select font-family-select"
                defaultValue=""
                onChange={(event) => {
                  onApplyFontFamily(event.target.value);
                  event.currentTarget.value = "";
                }}
                title={t("editor.toolbar.font")}
                disabled={disabled}
              >
                <option value="">{t("editor.toolbar.font")}</option>
                {FONT_FAMILIES.map((f) => (
                  <option key={f.value || "default"} value={f.value} style={{ fontFamily: f.value || "inherit" }}>
                    {t(f.labelKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-control-wrap font-size-combo">
              <input
                className="toolbar-number-input font-size-combo-input"
                type="number"
                min={1}
                max={200}
                step={1}
                value={fontSizeInput}
                onChange={(event) => setFontSizeInput(event.target.value)}
                onBlur={applyFontSizeInput}
                onKeyDown={handleFontSizeKeyDown}
                placeholder={t("editor.toolbar.fontSizeShort")}
                title={t("editor.toolbar.fontSize")}
                disabled={disabled}
              />
              <select
                className="toolbar-select font-size-combo-select"
                defaultValue=""
                onChange={(event) => {
                  handleFontSizePreset(event.target.value);
                  event.currentTarget.value = "";
                }}
                title={t("editor.toolbar.fontSize")}
                disabled={disabled}
              >
                {FONT_SIZES.map((s) => (
                  <option key={s.value || "default"} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-control-wrap">
              <select
                className="toolbar-select line-height-select"
                defaultValue=""
                onChange={(event) => {
                  if (event.target.value) onApplyLineHeight(event.target.value);
                  event.currentTarget.value = "";
                }}
                title={t("editor.toolbar.lineHeight")}
                disabled={disabled}
              >
                <option value="">{t("editor.toolbar.lineHeightShort")}</option>
                {LINE_HEIGHTS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass()} onClick={onIndent} title={t("editor.toolbar.indent")} disabled={disabled}>
              <Indent size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={onOutdent} title={t("editor.toolbar.outdent")} disabled={disabled}>
              <Outdent size={16} />
            </button>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass(activeFormats.alignLeft)} onClick={() => onSetAlignment("left")} title={t("editor.toolbar.alignLeft")} disabled={disabled}>
              <AlignLeft size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.alignCenter)} onClick={() => onSetAlignment("center")} title={t("editor.toolbar.alignCenter")} disabled={disabled}>
              <AlignCenter size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.alignRight)} onClick={() => onSetAlignment("right")} title={t("editor.toolbar.alignRight")} disabled={disabled}>
              <AlignRight size={16} />
            </button>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass(activeFormats.blockquote)} onClick={onToggleBlockquote} title={t("editor.toolbar.blockquote")} disabled={disabled}>
              <Quote size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.codeBlock)} onClick={onToggleCodeBlock} title={t("editor.toolbar.codeBlock")} disabled={disabled}>
              <Code size={16} />
            </button>
            <button className={toolbarButtonClass(activeFormats.taskList)} onClick={onToggleTaskList} title={t("editor.toolbar.taskList")} disabled={disabled}>
              <ListChecks size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={onInsertHorizontalRule} title={t("editor.toolbar.horizontalRule")} disabled={disabled}>
              <Minus size={16} />
            </button>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass()} onClick={onUndo} title={t("editor.toolbar.undo")} disabled={disabled}>
              <Undo size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={onRedo} title={t("editor.toolbar.redo")} disabled={disabled}>
              <Redo size={16} />
            </button>
          </>
        )}
        {activeTab === "insert" && (
          <>
            <div className="toolbar-dropdown-wrap">
              <button className={toolbarButtonClass(isTableMenuOpen)} onClick={toggleTableMenu} title={t("editor.toolbar.table")} disabled={disabled}>
                <TableIcon size={16} />
              </button>
              {isTableMenuOpen && (
                <div className="toolbar-dropdown table-menu">
                  <button onClick={() => { onInsertTable(2, 2); closeAllDropdowns(); }}>{t("editor.table.insert", { size: "2x2" })}</button>
                  <button onClick={() => { onInsertTable(3, 3); closeAllDropdowns(); }}>{t("editor.table.insert", { size: "3x3" })}</button>
                  <button onClick={() => { onInsertTable(4, 4); closeAllDropdowns(); }}>{t("editor.table.insert", { size: "4x4" })}</button>
                  <button onClick={() => { onInsertTable(5, 5); closeAllDropdowns(); }}>{t("editor.table.insert", { size: "5x5" })}</button>
                  <span className="dropdown-divider" />
                  <button onClick={() => { onTableAction("addColumnBefore"); closeAllDropdowns(); }}>{t("editor.table.addColumnBefore")}</button>
                  <button onClick={() => { onTableAction("addColumnAfter"); closeAllDropdowns(); }}>{t("editor.table.addColumnAfter")}</button>
                  <button onClick={() => { onTableAction("addRowBefore"); closeAllDropdowns(); }}>{t("editor.table.addRowBefore")}</button>
                  <button onClick={() => { onTableAction("addRowAfter"); closeAllDropdowns(); }}>{t("editor.table.addRowAfter")}</button>
                  <span className="dropdown-divider" />
                  <button onClick={() => { onTableAction("deleteColumn"); closeAllDropdowns(); }}>{t("editor.table.deleteColumn")}</button>
                  <button onClick={() => { onTableAction("deleteRow"); closeAllDropdowns(); }}>{t("editor.table.deleteRow")}</button>
                  <button onClick={() => { onTableAction("deleteTable"); closeAllDropdowns(); }}>{t("editor.table.deleteTable")}</button>
                  <span className="dropdown-divider" />
                  <button onClick={() => { onTableAction("mergeCells"); closeAllDropdowns(); }}>{t("editor.table.mergeCells")}</button>
                  <button onClick={() => { onTableAction("splitCell"); closeAllDropdowns(); }}>{t("editor.table.splitCell")}</button>
                  <button onClick={() => { onTableAction("toggleHeaderRow"); closeAllDropdowns(); }}>{t("editor.table.toggleHeaderRow")}</button>
                </div>
              )}
            </div>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass()} onClick={onInsertImage} title={t("editor.toolbar.insertImage")} disabled={disabled}>
              <ImageIcon size={16} />
            </button>
            <button className={toolbarButtonClass()} onClick={onInsertLink} title={t("editor.toolbar.insertLink")} disabled={disabled}>
              <Link size={16} />
            </button>
          </>
        )}
        {activeTab === "view" && (
          <>
            <button className={toolbarButtonClass(isOutlineOpen)} onClick={onToggleOutline} title={t("editor.toolbar.outline")} disabled={disabled}>
              <span className="toolbar-text-btn" style={{ fontSize: 11 }}>{t("editor.toolbar.outlineShort")}</span>
            </button>
            <button className={toolbarButtonClass(isPageViewMode)} onClick={onTogglePageView} title={t("editor.toolbar.pageView")} disabled={disabled}>
              <span className="toolbar-text-btn" style={{ fontSize: 11 }}>{t("editor.toolbar.pageShort")}</span>
            </button>
            <button className={toolbarButtonClass(isFocusMode)} onClick={onToggleFocusMode} title={t("editor.toolbar.focusMode")} disabled={disabled}>
              <span className="toolbar-text-btn" style={{ fontSize: 11 }}>{t("editor.toolbar.focusShort")}</span>
            </button>
            <span className="toolbar-divider" />
            <button className={toolbarButtonClass()} onClick={onToggleWordWrap} title={t("editor.toolbar.wordWrap")} disabled={disabled}>
              <WrapText size={16} />
            </button>
          </>
        )}
        {activeTab === "file" && (
          <>
            <button className={toolbarButtonClass()} onClick={onSave} title={t("editor.toolbar.save")} disabled={fileActionDisabled}>
              <Save size={16} />
            </button>
            <span className="toolbar-divider" />
            <div className="export-menu-wrap">
              <button className={toolbarButtonClass(isExportMenuOpen)} onClick={() => setIsExportMenuOpen(prev => !prev)} title={t("editor.toolbar.export")} disabled={fileActionDisabled}>
                <Download size={16} />
                <ChevronDown size={14} />
              </button>
              {isExportMenuOpen && activeFile && (
                <div className="export-menu">
                  <button type="button" onClick={() => { onExport("txt"); setIsExportMenuOpen(false); }}>{t("editor.export.asTxt")}</button>
                  <button type="button" onClick={() => { onExport("pdf"); setIsExportMenuOpen(false); }}>{t("editor.export.asPdf")}</button>
                  <button type="button" onClick={() => { onExport("docx"); setIsExportMenuOpen(false); }}>{t("editor.export.asDocx")}</button>
                </div>
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
});
