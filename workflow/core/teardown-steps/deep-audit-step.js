'use strict';

/**
 * Step: Deep Audit Orchestrator (P1)
 *
 * Comprehensive cross-module health assessment.
 * Fire-and-forget: runs as one of the last steps.
 *
 * Priority: 66
 * After: prompt-optimizer
 */

const { TeardownStep } = require('../teardown-step');
const { PATHS } = require('../constants');

class DeepAuditStep extends TeardownStep {
  constructor() {
    super({
      name: 'deep-audit',
      description: 'Cross-module health assessment via DeepAuditOrchestrator (P1)',
      priority: 66,
      after: ['prompt-optimizer'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { DeepAuditOrchestrator } = require('../deep-audit-orchestrator');
      const auditor = new DeepAuditOrchestrator({
        outputDir: orch._outputDir || PATHS.OUTPUT,
        experienceStore: orch.experienceStore || null,
        verbose: orch._verbose,
      });

      const auditReport = await auditor.run();
      if (auditReport && auditReport.stats) {
        const { critical = 0, high = 0, medium = 0, low = 0, info = 0 } = auditReport.stats;
        const totalFindings = critical + high + medium + low + info;
        if (totalFindings > 0) {
          console.log(`[Orchestrator] 🔎 DeepAudit: ${totalFindings} finding(s) (${critical} critical, ${high} high, ${medium} medium)`);
        } else {
          console.log(`[Orchestrator] ✅ DeepAudit: no cross-module issues found`);
        }
      }
    } catch (daErr) {
      console.warn(`[Orchestrator] ⚠️  Deep Audit Orchestrator failed (non-fatal): ${daErr.message}`);
    }
  }
}

module.exports = { DeepAuditStep };
