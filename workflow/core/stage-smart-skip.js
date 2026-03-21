/**
 * StageSmartSkip – Adaptive Stage Skipping Based on Task Complexity (Direction 5)
 *
 * Dynamically skips non-essential pipeline stages based on task complexity
 * assessed during ANALYSE. This avoids wasteful LLM calls for simple tasks
 * (e.g. a one-file bug fix doesn't need full architecture + plan phases).
 *
 * Design references:
 *   - LangGraph conditional edges: dynamic path selection based on state
 *   - Google AI adaptive pipeline: skip unnecessary stages based on input complexity
 *   - Stanford HAI RL workflow automation: self-optimising task pipelines
 *   - DARPA adaptive execution: complexity-driven resource allocation
 *
 * Skip rules:
 *   ┌─────────────────┬──────────┬─────────────┬──────────────┬─────────────┐
 *   │ Complexity       │ ANALYSE  │ ARCHITECT   │ PLANNER      │ CODE + TEST │
 *   ├─────────────────┼──────────┼─────────────┼──────────────┼─────────────┤
 *   │ simple (0-25)    │ ALWAYS   │ SKIP ⏭️     │ SKIP ⏭️      │ ALWAYS      │
 *   │ moderate (26-50) │ ALWAYS   │ ALWAYS      │ SKIP ⏭️      │ ALWAYS      │
 *   │ complex (51-75)  │ ALWAYS   │ ALWAYS      │ ALWAYS       │ ALWAYS      │
 *   │ very_complex(76+)│ ALWAYS   │ ALWAYS      │ ALWAYS       │ ALWAYS      │
 *   └─────────────────┴──────────┴─────────────┴──────────────┴─────────────┘
 *
 * Safety constraints:
 *   - ANALYSE is NEVER skipped (provides complexity assessment + enriched requirement)
 *   - CODE is NEVER skipped (produces the actual implementation)
 *   - TEST is NEVER skipped (validates the implementation)
 *   - Skipping is disabled when config.stageSmartSkip.enabled === false
 *   - Skipping is disabled when no complexity assessment is available
 *   - Each skip decision is recorded in the DecisionTrail for audit
 *
 * Integration:
 *   - Called from Orchestrator.run() before each _runStage() invocation
 *   - Reads complexity from stageCtx.get('ANALYSE').meta.complexity
 *   - Uses DecisionTrail.record() to log skip decisions
 *
 * @module stage-smart-skip
 */

'use strict';

const { DecisionCategory } = require('./decision-trail');

// ─── Default Skip Configuration ─────────────────────────────────────────────

/**
 * Default stage skip rules.
 * Key: stage name. Value: { skipBelow: number } — skip if complexity.score < skipBelow.
 *
 * Stages not listed here are NEVER skipped (implicitly skipBelow: 0).
 * ANALYSE, CODE, TEST are intentionally absent → always executed.
 */
const DEFAULT_SKIP_RULES = {
  // Simple tasks (score < 26): skip ARCHITECT (design doc is overkill for a one-liner fix)
  ARCHITECT: { skipBelow: 26, reason: 'Simple task — architecture design not needed' },
  // Simple + moderate tasks (score < 51): skip PLANNER (decomposition is overkill for single-module changes)
  PLAN:      { skipBelow: 51, reason: 'Simple/moderate task — sub-task decomposition not needed' },
};

/**
 * Stages that can NEVER be skipped, regardless of configuration.
 * These are the safety-critical pipeline stages.
 */
const NEVER_SKIP_STAGES = new Set(['ANALYSE', 'CODE', 'TEST']);

// ─── StageSmartSkip Class ───────────────────────────────────────────────────

