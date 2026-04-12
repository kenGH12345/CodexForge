'use strict';

/**
 * Step: Workflow Introspection Finalization
 *
 * Health check, generate reports, and finalize introspection session.
 *
 * Priority: 56
 * After: staleness-check
 * Requires: introspectionManager
 */

const { TeardownStep } = require('../teardown-step');

class IntrospectionStep extends TeardownStep {
  constructor() {
    super({
      name: 'introspection',
      description: 'Finalize workflow introspection and generate reports',
      priority: 56,
      after: ['staleness-check'],
      requires: ['introspectionManager'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      // Perform validation before finalizing
      const healthCheck = orch.introspectionManager.healthCheck();
      if (!healthCheck.healthy) {
        console.warn(`[Orchestrator] ⚠️  Introspection health check: ${healthCheck.issues.errors} error(s), ${healthCheck.issues.warnings} warning(s)`);
        console.warn(`[Orchestrator]    ${healthCheck.suggestion}`);
      } else {
        console.log(`[Orchestrator] ✅ Introspection health check: All modules operating consistently (${healthCheck.moduleCoverage} modules active)`);
      }

      // Generate final reports
      const reportPaths = orch.introspectionManager.generateReports();
      if (reportPaths.markdownPath) {
        console.log(`[Orchestrator] 🔍 Workflow Introspection Report: ${reportPaths.markdownPath}`);
      }

      // Finalize the introspection session
      orch.introspectionManager.finalize();
    } catch (introspectionErr) {
      console.warn(`[Orchestrator] ⚠️  Introspection finalize failed (non-fatal): ${introspectionErr.message}`);
    }
  }
}

module.exports = { IntrospectionStep };
