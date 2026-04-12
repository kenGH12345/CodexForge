'use strict';

/**
 * Step: Self-Reflection Quality Gate Validation (P1)
 *
 * Validate quality gates against pre-flush metrics,
 * perform proactive health audit, and flush reflection data.
 *
 * Priority: 32
 * After: obs-flush
 * Requires: _selfReflection
 * Condition: shouldEvolve.selfReflection
 */

const { TeardownStep } = require('../teardown-step');

class SelfReflectionStep extends TeardownStep {
  constructor() {
    super({
      name: 'self-reflection',
      description: 'Quality gate validation and proactive health audit',
      priority: 32,
      after: ['obs-flush'],
      requires: ['_selfReflection'],
      shouldSkip: (ctx) => {
        if (!ctx.shouldEvolve.selfReflection) {
          return 'No errors, short session';
        }
        return false;
      },
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const preFlushMetrics = orch.obs.getMetricsSnapshot ? orch.obs.getMetricsSnapshot() : null;

      if (preFlushMetrics) {
        const gatingResult = orch._selfReflection.validateRun(preFlushMetrics);
        orch.obs.recordReflectionGating(gatingResult);

        if (!gatingResult.passed) {
          console.warn(`[Orchestrator] ❌ Self-Reflection: ${gatingResult.gates.filter(g => !g.passed).length} quality gate(s) failed.`);
        }
      }

      const auditResult = await orch._selfReflection.auditHealth();
      if (auditResult.findings.length > 0) {
        console.log(`[Orchestrator] 🔍 Self-Reflection health audit: ${auditResult.findings.length} finding(s)`);
      }

      orch._selfReflection.flush();
    } catch (srErr) {
      console.warn(`[Orchestrator] ⚠️  Self-Reflection integration failed (non-fatal): ${srErr.message}`);
    }
  }
}

module.exports = { SelfReflectionStep };
