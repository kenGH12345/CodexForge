'use strict';

/**
 * Step: Auto-Deploy YELLOW Tier (P1, ADR-34)
 *
 * Apply YELLOW-tier configuration auto-deployment based on post-run strategy.
 *
 * Priority: 46
 * After: obs-dashboard
 * Requires: autoDeployer
 * Condition: shouldEvolve.autoDeploy
 */

const { TeardownStep } = require('../teardown-step');

class AutoDeployStep extends TeardownStep {
  constructor() {
    super({
      name: 'auto-deploy',
      description: 'Apply YELLOW-tier configuration auto-deployment (ADR-34)',
      priority: 46,
      after: ['obs-dashboard'],
      requires: ['autoDeployer'],
      shouldSkip: (ctx) => {
        if (!ctx.shouldEvolve.autoDeploy) {
          return 'No strategy history';
        }
        return false;
      },
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const Observability = require('../observability');
      const cfgAutoFix = (orch._config && orch._config.autoFixLoop) || {};
      const postRunStrategy = Observability.deriveStrategy(orch._outputDir, {
        maxFixRounds: cfgAutoFix.maxFixRounds ?? 2,
        maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
        maxExpInjected: cfgAutoFix.maxExpInjected ?? 5,
        projectId: orch.projectId,
      });

      if (postRunStrategy.source !== 'defaults') {
        const yellowResult = orch.autoDeployer.applyYellow(postRunStrategy);
        if (yellowResult.applied && yellowResult.changes.length > 0) {
          console.log(`[Orchestrator] 🟡 Auto-Deploy: ${yellowResult.changes.length} config param(s) updated for next run.`);
        }
      }
    } catch (adErr) {
      console.warn(`[Orchestrator] ⚠️  Auto-Deploy (YELLOW) failed (non-fatal): ${adErr.message}`);
    }
  }
}

module.exports = { AutoDeployStep };
