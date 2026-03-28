/**
 * Agent Handoff Log – Tracks inter-agent workflow state transitions
 *
 * Design Goals:
 *   - Visualize the "handoff" flow between agents (ANALYST → ARCHITECT → PLANNER → DEVELOPER → TESTER)
 *   - Record artifact paths, metadata, timing, and success/failure states
 *   - Provide both human-readable console output and machine-parseable JSONL logs
 *   - Track rollbacks and retries as part of the handoff history
 *   - NEW: Track internal Agent activities (prompt calls, code scanning, etc.)
 *
 * Integration Points:
 *   - Injected into FileRefBus to capture all publish() calls
 *   - Called from StageRunner to record stage execution context
 *   - NEW: Used by BaseAgent to log prompt calls
 *   - NEW: Used by DeepAudit checks to log scanning activities
 *   - Compatible with logger.js – uses structured logging conventions
 *
 * Visual Style: Inspired by comprehensive-module-test.js
 *   - Box-drawing characters (┌─┐│└─┘) for visual hierarchy
 *   - Emojis for quick status recognition (🔄 ✅ ❌ ⚠️)
 *   - ASCII art banners for major sections
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Handoff States ───────────────────────────────────────────────────────────

const HandoffState = {
  READY:     'ready',     // Handoff initialized, waiting for source agent
  IN_TRANSIT:'in_transit',// Source completed, artifact published
  CONSUMED:  'consumed',  // Target agent consumed the artifact
  PROCESSING:'processing',// Target agent is actively processing
  COMPLETED: 'completed', // Target agent finished successfully
  FAILED:    'failed',    // Target agent encountered an error
  ROLLBACK:  'rollback',  // Rollback triggered, returning to previous stage
};

const StateIcon = {
  [HandoffState.READY]:      '⏳',
  [HandoffState.IN_TRANSIT]: '📤',
  [HandoffState.CONSUMED]:   '📥',
  [HandoffState.PROCESSING]: '⚙️',
  [HandoffState.COMPLETED]:  '✅',
  [HandoffState.FAILED]:     '❌',
  [HandoffState.ROLLBACK]:   '⏪',
};

// ─── Agent Handoff Log Entry ──────────────────────────────────────────────────

class HandoffEntry {
  /**
   * @param {object} opts
   * @param {string} opts.fromAgent      - Source agent role (e.g., 'ANALYST')
   * @param {string} opts.toAgent        - Target agent role (e.g., 'ARCHITECT')
   * @param {string} opts.artifactPath   - Path to the artifact being handed off
   * @param {string} [opts.stage]        - Workflow stage name
   * @param {object} [opts.metadata]     - Additional context (reviewRounds, riskNotes, etc.)
   * @param {string} [opts.sessionId]    - Session identifier for correlation
   */
  constructor(opts) {
    this.id = `${opts.fromAgent}-${opts.toAgent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.timestamp = new Date().toISOString();
    this.fromAgent = opts.fromAgent;
    this.toAgent = opts.toAgent;
    this.artifactPath = opts.artifactPath;
    this.artifactName = path.basename(opts.artifactPath);
    this.stage = opts.stage || null;
    this.metadata = opts.metadata || {};
    this.sessionId = opts.sessionId || null;
    this.state = HandoffState.READY;
    this.timing = {
      publishedAt: null,
      consumedAt: null,
      completedAt: null,
      durationMs: null,
    };
    this.attempt = 1;
    this.rollbackFrom = null; // If this handoff is after a rollback, references original
  }

  publish() {
    this.state = HandoffState.IN_TRANSIT;
    this.timing.publishedAt = new Date().toISOString();
  }

  consume() {
    this.state = HandoffState.CONSUMED;
    this.timing.consumedAt = new Date().toISOString();
  }

  startProcessing() {
    this.state = HandoffState.PROCESSING;
  }

  complete(success = true) {
    this.state = success ? HandoffState.COMPLETED : HandoffState.FAILED;
    this.timing.completedAt = new Date().toISOString();
    if (this.timing.consumedAt) {
      this.timing.durationMs = new Date(this.timing.completedAt) - new Date(this.timing.consumedAt);
    }
  }

  markRollback(originalHandoffId = null) {
    this.state = HandoffState.ROLLBACK;
    this.rollbackFrom = originalHandoffId;
  }

  /**
   * Set enhanced tracing data for input/output
   * @param {object} input - Input information { content?, schema? }
   * @param {object} output - Output information { content?, schema? }
   */
  setEnhancedTracing(input = {}, output = {}) {
    this._enhanced = {
      input: {
        size: input.content ? input.content.length : 0,
        hash: this._computeHash(input.content),
        schema: input.schema || this._inferSchema(input.content),
      },
      output: {
        size: output.content ? output.content.length : 0,
        hash: this._computeHash(output.content),
        schema: output.schema || this._inferSchema(output.content),
      },
    };
  }

  _computeHash(content) {
    if (!content) return null;
    let hash = 0;
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).slice(0, 8);
  }

  _inferSchema(content) {
    if (!content) return 'unknown';
    const str = typeof content === 'string' ? content : JSON.stringify(content);

    if (str.startsWith('# ')) return 'markdown';
    if (str.startsWith('{') || str.startsWith('[')) {
      try {
        JSON.parse(str);
        return 'json';
      } catch { /* not JSON */ }
    }
    if (str.startsWith('<?xml') || str.startsWith('<')) return 'xml';
    if (str.includes('function') || str.includes('class')) return 'code';
    if (str.includes('describe(') || str.includes('test(')) return 'test';
    if (str.includes('interface') || str.includes('type ')) return 'typescript';
    if (str.match(/^\s*[\d\-|,|\/]+\n[│├└─]/m)) return 'tree';
    return 'text';
  }

  toJSON() {
    const base = {
      id: this.id,
      timestamp: this.timestamp,
      fromAgent: this.fromAgent,
      toAgent: this.toAgent,
      artifactPath: this.artifactPath,
      artifactName: this.artifactName,
      stage: this.stage,
      state: this.state,
      timing: this.timing,
      metadata: this.metadata,
      attempt: this.attempt,
      sessionId: this.sessionId,
      rollbackFrom: this.rollbackFrom,
    };

    if (this._enhanced) {
      base.enhanced = this._enhanced;
    }

    return base;
  }
}

// ─── Enhanced Tracing ─────────────────────────────────────────────────────────

/**
 * Enhanced Tracing Data Structures
 * Track input/output characteristics for change detection and quality analysis
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

    // Sort by impact descending
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

// ─── Enhanced HandoffEntry ────────────────────────────────────────────────────

// Extend HandoffEntry with hash and schema tracking
const originalHandoffEntryConstructor = HandoffEntry.prototype.constructor;

Object.assign(HandoffEntry.prototype, {
  /**
   * Set enhanced tracing data for input/output
   * @param {object} input - Input information
   * @param {string} input.content - Raw input content
   * @param {string} input.schema - Inferred schema type
   * @param {object} output - Output information
   * @param {string} output.content - Raw output content
   * @param {string} output.schema - Inferred schema type
   */
  setEnhancedTracing(input = {}, output = {}) {
    this._enhanced = {
      input: {
        size: input.content ? input.content.length : 0,
        hash: this._computeHash(input.content),
        schema: input.schema || this._inferSchema(input.content),
      },
      output: {
        size: output.content ? output.content.length : 0,
        hash: this._computeHash(output.content),
        schema: output.schema || this._inferSchema(output.content),
      },
    };
  },

  _computeHash(content) {
    if (!content) return null;
    // Simple hash function for content fingerprinting
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).slice(0, 8);
  },

  _inferSchema(content) {
    if (!content) return 'unknown';
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    
    // Detect content type based on patterns
    if (str.startsWith('# ')) return 'markdown';
    if (str.startsWith('{') || str.startsWith('[')) {
      try {
        JSON.parse(str);
        return 'json';
      } catch { /* not JSON */ }
    }
    if (str.startsWith('<?xml') || str.startsWith('<')) return 'xml';
    if (str.includes('function') || str.includes('class')) return 'code';
    if (str.includes('describe(') || str.includes('test(')) return 'test';
    if (str.includes('interface') || str.includes('type ')) return 'typescript';
    if (str.match(/^\s*[\d\-|,|\/]+\n[│├└─]/m)) return 'tree';
    return 'text';
  },

  toJSON() {
    const base = {
      id: this.id,
      timestamp: this.timestamp,
      fromAgent: this.fromAgent,
      toAgent: this.toAgent,
      artifactPath: this.artifactPath,
      artifactName: this.artifactName,
      stage: this.stage,
      state: this.state,
      timing: this.timing,
      metadata: this.metadata,
      attempt: this.attempt,
      sessionId: this.sessionId,
      rollbackFrom: this.rollbackFrom,
    };

    if (this._enhanced) {
      base.enhanced = this._enhanced;
    }

    return base;
  },
});

// ─── Agent Handoff Log ────────────────────────────────────────────────────────

class AgentHandoffLog {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.outputDir]     - Directory for log files
   * @param {string}  [opts.sessionId]     - Session identifier
   * @param {boolean} [opts.jsonMode=false]- Force JSON-only output
   * @param {boolean} [opts.verbose=true]  - Print human-readable logs to console
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || null;
    this._sessionId = opts.sessionId || null;
    this._jsonMode = opts.jsonMode || false;
    this._verbose = opts.verbose !== false;
    this._handoffs = [];      // All handoff entries
    this._active = new Map(); // Currently in-flight handoffs (toAgent -> entry)
    this._logStream = null;
    this._entryCount = 0;
  }

  /**
   * Set the output directory for log files.
   */
  setOutputDir(outputDir) {
    this._outputDir = outputDir;
    if (this._logStream) {
      try { this._logStream.end(); } catch (_) {}
      this._logStream = null;
    }
  }

  /**
   * Set the session ID for correlation.
   */
  setSessionId(sessionId) {
    this._sessionId = sessionId;
  }

  // ─── Core Handoff Operations ────────────────────────────────────────────

  /**
   * Initiates a new handoff between agents.
   * Called when FileRefBus.publish() is invoked.
   *
   * @param {string} fromAgent    - Source agent role
   * @param {string} toAgent      - Target agent role
   * @param {string} artifactPath - Path to the artifact file
   * @param {object} [metadata]   - Optional metadata
   * @param {string} [stage]      - Stage name
   * @returns {HandoffEntry} The created handoff entry
   */
  initiate(fromAgent, toAgent, artifactPath, metadata = {}, stage = null) {
    // Check for existing active handoff to this agent (rollback scenario)
    const existing = this._active.get(toAgent);
    if (existing) {
      // Mark the old one as superseded by rollback
      existing.markRollback();
      this._logHandoff(existing, 'ROLLBACK_TRIGGERED');
    }

    const entry = new HandoffEntry({
      fromAgent,
      toAgent,
      artifactPath,
      metadata,
      stage: stage || this._inferStage(fromAgent, toAgent),
      sessionId: this._sessionId,
    });

    // If this looks like a retry, increment attempt counter
    if (existing) {
      entry.attempt = existing.attempt + 1;
      entry.rollbackFrom = existing.id;
    }

    entry.publish();
    this._handoffs.push(entry);
    this._active.set(toAgent, entry);
    this._entryCount++;

    this._logHandoff(entry, 'PUBLISH');
    this._writeToFile(entry);

    return entry;
  }

  /**
   * Records that the target agent has consumed the artifact.
   * Called automatically when FileRefBus.consume() is invoked.
   *
   * @param {string} toAgent - The agent that consumed the artifact
   * @returns {HandoffEntry|null}
   */
  consume(toAgent) {
    const entry = this._active.get(toAgent);
    if (!entry) {
      this._warn(`No active handoff found for agent: ${toAgent}`);
      return null;
    }

    entry.consume();
    this._logHandoff(entry, 'CONSUME');
    this._writeToFile(entry);

    return entry;
  }

  /**
   * Marks the handoff as being processed by the target agent.
   *
   * @param {string} toAgent - The agent that is processing
   * @returns {HandoffEntry|null}
   */
  startProcessing(toAgent) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.startProcessing();
    this._logHandoff(entry, 'PROCESSING');
    this._writeToFile(entry);

    return entry;
  }

  /**
   * Completes the handoff (success or failure).
   *
   * @param {string} toAgent  - The agent that completed processing
   * @param {boolean} success - Whether processing succeeded
   * @param {object} [result] - Optional result metadata
   * @returns {HandoffEntry|null}
   */
  complete(toAgent, success = true, result = {}) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.complete(success);
    if (result) {
      Object.assign(entry.metadata, result);
    }

    this._logHandoff(entry, success ? 'COMPLETE' : 'FAILED');
    this._writeToFile(entry);

    // Keep in _active for potential retry tracking, but mark completion
    return entry;
  }

  /**
   * Records a rollback event.
   *
   * @param {string} fromStage - Stage rolling back from
   * @param {string} toStage   - Stage rolling back to
   * @param {string} reason    - Reason for rollback
   */
  recordRollback(fromStage, toStage, reason) {
    const rollbackEntry = {
      type: 'ROLLBACK_EVENT',
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      fromStage,
      toStage,
      reason,
    };

    if (this._verbose && !this._jsonMode) {
      console.log(`\n  ⏪ ROLLBACK: ${fromStage} → ${toStage}`);
      console.log(`     Reason: ${reason.slice(0, 100)}${reason.length > 100 ? '...' : ''}`);
    }

    this._writeToFile(rollbackEntry);
  }

  // ─── Internal Activity Tracking ─────────────────────────────────────────

  /**
   * Records the start of an internal activity (prompt calls, code scanning).
   * Returns an activity handle to be passed to endActivity().
   *
   * @param {string} agent        - Agent name
   * @param {string} activityType - Type: 'prompt', 'scan', 'check', 'review'
   * @param {string} name         - Activity name
   * @param {object} [metadata]   - Additional metadata
   * @returns {string} Activity ID
   */
  startActivity(agent, activityType, name, metadata = {}) {
    const activityId = `${agent}-${activityType}-${name}-${Date.now()}`;
    const activity = {
      type: 'INTERNAL_ACTIVITY',
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      agent,
      activityType,
      name,
      status: 'started',
      metadata,
    };

    // Store for later completion
    if (!this._activeActivities) {
      this._activeActivities = new Map();
    }
    this._activeActivities.set(activityId, { ...activity, startTime: Date.now() });

    if (this._verbose && !this._jsonMode) {
      const icon = this._getActivityIcon(activityType);
      console.log(`    ${icon} ${agent} → ${name}`);
    }

    this._writeToFile(activity);
    return activityId;
  }

  /**
   * Records the completion of an internal activity.
   *
   * @param {string} activityId   - Activity ID from startActivity()
   * @param {object} [result]     - Activity result (durationMs, token counts, etc.)
   * @param {boolean} [success=true] - Whether activity succeeded
   */
  endActivity(activityId, result = {}, success = true) {
    if (!this._activeActivities || !this._activeActivities.has(activityId)) {
      this._warn(`No active activity found for ID: ${activityId}`);
      return null;
    }

    const startRecord = this._activeActivities.get(activityId);
    const durationMs = Date.now() - startRecord.startTime;

    const activity = {
      type: 'INTERNAL_ACTIVITY',
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      agent: startRecord.agent,
      activityType: startRecord.activityType,
      name: startRecord.name,
      status: success ? 'completed' : 'failed',
      durationMs: result.durationMs || durationMs,
      result,
    };

    this._activeActivities.delete(activityId);

    if (this._verbose && !this._jsonMode) {
      const icon = success ? '✅' : '❌';
      console.log(`      ${icon} ${startRecord.name} (${this._formatDuration(durationMs)})`);
    }

    this._writeToFile(activity);
    return activity;
  }

  _getActivityIcon(activityType) {
    const icons = {
      'prompt':    '📝',
      'scan':      '🔍',
      'check':     '✓',
      'review':    '👁️',
      'analysis':  '📊',
    };
    return icons[activityType] || '•';
  }

  // ─── Visual Output ──────────────────────────────────────────────────────

  /**
   * Prints the main visual header banner.
   * Call this at the start of a workflow session.
   */
  printBanner() {
    if (this._jsonMode) return;

    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║         A G E N T   H A N D O F F   O R C H E S T R A T I O N      ║');
    console.log('║                  Workflow State Transition Log                     ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝');
  }

  /**
   * Prints a section header for a new stage.
   *
   * @param {string} stage - Stage name (e.g., 'ANALYSE')
   * @param {string} agent - Agent name (e.g., 'AnalystAgent')
   */
  printStageHeader(stage, agent) {
    if (this._jsonMode) return;

    console.log(`\n┌────────────────────────────────────────────────────────────────────┐`);
    console.log(`│  STAGE: ${stage.padEnd(56)}│`);
    console.log(`│  AGENT: ${agent.padEnd(56)}│`);
    console.log(`└────────────────────────────────────────────────────────────────────┘`);
  }

  /**
   * Prints a visual summary of all handoffs at workflow end.
   */
  printSummary() {
    if (this._jsonMode) return;

    if (this._handoffs.length === 0) {
      console.log('\n  ℹ️  No handoffs recorded.');
      return;
    }

    console.log('\n' + '═'.repeat(70));
    console.log('           H A N D O F F   F L O W   S U M M A R Y');
    console.log('═'.repeat(70));

    // Group handoffs by attempt number
    const byAttempt = this._groupByAttempt();

    for (const [attempt, handoffs] of Object.entries(byAttempt)) {
      if (parseInt(attempt) > 1) {
        console.log(`\n  🔄 Retry Attempt #${attempt}`);
      }

      for (let i = 0; i < handoffs.length; i++) {
        const h = handoffs[i];
        const isLast = i === handoffs.length - 1;
        const icon = StateIcon[h.state] || '◦';
        const branch = isLast ? '└─' : '├─';
        const duration = h.timing.durationMs
          ? `(${this._formatDuration(h.timing.durationMs)})`
          : '';
        const statusMarker = h.state === HandoffState.FAILED ? '❌'
          : h.state === HandoffState.ROLLBACK ? '⏪'
          : h.state === HandoffState.COMPLETED ? '✅'
          : '→';

        console.log(`  ${branch} ${statusMarker} ${h.fromAgent.padEnd(10)} → ${h.toAgent.padEnd(10)} ${icon} ${duration}`);

        // Show metadata for key handoffs
        if (h.metadata && Object.keys(h.metadata).length > 0 && this._verbose) {
          const metaStr = this._formatMetadata(h.metadata);
          if (metaStr) {
            const metaPrefix = isLast ? '      ' : '   │  ';
            console.log(`${metaPrefix}${metaStr}`);
          }
        }
      }
    }

    // Statistics
    const stats = this._calculateStats();
    console.log('\n  ─────────────────────────────────────────────────────────────────');
    console.log(`  Total Handoffs: ${stats.total}  |  Successful: ${stats.completed} ✅  |  Failed: ${stats.failed} ❌  |  Rollbacks: ${stats.rollbacks} ⏪`);
    console.log('═'.repeat(70));
  }

  /**
   * Generates a Mermaid flowchart of the handoff flow.
   * Can be saved to a file for documentation.
   *
   * @returns {string} Mermaid syntax
   */
  generateMermaidFlowchart() {
    const lines = ['```mermaid', 'flowchart LR'];

    // Track unique connections
    const connections = new Set();
    const nodeStyles = new Map();

    for (const h of this._handoffs) {
      const fromNode = h.fromAgent.toUpperCase().replace(/-/g, '_');
      const toNode = h.toAgent.toUpperCase().replace(/-/g, '_');
      const conn = `${fromNode} --> ${toNode}`;

      if (!connections.has(conn)) {
        connections.add(conn);
        lines.push(`    ${fromNode}[${h.fromAgent}] --> ${toNode}[${h.toAgent}]`);
      }

      // Track styles based on final state
      if (h.state === HandoffState.FAILED) {
        nodeStyles.set(toNode, 'fill:#ffcccc');
      } else if (h.state === HandoffState.ROLLBACK) {
        nodeStyles.set(toNode, 'fill:#ffffcc');
      } else if (h.state === HandoffState.COMPLETED) {
        nodeStyles.set(toNode, 'fill:#ccffcc');
      }
    }

    // Add style definitions
    for (const [node, style] of nodeStyles) {
      lines.push(`    style ${node} ${style}`);
    }

    lines.push('```');
    return lines.join('\n');
  }

  // ─── File Output ────────────────────────────────────────────────────────

  /**
   * Saves the full handoff log to JSON file.
   *
   * @returns {string} Path to the saved file
   */
  saveLog() {
    if (!this._outputDir) return null;

    const logPath = path.join(this._outputDir, 'agent-handoff-log.json');
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }

    const data = {
      sessionId: this._sessionId,
      generatedAt: new Date().toISOString(),
      summary: this._calculateStats(),
      handoffs: this._handoffs.map(h => h.toJSON()),
      mermaidFlowchart: this.generateMermaidFlowchart(),
    };

    // Atomic write
    const tmpPath = logPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, logPath);

    // Also save Mermaid diagram separately
    const mermaidPath = path.join(this._outputDir, 'agent-handoff-flow.mmd');
    fs.writeFileSync(mermaidPath, this.generateMermaidFlowchart(), 'utf-8');

    // Generate enhanced execution analysis
    const analysis = this.analyzeExecutionPath();
    const analysisPath = path.join(this._outputDir, 'execution-analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify({
      sessionId: this._sessionId,
      generatedAt: new Date().toISOString(),
      analysis,
      handoffs: this._handoffs.map(h => h.toJSON()),
    }, null, 2), 'utf-8');

    // Print critical path analysis if verbose
    if (this._verbose && this._handoffs.length > 0) {
      this.printCriticalPathAnalysis();
    }

    if (this._verbose) {
      console.log(`\n  💾 Handoff log saved to: ${logPath}`);
      console.log(`  📊 Flowchart saved to: ${mermaidPath}`);
      console.log(`  🔍 Execution analysis saved to: ${analysisPath}`);
    }

    return logPath;
  }

  /**
   * Flushes and closes the log stream.
   */
  flush() {
    if (this._logStream) {
      try { this._logStream.end(); } catch (_) {}
      this._logStream = null;
    }
    return this.saveLog();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  _logHandoff(entry, eventType) {
    if (!this._verbose || this._jsonMode) return;

    const icon = StateIcon[entry.state] || '◦';
    const artifactName = path.basename(entry.artifactPath);

    switch (eventType) {
      case 'PUBLISH':
        console.log(`  🔄 ${entry.fromAgent} → ${entry.toAgent}: ${artifactName}`);
        break;
      case 'CONSUME':
        console.log(`  📥 ${entry.toAgent} consumed ${artifactName}`);
        break;
      case 'PROCESSING':
        console.log(`  ⚙️  ${entry.toAgent} processing...`);
        break;
      case 'COMPLETE':
        const duration = entry.timing.durationMs
          ? ` (${this._formatDuration(entry.timing.durationMs)})`
          : '';
        console.log(`  ✅ ${entry.toAgent} completed${duration}`);
        break;
      case 'FAILED':
        console.log(`  ❌ ${entry.toAgent} failed`);
        break;
      case 'ROLLBACK_TRIGGERED':
        console.log(`  ⏪ Rollback: ${entry.toAgent} handoff superseded`);
        break;
    }
  }

  _writeToFile(entry) {
    if (!this._outputDir) return;

    try {
      if (!this._logStream) {
        if (!fs.existsSync(this._outputDir)) {
          fs.mkdirSync(this._outputDir, { recursive: true });
        }
        const logPath = path.join(this._outputDir, 'agent-handoff-log.jsonl');
        this._logStream = fs.createWriteStream(logPath, { flags: 'a' });
      }

      const record = entry.toJSON ? entry.toJSON() : entry;
      this._logStream.write(JSON.stringify(record) + '\n');
    } catch (e) {
      this._warn(`Failed to write to log file: ${e.message}`);
    }
  }

  _inferStage(fromAgent, toAgent) {
    const stageMap = {
      'ANALYST→ARCHITECT': 'ANALYSE→ARCHITECT',
      'ARCHITECT→PLANNER': 'ARCHITECT→PLAN',
      'PLANNER→DEVELOPER': 'PLAN→CODE',
      'DEVELOPER→TESTER': 'CODE→TEST',
    };
    return stageMap[`${fromAgent}→${toAgent}`] || null;
  }

  _groupByAttempt() {
    const groups = {};
    for (const h of this._handoffs) {
      const key = h.attempt || 1;
      if (!groups[key]) groups[key] = [];
      groups[key].push(h);
    }
    return groups;
  }

  _calculateStats() {
    const stats = {
      total: this._handoffs.length,
      completed: 0,
      failed: 0,
      rollbacks: 0,
      inProgress: 0,
    };

    for (const h of this._handoffs) {
      if (h.state === HandoffState.COMPLETED) stats.completed++;
      else if (h.state === HandoffState.FAILED) stats.failed++;
      else if (h.state === HandoffState.ROLLBACK) stats.rollbacks++;
      else stats.inProgress++;
    }

    return stats;
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  // ─── Enhanced Tracing & Analysis ───────────────────────────────────────────

  /**
   * Records enhanced tracing data for a handoff.
   * Captures input/output hash, size, and schema for change detection and quality analysis.
   *
   * @param {string} toAgent - Target agent
   * @param {object} input - Input information { content, schema? }
   * @param {object} output - Output information { content, schema? }
   * @returns {HandoffEntry|null}
   */
  recordEnhancedTracing(toAgent, input = {}, output = {}) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.setEnhancedTracing(input, output);
    this._writeToFile(entry);
    return entry;
  }

  /**
   * Analyzes the execution path and identifies critical paths and bottlenecks.
   * Uses graph theory to find the longest path (critical path) and nodes that
   * significantly impact total duration.
   *
   * @returns {object} Critical path analysis and bottleneck identification
   */
  analyzeExecutionPath() {
    const graph = new ExecutionGraph();

    // Build graph from handoff history
    for (const handoff of this._handoffs) {
      if (handoff.state === HandoffState.COMPLETED) {
        const trace = {
          agentId: handoff.toAgent,
          input: handoff._enhanced?.input || { size: 0 },
          output: handoff._enhanced?.output || { size: 0 },
          performance: {
            duration: handoff.timing.durationMs || 0,
          },
          dependencies: {
            upstream: handoff.fromAgent ? [{ agentId: handoff.fromAgent }] : [],
          },
        };

        graph.addNode(trace);

        // Add edges for dependencies
        if (handoff.fromAgent) {
          graph.addEdge(handoff.fromAgent, handoff.toAgent, 'artifact');
        }
      }
    }

    // Find critical path
    const criticalPath = graph.findCriticalPath();

    // Find bottlenecks (nodes with >15% impact)
    const bottlenecks = graph.findBottlenecks(0.15);

    // Generate optimization suggestions
    const suggestions = graph.suggestOptimizations(bottlenecks);

    return {
      sessionId: this._sessionId,
      totalHandoffs: this._handoffs.length,
      criticalPath,
      bottlenecks,
      suggestions,
      mermaid: graph.toMermaid(),
    };
  }

  /**
   * Prints a visual critical path analysis report.
   */
  printCriticalPathAnalysis() {
    const analysis = this.analyzeExecutionPath();

    console.log('\n' + '═'.repeat(70));
    console.log('           🔍 C R I T I C A L   P A T H   A N A L Y S I S');
    console.log('═'.repeat(70));

    // Critical path
    console.log(`\n  📊 Critical Path (${analysis.criticalPath.nodes.length} stages, ${this._formatDuration(analysis.criticalPath.totalDuration)})`);
    for (let i = 0; i < analysis.criticalPath.nodes.length; i++) {
      const node = analysis.criticalPath.nodes[i];
      const icon = node.impact > 0.3 ? '🔴' : node.impact > 0.15 ? '🟡' : '🟢';
      console.log(`    ${i + 1}. ${icon} ${node.id.padEnd(12)} ${this._formatDuration(node.durationMs).padEnd(10)} (${(node.impact * 100).toFixed(1)}%)`);
    }

    // Bottlenecks
    if (analysis.bottlenecks.length > 0) {
      console.log('\n  ⚠️  Identified Bottlenecks:');
      for (const b of analysis.bottlenecks.slice(0, 3)) {
        console.log(`     • ${b.stage}: ${(b.impact * 100).toFixed(1)}% of total time`);
      }
    }

    // Suggestions
    if (analysis.suggestions.length > 0) {
      console.log('\n  💡 Optimization Suggestions:');
      for (const s of analysis.suggestions.slice(0, 3)) {
        const severityIcon = s.severity === 'high' ? '🔴' : '🟡';
        console.log(`     ${severityIcon} ${s.suggestion.slice(0, 100)}${s.suggestion.length > 100 ? '...' : ''}`);
      }
    }

    console.log('═'.repeat(70));

    return analysis;
  }

  /**
   * Saves the enhanced tracing report to a JSON file.
   * @returns {string|null} Path to saved file
   */
  saveEnhancedReport() {
    if (!this._outputDir) return null;

    const analysis = this.analyzeExecutionPath();
    const reportPath = path.join(this._outputDir, 'execution-analysis.json');

    const report = {
      sessionId: this._sessionId,
      generatedAt: new Date().toISOString(),
      analysis,
      handoffs: this._handoffs.map(h => h.toJSON()),
    };

    try {
      const tmpPath = reportPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2), 'utf-8');
      fs.renameSync(tmpPath, reportPath);

      if (this._verbose) {
        console.log(`\n  🔍 Execution analysis saved to: ${reportPath}`);
      }
    } catch (e) {
      this._warn(`Failed to save analysis: ${e.message}`);
    }

    return reportPath;
  }

  _formatMetadata(metadata) {
    const parts = [];
    if (metadata.reviewRounds !== undefined) {
      parts.push(`reviews: ${metadata.reviewRounds}`);
    }
    if (metadata.failedItems !== undefined) {
      parts.push(`issues: ${metadata.failedItems}`);
    }
    if (metadata.riskNotes && metadata.riskNotes.length > 0) {
      parts.push(`risks: ${metadata.riskNotes.length}`);
    }
    if (metadata.contextSummary) {
      parts.push(`summary: "${metadata.contextSummary.slice(0, 40)}..."`);
    }
    return parts.join(' | ');
  }

  _warn(msg) {
    if (!this._jsonMode) {
      console.warn(`[AgentHandoffLog] ⚠️  ${msg}`);
    }
  }

  // ─── Getters ────────────────────────────────────────────────────────────

  getHandoffs() {
    return [...this._handoffs];
  }

  getActiveHandoffs() {
    return new Map(this._active);
  }

  getStats() {
    return this._calculateStats();
  }
}

