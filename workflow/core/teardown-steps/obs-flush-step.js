'use strict';

/**
 * Step: Observability Metrics Flush
 *
 * Snapshot prompt variant stats, adapter telemetry, then flush metrics.
 * Must run BEFORE dashboard print so numbers are accurate.
 *
 * Priority: 30
 * After: session-signal, failure-pattern, issue-pattern
 * Before: obs-dashboard
 */

const { TeardownStep } = require('../teardown-step');

class ObsFlushStep extends TeardownStep {
  constructor() {
    super({
      name: 'obs-flush',
      description: 'Snapshot variant/telemetry stats and flush observability metrics',
      priority: 30,
      after: ['session-signal', 'failure-pattern', 'issue-pattern'],
      before: ['obs-dashboard'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    // Prompt A/B: snapshot variant stats into Observability before flush
    if (orch.promptSlotManager) {
      orch.obs.recordPromptVariantUsage(orch.promptSlotManager.getStats());
    }

    // Adapter Telemetry: snapshot block lifecycle stats into Observability
    if (orch._adapterTelemetry) {
      try {
        const telemetryReport = orch._adapterTelemetry.getReport();
        orch.obs.recordBlockTelemetry(telemetryReport);
        if (telemetryReport.recommendations.length > 0) {
          console.log(`[Orchestrator] 📊 Adapter telemetry: ${telemetryReport.recommendations.length} recommendation(s):`);
          for (const rec of telemetryReport.recommendations.slice(0, 5)) {
            console.log(`  → ${rec}`);
          }
        }
        if (telemetryReport.summary.totalSavedByCompression > 0) {
          console.log(`[Orchestrator] 🗜️  Total compression savings: ${telemetryReport.summary.totalSavedByCompression} chars across ${telemetryReport.summary.totalBlocks} block(s).`);
        }
      } catch (telErr) {
        console.warn(`[Orchestrator] ⚠️  Adapter telemetry report failed (non-fatal): ${telErr.message}`);
      }
    }

    // Flush metrics BEFORE printDashboard
    try {
      orch.obs.flush();
    } catch (flushErr) {
      console.warn(`[Orchestrator] ⚠️  Observability flush failed (non-fatal): ${flushErr.message}`);
    }
  }
}

module.exports = { ObsFlushStep };
