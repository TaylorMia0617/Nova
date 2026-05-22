import type { WorkspaceNode } from "../services/fileSystemService";

export interface WorkspaceIndexes {
  nodeIndex: Record<string, WorkspaceNode>;
  parentIndex: Record<string, string | null>;
}

export function buildWorkspaceIndexes(nodes: WorkspaceNode[]): WorkspaceIndexes {
  const nodeIndex: Record<string, WorkspaceNode> = {};
  const parentIndex: Record<string, string | null> = {};

  const visit = (items: WorkspaceNode[], parentPath: string | null) => {
    for (const item of items) {
      nodeIndex[item.path] = item;
      parentIndex[item.path] = parentPath;

      if (item.children) {
        visit(item.children, item.path);
      }
    }
  };

  visit(nodes, null);

  return {
    nodeIndex,
    parentIndex,
  };
}

export function collectFolderPaths(nodes: WorkspaceNode[]): Set<string> {
  const folderPaths = new Set<string>();

  const visit = (items: WorkspaceNode[]) => {
    for (const item of items) {
      if (item.type === "folder") {
        folderPaths.add(item.path);
        if (item.children) {
          visit(item.children);
        }
      }
    }
  };

  visit(nodes);
  return folderPaths;
}

export function filterWorkspaceNodes(nodes: WorkspaceNode[], query: string): WorkspaceNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes.flatMap((node) => {
    const selfMatches = node.name.toLowerCase().includes(normalizedQuery);

    if (node.type === "file") {
      return selfMatches ? [node] : [];
    }

    const filteredChildren = node.children ? filterWorkspaceNodes(node.children, normalizedQuery) : [];
    if (selfMatches) {
      return [{ ...node, children: node.children, isLoaded: node.isLoaded, hasChildren: node.hasChildren }];
    }

    if (filteredChildren.length > 0) {
      return [{ ...node, children: filteredChildren, isLoaded: true, hasChildren: true }];
    }

    return [];
  });
}
