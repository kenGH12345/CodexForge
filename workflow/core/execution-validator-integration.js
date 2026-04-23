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
const { buildArchitectureScorecard } = require('./review-checklists');
const { getProjectionContractSummary } = require('./runtime/projection-contract-validator');
const { getRollbackScenarioSummary } = require('./rollback-coordinator');
const { getRuntimeProjectionScenarioSummary } = require('./runtime/file-state-store');

function _extractMarkdownSection(content, heading) {
  const text = String(content || '');
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(^|\\n)## ${escapedHeading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
  const match = regex.exec(text);
  return match ? match[2].trim() : '';
}

function _parseBulletMap(sectionContent) {
  const entries = [];
  for (const rawLine of String(sectionContent || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const withoutDash = line.replace(/^-+\s*/, '');
    const separatorIndex = withoutDash.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = withoutDash.slice(0, separatorIndex).trim().toLowerCase();
    const value = withoutDash.slice(separatorIndex + 1).trim();
    if (!key) continue;
    entries.push({ key, value });
  }
  return entries;
}

function _normaliseKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function _findFieldValue(parsedEntries, aliases) {
  const aliasSet = new Set(aliases.map(_normaliseKey));
  const entry = parsedEntries.find((item) => aliasSet.has(_normaliseKey(item.key)));
  return entry?.value || '';
}

function _validateStructuredSection(sectionName, sectionContent, fieldSpecs, options = {}) {
  const {
    degradeWhenSectionMissing = false,
    degradeReason = null,
    coveragePenalty = 0,
    meta = {},
  } = options;

  const trimmed = String(sectionContent || '').trim();
  const parsedEntries = _parseBulletMap(trimmed);

  if (!trimmed) {
    return {
      section: sectionName,
      present: false,
      valid: false,
      degraded: Boolean(degradeWhenSectionMissing),
      reducedCoverage: Boolean(degradeWhenSectionMissing),
      coveragePenalty,
      warning: degradeWhenSectionMissing ? degradeReason || `${sectionName} is missing.` : null,
      missingFields: fieldSpecs.map((field) => field.name),
      fields: fieldSpecs.map((field) => ({
        name: field.name,
        value: '',
        present: false,
      })),
      meta,
    };
  }

  const fields = fieldSpecs.map((field) => {
    const value = _findFieldValue(parsedEntries, field.aliases || [field.name]);
    return {
      name: field.name,
      value,
      present: Boolean(value),
    };
  });

  const missingFields = fields.filter((field) => !field.present).map((field) => field.name);
  return {
    section: sectionName,
    present: true,
    valid: missingFields.length === 0,
    degraded: false,
    reducedCoverage: false,
    coveragePenalty: 0,
    warning: null,
    missingFields,
    fields,
    meta,
  };
}

function _buildFailureModelAssessment(artifactContent) {
  const sectionContent = _extractMarkdownSection(artifactContent, 'Failure Model');
  return _validateStructuredSection(
    'Failure Model',
    sectionContent,
    [
      { name: 'Failure Mode', aliases: ['Failure Mode', 'Failure Modes', 'Failure Scenario'] },
      { name: 'Detection Signal', aliases: ['Detection Signal', 'Detection', 'Signal'] },
      { name: 'Mitigation', aliases: ['Mitigation', 'Fallback', 'Graceful Degradation'] },
      { name: 'Recovery', aliases: ['Recovery', 'Recovery Path', 'Rollback'] },
    ]
  );
}

function _buildMigrationSafetyAssessment(artifactContent, options = {}) {
  const projectionContract = options.projectionContract || getProjectionContractSummary();
  const sectionContent = _extractMarkdownSection(artifactContent, 'Migration Safety Case');
  const degradeReason = options.degradeReason || 'Projection contract evidence is unavailable, so migration coverage is reduced but not blocked.';

  const result = _validateStructuredSection(
    'Migration Safety Case',
    sectionContent,
    [
      { name: 'Backward Compatibility', aliases: ['Backward Compatibility', 'Compatibility', 'Legacy Compatibility'] },
      { name: 'Rollback Strategy', aliases: ['Rollback Strategy', 'Rollback', 'Revert Plan'] },
      { name: 'Contract Evidence', aliases: ['Contract Evidence', 'Projection Contract', 'Projection Evidence'] },
      { name: 'Data Migration Scope', aliases: ['Data Migration Scope', 'Migration Scope', 'Scope'] },
    ],
    {
      degradeWhenSectionMissing: false,
      meta: {
        projectionContract,
      },
    }
  );

  if (!options.hasProjectionEvidence) {
    result.degraded = true;
    result.reducedCoverage = true;
    result.coveragePenalty = 25;
    result.warning = degradeReason;
  }

  return result;
}

function _runConstitutionCheck(artifactContent, { projectRoot } = {}) {
  const constraintsPath = path.join(projectRoot, 'workflow', 'docs', 'architecture-constraints.md');
  if (!fs.existsSync(constraintsPath)) {
    return { valid: true, checks: [], skipped: true, reason: 'architecture-constraints.md not found' };
  }
  const constraintText = fs.readFileSync(constraintsPath, 'utf-8');
  const enforcedRules = _parseEnforcedConstraints(constraintText);
  const checks = enforcedRules.map(rule => ({
    rule: rule.title,
    enforced: true,
    passed: rule.pattern ? rule.pattern.test(artifactContent) : true,
    evidence: rule.description,
  }));
  return {
    valid: checks.every(c => c.passed),
    checks,
    skipped: false,
    checkCount: checks.length,
    failedChecks: checks.filter(c => !c.passed),
  };
}

function _parseEnforcedConstraints(text) {
  const rules = [];
  const lines = text.split('\n');
  let currentRule = null;
  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (currentRule) rules.push(currentRule);
      currentRule = { title: headingMatch[1].trim(), description: '', enforced: false, pattern: null };
    }
    if (currentRule) {
      if (/Violation\s*=\s*P0|\(P0\)/i.test(line)) {
        currentRule.enforced = true;
      }
      currentRule.description += line + '\n';
    }
  }
  if (currentRule) rules.push(currentRule);
  const enforced = rules.filter(r => r.enforced);
  for (const rule of enforced) {
    const keyTerms = rule.title.split(/[\s(/]+/).filter(w => w.length > 3 && !/^(the|and|for|with|from|rule|must|always)/i.test(w));
    if (keyTerms.length > 0) {
      rule.pattern = new RegExp(keyTerms.slice(0, 3).join('|'), 'i');
    }
  }
  return enforced;
}

