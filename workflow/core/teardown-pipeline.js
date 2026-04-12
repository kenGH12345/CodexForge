'use strict';

/**
 * TeardownPipeline – Declarative teardown step registry and executor.
 *
 * Replaces the monolithic _finalizeWorkflow() (1387 lines, 30+ hardcoded steps)
 * with a pluggable pipeline where each step is an independent TeardownStep.
 *
 * Adding a new teardown step:
 *   BEFORE: Modify orchestrator-teardown-impl.js + ide-workflow-bridge.js +
 *           agent-generator.js + test file = 4-5 files
 *   AFTER:  Create 1 TeardownStep file + 1 registration line in index.js
 *
 * Key design decisions:
 *   1. Topological sort via before/after (like StageRegistry) — not just priority
 *   2. Non-blocking: Step errors are caught and logged, never crash the pipeline
 *   3. TeardownContext provides safe access to orchestrator state
 *   4. Bridge-compatible: Same steps run in IDE Agent mode
 *
 * @module teardown-pipeline
 */

const { TeardownStep } = require('./teardown-step');

// ─── TeardownContext ────────────────────────────────────────────────────────

/**
 * Execution context passed to each TeardownStep.
 * Provides safe, structured access to orchestrator state.
 */
class TeardownContext {
  /**
   * @param {object} params
   * @param {object} params.orch         - Orchestrator instance
   * @param {string} params.mode         - 'sequential' or 'task-based'
   * @param {object} params.extra        - Additional context (goal, etc.)
   * @param {object} params.shouldEvolve - Evolution trigger flags
   */
  constructor({ orch, mode, extra, shouldEvolve }) {
    this.orch = orch;
    this.mode = mode;
    this.extra = extra || {};
    this.shouldEvolve = shouldEvolve || {};
    this._skipped = [];
    this._executed = [];
    this._failed = [];
  }

  /** Record a skipped step */
  recordSkip(stepName, reason) {
    this._skipped.push({ step: stepName, reason });
  }

  /** Record an executed step */
  recordExecution(stepName, durationMs) {
    this._executed.push({ step: stepName, durationMs });
  }

  /** Record a failed step */
  recordFailure(stepName, error) {
    this._failed.push({ step: stepName, error: error.message });
  }

  /** Get execution summary */
  getSummary() {
    return {
      executed: this._executed.length,
      skipped: this._skipped.length,
      failed: this._failed.length,
      steps: {
        executed: this._executed,
        skipped: this._skipped,
        failed: this._failed,
      },
    };
  }
}

// ─── TeardownPipeline ───────────────────────────────────────────────────────

class TeardownPipeline {
  constructor() {
    /** @type {Map<string, TeardownStep>} */
    this._steps = new Map();
    /** @type {string[]} Cached resolved order */
    this._resolvedOrder = null;
  }

  /**
   * Register a teardown step.
   *
   * @param {TeardownStep} step - Must extend TeardownStep
   * @returns {TeardownPipeline} this (for chaining)
   */
  register(step) {
    if (!(step instanceof TeardownStep)) {
      throw new Error(`[TeardownPipeline] Step must be an instance of TeardownStep.`);
    }
    if (this._steps.has(step.name)) {
      throw new Error(`[TeardownPipeline] Step "${step.name}" is already registered.`);
    }

    this._steps.set(step.name, step);
    this._resolvedOrder = null; // Invalidate cache
    return this;
  }

