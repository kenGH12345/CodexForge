/**
 * WorkFlowAgent Execution Validation Configuration Example
 * 工作流执行验证配置示例
 *
 * 这个配置文件展示了如何启用和自定义自动执行验证功能。
 * 将需要的配置项复制到 workflow.config.js 中即可生效。
 */

'use strict';

module.exports = {
  // ═══════════════════════════════════════════════════════════════════════════
  // Section: Execution Validation Configuration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Enable automatic execution validation after workflow completion.
   * Automatically runs after each /wf command finishes.
   */
  executionValidation: true,

  /**
   * Execution validator options.
   */
  executionValidatorOptions: {
    /**
     * Strict mode: fail validation on any issue.
     * Default: false (warnings don't cause failure)
     */
    strictMode: false,

    /**
     * Verbose output: show detailed validation logs.
     * Default: false (silent mode during automation)
     */
    verbose: false,

    /**
     * Minimum score threshold for passing validation.
     * Below this threshold, findings are recorded to ExperienceStore.
     * Default: 80
     */
    minScoreThreshold: 80,

    /**
     * Generate baseline on each successful validation.
     * Useful for tracking execution quality trends.
     * Default: false
     */
    autoGenerateBaseline: false,

    /**
     * Compare with previous baseline and report improvements/regressions.
     * Default: false
     */
    compareWithBaseline: false,
  },

  /**
   * Quality Gate integration: execution validation gates.
   *
   * These gates are automatically added to QualityGate when
   * executionValidation is enabled.
   */
  executionValidationGates: {
    /**
     * Minimum overall execution score (0-100).
     * Workflow fails if below this threshold.
     */
    minExecutionScore: 70,

    /**
     * Maximum allowed failed stages.
     * Set to 0 to require all stages pass.
     */
    maxFailedStages: 0,

    /**
     * Minimum content integrity score (0-100).
     * Measures completeness of stage outputs.
     */
    minIntegrityScore: 80,
  },

  /**
   * Deep Audit integration: automatically include execution-validation
   * dimension in deep audits.
   */
  deepAudit: {
    /**
     * Include execution validation in DeepAudit dimensions.
     */
    includeExecutionValidation: true,

    /**
     * Severity threshold for execution validation findings.
     * Options: 'high', 'medium', 'low', 'all'
     */
    executionValidationSeverity: 'medium',
  },

  /**
   * Self Audit integration: include execution validation questions
   * in self-audit questionnaire.
   */
  selfAudit: {
    /**
     * Include execution validation questions in self-audit.
     */
    includeExecutionValidation: true,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Section: Standard Execution Flow Templates
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Custom stage templates can be added here to extend or override
   * the default STANDARD_EXECUTION_FLOW.
   *
   * Each template defines:
   *   - requiredArtifacts: 必需产出文件
   *   - optionalArtifacts: 可选产出文件
   *   - minContentSections: 最少章节数
   *   - requiredSections: 必需章节（正则匹配）
   *   - expectedMetrics: 内容长度等预期指标
   */
  customStageTemplates: {
    // Example: Custom analysis stage
    // ANALYSE: {
    //   requiredArtifacts: ['requirement.md'],
    //   optionalArtifacts: ['requirement.zh.md'],
    //   minContentSections: 3,
    //   requiredSections: [
    //     { pattern: /需求分析|Requirements Analysis/i, name: 'analysis' },
    //     { pattern: /功能范围|Functional Scope/i, name: 'scope' },
    //   ],
    //   expectedMetrics: {
    //     minLines: 20,
    //     maxLines: 500,
    //     hasJsonMetadata: true,
    //   },
    // },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Section: Report Configuration
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validation report generation options.
   */
  validationReport: {
    /**
     * Always generate Markdown report.
     */
    generateMarkdown: true,

    /**
     * Always generate JSON report for programmatic access.
     */
    generateJson: true,

    /**
     * Include detailed check results in console output.
     */
    verboseConsoleOutput: false,

    /**
     * Custom report output directory.
     * Default: same as workflow outputDir
     */
    // outputDir: './reports',
  },
};