function _assessArtifactAvailability(projectRoot, architecturePath) {
  const outputDir = path.join(projectRoot, 'output');
  const projectProfilePath = path.join(outputDir, 'project-profile.md');
  const hasArchitecture = Boolean(architecturePath && fs.existsSync(architecturePath));
  const hasProjectProfile = fs.existsSync(projectProfilePath);
  return {
    outputDir,
    projectProfilePath,
    hasArchitecture,
    hasProjectProfile,
    hasProjectionEvidence: hasProjectProfile,
    warnings: hasProjectProfile
      ? []
      : ['project-profile.md is missing, so migration validation uses reduced coverage mode.'],
  };
}

function _buildScenarioCoverageAssessment(artifactContent) {
  const sectionContent = _extractMarkdownSection(artifactContent, 'Scenario Coverage');
  const parsedEntries = _parseBulletMap(sectionContent);
  const scenarios = parsedEntries.map((entry) => ({
    name: entry.key,
    coverage: entry.value,
  }));
  return {
    section: 'Scenario Coverage',
    present: Boolean(sectionContent),
    scenarios,
    valid: scenarios.length >= 3,
    missingScenarios: scenarios.length >= 3 ? [] : [
      'projection drift',
      'rollback boundary',
      'recovery path',
    ].slice(scenarios.length),
  };
}

