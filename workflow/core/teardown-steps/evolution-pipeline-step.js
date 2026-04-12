'use strict';

/**
 * Step: Evolution Pipelines (MAPE Engine + Sleeptime Maintenance)
 *
 * Run MAPE cycle and sleeptime maintenance if evolution is triggered.
 * Must run early so that evolution results are captured in metrics.
 *
 * TD-3 Fix: MAPEEngine and sleeptime are instantiated directly here
 * (matching the legacy path pattern), not via orch.mapeEngine / orch.sleeptimeMaintenance
 * which were never mounted on the orchestrator instance.
 *
 * Priority: 25
 * After: regression-guard
 * Before: obs-flush
 */

const { TeardownStep } = require('../teardown-step');

class EvolutionPipelineStep extends TeardownStep {
  constructor() {
    super({
      name: 'evolution-pipeline',
      description: 'Run MAPE engine cycle and sleeptime maintenance',
      priority: 25,
      after: ['regression-guard'],
      before: ['obs-flush'],
    });
  }

  async execute(ctx) {
    const { orch, mode, shouldEvolve } = ctx;

    // MAPE Engine cycle — instantiate directly (TD-3: orch.mapeEngine was never mounted)
    if (shouldEvolve.mape) {
      try {
        const { MAPEEngine } = require('../mape-engine');
        const mape = new MAPEEngine({ orchestrator: orch, verbose: orch._verbose });
        const mapeReport = await mape.runCycle({ dryRun: false, maxActions: 5 });

        if (mapeReport.phases.monitor.signalCount > 0) {
          console.log(`[Orchestrator] 🔄 MAPE Engine: ${mapeReport.phases.monitor.signalCount} signal(s) detected`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.analyze.rootCauses} root cause(s), ${mapeReport.phases.analyze.correlations} correlation(s)`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.execute.executed} action(s) executed, ${mapeReport.phases.execute.skipped} skipped`);
        }

        if (orch.obs && typeof orch.obs.recordCustomMetric === 'function') {
          orch.obs.recordCustomMetric('mape_cycle', {
            signalCount: mapeReport.phases.monitor.signalCount,
            rootCauses: mapeReport.phases.analyze.rootCauses,
            correlations: mapeReport.phases.analyze.correlations,
            executed: mapeReport.phases.execute.executed,
            elapsed: mapeReport.elapsed,
          });
        }
      } catch (mapeErr) {
        console.warn(`[Orchestrator] ⚠️  MAPE engine cycle failed (non-fatal): ${mapeErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  MAPE engine cycle skipped (stable quality)`);
    }

    // Sleeptime maintenance pipeline — call sleeptime() directly (TD-3 fix)
    if (shouldEvolve.sleeptime) {
      try {
        const { sleeptime } = require('../sleeptime');
        const sleeptimeResult = await sleeptime({
          experienceStore: orch.experienceStore,
          skillEvolution: orch.skillEvolution,
          selfReflection: orch._selfReflection,
          verbose: true,
        });

        if (orch.obs && typeof orch.obs.recordCustomMetric === 'function') {
          orch.obs.recordCustomMetric('sleeptime', {
            totalDurationMs: sleeptimeResult.totalDurationMs,
            stages: sleeptimeResult.stages.map(s => ({ name: s.name, status: s.status })),
          });
        }
      } catch (sleepErr) {
        console.warn(`[Orchestrator] ⚠️  Sleeptime maintenance failed (non-fatal): ${sleepErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  Sleeptime maintenance skipped (no pending tasks)`);
    }

    // Run post-evolution callbacks (e.g. RegressionGuard compareWithBaseline)
    if (ctx._postEvolutionCallbacks && ctx._postEvolutionCallbacks.length > 0) {
      for (const cb of ctx._postEvolutionCallbacks) {
        try {
          await cb();
        } catch (cbErr) {
          console.warn(`[Orchestrator] ⚠️  Post-evolution callback failed (non-fatal): ${cbErr.message}`);
        }
      }
    }
  }
}

module.exports = { EvolutionPipelineStep };
