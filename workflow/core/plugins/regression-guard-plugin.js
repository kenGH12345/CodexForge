'use strict';

/**
 * Regression Guard Plugin — Declarative lifecycle integration
 *
 * Phase 2 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in orchestrator-teardown-impl.js.
 * This module has the MOST integration points (7 files) and the highest
 * API mismatch risk, making it the prime candidate for plugin migration.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { outputDir, verbose, targets }
 *   - captureBaseline() — NO parameters, loads from ObsStrategy internally
 *   - compareWithBaseline(currentMetrics) → { improved, degraded, unchanged, regressions, delta, targetGaps }
 *   - Micro-cycle: snapshotMetrics(), evaluateMicroDelta(before, after, opts)
 *   - History: recordOutcome(), loadHistory(), getTrend()
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'regression-guard',
  phase: PluginPhase.BOTH,
  hooks: ['WORKFLOW_COMPLETE', 'AFTER_STATE_TRANSITION'],
  priority: PluginPriority.HIGH,
  description: 'Capture pre-evolve quality baseline and detect regressions after MAPE/sleeptime cycles',

  async activate(orch) {
    const { RegressionGuard } = require('../regression-guard');
    const { PATHS } = require('../constants');

    const guard = new RegressionGuard({
      outputDir: orch._outputDir || PATHS.OUTPUT,
      verbose: orch._verbose,
    });

    // Capture baseline immediately on activation (before MAPE runs)
    try {
      guard.captureBaseline();
      console.log(`[Plugin:rg] 🛡️  Quality baseline captured for post-evolve comparison`);
    } catch (err) {
      console.warn(`[Plugin:rg] ⚠️  Baseline capture failed (non-fatal): ${err.message}`);
    }

    return guard;
  },

  async onStage(event, orch) {
    // On WORKFLOW_COMPLETE, perform the post-evolve regression check
    if (event === 'WORKFLOW_COMPLETE' || event === 'FINISHED') {
      const guard = orch._pluginInstances?.['regression-guard'];
      if (!guard) return;

      try {
        const postMetrics = orch.obs?.getMetricsSnapshot?.() || {};
        const regressionResult = guard.compareWithBaseline(postMetrics);

        if (regressionResult.regressions.length > 0) {
          console.warn(`[Plugin:rg] 🛡️  ${regressionResult.regressions.length} regression(s) detected after evolve!`);
          for (const reg of regressionResult.regressions.slice(0, 5)) {
            console.warn(`  → ${reg.metric}: ${reg.direction === 'minimize' ? '↑' : '↓'} ${reg.delta} (threshold: ${reg.threshold})`);
          }

          // Record regression as negative experience
          if (orch.experienceStore) {
            orch.experienceStore.recordIfAbsent('evolve-regression', {
              type: 'negative',
              category: 'quality_gate',
              title: 'Quality regression detected after evolve cycle',
              content: `Regressions: ${regressionResult.regressions.map(r => `${r.metric} ${r.delta}`).join(', ')}`,
              tags: ['regression', 'evolve', 'quality-guard'],
              ttlDays: 90,
            });
          }
        } else {
          console.log(`[Plugin:rg] 🛡️  No regressions detected — evolve cycle was safe.`);
        }
      } catch (err) {
        console.warn(`[Plugin:rg] ⚠️  Post-evolve check failed (non-fatal): ${err.message}`);
      }
    }
  },

  async deactivate(orch) {
    // Deactivate triggers the same post-evolve check via onStage pattern
    // The actual check is in onStage — deactivate is for cleanup only
    const guard = orch._pluginInstances?.['regression-guard'];
    if (!guard) return;

    try {
      const postMetrics = orch.obs?.getMetricsSnapshot?.() || {};
      const regressionResult = guard.compareWithBaseline(postMetrics);

      if (regressionResult.regressions.length > 0) {
        console.warn(`[Plugin:rg] 🛡️  ${regressionResult.regressions.length} regression(s) detected at teardown!`);
        if (orch.experienceStore) {
          orch.experienceStore.recordIfAbsent('evolve-regression', {
            type: 'negative',
            category: 'quality_gate',
            title: 'Quality regression detected after evolve cycle',
            content: `Regressions: ${regressionResult.regressions.map(r => `${r.metric} ${r.delta}`).join(', ')}`,
            tags: ['regression', 'evolve', 'quality-guard'],
            ttlDays: 90,
          });
        }
      }
    } catch (err) {
      console.warn(`[Plugin:rg] ⚠️  Regression check at teardown failed (non-fatal): ${err.message}`);
    }
  },
});
