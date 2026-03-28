/**
 * Agent Handoff Entry – Data structures for handoff state tracking
 *
 * Extracted from agent-handoff-log.js (ADR-33 Phase 4) to isolate the
 * HandoffEntry class and state constants from the main log orchestrator.
 *
 * This module provides:
 *   - HandoffState enum
 *   - StateIcon mapping
 *   - HandoffEntry class
 *
 * @module agent-handoff-entry
 */

'use strict';

const path = require('path');

// ─── Handoff States ───────────────────────────────────────────────────────────

const HandoffState = {
  READY:     'ready',
  IN_TRANSIT:'in_transit',
  CONSUMED:  'consumed',
  PROCESSING:'processing',
  COMPLETED: 'completed',
  FAILED:    'failed',
  ROLLBACK:  'rollback',
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
   * @param {object} [opts.metadata]     - Additional context
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
    this.rollbackFrom = null;
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  HandoffEntry,
  HandoffState,
  StateIcon,
};
