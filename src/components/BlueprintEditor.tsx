import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LayoutDashboard, LayoutTemplate, Minus, Plus, RotateCcw, Save, Settings2, Trash2, UserRound } from "lucide-react";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useFileStore } from "../stores/fileStore";
import type { WorkspaceNode } from "../services/fileSystemService";
import type { BlueprintDocument, BlueprintEdge, BlueprintFieldBindingKey, BlueprintFieldInputMode, BlueprintLogicCompareOperator, BlueprintLogicTree, BlueprintMountLink, BlueprintNode, BlueprintNodeKind, BlueprintNodeLayer, BlueprintNodeTemplate, BlueprintPresetType, BlueprintTypedData, BlueprintTypedNodeType } from "../types/blueprint";
import { useTranslation } from "../hooks/useTranslation";
import { getFloatingPosition, type FloatingPositionResult } from "../utils/floatingPosition";
import { autoLayoutBlueprint } from "../utils/blueprintAutoLayout";
import "./BlueprintEditor.css";

interface Props {
  blueprintId: string;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 126;
const PORT_ANCHOR_OFFSET = 3;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.5;
const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 128;
const MINIMAP_PADDING = 80;
const ZOOM_SAVE_DELAY_MS = 280;
const FLOATING_EDGE_PADDING = 12;
const CREATE_MENU_WIDTH = 360;
const CREATE_MENU_HEIGHT = 360;
const CONTEXT_MENU_WIDTH = 230;
const CONTEXT_MENU_HEIGHT = 178;
const CONTEXT_SUBMENU_ROW_TOP = 114;
const CONTEXT_MENU_SHORT_PRESS_MS = 1000;
const NODE_COLLISION_GAP = 32;
const EDGE_INSERT_THRESHOLD = 34;
const EDGE_SAMPLE_STEPS = 28;

type PanState = { mode: "panning"; startX: number; startY: number; originX: number; originY: number };
type NodeDragState = { mode: "draggingNode"; nodeId: string; offsetX: number; offsetY: number; startX: number; startY: number; isDragging: boolean };
type ConnectionDragState = { mode: "connecting"; from: string; x: number; y: number };
type MarqueeSelectState = { mode: "marqueeSelecting"; startClientX: number; startClientY: number; currentClientX: number; currentClientY: number };
type InputManagerState =
  | { mode: "idle" }
  | PanState
  | NodeDragState
  | ConnectionDragState
  | MarqueeSelectState;
type MinimapDragState = { bounds: MinimapBounds } | null;
type SaveState = "idle" | "saving" | "saved" | "error";
type BlueprintClipboard = Pick<BlueprintDocument, "nodes" | "edges">;
type BlueprintPaletteItem =
  | { id: string; type: "base"; kind: BlueprintNodeKind; label: string }
  | { id: string; type: "preset"; kind: "custom"; presetType?: BlueprintPresetType; layer: BlueprintNodeLayer; nodeType: BlueprintTypedNodeType; label: string; summary: string }
  | { id: string; type: "template"; kind: BlueprintNodeKind; templateId: string; label: string };
type FloatingPosition = Pick<FloatingPositionResult, "left" | "top" | "maxHeight" | "placementY" | "placementX">;
type BlueprintContextMenuState = (FloatingPosition & { canvasX: number; canvasY: number; submenuSide: "left" | "right"; submenuMaxHeight: number; submenuTop: number }) | null;
type MinimapBounds = { minX: number; minY: number; width: number; height: number; scale: number };
type ContextMenuPressState = { startedAt: number; clientX: number; clientY: number; canvasX: number; canvasY: number };
type BlueprintSuggestionKind = "reference" | "chapterTitleFile";
type ActiveBlueprintSuggestionInput = { id: string; kind: BlueprintSuggestionKind } | null;
type EdgeInsertCandidate = { edgeId: string; x: number; y: number; distance: number } | null;
type PendingConnectionCreate = { fromNodeId: string; canvasX: number; canvasY: number } | null;

const newLocalId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ensureFieldValues = (values: string[] | undefined, fallback = "") => (values?.length ? values : [fallback]);
const nextFieldMode = (mode: BlueprintFieldInputMode | undefined): BlueprintFieldInputMode => (mode === "fixed" ? "repeatable" : "fixed");
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const newTemplateField = () => ({
  id: newLocalId("template-field"),
  key: "",
  defaultValue: "",
  defaultValues: [""],
  inputMode: "repeatable" as BlueprintFieldInputMode,
  bindingKey: "custom" as BlueprintFieldBindingKey,
  showInCard: true,
});
const BUILTIN_NODE_GROUPS: Array<{ layer: BlueprintNodeLayer; label: string; items: Array<{ nodeType: BlueprintTypedNodeType; presetType?: BlueprintPresetType; label: string; summary: string }> }> = [
  { layer: "story", label: "剧情层", items: [
    { nodeType: "hook", presetType: "hook", label: "Hook", summary: "吸引读者继续阅读，制造悬念、问题或冲突" },
    { nodeType: "linearPlot", presetType: "linearPlot", label: "线性剧情", summary: "A → B → C → D 的顺序剧情" },
    { nodeType: "nonlinearPlot", presetType: "nonlinearPlot", label: "非线性剧情", summary: "过去、现在、未来、回忆、梦境或平行时间线" },
    { nodeType: "trickPerspective", presetType: "trickPerspective", label: "诡叙（视角）", summary: "第一人称、第三人称、不可靠叙述者或反派视角" },
    { nodeType: "trickTime", presetType: "trickTime", label: "诡叙（时间）", summary: "倒叙、插叙、循环或未来片段" },
    { nodeType: "branchPlot", presetType: "branchPlot", label: "支线", summary: "可独立发展并回收到主线的故事" },
    { nodeType: "hiddenLine", presetType: "hiddenLine", label: "暗线", summary: "读者暂时看不到的伏笔、幕后组织或真相" },
  ] },
  { layer: "structure", label: "结构层", items: [
    { nodeType: "chapter", presetType: "chapter", label: "章节", summary: "章节梗概与挂载容器" },
    { nodeType: "chapterGroup", label: "章节组", summary: "管理一组连续章节" },
    { nodeType: "volume", label: "卷", summary: "管理长篇结构中的一卷" },
    { nodeType: "act", label: "幕", summary: "管理三幕式、起承转合等结构段落" },
    { nodeType: "mount", presetType: "mount", label: "挂载器", summary: "章节下的世界观、人物线、伏笔等容器" },
  ] },
  { layer: "logic", label: "逻辑层", items: [
    { nodeType: "because", presetType: "logicBlock", label: "因为", summary: "因为条件，所以结果，因此可选" },
    { nodeType: "and", label: "AND", summary: "多个条件同时成立" },
    { nodeType: "or", label: "OR", summary: "多个条件任一成立" },
    { nodeType: "compare", label: "比较", summary: "等于、不等于、大于、小于" },
    { nodeType: "condition", label: "条件", summary: "独立逻辑条件" },
  ] },
  { layer: "control", label: "控制流层", items: [
    { nodeType: "loop", presetType: "loop", label: "循环", summary: "次数循环、条件循环或无限循环" },
    { nodeType: "branch", label: "分支", summary: "剧情分叉" },
    { nodeType: "merge", label: "汇合", summary: "多条剧情线汇聚" },
  ] },
  { layer: "narrative", label: "叙事层", items: [
    { nodeType: "conflict", label: "冲突", summary: "目标 VS 阻碍" },
    { nodeType: "foreshadow", label: "伏笔", summary: "埋设、隐藏、回收" },
    { nodeType: "reveal", label: "揭露", summary: "揭示此前隐藏的信息" },
    { nodeType: "twist", label: "反转", summary: "改变读者对事件的理解" },
  ] },
];
const BUILTIN_PRESETS = BUILTIN_NODE_GROUPS.flatMap((group) => group.items.map((item) => ({ ...item, layer: group.layer })))
  .filter((item) => !["chapterGroup", "volume", "act", "mount", "loop", "branch", "merge", "and", "or", "compare", "condition"].includes(item.nodeType))
  .map((item) => item.nodeType === "because"
    ? { ...item, nodeType: "logicBlueprint" as const, label: "逻辑蓝图", summary: "用子蓝图整理因为、条件、比较与结果" }
    : item
  );

const createBlankTemplate = (): BlueprintNodeTemplate => {
  const now = new Date().toISOString();
  return {
    id: newLocalId("template"),
    name: "",
    nodeKind: "custom",
    inputCount: 1,
    fields: [newTemplateField()],
    createdAt: now,
    updatedAt: now,
  };
};

const isEditableEventTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
};

const isPrimaryMouseDown = (event: Pick<MouseEvent | PointerEvent | React.PointerEvent, "buttons">) => (event.buttons & 1) === 1;

const isBlueprintBlankTarget = (target: EventTarget | null, canvas: HTMLDivElement) => {
  if (!(target instanceof Element)) return false;
  if (target === canvas) return true;
  if (target.closest(".blueprint-node, .node-port, .blueprint-minimap, .blueprint-edge-hitbox")) return false;
  return Boolean(target.closest(".blueprint-world, .blueprint-edges"));
};

const isChapterSuggestionFile = (name: string) => /\.(docx|md|markdown|txt)$/i.test(name);

const collectWorkspaceDocumentNames = (nodes: WorkspaceNode[]) => {
  const names: string[] = [];
  const visit = (items: WorkspaceNode[]) => {
    for (const item of items) {
      if (item.type === "file" && isChapterSuggestionFile(item.name)) {
        names.push(item.name);
      }
      if (item.children?.length) visit(item.children);
    }
  };
  visit(nodes);
  return names;
};

const clientToCanvas = (clientX: number, clientY: number, canvas: HTMLDivElement, blueprint: BlueprintDocument) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - blueprint.viewport.x) / blueprint.viewport.zoom,
    y: (clientY - rect.top - blueprint.viewport.y) / blueprint.viewport.zoom,
  };
};

const screenToCanvas = (event: React.PointerEvent, canvas: HTMLDivElement, blueprint: BlueprintDocument) =>
  clientToCanvas(event.clientX, event.clientY, canvas, blueprint);

const getContextMenuPosition = (clientX: number, clientY: number) => {
  const mainPosition = getFloatingPosition(
    { x: clientX, y: clientY },
    {
      width: CONTEXT_MENU_WIDTH,
      height: CONTEXT_MENU_HEIGHT,
      offset: 0,
      padding: FLOATING_EDGE_PADDING,
      minHeight: 120,
      preferVertical: "bottom",
      preferHorizontal: "right",
    }
  );
  const rightSpace = window.innerWidth - (mainPosition.left + CONTEXT_MENU_WIDTH) - FLOATING_EDGE_PADDING;
  const leftSpace = mainPosition.left - FLOATING_EDGE_PADDING;
  const submenuSide: "left" | "right" = rightSpace >= CREATE_MENU_WIDTH || rightSpace >= leftSpace ? "right" : "left";
  const submenuHeight = Math.min(CREATE_MENU_HEIGHT, window.innerHeight - FLOATING_EDGE_PADDING * 2);
  const submenuAnchorTop = mainPosition.top + CONTEXT_SUBMENU_ROW_TOP;
  const desiredSubmenuTop = mainPosition.placementY === "top"
    ? clientY - submenuHeight
    : submenuAnchorTop;
  const submenuAbsoluteTop = Math.min(
    window.innerHeight - submenuHeight - FLOATING_EDGE_PADDING,
    Math.max(FLOATING_EDGE_PADDING, desiredSubmenuTop)
  );
  return {
    left: mainPosition.left,
    top: mainPosition.top,
    maxHeight: Math.min(CONTEXT_MENU_HEIGHT, mainPosition.maxHeight),
    placementY: mainPosition.placementY,
    placementX: mainPosition.placementX,
    submenuSide,
    submenuTop: submenuAbsoluteTop - submenuAnchorTop,
    submenuMaxHeight: submenuHeight,
  };
};

