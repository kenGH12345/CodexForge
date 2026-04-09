/**
 * Issue Pattern Collector – 问题模式收集器
 *
 * 核心目标：将测试发现的问题模式自动记录到经验库，实现自我进化
 *
 * 问题类型：
 *   1. 功能模块路由不通：模块定义存在但未被主流程调用
 *   2. 功能游离于主流程之外：功能代码存在但未集成到工作流
 *   3. 测试失败但未记录经验：测试失败后没有记录到经验库
 *   4. 运行时产物缺失：代码存在但产物文件不存在
 *   5. 下游消费失败：上游产物无法被下游正确解析
 *
 * 使用方式：
 *   const collector = new IssuePatternCollector(experienceStore);
 *   collector.recordIssue({
 *     type: 'MODULE_ROUTE_BROKEN',
 *     module: 'CoverageChecker',
 *     description: 'CoverageChecker未被ArchitectAgent调用',
 *     evidence: {...}
 *   });
 */

'use strict';

const { ExperienceType, ExperienceCategory } = require('./experience-types');

// ═══════════════════════════════════════════════════════════════════════════
// Issue Types Definition
// ═══════════════════════════════════════════════════════════════════════════

const IssueType = {
  MODULE_ROUTE_BROKEN: 'module-route-broken',         // 模块路由不通
  FEATURE_ORPHANED: 'feature-orphaned',               // 功能游离于主流程
  TEST_FAILURE_UNTRACKED: 'test-failure-untracked',   // 测试失败未记录
  ARTIFACT_MISSING: 'artifact-missing',               // 运行时产物缺失
  DOWNSTREAM_CONSUME_FAIL: 'downstream-consume-fail', // 下游消费失败
  FORMAT_MISMATCH: 'format-mismatch',                 // 格式不匹配
};

const IssueSeverity = {
  CRITICAL: 'critical',   // 阻塞性问题，流程无法继续
  HIGH: 'high',           // 严重问题，影响核心功能
  MEDIUM: 'medium',       // 一般问题，影响次要功能
  LOW: 'low',             // 轻微问题，不影响功能
};

// ═══════════════════════════════════════════════════════════════════════════
// Issue Pattern Collector
// ═══════════════════════════════════════════════════════════════════════════

class IssuePatternCollector {
  /**
   * @param {object} experienceStore - ExperienceStore instance
   * @param {object} [options]
   * @param {boolean} [options.verbose] - Enable verbose logging
   * @param {string} [options.projectContext] - Project context
   */
  constructor(experienceStore, options = {}) {
    this._exp = experienceStore;
    this._verbose = options.verbose || false;
    this._projectContext = options.projectContext || 'workflow';
    this._issues = [];  // Collect issues in memory
  }

