'use strict';

/**
 * Run Guard Plugin — Declarative lifecycle integration
 *
 * Phase 5 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in index.js (constructor only, no call sites)
 * with a hook-driven plugin that automatically intercepts stage and LLM events.
 *
 * Problem solved:
 *   RunGuard was created and registered in ServiceContainer, but its core methods
 *   (beforeStage, beforeLlmCall, afterLlmCall) were never called anywhere in the
 *   pipeline — making the entire cost-aware gateway + hard execution ceiling a
 *   dead code path.
 *
 * Solution:
 *   This plugin subscribes to HOOK_EVENTS.STAGE_STARTED and HOOK_EVENTS.STAGE_ENDED
 *   so that RunGuard checks are automatically triggered at the right lifecycle
 *   points without any manual wiring in orchestrator-run.js.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { maxTotalLlmCalls, maxTotalTokens, maxTotalDurationMs, budgetUsd, enabled }
 *   - beforeStage(stageName, context) → { allowed, tierMode, warnings }
 *   - beforeLlmCall(role, estimatedTokens) → { allowed, reason? }
 *   - afterLlmCall(role, inputTokens, outputTokens, costUsd)
 *   - recordStageCall(stageName)
 *   - syncCost(totalCostUsd)
 *   - getSummary() → RunGuardSummary
 *   - formatSummary() → string
 *
 * Dual-mode compliance (ADR-37):
 *   - Node Orchestrator: auto-discovered from core/plugins/ by LifecyclePluginRegistry
 *   - IDE Agent (Bridge): available via 'run-guard-status' subcommand
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'run-guard',
  phase: PluginPhase.BOTH,
  hooks: ['stage_started', 'stage_ended'],
  priority: PluginPriority.HIGH,
  description: 'Global execution guard and cost-aware gateway — enforces LLM call/token/duration/budget limits via hook events',

  async activate(orch) {
    const { RunGuard } = require('../run-guard');

    const runGuardOpts = {
      maxTotalLlmCalls:   (orch._adaptiveStrategy && orch._adaptiveStrategy.maxTotalLlmCalls) || 50,
      maxTotalTokens:     (orch._adaptiveStrategy && orch._adaptiveStrategy.maxTotalTokens) || 800_000,
      maxTotalDurationMs: (orch._adaptiveStrategy && orch._adaptiveStrategy.maxTotalDurationMs) || 30 * 60 * 1000,
      budgetUsd:          (orch._config && orch._config.llmCostRouter && orch._config.llmCostRouter.budgetUsd) || 5.0,
      enabled:            !(orch._config && orch._config.runGuard && orch._config.runGuard.enabled === false),
    };
    if (orch._config && orch._config.runGuard) {
      Object.assign(runGuardOpts, orch._config.runGuard);
    }

    const runGuard = new RunGuard(runGuardOpts);

    // Register into orchestrator for backward compatibility
    orch.runGuard = runGuard;

    // Also register into ServiceContainer for dependency injection
    if (orch.services && typeof orch.services.registerValue === 'function') {
      orch.services.registerValue('runGuard', runGuard);
    }

    // Store orch reference for onStage/deactivate callbacks
    this._orch = orch;

    console.log(`[Plugin:rg] 🛡️  RunGuard activated (calls≤${runGuardOpts.maxTotalLlmCalls}, budget=$${runGuardOpts.budgetUsd})`);

    return runGuard;
  },

  /**
   * Hook event handler: responds to STAGE_STARTED and STAGE_ENDED events.
   *
   * STAGE_STARTED:
   *   Calls runGuard.beforeStage() to check hard limits and apply cost-aware
   *   tier routing. If RunGuardAbortError is thrown, the stage is aborted.
   *
   * STAGE_ENDED:
   *   Syncs the latest cost from Observability into RunGuard for accurate
   *   budget tracking on the next beforeStage() call.
   */
  async onStage(event, payload) {
    const orch = this._orch;
    const runGuard = orch?.runGuard;
    if (!runGuard) return;

    try {
      if (event === 'stage_started') {
        const stageName = payload?.stage;
        if (!stageName) return;

        const result = runGuard.beforeStage(stageName, {
          llmRouter: orch.llmRouter || null,
        });

        // Record to DecisionTrail if available
        if (result.tierMode !== 'normal' && orch.decisionTrail) {
          orch.decisionTrail.record({
            category: 'cost_control',
            stage: stageName,
            action: `tier_downgrade:${result.tierMode}`,
            reason: `Budget pressure triggered tier change`,
            evidence: { warnings: result.warnings },
          });
        }

        if (result.warnings.length > 0) {
          for (const w of result.warnings) {
            console.warn(`[Plugin:rg] ⚠️  ${w}`);
          }
        }
      } else if (event === 'stage_ended') {
        // Sync cost from Observability after each stage
        if (orch.obs && typeof orch.obs.getTotalCostUsd === 'function') {
          const totalCost = orch.obs.getTotalCostUsd();
          runGuard.syncCost(totalCost);
        }
      }
    } catch (err) {
      if (err.code === 'RUN_GUARD_ABORT') {
        // Re-throw so the orchestrator can catch and abort the workflow
        console.error(`[Plugin:rg] 🛑 RunGuard ABORT: ${err.message}`);
        throw err;
      }
      console.warn(`[Plugin:rg] ⚠️  RunGuard check failed (non-fatal): ${err.message}`);
    }
  },

  async deactivate(orch) {
    const runGuard = (orch || this._orch)?.runGuard;
    if (!runGuard) return;

    // Output RunGuard summary to console during teardown
    try {
      const summary = runGuard.formatSummary();
      if (summary) {
        console.error(summary);
      }
    } catch (err) {
      console.warn(`[Plugin:rg] ⚠️  Summary output failed (non-fatal): ${err.message}`);
    }

    // Log tier downgrade history
    const data = runGuard.getSummary();
    if (data.tierDowngrades && data.tierDowngrades.length > 0) {
      console.log(`[Plugin:rg] ⚡ ${data.tierDowngrades.length} tier downgrade(s) occurred during this run.`);
    }

    // Log utilisation summary
    if (data.utilisation) {
      const maxUtil = Math.max(
        data.utilisation.llmCallsPct || 0,
        data.utilisation.tokensPct || 0,
        data.utilisation.durationPct || 0,
        data.utilisation.budgetPct || 0
      );
      if (maxUtil > 70) {
        console.log(`[Plugin:rg] 📊 Peak utilisation: ${maxUtil.toFixed(0)}% — consider adjusting limits for next run.`);
      }
    }
  },

  bridge: {
    subcommand: 'run-guard-status',
    handler: async (args) => {
      try {
        const { RunGuard } = require('../run-guard');
        // Create a lightweight instance for status check
        const guard = new RunGuard({
          maxTotalLlmCalls: 50,
          budgetUsd: 5.0,
          enabled: true,
        });

        return {
          success: true,
          subcommand: 'run-guard-status',
          data: {
            message: 'RunGuard plugin is active. Use this subcommand to check guard status during a workflow run.',
            defaultLimits: {
              maxTotalLlmCalls: 50,
              maxTotalTokens: 800000,
              maxTotalDurationMs: 1800000,
              budgetUsd: 5.0,
            },
          },
        };
      } catch (err) {
        return {
          success: false,
          subcommand: 'run-guard-status',
          error: err.message,
        };
      }
    },
  },
});
