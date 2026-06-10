import type { BlueprintDocument, BlueprintEdge, BlueprintNode } from "../types/blueprint";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 126;
const START_X = 120;
const START_Y = 120;
const COLUMN_GAP = 120;
const ROW_GAP = 64;
const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;
const ROW_STEP = NODE_HEIGHT + ROW_GAP;
const LAYER_ORDER = ["structure", "story", "narrative", "logic", "control"];
const EDGE_ROLE_ORDER = ["flow", "branch", "merge", "reveal", "logic", "mount"];

function stableNodeSort(left: BlueprintNode, right: BlueprintNode) {
  const leftLayer = LAYER_ORDER.indexOf(left.layer ?? "");
  const rightLayer = LAYER_ORDER.indexOf(right.layer ?? "");
  if (leftLayer !== rightLayer) {
    return (leftLayer === -1 ? LAYER_ORDER.length : leftLayer) - (rightLayer === -1 ? LAYER_ORDER.length : rightLayer);
  }

  const typeCompare = String(left.nodeType ?? "").localeCompare(String(right.nodeType ?? ""), "zh-Hans-CN");
  if (typeCompare !== 0) return typeCompare;

  const titleCompare = String(left.title ?? left.characterName ?? "").localeCompare(String(right.title ?? right.characterName ?? ""), "zh-Hans-CN");
  if (titleCompare !== 0) return titleCompare;

  return left.id.localeCompare(right.id);
}

function stableEdgeSort(left: BlueprintEdge, right: BlueprintEdge) {
  const leftRole = EDGE_ROLE_ORDER.indexOf(left.role ?? "flow");
  const rightRole = EDGE_ROLE_ORDER.indexOf(right.role ?? "flow");
  if (leftRole !== rightRole) {
    return (leftRole === -1 ? EDGE_ROLE_ORDER.length : leftRole) - (rightRole === -1 ? EDGE_ROLE_ORDER.length : rightRole);
  }
  return left.id.localeCompare(right.id);
}

function buildLevels(nodes: BlueprintNode[], edges: BlueprintEdge[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, BlueprintEdge[]>();

  for (const node of nodes) {
    incoming.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge);
  }

  for (const edgeList of outgoing.values()) {
    edgeList.sort(stableEdgeSort);
  }

  const levels = new Map<string, number>();
  const queue = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort(stableNodeSort)
    .map((node) => node.id);

  for (const id of queue) {
    levels.set(id, 0);
  }

  let cursor = 0;
  while (cursor < queue.length) {
    const id = queue[cursor];
    cursor += 1;
    const currentLevel = levels.get(id) ?? 0;
    for (const edge of outgoing.get(id) ?? []) {
      const nextLevel = Math.max(levels.get(edge.to) ?? 0, currentLevel + 1);
      if ((levels.get(edge.to) ?? -1) < nextLevel) {
        levels.set(edge.to, nextLevel);
        queue.push(edge.to);
      }
    }
  }

  let fallbackLevel = levels.size ? Math.max(...levels.values()) + 1 : 0;
  for (const node of nodes.sort(stableNodeSort)) {
    if (!levels.has(node.id)) {
      levels.set(node.id, fallbackLevel);
      fallbackLevel += 1;
    }
  }

  return levels;
}

export function autoLayoutBlueprint(blueprint: BlueprintDocument): BlueprintDocument {
  if (blueprint.nodes.length === 0) {
    return {
      ...blueprint,
      viewport: { x: 0, y: 0, zoom: blueprint.viewport?.zoom ?? 1 },
      updatedAt: new Date().toISOString(),
    };
  }

  const levels = buildLevels([...blueprint.nodes], blueprint.edges);
  const columns = new Map<number, BlueprintNode[]>();

  for (const node of blueprint.nodes) {
    const level = levels.get(node.id) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), node]);
  }

  const positionedNodes = new Map<string, BlueprintNode>();
  const sortedColumns = [...columns.entries()].sort(([left], [right]) => left - right);

  for (const [level, columnNodes] of sortedColumns) {
    const sortedNodes = columnNodes.sort(stableNodeSort);
    const columnHeight = sortedNodes.length * NODE_HEIGHT + Math.max(0, sortedNodes.length - 1) * ROW_GAP;
    const columnStartY = Math.max(START_Y, START_Y + Math.round((Math.max(0, 3 * ROW_STEP - columnHeight)) / 2));

    sortedNodes.forEach((node, index) => {
      positionedNodes.set(node.id, {
        ...node,
        x: START_X + level * COLUMN_STEP,
        y: columnStartY + index * ROW_STEP,
      });
    });
  }

  return {
    ...blueprint,
    nodes: blueprint.nodes.map((node) => positionedNodes.get(node.id) ?? node),
    viewport: {
      x: 0,
      y: 0,
      zoom: Math.min(Math.max(blueprint.viewport?.zoom ?? 1, 0.7), 1),
    },
    updatedAt: new Date().toISOString(),
  };
}
