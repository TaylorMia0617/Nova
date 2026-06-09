import type { BlueprintDocument, BlueprintEdgeRole, BlueprintLogicTree, BlueprintNodeLayer, BlueprintTypedData, BlueprintTypedNodeType } from "../types/blueprint";

export type BlueprintIrNode = {
  id: string;
  title: string;
  layer: BlueprintNodeLayer;
  nodeType: BlueprintTypedNodeType;
  linkedChapters: string[];
  parentChapterId?: string;
  parentStructureId?: string;
  typedData: BlueprintTypedData;
  logicTree?: BlueprintLogicTree;
};

export type BlueprintIrEdge = {
  id: string;
  from: string;
  to: string;
  role: BlueprintEdgeRole;
};

export type BlueprintIrDocument = {
  id: string;
  name: string;
  updatedAt: string;
  nodes: BlueprintIrNode[];
  edges: BlueprintIrEdge[];
};

export function exportBlueprintIr(blueprint: BlueprintDocument): BlueprintIrDocument {
  return {
    id: blueprint.id,
    name: blueprint.name,
    updatedAt: blueprint.updatedAt,
    nodes: blueprint.nodes.map((node) => ({
      id: node.id,
      title: node.title || node.templateName || node.characterName || "Untitled",
      layer: node.layer ?? "story",
      nodeType: node.nodeType ?? "custom",
      linkedChapters: node.linkedChapters ?? [],
      parentChapterId: node.parentChapterId,
      parentStructureId: node.parentStructureId ?? node.typedData?.parentStructureId as string | undefined,
      typedData: node.typedData ?? {},
      logicTree: node.typedData?.logicTree,
    })),
    edges: blueprint.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      role: edge.role ?? "flow",
    })),
  };
}
