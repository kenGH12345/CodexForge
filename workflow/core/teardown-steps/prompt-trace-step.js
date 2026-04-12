'use strict';

/**
 * Step: Prompt Trace Flush (P0)
 *
 * Flush prompt trace digests for replay & debugging.
 *
 * Priority: 34
 * After: obs-flush
 */

const { TeardownStep } = require('../teardown-step');

class PromptTraceStep extends TeardownStep {
  constructor() {
    super({
      name: 'prompt-trace',
      description: 'Flush prompt trace digests for replay and debugging',
      priority: 34,
      after: ['obs-flush'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const tracesWritten = orch.obs.flushPromptTraces();
      if (tracesWritten > 0) {
        console.log(`[Orchestrator] 📝 Prompt traces: ${tracesWritten} trace(s) persisted for replay & debugging.`);
      }
    } catch (ptErr) {
      console.warn(`[Orchestrator] ⚠️  Prompt trace flush failed (non-fatal): ${ptErr.message}`);
    }
  }
}

module.exports = { PromptTraceStep };
