import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LayoutTemplate, Minus, Plus, RotateCcw, Save, Settings2, Trash2, UserRound } from "lucide-react";
import { useBlueprintStore } from "../stores/blueprintStore";
import { useFileStore } from "../stores/fileStore";
import type { BlueprintDocument, BlueprintFieldBindingKey, BlueprintFieldInputMode, BlueprintNode, BlueprintNodeKind, BlueprintNodeTemplate } from "../types/blueprint";
import { useTranslation } from "../hooks/useTranslation";
import "./BlueprintEditor.css";

interface Props {
  blueprintId: string;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 126;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.5;
const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 128;
const MINIMAP_PADDING = 80;
const ZOOM_SAVE_DELAY_MS = 280;

type PanState = { startX: number; startY: number; originX: number; originY: number } | null;
type NodeDragState = { nodeId: string; offsetX: number; offsetY: number } | null;
type ConnectionDragState = { from: string; x: number; y: number } | null;
type MinimapDragState = { bounds: MinimapBounds } | null;
type SaveState = "idle" | "saving" | "saved" | "error";
type BlueprintClipboard = Pick<BlueprintDocument, "nodes" | "edges">;
type BlueprintPaletteItem =
  | { id: string; type: "base"; kind: BlueprintNodeKind; label: string }
  | { id: string; type: "template"; kind: BlueprintNodeKind; templateId: string; label: string };
type BlueprintContextMenuState = { x: number; y: number; canvasX: number; canvasY: number } | null;
type MinimapBounds = { minX: number; minY: number; width: number; height: number; scale: number };

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

const clientToCanvas = (clientX: number, clientY: number, canvas: HTMLDivElement, blueprint: BlueprintDocument) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - blueprint.viewport.x) / blueprint.viewport.zoom,
    y: (clientY - rect.top - blueprint.viewport.y) / blueprint.viewport.zoom,
  };
};

