'use strict';

/**
 * TeardownStep – Base class for all teardown pipeline steps.
 *
 * Part of the "Declarative Teardown Pipeline" (P0 teardown-impl).
 * Each teardown step is an independent, testable module that extends this base class.
 *
 * Adding a new teardown step requires:
 *   1. Create a class extending TeardownStep
 *   2. Register it in teardown-steps/index.js
 *   That's it — 1 file, 1 registration line. Down from modifying 5+ files.
 *
 * Inspiration:
 *   - StageRunner — the same pattern that already works for pipeline stages
 *   - LifecyclePlugin — activate/deactivate pattern (but lacks before/after ordering)
 *   - FastAPI lifespan — declarative startup/shutdown handlers
 *
 * @module teardown-step
 */

class TeardownStep {
  /**
   * @param {object} config
   * @param {string}   config.name         - Unique step identifier (e.g. 'obs-flush')
   * @param {string}   config.description  - Human-readable description
   * @param {number}   [config.priority=50] - Execution priority (lower = earlier)
   * @param {string[]} [config.before=[]]   - Step names this must run before
   * @param {string[]} [config.after=[]]    - Step names this must run after
   * @param {string[]} [config.requires=[]]  - Orchestrator properties required (skip if missing)
   * @param {Function} [config.shouldSkip]  - (ctx) => boolean — conditional skip logic
   */
  constructor(config) {
    if (!config || !config.name) {
      throw new Error('[TeardownStep] config.name is required');
    }

    this.name        = config.name;
    this.description = config.description || config.name;
    this.priority    = config.priority ?? 50;
    this.before      = config.before || [];
    this.after       = config.after || [];
    this.requires    = config.requires || [];
    this._shouldSkip = config.shouldSkip || null;
  }

  /**
   * Execute the teardown step.
   * Subclasses MUST override this method.
   *
   * @param {TeardownContext} ctx - Execution context with orchestrator reference
   * @returns {Promise<void>|void}
   */
  async execute(ctx) {
    throw new Error(`[TeardownStep] "${this.name}" must implement execute()`);
  }

  /**
   * Check if this step should be skipped.
   *
   * @param {TeardownContext} ctx
   * @returns {{ skip: boolean, reason?: string }}
   */
  checkSkip(ctx) {
    // Check required orchestrator properties
    for (const prop of this.requires) {
      if (!ctx.orch[prop]) {
        return { skip: true, reason: `Missing required property: ${prop}` };
      }
    }

    // Check custom skip logic
    if (this._shouldSkip) {
      const result = this._shouldSkip(ctx);
      if (result) {
        return { skip: true, reason: typeof result === 'string' ? result : 'Custom skip condition' };
      }
    }

    return { skip: false };
  }

  /**
   * Returns the step name.
   * @returns {string}
   */
  getName() {
    return this.name;
  }
}

module.exports = { TeardownStep };
