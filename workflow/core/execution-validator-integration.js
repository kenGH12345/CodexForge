/**
 * Execution Validator Integration — 执行验证系统集成层
 *
 * Purpose: 将 ExecutionLogValidator 无缝集成到现有工作流系统中
 *
 * Integration Points:
 *   1. Orchestrator: 工作流完成后自动触发验证
 *   2. QualityGate: 提供额外的执行质量指标
 *   3. DeepAudit: 验证发现作为审计维度之一
 *   4. ExperienceStore: 执行异常自动记录为经验
 *   5. SelfReflection: 执行质量纳入自审计
 *
 * ADR-37 Compliance: Uses fs/path only, no external deps
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Orchestrator Integration Mixin
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mixin for Orchestrator to add execution validation capabilities.
 *
 * Usage:
 *   const { withExecutionValidation } = require('./execution-validator-integration');
 *   class MyOrchestrator extends withExecutionValidation(BaseOrchestrator) { ... }
 */
function withExecutionValidation(BaseClass) {
  return class extends BaseClass {
    constructor(options = {}) {
      super(options);

      this._executionValidatorEnabled = options.executionValidator !== false;
      this._executionValidatorOptions = {
        strictMode: options.strictMode || false,
        verbose: options.verbose || false,
        ...options.executionValidatorOptions,
      };

      // Lazy-load validator to avoid circular dependencies
      this._executionValidator = null;
    }

    /**
     * Gets or creates ExecutionLogValidator instance.
     */
    _getExecutionValidator() {
      if (!this._executionValidator) {
        const { ExecutionLogValidator } = require('./execution-log-validator');
        this._executionValidator = new ExecutionLogValidator({
          outputDir: this._outputDir,
          verbose: this._executionValidatorOptions.verbose,
          strictMode: this._executionValidatorOptions.strictMode,
          reportOutputDir: this._outputDir,
        });
      }
      return this._executionValidator;
    }

    /**
     * Runs execution validation after workflow completion.
 * Called automatically by teardown pipeline if enabled.
     */
    async validateExecution() {
      if (!this._executionValidatorEnabled) {
        this._log('Execution validation disabled');
        return null;
      }

      try {
        this._log('Running execution validation...');
        const validator = this._getExecutionValidator();
        const result = await validator.validate();

        // Store validation result for other systems
        this._lastExecutionValidation = result;

        // Inject into ExperienceStore if issues found
        if (result.report.summary.score < 80) {
          this._injectValidationFindings(result.report);
        }

        return result;
      } catch (err) {
        this._warn(`Execution validation failed: ${err.message}`);
        return null;
      }
    }

    /**
     * Injects validation findings into ExperienceStore.
     */
    _injectValidationFindings(report) {
      if (!this.experienceStore) return;

      // Record low-score execution as negative experience
      if (report.summary.score < 60) {
        this.experienceStore.recordIfAbsent('execution-validation-low-score', {
          type: 'negative',
          category: 'execution_quality',
          title: 'Execution validation score below threshold',
          content: `Execution validation score: ${report.summary.score}/100. ` +
                   `Failed stages: ${report.summary.failedStages}. ` +
                   `Warnings: ${report.summary.warnings}`,
          tags: ['execution-validation', 'quality-issue'],
          metrics: { score: report.summary.score },
        });
      }

      // Record specific findings
      for (const rec of report.recommendations.filter(r => r.priority === 'high')) {
        this.experienceStore.recordIfAbsent(`exec-val-${rec.type}`, {
          type: 'negative',
          category: 'execution_pattern',
          title: `[Execution] ${rec.message}`,
          content: rec.action,
          tags: ['execution-validation', rec.type, rec.priority],
        });
      }
    }

    /**
     * Returns execution validation metrics for QualityGate.
     */
    getExecutionValidationMetrics() {
      if (!this._lastExecutionValidation) {
        return null;
      }

      const { report } = this._lastExecutionValidation;
      return {
        executionScore: report.summary.score,
        executionStatus: report.summary.status,
        completedStages: report.summary.completedStages,
        failedStages: report.summary.failedStages,
        warnings: report.summary.warnings,
        integrityScore: this._calculateIntegrityScore(report),
      };
    }

    /**
     * Calculates overall integrity score from integrity checks.
     */
    _calculateIntegrityScore(report) {
      if (!report.integrityChecks || report.integrityChecks.length === 0) {
        return 100;
      }

      const scores = report.integrityChecks
        .filter(c => c.score !== undefined)
        .map(c => c.score);

      return scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 100;
    }

    _log(msg) {
      console.log(`[Orchestrator] ${msg}`);
    }

    _warn(msg) {
      console.warn(`[Orchestrator] ⚠️ ${msg}`);
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: QualityGate Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extends QualityGate with execution validation gates.
 *
 * Usage:
 *   const { createExecutionValidationGates } = require('./execution-validator-integration');
 *   const gates = createExecutionValidationGates();
 *   // Add to QualityGate configuration
 */
function createExecutionValidationGates(options = {}) {
  const {
    minExecutionScore = 70,
    maxFailedStages = 0,
    minIntegrityScore = 80,
  } = options;

  return {
    // Gate 1: Minimum execution score
    minExecutionScore: {
      threshold: minExecutionScore,
      validate(metrics) {
        const score = metrics.executionValidation?.executionScore;
        if (score === undefined) return { passed: true, message: 'No execution validation data' };

        const passed = score >= this.threshold;
        return {
          passed,
          actual: `${score}/100`,
          threshold: `${this.threshold}/100`,
          message: passed
            ? `Execution score OK (${score} ≥ ${this.threshold})`
            : `Execution score too low (${score} < ${this.threshold})`,
        };
      },
    },

    // Gate 2: Maximum allowed failed stages
    maxFailedStages: {
      threshold: maxFailedStages,
      validate(metrics) {
        const failed = metrics.executionValidation?.failedStages;
        if (failed === undefined) return { passed: true, message: 'No execution validation data' };

        const passed = failed <= this.threshold;
        return {
          passed,
          actual: failed,
          threshold: this.threshold,
          message: passed
            ? `Failed stages within limit (${failed} ≤ ${this.threshold})`
            : `Too many failed stages (${failed} > ${this.threshold})`,
        };
      },
    },

    // Gate 3: Minimum integrity score
    minIntegrityScore: {
      threshold: minIntegrityScore,
      validate(metrics) {
        const score = metrics.executionValidation?.integrityScore;
        if (score === undefined) return { passed: true, message: 'No execution validation data' };

        const passed = score >= this.threshold;
        return {
          passed,
          actual: `${score}/100`,
          threshold: `${this.threshold}/100`,
          message: passed
            ? `Integrity score OK (${score} ≥ ${this.threshold})`
            : `Integrity score too low (${score} < ${this.threshold})`,
        };
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: DeepAudit Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates execution validation dimension checks for DeepAudit.
 *
 * Usage:
 *   const { createExecutionValidationDimension } = require('./execution-validator-integration');
 *   // Register with DeepAuditOrchestrator
 */
function createExecutionValidationDimension() {
  return {
    name: 'execution-validation',
    displayName: 'Execution Flow Validation',
    description: 'Validates execution logs against standard flow templates',

    async run({ outputDir, addFinding }) {
      const { ExecutionLogValidator } = require('./execution-log-validator');

      const validator = new ExecutionLogValidator({
        outputDir,
        verbose: false,
      });

      const result = await validator.validate();

      // Convert validation report to audit findings
      const findings = [];

      // High-priority: Failed stages
      for (const [stage, validation] of Object.entries(result.report.stageValidations)) {
        if (validation.status === 'failed') {
          findings.push({
            category: 'execution-validation',
            severity: 'high',
            title: `Stage ${stage} validation failed`,
            description: validation.errors.join('; '),
            suggestion: `Re-run ${stage} stage or check artifact generation`,
            locations: [{ stage }],
          });
        }
      }

      // Medium-priority: Flow breaks
      if (result.report.flowValidation?.breaks?.length > 0) {
        findings.push({
          category: 'execution-validation',
          severity: 'medium',
          title: 'Execution flow discontinuity detected',
          description: `Flow breaks: ${result.report.flowValidation.breaks.length}`,
          suggestion: 'Review stage sequencing; ensure all stages complete successfully',
          locations: result.report.flowValidation.breaks.map(b => ({
            from: b.from,
            to: b.to,
          })),
        });
      }

      // Low-priority: Warnings
      if (result.report.summary.warnings > 5) {
        findings.push({
          category: 'execution-validation',
          severity: 'low',
          title: 'High number of validation warnings',
          description: `${result.report.summary.warnings} warnings detected across all stages`,
          suggestion: 'Review individual stage outputs for completeness',
          metrics: { warnings: result.report.summary.warnings },
        });
      }

      // Add all findings
      for (const finding of findings) {
        addFinding(finding);
      }

      return {
        score: result.report.summary.score,
        findingsCount: findings.length,
        reportPath: result.reportPaths?.latestMarkdown,
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Self-Audit Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates execution validation questions for SelfAuditSocratic.
 *
 * Usage:
 *   const { getExecutionValidationAuditQuestions } = require('./execution-validator-integration');
 *   const questions = getExecutionValidationAuditQuestions(validationResult);
 */
function getExecutionValidationAuditQuestions(validationResult) {
  if (!validationResult) {
    return [{
      question: 'Has execution been validated?',
      answer: 'unknown',
      context: 'No execution validation data available',
    }];
  }

  const { report } = validationResult;
  const questions = [];

  // Question 1: Overall execution quality
  questions.push({
    id: 'execution_overall_quality',
    question: 'Does the execution meet quality standards?',
    context: `Execution score: ${report.summary.score}/100. ` +
             `Status: ${report.summary.status}. ` +
             `Completed ${report.summary.completedStages}/${report.summary.totalStages} stages.`,
    answer: report.summary.score >= 80 ? 'passed' :
            report.summary.score >= 60 ? 'passed_with_warnings' : 'failed',
    options: [
      { value: 'passed', label: '✅ Passed all quality checks' },
      { value: 'passed_with_warnings', label: '⚠️ Passed with minor issues' },
      { value: 'failed', label: '❌ Failed quality checks' },
    ],
  });

  // Question 2: Output completeness
  questions.push({
    id: 'execution_output_completeness',
    question: 'Are all expected outputs present and complete?',
    context: report.integrityChecks
      .find(c => c.name === 'content_completeness')
      ? `Content completeness: ${report.integrityChecks.find(c => c.name === 'content_completeness').score}%`
      : 'Content completeness check not available',
    answer: report.integrityChecks.find(c => c.name === 'content_completeness')?.passed ? 'yes' : 'no',
    options: [
      { value: 'yes', label: '✅ All outputs complete' },
      { value: 'partial', label: '⚠️ Some outputs incomplete' },
      { value: 'no', label: '❌ Significant outputs missing' },
    ],
  });

  // Question 3: Stage flow continuity
  questions.push({
    id: 'execution_flow_continuity',
    question: 'Was the execution flow continuous without gaps?',
    context: report.flowValidation
      ? `Flow status: ${report.flowValidation.status}. ` +
        `Gaps: ${report.flowValidation.breaks?.length || 0}`
      : 'Flow validation not available',
    answer: report.flowValidation?.status === 'passed' ? 'continuous' : 'broken',
    options: [
      { value: 'continuous', label: '✅ Continuous execution flow' },
      { value: 'minor_gaps', label: '⚠️ Minor discontinuities' },
      { value: 'broken', label: '❌ Significant flow breaks' },
    ],
  });

  return questions;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: Event Journal Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Records execution validation events to EventJournal.
 *
 * Usage:
 *   const { recordValidationEvent } = require('./execution-validator-integration');
 *   recordValidationEvent(eventJournal, validationResult);
 */
function recordValidationEvent(eventJournal, validationResult) {
  if (!eventJournal || !validationResult) return;

  const { report } = validationResult;

  // Record main validation event
  eventJournal.record({
    type: 'execution_validation_complete',
    severity: report.summary.status === 'passed' ? 'info' :
              report.summary.status === 'passed_with_warnings' ? 'warning' : 'error',
    data: {
      score: report.summary.score,
      status: report.summary.status,
      completedStages: report.summary.completedStages,
      failedStages: report.summary.failedStages,
      warnings: report.summary.warnings,
      elapsedMs: validationResult.elapsedMs,
    },
  });

  // Record individual stage events
  for (const [stage, validation] of Object.entries(report.stageValidations)) {
    if (validation.status !== 'passed') {
      eventJournal.record({
        type: 'execution_validation_stage_issue',
        severity: validation.status === 'failed' ? 'error' : 'warning',
        data: {
          stage,
          status: validation.status,
          score: validation.score,
          errors: validation.errors,
          warnings: validation.warnings,
        },
      });
    }
  }

  // Record flow events
  if (report.flowValidation?.breaks?.length > 0) {
    eventJournal.record({
      type: 'execution_validation_flow_break',
      severity: 'warning',
      data: {
        breaks: report.flowValidation.breaks,
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: Configuration Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates complete integration configuration.
 */
function createIntegrationConfig(options = {}) {
  return {
    orchestrator: {
      enabled: options.orchestrator !== false,
      validateOnComplete: true,
      injectFindingsToExperience: true,
      options: {
        strictMode: options.strictMode || false,
        verbose: options.verbose || false,
      },
    },
    qualityGate: {
      enabled: options.qualityGate !== false,
      gates: createExecutionValidationGates(options.qualityGateOptions || {}),
    },
    deepAudit: {
      enabled: options.deepAudit !== false,
      dimension: createExecutionValidationDimension(),
    },
    selfAudit: {
      enabled: options.selfAudit !== false,
      questions: getExecutionValidationAuditQuestions,
    },
    eventJournal: {
      enabled: options.eventJournal !== false,
      record: recordValidationEvent,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Mixins
  withExecutionValidation,

  // QualityGate
  createExecutionValidationGates,

  // DeepAudit
  createExecutionValidationDimension,

  // SelfAudit
  getExecutionValidationAuditQuestions,

  // EventJournal
  recordValidationEvent,

  // Configuration
  createIntegrationConfig,
};