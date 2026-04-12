'use strict';

/**
 * Step: Prompt Auto-Optimizer (P2 Feature #3)
 *
 * Feedback-driven prompt improvement analysis and optimization.
 *
 * Priority: 64
 * After: feedback-system
 */

const { TeardownStep } = require('../teardown-step');
const { PromptAutoOptimizer } = require('../prompt-auto-optimizer');
const { PATHS } = require('../constants');
const path = require('path');

class PromptOptimizerStep extends TeardownStep {
  constructor() {
    super({
      name: 'prompt-optimizer',
      description: 'Feedback-driven prompt auto-optimization (P2)',
      priority: 64,
      after: ['feedback-system'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const promptOptimizer = new PromptAutoOptimizer({
        outputDir: orch._outputDir || PATHS.OUTPUT,
        autoApply: orch._config?.promptAutoOptimization?.autoApply ?? false,
      });
      const optResult = promptOptimizer.analyzeAndOptimize();

      if (optResult.status === 'completed') {
        console.log(`[Orchestrator] 📝 Prompt Auto-Optimizer: ${optResult.suggestions?.length || 0} suggestion(s) generated`);
        if (optResult.applied?.length > 0) {
          console.log(`[Orchestrator]    → ${optResult.applied.length} optimization(s) auto-applied`);
        }

        const reportContent = promptOptimizer.generateReport(
          path.join(orch._outputDir || PATHS.OUTPUT, 'prompt-optimization-report.md')
        );
        if (reportContent) {
          console.log(`[Orchestrator]    → Report generated: prompt-optimization-report.md`);
        }
      } else if (optResult.status === 'skipped') {
        console.log(`[Orchestrator] ⏭️  Prompt Auto-Optimizer: ${optResult.reason}`);
      }
    } catch (optErr) {
      console.warn(`[Orchestrator] ⚠️  Prompt Auto-Optimizer failed (non-fatal): ${optErr.message}`);
    }
  }
}

module.exports = { PromptOptimizerStep };
