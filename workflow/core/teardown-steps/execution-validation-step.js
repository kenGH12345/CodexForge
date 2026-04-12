'use strict';

/**
 * Step: Execution Log Validation
 *
 * Auto-validate execution against standard workflow flow templates.
 * Generates execution quality report for post-mortem analysis.
 *
 * Priority: 58
 * After: introspection
 */

const { TeardownStep } = require('../teardown-step');
const { PATHS } = require('../constants');
const path = require('path');

class ExecutionValidationStep extends TeardownStep {
  constructor() {
    super({
      name: 'execution-validation',
      description: 'Validate execution against workflow flow templates',
      priority: 58,
      after: ['introspection'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;
    const shouldValidate = orch._config?.executionValidation !== false;
    if (!shouldValidate) {
      console.log(`[Orchestrator] ⏭️  Execution validation skipped (disabled in config)`);
      return;
    }

    try {
      const { ExecutionLogValidator } = require('../execution-log-validator');
      const validator = new ExecutionLogValidator({
        outputDir: orch._outputDir || PATHS.OUTPUT,
        verbose: false,
        strictMode: false,
        reportOutputDir: orch._outputDir || PATHS.OUTPUT,
      });

      console.log(`[Orchestrator] 🔍 Running execution validation...`);
      const validationResult = await validator.validate();

      const { summary } = validationResult.report;
      const statusEmoji = summary.status === 'passed' ? '✅' :
                         summary.status === 'passed_with_warnings' ? '⚠️' : '❌';
      console.log(`[Orchestrator] ${statusEmoji} Execution Validation: ${summary.status.toUpperCase()} (${summary.score}/100)`);
      console.log(`[Orchestrator]    Stages: ${summary.completedStages}/${summary.totalStages} completed, ${summary.failedStages} failed`);

      if (summary.warnings > 0) {
        console.log(`[Orchestrator]    Warnings: ${summary.warnings}`);
      }

      orch._lastExecutionValidation = validationResult;

      // Inject low-score findings into ExperienceStore
      if (summary.score < 80 && orch.experienceStore) {
        orch.experienceStore.recordIfAbsent('execution-validation-low-score', {
          type: 'negative',
          category: 'execution_quality',
          title: 'Execution validation score below threshold',
          content: `Execution validation score: ${summary.score}/100. ` +
                   `Failed stages: ${summary.failedStages}. ` +
                   `Warnings: ${summary.warnings}. ` +
                   `Report: ${validationResult.reportPaths?.latestMarkdown || 'N/A'}`,
          tags: ['execution-validation', 'quality-issue'],
          metrics: { score: summary.score },
        });
        console.log(`[Orchestrator]    ⚠️  Low execution quality recorded to ExperienceStore`);
      }

      if (validationResult.reportPaths?.latestMarkdown) {
        console.log(`[Orchestrator]    Report: ${path.basename(validationResult.reportPaths.latestMarkdown)}`);
      }
    } catch (validationErr) {
      console.warn(`[Orchestrator] ⚠️  Execution validation failed (non-fatal): ${validationErr.message}`);
    }
  }
}

module.exports = { ExecutionValidationStep };
