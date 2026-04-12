'use strict';

/**
 * Step: Regression Guard – Pre/Post Evolution Quality Delta Tracking
 *
 * Captures a quality baseline BEFORE evolution (MAPE/sleeptime) runs,
 * then compares post-evolution metrics against the baseline after
 * EvolutionPipelineStep completes.
 *
 * Design: Wraps the existing RegressionGuard class (core/regression-guard.js)
 * into the declarative teardown pipeline. Previously this logic was embedded
 * in the legacy 1387-line _finalizeWorkflow() method.
 *
 * Execution: Two-phase within a single step:
 *   Phase 1 (before evolution): captureBaseline()
 *   Phase 2 (after evolution):  compareWithBaseline() + recordOutcome()
 *
 * Since steps execute sequentially and EvolutionPipelineStep runs at
 * priority 25, this step's before constraint ensures baseline capture
 * happens first, then comparison happens after evolution completes.
 *
 * Priority: 22 (between aef-refinement:20 and evolution-pipeline:25)
 * After: aef-refinement
 * Before: evolution-pipeline
 */

const { TeardownStep } = require('../teardown-step');

class RegressionGuardStep extends TeardownStep {
  constructor() {
    super({
      name: 'regression-guard',
      description: 'Capture quality baseline before evolution and compare after',
      priority: 22,
      after: ['aef-refinement'],
      before: ['evolution-pipeline'],
    });
  }

  async execute(ctx) {
    const { orch, mode } = ctx;

    // Phase 1: Capture baseline BEFORE evolution
    let regressionGuard = null;
    try {
      const { RegressionGuard } = require('../regression-guard');
      regressionGuard = new RegressionGuard({
        outputDir: orch._outputDir || orch.outputDir,
        verbose: orch._verbose,
      });
      regressionGuard.captureBaseline();
      console.log(`[Orchestrator] 🛡️  RegressionGuard: quality baseline captured for post-evolve comparison.`);

      // Store guard instance on context for post-evolution comparison
      ctx._regressionGuard = regressionGuard;
    } catch (rgErr) {
      console.warn(`[Orchestrator] ⚠️  RegressionGuard baseline capture failed (non-fatal): ${rgErr.message}`);
    }

    // Register a post-evolution callback on the context
    // This will be called by EvolutionPipelineStep after it completes
    if (regressionGuard) {
      ctx._postEvolutionCallbacks = ctx._postEvolutionCallbacks || [];
      ctx._postEvolutionCallbacks.push(async () => {
        try {
          const postMetrics = orch.obs?.getMetricsSnapshot ? orch.obs.getMetricsSnapshot() : {};
          const regressionResult = regressionGuard.compareWithBaseline(postMetrics);

          if (regressionResult.regressions.length > 0) {
            console.warn(`[Orchestrator] 🛡️  RegressionGuard: ${regressionResult.regressions.length} regression(s) detected after evolve!`);
            for (const reg of regressionResult.regressions.slice(0, 5)) {
              console.warn(`  → ${reg.metric || reg.reason}: ${reg.direction === 'minimize' ? '↑' : '↓'} delta detected`);
            }

            // Record regression as negative experience
            if (orch.experienceStore) {
              orch.experienceStore.recordIfAbsent('evolve-regression', {
                type: 'negative',
                category: 'quality_gate',
                title: 'Quality regression detected after evolve cycle',
                content: `Regressions: ${regressionResult.regressions.map(r => `${r.metric || r.reason} ${r.delta || 'changed'}`).join(', ')}`,
                tags: ['regression', 'evolve', 'quality-guard'],
                ttlDays: 90,
              });
            }
          } else {
            console.log(`[Orchestrator] 🛡️  RegressionGuard: no regressions detected — evolve cycle was safe.`);
          }
        } catch (rgErr) {
          console.warn(`[Orchestrator] ⚠️  RegressionGuard post-evolve check failed (non-fatal): ${rgErr.message}`);
        }
      });
    }
  }
}

module.exports = { RegressionGuardStep };