export default function BlueprintEditor({ blueprintId }: Props) {
  const { t } = useTranslation();
  const {
    blueprints,
    templates,
    focusedNodeByBlueprintId,
    templateErrorMessage,
    loadBlueprints,
    loadTemplates,
    saveBlueprint,
    saveTemplate,
    deleteTemplate,
    createBlueprint,
    replaceBlueprint,
    updateViewport: updateBlueprintViewport,
    pushUndo,
    undoBlueprint,
    addNode,
    createCustomNodeFromTemplate,
    updateNode,
    deleteNodes,
    addEdge,
    deleteEdge,
    focusNode,
  } = useBlueprintStore();
  const { activeFile, editorGroups, files, referenceEntries, openBlueprintTab } = useFileStore();
  const blueprint = blueprints.find((item) => item.id === blueprintId) ?? null;
  const focusedNodeId = focusedNodeByBlueprintId[blueprintId] ?? null;
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(focusedNodeId ? [focusedNodeId] : []);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inputManager, setInputManager] = useState<InputManagerState>({ mode: "idle" });
  const [connectionHoverNodeId, setConnectionHoverNodeId] = useState<string | null>(null);
  const [minimapDrag, setMinimapDrag] = useState<MinimapDragState>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<BlueprintContextMenuState>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [createMenuPosition, setCreateMenuPosition] = useState<FloatingPosition | null>(null);
  const [createLayer, setCreateLayer] = useState<BlueprintNodeLayer>("story");
  const [createSearch, setCreateSearch] = useState("");
  const [activeCreateItemId, setActiveCreateItemId] = useState<string | null>(null);
  const [edgeInsertCandidate, setEdgeInsertCandidate] = useState<EdgeInsertCandidate>(null);
  const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate>(null);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<BlueprintNodeTemplate>(() => createBlankTemplate());
  const [activeSuggestionInput, setActiveSuggestionInput] = useState<ActiveBlueprintSuggestionInput>(null);
  const [suggestionPlacement, setSuggestionPlacement] = useState<"top" | "bottom">("bottom");
  const [mountBlueprintSearch, setMountBlueprintSearch] = useState("");
  const [newMountBlueprintName, setNewMountBlueprintName] = useState("");
  const [activeChildNodeId, setActiveChildNodeId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const minimapRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const saveTimerRef = useRef<number | null>(null);
  const zoomSaveTimerRef = useRef<number | null>(null);
  const clipboardRef = useRef<BlueprintClipboard | null>(null);
  const contextMenuPressRef = useRef<ContextMenuPressState | null>(null);
  const inputManagerRef = useRef<InputManagerState>({ mode: "idle" });
  const connectionHoverNodeIdRef = useRef<string | null>(null);
  const edgeInsertCandidateRef = useRef<EdgeInsertCandidate>(null);
  const nodeDrag = inputManager.mode === "draggingNode" ? inputManager : null;
  const panState = inputManager.mode === "panning" ? inputManager : null;
  const connectionDrag = inputManager.mode === "connecting" ? inputManager : null;
  const marqueeSelect = inputManager.mode === "marqueeSelecting" ? inputManager : null;

  useEffect(() => {
    inputManagerRef.current = inputManager;
  }, [inputManager]);

  useEffect(() => {
    connectionHoverNodeIdRef.current = connectionHoverNodeId;
  }, [connectionHoverNodeId]);

  const updateEdgeInsertCandidate = (candidate: EdgeInsertCandidate) => {
    edgeInsertCandidateRef.current = candidate;
    setEdgeInsertCandidate(candidate);
  };

  const getConnectionTargetAtPoint = (clientX: number, clientY: number, fromNodeId: string) => {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
      const nodeElement = element.closest?.<HTMLElement>("[data-blueprint-node-id]");
      const nodeId = nodeElement?.dataset.blueprintNodeId;
      if (nodeId && nodeId !== fromNodeId) return nodeId;
    }
    return null;
  };

  const clearConnectionDrag = () => {
    inputManagerRef.current = { mode: "idle" };
    setInputManager({ mode: "idle" });
    connectionHoverNodeIdRef.current = null;
    setConnectionHoverNodeId(null);
  };

  const openContextMenuAt = (press: ContextMenuPressState) => {
    setIsCreateMenuOpen(false);
    const menuPosition = getContextMenuPosition(press.clientX, press.clientY);
    setContextMenu({ ...menuPosition, canvasX: press.canvasX, canvasY: press.canvasY });
  };

  const finishConnectionDrag = (clientX?: number, clientY?: number, explicitTargetId?: string | null) => {
    const current = inputManagerRef.current;
    if (current.mode !== "connecting") {
      clearConnectionDrag();
      return;
    }
    const targetNodeId = explicitTargetId
      ?? (clientX !== undefined && clientY !== undefined ? getConnectionTargetAtPoint(clientX, clientY, current.from) : null)
      ?? connectionHoverNodeIdRef.current;
    if (targetNodeId && targetNodeId !== current.from) {
      addEdge(blueprintId, current.from, targetNodeId);
      setPendingConnectionCreate(null);
      clearConnectionDrag();
      return;
    }
    if (blueprint && canvasRef.current) {
      const point = clientX !== undefined && clientY !== undefined
        ? clientToCanvas(clientX, clientY, canvasRef.current, blueprint)
        : { x: current.x, y: current.y };
      setPendingConnectionCreate({ fromNodeId: current.from, canvasX: point.x, canvasY: point.y });
      const screenPoint = clientX !== undefined && clientY !== undefined
        ? { x: clientX, y: clientY }
        : {
            x: point.x * blueprint.viewport.zoom + blueprint.viewport.x + canvasRef.current.getBoundingClientRect().left,
            y: point.y * blueprint.viewport.zoom + blueprint.viewport.y + canvasRef.current.getBoundingClientRect().top,
          };
      setCreateMenuPosition(getFloatingPosition(
        { x: screenPoint.x, y: screenPoint.y },
        {
          width: CREATE_MENU_WIDTH,
          height: CREATE_MENU_HEIGHT,
          padding: FLOATING_EDGE_PADDING,
          preferVertical: "bottom",
          preferHorizontal: "right",
        }
      ));
      setContextMenu(null);
      setIsCreateMenuOpen(true);
    }
    clearConnectionDrag();
  };

  useEffect(() => {
    if (!blueprint) void loadBlueprints();
  }, [blueprint, loadBlueprints]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (focusedNodeId) {
      setSelectedNodeIds((current) => current.includes(focusedNodeId) ? current : [focusedNodeId]);
    }
  }, [focusedNodeId]);

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (zoomSaveTimerRef.current) window.clearTimeout(zoomSaveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isCreateMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (createMenuRef.current?.contains(target) || createButtonRef.current?.contains(target)) return;
      setIsCreateMenuOpen(false);
      setPendingConnectionCreate(null);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isCreateMenuOpen]);

  const selectedNode = blueprint?.nodes.find((node) => node.id === selectedNodeIds[selectedNodeIds.length - 1]) ?? null;
  const activeChildNode = blueprint?.nodes.find((node) => node.id === activeChildNodeId) ?? null;
  const activeChildBlueprint = activeChildNode?.typedData?.childBlueprint;
  const inputGuideStatus = inputManager.mode === "panning"
    ? t("blueprint.inputGuide.panning")
    : inputManager.mode === "marqueeSelecting"
      ? t("blueprint.inputGuide.selecting")
      : inputManager.mode === "draggingNode"
        ? t("blueprint.inputGuide.draggingNode")
        : inputManager.mode === "connecting"
          ? t("blueprint.inputGuide.connecting")
          : t("blueprint.inputGuide.ready");
  const paletteItems = useMemo<BlueprintPaletteItem[]>(() => [
    ...BUILTIN_PRESETS.map((preset) => ({
      id: `preset-${preset.nodeType}`,
      type: "preset" as const,
      kind: "custom" as const,
      presetType: preset.presetType,
      layer: preset.layer,
      nodeType: preset.nodeType,
      label: preset.label,
      summary: preset.summary,
    })),
    { id: "character-base", type: "base", kind: "character", label: t("blueprint.addCharacter") },
    { id: "custom-base", type: "base", kind: "custom", label: t("blueprint.customNode") },
    ...templates.map((template) => ({
      id: `template-${template.id}`,
      type: "template" as const,
      kind: template.nodeKind ?? "custom",
      templateId: template.id,
      label: template.name || t("blueprint.untitledNode"),
    })),
  ], [t, templates]);

  const clampInspectorWidth = (width: number) => Math.min(560, Math.max(320, width));

  useEffect(() => {
    if (!isResizingInspector) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      setInspectorWidth(clampInspectorWidth(rect.right - event.clientX));
    };

    const handlePointerUp = () => {
      setIsResizingInspector(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isResizingInspector]);

  useEffect(() => {
    if (!minimapDrag) return;

    const handlePointerMove = (event: PointerEvent) => {
      const target = minimapRef.current;
      if (!target || !blueprint || !canvasRef.current) return;
      const rect = target.getBoundingClientRect();
      const bounds = minimapDrag.bounds;
      const offsetX = (MINIMAP_WIDTH - bounds.width * bounds.scale) / 2;
      const offsetY = (MINIMAP_HEIGHT - bounds.height * bounds.scale) / 2;
      const localX = clamp(event.clientX - rect.left - offsetX, 0, bounds.width * bounds.scale);
      const localY = clamp(event.clientY - rect.top - offsetY, 0, bounds.height * bounds.scale);
      const worldX = bounds.minX + localX / bounds.scale;
      const worldY = bounds.minY + localY / bounds.scale;
      const canvasRect = canvasRef.current.getBoundingClientRect();
      updateViewport({
        x: canvasRect.width / 2 - worldX * blueprint.viewport.zoom,
        y: canvasRect.height / 2 - worldY * blueprint.viewport.zoom,
      });
    };

    const handlePointerUp = () => {
      setMinimapDrag(null);
      scheduleViewportSave();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [blueprint, minimapDrag]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !blueprint) return;

    const handleWheel = (event: WheelEvent) => {
      if (!canvasRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = canvasRef.current.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const currentZoom = blueprint.viewport.zoom;
      const nextZoom = clamp(currentZoom * Math.exp(-event.deltaY * 0.0012), MIN_ZOOM, MAX_ZOOM);
      if (Math.abs(nextZoom - currentZoom) < 0.001) return;

      const canvasX = (mouseX - blueprint.viewport.x) / currentZoom;
      const canvasY = (mouseY - blueprint.viewport.y) / currentZoom;
      updateViewport({
        zoom: nextZoom,
        x: mouseX - canvasX * nextZoom,
        y: mouseY - canvasY * nextZoom,
      });
      scheduleViewportSave();
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [blueprint?.id, blueprint?.viewport.x, blueprint?.viewport.y, blueprint?.viewport.zoom]);

  useEffect(() => {
    if (!connectionDrag || !blueprint || !canvasRef.current) return;

    const cancelConnectionDrag = (event?: Event) => {
      event?.preventDefault();
      event?.stopPropagation();
      clearConnectionDrag();
    };

    const handleConnectionPointerDown = (event: PointerEvent) => {
      if (event.button === 2) cancelConnectionDrag(event);
    };

    const handleConnectionPointerMove = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      const latestBlueprint = useBlueprintStore.getState().blueprints.find((item) => item.id === blueprintId) ?? blueprint;
      if (!canvas || !latestBlueprint) return;
      const point = clientToCanvas(event.clientX, event.clientY, canvas, latestBlueprint);
      setInputManager((current) => {
        if (current.mode !== "connecting") return current;
        const targetNodeId = getConnectionTargetAtPoint(event.clientX, event.clientY, current.from);
        connectionHoverNodeIdRef.current = targetNodeId;
        setConnectionHoverNodeId(targetNodeId);
        return { ...current, x: point.x, y: point.y };
      });
    };

    const handleConnectionPointerUp = (event: PointerEvent) => {
      if (event.button === 2) {
        cancelConnectionDrag(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      finishConnectionDrag(event.clientX, event.clientY);
    };

    const handleConnectionContextMenu = (event: MouseEvent) => {
      cancelConnectionDrag(event);
    };

    window.addEventListener("pointerdown", handleConnectionPointerDown);
    window.addEventListener("pointermove", handleConnectionPointerMove);
    window.addEventListener("pointerup", handleConnectionPointerUp);
    window.addEventListener("contextmenu", handleConnectionContextMenu);
    return () => {
      window.removeEventListener("pointerdown", handleConnectionPointerDown);
      window.removeEventListener("pointermove", handleConnectionPointerMove);
      window.removeEventListener("pointerup", handleConnectionPointerUp);
      window.removeEventListener("contextmenu", handleConnectionContextMenu);
    };
  }, [addEdge, blueprint, blueprintId, connectionDrag?.from]);

  useEffect(() => {
    if (!blueprint || !canvasRef.current || inputManager.mode === "connecting") return;

    const handleInputPointerMove = (event: PointerEvent) => {
      if (!canvasRef.current) return;
      if (inputManager.mode === "panning") {
        if (!isPrimaryMouseDown(event)) {
          handlePointerUp();
          return;
        }
        updateViewport({
          x: inputManager.originX + event.clientX - inputManager.startX,
          y: inputManager.originY + event.clientY - inputManager.startY,
        });
        return;
      }
      if (inputManager.mode === "draggingNode") {
      const point = clientToCanvas(event.clientX, event.clientY, canvasRef.current, blueprint);
      if (!inputManager.isDragging && Math.hypot(event.clientX - inputManager.startX, event.clientY - inputManager.startY) < 4) return;
      if (!inputManager.isDragging) {
        pushUndo(blueprintId);
        setInputManager({ ...inputManager, isDragging: true });
      }
        updateNode(blueprintId, inputManager.nodeId, {
          x: point.x - inputManager.offsetX,
          y: point.y - inputManager.offsetY,
        }, { skipUndo: true, skipPersist: true });
        return;
      }
      if (inputManager.mode === "marqueeSelecting") {
        setInputManager({ ...inputManager, currentClientX: event.clientX, currentClientY: event.clientY });
      }
    };

    const handleInputPointerUp = () => {
      if (inputManager.mode !== "idle") handlePointerUp();
    };

    window.addEventListener("pointermove", handleInputPointerMove);
    window.addEventListener("pointerup", handleInputPointerUp);
    return () => {
      window.removeEventListener("pointermove", handleInputPointerMove);
      window.removeEventListener("pointerup", handleInputPointerUp);
    };
  }, [blueprint, blueprintId, inputManager, updateNode]);

  const nodeById = useMemo(() => {
    const map = new Map<string, BlueprintNode>();
    blueprint?.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [blueprint]);

  const commitBlueprint = (next: BlueprintDocument, options?: { skipUndo?: boolean; skipPersist?: boolean }) => {
    replaceBlueprint(next, options);
  };

  const updateViewport = (patch: Partial<BlueprintDocument["viewport"]>) => {
    updateBlueprintViewport(blueprintId, patch);
  };

  const scheduleViewportSave = () => {
    if (zoomSaveTimerRef.current) window.clearTimeout(zoomSaveTimerRef.current);
    zoomSaveTimerRef.current = window.setTimeout(() => {
      const latestBlueprint = useBlueprintStore.getState().blueprints.find((item) => item.id === blueprintId);
      if (latestBlueprint) void saveBlueprint(latestBlueprint);
      zoomSaveTimerRef.current = null;
    }, ZOOM_SAVE_DELAY_MS);
  };

  const deleteSelection = () => {
    if (!blueprint) return;
    if (selectedNodeIds.length > 0) {
      deleteNodes(blueprintId, selectedNodeIds);
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
      return;
    }
    if (selectedEdgeId) {
      deleteEdge(blueprintId, selectedEdgeId);
      setSelectedEdgeId(null);
    }
  };

  const copySelection = () => {
    if (!blueprint || selectedNodeIds.length === 0) return;
    const ids = new Set(selectedNodeIds);
    clipboardRef.current = {
      nodes: blueprint.nodes.filter((node) => ids.has(node.id)).map((node) => structuredClone(node)),
      edges: blueprint.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => structuredClone(edge)),
    };
  };

  const cutSelection = () => {
    if (selectedNodeIds.length === 0) return;
    copySelection();
    deleteSelection();
  };

  const cloneNodeForPaste = (node: BlueprintNode, nextId: string): BlueprintNode => ({
    ...structuredClone(node),
    id: nextId,
    x: node.x + 32,
    y: node.y + 32,
    storyEvents: node.storyEvents?.map((event) => ({ ...event, id: newLocalId("event") })),
    characterEvents: node.characterEvents?.map((event) => ({ ...event, id: newLocalId("character-event") })),
    relationships: node.relationships?.map((relationship) => ({ ...relationship, id: newLocalId("rel") })),
    customFields: node.customFields?.map((field) => ({
      ...field,
      id: newLocalId("field"),
      values: field.values?.length ? [...field.values] : [field.value ?? ""],
      value: field.values?.[0] ?? field.value ?? "",
    })),
  });

  const pasteClipboard = (target?: { x: number; y: number }) => {
    if (!blueprint || !clipboardRef.current || clipboardRef.current.nodes.length === 0) return;
    const sourceNodes = clipboardRef.current.nodes;
    const minX = Math.min(...sourceNodes.map((node) => node.x));
    const minY = Math.min(...sourceNodes.map((node) => node.y));
    const idMap = new Map<string, string>();
    const nextNodes = sourceNodes.map((node) => {
      const nextId = newLocalId("node");
      idMap.set(node.id, nextId);
      const cloned = cloneNodeForPaste(node, nextId);
      return target ? { ...cloned, x: target.x + node.x - minX, y: target.y + node.y - minY } : cloned;
    });
    const nextEdges = clipboardRef.current.edges
      .map((edge) => {
        const from = idMap.get(edge.from);
        const to = idMap.get(edge.to);
        return from && to ? { ...edge, id: newLocalId("edge"), from, to } : null;
      })
      .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge));
    commitBlueprint({ ...blueprint, nodes: [...blueprint.nodes, ...nextNodes], edges: [...blueprint.edges, ...nextEdges] });
    const pastedIds = nextNodes.map((node) => node.id);
    setSelectedNodeIds(pastedIds);
    setSelectedEdgeId(null);
    focusNode(blueprintId, pastedIds[pastedIds.length - 1] ?? null);
    clipboardRef.current = {
      nodes: nextNodes.map((node) => structuredClone(node)),
      edges: nextEdges.map((edge) => structuredClone(edge)),
    };
  };

  const createChildBlueprint = (name: string): BlueprintDocument => ({
    id: newLocalId("child-blueprint"),
    name,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: newLocalId("child-start"),
        kind: "custom",
        layer: "control",
        nodeType: "custom",
        x: 80,
        y: 140,
        title: "开始",
        linkedChapters: [],
        templateName: "开始",
        inputCount: 1,
        customFields: [],
        typedData: { summary: "子蓝图开始" },
      },
      {
        id: newLocalId("child-end"),
        kind: "custom",
        layer: "control",
        nodeType: "custom",
        x: 460,
        y: 140,
        title: "结束",
        linkedChapters: [],
        templateName: "结束",
        inputCount: 1,
        customFields: [],
        typedData: { summary: "子蓝图结束" },
      },
    ],
    edges: [],
  });

  const createDefaultLogicTree = (nodeType: BlueprintTypedNodeType): BlueprintLogicTree => {
    if (nodeType === "compare") {
      return { id: newLocalId("logic-compare"), type: "compare", left: "", operator: "equals", right: "" };
    }
    if (nodeType === "and" || nodeType === "or") {
      return {
        id: newLocalId("logic-group"),
        type: "group",
        operator: nodeType,
        children: [
          { id: newLocalId("logic-condition"), type: "condition", text: "" },
          { id: newLocalId("logic-condition"), type: "condition", text: "" },
        ],
      };
    }
    return {
      id: newLocalId("logic-group"),
      type: "group",
      operator: "and",
      children: [{ id: newLocalId("logic-condition"), type: "condition", text: "" }],
    };
  };

  const createTypedDataForPreset = (layer: BlueprintNodeLayer, nodeType: BlueprintTypedNodeType, summary: string): BlueprintTypedData => {
    if (layer === "logic") {
      return { summary, childBlueprint: createChildBlueprint("逻辑蓝图"), logicTree: createDefaultLogicTree(nodeType), result: "", therefore: "" };
    }
    if (nodeType === "hook") return { summary, curiosity: "", relatedCharacters: [] };
    if (nodeType === "linearPlot" || nodeType === "nonlinearPlot") return { summary, timelineItems: [{ id: newLocalId("timeline"), time: "", event: "" }], relatedCharacters: [] };
    if (layer === "story" || layer === "narrative") return { summary, relatedCharacters: [] };
    if (nodeType === "chapter") return { summary, chapterTitle: "", mountLinks: [] };
    if (nodeType === "chapterGroup" || nodeType === "volume" || nodeType === "act") return { summary, parentStructureId: "" };
    if (nodeType === "mount") return { summary, mountKind: "", childBlueprint: createChildBlueprint("挂载器") };
    if (nodeType === "loop") return { summary, loopSteps: ["", ""], relatedCharacters: [] };
    if (nodeType === "conflict") return { summary, conflictPoint: "", protagonists: [""], antagonists: [""], relatedCharacters: [] };
    if (nodeType === "foreshadow") return { summary, setup: "", payoff: "" };
    if (nodeType === "reveal") return { summary, revealContent: "" };
    if (nodeType === "twist") return { summary, twistBefore: "", twistAfter: "" };
    return { summary };
  };

  const createPresetNode = (item: Extract<BlueprintPaletteItem, { type: "preset" }>, x: number, y: number): BlueprintNode => {
    const baseField = (key: string, value = "") => ({
      id: newLocalId("field"),
      key,
      value,
      values: [value],
      inputMode: "fixed" as BlueprintFieldInputMode,
      bindingKey: "custom" as BlueprintFieldBindingKey,
      showInCard: true,
    });
    const node: BlueprintNode = {
      id: newLocalId("node"),
      kind: "custom",
      layer: item.layer,
      nodeType: item.nodeType,
      typedData: createTypedDataForPreset(item.layer, item.nodeType, item.summary),
      presetType: item.presetType,
      x,
      y,
      title: item.label,
      linkedChapters: [],
      templateName: item.label,
      inputCount: 1,
      customFields: [],
    };

    if (item.nodeType === "chapter") {
      return {
        ...node,
        customFields: [baseField("所属章节或标题"), baseField("梗概", item.summary)],
      };
    }
    if (item.nodeType === "mount") {
      return {
        ...node,
        customFields: [baseField("内容"), baseField("备注")],
      };
    }
    if (item.nodeType === "loop") {
      return {
        ...node,
        customFields: [baseField("循环名称"), baseField("循环模式"), baseField("循环说明", item.summary)],
      };
    }
    if (item.layer === "logic") {
      return {
        ...node,
        logicBlock: {
          conditions: [
            { id: newLocalId("logic-condition"), value: "", operator: "and" },
            { id: newLocalId("logic-condition"), value: "", operator: "and" },
          ],
          result: "",
          therefore: "",
        },
      };
    }
    return {
      ...node,
      customFields: [baseField("梗概", item.summary)],
    };
  };

  const placePaletteItem = (item: BlueprintPaletteItem, x: number, y: number) => {
    const position = findAvailableNodePosition(x, y);
    let createdNode: BlueprintNode | null = null;
    if (item.type === "template") {
      createdNode = createCustomNodeFromTemplate(blueprintId, item.templateId, position.x, position.y);
    } else if (item.type === "preset") {
      if (!blueprint) return;
      const node = createPresetNode(item, position.x, position.y);
      commitBlueprint({ ...blueprint, nodes: [...blueprint.nodes, node] });
      createdNode = node;
      setSelectedNodeIds([node.id]);
      focusNode(blueprintId, node.id);
    } else {
      createdNode = addNode(blueprintId, item.kind, position.x, position.y);
    }
    if (pendingConnectionCreate && createdNode) {
      addEdge(blueprintId, pendingConnectionCreate.fromNodeId, createdNode.id);
      setSelectedNodeIds([createdNode.id]);
      focusNode(blueprintId, createdNode.id);
    }
    setPendingConnectionCreate(null);
    setSelectedEdgeId(null);
    setContextMenu(null);
    setIsCreateMenuOpen(false);
    setCreateSearch("");
  };

  const getViewportCenterPoint = () => {
    if (!blueprint || !canvasRef.current) return { x: 200, y: 160 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: (rect.width / 2 - blueprint.viewport.x) / blueprint.viewport.zoom,
      y: (rect.height / 2 - blueprint.viewport.y) / blueprint.viewport.zoom,
    };
  };

  const minimapBounds = useMemo<MinimapBounds>(() => {
    if (!blueprint || blueprint.nodes.length === 0) {
      const width = 1200;
      const height = 860;
      const scale = Math.min(MINIMAP_WIDTH / width, MINIMAP_HEIGHT / height);
      return { minX: -width / 2, minY: -height / 2, width, height, scale };
    }
    const minX = Math.min(...blueprint.nodes.map((node) => node.x)) - MINIMAP_PADDING;
    const minY = Math.min(...blueprint.nodes.map((node) => node.y)) - MINIMAP_PADDING;
    const maxX = Math.max(...blueprint.nodes.map((node) => node.x + NODE_WIDTH)) + MINIMAP_PADDING;
    const maxY = Math.max(...blueprint.nodes.map((node) => node.y + NODE_HEIGHT)) + MINIMAP_PADDING;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min(MINIMAP_WIDTH / width, MINIMAP_HEIGHT / height);
    return { minX, minY, width, height, scale };
  }, [blueprint]);

  const minimapOffset = {
    x: (MINIMAP_WIDTH - minimapBounds.width * minimapBounds.scale) / 2,
    y: (MINIMAP_HEIGHT - minimapBounds.height * minimapBounds.scale) / 2,
  };

  const viewRect = (() => {
    if (!blueprint || !canvasRef.current) return { x: 0, y: 0, width: 0, height: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    const worldX = -blueprint.viewport.x / blueprint.viewport.zoom;
    const worldY = -blueprint.viewport.y / blueprint.viewport.zoom;
    return {
      x: minimapOffset.x + (worldX - minimapBounds.minX) * minimapBounds.scale,
      y: minimapOffset.y + (worldY - minimapBounds.minY) * minimapBounds.scale,
      width: (rect.width / blueprint.viewport.zoom) * minimapBounds.scale,
      height: (rect.height / blueprint.viewport.zoom) * minimapBounds.scale,
    };
  })();

  const navigateMinimap = (event: React.PointerEvent<HTMLElement>, bounds = minimapBounds) => {
    if (!blueprint || !canvasRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const localX = clamp(event.clientX - rect.left - (MINIMAP_WIDTH - bounds.width * bounds.scale) / 2, 0, bounds.width * bounds.scale);
    const localY = clamp(event.clientY - rect.top - (MINIMAP_HEIGHT - bounds.height * bounds.scale) / 2, 0, bounds.height * bounds.scale);
    const worldX = bounds.minX + localX / bounds.scale;
    const worldY = bounds.minY + localY / bounds.scale;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    updateViewport({
      x: canvasRect.width / 2 - worldX * blueprint.viewport.zoom,
      y: canvasRect.height / 2 - worldY * blueprint.viewport.zoom,
    });
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key === "Escape") {
        setContextMenu(null);
        setIsCreateMenuOpen(false);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelection();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoBlueprint(blueprintId);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelection();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
        event.preventDefault();
        cutSelection();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteClipboard();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!blueprint || !canvasRef.current) return;
    if (event.button === 2) {
      event.preventDefault();
      setPendingConnectionCreate(null);
      const point = clientToCanvas(event.clientX, event.clientY, canvasRef.current, blueprint);
      contextMenuPressRef.current = {
        startedAt: Date.now(),
        clientX: event.clientX,
        clientY: event.clientY,
        canvasX: point.x,
        canvasY: point.y,
      };
      setContextMenu(null);
      setIsCreateMenuOpen(false);
      return;
    }
    if (!isBlueprintBlankTarget(event.target, event.currentTarget)) return;
    if (event.button !== 0) return;
    event.preventDefault();
    setContextMenu(null);
    setIsCreateMenuOpen(false);
    setPendingConnectionCreate(null);
    if (event.shiftKey) {
      setSelectedEdgeId(null);
      setInputManager({
        mode: "marqueeSelecting",
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
      });
      return;
    }
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    focusNode(blueprintId, null);
    setInputManager({
      mode: "panning",
      startX: event.clientX,
      startY: event.clientY,
      originX: blueprint.viewport.x,
      originY: blueprint.viewport.y,
    });
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!blueprint || !canvasRef.current) return;
    if (panState) {
      if (!isPrimaryMouseDown(event)) {
        handlePointerUp();
        return;
      }
      updateViewport({
        x: panState.originX + event.clientX - panState.startX,
        y: panState.originY + event.clientY - panState.startY,
      });
      return;
    }
    if (nodeDrag) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      if (!nodeDrag.isDragging && Math.hypot(event.clientX - nodeDrag.startX, event.clientY - nodeDrag.startY) < 4) return;
      if (!nodeDrag.isDragging) {
        pushUndo(blueprintId);
        setInputManager({ ...nodeDrag, isDragging: true });
      }
      updateNode(blueprintId, nodeDrag.nodeId, {
        x: point.x - nodeDrag.offsetX,
        y: point.y - nodeDrag.offsetY,
      }, { skipUndo: true, skipPersist: true });
      updateEdgeInsertCandidate(findEdgeInsertCandidate(nodeDrag.nodeId, point.x - nodeDrag.offsetX + NODE_WIDTH / 2, point.y - nodeDrag.offsetY + NODE_HEIGHT / 2));
      return;
    }
    if (connectionDrag) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      setInputManager({ ...connectionDrag, x: point.x, y: point.y });
      return;
    }
    if (marqueeSelect) {
      setInputManager({ ...marqueeSelect, currentClientX: event.clientX, currentClientY: event.clientY });
    }
  };

  const handleNodePointerDown = (event: React.PointerEvent, node: BlueprintNode) => {
    if (!blueprint || !canvasRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    setPendingConnectionCreate(null);
    updateEdgeInsertCandidate(null);
    const point = screenToCanvas(event, canvasRef.current, blueprint);
    setSelectedEdgeId(null);
    if (event.shiftKey) {
      setInputManager({ mode: "idle" });
      setSelectedNodeIds((current) => current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id]);
      focusNode(blueprintId, node.id);
      return;
    }
    setInputManager({
      mode: "draggingNode",
      nodeId: node.id,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    });
    setSelectedNodeIds([node.id]);
    focusNode(blueprintId, node.id);
  };

  const handleConnectionStart = (event: React.PointerEvent, nodeId: string) => {
    if (!blueprint || !canvasRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = screenToCanvas(event, canvasRef.current, blueprint);
    const nextState: ConnectionDragState = { mode: "connecting", from: nodeId, x: point.x, y: point.y };
    setPendingConnectionCreate(null);
    inputManagerRef.current = nextState;
    setInputManager(nextState);
    connectionHoverNodeIdRef.current = null;
    setConnectionHoverNodeId(null);
  };

  const handleConnectionEnd = (event: React.PointerEvent, nodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    finishConnectionDrag(event.clientX, event.clientY, nodeId);
  };

  const handleConnectionPointerMove = (event: React.PointerEvent) => {
    const current = inputManagerRef.current;
    if (!blueprint || !canvasRef.current || current.mode !== "connecting") return;
    event.preventDefault();
    event.stopPropagation();
    const point = screenToCanvas(event, canvasRef.current, blueprint);
    const targetNodeId = getConnectionTargetAtPoint(event.clientX, event.clientY, current.from);
    connectionHoverNodeIdRef.current = targetNodeId;
    setConnectionHoverNodeId(targetNodeId);
    setInputManager((current) => current.mode === "connecting" ? { ...current, x: point.x, y: point.y } : current);
  };

  const handleNodePointerEnter = (nodeId: string) => {
    if (!connectionDrag || connectionDrag.from === nodeId) return;
    setConnectionHoverNodeId(nodeId);
  };

  const handleNodePointerLeave = (nodeId: string) => {
    setConnectionHoverNodeId((current) => (current === nodeId ? null : current));
  };

  const getMarqueeCanvasRect = (state: MarqueeSelectState) => {
    if (!blueprint || !canvasRef.current) return null;
    const start = clientToCanvas(state.startClientX, state.startClientY, canvasRef.current, blueprint);
    const current = clientToCanvas(state.currentClientX, state.currentClientY, canvasRef.current, blueprint);
    return {
      left: Math.min(start.x, current.x),
      top: Math.min(start.y, current.y),
      right: Math.max(start.x, current.x),
      bottom: Math.max(start.y, current.y),
    };
  };

  const getMarqueeScreenRect = (state: MarqueeSelectState) => {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    const left = Math.min(state.startClientX, state.currentClientX) - rect.left;
    const top = Math.min(state.startClientY, state.currentClientY) - rect.top;
    return {
      left,
      top,
      width: Math.abs(state.currentClientX - state.startClientX),
      height: Math.abs(state.currentClientY - state.startClientY),
    };
  };

  const selectNodesInMarquee = (state: MarqueeSelectState) => {
    if (!blueprint) return;
    const rect = getMarqueeCanvasRect(state);
    if (!rect) return;
    const ids = blueprint.nodes
      .filter((node) => {
        const nodeLeft = node.x;
        const nodeTop = node.y;
        const nodeRight = node.x + NODE_WIDTH;
        const nodeBottom = node.y + NODE_HEIGHT;
        return nodeRight >= rect.left && nodeLeft <= rect.right && nodeBottom >= rect.top && nodeTop <= rect.bottom;
      })
      .map((node) => node.id);
    setSelectedNodeIds(ids);
    setSelectedEdgeId(null);
    focusNode(blueprintId, ids[ids.length - 1] ?? null);
  };

  const handlePointerUp = (event?: React.PointerEvent<HTMLDivElement>) => {
    if (event?.button === 2) {
      const contextPress = contextMenuPressRef.current;
      contextMenuPressRef.current = null;
      if (contextPress && inputManagerRef.current.mode === "idle" && Date.now() - contextPress.startedAt <= CONTEXT_MENU_SHORT_PRESS_MS) {
        event.preventDefault();
        event.stopPropagation();
        openContextMenuAt(contextPress);
      }
      return;
    }
    contextMenuPressRef.current = null;
    if (marqueeSelect) {
      selectNodesInMarquee(marqueeSelect);
    }
    const currentInput = inputManagerRef.current;
    if (currentInput.mode === "connecting") {
      finishConnectionDrag(event?.clientX, event?.clientY, connectionHoverNodeIdRef.current);
      return;
    }
    const insertCandidate = edgeInsertCandidateRef.current;
    if (nodeDrag && nodeDrag.isDragging && insertCandidate) {
      const position = findAvailableNodePosition(insertCandidate.x, insertCandidate.y, nodeDrag.nodeId);
      splitEdgeWithNode(insertCandidate.edgeId, nodeDrag.nodeId, position.x, position.y);
      updateEdgeInsertCandidate(null);
      inputManagerRef.current = { mode: "idle" };
      setInputManager({ mode: "idle" });
      connectionHoverNodeIdRef.current = null;
      setConnectionHoverNodeId(null);
      return;
    }
    if (nodeDrag || panState) {
      const latestBlueprint = useBlueprintStore.getState().blueprints.find((item) => item.id === blueprintId);
      if (latestBlueprint) void saveBlueprint(latestBlueprint);
    }
    updateEdgeInsertCandidate(null);
    inputManagerRef.current = { mode: "idle" };
    setInputManager({ mode: "idle" });
    connectionHoverNodeIdRef.current = null;
    setConnectionHoverNodeId(null);
  };

  const updateSelected = (patch: Partial<BlueprintNode>) => {
    if (!selectedNode) return;
    updateNode(blueprintId, selectedNode.id, patch);
  };

  const updateChapter = (index: number, value: string) => {
    if (!selectedNode) return;
    const linkedChapters = [...(selectedNode.linkedChapters ?? [])];
    linkedChapters[index] = value;
    updateSelected({ linkedChapters });
  };

  const updateStoryEvent = (eventId: string, patch: Partial<NonNullable<BlueprintNode["storyEvents"]>[number]>) => {
    if (!selectedNode) return;
    updateSelected({
      storyEvents: (selectedNode.storyEvents ?? []).map((event) =>
        event.id === eventId ? { ...event, ...patch } : event
      ),
    });
  };

  const updateCharacterEvent = (eventId: string, patch: Partial<NonNullable<BlueprintNode["characterEvents"]>[number]>) => {
    if (!selectedNode) return;
    updateSelected({
      characterEvents: (selectedNode.characterEvents ?? []).map((event) =>
        event.id === eventId ? { ...event, ...patch } : event
      ),
    });
  };

  const updateRelationship = (relationshipId: string, patch: Partial<NonNullable<BlueprintNode["relationships"]>[number]>) => {
    if (!selectedNode) return;
    updateSelected({
      relationships: (selectedNode.relationships ?? []).map((relationship) =>
        relationship.id === relationshipId ? { ...relationship, ...patch } : relationship
      ),
    });
  };

  const updateCustomField = (fieldId: string, patch: Partial<NonNullable<BlueprintNode["customFields"]>[number]>) => {
    if (!selectedNode) return;
    updateSelected({
      customFields: (selectedNode.customFields ?? []).map((field) =>
        field.id === fieldId ? { ...field, ...patch } : field
      ),
    });
  };

  const updateCustomFieldInput = (fieldId: string, index: number, value: string) => {
    if (!selectedNode) return;
    updateSelected({
      customFields: (selectedNode.customFields ?? []).map((field) => {
        if (field.id !== fieldId) return field;
        const values = [...ensureFieldValues(field.values, field.value ?? "")];
        values[index] = value;
        return { ...field, values, value: values[0] ?? "" };
      }),
    });
  };

  const addCustomFieldInput = (fieldId: string) => {
    if (!selectedNode) return;
    updateSelected({
      customFields: (selectedNode.customFields ?? []).map((field) => (
        field.id === fieldId && field.inputMode !== "fixed"
          ? { ...field, values: [...ensureFieldValues(field.values, field.value ?? ""), ""], value: ensureFieldValues(field.values, field.value ?? "")[0] ?? "" }
          : field
      )),
    });
  };

  const removeCustomFieldInput = (fieldId: string, index: number) => {
    if (!selectedNode) return;
    updateSelected({
      customFields: (selectedNode.customFields ?? []).map((field) => {
        if (field.id !== fieldId) return field;
        if (field.inputMode === "fixed") return field;
        const currentValues = ensureFieldValues(field.values, field.value ?? "");
        const nextValues = currentValues.length <= 1 ? [""] : currentValues.filter((_, itemIndex) => itemIndex !== index);
        return { ...field, values: nextValues, value: nextValues[0] ?? "" };
      }),
    });
  };

  const updateLogicBlock = (patch: Partial<NonNullable<BlueprintNode["logicBlock"]>>) => {
    if (!selectedNode) return;
    updateSelected({
      logicBlock: {
        conditions: selectedNode.logicBlock?.conditions?.length
          ? selectedNode.logicBlock.conditions
          : [{ id: newLocalId("logic-condition"), value: "", operator: "and" }],
        result: selectedNode.logicBlock?.result ?? "",
        therefore: selectedNode.logicBlock?.therefore ?? "",
        ...patch,
      },
    });
  };

  const updateLogicCondition = (conditionId: string, patch: Partial<NonNullable<BlueprintNode["logicBlock"]>["conditions"][number]>) => {
    const conditions = selectedNode?.logicBlock?.conditions?.length
      ? selectedNode.logicBlock.conditions
      : [{ id: newLocalId("logic-condition"), value: "", operator: "and" as const }];
    updateLogicBlock({
      conditions: conditions.map((condition) => condition.id === conditionId ? { ...condition, ...patch } : condition),
    });
  };

  const addLogicCondition = () => {
    const conditions = selectedNode?.logicBlock?.conditions?.length ? selectedNode.logicBlock.conditions : [];
    updateLogicBlock({
      conditions: [...conditions, { id: newLocalId("logic-condition"), value: "", operator: "and" }],
    });
  };

  const removeLogicCondition = (conditionId: string) => {
    const conditions = selectedNode?.logicBlock?.conditions ?? [];
    updateLogicBlock({
      conditions: conditions.length <= 1
        ? [{ id: newLocalId("logic-condition"), value: "", operator: "and" }]
        : conditions.filter((condition) => condition.id !== conditionId),
    });
  };

  const updateTypedData = (patch: BlueprintTypedData) => {
    if (!selectedNode) return;
    updateSelected({ typedData: { ...(selectedNode.typedData ?? {}), ...patch } });
  };

  const getMountLinks = () => (
    Array.isArray(selectedNode?.typedData?.mountLinks) ? selectedNode.typedData.mountLinks as BlueprintMountLink[] : []
  );

  const updateMountLinks = (links: BlueprintMountLink[]) => updateTypedData({ mountLinks: links });

  const addMountLink = (target: BlueprintDocument) => {
    const links = getMountLinks();
    if (target.id === blueprintId || links.some((link) => link.blueprintId === target.id)) return;
    updateMountLinks([
      ...links,
      {
        id: newLocalId("mount-link"),
        label: target.name,
        blueprintId: target.id,
        blueprintName: target.name,
        kind: "mount",
      },
    ]);
    setMountBlueprintSearch("");
  };

  const createAndMountBlueprint = async () => {
    const name = newMountBlueprintName.trim();
    if (!name) return;
    const created = await createBlueprint(name);
    updateMountLinks([
      ...getMountLinks(),
      {
        id: newLocalId("mount-link"),
        label: created.name,
        blueprintId: created.id,
        blueprintName: created.name,
        kind: "mount",
      },
    ]);
    setNewMountBlueprintName("");
    openBlueprintTab(created.id, created.name);
  };

  const getStringList = (key: keyof BlueprintTypedData) => (
    Array.isArray(selectedNode?.typedData?.[key]) ? selectedNode.typedData?.[key] as string[] : [""]
  );

  const updateStringList = (key: keyof BlueprintTypedData, values: string[]) => updateTypedData({ [key]: values.length ? values : [""] });

  const renderStringListEditor = (key: keyof BlueprintTypedData, label: string, placeholder = label) => {
    const values = getStringList(key);
    return (
      <div className="blueprint-key-block">
        <div className="blueprint-key-block-header">
          <span>{label}</span>
          <button type="button" onClick={() => updateStringList(key, [...values, ""])}>
            <Plus size={13} /> {t("blueprint.add")}
          </button>
        </div>
        {values.map((value, index) => (
          <div key={index} className="blueprint-key-list-row">
            <span>{index + 1}</span>
            {renderSuggestionInput(
              `typed-list-${String(key)}-${index}`,
              "reference",
              value,
              (nextValue) => updateStringList(key, values.map((item, itemIndex) => itemIndex === index ? nextValue : item)),
              placeholder
            )}
            <button type="button" disabled={index === 0} onClick={() => {
              const next = [...values];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              updateStringList(key, next);
            }}>↑</button>
            <button type="button" disabled={index === values.length - 1} onClick={() => {
              const next = [...values];
              [next[index + 1], next[index]] = [next[index], next[index + 1]];
              updateStringList(key, next);
            }}>↓</button>
            <button type="button" onClick={() => updateStringList(key, values.length <= 1 ? [""] : values.filter((_, itemIndex) => itemIndex !== index))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    );
  };

  const getTimelineItems = () => (
    Array.isArray(selectedNode?.typedData?.timelineItems)
      ? selectedNode.typedData.timelineItems
      : [{ id: newLocalId("timeline"), time: "", event: "" }]
  );

  const updateTimelineItems = (timelineItems: NonNullable<BlueprintTypedData["timelineItems"]>) => updateTypedData({ timelineItems });

  const renderTimelineEditor = () => {
    const items = getTimelineItems();
    return (
      <div className="blueprint-key-block">
        <div className="blueprint-key-block-header">
          <span>时间线</span>
          <button type="button" onClick={() => updateTimelineItems([...items, { id: newLocalId("timeline"), time: "", event: "" }])}>
            <Plus size={13} /> {t("blueprint.add")}
          </button>
        </div>
        {items.map((item, index) => (
          <div key={item.id} className="blueprint-timeline-row">
            <span>{index + 1}</span>
            <input value={item.time} placeholder="时间" onChange={(event) => updateTimelineItems(items.map((entry) => entry.id === item.id ? { ...entry, time: event.target.value } : entry))} />
            <input value={item.event} placeholder="事件" onChange={(event) => updateTimelineItems(items.map((entry) => entry.id === item.id ? { ...entry, event: event.target.value } : entry))} />
            <button type="button" disabled={index === 0} onClick={() => {
              const next = [...items];
              [next[index - 1], next[index]] = [next[index], next[index - 1]];
              updateTimelineItems(next);
            }}>↑</button>
            <button type="button" disabled={index === items.length - 1} onClick={() => {
              const next = [...items];
              [next[index + 1], next[index]] = [next[index], next[index + 1]];
              updateTimelineItems(next);
            }}>↓</button>
            <button type="button" onClick={() => updateTimelineItems(items.length <= 1 ? [{ id: newLocalId("timeline"), time: "", event: "" }] : items.filter((entry) => entry.id !== item.id))}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    );
  };

  const updateLogicTree = (logicTree: BlueprintLogicTree) => updateTypedData({ logicTree });

  const updateLogicTreeNode = (tree: BlueprintLogicTree, targetId: string, updater: (node: BlueprintLogicTree) => BlueprintLogicTree): BlueprintLogicTree => {
    if (tree.id === targetId) return updater(tree);
    if (tree.type !== "group") return tree;
    return { ...tree, children: tree.children.map((child) => updateLogicTreeNode(child, targetId, updater)) };
  };

  const addLogicTreeChild = (targetId: string, childType: "condition" | "group" | "compare") => {
    const root = selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because");
    const nextChild: BlueprintLogicTree = childType === "group"
      ? { id: newLocalId("logic-group"), type: "group", operator: "and", children: [{ id: newLocalId("logic-condition"), type: "condition", text: "" }] }
      : childType === "compare"
        ? { id: newLocalId("logic-compare"), type: "compare", left: "", operator: "equals", right: "" }
        : { id: newLocalId("logic-condition"), type: "condition", text: "" };
    updateLogicTree(updateLogicTreeNode(root, targetId, (node) => (
      node.type === "group" ? { ...node, children: [...node.children, nextChild] } : node
    )));
  };

  const removeLogicTreeNode = (tree: BlueprintLogicTree, targetId: string): BlueprintLogicTree => {
    if (tree.type !== "group") return tree;
    const children = tree.children
      .filter((child) => child.id !== targetId)
      .map((child) => removeLogicTreeNode(child, targetId));
    return { ...tree, children: children.length ? children : [{ id: newLocalId("logic-condition"), type: "condition", text: "" }] };
  };

  const updateTemplateFieldInput = (fieldId: string, index: number, value: string) => {
    setTemplateDraft((draft) => ({
      ...draft,
      fields: draft.fields.map((field) => {
        if (field.id !== fieldId) return field;
        const defaultValues = [...ensureFieldValues(field.defaultValues, field.defaultValue ?? "")];
        defaultValues[index] = value;
        return { ...field, defaultValues, defaultValue: defaultValues[0] ?? "" };
      }),
    }));
  };

  const addTemplateFieldInput = (fieldId: string) => {
    setTemplateDraft((draft) => ({
      ...draft,
      fields: draft.fields.map((field) => (
        field.id === fieldId && field.inputMode !== "fixed"
          ? { ...field, defaultValues: [...ensureFieldValues(field.defaultValues, field.defaultValue ?? ""), ""], defaultValue: ensureFieldValues(field.defaultValues, field.defaultValue ?? "")[0] ?? "" }
          : field
      )),
    }));
  };

  const removeTemplateFieldInput = (fieldId: string, index: number) => {
    setTemplateDraft((draft) => ({
      ...draft,
      fields: draft.fields.map((field) => {
        if (field.id !== fieldId) return field;
        if (field.inputMode === "fixed") return field;
        const currentValues = ensureFieldValues(field.defaultValues, field.defaultValue ?? "");
        const nextValues = currentValues.length <= 1 ? [""] : currentValues.filter((_, itemIndex) => itemIndex !== index);
        return { ...field, defaultValues: nextValues, defaultValue: nextValues[0] ?? "" };
      }),
    }));
  };

  const savedTemplate = templates.find((template) => template.id === templateDraft.id);

  const isTemplateFieldKeyLocked = (fieldId: string) => (
    Boolean(savedTemplate?.fields.some((field) => field.id === fieldId))
  );

  const getTemplateBindingField = (bindingKey: BlueprintFieldBindingKey) => (
    templateDraft.fields.find((field) => (field.bindingKey ?? "custom") === bindingKey)
  );

  const getTemplateBindingValues = (bindingKey: BlueprintFieldBindingKey, fallback = "") => {
    const field = getTemplateBindingField(bindingKey);
    return ensureFieldValues(field?.defaultValues, field?.defaultValue ?? fallback);
  };

  const getTemplateBindingValue = (bindingKey: BlueprintFieldBindingKey, fallback = "") => (
    getTemplateBindingValues(bindingKey, fallback)[0] ?? ""
  );

  const setTemplateBindingValues = (
    bindingKey: BlueprintFieldBindingKey,
    key: string,
    values: string[],
    options: Partial<Pick<BlueprintNodeTemplate["fields"][number], "inputMode" | "showInCard">> = {}
  ) => {
    setTemplateDraft((draft) => {
      const defaultValues = ensureFieldValues(values, "");
      const existing = draft.fields.find((field) => (field.bindingKey ?? "custom") === bindingKey);
      const nextField = {
        ...(existing ?? {
          id: newLocalId("template-field"),
          defaultValue: "",
          defaultValues: [""],
        }),
        key,
        bindingKey,
        defaultValue: defaultValues[0] ?? "",
        defaultValues,
        inputMode: options.inputMode ?? existing?.inputMode ?? "repeatable",
        showInCard: options.showInCard ?? existing?.showInCard ?? true,
      };
      return {
        ...draft,
        fields: existing
          ? draft.fields.map((field) => field.id === existing.id ? nextField : field)
          : [...draft.fields, nextField],
      };
    });
  };

  const setTemplateBindingValue = (
    bindingKey: BlueprintFieldBindingKey,
    key: string,
    value: string,
    options: Partial<Pick<BlueprintNodeTemplate["fields"][number], "inputMode" | "showInCard">> = {}
  ) => setTemplateBindingValues(bindingKey, key, [value], { inputMode: "fixed", ...options });

  const addTemplateBindingInput = (bindingKey: BlueprintFieldBindingKey, key: string) => {
    setTemplateBindingValues(bindingKey, key, [...getTemplateBindingValues(bindingKey), ""]);
  };

  const removeTemplateBindingInput = (bindingKey: BlueprintFieldBindingKey, key: string, index: number) => {
    const values = getTemplateBindingValues(bindingKey);
    setTemplateBindingValues(bindingKey, key, values.length <= 1 ? [""] : values.filter((_, itemIndex) => itemIndex !== index));
  };

  const updateTemplateBindingInput = (bindingKey: BlueprintFieldBindingKey, key: string, index: number, value: string) => {
    const values = [...getTemplateBindingValues(bindingKey)];
    values[index] = value;
    setTemplateBindingValues(bindingKey, key, values);
  };

  const getTemplateRowCount = (bindingKeys: BlueprintFieldBindingKey[]) => (
    Math.max(1, ...bindingKeys.map((bindingKey) => getTemplateBindingValues(bindingKey).length))
  );

  const updateStoryTemplateEvent = (index: number, patch: Partial<{ time: string; content: string; foreshadowing: string }>) => {
    if (patch.time !== undefined) updateTemplateBindingInput("storyEventTime", t("blueprint.time"), index, patch.time);
    if (patch.content !== undefined) updateTemplateBindingInput("storyEventContent", t("blueprint.content"), index, patch.content);
    if (patch.foreshadowing !== undefined) updateTemplateBindingInput("storyEventForeshadowing", t("blueprint.foreshadowing"), index, patch.foreshadowing);
  };

  const addStoryTemplateEvent = () => {
    addTemplateBindingInput("storyEventTime", t("blueprint.time"));
    addTemplateBindingInput("storyEventContent", t("blueprint.content"));
    addTemplateBindingInput("storyEventForeshadowing", t("blueprint.foreshadowing"));
  };

  const removeStoryTemplateEvent = (index: number) => {
    removeTemplateBindingInput("storyEventTime", t("blueprint.time"), index);
    removeTemplateBindingInput("storyEventContent", t("blueprint.content"), index);
    removeTemplateBindingInput("storyEventForeshadowing", t("blueprint.foreshadowing"), index);
  };

  const updateCharacterTemplateEvent = (index: number, patch: Partial<{ time: string; story: string; location: string }>) => {
    if (patch.time !== undefined) updateTemplateBindingInput("characterEventTime", t("blueprint.time"), index, patch.time);
    if (patch.story !== undefined) updateTemplateBindingInput("characterEventStory", t("blueprint.storyText"), index, patch.story);
    if (patch.location !== undefined) updateTemplateBindingInput("characterEventLocation", t("blueprint.location"), index, patch.location);
  };

  const addCharacterTemplateEvent = () => {
    addTemplateBindingInput("characterEventTime", t("blueprint.time"));
    addTemplateBindingInput("characterEventStory", t("blueprint.storyText"));
    addTemplateBindingInput("characterEventLocation", t("blueprint.location"));
  };

  const removeCharacterTemplateEvent = (index: number) => {
    removeTemplateBindingInput("characterEventTime", t("blueprint.time"), index);
    removeTemplateBindingInput("characterEventStory", t("blueprint.storyText"), index);
    removeTemplateBindingInput("characterEventLocation", t("blueprint.location"), index);
  };

  const updateTemplateRelationship = (index: number, patch: Partial<{ target: string; description: string }>) => {
    if (patch.target !== undefined) updateTemplateBindingInput("relationshipTarget", t("blueprint.relationshipTarget"), index, patch.target);
    if (patch.description !== undefined) updateTemplateBindingInput("relationshipDescription", t("blueprint.relationshipDescription"), index, patch.description);
  };

  const addTemplateRelationship = () => {
    addTemplateBindingInput("relationshipTarget", t("blueprint.relationshipTarget"));
    addTemplateBindingInput("relationshipDescription", t("blueprint.relationshipDescription"));
  };

  const removeTemplateRelationship = (index: number) => {
    removeTemplateBindingInput("relationshipTarget", t("blueprint.relationshipTarget"), index);
    removeTemplateBindingInput("relationshipDescription", t("blueprint.relationshipDescription"), index);
  };

  const handleSaveBlueprint = async () => {
    if (!blueprint || saveState === "saving") return;
    setSaveState("saving");
    setSaveMessage(t("blueprint.saving"));
    try {
      await saveBlueprint(blueprint);
      setSaveState("saved");
      setSaveMessage(t("blueprint.saved"));
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        setSaveState("idle");
        setSaveMessage("");
      }, 1600);
    } catch (error) {
      setSaveState("error");
      setSaveMessage(error instanceof Error ? error.message : t("blueprint.saveFailed"));
    }
  };

  const handleSaveTemplate = async () => {
    const saved = await saveTemplate(templateDraft);
    if (saved) {
      setTemplateDraft(saved);
    }
  };

  const handleUseTemplate = (templateId: string) => {
    createCustomNodeFromTemplate(blueprintId, templateId, 520, 220);
    setIsTemplateModalOpen(false);
  };

  const handleAutoLayout = () => {
    if (!blueprint || blueprint.nodes.length === 0) return;
    commitBlueprint(autoLayoutBlueprint(blueprint));
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    focusNode(blueprintId, null);
  };

  if (!blueprint) {
    return <div className="blueprint-editor-empty">{t("blueprint.loading")}</div>;
  }

  const drawEdge = (from: BlueprintNode, toX: number, toY: number) => {
    const x1 = from.x + NODE_WIDTH - PORT_ANCHOR_OFFSET;
    const y1 = from.y + NODE_HEIGHT / 2;
    const mid = Math.max(40, Math.abs(toX - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${toX - mid} ${toY}, ${toX} ${toY}`;
  };

  const getEdgeControlPoints = (from: BlueprintNode, to: BlueprintNode) => {
    const x1 = from.x + NODE_WIDTH - PORT_ANCHOR_OFFSET;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x + PORT_ANCHOR_OFFSET;
    const y2 = to.y + NODE_HEIGHT / 2;
    const mid = Math.max(40, Math.abs(x2 - x1) / 2);
    return {
      p0: { x: x1, y: y1 },
      p1: { x: x1 + mid, y: y1 },
      p2: { x: x2 - mid, y: y2 },
      p3: { x: x2, y: y2 },
    };
  };

  const sampleCubic = (points: ReturnType<typeof getEdgeControlPoints>, tValue: number) => {
    const inv = 1 - tValue;
    const x = inv ** 3 * points.p0.x + 3 * inv ** 2 * tValue * points.p1.x + 3 * inv * tValue ** 2 * points.p2.x + tValue ** 3 * points.p3.x;
    const y = inv ** 3 * points.p0.y + 3 * inv ** 2 * tValue * points.p1.y + 3 * inv * tValue ** 2 * points.p2.y + tValue ** 3 * points.p3.y;
    return { x, y };
  };

  const findAvailableNodePosition = (x: number, y: number, excludeNodeId?: string | null) => {
    if (!blueprint) return { x, y };
    const stepX = NODE_WIDTH + NODE_COLLISION_GAP;
    const stepY = NODE_HEIGHT + NODE_COLLISION_GAP;
    const overlaps = (left: number, top: number) => blueprint.nodes.some((node) => {
      if (node.id === excludeNodeId) return false;
      return left < node.x + NODE_WIDTH + NODE_COLLISION_GAP &&
        left + NODE_WIDTH + NODE_COLLISION_GAP > node.x &&
        top < node.y + NODE_HEIGHT + NODE_COLLISION_GAP &&
        top + NODE_HEIGHT + NODE_COLLISION_GAP > node.y;
    });
    for (let radius = 0; radius <= 6; radius += 1) {
      for (let row = 0; row <= radius; row += 1) {
        for (let col = 0; col <= radius; col += 1) {
          const candidates = [
            { x: x + col * stepX, y: y + row * stepY },
            { x: x - col * stepX, y: y + row * stepY },
          ];
          for (const candidate of candidates) {
            if (!overlaps(candidate.x, candidate.y)) return candidate;
          }
        }
      }
    }
    return { x, y };
  };

  const findEdgeInsertCandidate = (nodeId: string, centerX: number, centerY: number): EdgeInsertCandidate => {
    if (!blueprint) return null;
    let best: EdgeInsertCandidate = null;
    for (const edge of blueprint.edges) {
      if (edge.from === nodeId || edge.to === nodeId) continue;
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from || !to) continue;
      const points = getEdgeControlPoints(from, to);
      for (let step = 1; step < EDGE_SAMPLE_STEPS; step += 1) {
        const point = sampleCubic(points, step / EDGE_SAMPLE_STEPS);
        const distance = Math.hypot(centerX - point.x, centerY - point.y);
        if (distance <= EDGE_INSERT_THRESHOLD && (!best || distance < best.distance)) {
          best = { edgeId: edge.id, x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2, distance };
        }
      }
    }
    return best;
  };

  const splitEdgeWithNode = (edgeId: string, nodeId: string, x: number, y: number) => {
    const latestBlueprint = useBlueprintStore.getState().blueprints.find((item) => item.id === blueprintId);
    if (!latestBlueprint) return;
    const edge = latestBlueprint.edges.find((item) => item.id === edgeId);
    if (!edge || edge.from === nodeId || edge.to === nodeId) return;
    const existing = new Set(latestBlueprint.edges.map((item) => `${item.from}->${item.to}`));
    const nextEdges: BlueprintEdge[] = latestBlueprint.edges
      .filter((item) => item.id !== edgeId)
      .concat(
        existing.has(`${edge.from}->${nodeId}`) ? [] : [{ id: newLocalId("edge"), from: edge.from, to: nodeId, role: edge.role }],
        existing.has(`${nodeId}->${edge.to}`) ? [] : [{ id: newLocalId("edge"), from: nodeId, to: edge.to, role: edge.role }]
      );
    replaceBlueprint({
      ...latestBlueprint,
      nodes: latestBlueprint.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node),
      edges: nextEdges,
    });
  };

  const getNodeSummary = (node: BlueprintNode) => {
    const linkedSummary = (node.linkedChapters ?? []).filter(Boolean).slice(0, 2).join(" / ");
    const withLinked = (summary: string) => (
      [linkedSummary ? `${t("blueprint.linkedChapter")}: ${linkedSummary}` : "", summary].filter(Boolean).join(" · ") || t("blueprint.emptyNode")
    );
    const typedData = node.typedData ?? {};
    if (node.nodeType === "chapter") {
      const mounts = Array.isArray(typedData.mountLinks) ? typedData.mountLinks as BlueprintMountLink[] : [];
      const mountSummary = mounts.length > 0
        ? `挂载 ${mounts.length} 个蓝图：${mounts.map((link) => link.blueprintName || link.label).filter(Boolean).slice(0, 2).join(" / ")}`
        : "";
      return withLinked([typedData.summary ? String(typedData.summary) : "", mountSummary].filter(Boolean).join(" · "));
    }
    if (node.nodeType === "linearPlot" || node.nodeType === "nonlinearPlot") {
      const timeline = Array.isArray(typedData.timelineItems) ? typedData.timelineItems.filter((item) => item.time || item.event).slice(0, 2).map((item) => `${item.time} ${item.event}`.trim()).join(" / ") : "";
      const people = Array.isArray(typedData.relatedCharacters) ? typedData.relatedCharacters.filter(Boolean).slice(0, 2).join(" / ") : "";
      return withLinked([typedData.summary ? `梗概 ${typedData.summary}` : "", timeline ? `时间线 ${timeline}` : "", people ? `关联人物 ${people}` : ""].filter(Boolean).join(" · "));
    }
    if (node.nodeType === "loop") {
      const steps = Array.isArray(typedData.loopSteps) ? typedData.loopSteps.filter(Boolean).slice(0, 3).join(" → ") : "";
      return withLinked([typedData.summary ? `梗概 ${typedData.summary}` : "", steps ? `循环 ${steps}` : ""].filter(Boolean).join(" · "));
    }
    if (node.nodeType === "conflict") {
      const pros = Array.isArray(typedData.protagonists) ? typedData.protagonists.filter(Boolean).slice(0, 2).join(" / ") : "";
      const ants = Array.isArray(typedData.antagonists) ? typedData.antagonists.filter(Boolean).slice(0, 2).join(" / ") : "";
      return withLinked([typedData.conflictPoint ? `冲突点 ${typedData.conflictPoint}` : "", pros ? `正派 ${pros}` : "", ants ? `反派 ${ants}` : ""].filter(Boolean).join(" · ") || String(typedData.summary ?? ""));
    }
    if (node.nodeType === "foreshadow") return withLinked([typedData.setup ? `埋设 ${typedData.setup}` : "", typedData.payoff ? `回收 ${typedData.payoff}` : ""].filter(Boolean).join(" · ") || String(typedData.summary ?? ""));
    if (node.nodeType === "reveal") return withLinked(String(typedData.revealContent ?? typedData.summary ?? ""));
    if (node.nodeType === "twist") return withLinked([typedData.twistBefore, typedData.twistAfter].filter(Boolean).join(" → ") || String(typedData.summary ?? ""));
    if (node.layer === "logic" && typedData.logicTree) {
      return withLinked(`${String(typedData.result ?? "") || "所以…"}`);
    }
    if (typedData.summary) return withLinked(String(typedData.summary));
    if (node.presetType === "logicBlock" && node.logicBlock) {
      const because = node.logicBlock.conditions.map((condition) => condition.value).filter(Boolean).slice(0, 3).join(" / ");
      const result = node.logicBlock.result ? `所以 ${node.logicBlock.result}` : "";
      return withLinked([because ? `因为 ${because}` : "", result, node.logicBlock.therefore ? `因此 ${node.logicBlock.therefore}` : ""].filter(Boolean).join(" · "));
    }
    if (node.kind === "story") {
      const firstEvent = node.storyEvents?.find((item) => item.content || item.foreshadowing);
      return withLinked(node.summary || firstEvent?.content || firstEvent?.foreshadowing || "");
    }
    if (node.kind === "character" && linkedSummary) {
      const relationshipCount = node.relationships?.length ?? 0;
      const eventCount = node.characterEvents?.length ?? 0;
      return withLinked([node.characterName, node.identity, relationshipCount ? `${relationshipCount} ${t("blueprint.relationships")}` : "", eventCount ? `${eventCount} ${t("blueprint.characterStories")}` : ""].filter(Boolean).join(" / "));
    }
    if (node.kind === "character") {
      const relationshipCount = node.relationships?.length ?? 0;
      const eventCount = node.characterEvents?.length ?? 0;
      return [node.characterName, node.identity, relationshipCount ? `${relationshipCount} ${t("blueprint.relationships")}` : "", eventCount ? `${eventCount} ${t("blueprint.characterStories")}` : ""].filter(Boolean).join(" · ") || t("blueprint.emptyNode");
    }
    if (linkedSummary) {
      const customSummary = (node.customFields ?? [])
        .filter((field) => field.showInCard !== false)
        .map((field) => (field.values?.length ? field.values : [field.value]).filter(Boolean).join(" / ") || field.key)
        .filter(Boolean)
        .slice(0, 3)
        .join(" / ");
      return withLinked(customSummary);
    }
    return (node.customFields ?? [])
      .filter((field) => field.showInCard !== false)
      .map((field) => (field.values?.length ? field.values : [field.value]).filter(Boolean).join(" / ") || field.key)
      .filter(Boolean)
      .slice(0, 3)
      .join(" · ") || t("blueprint.emptyNode");
  };

  const getNodeLabel = (node: BlueprintNode) => {
    if (node.presetType) return BUILTIN_PRESETS.find((preset) => preset.presetType === node.presetType)?.label ?? t("blueprint.customNode");
    if (node.kind === "story") return t("blueprint.story");
    if (node.kind === "character") return t("blueprint.character");
    return t("blueprint.customNode");
  };

  const getTemplateKindLabel = (kind: BlueprintNodeKind) => {
    if (kind === "story") return t("blueprint.story");
    if (kind === "character") return t("blueprint.character");
    return t("blueprint.customNode");
  };

  const getFieldModeLabel = (mode: BlueprintFieldInputMode | undefined) => (
    mode === "fixed" ? t("blueprint.fixedInputs") : t("blueprint.repeatableInputs")
  );

  const getBindingOptions = (): Array<{ key: BlueprintFieldBindingKey; label: string }> => [
    { key: "custom", label: t("blueprint.binding.custom") },
    { key: "linkedChapters", label: t("blueprint.linkedChapter") },
  ];

  const collectTextFromTipTapNode = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const item = node as { text?: unknown; content?: unknown[] };
    const ownText = typeof item.text === "string" ? item.text : "";
    const childText = Array.isArray(item.content) ? item.content.map(collectTextFromTipTapNode).join("") : "";
    return ownText + childText;
  };

  const extractHeadingTitles = (content: string) => {
    const titles: string[] = [];
    try {
      const parsed = JSON.parse(content) as { content?: unknown[] };
      const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const item = node as { type?: unknown; attrs?: { level?: unknown }; content?: unknown[] };
        if (item.type === "heading" && [1, 2, 3].includes(Number(item.attrs?.level))) {
          const text = collectTextFromTipTapNode(item).trim();
          if (text) titles.push(text);
        }
        if (Array.isArray(item.content)) item.content.forEach(visit);
      };
      if (Array.isArray(parsed.content)) parsed.content.forEach(visit);
    } catch {
      // Non-JSON editor content is handled below.
    }

    for (const match of content.matchAll(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/gis)) {
      const text = match[1]?.replace(/<[^>]+>/g, "").trim();
      if (text) titles.push(text);
    }
    for (const match of content.matchAll(/^#{1,3}\s+(.+)$/gm)) {
      const text = match[1]?.trim();
      if (text) titles.push(text);
    }
    return titles;
  };

  const getChapterTitleFileSuggestions = (value: string) => {
    const query = value.trim().toLowerCase();
    const unique = new Map<string, string>();
    const addSuggestion = (name: string | undefined, label: string) => {
      const trimmed = name?.trim();
      if (!trimmed || unique.has(trimmed)) return;
      if (!query || trimmed.toLowerCase().includes(query)) unique.set(trimmed, label);
    };
    const openTabs = editorGroups.flatMap((group) => group.tabs);
    const documentTabs = openTabs.filter((tab) => ["txt", "markdown", "docx"].includes(tab.fileMode));
    const activeDocumentFile = activeFile && ["txt", "markdown", "docx"].includes(activeFile.fileMode) ? activeFile : null;
    const contents = [
      activeDocumentFile?.content,
      ...documentTabs.map((tab) => tab.content),
    ].filter((content): content is string => Boolean(content));

    addSuggestion(activeDocumentFile?.name, "文件");
    for (const name of collectWorkspaceDocumentNames(files)) addSuggestion(name, "文件");
    for (const tab of documentTabs) addSuggestion(tab.name, "文件");
    for (const content of contents) {
      for (const title of extractHeadingTitles(content)) addSuggestion(title, "标题");
    }
    return [...unique.entries()].slice(0, 8);
  };

  const getReferenceKeySuggestions = (value: string) => {
    const query = value.trim().toLowerCase();
    const unique = new Map<string, string>();
    for (const entry of referenceEntries) {
      const name = entry.name.trim();
      if (!name || unique.has(name)) continue;
      const lower = name.toLowerCase();
      if (!query || lower.includes(query)) {
        unique.set(name, entry.description ?? entry.sourceList ?? "");
      }
    }
    return [...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 8);
  };

  const updateSuggestionPlacement = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const desiredHeight = 210;
    const spaceBelow = window.innerHeight - rect.bottom - FLOATING_EDGE_PADDING;
    const spaceAbove = rect.top - FLOATING_EDGE_PADDING;
    setSuggestionPlacement(spaceBelow < desiredHeight && spaceAbove > spaceBelow ? "top" : "bottom");
  };

  const renderSuggestionInput = (
    id: string,
    kind: BlueprintSuggestionKind,
    value: string,
    onChange: (value: string) => void,
    placeholder = t("blueprint.templateInputPlaceholder"),
    multiline = false
  ) => {
    const suggestions = kind === "reference"
      ? getReferenceKeySuggestions(value)
      : getChapterTitleFileSuggestions(value);
    const isActive = activeSuggestionInput?.id === id && activeSuggestionInput.kind === kind;
    const field = multiline ? (
      <textarea
        value={value}
        placeholder={placeholder}
        onFocus={(event) => {
          updateSuggestionPlacement(event.currentTarget);
          setActiveSuggestionInput({ id, kind });
        }}
        onBlur={() => window.setTimeout(() => setActiveSuggestionInput(null), 120)}
        onChange={(event) => {
          onChange(event.target.value);
          updateSuggestionPlacement(event.currentTarget);
          setActiveSuggestionInput({ id, kind });
        }}
      />
    ) : (
      <input
        value={value}
        placeholder={placeholder}
        onFocus={(event) => {
          updateSuggestionPlacement(event.currentTarget);
          setActiveSuggestionInput({ id, kind });
        }}
        onBlur={() => window.setTimeout(() => setActiveSuggestionInput(null), 120)}
        onChange={(event) => {
          onChange(event.target.value);
          updateSuggestionPlacement(event.currentTarget);
          setActiveSuggestionInput({ id, kind });
        }}
      />
    );
    return (
      <div className="blueprint-template-key-input-cell">
        {field}
        {isActive && suggestions.length > 0 && (
          <div className={`blueprint-template-key-suggestions ${suggestionPlacement}`}>
            {suggestions.map(([name, description]) => (
              <button
                key={`${id}-${name}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(name);
                  setActiveSuggestionInput(null);
                }}
              >
                <strong>{name}</strong>
                {description && <span>{description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderChapterSuggestionInput = (
    scope: string,
    index: number,
    value: string,
    onChange: (value: string) => void,
    placeholder = t("blueprint.templateInputPlaceholder")
  ) => renderSuggestionInput(`${scope}-${index}`, "chapterTitleFile", value, onChange, placeholder);

  const renderReferenceTextarea = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder = label
  ) => (
    <label>
      <span>{label}</span>
      {renderSuggestionInput(id, "reference", value, onChange, placeholder, true)}
    </label>
  );

  const renderPaletteIcon = (kind: BlueprintNodeKind) => {
    if (kind === "story") return <GitBranch size={15} />;
    if (kind === "character") return <UserRound size={15} />;
    return <Settings2 size={15} />;
  };

  const renderCreateItemButtonLegacy = (item: BlueprintPaletteItem, onSelect: (item: BlueprintPaletteItem) => void) => (
    <button key={item.id} type="button" onClick={() => onSelect(item)}>
      {renderPaletteIcon(item.kind)}
      <span>{item.label}</span>
    </button>
  );

  const renderCreateItemsLegacy = (onSelect: (item: BlueprintPaletteItem) => void) => {
    const templateItems = paletteItems.filter((item) => item.type === "template");
    return (
      <>
        {BUILTIN_NODE_GROUPS.map((group) => {
          const groupItems = paletteItems.filter((item) => item.type === "preset" && item.layer === group.layer);
          return (
            <div key={group.layer} className="blueprint-create-group">
              <span>{group.label}</span>
              {groupItems.map((item) => renderCreateItemButtonLegacy(item, onSelect))}
            </div>
          );
        })}
        <div className="blueprint-create-group">
          <span>基础节点</span>
          {paletteItems.filter((item) => item.type === "base").map((item) => renderCreateItemButtonLegacy(item, onSelect))}
        </div>
        {templateItems.length > 0 && (
          <div className="blueprint-create-group">
            <span>{t("blueprint.templates")}</span>
            {templateItems.map((item) => renderCreateItemButtonLegacy(item, onSelect))}
          </div>
        )}
      </>
    );
  };

  void renderCreateItemsLegacy;

  const renderCreateItems = (onSelect: (item: BlueprintPaletteItem) => void) => {
    const query = createSearch.trim().toLowerCase();
    const searchableItems = paletteItems.filter((item): item is Extract<BlueprintPaletteItem, { type: "preset" }> => (
      item.type === "preset" &&
      item.layer === createLayer &&
      (!query || item.label.toLowerCase().includes(query) || item.summary.toLowerCase().includes(query))
    ));
    return (
      <div className="blueprint-create-picker">
        <div className="blueprint-create-search">
          <input value={createSearch} placeholder="搜索节点" onChange={(event) => setCreateSearch(event.target.value)} />
        </div>
        <div className="blueprint-create-layers">
          {BUILTIN_NODE_GROUPS
            .filter((group) => paletteItems.some((item) => item.type === "preset" && item.layer === group.layer))
            .map((group) => (
              <button
                key={group.layer}
                type="button"
                className={createLayer === group.layer ? "active" : ""}
                onClick={() => {
                  setCreateLayer(group.layer);
                  setActiveCreateItemId(null);
                }}
              >
                {group.label}
              </button>
            ))}
        </div>
        <div className="blueprint-create-items">
          {searchableItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeCreateItemId === item.id ? "active" : ""}
              onMouseEnter={() => setActiveCreateItemId(item.id)}
              onFocus={() => setActiveCreateItemId(item.id)}
              onClick={() => onSelect(item)}
              title={item.summary}
            >
              {renderPaletteIcon(item.kind)}
              <span>
                <strong>{item.label}</strong>
                <small>{item.summary}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="blueprint-create-detail" hidden>
          {false ? (
            <>
              <strong />
              <p />
              <button type="button" onClick={() => undefined}>
                <Plus size={14} /> 创建节点
              </button>
            </>
          ) : (
            <p>没有匹配的节点</p>
          )}
        </div>
      </div>
    );
  };

  const renderCustomFieldsSection = () => {
    if (!selectedNode) return null;
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>{t("blueprint.configManagement")}</span>
          <button type="button" onClick={() => updateSelected({ customFields: [...(selectedNode.customFields ?? []), { id: newLocalId("field"), key: "", value: "", values: [""], inputMode: "repeatable", bindingKey: "custom", showInCard: true }] })}>
            <Plus size={13} /> {t("blueprint.add")}
          </button>
        </div>
        {(selectedNode.customFields ?? []).map((field) => {
          const values = ensureFieldValues(field.values, field.value ?? "");
          const isFixed = field.inputMode === "fixed";
          return (
            <div key={field.id} className="blueprint-detail-card custom-field">
              <div className="blueprint-detail-card-header custom-field-header">
                {renderSuggestionInput(
                  `node-field-key-${field.id}`,
                  "reference",
                  field.key,
                  (value) => updateCustomField(field.id, { key: value }),
                  t("blueprint.fieldKey")
                )}
                <button type="button" onClick={() => updateSelected({ customFields: (selectedNode.customFields ?? []).filter((item) => item.id !== field.id) })}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="blueprint-field-inputs">
                {values.map((value, index) => (
                  <div key={index} className={`blueprint-field-input-row ${isFixed ? "fixed" : ""}`}>
                    {renderSuggestionInput(
                      `node-field-value-${field.id}-${index}`,
                      "reference",
                      value,
                      (nextValue) => updateCustomFieldInput(field.id, index, nextValue),
                      `${t("blueprint.input")} ${index + 1}`
                    )}
                    {!isFixed && (
                      <>
                        <button type="button" onClick={() => removeCustomFieldInput(field.id, index)} title={t("blueprint.removeInput")}>
                          <Minus size={13} />
                        </button>
                        {index === values.length - 1 && (
                          <button type="button" onClick={() => addCustomFieldInput(field.id)} title={t("blueprint.addInput")}>
                            <Plus size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderNodeLinkedChaptersSection = () => {
    if (!selectedNode) return null;
    const linkedChapters = selectedNode.linkedChapters?.length ? selectedNode.linkedChapters : [""];
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>{t("blueprint.linkedChapter")}</span>
          <button type="button" onClick={() => updateSelected({ linkedChapters: [...linkedChapters, ""] })}>
            <Plus size={13} /> {t("blueprint.add")}
          </button>
        </div>
        {linkedChapters.map((chapter, index) => (
          <div key={index} className="blueprint-inline-row single">
            {renderChapterSuggestionInput("node", index, chapter, (value) => updateChapter(index, value), t("blueprint.linkedChapter"))}
            <button type="button" onClick={() => updateSelected({ linkedChapters: linkedChapters.filter((_, itemIndex) => itemIndex !== index) })}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    );
  };

  const renderLogicBlockSection = () => {
    if (!selectedNode || selectedNode.presetType !== "logicBlock") return null;
    const logicBlock = selectedNode.logicBlock ?? {
      conditions: [{ id: newLocalId("logic-condition"), value: "", operator: "and" as const }],
      result: "",
      therefore: "",
    };
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>因为</span>
          <button type="button" onClick={addLogicCondition}>
            <Plus size={13} /> {t("blueprint.add")}
          </button>
        </div>
        {logicBlock.conditions.map((condition, index) => (
          <div key={condition.id} className="blueprint-logic-condition-row">
            <input value={condition.value} placeholder={`${t("blueprint.input")} ${index + 1}`} onChange={(event) => updateLogicCondition(condition.id, { value: event.target.value })} />
            <select value={condition.operator ?? "and"} onChange={(event) => updateLogicCondition(condition.id, { operator: event.target.value as NonNullable<typeof condition.operator> })}>
              <option value="and">且</option>
              <option value="or">或</option>
              <option value="equals">等于</option>
              <option value="notEquals">不等于</option>
            </select>
            <button type="button" onClick={() => removeLogicCondition(condition.id)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <label>
          <span>所以</span>
          <textarea value={logicBlock.result} onChange={(event) => updateLogicBlock({ result: event.target.value })} />
        </label>
        <label>
          <span>因此（可选）</span>
          <textarea value={logicBlock.therefore ?? ""} onChange={(event) => updateLogicBlock({ therefore: event.target.value })} />
        </label>
      </div>
    );
  };

  const renderParentChapterSection = () => {
    if (!selectedNode || false) return null;
    const chapters = blueprint.nodes.filter((node) => node.presetType === "chapter");
    return (
      <label>
        <span>所属章节</span>
        <select value={selectedNode.parentChapterId ?? ""} onChange={(event) => updateSelected({ parentChapterId: event.target.value || undefined })}>
          <option value="">未绑定</option>
          {chapters.map((chapter) => (
            <option key={chapter.id} value={chapter.id}>
              {chapter.title || chapter.templateName || "章节"}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const renderLogicTreeEditor = (tree: BlueprintLogicTree, isRoot = false): React.ReactNode => (
    <div className={`blueprint-logic-tree-node ${tree.type}`}>
      {tree.type === "condition" && (
        <div className="blueprint-logic-condition-row">
          <input value={tree.text} placeholder="条件" onChange={(event) => updateLogicTree(updateLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id, (node) => node.type === "condition" ? { ...node, text: event.target.value } : node))} />
          <span>条件</span>
          {!isRoot && <button type="button" onClick={() => updateLogicTree(removeLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id))}><Trash2 size={13} /></button>}
        </div>
      )}
      {tree.type === "compare" && (
        <div className="blueprint-logic-compare-row">
          <input value={tree.left} placeholder="1" onChange={(event) => updateLogicTree(updateLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id, (node) => node.type === "compare" ? { ...node, left: event.target.value } : node))} />
          <select value={tree.operator} onChange={(event) => updateLogicTree(updateLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id, (node) => node.type === "compare" ? { ...node, operator: event.target.value as BlueprintLogicCompareOperator } : node))}>
            <option value="equals">=</option>
            <option value="notEquals">≠</option>
            <option value="greaterThan">&gt;</option>
            <option value="lessThan">&lt;</option>
          </select>
          <input value={tree.right} placeholder="2" onChange={(event) => updateLogicTree(updateLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id, (node) => node.type === "compare" ? { ...node, right: event.target.value } : node))} />
          {!isRoot && <button type="button" onClick={() => updateLogicTree(removeLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id))}><Trash2 size={13} /></button>}
        </div>
      )}
      {tree.type === "group" && (
        <>
          <div className="blueprint-logic-group-header">
            <select value={tree.operator} onChange={(event) => updateLogicTree(updateLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id, (node) => node.type === "group" ? { ...node, operator: event.target.value as "and" | "or" } : node))}>
              <option value="and">AND</option>
              <option value="or">OR</option>
            </select>
            <button type="button" onClick={() => addLogicTreeChild(tree.id, "condition")}>条件</button>
            <button type="button" onClick={() => addLogicTreeChild(tree.id, "group")}>组</button>
            <button type="button" onClick={() => addLogicTreeChild(tree.id, "compare")}>比较</button>
            {!isRoot && <button type="button" onClick={() => updateLogicTree(removeLogicTreeNode(selectedNode?.typedData?.logicTree ?? createDefaultLogicTree(selectedNode?.nodeType ?? "because"), tree.id))}><Trash2 size={13} /></button>}
          </div>
          <div className="blueprint-logic-tree-children">
            {tree.children.map((child) => <div key={child.id}>{renderLogicTreeEditor(child)}</div>)}
          </div>
        </>
      )}
    </div>
  );

  const renderTypedDataSectionLegacy = () => {
    if (!selectedNode?.layer || !selectedNode.nodeType) return null;
    const data = selectedNode.typedData ?? {};
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>{selectedNode.layer} · {selectedNode.nodeType}</span>
        </div>
        <label>
          <span>{t("blueprint.summary")}</span>
          {renderSuggestionInput(
            `typed-summary-${selectedNode.id}`,
            "reference",
            String(data.summary ?? ""),
            (value) => updateTypedData({ summary: value }),
            t("blueprint.summary"),
            true
          )}
        </label>
        {(selectedNode.layer === "story" || selectedNode.layer === "narrative") && renderStringListEditor("relatedCharacters", "关联人物", "人物 / 角色")}
        {(selectedNode.nodeType === "linearPlot" || selectedNode.nodeType === "nonlinearPlot") && renderTimelineEditor()}
        {false && (
          <>
            <label><span>循环名称</span><input value={String(data.loopName ?? "")} onChange={(event) => updateTypedData({ loopName: event.target.value })} /></label>
            {renderStringListEditor("loopSteps", "循环节点/步骤", "剧情步骤")}
            {renderStringListEditor("relatedCharacters", "关联人物", "人物 / 角色")}
          </>
        )}
        {selectedNode.nodeType === "conflict" && (
          <>
            <label><span>冲突点</span><textarea value={String(data.conflictPoint ?? "")} onChange={(event) => updateTypedData({ conflictPoint: event.target.value })} /></label>
            {renderStringListEditor("protagonists", "正派", "正派角色")}
            <div className="blueprint-vs-divider">VS</div>
            {renderStringListEditor("antagonists", "反派", "反派角色")}
          </>
        )}
        {selectedNode.nodeType === "hook" && (
          <label><span>读者好奇心</span><textarea value={String(data.curiosity ?? "")} onChange={(event) => updateTypedData({ curiosity: event.target.value })} /></label>
        )}
        {false && (
          <>
            <label><span>循环类型</span><select value={String(data.loopMode ?? "condition")} onChange={(event) => updateTypedData({ loopMode: event.target.value as BlueprintTypedData["loopMode"] })}><option value="count">次数循环</option><option value="condition">条件循环</option><option value="infinite">无限循环</option></select></label>
            <label><span>次数</span><input type="number" min={1} value={Number(data.loopCount ?? 3)} onChange={(event) => updateTypedData({ loopCount: Math.max(1, Number(event.target.value) || 1) })} /></label>
            <label><span>直到</span><input value={String(data.loopUntil ?? "")} onChange={(event) => updateTypedData({ loopUntil: event.target.value })} /></label>
          </>
        )}
        {false && (
          <>
            <label><span>目标</span><textarea value={String(data.conflictGoal ?? "")} onChange={(event) => updateTypedData({ conflictGoal: event.target.value })} /></label>
            <label><span>阻碍</span><textarea value={String(data.conflictObstacle ?? "")} onChange={(event) => updateTypedData({ conflictObstacle: event.target.value })} /></label>
          </>
        )}
        {selectedNode.nodeType === "foreshadow" && (
          <>
            <label><span>埋设</span><textarea value={String(data.setup ?? "")} onChange={(event) => updateTypedData({ setup: event.target.value })} /></label>
            <label><span>回收</span><textarea value={String(data.payoff ?? "")} onChange={(event) => updateTypedData({ payoff: event.target.value })} /></label>
          </>
        )}
        {selectedNode.nodeType === "reveal" && (
          <label><span>揭露内容</span><textarea value={String(data.revealContent ?? "")} onChange={(event) => updateTypedData({ revealContent: event.target.value })} /></label>
        )}
        {selectedNode.nodeType === "twist" && (
          <>
            <label><span>反转前</span><textarea value={String(data.twistBefore ?? "")} onChange={(event) => updateTypedData({ twistBefore: event.target.value })} /></label>
            <label><span>反转后</span><textarea value={String(data.twistAfter ?? "")} onChange={(event) => updateTypedData({ twistAfter: event.target.value })} /></label>
          </>
        )}
        {selectedNode.layer === "logic" && (
          <>
            {renderLogicTreeEditor(data.logicTree ?? createDefaultLogicTree(selectedNode.nodeType), true)}
            <label><span>所以</span><textarea value={String(data.result ?? "")} onChange={(event) => updateTypedData({ result: event.target.value })} /></label>
            <label><span>因此（可选）</span><textarea value={String(data.therefore ?? "")} onChange={(event) => updateTypedData({ therefore: event.target.value })} /></label>
          </>
        )}
      </div>
    );
  };

  void renderTypedDataSectionLegacy;

  const renderTypedDataSection = () => {
    if (!selectedNode?.layer || !selectedNode.nodeType) return null;
    const data = selectedNode.typedData ?? {};
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>{selectedNode.layer} · {selectedNode.nodeType}</span>
        </div>
        {renderReferenceTextarea(
          `typed-summary-${selectedNode.id}`,
          t("blueprint.summary"),
          String(data.summary ?? ""),
          (value) => updateTypedData({ summary: value })
        )}
        {(selectedNode.layer === "story" || selectedNode.layer === "narrative") && renderStringListEditor("relatedCharacters", "关联人物", "人物 / 角色")}
        {(selectedNode.nodeType === "linearPlot" || selectedNode.nodeType === "nonlinearPlot") && renderTimelineEditor()}
        {selectedNode.nodeType === "conflict" && (
          <>
            {renderReferenceTextarea(`typed-conflict-point-${selectedNode.id}`, "冲突点", String(data.conflictPoint ?? ""), (value) => updateTypedData({ conflictPoint: value }))}
            {renderStringListEditor("protagonists", "正派", "正派角色")}
            <div className="blueprint-vs-divider">VS</div>
            {renderStringListEditor("antagonists", "反派", "反派角色")}
          </>
        )}
        {selectedNode.nodeType === "hook" && (
          renderReferenceTextarea(`typed-curiosity-${selectedNode.id}`, "读者好奇心", String(data.curiosity ?? ""), (value) => updateTypedData({ curiosity: value }))
        )}
        {selectedNode.nodeType === "foreshadow" && (
          <>
            {renderReferenceTextarea(`typed-setup-${selectedNode.id}`, "埋设", String(data.setup ?? ""), (value) => updateTypedData({ setup: value }))}
            {renderReferenceTextarea(`typed-payoff-${selectedNode.id}`, "回收", String(data.payoff ?? ""), (value) => updateTypedData({ payoff: value }))}
          </>
        )}
        {selectedNode.nodeType === "reveal" && (
          renderReferenceTextarea(`typed-reveal-${selectedNode.id}`, "揭露内容", String(data.revealContent ?? ""), (value) => updateTypedData({ revealContent: value }))
        )}
        {selectedNode.nodeType === "twist" && (
          <>
            {renderReferenceTextarea(`typed-twist-before-${selectedNode.id}`, "反转前", String(data.twistBefore ?? ""), (value) => updateTypedData({ twistBefore: value }))}
            {renderReferenceTextarea(`typed-twist-after-${selectedNode.id}`, "反转后", String(data.twistAfter ?? ""), (value) => updateTypedData({ twistAfter: value }))}
          </>
        )}
        {selectedNode.layer === "logic" && (
          <>
            {renderLogicTreeEditor(data.logicTree ?? createDefaultLogicTree(selectedNode.nodeType), true)}
            {renderReferenceTextarea(`typed-result-${selectedNode.id}`, "所以", String(data.result ?? ""), (value) => updateTypedData({ result: value }))}
            {renderReferenceTextarea(`typed-therefore-${selectedNode.id}`, "因此（可选）", String(data.therefore ?? ""), (value) => updateTypedData({ therefore: value }))}
          </>
        )}
      </div>
    );
  };

  const renderMountLinksSection = () => {
    if (!selectedNode || selectedNode.nodeType !== "chapter") return null;
    const links = getMountLinks();
    const query = mountBlueprintSearch.trim().toLowerCase();
    const linkedIds = new Set(links.map((link) => link.blueprintId));
    const candidates = blueprints.filter((item) => (
      item.id !== blueprintId &&
      !linkedIds.has(item.id) &&
      (!query || item.name.toLowerCase().includes(query))
    )).slice(0, 8);
    return (
      <div className="blueprint-field-group blueprint-mount-links">
        <div className="blueprint-field-header">
          <span>挂载蓝图</span>
        </div>
        <div className="blueprint-mount-link-create">
          <input
            value={mountBlueprintSearch}
            placeholder="搜索已有蓝图"
            onChange={(event) => setMountBlueprintSearch(event.target.value)}
          />
          <div className="blueprint-mount-candidates">
            {candidates.map((candidate) => (
              <button key={candidate.id} type="button" onClick={() => addMountLink(candidate)}>
                <GitBranch size={13} />
                <span>{candidate.name}</span>
              </button>
            ))}
            {mountBlueprintSearch.trim() && candidates.length === 0 && <span>没有匹配的蓝图</span>}
          </div>
        </div>
        <div className="blueprint-mount-link-create new">
          <input
            value={newMountBlueprintName}
            placeholder="新建蓝图名称"
            onChange={(event) => setNewMountBlueprintName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createAndMountBlueprint();
            }}
          />
          <button type="button" onClick={() => void createAndMountBlueprint()} disabled={!newMountBlueprintName.trim()}>
            <Plus size={13} /> 新建并挂载
          </button>
        </div>
        <div className="blueprint-mount-link-list">
          {links.length === 0 && <span className="blueprint-mount-empty">暂无挂载蓝图</span>}
          {links.map((link) => {
            const target = blueprints.find((item) => item.id === link.blueprintId);
            const title = target?.name ?? link.blueprintName ?? link.label;
            return (
              <article key={link.id} className={`blueprint-mount-link-card ${target ? "" : "missing"}`}>
                <button
                  type="button"
                  className="blueprint-mount-link-main"
                  disabled={!target}
                  onClick={() => target && openBlueprintTab(target.id, target.name)}
                >
                  <GitBranch size={14} />
                  <span>{target ? title : `${title || "蓝图"} 不存在`}</span>
                  <small>{link.kind === "loop" ? "循环蓝图" : "挂载蓝图"}</small>
                </button>
                <button
                  type="button"
                  onClick={() => updateMountLinks(links.filter((item) => item.id !== link.id))}
                  title="移除绑定"
                >
                  <Trash2 size={13} />
                </button>
              </article>
            );
          })}
        </div>
      </div>
    );
  };

  const renderChildBlueprintSection = () => {
    if (!selectedNode || selectedNode.nodeType !== "logicBlueprint") return null;
    const childBlueprint = selectedNode.typedData?.childBlueprint ?? createChildBlueprint(selectedNode.title || "子蓝图");
    return (
      <div className="blueprint-field-group">
        <div className="blueprint-field-header">
          <span>子蓝图</span>
          <button type="button" onClick={() => {
            if (!selectedNode.typedData?.childBlueprint) updateTypedData({ childBlueprint });
            setActiveChildNodeId(selectedNode.id);
          }}>
            进入子蓝图
          </button>
        </div>
        <div className="blueprint-child-strip">
          <span>输入/输出</span>
          <strong>开始</strong>
          <span>子蓝图内容</span>
          <strong>结束</strong>
        </div>
      </div>
    );
  };

  void renderCustomFieldsSection;

  const renderTemplateFieldsSection = () => (
    <div className="blueprint-field-group">
      <div className="blueprint-field-header">
        <span>{t("blueprint.configManagement")}</span>
        <button type="button" onClick={() => setTemplateDraft((draft) => ({ ...draft, fields: [...draft.fields, newTemplateField()] }))}>
          <Plus size={13} /> {t("blueprint.add")}
        </button>
      </div>
      {templateDraft.fields.map((field) => {
        const values = ensureFieldValues(field.defaultValues, field.defaultValue ?? "");
        const isFixed = field.inputMode === "fixed";
        const bindingOptions = getBindingOptions();
        const isKeyLocked = isTemplateFieldKeyLocked(field.id);
        const fieldBindingKey = field.bindingKey ?? "custom";
        const fieldSuggestionKind: BlueprintSuggestionKind | null = fieldBindingKey === "custom"
          ? "reference"
          : fieldBindingKey === "title" || fieldBindingKey === "linkedChapters"
            ? "chapterTitleFile"
            : null;
        return (
          <div key={field.id} className="blueprint-detail-card custom-field template-field">
            <div className="blueprint-template-field-row top">
              <input
                className={isKeyLocked ? "blueprint-template-field-key locked" : "blueprint-template-field-key"}
                value={field.key}
                placeholder={t("blueprint.fieldKey")}
                readOnly={isKeyLocked}
                onChange={(event) => setTemplateDraft((draft) => ({
                  ...draft,
                  fields: draft.fields.map((item) => item.id === field.id ? { ...item, key: event.target.value } : item),
                }))}
              />
              <select value={field.bindingKey ?? "custom"} onChange={(event) => setTemplateDraft((draft) => ({
                ...draft,
                fields: draft.fields.map((item) => item.id === field.id ? { ...item, bindingKey: event.target.value as BlueprintFieldBindingKey } : item),
              }))}>
                {bindingOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
              <button type="button" onClick={() => setTemplateDraft((draft) => ({ ...draft, fields: draft.fields.filter((item) => item.id !== field.id) }))}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="blueprint-field-inputs">
              {values.map((value, index) => (
                <div key={index} className={`blueprint-template-field-row input ${isFixed ? "fixed" : ""}`}>
                  <div className="blueprint-template-key-input-cell">
                    {fieldSuggestionKind
                      ? renderSuggestionInput(
                          `template-field-value-${field.id}-${index}`,
                          fieldSuggestionKind,
                          value,
                          (nextValue) => updateTemplateFieldInput(field.id, index, nextValue),
                          t("blueprint.templateInputPlaceholder")
                        )
                      : (
                          <input
                            value={value}
                            placeholder={t("blueprint.templateInputPlaceholder")}
                            onChange={(event) => updateTemplateFieldInput(field.id, index, event.target.value)}
                          />
                        )}
                  </div>
                  {!isFixed && (
                    <>
                      <button type="button" onClick={() => removeTemplateFieldInput(field.id, index)} title={t("blueprint.removeInput")}>
                        <Minus size={13} />
                      </button>
                      {index === values.length - 1 && (
                        <button type="button" onClick={() => addTemplateFieldInput(field.id)} title={t("blueprint.addInput")}>
                          <Plus size={13} />
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
            <div className="blueprint-template-field-settings-row">
            <button type="button" className="blueprint-field-settings-button" onClick={() => setTemplateDraft((draft) => ({
              ...draft,
              fields: draft.fields.map((item) => item.id === field.id ? { ...item, inputMode: nextFieldMode(item.inputMode) } : item),
            }))} title={t("blueprint.fieldSettings")}>
              <Settings2 size={13} /> {t("blueprint.settings")} · {getFieldModeLabel(field.inputMode)}
            </button>
            <label className="blueprint-template-field-visible">
              <input type="checkbox" checked={field.showInCard ?? true} onChange={(event) => setTemplateDraft((draft) => ({
                ...draft,
                fields: draft.fields.map((item) => item.id === field.id ? { ...item, showInCard: event.target.checked } : item),
              }))} />
              {t("blueprint.showInCard")}
            </label>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderStoryTemplateFieldsSection = () => {
    const linkedChapters = getTemplateBindingValues("linkedChapters");
    const storyEventCount = getTemplateRowCount(["storyEventTime", "storyEventContent", "storyEventForeshadowing"]);
    const storyEventTimes = getTemplateBindingValues("storyEventTime");
    const storyEventContents = getTemplateBindingValues("storyEventContent");
    const storyEventForeshadowings = getTemplateBindingValues("storyEventForeshadowing");
    return (
      <div className="blueprint-template-builtins">
        <label>
          <span>{t("blueprint.nodeTitle")}</span>
          {renderSuggestionInput(
            "template-story-title",
            "chapterTitleFile",
            getTemplateBindingValue("title"),
            (value) => setTemplateBindingValue("title", t("blueprint.nodeTitle"), value),
            t("blueprint.nodeTitle")
          )}
        </label>
        <label>
          <span>{t("blueprint.storyType.label")}</span>
          <select value={getTemplateBindingValue("storyType", "custom")} onChange={(event) => setTemplateBindingValue("storyType", t("blueprint.storyType.label"), event.target.value)}>
            <option value="custom">{t("blueprint.storyType.custom")}</option>
            <option value="start">{t("blueprint.storyType.start")}</option>
            <option value="ending">{t("blueprint.storyType.ending")}</option>
          </select>
        </label>
        <label>
          <span>{t("blueprint.summary")}</span>
          <textarea value={getTemplateBindingValue("summary")} placeholder={t("blueprint.templateInputPlaceholder")} onChange={(event) => setTemplateBindingValue("summary", t("blueprint.summary"), event.target.value)} />
        </label>
        <div className="blueprint-field-group">
          <div className="blueprint-field-header">
            <span>{t("blueprint.linkedChapter")}</span>
            <button type="button" onClick={() => addTemplateBindingInput("linkedChapters", t("blueprint.linkedChapter"))}>
              <Plus size={13} /> {t("blueprint.add")}
            </button>
          </div>
          {linkedChapters.map((chapter, index) => (
            <div key={index} className="blueprint-template-inline-row">
              {renderChapterSuggestionInput(
                "template",
                index,
                chapter,
                (value) => updateTemplateBindingInput("linkedChapters", t("blueprint.linkedChapter"), index, value),
                t("blueprint.linkedChapter")
              )}
              <button type="button" onClick={() => removeTemplateBindingInput("linkedChapters", t("blueprint.linkedChapter"), index)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="blueprint-field-group">
          <div className="blueprint-field-header">
            <span>{t("blueprint.storyEvents")}</span>
            <button type="button" onClick={addStoryTemplateEvent}>
              <Plus size={13} /> {t("blueprint.add")}
            </button>
          </div>
          {Array.from({ length: storyEventCount }).map((_, index) => (
            <div key={index} className="blueprint-detail-card story-event template-builtin-card">
              <div className="blueprint-detail-card-header custom-field-header">
                <input value={storyEventTimes[index] ?? ""} placeholder={t("blueprint.time")} onChange={(event) => updateStoryTemplateEvent(index, { time: event.target.value })} />
                <button type="button" onClick={() => removeStoryTemplateEvent(index)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea className="blueprint-detail-textarea" value={storyEventContents[index] ?? ""} placeholder={t("blueprint.content")} onChange={(event) => updateStoryTemplateEvent(index, { content: event.target.value })} />
              <textarea className="blueprint-detail-textarea" value={storyEventForeshadowings[index] ?? ""} placeholder={t("blueprint.foreshadowing")} onChange={(event) => updateStoryTemplateEvent(index, { foreshadowing: event.target.value })} />
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderCharacterTemplateFieldsSection = () => {
    const characterEventCount = getTemplateRowCount(["characterEventTime", "characterEventStory", "characterEventLocation"]);
    const characterEventTimes = getTemplateBindingValues("characterEventTime");
    const characterEventStories = getTemplateBindingValues("characterEventStory");
    const characterEventLocations = getTemplateBindingValues("characterEventLocation");
    const relationshipCount = getTemplateRowCount(["relationshipTarget", "relationshipDescription"]);
    const relationshipTargets = getTemplateBindingValues("relationshipTarget");
    const relationshipDescriptions = getTemplateBindingValues("relationshipDescription");
    return (
      <div className="blueprint-template-builtins">
        <label>
          <span>{t("blueprint.nodeTitle")}</span>
          {renderSuggestionInput(
            "template-character-title",
            "chapterTitleFile",
            getTemplateBindingValue("title"),
            (value) => setTemplateBindingValue("title", t("blueprint.nodeTitle"), value),
            t("blueprint.nodeTitle")
          )}
        </label>
        <label>
          <span>{t("blueprint.characterName")}</span>
          <input value={getTemplateBindingValue("characterName")} placeholder={t("blueprint.templateInputPlaceholder")} onChange={(event) => setTemplateBindingValue("characterName", t("blueprint.characterName"), event.target.value)} />
        </label>
        <label>
          <span>{t("blueprint.identity")}</span>
          <input value={getTemplateBindingValue("identity")} placeholder={t("blueprint.templateInputPlaceholder")} onChange={(event) => setTemplateBindingValue("identity", t("blueprint.identity"), event.target.value)} />
        </label>
        <div className="blueprint-field-group">
          <div className="blueprint-field-header">
            <span>{t("blueprint.characterStories")}</span>
            <button type="button" onClick={addCharacterTemplateEvent}>
              <Plus size={13} /> {t("blueprint.add")}
            </button>
          </div>
          {Array.from({ length: characterEventCount }).map((_, index) => (
            <div key={index} className="blueprint-detail-card character-event template-builtin-card">
              <div className="blueprint-detail-card-header custom-field-header">
                <input value={characterEventTimes[index] ?? ""} placeholder={t("blueprint.time")} onChange={(event) => updateCharacterTemplateEvent(index, { time: event.target.value })} />
                <button type="button" onClick={() => removeCharacterTemplateEvent(index)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea className="blueprint-detail-textarea" value={characterEventStories[index] ?? ""} placeholder={t("blueprint.storyText")} onChange={(event) => updateCharacterTemplateEvent(index, { story: event.target.value })} />
              <input value={characterEventLocations[index] ?? ""} placeholder={t("blueprint.location")} onChange={(event) => updateCharacterTemplateEvent(index, { location: event.target.value })} />
            </div>
          ))}
        </div>
        <div className="blueprint-field-group">
          <div className="blueprint-field-header">
            <span>{t("blueprint.relationship")}</span>
            <button type="button" onClick={addTemplateRelationship}>
              <Plus size={13} /> {t("blueprint.add")}
            </button>
          </div>
          {Array.from({ length: relationshipCount }).map((_, index) => (
            <div key={index} className="blueprint-detail-card template-builtin-card">
              <div className="blueprint-detail-card-header custom-field-header">
                <input value={relationshipTargets[index] ?? ""} placeholder={t("blueprint.relationshipTarget")} onChange={(event) => updateTemplateRelationship(index, { target: event.target.value })} />
                <button type="button" onClick={() => removeTemplateRelationship(index)}>
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea className="blueprint-detail-textarea" value={relationshipDescriptions[index] ?? ""} placeholder={t("blueprint.relationshipDescription")} onChange={(event) => updateTemplateRelationship(index, { description: event.target.value })} />
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderTemplateConfiguration = () => {
    if ((templateDraft.nodeKind ?? "custom") === "story") return renderStoryTemplateFieldsSection();
    if ((templateDraft.nodeKind ?? "custom") === "character") return renderCharacterTemplateFieldsSection();
    return renderTemplateFieldsSection();
  };

  return (
    <section
      className="blueprint-editor"
      onContextMenu={(event) => {
        if (!blueprint || !canvasRef.current || !(event.target as HTMLElement).closest(".blueprint-canvas")) return;
        event.preventDefault();
        event.stopPropagation();
        if (connectionDrag) {
          clearConnectionDrag();
        }
      }}
    >
      <div
        ref={bodyRef}
        className={`blueprint-editor-body ${selectedNode ? "has-inspector" : ""} ${isResizingInspector ? "is-resizing" : ""}`}
        style={{
          gridTemplateColumns: selectedNode ? `minmax(0, 1fr) 6px ${inspectorWidth}px` : "minmax(0, 1fr)",
        }}
      >
        <div
          className={`blueprint-canvas ${panState ? "is-panning" : ""}`}
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            if (inputManagerRef.current.mode !== "connecting") handlePointerUp();
          }}
        >
          {activeChildNode && activeChildBlueprint && (
            <div className="blueprint-child-nav">
              <button type="button" onClick={() => setActiveChildNodeId(null)}>返回父蓝图</button>
              <strong>{activeChildNode.title}</strong>
              <span>{activeChildBlueprint.nodes.length} 个子节点</span>
            </div>
          )}
          <div
            className="blueprint-world"
            style={{
              transform: `translate(${blueprint.viewport.x}px, ${blueprint.viewport.y}px) scale(${blueprint.viewport.zoom})`,
            }}
          >
            <svg className="blueprint-edges">
              {blueprint.edges.map((edge) => {
                const from = nodeById.get(edge.from);
                const to = nodeById.get(edge.to);
                if (!from || !to) return null;
                const path = drawEdge(from, to.x + PORT_ANCHOR_OFFSET, to.y + NODE_HEIGHT / 2);
                const isSelected = selectedEdgeId === edge.id;
                const isInsertTarget = edgeInsertCandidate?.edgeId === edge.id;
                return (
                  <g key={edge.id} className={`blueprint-edge ${isSelected ? "selected" : ""} ${isInsertTarget ? "insert-target" : ""} role-${edge.role ?? "flow"}`}>
                    <path
                      className="blueprint-edge-hitbox"
                      d={path}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedNodeIds([]);
                        setSelectedEdgeId(edge.id);
                      }}
                    />
                    <path
                      className="blueprint-edge-line"
                      d={path}
                      aria-hidden="true"
                    />
                  </g>
                );
              })}
              {connectionDrag && nodeById.get(connectionDrag.from) && (
                <path
                  className="draft"
                  d={drawEdge(nodeById.get(connectionDrag.from)!, connectionDrag.x, connectionDrag.y)}
                />
              )}
              {pendingConnectionCreate && nodeById.get(pendingConnectionCreate.fromNodeId) && (
                <path
                  className="draft pending"
                  d={drawEdge(nodeById.get(pendingConnectionCreate.fromNodeId)!, pendingConnectionCreate.canvasX, pendingConnectionCreate.canvasY)}
                />
              )}
            </svg>
            {blueprint.nodes.map((node) => {
              const inputCount = node.kind === "custom" ? Math.max(1, Number(node.inputCount) || 1) : 1;
              return (
                <div
                  key={node.id}
                  className={`blueprint-node ${node.kind} layer-${node.layer ?? "story"} node-type-${node.nodeType ?? "custom"} ${selectedNodeIds.includes(node.id) ? "selected" : ""} ${connectMode ? "connect-mode" : ""} ${connectionDrag?.from === node.id ? "connecting" : ""} ${connectionHoverNodeId === node.id ? "connection-target" : ""}`}
                  data-blueprint-node-id={node.id}
                  style={{ left: node.x, top: node.y }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
                  onPointerEnter={() => handleNodePointerEnter(node.id)}
                  onPointerLeave={() => handleNodePointerLeave(node.id)}
                >
                  {Array.from({ length: inputCount }).map((_, index) => (
                    <span
                      key={index}
                      className="node-port input"
                      style={{ top: `${30 + ((NODE_HEIGHT - 60) / Math.max(1, inputCount - 1 || 1)) * index}px` }}
                      title={t("blueprint.connectHint")}
                      onPointerUp={(event) => handleConnectionEnd(event, node.id)}
                    />
                  ))}
                  <span
                    className="node-port output"
                    title={t("blueprint.connectHint")}
                    onPointerDown={(event) => handleConnectionStart(event, node.id)}
                    onPointerMove={handleConnectionPointerMove}
                  />
                  {false && (
                    <>
                      <span className="node-port structure-parent" title="父级结构" />
                      <span className="node-port mount" title="挂载内容" />
                    </>
                  )}
                  <div className="blueprint-node-header">
                    <span>{getNodeLabel(node)}</span>
                    <small>{node.layer ?? (node.kind === "story" ? t(`blueprint.storyType.${node.storyType ?? "custom"}`) : node.kind === "custom" ? node.templateName : node.identity)}</small>
                  </div>
                  <strong>{node.title || node.characterName || node.templateName || t("blueprint.untitledNode")}</strong>
                  <p>{getNodeSummary(node)}</p>
                </div>
              );
            })}
          </div>
          {marqueeSelect && getMarqueeScreenRect(marqueeSelect) && (
            <div
              className="blueprint-marquee"
              style={getMarqueeScreenRect(marqueeSelect) ?? undefined}
            />
          )}
          <div className="blueprint-input-guide" aria-live="polite">
            <strong>{inputGuideStatus}</strong>
            <span>{t("blueprint.inputGuide.pan")}</span>
            <span>{t("blueprint.inputGuide.marquee")}</span>
            <span>{t("blueprint.inputGuide.menu")}</span>
          </div>
          <div
            ref={minimapRef}
            className="blueprint-minimap"
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              navigateMinimap(event);
              setMinimapDrag({ bounds: minimapBounds });
            }}
            onPointerMove={(event) => event.stopPropagation()}
            onWheel={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            aria-label="Blueprint minimap"
          >
            <span className="blueprint-minimap-zoom">{Math.round(blueprint.viewport.zoom * 100)}%</span>
            <div
              className="blueprint-minimap-plane"
              style={{
                left: minimapOffset.x,
                top: minimapOffset.y,
                width: minimapBounds.width * minimapBounds.scale,
                height: minimapBounds.height * minimapBounds.scale,
              }}
            >
              {blueprint.nodes.length === 0 && <span className="blueprint-minimap-empty" />}
              {blueprint.nodes.map((node) => (
                <span
                  key={node.id}
                  className={`blueprint-minimap-node ${node.kind}`}
                  style={{
                    left: (node.x - minimapBounds.minX) * minimapBounds.scale,
                    top: (node.y - minimapBounds.minY) * minimapBounds.scale,
                    width: Math.max(4, NODE_WIDTH * minimapBounds.scale),
                    height: Math.max(3, NODE_HEIGHT * minimapBounds.scale),
                  }}
                />
              ))}
              <span
                className="blueprint-minimap-view"
                style={{
                  left: viewRect.x - minimapOffset.x,
                  top: viewRect.y - minimapOffset.y,
                  width: Math.max(12, viewRect.width),
                  height: Math.max(10, viewRect.height),
                }}
              />
            </div>
          </div>
          {activeChildNode && activeChildBlueprint && (
            <div className="blueprint-child-canvas-preview">
              {activeChildBlueprint.nodes.map((node) => (
                <div key={node.id} className="blueprint-child-preview-node">
                  <span>{node.title}</span>
                  <small>{getNodeSummary(node)}</small>
                </div>
              ))}
            </div>
          )}
        </div>
        {selectedNode && (
          <>
            <div
              className="blueprint-inspector-resize"
              role="separator"
              aria-orientation="vertical"
              tabIndex={0}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsResizingInspector(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setInspectorWidth((width) => clampInspectorWidth(width + 24));
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setInspectorWidth((width) => clampInspectorWidth(width - 24));
                }
              }}
            />
            <aside className="blueprint-inspector" onKeyDown={(event) => event.stopPropagation()}>
              <div className="blueprint-inspector-header">
                <h3>{t("blueprint.nodeSettings")}</h3>
                <button type="button" onClick={deleteSelection} title={t("blueprint.deleteSelected")}>
                  <Trash2 size={14} />
                </button>
              </div>
              <label>
                <span>{t("blueprint.nodeTitle")}</span>
                <input value={selectedNode.title} onChange={(event) => updateSelected({ title: event.target.value })} />
              </label>
              {renderNodeLinkedChaptersSection()}
              {renderParentChapterSection()}
              {renderMountLinksSection()}
              {renderChildBlueprintSection()}
              {renderTypedDataSection()}
              {renderLogicBlockSection()}
              {selectedNode.kind === "story" && (
                <>
                  <label>
                    <span>{t("blueprint.storyType.label")}</span>
                    <select value={selectedNode.storyType ?? "custom"} onChange={(event) => updateSelected({ storyType: event.target.value as BlueprintNode["storyType"] })}>
                      <option value="start">{t("blueprint.storyType.start")}</option>
                      <option value="ending">{t("blueprint.storyType.ending")}</option>
                      <option value="custom">{t("blueprint.storyType.custom")}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t("blueprint.summary")}</span>
                    <textarea value={selectedNode.summary ?? ""} onChange={(event) => updateSelected({ summary: event.target.value })} />
                  </label>
                  <div className="blueprint-field-group">
                    <div className="blueprint-field-header">
                      <span>{t("blueprint.storyEvents")}</span>
                      <button type="button" onClick={() => updateSelected({ storyEvents: [...(selectedNode.storyEvents ?? []), { id: newLocalId("event"), time: "", content: "", foreshadowing: "" }] })}>
                        <Plus size={13} /> {t("blueprint.add")}
                      </button>
                    </div>
                    {(selectedNode.storyEvents ?? []).map((storyEvent) => (
                      <div key={storyEvent.id} className="blueprint-detail-card story-event">
                        <div className="blueprint-detail-card-header">
                          <input value={storyEvent.time} placeholder={t("blueprint.time")} onChange={(event) => updateStoryEvent(storyEvent.id, { time: event.target.value })} />
                          <button type="button" onClick={() => updateSelected({ storyEvents: (selectedNode.storyEvents ?? []).filter((item) => item.id !== storyEvent.id) })}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <textarea className="blueprint-detail-textarea" value={storyEvent.content} placeholder={t("blueprint.content")} onChange={(event) => updateStoryEvent(storyEvent.id, { content: event.target.value })} />
                        <textarea className="blueprint-detail-textarea" value={storyEvent.foreshadowing} placeholder={t("blueprint.foreshadowing")} onChange={(event) => updateStoryEvent(storyEvent.id, { foreshadowing: event.target.value })} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {selectedNode.kind === "character" && (
                <>
                  <label>
                    <span>{t("blueprint.characterName")}</span>
                    <input value={selectedNode.characterName ?? ""} onChange={(event) => updateSelected({ characterName: event.target.value })} />
                  </label>
                  <label>
                    <span>{t("blueprint.identity")}</span>
                    <input value={selectedNode.identity ?? ""} onChange={(event) => updateSelected({ identity: event.target.value })} />
                  </label>
                  <div className="blueprint-field-group">
                    <div className="blueprint-field-header">
                      <span>{t("blueprint.characterStories")}</span>
                      <button type="button" onClick={() => updateSelected({ characterEvents: [...(selectedNode.characterEvents ?? []), { id: newLocalId("character-event"), time: "", story: "", location: "" }] })}>
                        <Plus size={13} /> {t("blueprint.add")}
                      </button>
                    </div>
                    {(selectedNode.characterEvents ?? []).map((characterEvent) => (
                      <div key={characterEvent.id} className="blueprint-detail-card character-event">
                        <div className="blueprint-detail-card-header">
                          <input value={characterEvent.time} placeholder={t("blueprint.time")} onChange={(event) => updateCharacterEvent(characterEvent.id, { time: event.target.value })} />
                          <button type="button" onClick={() => updateSelected({ characterEvents: (selectedNode.characterEvents ?? []).filter((item) => item.id !== characterEvent.id) })}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <textarea className="blueprint-detail-textarea" value={characterEvent.story} placeholder={t("blueprint.storyText")} onChange={(event) => updateCharacterEvent(characterEvent.id, { story: event.target.value })} />
                        <input value={characterEvent.location} placeholder={t("blueprint.location")} onChange={(event) => updateCharacterEvent(characterEvent.id, { location: event.target.value })} />
                      </div>
                    ))}
                  </div>
                  <div className="blueprint-field-group">
                    <div className="blueprint-field-header">
                      <span>{t("blueprint.relationship")}</span>
                      <button type="button" onClick={() => updateSelected({ relationships: [...(selectedNode.relationships ?? []), { id: newLocalId("rel"), target: "", description: "" }] })}>
                        <Plus size={13} /> {t("blueprint.add")}
                      </button>
                    </div>
                    {(selectedNode.relationships ?? []).map((relationship) => (
                      <div key={relationship.id} className="blueprint-detail-card relationship">
                        <div className="blueprint-detail-card-header">
                          <input value={relationship.target ?? ""} placeholder={t("blueprint.relationshipTarget")} onChange={(event) => updateRelationship(relationship.id, { target: event.target.value })} />
                          <button type="button" onClick={() => updateSelected({ relationships: (selectedNode.relationships ?? []).filter((item) => item.id !== relationship.id) })}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                        <textarea className="blueprint-detail-textarea" value={relationship.description ?? ""} placeholder={t("blueprint.relationshipDescription")} onChange={(event) => updateRelationship(relationship.id, { description: event.target.value })} />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {selectedNode.kind === "custom" && (
                <>
                  <label>
                    <span>{t("blueprint.templateName")}</span>
                    <input value={selectedNode.templateName ?? ""} onChange={(event) => updateSelected({ templateName: event.target.value })} />
                  </label>
                  <label>
                    <span>{t("blueprint.inputCount")}</span>
                    <input type="number" min={1} value={selectedNode.inputCount ?? 1} onChange={(event) => updateSelected({ inputCount: Math.max(1, Number(event.target.value) || 1) })} />
                  </label>
                </>
              )}
            </aside>
          </>
        )}
      </div>
      <footer className="blueprint-toolbar">
        <div className="blueprint-toolbar-title">
          <GitBranch size={16} />
          <strong>{blueprint.name}</strong>
        </div>
        <div className="blueprint-toolbar-create">
          <button
            ref={createButtonRef}
            type="button"
            className={isCreateMenuOpen ? "active" : ""}
            onClick={(event) => {
              event.stopPropagation();
              setContextMenu(null);
              setPendingConnectionCreate(null);
              const rect = event.currentTarget.getBoundingClientRect();
              setCreateMenuPosition(getFloatingPosition(
                { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
                {
                  width: CREATE_MENU_WIDTH,
                  height: CREATE_MENU_HEIGHT,
                  padding: FLOATING_EDGE_PADDING,
                  preferVertical: "top",
                  preferHorizontal: "right",
                }
              ));
              setIsCreateMenuOpen((value) => !value);
            }}
          >
            <Plus size={15} /> {t("blueprint.createBlueprint")}
          </button>
          {isCreateMenuOpen && (
            <div
              ref={createMenuRef}
              className="blueprint-create-menu"
              style={createMenuPosition ? { left: createMenuPosition.left, top: createMenuPosition.top, maxHeight: createMenuPosition.maxHeight } : undefined}
            >
              {renderCreateItems((item) => {
                const point = pendingConnectionCreate
                  ? { x: pendingConnectionCreate.canvasX, y: pendingConnectionCreate.canvasY }
                  : getViewportCenterPoint();
                placePaletteItem(item, point.x, point.y);
              })}
            </div>
          )}
        </div>
        <button type="button" onClick={() => {
          setContextMenu(null);
          setIsCreateMenuOpen(false);
          setTemplateDraft(templates[0] ?? createBlankTemplate());
          setIsTemplateModalOpen(true);
        }}>
          <LayoutTemplate size={15} /> {t("blueprint.templates")}
        </button>
        <button type="button" onClick={handleAutoLayout} disabled={blueprint.nodes.length === 0}>
          <LayoutDashboard size={15} /> {t("blueprint.autoLayout")}
        </button>
        <button type="button" className={connectMode ? "active" : ""} onClick={() => {
          setConnectMode((value) => !value);
        }}>
          <GitBranch size={15} /> {t("blueprint.connect")}
        </button>
        <button type="button" onClick={() => undoBlueprint(blueprintId)}>
          <RotateCcw size={15} /> {t("blueprint.undo")}
        </button>
        <button type="button" onClick={deleteSelection} disabled={selectedNodeIds.length === 0 && !selectedEdgeId}>
          <Trash2 size={15} /> {t("blueprint.deleteSelected")}
        </button>
        <button type="button" className={`blueprint-save-button ${saveState}`} onClick={() => void handleSaveBlueprint()} disabled={saveState === "saving"}>
          <Save size={15} /> {saveState === "saving" ? t("blueprint.saving") : t("blueprint.save")}
        </button>
        {saveMessage && <span className={`blueprint-save-status ${saveState}`}>{saveMessage}</span>}
      </footer>
      {contextMenu && (
        <div className="blueprint-context-menu" style={{ left: contextMenu.left, top: contextMenu.top, maxHeight: contextMenu.maxHeight }}>
          <button type="button" onClick={() => { undoBlueprint(blueprintId); setContextMenu(null); }}>
            {t("blueprint.undo")}
          </button>
          <button type="button" onClick={() => { copySelection(); setContextMenu(null); }}>
            {t("blueprint.copy")}
          </button>
          <button type="button" onClick={() => { pasteClipboard({ x: contextMenu.canvasX, y: contextMenu.canvasY }); setContextMenu(null); }}>
            {t("blueprint.paste")}
          </button>
          <div className={`blueprint-context-submenu ${contextMenu.submenuSide === "left" ? "open-left" : "open-right"}`}>
            <span>{t("blueprint.create")} &gt; {t("blueprint.title")}</span>
            <div style={{ top: contextMenu.submenuTop, maxHeight: contextMenu.submenuMaxHeight }}>
              {renderCreateItems((item) => placePaletteItem(item, contextMenu.canvasX, contextMenu.canvasY))}
            </div>
          </div>
        </div>
      )}
      {isTemplateModalOpen && (
        <div className="blueprint-modal-backdrop" onMouseDown={() => setIsTemplateModalOpen(false)}>
          <section className="blueprint-template-modal" onMouseDown={(event) => event.stopPropagation()}>
            <header className="blueprint-template-modal-header">
              <div>
                <h3>{t("blueprint.templates")}</h3>
                <p>{t("blueprint.templatesHint")}</p>
              </div>
              <button type="button" onClick={() => setIsTemplateModalOpen(false)}>{t("blueprint.close")}</button>
            </header>
            <div className="blueprint-template-modal-body">
              <aside className="blueprint-template-list">
                <button type="button" className="blueprint-template-new" onClick={() => setTemplateDraft(createBlankTemplate())}>
                  <Plus size={14} /> {t("blueprint.newTemplate")}
                </button>
                {templates.map((template) => (
                  <article key={template.id} className={templateDraft.id === template.id ? "active" : ""}>
                    <button type="button" onClick={() => setTemplateDraft(template)}>
                      <strong>{template.name}</strong>
                      <span>{getTemplateKindLabel(template.nodeKind ?? "custom")} · {template.fields.length} {t("blueprint.fields")}</span>
                    </button>
                    <div className="blueprint-template-actions">
                      <button type="button" onClick={() => handleUseTemplate(template.id)}>{t("blueprint.useTemplate")}</button>
                      <button type="button" onClick={() => void deleteTemplate(template.id)}>{t("blueprint.delete")}</button>
                    </div>
                  </article>
                ))}
              </aside>
              <div className="blueprint-template-form">
                <label>
                  <span>{t("blueprint.templateName")}</span>
                  <input value={templateDraft.name} onChange={(event) => setTemplateDraft((draft) => ({ ...draft, name: event.target.value }))} />
                </label>
                <label>
                  <span>{t("blueprint.nodeType")}</span>
                  <select value={templateDraft.nodeKind ?? "custom"} onChange={(event) => setTemplateDraft((draft) => ({ ...draft, nodeKind: event.target.value as BlueprintNodeKind }))}>
                    <option value="custom">{t("blueprint.customNode")}</option>
                    <option value="story">{t("blueprint.story")}</option>
                    <option value="character">{t("blueprint.character")}</option>
                  </select>
                </label>
                {renderTemplateConfiguration()}
                {templateErrorMessage && <div className="blueprint-template-error">{templateErrorMessage}</div>}
                <div className="blueprint-template-form-actions">
                  <button type="button" onClick={() => void handleSaveTemplate()}>
                    <Save size={14} /> {t("blueprint.saveTemplate")}
                  </button>
                  {templates.some((template) => template.id === templateDraft.id) && (
                    <button type="button" onClick={() => handleUseTemplate(templateDraft.id)}>
                      <Settings2 size={14} /> {t("blueprint.useTemplate")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