  /**
   * Records an issue pattern.
   *
   * @param {object} params
   * @param {string} params.type - Issue type (IssueType enum)
   * @param {string} params.severity - Issue severity (IssueSeverity enum)
   * @param {string} params.module - Affected module name
   * @param {string} params.description - Issue description
   * @param {object} [params.evidence] - Evidence data (stack trace, file paths, etc.)
   * @param {string} [params.suggestedFix] - Suggested fix
   * @param {string} [params.testFile] - Test file that detected the issue
   */
  recordIssue({ type, severity, module, description, evidence = {}, suggestedFix = '', testFile = '' }) {
    const now = new Date().toISOString();
    const issueId = `ISSUE-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    
    // Build content
    const content = this._buildContent({
      type,
      severity,
      module,
      description,
      evidence,
      suggestedFix,
      testFile,
      now,
    });
    
    // Record as negative experience (pitfall)
    const exp = this._exp.record({
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: `[${severity.toUpperCase()}] ${type}: ${module}`,
      content,
      skill: 'issue-pattern',
      tags: [
        'issue-pattern',
        type,
        severity,
        module.toLowerCase(),
        this._projectContext,
      ].filter(Boolean),
    });
    
    // Store in memory
    this._issues.push({
      id: issueId,
      type,
      severity,
      module,
      description,
      experienceId: exp?.id || null,
      recordedAt: now,
    });
    
    if (this._verbose) {
      const icon = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : '📝';
      console.log(`[IssueCollector] ${icon} Recorded: ${type} in ${module} (${severity})`);
    }
    
    return { issueId, experienceId: exp?.id || null };
  }

  /**
   * Records a module route broken issue.
   */
  recordModuleRouteBroken({ module, caller, expectedRoute, actualBehavior, evidence = {} }) {
    return this.recordIssue({
      type: IssueType.MODULE_ROUTE_BROKEN,
      severity: IssueSeverity.HIGH,
      module,
      description: `Module ${module} is not being called from ${caller}. Expected route: ${expectedRoute}. Actual: ${actualBehavior}`,
      evidence: {
        caller,
        expectedRoute,
        actualBehavior,
        ...evidence,
      },
      suggestedFix: `Verify that ${caller} correctly imports and invokes ${module}. Check state machine transitions.`,
    });
  }

  /**
   * Records a feature orphaned issue (feature exists but not integrated).
   */
  recordFeatureOrphaned({ feature, location, mainFlow, integrationPoint, evidence = {} }) {
    return this.recordIssue({
      type: IssueType.FEATURE_ORPHANED,
      severity: IssueSeverity.HIGH,
      module: feature,
      description: `Feature ${feature} at ${location} is not integrated into main flow ${mainFlow}. Should be integrated at ${integrationPoint}`,
      evidence: {
        location,
        mainFlow,
        integrationPoint,
        ...evidence,
      },
      suggestedFix: `Add integration at ${integrationPoint} to invoke ${feature}.`,
    });
  }

  /**
   * Records a test failure that was not tracked to experience store.
   */
  recordTestFailureUntracked({ testFile, testName, error, fixHistory = [] }) {
    return this.recordIssue({
      type: IssueType.TEST_FAILURE_UNTRACKED,
      severity: IssueSeverity.MEDIUM,
      module: testFile,
      description: `Test ${testName} failed but no experience was recorded. Error: ${error.message || error}`,
      evidence: {
        testName,
        error: error.message || String(error),
        stack: error.stack || '',
        fixHistory,
      },
      testFile,
      suggestedFix: 'Integrate TestFailureExperienceRecorder into test runner.',
    });
  }

  /**
   * Records a missing runtime artifact.
   */
  recordArtifactMissing({ artifact, expectedPath, stage, evidence = {} }) {
    return this.recordIssue({
      type: IssueType.ARTIFACT_MISSING,
      severity: IssueSeverity.CRITICAL,
      module: stage,
      description: `Runtime artifact ${artifact} is missing at ${expectedPath}. Stage ${stage} may not have executed.`,
      evidence: {
        artifact,
        expectedPath,
        stage,
        ...evidence,
      },
      suggestedFix: `Verify that ${stage} stage executed successfully. Check stage transition logs.`,
    });
  }

  /**
   * Records a downstream consumption failure.
   */
  recordDownstreamConsumeFail({ upstream, downstream, artifact, parseError, evidence = {} }) {
    return this.recordIssue({
      type: IssueType.DOWNSTREAM_CONSUME_FAIL,
      severity: IssueSeverity.HIGH,
      module: downstream,
      description: `Downstream ${downstream} failed to parse artifact ${artifact} from ${upstream}. Error: ${parseError}`,
      evidence: {
        upstream,
        artifact,
        parseError,
        ...evidence,
      },
      suggestedFix: `Verify format compatibility between ${upstream} output and ${downstream} parser.`,
    });
  }

  /**
   * Records a format mismatch issue.
   */
  recordFormatMismatch({ file, expectedFormat, actualFormat, parser, evidence = {} }) {
    return this.recordIssue({
      type: IssueType.FORMAT_MISMATCH,
      severity: IssueSeverity.HIGH,
      module: parser,
      description: `File ${file} format mismatch. Expected: ${expectedFormat}. Actual: ${actualFormat}. Parser: ${parser}`,
      evidence: {
        file,
        expectedFormat,
        actualFormat,
        parser,
        ...evidence,
      },
      suggestedFix: `Update ${file} to match expected format, or update ${parser} to handle the actual format.`,
    });
  }

  /**
   * Gets all recorded issues.
   */
  getIssues() {
    return [...this._issues];
  }

  /**
   * Gets issues by type.
   */
  getIssuesByType(type) {
    return this._issues.filter(i => i.type === type);
  }

  /**
   * Gets issues by severity.
   */
  getIssuesBySeverity(severity) {
    return this._issues.filter(i => i.severity === severity);
  }

  /**
   * Generates a summary report.
   */
  generateSummary() {
    const summary = {
      total: this._issues.length,
      byType: {},
      bySeverity: {},
      critical: [],
      high: [],
    };
    
    for (const issue of this._issues) {
      // Count by type
      summary.byType[issue.type] = (summary.byType[issue.type] || 0) + 1;
      
      // Count by severity
      summary.bySeverity[issue.severity] = (summary.bySeverity[issue.severity] || 0) + 1;
      
      // Collect critical/high issues
      if (issue.severity === 'critical') {
        summary.critical.push(issue);
      } else if (issue.severity === 'high') {
        summary.high.push(issue);
      }
    }
    
    return summary;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  _buildContent({ type, severity, module, description, evidence, suggestedFix, testFile, now }) {
    const lines = [];
    
    lines.push(`## Issue Pattern`);
    lines.push(`**Type:** ${type}`);
    lines.push(`**Severity:** ${severity}`);
    lines.push(`**Module:** ${module}`);
    lines.push(`**Detected:** ${now}`);
    lines.push(``);
    
    lines.push(`## Description`);
    lines.push(description);
    lines.push(``);
    
    if (testFile) {
      lines.push(`## Detection Source`);
      lines.push(`- **Test File:** ${testFile}`);
      lines.push(``);
    }
    
    if (Object.keys(evidence).length > 0) {
      lines.push(`## Evidence`);
      for (const [key, value] of Object.entries(evidence)) {
        if (typeof value === 'object') {
          lines.push(`- **${key}:** \`${JSON.stringify(value).slice(0, 100)}\``);
        } else {
          lines.push(`- **${key}:** ${String(value).slice(0, 200)}`);
        }
      }
      lines.push(``);
    }
    
    if (suggestedFix) {
      lines.push(`## Suggested Fix`);
      lines.push(suggestedFix);
      lines.push(``);
    }
    
    lines.push(`## Self-Evolution Action`);
    lines.push(`This issue should trigger:`);
    lines.push(`1. Skill update if pattern repeats`);
    lines.push(`2. Test case addition for regression prevention`);
    lines.push(`3. Architecture review if structural issue`);
    
    return lines.join('\n');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Module Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  IssuePatternCollector,
  IssueType,
  IssueSeverity,
};