const screenToCanvas = (event: React.PointerEvent, canvas: HTMLDivElement, blueprint: BlueprintDocument) =>
  clientToCanvas(event.clientX, event.clientY, canvas, blueprint);

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
    replaceBlueprint,
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
  const { referenceEntries } = useFileStore();
  const blueprint = blueprints.find((item) => item.id === blueprintId) ?? null;
  const focusedNodeId = focusedNodeByBlueprintId[blueprintId] ?? null;
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(focusedNodeId ? [focusedNodeId] : []);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDragState>(null);
  const [panState, setPanState] = useState<PanState>(null);
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDragState>(null);
  const [connectionHoverNodeId, setConnectionHoverNodeId] = useState<string | null>(null);
  const [minimapDrag, setMinimapDrag] = useState<MinimapDragState>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<BlueprintContextMenuState>(null);
  const [isCreateMenuOpen, setIsCreateMenuOpen] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<BlueprintNodeTemplate>(() => createBlankTemplate());
  const [activeTemplateKeyInput, setActiveTemplateKeyInput] = useState<{ fieldId: string; index: number } | null>(null);
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

  useEffect(() => {
    if (!blueprint) void loadBlueprints();
  }, [blueprint, loadBlueprints]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  useEffect(() => {
    if (focusedNodeId) setSelectedNodeIds([focusedNodeId]);
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
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isCreateMenuOpen]);

  const selectedNode = blueprint?.nodes.find((node) => node.id === selectedNodeIds[selectedNodeIds.length - 1]) ?? null;
  const paletteItems = useMemo<BlueprintPaletteItem[]>(() => [
    { id: "story-base", type: "base", kind: "story", label: t("blueprint.addStory") },
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

  const nodeById = useMemo(() => {
    const map = new Map<string, BlueprintNode>();
    blueprint?.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [blueprint]);

  const commitBlueprint = (next: BlueprintDocument, options?: { skipUndo?: boolean; skipPersist?: boolean }) => {
    replaceBlueprint(next, options);
  };

  const updateViewport = (patch: Partial<BlueprintDocument["viewport"]>) => {
    if (!blueprint) return;
    commitBlueprint({ ...blueprint, viewport: { ...blueprint.viewport, ...patch } }, { skipUndo: true, skipPersist: true });
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

  const placePaletteItem = (item: BlueprintPaletteItem, x: number, y: number) => {
    if (item.type === "template") {
      createCustomNodeFromTemplate(blueprintId, item.templateId, x, y);
    } else {
      addNode(blueprintId, item.kind, x, y);
    }
    setSelectedEdgeId(null);
    setContextMenu(null);
    setIsCreateMenuOpen(false);
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
    if (!blueprint || (event.target !== event.currentTarget && !(event.target as HTMLElement).classList.contains("blueprint-world"))) return;
    event.preventDefault();
    setContextMenu(null);
    setIsCreateMenuOpen(false);
    setSelectedNodeIds([]);
    setSelectedEdgeId(null);
    focusNode(blueprintId, null);
    if (event.button === 0 || event.button === 1) {
      setPanState({
        startX: event.clientX,
        startY: event.clientY,
        originX: blueprint.viewport.x,
        originY: blueprint.viewport.y,
      });
    }
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!blueprint || !canvasRef.current) return;
    if (panState) {
      updateViewport({
        x: panState.originX + event.clientX - panState.startX,
        y: panState.originY + event.clientY - panState.startY,
      });
      return;
    }
    if (nodeDrag) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      updateNode(blueprintId, nodeDrag.nodeId, {
        x: point.x - nodeDrag.offsetX,
        y: point.y - nodeDrag.offsetY,
      }, { skipUndo: true, skipPersist: true });
      return;
    }
    if (connectionDrag) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      setConnectionDrag({ ...connectionDrag, x: point.x, y: point.y });
    }
  };

  const handleCanvasWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!blueprint || !canvasRef.current) return;
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

  const handleNodePointerDown = (event: React.PointerEvent, node: BlueprintNode) => {
    if (!blueprint || !canvasRef.current || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu(null);
    pushUndo(blueprintId);
    const point = screenToCanvas(event, canvasRef.current, blueprint);
    setNodeDrag({ nodeId: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y });
    setSelectedEdgeId(null);
    setSelectedNodeIds((current) => {
      if (event.shiftKey) {
        return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
      }
      return [node.id];
    });
    focusNode(blueprintId, node.id);
  };

  const handleConnectionStart = (event: React.PointerEvent, nodeId: string) => {
    if (!blueprint || !canvasRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const point = screenToCanvas(event, canvasRef.current, blueprint);
    setConnectionDrag({ from: nodeId, x: point.x, y: point.y });
    setConnectionHoverNodeId(null);
  };

  const handleConnectionEnd = (event: React.PointerEvent, nodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (connectionDrag && connectionDrag.from !== nodeId) {
      addEdge(blueprintId, connectionDrag.from, nodeId);
    }
    setConnectionDrag(null);
    setConnectionHoverNodeId(null);
  };

  const handleNodePointerEnter = (nodeId: string) => {
    if (!connectionDrag || connectionDrag.from === nodeId) return;
    setConnectionHoverNodeId(nodeId);
  };

  const handleNodePointerLeave = (nodeId: string) => {
    setConnectionHoverNodeId((current) => (current === nodeId ? null : current));
  };

  const handlePointerUp = () => {
    if (connectionDrag && connectionHoverNodeId && connectionDrag.from !== connectionHoverNodeId) {
      addEdge(blueprintId, connectionDrag.from, connectionHoverNodeId);
    }
    if (nodeDrag || panState) {
      const latestBlueprint = useBlueprintStore.getState().blueprints.find((item) => item.id === blueprintId);
      if (latestBlueprint) void saveBlueprint(latestBlueprint);
    }
    setNodeDrag(null);
    setPanState(null);
    setConnectionDrag(null);
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

  if (!blueprint) {
    return <div className="blueprint-editor-empty">{t("blueprint.loading")}</div>;
  }

  const drawEdge = (from: BlueprintNode, toX: number, toY: number) => {
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const mid = Math.max(40, Math.abs(toX - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${toX - mid} ${toY}, ${toX} ${toY}`;
  };

  const getNodeSummary = (node: BlueprintNode) => {
    if (node.kind === "story") {
      const firstEvent = node.storyEvents?.find((item) => item.content || item.foreshadowing);
      return node.summary || firstEvent?.content || firstEvent?.foreshadowing || t("blueprint.emptyNode");
    }
    if (node.kind === "character") {
      const relationshipCount = node.relationships?.length ?? 0;
      const eventCount = node.characterEvents?.length ?? 0;
      return [node.characterName, node.identity, relationshipCount ? `${relationshipCount} ${t("blueprint.relationships")}` : "", eventCount ? `${eventCount} ${t("blueprint.characterStories")}` : ""].filter(Boolean).join(" · ") || t("blueprint.emptyNode");
    }
    return (node.customFields ?? [])
      .filter((field) => field.showInCard !== false)
      .map((field) => (field.values?.length ? field.values : [field.value]).filter(Boolean).join(" / ") || field.key)
      .filter(Boolean)
      .slice(0, 3)
      .join(" · ") || t("blueprint.emptyNode");
  };

  const getNodeLabel = (node: BlueprintNode) => {
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

  const renderPaletteIcon = (kind: BlueprintNodeKind) => {
    if (kind === "story") return <GitBranch size={15} />;
    if (kind === "character") return <UserRound size={15} />;
    return <Settings2 size={15} />;
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
                <input value={field.key} placeholder={t("blueprint.fieldKey")} onChange={(event) => updateCustomField(field.id, { key: event.target.value })} />
                <button type="button" onClick={() => updateSelected({ customFields: (selectedNode.customFields ?? []).filter((item) => item.id !== field.id) })}>
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="blueprint-field-inputs">
                {values.map((value, index) => (
                  <div key={index} className={`blueprint-field-input-row ${isFixed ? "fixed" : ""}`}>
                    <input value={value} placeholder={`${t("blueprint.input")} ${index + 1}`} onChange={(event) => updateCustomFieldInput(field.id, index, event.target.value)} />
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
                    <input
                      value={value}
                      placeholder={t("blueprint.templateInputPlaceholder")}
                      onFocus={() => {
                        if ((field.bindingKey ?? "custom") === "custom") setActiveTemplateKeyInput({ fieldId: field.id, index });
                      }}
                      onBlur={() => window.setTimeout(() => setActiveTemplateKeyInput(null), 120)}
                      onChange={(event) => {
                        updateTemplateFieldInput(field.id, index, event.target.value);
                        if ((field.bindingKey ?? "custom") === "custom") setActiveTemplateKeyInput({ fieldId: field.id, index });
                      }}
                    />
                    {(field.bindingKey ?? "custom") === "custom" &&
                      activeTemplateKeyInput?.fieldId === field.id &&
                      activeTemplateKeyInput.index === index &&
                      getReferenceKeySuggestions(value).length > 0 && (
                        <div className="blueprint-template-key-suggestions">
                          {getReferenceKeySuggestions(value).map(([name, description]) => (
                            <button
                              key={name}
                              type="button"
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                updateTemplateFieldInput(field.id, index, name);
                                setActiveTemplateKeyInput(null);
                              }}
                            >
                              <strong>{name}</strong>
                              {description && <span>{description}</span>}
                            </button>
                          ))}
                        </div>
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
          <input value={getTemplateBindingValue("title")} placeholder={t("blueprint.nodeTitle")} onChange={(event) => setTemplateBindingValue("title", t("blueprint.nodeTitle"), event.target.value)} />
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
              <input value={chapter} placeholder={t("blueprint.templateInputPlaceholder")} onChange={(event) => updateTemplateBindingInput("linkedChapters", t("blueprint.linkedChapter"), index, event.target.value)} />
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
          <input value={getTemplateBindingValue("title")} placeholder={t("blueprint.nodeTitle")} onChange={(event) => setTemplateBindingValue("title", t("blueprint.nodeTitle"), event.target.value)} />
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
        const point = clientToCanvas(event.clientX, event.clientY, canvasRef.current, blueprint);
        setIsCreateMenuOpen(false);
        setContextMenu({ x: event.clientX, y: event.clientY, canvasX: point.x, canvasY: point.y });
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
          className="blueprint-canvas"
          ref={canvasRef}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          onWheel={handleCanvasWheel}
        >
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
                return (
                  <path
                    key={edge.id}
                    className={selectedEdgeId === edge.id ? "selected" : ""}
                    d={drawEdge(from, to.x, to.y + NODE_HEIGHT / 2)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedNodeIds([]);
                      setSelectedEdgeId(edge.id);
                    }}
                  />
                );
              })}
              {connectionDrag && nodeById.get(connectionDrag.from) && (
                <path
                  className="draft"
                  d={drawEdge(nodeById.get(connectionDrag.from)!, connectionDrag.x, connectionDrag.y)}
                />
              )}
            </svg>
            {blueprint.nodes.map((node) => {
              const inputCount = node.kind === "custom" ? Math.max(1, Number(node.inputCount) || 1) : 1;
              return (
                <div
                  key={node.id}
                  className={`blueprint-node ${node.kind} ${selectedNodeIds.includes(node.id) ? "selected" : ""} ${connectMode ? "connect-mode" : ""} ${connectionDrag?.from === node.id ? "connecting" : ""} ${connectionHoverNodeId === node.id ? "connection-target" : ""}`}
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
                  />
                  <div className="blueprint-node-header">
                    <span>{getNodeLabel(node)}</span>
                    <small>{node.kind === "story" ? t(`blueprint.storyType.${node.storyType ?? "custom"}`) : node.kind === "custom" ? node.templateName : node.identity}</small>
                  </div>
                  <strong>{node.title || node.characterName || node.templateName || t("blueprint.untitledNode")}</strong>
                  <p>{getNodeSummary(node)}</p>
                </div>
              );
            })}
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
                      <span>{t("blueprint.linkedChapter")}</span>
                      <button type="button" onClick={() => updateSelected({ linkedChapters: [...(selectedNode.linkedChapters ?? []), ""] })}>
                        <Plus size={13} /> {t("blueprint.add")}
                      </button>
                    </div>
                    {(selectedNode.linkedChapters ?? []).map((chapter, index) => (
                      <div key={index} className="blueprint-inline-row single">
                        <input value={chapter} onChange={(event) => updateChapter(index, event.target.value)} />
                        <button type="button" onClick={() => updateSelected({ linkedChapters: (selectedNode.linkedChapters ?? []).filter((_, itemIndex) => itemIndex !== index) })}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
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
                  {renderCustomFieldsSection()}
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
                  {renderCustomFieldsSection()}
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
                  {renderCustomFieldsSection()}
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
              setIsCreateMenuOpen((value) => !value);
            }}
          >
            <Plus size={15} /> {t("blueprint.createBlueprint")}
          </button>
          {isCreateMenuOpen && (
            <div ref={createMenuRef} className="blueprint-create-menu">
              {paletteItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    const point = getViewportCenterPoint();
                    placePaletteItem(item, point.x, point.y);
                  }}
                >
                  {renderPaletteIcon(item.kind)}
                  <span>{item.label}</span>
                </button>
              ))}
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
        <div className="blueprint-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" onClick={() => { undoBlueprint(blueprintId); setContextMenu(null); }}>
            {t("blueprint.undo")}
          </button>
          <button type="button" onClick={() => { copySelection(); setContextMenu(null); }}>
            {t("blueprint.copy")}
          </button>
          <button type="button" onClick={() => { pasteClipboard({ x: contextMenu.canvasX, y: contextMenu.canvasY }); setContextMenu(null); }}>
            {t("blueprint.paste")}
          </button>
          <div className="blueprint-context-submenu">
            <span>{t("blueprint.create")} &gt; {t("blueprint.title")}</span>
            <div>
              {paletteItems.map((item) => (
                <button key={item.id} type="button" onClick={() => placePaletteItem(item, contextMenu.canvasX, contextMenu.canvasY)}>
                  {renderPaletteIcon(item.kind)}
                  {item.label}
                </button>
              ))}
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
