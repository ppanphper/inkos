import type { StoryGraph, StoryNode } from "./graph-schema.js";

export interface ValidationIssue {
  readonly code: "DEAD_END" | "BROKEN_LINK" | "UNREACHABLE" | "NO_PATH_TO_ENDING";
  readonly level: "error" | "warning";
  readonly message: string;
  readonly nodeIds: readonly string[];
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

function label(node: StoryNode): string {
  return node.title || node.id;
}

export function validateStoryGraph(graph: StoryGraph): ValidationReport {
  const issues: ValidationIssue[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

  // BROKEN_LINK
  for (const node of graph.nodes) {
    for (const c of node.choices) {
      if (!ids.has(c.targetNodeId)) {
        issues.push({
          code: "BROKEN_LINK",
          level: "error",
          message: `节点「${label(node)}」的选项「${c.text}」指向不存在的节点 ${c.targetNodeId}`,
          nodeIds: [node.id],
        });
      }
    }
  }

  // DEAD_END：非结局节点没有任何指向存在节点的出口
  for (const node of graph.nodes) {
    if (node.type === "ending") continue;
    const hasExit = node.choices.some((c) => ids.has(c.targetNodeId));
    if (!hasExit) {
      issues.push({
        code: "DEAD_END",
        level: "error",
        message: `节点「${label(node)}」是死路：没有任何有效出口`,
        nodeIds: [node.id],
      });
    }
  }

  // 可达性 BFS
  const start = graph.nodes.find((n) => n.type === "start") ?? graph.nodes[0];
  const reachable = new Set<string>();
  if (start) {
    const queue = [start.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (reachable.has(cur)) continue;
      reachable.add(cur);
      const n = nodeMap.get(cur);
      if (!n) continue;
      for (const c of n.choices) {
        if (ids.has(c.targetNodeId) && !reachable.has(c.targetNodeId)) queue.push(c.targetNodeId);
      }
    }
  }

  // UNREACHABLE
  for (const node of graph.nodes) {
    if (graph.nodes.length > 1 && !reachable.has(node.id)) {
      issues.push({
        code: "UNREACHABLE",
        level: "warning",
        message: `节点「${label(node)}」从开场无法到达`,
        nodeIds: [node.id],
      });
    }
  }

  // NO_PATH_TO_ENDING
  if (start) {
    let canEnd = false;
    for (const id of reachable) {
      if (nodeMap.get(id)?.type === "ending") { canEnd = true; break; }
    }
    if (!canEnd) {
      issues.push({
        code: "NO_PATH_TO_ENDING",
        level: "error",
        message: `从开场节点「${label(start)}」出发无法到达任何结局`,
        nodeIds: [start.id],
      });
    }
  }

  return { ok: issues.every((i) => i.level !== "error"), issues };
}
