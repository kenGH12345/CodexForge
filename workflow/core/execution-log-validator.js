/**
 * Execution Log Validator — 执行日志校验与评估系统
 *
 * Purpose: 将 /wf 产生的执行日志与标准执行流程进行对比，
 *          检查输出内容完整性，评估执行是否正常。
 *
 * Core Functions:
 *   1. Define standard execution flow templates (expected outputs per stage)
 *   2. Parse and analyze actual execution logs
 *   3. Compare actual vs expected outputs
 *   4. Generate execution health assessment report
 *
 * Integration Points:
 *   - Orchestrator: Auto-runs after workflow completion
 *   - QualityGate: Contributes metrics for quality evaluation
 *   - DeepAudit: Provides execution pattern analysis
 *   - ExperienceStore: Records execution anomalies for learning
 *
 * ADR-37 Compliance: Uses fs/path modules only (IDE-native), no external deps
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WorkflowState } = require('./types');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Standard Execution Flow Templates (delegated to execution-log-templates.js, ADR-33 Phase 4)
// ═══════════════════════════════════════════════════════════════════════════

const { STANDARD_EXECUTION_FLOW, STAGE_SEQUENCE } = require('./execution-log-templates');

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Execution Log Parser
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parses execution logs from various sources.
 * Supports: console output capture, log files, orchestrator state
 */
class ExecutionLogParser {
  constructor(outputDir) {
    this.outputDir = outputDir;
  }

  /**
   * Parses complete execution state from output directory.
   * @returns {ExecutionState}
   */
  parseExecutionState() {
    const state = {
      timestamp: new Date().toISOString(),
      stages: {},
      artifacts: {},
      flow: {
        started: null,
        completed: null,
        currentStage: null,
        stageSequence: [],
      },
      errors: [],
      warnings: [],
    };

    // Scan for stage artifacts
    for (const stage of STAGE_SEQUENCE) {
      const stageDef = STANDARD_EXECUTION_FLOW[stage];
      if (!stageDef) continue;

      const stageState = this._parseStageState(stage, stageDef);
      state.stages[stage] = stageState;
      state.flow.stageSequence.push({
        stage,
        status: stageState.status,
        completedAt: stageState.completedAt,
      });

      if (stageState.status === 'completed') {
        state.flow.completed = stage;
      }
      if (!state.flow.started && stageState.status !== 'pending') {
        state.flow.started = stage;
      }
    }

    state.flow.currentStage = this._determineCurrentStage(state);

    return state;
  }

  /**
   * Parses individual stage state.
   */
  _parseStageState(stage, stageDef) {
    const stageState = {
      stage,
      status: 'pending',
      artifacts: {},
      contentAnalysis: null,
      metrics: {},
      completedAt: null,
    };

    // Check required artifacts
    for (const artifact of stageDef.requiredArtifacts) {
      const artifactPath = path.join(this.outputDir, artifact);
      const exists = fs.existsSync(artifactPath);
      stageState.artifacts[artifact] = {
        exists,
        path: exists ? artifactPath : null,
      };

      if (exists) {
        stageState.status = 'completed';
        stageState.completedAt = fs.statSync(artifactPath).mtime.toISOString();

        // Analyze content
        const content = fs.readFileSync(artifactPath, 'utf-8');
        stageState.contentAnalysis = this._analyzeContent(content, stageDef);
        stageState.metrics = this._extractMetrics(content, artifact);
      }
    }

    // Check optional artifacts
    for (const artifact of stageDef.optionalArtifacts) {
      const artifactPath = path.join(this.outputDir, artifact);
      const exists = fs.existsSync(artifactPath);
      stageState.artifacts[artifact] = {
        exists,
        path: exists ? artifactPath : null,
      };
    }

    return stageState;
  }

