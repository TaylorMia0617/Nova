import { create } from "zustand";
import {
  deleteBlueprint as deleteBlueprintFromDisk,
  deleteBlueprintTemplate as deleteBlueprintTemplateFromDisk,
  listBlueprints,
  listBlueprintTemplates,
  renameBlueprint as renameBlueprintOnDisk,
  saveBlueprint as saveBlueprintOnDisk,
  saveBlueprintTemplate as saveBlueprintTemplateOnDisk,
} from "../services/fileSystemService";
import type { BlueprintDocument, BlueprintEdge, BlueprintFieldBindingKey, BlueprintNode, BlueprintNodeKind, BlueprintNodeTemplate } from "../types/blueprint";

const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ensureValues = (values: string[] | undefined, fallback = "") => (Array.isArray(values) && values.length > 0 ? values : [fallback]);
const firstValue = (values: string[] | undefined, fallback = "") => ensureValues(values, fallback)[0] ?? "";

const supportsTemplateBinding = (kind: BlueprintNodeKind, bindingKey: BlueprintFieldBindingKey) => {
  if (bindingKey === "custom" || bindingKey === "title") return true;
  if (kind === "story") {
    return ["summary", "linkedChapters", "storyType", "storyEventContent", "storyEventTime", "storyEventForeshadowing"].includes(bindingKey);
  }
  if (kind === "character") {
    return ["characterName", "identity", "relationshipTarget", "relationshipDescription", "characterEventTime", "characterEventStory", "characterEventLocation"].includes(bindingKey);
  }
  return false;
};

const fieldsFromTemplate = (template: BlueprintNodeTemplate | undefined, kind: BlueprintNodeKind): BlueprintNode["customFields"] =>
  (template?.fields ?? []).filter((field) => {
    const bindingKey = field.bindingKey ?? "custom";
    return bindingKey === "custom" || !supportsTemplateBinding(kind, bindingKey);
  }).map((field) => {
    const values = ensureValues(field.defaultValues, field.defaultValue ?? "");
    return {
      id: newId("field"),
      key: field.key,
      value: values[0] ?? "",
      values,
      inputMode: field.inputMode ?? "repeatable",
      bindingKey: "custom",
      showInCard: field.showInCard ?? true,
    };
  });

const applyTemplateBinding = (node: BlueprintNode, field: BlueprintNodeTemplate["fields"][number]): BlueprintNode => {
  const bindingKey = field.bindingKey ?? "custom";
  if (bindingKey === "custom") return node;
  const values = ensureValues(field.defaultValues, field.defaultValue ?? "");
  const value = firstValue(values, field.defaultValue ?? "");

  if (bindingKey === "title") return { ...node, title: value || node.title };
  if (node.kind === "story") {
    if (bindingKey === "summary") return { ...node, summary: value };
    if (bindingKey === "linkedChapters") return { ...node, linkedChapters: values };
    if (bindingKey === "storyType") {
      const storyType = value === "start" || value === "ending" || value === "custom" ? value : "custom";
      return { ...node, storyType };
    }
    if (bindingKey === "storyEventContent") {
      return { ...node, storyEvents: values.map((item, index) => ({ id: newId("event"), time: node.storyEvents?.[index]?.time ?? "", content: item, foreshadowing: node.storyEvents?.[index]?.foreshadowing ?? "" })) };
    }
    if (bindingKey === "storyEventTime") {
      return { ...node, storyEvents: values.map((item, index) => ({ id: newId("event"), time: item, content: node.storyEvents?.[index]?.content ?? "", foreshadowing: node.storyEvents?.[index]?.foreshadowing ?? "" })) };
    }
    if (bindingKey === "storyEventForeshadowing") {
      return { ...node, storyEvents: values.map((item, index) => ({ id: newId("event"), time: node.storyEvents?.[index]?.time ?? "", content: node.storyEvents?.[index]?.content ?? "", foreshadowing: item })) };
    }
  }
  if (node.kind === "character") {
    if (bindingKey === "characterName") return { ...node, characterName: value };
    if (bindingKey === "identity") return { ...node, identity: value };
    if (bindingKey === "relationshipTarget") {
      return { ...node, relationships: values.map((item, index) => ({ id: newId("rel"), target: item, description: node.relationships?.[index]?.description ?? "" })) };
    }
    if (bindingKey === "relationshipDescription") {
      return { ...node, relationships: values.map((item, index) => ({ id: newId("rel"), target: node.relationships?.[index]?.target ?? "", description: item })) };
    }
    if (bindingKey === "characterEventTime") {
      return { ...node, characterEvents: values.map((item, index) => ({ id: newId("character-event"), time: item, story: node.characterEvents?.[index]?.story ?? "", location: node.characterEvents?.[index]?.location ?? "" })) };
    }
    if (bindingKey === "characterEventStory") {
      return { ...node, characterEvents: values.map((item, index) => ({ id: newId("character-event"), time: node.characterEvents?.[index]?.time ?? "", story: item, location: node.characterEvents?.[index]?.location ?? "" })) };
    }
    if (bindingKey === "characterEventLocation") {
      return { ...node, characterEvents: values.map((item, index) => ({ id: newId("character-event"), time: node.characterEvents?.[index]?.time ?? "", story: node.characterEvents?.[index]?.story ?? "", location: item })) };
    }
  }
  return node;
};

