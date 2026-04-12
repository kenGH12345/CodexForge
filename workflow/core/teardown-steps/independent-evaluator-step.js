'use strict';

/**
 * Step: Independent Evaluator (ADR-52)
 *
 * Multi-dimensional quality assessment reading from DISK (not memory)
 * to avoid "self-grading" bias.
 *
 * Priority: 60
 * After: execution-validation
 */

const { TeardownStep } = require('../teardown-step');
const { PATHS } = require('../constants');
const path = require('path');
const fs = require('fs');

class IndependentEvaluatorStep extends TeardownStep {
  constructor() {
    super({
      name: 'independent-evaluator',
      description: 'Multi-dimensional quality assessment from disk (ADR-52)',
      priority: 60,
      after: ['execution-validation'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { runIndependentEvaluation } = require('../independent-evaluator');
      const outputDir = orch._outputDir || PATHS.OUTPUT;

      console.log(`[Orchestrator] 🔬 Independent Evaluator: Running multi-dimensional assessment...`);
      const evaluation = runIndependentEvaluation(outputDir, {
        evaluatorMode: 'independent',
      });

      const { summary } = evaluation;
      console.log(`[Orchestrator]    Composite Score: ${summary.compositeScore}/100`);
      console.log(`[Orchestrator]    Passed: ${summary.passed ? '✅' : '❌'} (threshold: 60)`);
      console.log(`[Orchestrator]    Quality Gate: ${summary.qualityGatePassed ? '✅' : '❌'} (threshold: 70)`);

      for (const [dim, score] of Object.entries(summary.dimensions)) {
        console.log(`[Orchestrator]      - ${dim}: ${score}`);
      }

      if (summary.recommendations?.length > 0) {
        console.log(`[Orchestrator]    📋 Recommendations:`);
        for (const rec of summary.recommendations.slice(0, 3)) {
          console.log(`[Orchestrator]       [${rec.priority}] ${rec.message}`);
        }
      }

      // Save evaluation report
      const evaluationReportPath = path.join(outputDir, 'evaluation-report.json');
      fs.writeFileSync(evaluationReportPath, JSON.stringify(evaluation, null, 2));
      console.log(`[Orchestrator]    📄 Evaluation report: evaluation-report.json`);

      // Record low scores to ExperienceStore
      if (summary.compositeScore < 60 && orch.experienceStore) {
        orch.experienceStore.recordIfAbsent('evaluation-low-score', {
          type: 'negative',
          category: 'quality_gate',
          title: 'Independent evaluation score below threshold',
          content: `Composite score: ${summary.compositeScore}/100. ` +
                   `Dimensions: ${JSON.stringify(summary.dimensions)}. ` +
                   `Recommendations: ${summary.recommendations?.slice(0, 3).map(r => r.message).join('; ')}`,
          tags: ['evaluation', 'quality-issue', 'adr-52'],
          metrics: { compositeScore: summary.compositeScore },
        });
      }
    } catch (evalErr) {
      console.warn(`[Orchestrator] ⚠️  Independent Evaluator failed (non-fatal): ${evalErr.message}`);
    }
  }
}

module.exports = { IndependentEvaluatorStep };
