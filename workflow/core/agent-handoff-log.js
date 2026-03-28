/**
 * Agent Handoff Log – Tracks inter-agent workflow state transitions
 *
 * ADR-33 Phase 4: This module has been split into sub-modules:
 *   - agent-handoff-entry.js  – HandoffEntry, HandoffState, StateIcon
 *   - agent-handoff-graph.js  – ExecutionGraph (critical path analysis)
 *   - agent-handoff-log.js (this) – AgentHandoffLog orchestrator, wrapFileRefBus
 *
 * All exports are re-exported from this file for backward compatibility.
 *
 * @module agent-handoff-log
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Import from sub-modules ────────────────────────────────────────────────

const { HandoffEntry, HandoffState, StateIcon } = require('./agent-handoff-entry');
const { ExecutionGraph } = require('./agent-handoff-graph');

// ─── Agent Handoff Log ────────────────────────────────────────────────────────

class AgentHandoffLog {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.outputDir]     - Directory for log files
   * @param {string}  [opts.sessionId]     - Session identifier
   * @param {boolean} [opts.jsonMode=false] - Force JSON-only output
   * @param {boolean} [opts.verbose=true]  - Print human-readable logs to console
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || null;
    this._sessionId = opts.sessionId || null;
    this._jsonMode = opts.jsonMode || false;
    this._verbose = opts.verbose !== false;
    this._handoffs = [];
    this._active = new Map();
    this._logStream = null;
    this._entryCount = 0;
  }

  setOutputDir(outputDir) {
    this._outputDir = outputDir;
    if (this._logStream) {
      try { this._logStream.end(); } catch (_) {}
      this._logStream = null;
    }
  }

  setSessionId(sessionId) {
    this._sessionId = sessionId;
  }

  // ─── Core Handoff Operations ────────────────────────────────────────────

  initiate(fromAgent, toAgent, artifactPath, metadata = {}, stage = null) {
    const existing = this._active.get(toAgent);
    if (existing) {
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

  startProcessing(toAgent) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.startProcessing();
    this._logHandoff(entry, 'PROCESSING');
    this._writeToFile(entry);

    return entry;
  }

  complete(toAgent, success = true, result = {}) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.complete(success);
    if (result) {
      Object.assign(entry.metadata, result);
    }

    this._logHandoff(entry, success ? 'COMPLETE' : 'FAILED');
    this._writeToFile(entry);

    return entry;
  }

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

  printBanner() {
    if (this._jsonMode) return;

    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║         A G E N T   H A N D O F F   O R C H E S T R A T I O N      ║');
    console.log('║                  Workflow State Transition Log                     ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝');
  }

  printStageHeader(stage, agent) {
    if (this._jsonMode) return;

    console.log(`\n┌────────────────────────────────────────────────────────────────────┐`);
    console.log(`│  STAGE: ${stage.padEnd(56)}│`);
    console.log(`│  AGENT: ${agent.padEnd(56)}│`);
    console.log(`└────────────────────────────────────────────────────────────────────┘`);
  }

  printSummary() {
    if (this._jsonMode) return;

    if (this._handoffs.length === 0) {
      console.log('\n  ℹ️  No handoffs recorded.');
      return;
    }

    console.log('\n' + '═'.repeat(70));
    console.log('           H A N D O F F   F L O W   S U M M A R Y');
    console.log('═'.repeat(70));

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

        if (h.metadata && Object.keys(h.metadata).length > 0 && this._verbose) {
          const metaStr = this._formatMetadata(h.metadata);
          if (metaStr) {
            const metaPrefix = isLast ? '      ' : '   │  ';
            console.log(`${metaPrefix}${metaStr}`);
          }
        }
      }
    }

    const stats = this._calculateStats();
    console.log('\n  ─────────────────────────────────────────────────────────────────');
    console.log(`  Total Handoffs: ${stats.total}  |  Successful: ${stats.completed} ✅  |  Failed: ${stats.failed} ❌  |  Rollbacks: ${stats.rollbacks} ⏪`);
    console.log('═'.repeat(70));
  }

  generateMermaidFlowchart() {
    const lines = ['```mermaid', 'flowchart LR'];

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

      if (h.state === HandoffState.FAILED) {
        nodeStyles.set(toNode, 'fill:#ffcccc');
      } else if (h.state === HandoffState.ROLLBACK) {
        nodeStyles.set(toNode, 'fill:#ffffcc');
      } else if (h.state === HandoffState.COMPLETED) {
        nodeStyles.set(toNode, 'fill:#ccffcc');
      }
    }

    for (const [node, style] of nodeStyles) {
      lines.push(`    style ${node} ${style}`);
    }

    lines.push('```');
    return lines.join('\n');
  }

  // ─── File Output ────────────────────────────────────────────────────────

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

    const tmpPath = logPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, logPath);

    const mermaidPath = path.join(this._outputDir, 'agent-handoff-flow.mmd');
    fs.writeFileSync(mermaidPath, this.generateMermaidFlowchart(), 'utf-8');

    const analysis = this.analyzeExecutionPath();
    const analysisPath = path.join(this._outputDir, 'execution-analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify({
      sessionId: this._sessionId,
      generatedAt: new Date().toISOString(),
      analysis,
      handoffs: this._handoffs.map(h => h.toJSON()),
    }, null, 2), 'utf-8');

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

  recordEnhancedTracing(toAgent, input = {}, output = {}) {
    const entry = this._active.get(toAgent);
    if (!entry) return null;

    entry.setEnhancedTracing(input, output);
    this._writeToFile(entry);
    return entry;
  }

  analyzeExecutionPath() {
    const graph = new ExecutionGraph();

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

        if (handoff.fromAgent) {
          graph.addEdge(handoff.fromAgent, handoff.toAgent, 'artifact');
        }
      }
    }

    const criticalPath = graph.findCriticalPath();
    const bottlenecks = graph.findBottlenecks(0.15);
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

  printCriticalPathAnalysis() {
    const analysis = this.analyzeExecutionPath();

    console.log('\n' + '═'.repeat(70));
    console.log('           🔍 C R I T I C A L   P A T H   A N A L Y S I S');
    console.log('═'.repeat(70));

    console.log(`\n  📊 Critical Path (${analysis.criticalPath.nodes.length} stages, ${this._formatDuration(analysis.criticalPath.totalDuration)})`);
    for (let i = 0; i < analysis.criticalPath.nodes.length; i++) {
      const node = analysis.criticalPath.nodes[i];
      const icon = node.impact > 0.3 ? '🔴' : node.impact > 0.15 ? '🟡' : '🟢';
      console.log(`    ${i + 1}. ${icon} ${node.id.padEnd(12)} ${this._formatDuration(node.durationMs).padEnd(10)} (${(node.impact * 100).toFixed(1)}%)`);
    }

    if (analysis.bottlenecks.length > 0) {
      console.log('\n  ⚠️  Identified Bottlenecks:');
      for (const b of analysis.bottlenecks.slice(0, 3)) {
        console.log(`     • ${b.stage}: ${(b.impact * 100).toFixed(1)}% of total time`);
      }
    }

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
 */
function wrapFileRefBus(fileRefBus, handoffLog) {
  const originalPublish = fileRefBus.publish.bind(fileRefBus);
  const originalConsume = fileRefBus.consume.bind(fileRefBus);

  fileRefBus.publish = function(senderRole, receiverRole, filePath, meta = null) {
    const result = originalPublish(senderRole, receiverRole, filePath, meta);
    handoffLog.initiate(senderRole, receiverRole, filePath, meta);
    return result;
  };

  fileRefBus.consume = function(receiverRole) {
    handoffLog.consume(receiverRole);
    return originalConsume(receiverRole);
  };

  return fileRefBus;
}

// ─── Exports (backward compatible) ────────────────────────────────────────

module.exports = {
  AgentHandoffLog,
  HandoffEntry,
  HandoffState,
  StateIcon,
  wrapFileRefBus,
  ExecutionGraph,
};