// ─── Integration Helper ───────────────────────────────────────────────────────

/**
 * Creates a wrapped FileRefBus that automatically logs all handoffs.
 *
 * @param {FileRefBus} fileRefBus       - The original FileRefBus instance
 * @param {AgentHandoffLog} handoffLog  - The handoff log instance
 * @returns {FileRefBus} The wrapped bus with logging
 */
function wrapFileRefBus(fileRefBus, handoffLog) {
  const originalPublish = fileRefBus.publish.bind(fileRefBus);
  const originalConsume = fileRefBus.consume.bind(fileRefBus);

  // Wrap publish
  fileRefBus.publish = function(senderRole, receiverRole, filePath, meta = null) {
    // Call original first to ensure validation happens
    const result = originalPublish(senderRole, receiverRole, filePath, meta);

    // Log the handoff
    handoffLog.initiate(senderRole, receiverRole, filePath, meta);

    return result;
  };

  // Wrap consume
  fileRefBus.consume = function(receiverRole) {
    // Log consumption before actual consume
    handoffLog.consume(receiverRole);

    // Call original
    return originalConsume(receiverRole);
  };

  return fileRefBus;
}

// ─── Integration Helper ───────────────────────────────────────────────────────

/**
 * Creates a wrapped FileRefBus that automatically logs all handoffs.
 *
 * @param {FileRefBus} fileRefBus       - The original FileRefBus instance
 * @param {AgentHandoffLog} handoffLog  - The handoff log instance
 * @returns {FileRefBus} The wrapped bus with logging
 */
function wrapFileRefBus(fileRefBus, handoffLog) {
  const originalPublish = fileRefBus.publish.bind(fileRefBus);
  const originalConsume = fileRefBus.consume.bind(fileRefBus);

  // Wrap publish
  fileRefBus.publish = function(senderRole, receiverRole, filePath, meta = null) {
    // Call original first to ensure validation happens
    const result = originalPublish(senderRole, receiverRole, filePath, meta);

    // Log the handoff
    handoffLog.initiate(senderRole, receiverRole, filePath, meta);

    return result;
  };

  // Wrap consume
  fileRefBus.consume = function(receiverRole) {
    // Log consumption before actual consume
    handoffLog.consume(receiverRole);

    // Call original
    return originalConsume(receiverRole);
  };

  return fileRefBus;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  AgentHandoffLog,
  HandoffEntry,
  HandoffState,
  StateIcon,
  wrapFileRefBus,
  ExecutionGraph,  // Enhanced tracing support
};