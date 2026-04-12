'use strict';

/**
 * Step: Summary Prints — RunGuard, DecisionTrail, StageSmartSkip
 *
 * Print formatted summaries for operational awareness.
 *
 * Priority: 36
 * After: obs-flush, self-reflection
 */

const { TeardownStep } = require('../teardown-step');

class SummaryPrintsStep extends TeardownStep {
  constructor() {
    super({
      name: 'summary-prints',
      description: 'Print RunGuard, DecisionTrail, and StageSmartSkip summaries',
      priority: 36,
      after: ['obs-flush', 'self-reflection'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    // Agent Self-Report flush
    if (orch._selfReportCollector) {
      try {
        const reportsWritten = orch._selfReportCollector.flush();
        if (reportsWritten > 0) {
          const stats = orch._selfReportCollector.getStats();
          console.log(`[Orchestrator] 📊 Agent Self-Reports: ${reportsWritten} report(s) persisted (compliance: ${stats.complianceRate}, avg confidence: ${stats.avgConfidence.toFixed(1)}/5).`);
        }
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  Agent Self-Report flush failed (non-fatal): ${srErr.message}`);
      }
    }

    // RunGuard summary
    if (orch.runGuard) {
      try {
        const guardSummary = orch.runGuard.formatSummary();
        if (guardSummary) {
          console.log(guardSummary);
        }
        if (orch.obs.recordRunGuardSummary) {
          orch.obs.recordRunGuardSummary(orch.runGuard.getSummary());
        }
      } catch (rgErr) {
        console.warn(`[Orchestrator] ⚠️  RunGuard summary failed (non-fatal): ${rgErr.message}`);
      }
    }

    // DecisionTrail timeline
    if (orch.decisionTrail) {
      try {
        const timeline = orch.decisionTrail.formatTimeline();
        if (timeline) {
          console.log(timeline);
        }
      } catch (dtErr) {
        console.warn(`[Orchestrator] ⚠️  DecisionTrail summary failed (non-fatal): ${dtErr.message}`);
      }
    }

    // StageSmartSkip summary
    if (orch.stageSmartSkip) {
      try {
        const skipSummary = orch.stageSmartSkip.formatSummary();
        if (skipSummary) {
          console.log(skipSummary);
        }
      } catch (ssErr) {
        console.warn(`[Orchestrator] ⚠️  StageSmartSkip summary failed (non-fatal): ${ssErr.message}`);
      }
    }
  }
}

module.exports = { SummaryPrintsStep };
