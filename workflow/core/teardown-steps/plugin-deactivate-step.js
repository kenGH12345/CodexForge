'use strict';

/**
 * Step: Plugin Deactivation
 *
 * Deactivate all registered lifecycle plugins.
 * Must be the LAST teardown step to allow plugins to participate
 * in all earlier steps.
 *
 * Priority: 90 (latest)
 * After: git-pr
 */

const { TeardownStep } = require('../teardown-step');

class PluginDeactivateStep extends TeardownStep {
  constructor() {
    super({
      name: 'plugin-deactivate',
      description: 'Deactivate all registered lifecycle plugins',
      priority: 90,
      after: ['git-pr'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      if (orch._pluginRegistry) {
        const { deactivated, failed } = await orch._pluginRegistry.deactivateAll('teardown', orch);
        if (deactivated.length > 0) {
          console.log(`[Orchestrator] 🔌 Plugin Registry: ${deactivated.length} plugin(s) deactivated${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
        }
      }
    } catch (pdErr) {
      console.warn(`[Orchestrator] ⚠️  Plugin deactivation failed (non-fatal): ${pdErr.message}`);
    }
  }
}

module.exports = { PluginDeactivateStep };
