/**
 * Agent Handoff Graph – Execution graph analysis for workflow optimization
 *
 * Extracted from agent-handoff-log.js (ADR-33 Phase 4) to isolate the
 * graph-based critical path analysis from the main log orchestrator.
 *
 * This module provides:
 *   - ExecutionGraph class – DAG-based critical path and bottleneck analysis
 *
 * @module agent-handoff-graph
 */

'use strict';

// ─── Enhanced Tracing ─────────────────────────────────────────────────────────

/**
 * ExecutionGraph – Track input/output characteristics for change detection
 * and quality analysis. Uses DAG-based critical path algorithm.
 */
class ExecutionGraph {
  constructor() {
    this.nodes = new Map(); // nodeId -> { id, durationMs, dependencies: [], dependents: [] }
    this.edges = [];        // [{ from, to, dataFlow }]
  }

  addNode(trace) {
    if (!this.nodes.has(trace.agentId)) {
      this.nodes.set(trace.agentId, {
        id: trace.agentId,
        durationMs: trace.performance?.duration || 0,
        inputSize: trace.input?.size || 0,
        outputSize: trace.output?.size || 0,
        dependencies: [],
        dependents: [],
        criticalPathWeight: 0,
      });
    }
  }

  addEdge(from, to, dataFlow = null) {
    this.edges.push({ from, to, dataFlow });
    const fromNode = this.nodes.get(from);
    const toNode = this.nodes.get(to);
    if (fromNode && toNode) {
      toNode.dependencies.push(from);
      fromNode.dependents.push(to);
    }
  }

  /**
   * Find critical path using longest path algorithm (DAG)
   * Returns the sequence of nodes that form the critical path
   */
  findCriticalPath() {
    // Topological sort
    const inDegree = new Map();
    for (const [id, node] of this.nodes) {
      inDegree.set(id, node.dependencies.length);
    }

    const queue = [];
    const distances = new Map();
    const predecessors = new Map();

    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
        distances.set(id, this.nodes.get(id).durationMs);
        predecessors.set(id, null);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      const currentNode = this.nodes.get(current);

      for (const dependent of currentNode.dependents) {
        const dependentNode = this.nodes.get(dependent);
        const newDistance = (distances.get(current) || 0) + dependentNode.durationMs;

        if (newDistance > (distances.get(dependent) || 0)) {
          distances.set(dependent, newDistance);
          predecessors.set(dependent, current);
        }

        const newDegree = inDegree.get(dependent) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    // Find the node with maximum distance (end of critical path)
    let maxDistance = 0;
    let endNode = null;
    for (const [id, dist] of distances) {
      if (dist > maxDistance) {
        maxDistance = dist;
        endNode = id;
      }
    }

    // Reconstruct path
    const path = [];
    let current = endNode;
    while (current) {
      path.unshift(current);
      current = predecessors.get(current);
    }

    return {
      path,
      totalDuration: maxDistance,
      nodes: path.map(id => ({
        id,
        durationMs: this.nodes.get(id).durationMs,
        impact: this.nodes.get(id).durationMs / maxDistance,
      })),
    };
  }

  /**
   * Find bottlenecks - nodes that significantly impact total duration
   */
  findBottlenecks(threshold = 0.15) {
    const criticalPath = this.findCriticalPath();
    const bottlenecks = [];

    for (const node of criticalPath.nodes) {
      if (node.impact >= threshold) {
        const nodeData = this.nodes.get(node.id);
        bottlenecks.push({
          stage: node.id,
          durationMs: node.durationMs,
          impact: node.impact,
          inputSize: nodeData.inputSize,
          outputSize: nodeData.outputSize,
        });
      }
    }

    bottlenecks.sort((a, b) => b.impact - a.impact);
    return bottlenecks;
  }

  /**
   * Generate optimization suggestions based on bottlenecks
   */
  suggestOptimizations(bottlenecks) {
    const suggestions = [];

    for (const b of bottlenecks) {
      if (b.impact > 0.3) {
        suggestions.push({
          stage: b.stage,
          severity: 'high',
          suggestion: `${b.stage} accounts for ${(b.impact * 100).toFixed(1)}% of total time. Consider: 1) Parallel processing, 2) Model tier optimization, 3) Input size reduction (current: ${b.inputSize} chars)`,
        });
      } else if (b.impact > 0.15) {
        suggestions.push({
          stage: b.stage,
          severity: 'medium',
          suggestion: `${b.stage} is a moderate bottleneck (${(b.impact * 100).toFixed(1)}%). Review prompt efficiency and model selection.`,
        });
      }
    }

    return suggestions;
  }

  toMermaid() {
    const lines = ['flowchart LR'];
    const nodeStyles = new Map();

    for (const [id, node] of this.nodes) {
      lines.push(`    ${id}[${id}]`);
      if (node.durationMs > 30000) {
        nodeStyles.set(id, 'fill:#ffcccc');
      } else if (node.durationMs > 10000) {
        nodeStyles.set(id, 'fill:#ffffcc');
      } else {
        nodeStyles.set(id, 'fill:#ccffcc');
      }
    }

    for (const edge of this.edges) {
      lines.push(`    ${edge.from} --> ${edge.to}`);
    }

    for (const [node, style] of nodeStyles) {
      lines.push(`    style ${node} ${style}`);
    }

    return lines.join('\n');
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  ExecutionGraph,
};