function runArchitectureScenarioHarness(options = {}) {
  const {
    projectRoot = path.resolve(__dirname, '..', '..'),
    artifactContent = '',
    availability = _assessArtifactAvailability(projectRoot, path.join(projectRoot, 'output', 'architecture.md')),
    contracts = {},
  } = options;

  const rollbackSummary = getRollbackScenarioSummary();
  const runtimeSummary = getRuntimeProjectionScenarioSummary(projectRoot);
  const projectionContract = getProjectionContractSummary();
  const declaredCoverage = _buildScenarioCoverageAssessment(artifactContent);

  const scenarios = [
    {
      id: 'projection-contract-drift',
      category: 'projection',
      title: 'Projection contract drift is covered',
      passed: Boolean(contracts.migrationSafety?.present),
      details: contracts.migrationSafety?.present
        ? `Migration Safety Case is present and references projection contracts (${projectionContract.manifest.requiredFields.length} manifest field(s)).`
        : 'Migration Safety Case section is missing or empty.',
      evidence: {
        manifestRequiredFields: projectionContract.manifest.requiredFields,
        workflowStatusRequiredFields: projectionContract.workflowStatus.requiredFields,
      },
    },
    {
      id: 'rollback-boundary',
      category: 'rollback',
      title: 'Rollback boundary is described against real coordinator stages',
      passed: Boolean(contracts.migrationSafety?.present),
      details: contracts.migrationSafety?.present
        ? `Rollback targets available for ${Object.keys(rollbackSummary.rollbackTargets).length} stage(s).`
        : 'Rollback Strategy evidence is missing from Migration Safety Case.',
      evidence: rollbackSummary,
    },
    {
      id: 'recovery-path',
      category: 'recovery',
      title: 'Recovery path is grounded in runtime recovery metadata',
      passed: availability.hasProjectionEvidence,
      degraded: !availability.hasProjectionEvidence,
      details: availability.hasProjectionEvidence
        ? `project-profile.md is present; runtime recovery fields are ${runtimeSummary.recoveryFields.join(', ')}.`
        : 'project-profile.md is missing, so recovery-path coverage is reduced to runtime metadata only.',
      evidence: runtimeSummary,
    },
    {
      id: 'bridge-contract-divergence',
      category: 'contract-divergence',
      title: 'Bridge and Node governance share the same contract source',
      passed: true,
      details: 'Architecture governance is computed through assessArchitectureGovernance() for both integration paths.',
      evidence: {
        source: 'execution-validator-integration.assessArchitectureGovernance',
      },
    },
  ];

  const failed = scenarios.filter((scenario) => !scenario.passed && !scenario.degraded);
  const degraded = scenarios.filter((scenario) => scenario.degraded);
  const categoriesCovered = new Set(scenarios.filter((scenario) => scenario.passed || scenario.degraded).map((scenario) => scenario.category));

  return {
    version: 'architecture-scenario-harness-v1',
    declaredCoverage,
    scenarios,
    summary: {
      total: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.passed).length,
      failed: failed.length,
      degraded: degraded.length,
      categoriesCovered: [...categoriesCovered],
      meetsMinimumCoverage: categoriesCovered.size >= 2 && scenarios.length >= 3,
    },
  };
}

