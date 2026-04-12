'use strict';

/**
 * Step: Risk Correlation Analysis (P3)
 *
 * Detect cross-stage risk chains and print risk summary.
 *
 * Priority: 42
 * After: obs-dashboard
 */

const { TeardownStep } = require('../teardown-step');
const { _analyseRiskCorrelations } = require('../orchestrator-teardown-impl');

class RiskCorrelationStep extends TeardownStep {
  constructor() {
    super({
      name: 'risk-correlation',
      description: 'Cross-stage risk correlation analysis and risk summary',
      priority: 42,
      after: ['obs-dashboard'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    const risks = orch.stateMachine.getRisks ? orch.stateMachine.getRisks() : [];
    if (risks.length >= 2) {
      try {
        const correlatedRisks = _analyseRiskCorrelations(risks, orch.stageCtx);
        if (correlatedRisks.length > 0) {
          console.warn(`\n${'─'.repeat(60)}`);
          console.warn(`  🔗 RISK CORRELATION ANALYSIS (${correlatedRisks.length} chain(s) found)`);
          console.warn(`${'─'.repeat(60)}`);
          for (const chain of correlatedRisks) {
            console.warn(`  ⛓️  [${chain.severity.toUpperCase()}] ${chain.label}`);
            console.warn(`      Contributing factors:`);
            for (const factor of chain.factors) {
              console.warn(`        → [${factor.stage}] ${factor.description.slice(0, 120)}`);
            }
            console.warn(`      Impact: ${chain.impact}`);
            if (chain.recommendation) {
              console.warn(`      Recommendation: ${chain.recommendation}`);
            }
            orch.stateMachine.recordRisk(chain.severity,
              `[RiskCorrelation] ${chain.label}: ${chain.factors.map(f => f.description.slice(0, 60)).join(' + ')}. Impact: ${chain.impact}`,
              false
            );
          }
          console.warn(`${'─'.repeat(60)}`);
          orch.stateMachine.flushRisks();
        }
      } catch (corrErr) {
        console.warn(`[Orchestrator] ⚠️  Risk correlation analysis failed (non-fatal): ${corrErr.message}`);
      }
    }

    // Print accumulated risk summary
    const allRisks = orch.stateMachine.getRisks ? orch.stateMachine.getRisks() : [];
    if (allRisks.length > 0) {
      console.warn(`\n${'─'.repeat(60)}`);
      console.warn(`  ⚠️  RISK SUMMARY (${allRisks.length} item(s))`);
      console.warn(`${'─'.repeat(60)}`);
      for (const r of allRisks) {
        console.warn(`  [${r.severity?.toUpperCase() ?? 'UNKNOWN'}] ${r.description}`);
      }
      console.warn(`${'─'.repeat(60)}\n`);
    }
  }
}

module.exports = { RiskCorrelationStep };
