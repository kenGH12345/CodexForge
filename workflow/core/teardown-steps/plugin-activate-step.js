'use strict';

/**
 * Step: Plugin Registry Activation
 *
 * Auto-discover and activate plugins from core/plugins/ directory.
 * This must run FIRST so that plugin instances are available for later steps.
 *
 * Priority: 10 (earliest)
 * After: (none)
 * Before: plugin-deactivate
 */

const { TeardownStep } = require('../teardown-step');
const path = require('path');

class PluginActivateStep extends TeardownStep {
  constructor() {
    super({
      name: 'plugin-activate',
      description: 'Auto-discover and activate lifecycle plugins',
      priority: 10,
      before: ['plugin-deactivate'],
      requires: [],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { LifecyclePluginRegistry } = require('../lifecycle-plugin-registry');
      const pluginDir = path.join(__dirname, '..', 'plugins');

      if (!orch._pluginRegistry) {
        orch._pluginRegistry = new LifecyclePluginRegistry();
        orch._pluginRegistry.autoDiscover(pluginDir);
        orch._pluginInstances = orch._pluginInstances || {};
      }

      // Activate all init-phase plugins (captures baselines, etc.)
      const { activated, failed } = await orch._pluginRegistry.activateAll('teardown', orch);

      // Store activated instances for plugin-internal access
      for (const plugin of orch._pluginRegistry.getActivated()) {
        if (plugin._instance) {
          orch._pluginInstances[plugin.name] = plugin._instance;
        }
      }

      if (activated.length > 0) {
        console.log(`[Orchestrator] 🔌 Plugin Registry: ${activated.length} plugin(s) activated${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
      }
    } catch (prErr) {
      console.warn(`[Orchestrator] ⚠️  Plugin Registry activation failed (non-fatal): ${prErr.message}`);
    }
  }
}

module.exports = { PluginActivateStep };
