import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LayoutTemplate, Minus, Plus, RotateCcw, Save, Settings2, Trash2, UserRound } from "lucide-react";
import { useBlueprintStore } from "../stores/blueprintStore";
import type { BlueprintDocument, BlueprintFieldInputMode, BlueprintNode, BlueprintNodeKind, BlueprintNodeTemplate } from "../types/blueprint";
import { useTranslation } from "../hooks/useTranslation";
import "./BlueprintEditor.css";

interface Props {
  blueprintId: string;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 126;

type PanState = { startX: number; startY: number; originX: number; originY: number } | null;
type NodeDragState = { nodeId: string; offsetX: number; offsetY: number } | null;
type ConnectionDragState = { from: string; x: number; y: number } | null;
type SaveState = "idle" | "saving" | "saved" | "error";
type BlueprintClipboard = Pick<BlueprintDocument, "nodes" | "edges">;
type BlueprintPaletteItem =
  | { id: string; type: "base"; kind: BlueprintNodeKind; label: string }
  | { id: string; type: "template"; kind: BlueprintNodeKind; templateId: string; label: string };

const newLocalId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ensureFieldValues = (values: string[] | undefined, fallback = "") => (values?.length ? values : [fallback]);
const nextFieldMode = (mode: BlueprintFieldInputMode | undefined): BlueprintFieldInputMode => (mode === "fixed" ? "repeatable" : "fixed");

const createBlankTemplate = (): BlueprintNodeTemplate => {
  const now = new Date().toISOString();
  return {
    id: newLocalId("template"),
    name: "",
    nodeKind: "custom",
    inputCount: 1,
    fields: [{ id: newLocalId("template-field"), key: "", defaultValue: "", defaultValues: [""], inputMode: "repeatable" }],
    createdAt: now,
    updatedAt: now,
  };
};

const templateFromNode = (node: BlueprintNode): BlueprintNodeTemplate => {
  const now = new Date().toISOString();
  return {
    id: newLocalId("template"),
    name: node.templateName || node.title || "",
    nodeKind: node.kind,
    inputCount: Math.max(1, Number(node.inputCount) || 1),
    fields: (node.customFields ?? []).map((field) => ({
      id: newLocalId("template-field"),
      key: field.key,
      defaultValue: field.values?.[0] ?? field.value,
      defaultValues: field.values?.length ? field.values : [field.value],
      inputMode: field.inputMode ?? "repeatable",
    })),
    createdAt: now,
    updatedAt: now,
  };
};

const isEditableEventTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
};

