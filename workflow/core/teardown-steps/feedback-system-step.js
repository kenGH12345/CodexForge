'use strict';

/**
 * Step: Agent Feedback System Finalization
 *
 * Flush feedback history and print/generate reports.
 *
 * Priority: 62
 * After: independent-evaluator
 * Requires: feedbackSystem
 */

const { TeardownStep } = require('../teardown-step');

class FeedbackSystemStep extends TeardownStep {
  constructor() {
    super({
      name: 'feedback-system',
      description: 'Flush and finalize agent feedback system',
      priority: 62,
      after: ['independent-evaluator'],
      requires: ['feedbackSystem'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      orch.feedbackSystem.printFeedbackSummary();
      orch.feedbackSystem.saveFeedbackReport();
      orch.feedbackSystem.flush();
    } catch (feedbackErr) {
      console.warn(`[Orchestrator] ⚠️  Feedback system finalization failed (non-fatal): ${feedbackErr.message}`);
    }
  }
}

module.exports = { FeedbackSystemStep };
