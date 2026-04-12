'use strict';

/**
 * Decision Trail Plugin — Declarative lifecycle integration
 *
 * Phase 6 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in index.js (constructor only, no call sites)
 * with a hook-driven plugin that automatically records decision points.
 *
 * Problem solved:
 *   DecisionTrail was created and registered in ServiceContainer, and its
 *   record() method was only called from stage-smart-skip.js. The 5 main
 *   stage runners (ANALYSE, ARCHITECT, PLAN, CODE, TEST) never recorded
 *   their key decisions — making the decision audit trail mostly empty
 *   and the teardown timeline output useless.
 *
 * Solution:
 *   This plugin subscribes to HOOK_EVENTS.STAGE_STARTED, STAGE_ENDED,
 *   and NEGOTIATE_RESPONSE so that DecisionTrail records are automatically
 *   created at every key decision point without any manual wiring in
 *   stage runners.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { enabled, maxEntries }
 *   - record(decision) — decision = { category, stage, action, reason, evidence?, outcome? }
 *   - setOutcome(seq, outcome)
 *   - query(filter) → Array
 *   - getSummary() → { totalEntries, categories, stages }
 *   - formatTimeline() → string
 *
 * Dual-mode compliance (ADR-37):
 *   - Node Orchestrator: auto-discovered from core/plugins/ by LifecyclePluginRegistry
 *   - IDE Agent (Bridge): available via 'decision-trail' subcommand
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'decision-trail',
  phase: PluginPhase.BOTH,
  hooks: ['stage_started', 'stage_ended', 'negotiate_response'],
  priority: PluginPriority.NORMAL,
  description: 'Structured decision audit log — records key decision points at stage boundaries via hook events',

  async activate(orch) {
    const { DecisionTrail } = require('../decision-trail');

    const decisionTrail = new DecisionTrail({
      enabled: !(orch._config && orch._config.decisionTrail && orch._config.decisionTrail.enabled === false),
      maxEntries: (orch._config && orch._config.decisionTrail && orch._config.decisionTrail.maxEntries) || 200,
    });

    // Register into orchestrator for backward compatibility
    orch.decisionTrail = decisionTrail;

    // Also register into ServiceContainer for dependency injection
    if (orch.services && typeof orch.services.registerValue === 'function') {
      orch.services.registerValue('decisionTrail', decisionTrail);
    }

    // Wire DecisionTrail into StageSmartSkip (if it exists)
    if (orch.stageSmartSkip) {
      orch.stageSmartSkip._decisionTrail = decisionTrail;
    }

    // Store orch reference for onStage/deactivate callbacks
    this._orch = orch;

    console.log(`[Plugin:dt] 📝 DecisionTrail activated (maxEntries=${decisionTrail._maxEntries || 200})`);

    return decisionTrail;
  },

  /**
   * Hook event handler: responds to STAGE_STARTED, STAGE_ENDED, and
   * NEGOTIATE_RESPONSE events.
   *
   * STAGE_STARTED:
   *   Records a 'stage_enter' decision — which stage is about to execute
   *   and with what context (previous artifact, skip status, etc.).
   *
   * STAGE_ENDED:
   *   Records a 'stage_exit' decision — whether the stage succeeded or
   *   failed, its duration, and the output artifact path.
   *
   * NEGOTIATE_RESPONSE:
   *   Records the outcome of inter-agent negotiation — what was the
   *   concern, what action was taken, and why.
   */
  async onStage(event, payload) {
    const orch = this._orch;
    const decisionTrail = orch?.decisionTrail;
    if (!decisionTrail || !decisionTrail._enabled) return;

    try {
      if (event === 'stage_started') {
        const stageName = payload?.stage;
        if (!stageName) return;

        decisionTrail.record({
          category: 'lifecycle',
          stage: stageName,
          action: 'stage_enter',
          reason: `Stage ${stageName} starting execution`,
          evidence: {
            previousArtifact: payload.previousArtifact || null,
            skipSource: payload.skipSource || null,
          },
        });
      } else if (event === 'stage_ended') {
        const stageName = payload?.stage;
        if (!stageName) return;

        const success = payload?.success !== false;
        decisionTrail.record({
          category: 'lifecycle',
          stage: stageName,
          action: success ? 'stage_exit_success' : 'stage_exit_failure',
          reason: success
            ? `Stage ${stageName} completed successfully`
            : `Stage ${stageName} failed: ${payload?.error || 'unknown'}`,
          evidence: {
            artifactPath: payload?.artifactPath || null,
            duration: payload?.duration || null,
            confidence: payload?.confidence || null,
            error: payload?.error || null,
          },
          outcome: success ? 'completed' : 'failed',
        });
      } else if (event === 'negotiate_response') {
        const fromStage = payload?.fromStage;
        const toStage = payload?.toStage;
        if (!fromStage || !toStage) return;

        decisionTrail.record({
          category: 'negotiation',
          stage: fromStage,
          action: `negotiate:${payload.resolution || 'unknown'}`,
          reason: `Negotiation from ${fromStage} to ${toStage}: ${payload.action || 'no action'}`,
          evidence: {
            concernType: payload.concernType || null,
            resolution: payload.resolution || null,
            action: payload.action || null,
            detail: payload.detail || null,
          },
          outcome: payload.action === 'rollback_upstream' ? 'rollback' : 'proceed',
        });
      }
    } catch (err) {
      // DecisionTrail recording must never break the workflow
      console.warn(`[Plugin:dt] ⚠️  Record failed (non-fatal): ${err.message}`);
    }
  },

  async deactivate(orch) {
    const decisionTrail = (orch || this._orch)?.decisionTrail;
    if (!decisionTrail) return;

    // Output decision timeline to console during teardown
    try {
      const timeline = decisionTrail.formatTimeline();
      if (timeline) {
        console.error(timeline);
      }

      const summary = decisionTrail.getSummary();
      if (summary && summary.total > 0) {
        console.log(`[Plugin:dt] 📋 ${summary.total} decision(s) recorded across ${Object.keys(summary.byStage || {}).length} stage(s).`);
      }
    } catch (err) {
      console.warn(`[Plugin:dt] ⚠️  Timeline output failed (non-fatal): ${err.message}`);
    }
  },

  bridge: {
    subcommand: 'decision-trail',
    handler: async (args) => {
      try {
        const { DecisionTrail } = require('../decision-trail');
        const trail = new DecisionTrail({ enabled: true, maxEntries: 200 });

        return {
          success: true,
          subcommand: 'decision-trail',
          data: {
            message: 'DecisionTrail plugin is active. Decision records are created automatically at stage boundaries.',
            supportedEvents: ['stage_started', 'stage_ended', 'negotiate_response'],
          },
        };
      } catch (err) {
        return {
          success: false,
          subcommand: 'decision-trail',
          error: err.message,
        };
      }
    },
  },
});