const screenToCanvas = (event: React.PointerEvent, canvas: HTMLDivElement, blueprint: BlueprintDocument) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - blueprint.viewport.x) / blueprint.viewport.zoom,
    y: (event.clientY - rect.top - blueprint.viewport.y) / blueprint.viewport.zoom,
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
  const blueprint = blueprints.find((item) => item.id === blueprintId) ?? null;
  const focusedNodeId = focusedNodeByBlueprintId[blueprintId] ?? null;
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(focusedNodeId ? [focusedNodeId] : []);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodeDrag, setNodeDrag] = useState<NodeDragState>(null);
  const [panState, setPanState] = useState<PanState>(null);
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDragState>(null);
  const [connectMode, setConnectMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(360);
  const [isResizingInspector, setIsResizingInspector] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<BlueprintNodeTemplate>(() => createBlankTemplate());
  const [selectedPaletteItemId, setSelectedPaletteItemId] = useState<string | null | undefined>(undefined);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const paletteItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const saveTimerRef = useRef<number | null>(null);
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
  }, []);

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
  const selectedPaletteItem = paletteItems.find((item) => item.id === selectedPaletteItemId) ?? null;

  const clampInspectorWidth = (width: number) => Math.min(560, Math.max(320, width));

  useEffect(() => {
    if (selectedPaletteItemId === undefined && paletteItems[0]) {
      setSelectedPaletteItemId(paletteItems[0].id);
      return;
    }
    if (selectedPaletteItemId && !paletteItems.some((item) => item.id === selectedPaletteItemId)) {
      setSelectedPaletteItemId(paletteItems[0]?.id ?? null);
    }
  }, [paletteItems, selectedPaletteItemId]);

  useEffect(() => {
    if (!selectedPaletteItemId) return;
    paletteItemRefs.current[selectedPaletteItemId]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [selectedPaletteItemId]);

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

  const nodeById = useMemo(() => {
    const map = new Map<string, BlueprintNode>();
    blueprint?.nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [blueprint]);

  const commitBlueprint = (next: BlueprintDocument, options?: { skipUndo?: boolean }) => {
    replaceBlueprint(next, options);
  };

  const updateViewport = (patch: Partial<BlueprintDocument["viewport"]>) => {
    if (!blueprint) return;
    commitBlueprint({ ...blueprint, viewport: { ...blueprint.viewport, ...patch } }, { skipUndo: true });
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

  const pasteClipboard = () => {
    if (!blueprint || !clipboardRef.current || clipboardRef.current.nodes.length === 0) return;
    const idMap = new Map<string, string>();
    const nextNodes = clipboardRef.current.nodes.map((node) => {
      const nextId = newLocalId("node");
      idMap.set(node.id, nextId);
      return cloneNodeForPaste(node, nextId);
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

  const selectPaletteItem = (itemId: string) => {
    setSelectedPaletteItemId(itemId);
    setConnectMode(false);
  };

  const handlePaletteWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (paletteItems.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const currentId = selectedPaletteItemId ?? paletteItems[0].id;
    const currentIndex = Math.max(0, paletteItems.findIndex((item) => item.id === currentId));
    const direction = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const nextIndex = direction > 0
      ? (currentIndex + 1) % paletteItems.length
      : (currentIndex - 1 + paletteItems.length) % paletteItems.length;
    selectPaletteItem(paletteItems[nextIndex].id);
  };

  const placeSelectedPaletteItem = (x: number, y: number) => {
    if (!selectedPaletteItem) return false;
    if (selectedPaletteItem.type === "template") {
      createCustomNodeFromTemplate(blueprintId, selectedPaletteItem.templateId, x, y);
    } else {
      addNode(blueprintId, selectedPaletteItem.kind, x, y);
    }
    setSelectedPaletteItemId(null);
    setSelectedEdgeId(null);
    setContextMenu(null);
    return true;
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key === "Escape") {
        setSelectedPaletteItemId(null);
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
    if (selectedPaletteItem && event.button === 0 && canvasRef.current) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      placeSelectedPaletteItem(point.x, point.y);
      return;
    }
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
      }, { skipUndo: true });
      return;
    }
    if (connectionDrag) {
      const point = screenToCanvas(event, canvasRef.current, blueprint);
      setConnectionDrag({ ...connectionDrag, x: point.x, y: point.y });
    }
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
  };

  const handleConnectionEnd = (event: React.PointerEvent, nodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (connectionDrag && connectionDrag.from !== nodeId) {
      addEdge(blueprintId, connectionDrag.from, nodeId);
    }
    setConnectionDrag(null);
  };

  const handlePointerUp = () => {
    setNodeDrag(null);
    setPanState(null);
    setConnectionDrag(null);
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

  const openTemplateModal = (draft?: BlueprintNodeTemplate) => {
    setTemplateDraft(draft ?? templates[0] ?? createBlankTemplate());
    setIsTemplateModalOpen(true);
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
          <button type="button" onClick={() => updateSelected({ customFields: [...(selectedNode.customFields ?? []), { id: newLocalId("field"), key: "", value: "", values: [""], inputMode: "repeatable" }] })}>
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
        <button type="button" onClick={() => setTemplateDraft((draft) => ({ ...draft, fields: [...draft.fields, { id: newLocalId("template-field"), key: "", defaultValue: "", defaultValues: [""], inputMode: "repeatable" }] }))}>
          <Plus size={13} /> {t("blueprint.add")}
        </button>
      </div>
      {templateDraft.fields.map((field) => {
        const values = ensureFieldValues(field.defaultValues, field.defaultValue ?? "");
        const isFixed = field.inputMode === "fixed";
        return (
          <div key={field.id} className="blueprint-detail-card custom-field template-field">
            <div className="blueprint-detail-card-header custom-field-header">
              <input value={field.key} placeholder={t("blueprint.fieldKey")} onChange={(event) => setTemplateDraft((draft) => ({
                ...draft,
                fields: draft.fields.map((item) => item.id === field.id ? { ...item, key: event.target.value } : item),
              }))} />
              <button type="button" onClick={() => setTemplateDraft((draft) => ({ ...draft, fields: draft.fields.filter((item) => item.id !== field.id) }))}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="blueprint-field-inputs">
              {values.map((value, index) => (
                <div key={index} className={`blueprint-field-input-row ${isFixed ? "fixed" : ""}`}>
                  <input value={value} placeholder={`${t("blueprint.input")} ${index + 1}`} onChange={(event) => updateTemplateFieldInput(field.id, index, event.target.value)} />
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
            <button type="button" className="blueprint-field-settings-button" onClick={() => setTemplateDraft((draft) => ({
              ...draft,
              fields: draft.fields.map((item) => item.id === field.id ? { ...item, inputMode: nextFieldMode(item.inputMode) } : item),
            }))} title={t("blueprint.fieldSettings")}>
              <Settings2 size={13} /> {t("blueprint.settings")} · {getFieldModeLabel(field.inputMode)}
            </button>
          </div>
        );
      })}
    </div>
  );

  return (
    <section
      className="blueprint-editor"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
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
                  className={`blueprint-node ${node.kind} ${selectedNodeIds.includes(node.id) ? "selected" : ""} ${connectMode ? "connect-mode" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onPointerDown={(event) => handleNodePointerDown(event, node)}
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
          <div className="blueprint-node-palette-shell" onWheel={handlePaletteWheel}>
            <div className="blueprint-node-palette" aria-label={t("blueprint.nodePalette")}>
              {paletteItems.map((item) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    paletteItemRefs.current[item.id] = element;
                  }}
                  type="button"
                  className={selectedPaletteItemId === item.id ? "active" : ""}
                  title={t("blueprint.placeNodeHint")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectPaletteItem(item.id);
                  }}
                >
                  {renderPaletteIcon(item.kind)}
                  <span>{item.label}</span>
                </button>
              ))}
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
                  <button type="button" className="blueprint-wide-button" onClick={() => openTemplateModal(templateFromNode(selectedNode))}>
                    <LayoutTemplate size={14} /> {t("blueprint.saveAsTemplate")}
                  </button>
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
        <button type="button" onClick={() => openTemplateModal()}>
          <LayoutTemplate size={15} /> {t("blueprint.templates")}
        </button>
        <button type="button" className={connectMode ? "active" : ""} onClick={() => {
          setSelectedPaletteItemId(null);
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
                {(templateDraft.nodeKind ?? "custom") === "custom" && (
                  <label>
                    <span>{t("blueprint.inputCount")}</span>
                    <input type="number" min={1} value={templateDraft.inputCount} onChange={(event) => setTemplateDraft((draft) => ({ ...draft, inputCount: Math.max(1, Number(event.target.value) || 1) }))} />
                  </label>
                )}
                {renderTemplateFieldsSection()}
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