const applyTemplateBindings = (node: BlueprintNode, template?: BlueprintNodeTemplate): BlueprintNode =>
  (template?.fields ?? []).reduce(applyTemplateBinding, node);

const normalizeCustomFields = (fields: BlueprintNode["customFields"]): BlueprintNode["customFields"] =>
  Array.isArray(fields)
    ? fields.map((field) => {
        const values = ensureValues(field.values, field.value ?? "");
        return {
          id: field.id ?? newId("field"),
          key: field.key ?? "",
          value: values[0] ?? "",
          values,
          inputMode: field.inputMode ?? "repeatable",
          bindingKey: field.bindingKey ?? "custom",
          showInCard: field.showInCard ?? true,
        };
      })
    : [];

const createEmptyBlueprint = (name: string): BlueprintDocument => ({
  id: newId("blueprint"),
  name,
  updatedAt: new Date().toISOString(),
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

const createNode = (kind: BlueprintNodeKind, x: number, y: number, template?: BlueprintNodeTemplate): BlueprintNode => applyTemplateBindings({
  id: newId("node"),
  kind,
  x,
  y,
  title: kind === "story" ? "剧情节点" : kind === "character" ? "人物节点" : template?.name ?? "自定义节点",
  storyType: kind === "story" ? "custom" : undefined,
  summary: kind === "story" ? "" : undefined,
  linkedChapters: kind === "story" ? [] : undefined,
  storyEvents: kind === "story" ? [] : undefined,
  characterName: kind === "character" ? "" : undefined,
  identity: kind === "character" ? "" : undefined,
  relationships: kind === "character" ? [] : undefined,
  characterEvents: kind === "character" ? [] : undefined,
  templateName: template?.name ?? (kind === "custom" ? "" : undefined),
  inputCount: kind === "custom" ? template?.inputCount ?? 1 : undefined,
  customFields: template ? fieldsFromTemplate(template, kind) : kind === "custom" ? [] : undefined,
  ...(template ? { title: template.name } : {}),
}, template);

const normalizeNode = (node: BlueprintNode): BlueprintNode => {
  if (node.kind === "story") {
    const linkedChapters = Array.isArray(node.linkedChapters)
      ? node.linkedChapters
      : node.linkedChapter
        ? [node.linkedChapter]
        : [];
    const storyEvents = Array.isArray(node.storyEvents)
      ? node.storyEvents
      : (node.time || node.foreshadowing)
        ? [{
            id: newId("event"),
            time: node.time ?? "",
            content: "",
            foreshadowing: node.foreshadowing ?? "",
          }]
        : [];

    return {
      ...node,
      storyType: node.storyType ?? "custom",
      summary: node.summary ?? "",
      linkedChapters,
      storyEvents,
      customFields: normalizeCustomFields(node.customFields),
    };
  }

  if (node.kind === "custom") {
    return {
      ...node,
      title: node.title ?? node.templateName ?? "自定义节点",
      templateName: node.templateName ?? node.title ?? "",
      inputCount: Math.max(1, Number(node.inputCount) || 1),
      customFields: normalizeCustomFields(node.customFields),
    };
  }

  const relationships = Array.isArray(node.relationships)
    ? node.relationships.map((relationship) => {
        const legacyDescription = [relationship.relation, relationship.identity].filter(Boolean).join(" · ");
        return {
          id: relationship.id ?? newId("rel"),
          target: relationship.target ?? relationship.name ?? "",
          description: relationship.description ?? legacyDescription,
        };
      })
    : node.relationship
      ? [{ id: newId("rel"), target: "", description: node.relationship }]
      : [];

  return {
    ...node,
    characterName: node.characterName ?? "",
    identity: node.identity ?? "",
    relationships,
    characterEvents: Array.isArray(node.characterEvents)
      ? node.characterEvents.map((event) => ({
          id: event.id ?? newId("character-event"),
          time: event.time ?? "",
          story: event.story ?? "",
          location: event.location ?? "",
        }))
      : [],
    customFields: normalizeCustomFields(node.customFields),
  };
};

const normalizeBlueprint = (blueprint: BlueprintDocument): BlueprintDocument => ({
  ...blueprint,
  nodes: Array.isArray(blueprint.nodes) ? blueprint.nodes.map(normalizeNode) : [],
  edges: Array.isArray(blueprint.edges) ? blueprint.edges : [],
  viewport: blueprint.viewport ?? { x: 0, y: 0, zoom: 1 },
});

const normalizeTemplate = (template: BlueprintNodeTemplate): BlueprintNodeTemplate => {
  const now = new Date().toISOString();
  return {
    ...template,
    name: template.name ?? "",
    nodeKind: template.nodeKind ?? "custom",
    inputCount: Math.max(1, Number(template.inputCount) || 1),
    fields: Array.isArray(template.fields)
      ? template.fields.map((field) => {
          const defaultValues = ensureValues(field.defaultValues, field.defaultValue ?? "");
          return {
            id: field.id ?? newId("template-field"),
            key: field.key ?? "",
            defaultValue: defaultValues[0] ?? "",
            defaultValues,
            inputMode: field.inputMode ?? "repeatable",
            bindingKey: (field.bindingKey ?? "custom") as BlueprintFieldBindingKey,
            showInCard: field.showInCard ?? true,
          };
        })
      : [],
    createdAt: template.createdAt ?? now,
    updatedAt: template.updatedAt ?? now,
  };
};

interface BlueprintState {
  blueprints: BlueprintDocument[];
  templates: BlueprintNodeTemplate[];
  focusedNodeByBlueprintId: Record<string, string | null>;
  undoStacks: Record<string, BlueprintDocument[]>;
  isLoading: boolean;
  errorMessage: string | null;
  templateErrorMessage: string | null;
  loadBlueprints: () => Promise<void>;
  loadTemplates: () => Promise<void>;
  createBlueprint: (name?: string) => Promise<BlueprintDocument>;
  saveBlueprint: (blueprint: BlueprintDocument) => Promise<void>;
  deleteBlueprint: (id: string) => Promise<void>;
  renameBlueprint: (id: string, name: string) => Promise<void>;
  pushUndo: (blueprintId: string) => void;
  undoBlueprint: (blueprintId: string) => void;
  replaceBlueprint: (blueprint: BlueprintDocument, options?: { skipUndo?: boolean; skipPersist?: boolean }) => void;
  addNode: (blueprintId: string, kind: BlueprintNodeKind, x?: number, y?: number) => void;
  createCustomNodeFromTemplate: (blueprintId: string, templateId: string, x?: number, y?: number) => void;
  updateNode: (blueprintId: string, nodeId: string, patch: Partial<BlueprintNode>, options?: { skipUndo?: boolean; skipPersist?: boolean }) => void;
  deleteNode: (blueprintId: string, nodeId: string) => void;
  deleteNodes: (blueprintId: string, nodeIds: string[]) => void;
  addEdge: (blueprintId: string, from: string, to: string) => void;
  deleteEdge: (blueprintId: string, edgeId: string) => void;
  focusNode: (blueprintId: string, nodeId: string | null) => void;
  saveTemplate: (template: BlueprintNodeTemplate) => Promise<BlueprintNodeTemplate | null>;
  deleteTemplate: (templateId: string) => Promise<void>;
}

export const useBlueprintStore = create<BlueprintState>((set, get) => ({
  blueprints: [],
  templates: [],
  focusedNodeByBlueprintId: {},
  undoStacks: {},
  isLoading: false,
  errorMessage: null,
  templateErrorMessage: null,
  loadBlueprints: async () => {
    set({ isLoading: true, errorMessage: null });
    try {
      const blueprints = (await listBlueprints()).map(normalizeBlueprint);
      set({
        blueprints: blueprints.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        isLoading: false,
      });
    } catch (error) {
      set({ isLoading: false, errorMessage: error instanceof Error ? error.message : "Failed to load blueprints." });
    }
  },
  loadTemplates: async () => {
    try {
      const templates = (await listBlueprintTemplates()).map(normalizeTemplate);
      set({
        templates: templates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        templateErrorMessage: null,
      });
    } catch (error) {
      set({ templateErrorMessage: error instanceof Error ? error.message : "Failed to load blueprint templates." });
    }
  },
  createBlueprint: async (name = "新蓝图") => {
    const blueprint = createEmptyBlueprint(name);
    const saved = normalizeBlueprint(await saveBlueprintOnDisk(blueprint));
    set((state) => ({
      blueprints: [saved, ...state.blueprints],
      errorMessage: null,
    }));
    return saved;
  },
  saveBlueprint: async (blueprint) => {
    const next = normalizeBlueprint({ ...blueprint, updatedAt: new Date().toISOString() });
    const saved = normalizeBlueprint(await saveBlueprintOnDisk(next));
    set((state) => ({
      blueprints: state.blueprints.some((item) => item.id === saved.id)
        ? state.blueprints.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...state.blueprints],
      errorMessage: null,
    }));
  },
  deleteBlueprint: async (id) => {
    const blueprints = (await deleteBlueprintFromDisk(id)).map(normalizeBlueprint);
    set((state) => {
      const nextFocused = { ...state.focusedNodeByBlueprintId };
      delete nextFocused[id];
      return { blueprints, focusedNodeByBlueprintId: nextFocused, errorMessage: null };
    });
  },
  renameBlueprint: async (id, name) => {
    const renamed = await renameBlueprintOnDisk(id, name);
    if (!renamed) return;
    const normalized = normalizeBlueprint(renamed);
    set((state) => ({
      blueprints: state.blueprints.map((item) => (item.id === id ? normalized : item)),
      errorMessage: null,
    }));
  },
  pushUndo: (blueprintId) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint) return;
    set((state) => ({
      undoStacks: {
        ...state.undoStacks,
        [blueprintId]: [...(state.undoStacks[blueprintId] ?? []), structuredClone(blueprint)].slice(-50),
      },
    }));
  },
  undoBlueprint: (blueprintId) => {
    const stack = get().undoStacks[blueprintId] ?? [];
    const previous = stack[stack.length - 1];
    if (!previous) return;
    set((state) => ({
      blueprints: state.blueprints.map((item) => (item.id === blueprintId ? previous : item)),
      undoStacks: {
        ...state.undoStacks,
        [blueprintId]: stack.slice(0, -1),
      },
      focusedNodeByBlueprintId: {
        ...state.focusedNodeByBlueprintId,
        [blueprintId]: previous.nodes.some((node) => node.id === state.focusedNodeByBlueprintId[blueprintId])
          ? state.focusedNodeByBlueprintId[blueprintId]
          : null,
      },
    }));
    void saveBlueprintOnDisk(previous);
  },
  replaceBlueprint: (blueprint, options) => {
    if (!options?.skipUndo) get().pushUndo(blueprint.id);
    const next = normalizeBlueprint({ ...blueprint, updatedAt: new Date().toISOString() });
    set((state) => ({
      blueprints: state.blueprints.map((item) => (item.id === next.id ? next : item)),
    }));
    if (!options?.skipPersist) void saveBlueprintOnDisk(next);
  },
  addNode: (blueprintId, kind, x = 120, y = 120) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint) return;
    const node = createNode(kind, x, y);
    get().replaceBlueprint({ ...blueprint, nodes: [...blueprint.nodes, node] });
    get().focusNode(blueprintId, node.id);
  },
  createCustomNodeFromTemplate: (blueprintId, templateId, x = 160, y = 160) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    const template = get().templates.find((item) => item.id === templateId);
    if (!blueprint || !template) return;
    const node = createNode(template.nodeKind ?? "custom", x, y, template);
    get().replaceBlueprint({ ...blueprint, nodes: [...blueprint.nodes, node] });
    get().focusNode(blueprintId, node.id);
  },
  updateNode: (blueprintId, nodeId, patch, options) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint) return;
    get().replaceBlueprint({
      ...blueprint,
      nodes: blueprint.nodes.map((node) => (node.id === nodeId ? normalizeNode({ ...node, ...patch }) : node)),
    }, options);
  },
  deleteNode: (blueprintId, nodeId) => {
    get().deleteNodes(blueprintId, [nodeId]);
  },
  deleteNodes: (blueprintId, nodeIds) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint) return;
    const ids = new Set(nodeIds);
    get().replaceBlueprint({
      ...blueprint,
      nodes: blueprint.nodes.filter((node) => !ids.has(node.id)),
      edges: blueprint.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)),
    });
    get().focusNode(blueprintId, null);
  },
  addEdge: (blueprintId, from, to) => {
    if (from === to) return;
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint || blueprint.edges.some((edge) => edge.from === from && edge.to === to)) return;
    const edge: BlueprintEdge = { id: newId("edge"), from, to };
    get().replaceBlueprint({ ...blueprint, edges: [...blueprint.edges, edge] });
  },
  deleteEdge: (blueprintId, edgeId) => {
    const blueprint = get().blueprints.find((item) => item.id === blueprintId);
    if (!blueprint) return;
    get().replaceBlueprint({ ...blueprint, edges: blueprint.edges.filter((edge) => edge.id !== edgeId) });
  },
  focusNode: (blueprintId, nodeId) => {
    set((state) => ({
      focusedNodeByBlueprintId: {
        ...state.focusedNodeByBlueprintId,
        [blueprintId]: nodeId,
      },
    }));
  },
  saveTemplate: async (template) => {
    const normalized = normalizeTemplate(template);
    const name = normalized.name.trim();
    if (!name) {
      set({ templateErrorMessage: "Template name is required." });
      return null;
    }
    if (get().templates.some((item) => item.id !== normalized.id && item.name.trim() === name)) {
      set({ templateErrorMessage: "Template name already exists." });
      return null;
    }
    const saved = normalizeTemplate(await saveBlueprintTemplateOnDisk({ ...normalized, name }));
    set((state) => ({
      templates: state.templates.some((item) => item.id === saved.id)
        ? state.templates.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...state.templates],
      templateErrorMessage: null,
    }));
    return saved;
  },
  deleteTemplate: async (templateId) => {
    const templates = (await deleteBlueprintTemplateFromDisk(templateId)).map(normalizeTemplate);
    set({ templates, templateErrorMessage: null });
  },
}));