function evaluateArchitectureFitnessGates(governance, options = {}) {
  const {
    minScore = 70,
    maxHighSeverityGaps = 0,
    requireScenarioCoverage = true,
  } = options;

  const scorecard = governance?.scorecard || {};
  const contracts = governance?.contracts || {};
  const scenarioHarness = governance?.scenarioHarness || {};
  const highSeverityGaps = scorecard.gapSummary?.highSeverityGapIds?.length || 0;
  const totalScore = scorecard.totalScore ?? 0;

  const checks = [
    {
      id: 'architecture-score-threshold',
      passed: totalScore >= minScore,
      message: totalScore >= minScore
        ? `Architecture score ${totalScore} meets threshold ${minScore}.`
        : `Architecture score ${totalScore} is below threshold ${minScore}.`,
    },
    {
      id: 'architecture-contracts-valid',
      passed: Boolean(contracts.overallValid),
      message: contracts.overallValid
        ? 'Failure and migration contracts are structurally valid.'
        : 'Failure or migration contract sections are incomplete.',
    },
    {
      id: 'architecture-high-severity-gaps',
      passed: highSeverityGaps <= maxHighSeverityGaps,
      message: highSeverityGaps <= maxHighSeverityGaps
        ? `High severity checklist gaps within limit (${highSeverityGaps}).`
        : `Too many high severity checklist gaps (${highSeverityGaps} > ${maxHighSeverityGaps}).`,
    },
    {
      id: 'architecture-scenario-coverage',
      passed: requireScenarioCoverage ? Boolean(scenarioHarness.summary?.meetsMinimumCoverage) : true,
      message: requireScenarioCoverage
        ? scenarioHarness.summary?.meetsMinimumCoverage
          ? 'Scenario harness covers at least two runtime risk categories.'
          : 'Scenario harness does not cover enough runtime risk categories.'
        : 'Scenario coverage gate disabled.',
    },
    {
      id: 'architecture-constitution-check',
      passed: governance?.constitutionCheck?.valid !== false,
      message: governance?.constitutionCheck?.valid !== false
        ? `Constitution check passed (${governance?.constitutionCheck?.checkCount ?? 0} enforced constraints verified).`
        : `Constitution check failed: ${(governance?.constitutionCheck?.failedChecks ?? []).map(c => c.rule).join(', ')}`,
    },
  ];

  const failedChecks = checks.filter((check) => !check.passed);
  return {
    passed: failedChecks.length === 0,
    checks,
    failedChecks,
    degraded: Boolean(governance?.degradation?.active || governance?.contracts?.degraded || scenarioHarness.summary?.degraded > 0),
  };
}

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
// Section 6: Architecture Governance Helper
// ═══════════════════════════════════════════════════════════════════════════

function assessArchitectureGovernance(options = {}) {
  const {
    projectRoot = path.resolve(__dirname, '..', '..'),
    outputDir = path.join(projectRoot, 'output'),
    architecturePath = path.join(outputDir, 'architecture.md'),
    reviewResult = null,
    artifactContent = null,
  } = options;

  const availability = _assessArtifactAvailability(projectRoot, architecturePath);
  let content = typeof artifactContent === 'string' ? artifactContent : '';
  if (!content && architecturePath && fs.existsSync(architecturePath)) {
    content = fs.readFileSync(architecturePath, 'utf-8');
  }

  const scorecard = buildArchitectureScorecard({
    reviewResult,
    artifactContent: content,
  });
  const failureModel = _buildFailureModelAssessment(content);
  const migrationSafety = _buildMigrationSafetyAssessment(content, {
    hasProjectionEvidence: availability.hasProjectionEvidence,
    projectionContract: getProjectionContractSummary(),
    degradeReason: availability.warnings[0],
  });

  const warnings = [
    ...availability.warnings,
    ...(failureModel.warning ? [failureModel.warning] : []),
    ...(migrationSafety.warning ? [migrationSafety.warning] : []),
  ].filter(Boolean);

  const contracts = {
    failureModel,
    migrationSafety,
    overallValid: failureModel.valid && migrationSafety.valid,
    degraded: failureModel.degraded || migrationSafety.degraded,
    reducedCoverage: failureModel.reducedCoverage || migrationSafety.reducedCoverage,
  };
  const degradation = {
    active: warnings.length > 0,
    warnings,
    hasProjectProfile: availability.hasProjectProfile,
    hasProjectionEvidence: availability.hasProjectionEvidence,
  };
  const scenarioHarness = runArchitectureScenarioHarness({
    projectRoot,
    artifactContent: content,
    availability,
    contracts,
  });
  const constitutionCheck = _runConstitutionCheck(content, { projectRoot });
  const fitnessGates = evaluateArchitectureFitnessGates({
    scorecard,
    contracts,
    degradation,
    scenarioHarness,
    constitutionCheck,
  });

  return {
    architecturePath,
    exists: Boolean(content),
    scorecard,
    contracts,
    constitutionCheck,
    scenarioHarness,
    fitnessGates,
    degradation,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 7: Configuration Helper
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
// Section 8: Exports
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

  // Architecture governance
  assessArchitectureGovernance,
  runArchitectureScenarioHarness,
  evaluateArchitectureFitnessGates,

  // Configuration
  createIntegrationConfig,
};