class StageSmartSkip {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true]  - Set false to disable all skipping
   * @param {object}  [opts.skipRules]     - Custom skip rules (merged with defaults)
   * @param {import('./decision-trail').DecisionTrail} [opts.decisionTrail] - For recording skip decisions
   */
  constructor(opts = {}) {
    this._enabled = opts.enabled !== false;
    this._decisionTrail = opts.decisionTrail || null;

    // Merge custom skip rules with defaults
    this._skipRules = { ...DEFAULT_SKIP_RULES };
    if (opts.skipRules) {
      for (const [stage, rule] of Object.entries(opts.skipRules)) {
        if (NEVER_SKIP_STAGES.has(stage)) {
          console.warn(`[StageSmartSkip] ⚠️  Ignoring skip rule for safety-critical stage "${stage}".`);
          continue;
        }
        this._skipRules[stage] = { ...this._skipRules[stage], ...rule };
      }
    }

    // Track skip decisions for summary
    this._skippedStages = [];
    this._executedStages = [];

    if (this._enabled) {
      const rules = Object.entries(this._skipRules)
        .map(([stage, rule]) => `${stage}(score<${rule.skipBelow})`)
        .join(', ');
      console.log(`[StageSmartSkip] ⏭️  Initialised (rules: ${rules})`);
    }
  }

  // ─── Core API ───────────────────────────────────────────────────────────

  /**
   * Evaluates whether a stage should be skipped based on task complexity.
   *
   * @param {string} stageName - The pipeline stage name (e.g. 'ARCHITECT', 'PLAN')
   * @param {object} context   - Orchestrator context for accessing complexity data
   * @param {object} [context.stageCtx]  - StageContextStore with ANALYSE results
   * @param {object} [context.complexity] - Direct complexity override (for testing)
   * @returns {{ skip: boolean, reason: string, complexity?: object }}
   */
  shouldSkip(stageName, context = {}) {
    // Disabled → never skip
    if (!this._enabled) {
      return { skip: false, reason: 'Stage smart-skip is disabled' };
    }

    // Safety-critical stages → never skip
    if (NEVER_SKIP_STAGES.has(stageName)) {
      return { skip: false, reason: `${stageName} is a safety-critical stage and cannot be skipped` };
    }

    // No skip rule defined for this stage → don't skip
    const rule = this._skipRules[stageName];
    if (!rule) {
      return { skip: false, reason: `No skip rule defined for stage ${stageName}` };
    }

    // Get complexity assessment
    const complexity = this._getComplexity(context);
    if (!complexity || complexity.score == null) {
      // No complexity data available → conservative: don't skip
      this._recordDecision(stageName, false, 'No complexity assessment available — executing stage', null);
      return { skip: false, reason: 'No complexity assessment available — executing stage as precaution' };
    }

    // Evaluate skip condition
    if (complexity.score < rule.skipBelow) {
      const reason = `${rule.reason} (complexity: ${complexity.level}, score=${complexity.score}, threshold=${rule.skipBelow})`;
      this._skippedStages.push({ stage: stageName, complexity, reason });
      this._recordDecision(stageName, true, reason, complexity);
      console.log(`[StageSmartSkip] ⏭️  Skipping ${stageName}: ${reason}`);
      return { skip: true, reason, complexity };
    }

    // Complexity above threshold → execute normally
    const reason = `Task complexity (${complexity.level}, score=${complexity.score}) exceeds skip threshold (${rule.skipBelow})`;
    this._executedStages.push({ stage: stageName, complexity });
    this._recordDecision(stageName, false, reason, complexity);
    return { skip: false, reason, complexity };
  }

  // ─── Summary ────────────────────────────────────────────────────────────

  /**
   * Returns a structured summary of skip decisions.
   * @returns {{ enabled: boolean, skipped: object[], executed: object[], savedCalls: number }}
   */
  getSummary() {
    return {
      enabled: this._enabled,
      skipped: [...this._skippedStages],
      executed: [...this._executedStages],
      skippedCount: this._skippedStages.length,
      executedCount: this._executedStages.length,
    };
  }

  /**
   * Formats the skip summary for console output.
   * @returns {string}
   */
  formatSummary() {
    if (!this._enabled) return '';
    if (this._skippedStages.length === 0 && this._executedStages.length === 0) return '';

    const lines = [];

    if (this._skippedStages.length > 0) {
      lines.push(`  ⏭️  Smart-Skip: ${this._skippedStages.length} stage(s) skipped`);
      for (const s of this._skippedStages) {
        lines.push(`    ⏭️ ${s.stage} — ${s.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  /**
   * Extracts complexity assessment from the context.
   * @param {object} context
   * @returns {{ level: string, score: number }|null}
   * @private
   */
  _getComplexity(context) {
    // Direct override (for testing)
    if (context.complexity) return context.complexity;

    // From StageContextStore (production path)
    if (context.stageCtx) {
      const analyseData = typeof context.stageCtx.get === 'function'
        ? context.stageCtx.get('ANALYSE')
        : null;
      if (analyseData && analyseData.meta && analyseData.meta.complexity) {
        return analyseData.meta.complexity;
      }
    }

    // From Observability (fallback)
    if (context.obs && context.obs._taskComplexity) {
      return context.obs._taskComplexity;
    }

    return null;
  }

  /**
   * Records a skip decision in the DecisionTrail.
   * @param {string} stageName
   * @param {boolean} skipped
   * @param {string} reason
   * @param {object|null} complexity
   * @private
   */
  _recordDecision(stageName, skipped, reason, complexity) {
    if (!this._decisionTrail) return;

    this._decisionTrail.record({
      category: DecisionCategory.SKIP,
      stage: stageName,
      action: skipped ? 'skip_stage' : 'execute_stage',
      reason,
      evidence: complexity ? {
        level: complexity.level,
        score: complexity.score,
        threshold: this._skipRules[stageName]?.skipBelow || 0,
      } : null,
      outcome: skipped ? 'skipped' : 'will_execute',
    });
  }
}

module.exports = { StageSmartSkip, DEFAULT_SKIP_RULES, NEVER_SKIP_STAGES };