  /**
   * Resolve execution order using topological sort with priority fallback.
   * Steps with 'before'/'after' constraints are ordered first (topological),
   * then remaining steps are sorted by priority (lower = earlier).
   *
   * @returns {string[]}
   */
  resolveOrder() {
    if (this._resolvedOrder) return this._resolvedOrder;

    const names = [...this._steps.keys()];
    const stepMap = this._steps;

    // Build adjacency list for topological sort
    // Edge: A -> B means "A must run before B"
    const graph = new Map(); // name -> Set of names that depend on it
    const inDegree = new Map(); // name -> number of prerequisites
    for (const name of names) {
      graph.set(name, new Set());
      inDegree.set(name, 0);
    }

    for (const name of names) {
      const step = stepMap.get(name);

      // step.before = [X] means step must run before X → edge: name → X
      for (const beforeName of step.before) {
        if (stepMap.has(beforeName)) {
          graph.get(name).add(beforeName);
          inDegree.set(beforeName, (inDegree.get(beforeName) || 0) + 1);
        }
      }

      // step.after = [X] means step must run after X → edge: X → name
      for (const afterName of step.after) {
        if (stepMap.has(afterName)) {
          graph.get(afterName).add(name);
          inDegree.set(name, (inDegree.get(name) || 0) + 1);
        }
      }
    }

    // Kahn's algorithm with priority-based tie-breaking
    const queue = [];
    for (const name of names) {
      if (inDegree.get(name) === 0) {
        queue.push(name);
      }
    }
    // Sort initial queue by priority
    queue.sort((a, b) => stepMap.get(a).priority - stepMap.get(b).priority);

    const sorted = [];
    while (queue.length > 0) {
      // Pick the one with lowest priority (earliest)
      queue.sort((a, b) => stepMap.get(a).priority - stepMap.get(b).priority);
      const current = queue.shift();
      sorted.push(current);

      for (const neighbor of graph.get(current)) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          queue.push(neighbor);
        }
      }
    }

    // If cycle exists, append remaining nodes sorted by priority
    if (sorted.length < names.length) {
      const remaining = names.filter(n => !sorted.includes(n));
      remaining.sort((a, b) => stepMap.get(a).priority - stepMap.get(b).priority);
      sorted.push(...remaining);
    }

    this._resolvedOrder = sorted;
    return sorted;
  }

  /**
   * Execute all registered teardown steps in resolved order.
   * Each step is wrapped in try/catch — errors never crash the pipeline.
   *
   * @param {TeardownContext} ctx
   * @returns {Promise<object>} Execution summary
   */
  async execute(ctx) {
    const order = this.resolveOrder();

    console.log(`[TeardownPipeline] Executing ${order.length} teardown step(s)...`);

    for (const stepName of order) {
      const step = this._steps.get(stepName);
      const startTime = Date.now();

      // Check skip conditions
      const { skip, reason } = step.checkSkip(ctx);
      if (skip) {
        ctx.recordSkip(stepName, reason);
        continue;
      }

      try {
        await step.execute(ctx);
        const durationMs = Date.now() - startTime;
        ctx.recordExecution(stepName, durationMs);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        ctx.recordFailure(stepName, err);
        console.warn(`[TeardownPipeline] ⚠️  Step "${stepName}" failed (non-fatal): ${err.message}`);
      }
    }

    const summary = ctx.getSummary();
    if (summary.failed > 0) {
      console.warn(`[TeardownPipeline] ⚠️  ${summary.failed}/${order.length} step(s) failed`);
    }
    if (summary.skipped > 0) {
      console.log(`[TeardownPipeline] ⏭️  ${summary.skipped}/${order.length} step(s) skipped`);
    }
    console.log(`[TeardownPipeline] ✅ Completed: ${summary.executed} executed, ${summary.skipped} skipped, ${summary.failed} failed`);

    return summary;
  }

  /**
   * Get a registered step by name.
   * @param {string} name
   * @returns {TeardownStep|null}
   */
  get(name) {
    return this._steps.get(name) || null;
  }

  /**
   * Check if a step is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._steps.has(name);
  }

  /** Number of registered steps */
  get size() {
    return this._steps.size;
  }

  /**
   * Return all step names in resolved order.
   * @returns {string[]}
   */
  getOrder() {
    return this.resolveOrder();
  }

  /**
   * Build a Bridge-compatible summary for IDE Agent mode.
   * Returns a JSON-serializable summary of available teardown steps.
   *
   * @returns {object}
   */
  toBridgeSummary() {
    const order = this.resolveOrder();
    return {
      totalSteps: order.length,
      steps: order.map(name => {
        const step = this._steps.get(name);
        return {
          name: step.name,
          description: step.description,
          priority: step.priority,
          requires: step.requires,
        };
      }),
    };
  }
}

module.exports = { TeardownPipeline, TeardownContext, TeardownStep };
