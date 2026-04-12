'use strict';

/**
 * Step: Agent Handoff Log Flush
 *
 * Print handoff summary and flush the handoff log.
 *
 * Priority: 44
 * After: obs-dashboard
 */

const { TeardownStep } = require('../teardown-step');

class HandoffLogStep extends TeardownStep {
  constructor() {
    super({
      name: 'handoff-log',
      description: 'Print and flush agent handoff log',
      priority: 44,
      after: ['obs-dashboard'],
      requires: ['handoffLog'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      orch.handoffLog.printSummary();
      orch.handoffLog.flush();
    } catch (handoffErr) {
      console.warn(`[Orchestrator] ⚠️  Handoff Log flush failed (non-fatal): ${handoffErr.message}`);
    }
  }
}

module.exports = { HandoffLogStep };
