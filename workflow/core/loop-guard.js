/**
 * LoopGuard – Prevents infinite conditional rollback loops
 *
 * When ConditionalEdge rules trigger backward transitions (e.g. TEST → ARCHITECT),
 * LoopGuard tracks how many times each backward edge has been traversed and
 * enforces a configurable maximum retry count.
 *
 * Design:
 *   - Pure rule engine: zero LLM calls, zero token cost
 *   - Tracks per-edge retry counts: 'TEST→ARCHITECT' → count
 *   - Configurable per-edge and global max retries
 *   - Integrates with StateMachine.transitionConditional() via context injection
 *
 * Usage:
 *   const guard = new LoopGuard({ maxRetries: 2 });
 *   // Before conditional transition:
 *   if (!guard.canRetry('TEST', 'ARCHITECT')) {
 *     // Exceeded max retries, proceed forward instead
 *   }
 *   guard.recordRetry('TEST', 'ARCHITECT');
 *
 * @module workflow/core/loop-guard
 */

'use strict';

class LoopGuard {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetries=2]  - Default max retries per backward edge
   * @param {Object<string, number>} [options.edgeLimits] - Per-edge override limits
   *   e.g. { 'TEST→ARCHITECT': 1, 'TEST→CODE': 3 }
   */
  constructor(options = {}) {
    /** @type {number} Default max retries for any backward edge */
    this._maxRetries = options.maxRetries ?? 2;

    /** @type {Object<string, number>} Per-edge override limits */
    this._edgeLimits = options.edgeLimits || {};

    /** @type {Map<string, number>} Edge key → retry count */
    this._counters = new Map();

    /** @type {Array<{ edge: string, timestamp: string, count: number }>} Audit log */
    this._history = [];
  }

  /**
   * Returns the edge key for a from→to transition.
   * @param {string} fromStage
   * @param {string} toStage
   * @returns {string}
   */
  _edgeKey(fromStage, toStage) {
    return `${fromStage}→${toStage}`;
  }

  /**
   * Returns the max retry limit for a specific edge.
   * Uses per-edge override if configured, otherwise the global default.
   *
   * @param {string} fromStage
   * @param {string} toStage
   * @returns {number}
   */
  getMaxRetries(fromStage, toStage) {
    const key = this._edgeKey(fromStage, toStage);
    return this._edgeLimits[key] ?? this._maxRetries;
  }

  /**
   * Checks if a backward transition can be retried.
   *
   * @param {string} fromStage - Current stage (e.g. 'TEST')
   * @param {string} toStage   - Target stage (e.g. 'ARCHITECT')
   * @returns {boolean} true if retry count < max retries
   */
  canRetry(fromStage, toStage) {
    const key = this._edgeKey(fromStage, toStage);
    const count = this._counters.get(key) || 0;
    const max = this.getMaxRetries(fromStage, toStage);
    return count < max;
  }

  /**
   * Records a backward transition retry.
   *
   * @param {string} fromStage
   * @param {string} toStage
   * @returns {number} The new retry count for this edge
   */
  recordRetry(fromStage, toStage) {
    const key = this._edgeKey(fromStage, toStage);
    const newCount = (this._counters.get(key) || 0) + 1;
    this._counters.set(key, newCount);

    this._history.push({
      edge: key,
      timestamp: new Date().toISOString(),
      count: newCount,
    });

    const max = this.getMaxRetries(fromStage, toStage);
    console.log(`[LoopGuard] 🔄 Retry recorded: ${key} (${newCount}/${max})`);

    if (newCount >= max) {
      console.warn(`[LoopGuard] ⚠️  Max retries reached for ${key} (${newCount}/${max}). Further retries will be blocked.`);
    }

    return newCount;
  }

  /**
   * Returns the current retry count for an edge.
   *
   * @param {string} fromStage
   * @param {string} toStage
   * @returns {number}
   */
  getRetryCount(fromStage, toStage) {
    return this._counters.get(this._edgeKey(fromStage, toStage)) || 0;
  }

  /**
   * Returns the remaining retries for an edge.
   *
   * @param {string} fromStage
   * @param {string} toStage
   * @returns {number}
   */
  getRemainingRetries(fromStage, toStage) {
    const max = this.getMaxRetries(fromStage, toStage);
    const count = this.getRetryCount(fromStage, toStage);
    return Math.max(0, max - count);
  }

  /**
   * Resets the retry counter for a specific edge.
   * Useful when a stage succeeds after a retry (reset for next run).
   *
   * @param {string} fromStage
   * @param {string} toStage
   */
  resetEdge(fromStage, toStage) {
    const key = this._edgeKey(fromStage, toStage);
    this._counters.delete(key);
  }

  /**
   * Resets all retry counters. Called at the start of a new workflow run.
   */
  resetAll() {
    this._counters.clear();
    this._history = [];
  }

  /**
   * Returns statistics for observability and debugging.
   *
   * @returns {{ edges: Object<string, { count: number, max: number, exhausted: boolean }>, totalRetries: number, history: Array }}
   */
  getStats() {
    const edges = {};
    for (const [key, count] of this._counters) {
      const [from, to] = key.split('→');
      const max = this.getMaxRetries(from, to);
      edges[key] = {
        count,
        max,
        exhausted: count >= max,
      };
    }

    const totalRetries = [...this._counters.values()].reduce((sum, c) => sum + c, 0);

    return {
      edges,
      totalRetries,
      history: [...this._history],
    };
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = { LoopGuard };