  /**
   * Analyzes artifact content against expected structure.
   */
  _analyzeContent(content, stageDef) {
    const analysis = {
      lineCount: content.split('\n').length,
      byteSize: Buffer.byteLength(content, 'utf-8'),
      sections: [],
      hasJsonMetadata: false,
      missingRequiredSections: [],
      sectionCount: 0,
    };

    // Check for JSON metadata block
    const jsonMatch = content.match(/^```json\s*\n([\s\S]*?)\n```/m);
    if (jsonMatch) {
      analysis.hasJsonMetadata = true;
      try {
        analysis.jsonMetadata = JSON.parse(jsonMatch[1]);
      } catch {
        analysis.jsonParseError = true;
      }
    }

    // Extract sections (headings)
    const headings = content.match(/^#{1,3}\s+.+$/gm) || [];
    analysis.sectionCount = headings.length;
    analysis.sections = headings.map(h => ({
      level: h.match(/^(#+)/)[1].length,
      title: h.replace(/^#+\s*/, '').trim(),
    }));

    // Check required sections
    for (const required of stageDef.requiredSections) {
      const found = analysis.sections.some(s => required.pattern.test(s.title));
      if (!found) {
        analysis.missingRequiredSections.push(required.name);
      }
    }

    return analysis;
  }

  /**
   * Extracts metrics from content.
   */
  _extractMetrics(content, artifactName) {
    const metrics = {};

    if (artifactName.endsWith('.diff')) {
      // Diff metrics
      const files = new Set();
      const diffHeaders = content.match(/^(?:diff --git|---|\+\+\+)\s+[ab]?\/?(.+)$/gm) || [];
      for (const h of diffHeaders) {
        const m = h.match(/(?:diff --git a\/|--- a\/|\+\+\+ b\/)(.+)/);
        if (m && m[1] !== '/dev/null') files.add(m[1]);
      }
      metrics.filesChanged = files.size;

      // Count additions/deletions
      const lines = content.split('\n');
      metrics.additions = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
      metrics.deletions = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
    } else {
      // Markdown metrics - try to extract from JSON metadata
      const jsonMatch = content.match(/^```json\s*\n([\s\S]*?)\n```/m);
      if (jsonMatch) {
        try {
          const meta = JSON.parse(jsonMatch[1]);
          Object.assign(metrics, meta);
        } catch { /* ignore */ }
      }

      // Additional pattern extraction
      const taskMatch = content.match(/(?:任务|Task|总数|Total)[：:]\s*(\d+)/i);
      if (taskMatch) metrics.taskCount = parseInt(taskMatch[1], 10);

      const phaseMatch = content.match(/(?:阶段|Phase)[：:]\s*(\d+)/i);
      if (phaseMatch) metrics.phaseCount = parseInt(phaseMatch[1], 10);
    }

    return metrics;
  }

  /**
   * Determines current active stage based on state.
   */
  _determineCurrentStage(state) {
    for (const stage of STAGE_SEQUENCE) {
      const stageState = state.stages[stage];
      if (stageState.status !== 'completed') {
        return stage;
      }
    }
    return WorkflowState.TEST;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Execution Validator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates execution state against standard flow.
 * Generates detailed assessment report.
 */
class ExecutionValidator {
  constructor(options = {}) {
    this.strictMode = options.strictMode || false;
    this.checkOptionalArtifacts = options.checkOptionalArtifacts !== false;
  }

  /**
   * Validates complete execution flow.
   * @param {ExecutionState} state - Parsed execution state
   * @returns {ValidationReport}
   */
  validate(state) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        status: 'pending',
        score: 0,
        totalStages: STAGE_SEQUENCE.length,
        completedStages: 0,
        failedStages: 0,
        warnings: 0,
      },
      stageValidations: {},
      flowValidation: null,
      integrityChecks: [],
      recommendations: [],
    };

    // Validate each stage
    let totalScore = 0;
    for (const stage of STAGE_SEQUENCE) {
      const stageState = state.stages[stage];
      const stageDef = STANDARD_EXECUTION_FLOW[stage];

      const validation = this._validateStage(stage, stageState, stageDef);
      report.stageValidations[stage] = validation;

      if (validation.status === 'passed') {
        report.summary.completedStages++;
      } else if (validation.status === 'failed') {
        report.summary.failedStages++;
      }

      report.summary.warnings += validation.warnings.length;
      totalScore += validation.score;
    }

    // Validate flow continuity
    report.flowValidation = this._validateFlow(state);

    // Run integrity checks
    report.integrityChecks = this._runIntegrityChecks(state);

    // Generate recommendations
    report.recommendations = this._generateRecommendations(report);

    // Calculate overall score (average of stage scores)
    report.summary.score = Math.round(totalScore / STAGE_SEQUENCE.length);

    // Determine overall status
    if (report.summary.failedStages > 0) {
      report.summary.status = 'failed';
    } else if (report.summary.warnings > 0) {
      report.summary.status = 'passed_with_warnings';
    } else {
      report.summary.status = 'passed';
    }

    return report;
  }

  /**
   * Validates individual stage.
   */
  _validateStage(stage, stageState, stageDef) {
    const validation = {
      stage,
      status: 'pending',
      score: 0,
      maxScore: 100,
      checks: [],
      warnings: [],
      errors: [],
    };

    if (!stageState) {
      validation.errors.push('Stage state not found');
      return validation;
    }

    // Check 1: Artifact existence
    for (const [artifact, info] of Object.entries(stageState.artifacts)) {
      if (stageDef.requiredArtifacts.includes(artifact)) {
        if (info.exists) {
          validation.checks.push({
            name: 'required_artifact_exists',
            artifact,
            passed: true,
            points: 20,
          });
          validation.score += 20;
        } else {
          validation.checks.push({
            name: 'required_artifact_exists',
            artifact,
            passed: false,
            points: 0,
            error: `Required artifact missing: ${artifact}`,
          });
          validation.errors.push(`Missing required artifact: ${artifact}`);
        }
      } else if (this.checkOptionalArtifacts) {
        validation.checks.push({
          name: 'optional_artifact_exists',
          artifact,
          passed: info.exists,
          points: info.exists ? 5 : 0,
        });
        if (info.exists) validation.score += 5;
      }
    }

    // Check 2: Content analysis (if artifact exists)
    if (stageState.contentAnalysis) {
      const analysis = stageState.contentAnalysis;

      // Line count validation
      const lineCount = analysis.lineCount;
      if (lineCount >= stageDef.expectedMetrics.minLines &&
          lineCount <= stageDef.expectedMetrics.maxLines) {
        validation.checks.push({
          name: 'content_length',
          passed: true,
          points: 15,
          details: { lines: lineCount },
        });
        validation.score += 15;
      } else {
        validation.checks.push({
          name: 'content_length',
          passed: false,
          points: 0,
          details: { lines: lineCount, expected: stageDef.expectedMetrics },
        });
        validation.warnings.push(
          `Content length (${lineCount} lines) outside expected range ` +
          `(${stageDef.expectedMetrics.minLines}-${stageDef.expectedMetrics.maxLines})`
        );
      }

      // Section count validation
      if (analysis.sectionCount >= stageDef.minContentSections) {
        validation.checks.push({
          name: 'section_count',
          passed: true,
          points: 15,
          details: { sections: analysis.sectionCount },
        });
        validation.score += 15;
      } else {
        validation.checks.push({
          name: 'section_count',
          passed: false,
          points: 0,
          details: { sections: analysis.sectionCount, expected: stageDef.minContentSections },
        });
        validation.warnings.push(
          `Too few sections (${analysis.sectionCount}, expected >= ${stageDef.minContentSections})`
        );
      }

      // Required sections validation
      if (analysis.missingRequiredSections.length === 0) {
        validation.checks.push({
          name: 'required_sections',
          passed: true,
          points: 25,
        });
        validation.score += 25;
      } else {
        validation.checks.push({
          name: 'required_sections',
          passed: false,
          points: 0,
          details: { missing: analysis.missingRequiredSections },
        });
        validation.warnings.push(
          `Missing required sections: ${analysis.missingRequiredSections.join(', ')}`
        );
      }

      // JSON metadata validation
      if (stageDef.expectedMetrics.hasJsonMetadata) {
        if (analysis.hasJsonMetadata && !analysis.jsonParseError) {
          validation.checks.push({
            name: 'json_metadata',
            passed: true,
            points: 10,
          });
          validation.score += 10;
        } else {
          validation.checks.push({
            name: 'json_metadata',
            passed: false,
            points: 0,
          });
          validation.warnings.push('JSON metadata missing or malformed');
        }
      }
    }

    // Determine status
    if (validation.errors.length > 0) {
      validation.status = 'failed';
    } else if (validation.warnings.length > 0) {
      validation.status = 'passed_with_warnings';
    } else {
      validation.status = 'passed';
    }

    return validation;
  }

  /**
   * Validates flow continuity between stages.
   */
  _validateFlow(state) {
    const flowValidation = {
      status: 'passed',
      sequence: [],
      breaks: [],
      warnings: [],
    };

    const completedStages = STAGE_SEQUENCE.filter(
      s => state.stages[s]?.status === 'completed'
    );

    // Check for sequence gaps
    for (let i = 0; i < completedStages.length - 1; i++) {
      const current = STAGE_SEQUENCE.indexOf(completedStages[i]);
      const next = STAGE_SEQUENCE.indexOf(completedStages[i + 1]);

      if (next !== current + 1) {
        flowValidation.breaks.push({
          from: completedStages[i],
          to: completedStages[i + 1],
          gap: next - current - 1,
        });
        flowValidation.status = 'broken';
      }

      flowValidation.sequence.push({
        from: completedStages[i],
        to: completedStages[i + 1],
        continuous: next === current + 1,
      });
    }

    if (flowValidation.breaks.length > 0) {
      flowValidation.warnings.push(
        `Flow discontinuity detected: ${flowValidation.breaks.length} gap(s)`
      );
    }

    return flowValidation;
  }

  /**
   * Runs additional integrity checks.
   */
  _runIntegrityChecks(state) {
    const checks = [];

    // Check 1: All required artifacts present
    const allArtifactsCheck = {
      name: 'all_required_artifacts_present',
      passed: true,
      details: {},
    };

    for (const stage of STAGE_SEQUENCE) {
      const stageState = state.stages[stage];
      const stageDef = STANDARD_EXECUTION_FLOW[stage];

      for (const artifact of stageDef.requiredArtifacts) {
        if (!stageState?.artifacts[artifact]?.exists) {
          allArtifactsCheck.passed = false;
          allArtifactsCheck.details[stage] = allArtifactsCheck.details[stage] || [];
          allArtifactsCheck.details[stage].push(artifact);
        }
      }
    }

    checks.push(allArtifactsCheck);

    // Check 2: Content completeness
    const contentCompleteness = {
      name: 'content_completeness',
      passed: true,
      score: 0,
      maxScore: 100,
    };

    let totalSections = 0;
    let foundSections = 0;

    for (const stage of STAGE_SEQUENCE) {
      const stageState = state.stages[stage];
      const stageDef = STANDARD_EXECUTION_FLOW[stage];

      if (stageState?.contentAnalysis) {
        totalSections += stageDef.requiredSections.length;
        foundSections += stageDef.requiredSections.length -
                        stageState.contentAnalysis.missingRequiredSections.length;
      }
    }

    contentCompleteness.score = totalSections > 0
      ? Math.round((foundSections / totalSections) * 100)
      : 0;
    contentCompleteness.passed = contentCompleteness.score >= 80;
    contentCompleteness.details = { foundSections, totalSections };

    checks.push(contentCompleteness);

    // Check 3: Metadata quality
    const metadataQuality = {
      name: 'metadata_quality',
      passed: true,
      score: 0,
      maxScore: 100,
    };

    let validMetadata = 0;
    let totalMetadata = 0;

    for (const stage of STAGE_SEQUENCE) {
      const stageState = state.stages[stage];
      const stageDef = STANDARD_EXECUTION_FLOW[stage];

      if (stageDef.expectedMetrics.hasJsonMetadata && stageState?.contentAnalysis) {
        totalMetadata++;
        if (stageState.contentAnalysis.hasJsonMetadata &&
            !stageState.contentAnalysis.jsonParseError) {
          validMetadata++;
        }
      }
    }

    metadataQuality.score = totalMetadata > 0
      ? Math.round((validMetadata / totalMetadata) * 100)
      : 0;
    metadataQuality.passed = metadataQuality.score >= 80;
    metadataQuality.details = { validMetadata, totalMetadata };

    checks.push(metadataQuality);

    return checks;
  }

  /**
   * Generates recommendations based on validation results.
   */
  _generateRecommendations(report) {
    const recommendations = [];

    // Recommendations for failed stages
    for (const [stage, validation] of Object.entries(report.stageValidations)) {
      if (validation.status === 'failed') {
        recommendations.push({
          priority: 'high',
          stage,
          type: 'stage_failure',
          message: `Stage ${stage} validation failed`,
          action: `Re-run ${stage} stage to generate missing artifacts`,
        });
      }
    }

    // Recommendations for flow breaks
    if (report.flowValidation?.breaks?.length > 0) {
      recommendations.push({
        priority: 'high',
        type: 'flow_break',
        message: 'Execution flow has discontinuities',
        action: 'Review skipped stages; ensure sequential execution',
        details: report.flowValidation.breaks,
      });
    }

    // Recommendations for low scores
    if (report.summary.score < 70) {
      recommendations.push({
        priority: 'medium',
        type: 'low_quality',
        message: `Overall execution score (${report.summary.score}) below threshold`,
        action: 'Review output completeness and structure',
      });
    }

    // Recommendations for missing sections
    for (const [stage, validation] of Object.entries(report.stageValidations)) {
      const missingSections = validation.checks
        .find(c => c.name === 'required_sections')?.details?.missing;

      if (missingSections && missingSections.length > 0) {
        recommendations.push({
          priority: 'low',
          stage,
          type: 'missing_sections',
          message: `Stage ${stage} missing sections: ${missingSections.join(', ')}`,
          action: 'Add required sections to output templates',
        });
      }
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recommendations;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Report Generator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates human-readable validation reports.
 */
class ExecutionReportGenerator {
  /**
   * Generates markdown report.
   */
  generateMarkdownReport(report) {
    const lines = [
      '# Execution Log Validation Report',
      '',
      `Generated: ${new Date(report.timestamp).toLocaleString()}`,
      '',
      '## Summary',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Status | ${this._statusEmoji(report.summary.status)} ${report.summary.status} |`,
      `| Overall Score | ${report.summary.score}/100 |`,
      `| Completed Stages | ${report.summary.completedStages}/${report.summary.totalStages} |`,
      `| Failed Stages | ${report.summary.failedStages} |`,
      `| Warnings | ${report.summary.warnings} |`,
      '',
      '## Stage Validations',
      '',
    ];

    // Stage details
    for (const [stage, validation] of Object.entries(report.stageValidations)) {
      lines.push(`### ${stage}`);
      lines.push('');
      lines.push(`- **Status**: ${this._statusEmoji(validation.status)} ${validation.status}`);
      lines.push(`- **Score**: ${validation.score}/${validation.maxScore}`);

      if (validation.errors.length > 0) {
        lines.push('- **Errors**:', ...validation.errors.map(e => `  - ❌ ${e}`));
      }

      if (validation.warnings.length > 0) {
        lines.push('- **Warnings**:', ...validation.warnings.map(w => `  - ⚠️ ${w}`));
      }

      // Check details
      if (validation.checks.length > 0) {
        lines.push('- **Checks**:', '');
        lines.push('  | Check | Status | Points |');
        lines.push('  |-------|--------|--------|');
        for (const check of validation.checks) {
          const status = check.passed ? '✅' : '❌';
          lines.push(`  | ${check.name} | ${status} | ${check.points} |`);
        }
      }

      lines.push('');
    }

    // Flow validation
    if (report.flowValidation) {
      lines.push('## Flow Validation', '');
      lines.push(`- **Status**: ${this._statusEmoji(report.flowValidation.status)} ${report.flowValidation.status}`);

      if (report.flowValidation.breaks.length > 0) {
        lines.push('- **Breaks**:', ...report.flowValidation.breaks.map(b =>
          `  - ${b.from} → ${b.to} (${b.gap} stage(s) skipped)`
        ));
      }
      lines.push('');
    }

    // Integrity checks
    if (report.integrityChecks.length > 0) {
      lines.push('## Integrity Checks', '');
      lines.push('| Check | Status | Score |');
      lines.push('|-------|--------|-------|');
      for (const check of report.integrityChecks) {
        const status = check.passed ? '✅' : '❌';
        const score = check.score !== undefined ? `${check.score}%` : 'N/A';
        lines.push(`| ${check.name} | ${status} | ${score} |`);
      }
      lines.push('');
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('## Recommendations', '');
      for (const rec of report.recommendations) {
        const emoji = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢';
        lines.push(`### ${emoji} [${rec.priority.toUpperCase()}] ${rec.type}`);
        lines.push(`- **Message**: ${rec.message}`);
        lines.push(`- **Action**: ${rec.action}`);
        if (rec.stage) {
          lines.push(`- **Stage**: ${rec.stage}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Generates JSON report.
   */
  generateJsonReport(report) {
    return JSON.stringify(report, null, 2);
  }

  _statusEmoji(status) {
    const emojis = {
      passed: '✅',
      passed_with_warnings: '⚠️',
      failed: '❌',
      pending: '⏳',
      broken: '💔',
    };
    return emojis[status] || '❓';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: Main Validator Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main execution log validator orchestrator.
 * Coordinates parsing, validation, and reporting.
 */
class ExecutionLogValidator {
  /**
   * @param {object} options
   * @param {string} options.outputDir - Directory containing execution artifacts
   * @param {boolean} [options.verbose=false] - Enable verbose logging
   * @param {boolean} [options.strictMode=false] - Strict validation mode
   * @param {string} [options.reportOutputDir] - Directory for validation reports
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir;
    this.verbose = options.verbose || false;
    this.strictMode = options.strictMode || false;
    this.reportOutputDir = options.reportOutputDir || options.outputDir;

    this.parser = new ExecutionLogParser(this.outputDir);
    this.validator = new ExecutionValidator({ strictMode: this.strictMode });
    this.reportGenerator = new ExecutionReportGenerator();
  }

  /**
   * Runs complete validation workflow.
   * @returns {Promise<ValidationResult>}
   */
  async validate() {
    const startTime = Date.now();

    this._log('Starting execution log validation...');

    // Step 1: Parse execution state
    this._log('Parsing execution state...');
    const state = this.parser.parseExecutionState();

    // Step 2: Validate against standards
    this._log('Validating against standard flow...');
    const report = this.validator.validate(state);

    // Step 3: Generate reports
    this._log('Generating reports...');
    const markdownReport = this.reportGenerator.generateMarkdownReport(report);
    const jsonReport = this.reportGenerator.generateJsonReport(report);

    // Step 4: Write reports
    const reportPaths = this._writeReports(markdownReport, jsonReport, report);

    const elapsed = Date.now() - startTime;
    this._log(`Validation complete in ${elapsed}ms`);

    // Step 5: Console summary
    this._printSummary(report);

    return {
      state,
      report,
      markdownReport,
      jsonReport,
      reportPaths,
      elapsedMs: elapsed,
    };
  }

  /**
   * Writes validation reports to disk.
   */
  _writeReports(markdown, json, report) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `execution-validation-${timestamp}`;

    const paths = {
      markdown: path.join(this.reportOutputDir, `${baseName}.md`),
      json: path.join(this.reportOutputDir, `${baseName}.json`),
      latestMarkdown: path.join(this.reportOutputDir, 'execution-validation-report.md'),
      latestJson: path.join(this.reportOutputDir, 'execution-validation-report.json'),
    };

    try {
      // Write timestamped versions
      fs.writeFileSync(paths.markdown, markdown, 'utf-8');
      fs.writeFileSync(paths.json, json, 'utf-8');

      // Update latest versions
      fs.writeFileSync(paths.latestMarkdown, markdown, 'utf-8');
      fs.writeFileSync(paths.latestJson, json, 'utf-8');

      this._log(`Reports written: ${paths.latestMarkdown}`);
    } catch (err) {
      this._log(`Error writing reports: ${err.message}`, 'error');
    }

    return paths;
  }

  /**
   * Prints validation summary to console.
   */
  _printSummary(report) {
    const separator = '═'.repeat(60);
    console.log(`\n${separator}`);
    console.log('       E X E C U T I O N   V A L I D A T I O N   R E S U L T');
    console.log(separator);
    console.log('');

    const statusEmoji = report.summary.status === 'passed' ? '✅' :
                       report.summary.status === 'passed_with_warnings' ? '⚠️' : '❌';

    console.log(`  Status: ${statusEmoji} ${report.summary.status.toUpperCase()}`);
    console.log(`  Score: ${report.summary.score}/100`);
    console.log(`  Stages: ${report.summary.completedStages}/${report.summary.totalStages} completed`);

    if (report.summary.failedStages > 0) {
      console.log(`  Failed: ${report.summary.failedStages} stage(s)`);
    }

    if (report.summary.warnings > 0) {
      console.log(`  Warnings: ${report.summary.warnings}`);
    }

    // Print stage summary
    console.log('');
    console.log('  Stage Breakdown:');
    for (const [stage, validation] of Object.entries(report.stageValidations)) {
      const emoji = validation.status === 'passed' ? '✅' :
                   validation.status === 'passed_with_warnings' ? '⚠️' :
                   validation.status === 'failed' ? '❌' : '⏳';
      console.log(`    ${emoji} ${stage.padEnd(10)} ${validation.score}/${validation.maxScore}`);
    }

    // Print top recommendations
    if (report.recommendations.length > 0) {
      console.log('');
      console.log('  Top Recommendations:');
      for (const rec of report.recommendations.slice(0, 3)) {
        const emoji = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢';
        console.log(`    ${emoji} ${rec.message}`);
      }
    }

    console.log('');
    console.log(`  Report: execution-validation-report.md`);
    console.log(separator);
    console.log('');
  }

  _log(message, level = 'info') {
    if (!this.verbose && level === 'debug') return;

    const prefix = `[ExecutionValidator:${level.toUpperCase()}]`;
    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else {
      console.log(`${prefix} ${message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 6: Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  ExecutionLogValidator,
  ExecutionLogParser,
  ExecutionValidator,
  ExecutionReportGenerator,
  STANDARD_EXECUTION_FLOW,
  STAGE_SEQUENCE,
};