'use strict';

/**
 * Issue Pattern Collector Plugin — Declarative lifecycle integration
 *
 * Phase 1 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in orchestrator-teardown-impl.js and ide-workflow-bridge.js.
 *
 * Verified API (2026-04-11):
 *   - Constructor: (experienceStore, { verbose, projectContext })
 *   - recordIssue({ type, severity, module, description, evidence, suggestedFix, testFile })
 *   - Convenience methods: recordModuleRouteBroken(), recordFeatureOrphaned(),
 *     recordTestFailureUntracked(), recordArtifactMissing(), recordDownstreamConsumeFail(),
 *     recordFormatMismatch()
 *   - getIssues(), getIssuesByType(), getIssuesBySeverity()
 *   - generateSummary() → { total, byType, bySeverity, topModules, timestamp }
 *   - Exports: IssueType enum, IssueSeverity enum
 *   - NO flush() method — recordIssue() writes directly to ExperienceStore
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'issue-pattern-collector',
  phase: PluginPhase.TEARDOWN,
  priority: PluginPriority.NORMAL + 5, // After FailurePatternAnalyzer
  description: 'Collect and categorize structural issues (orphan features, missing artifacts, route breaks)',

  async activate(orch) {
    const { IssuePatternCollector } = require('../issue-pattern-collector');

    const collector = new IssuePatternCollector(orch.experienceStore || null, {
      verbose: orch._verbose,
      projectContext: orch._projectRoot || process.cwd(),
    });

    return collector;
  },

  async deactivate(orch) {
    const collector = orch._pluginInstances?.['issue-pattern-collector'];
    if (!collector) return;

    try {
      // Record common teardown-time issues
      const outputDir = orch._outputDir || (orch._outputDir = require('../constants').PATHS.OUTPUT);
      const fs = require('fs');

      // Check for missing artifacts
      const expectedArtifacts = [
        { file: 'output/requirement.md', name: 'Requirements' },
        { file: 'output/architecture.md', name: 'Architecture' },
        { file: 'output/execution-plan.md', name: 'Execution Plan' },
        { file: 'output/code.diff', name: 'Code Changes' },
      ];

      for (const { file, name } of expectedArtifacts) {
        const filePath = require('path').join(orch._projectRoot || process.cwd(), file);
        if (!fs.existsSync(filePath)) {
          collector.recordArtifactMissing({
            module: name,
            description: `Expected output artifact not found: ${file}`,
            suggestedFix: `Re-run the ${name} stage to generate the missing artifact`,
          });
        }
      }

      // Generate summary
      const summary = collector.generateSummary();
      if (summary.total > 0) {
        console.log(`[Plugin:ipc] 📋 ${summary.total} issue(s) collected: ${Object.entries(summary.byType || {}).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    } catch (err) {
      console.warn(`[Plugin:ipc] ⚠️  Issue Pattern Collector failed (non-fatal): ${err.message}`);
    }
  },

  bridge: {
    subcommand: 'issue-pattern-collect',
    handler: async (args) => {
      const { IssuePatternCollector, IssueType, IssueSeverity } = require('../issue-pattern-collector');
      const path = require('path');
      const fs = require('fs');

      const collector = new IssuePatternCollector(null, {
        verbose: args.verbose || false,
        projectContext: args.projectRoot || process.cwd(),
      });

      // Scan for issues in IDE mode
      const projectRoot = args.projectRoot || process.cwd();
      const outputDir = path.join(projectRoot, 'output');

      // Check for missing artifacts
      const expectedFiles = [
        { file: 'output/requirement.md', name: 'Requirements' },
        { file: 'output/architecture.md', name: 'Architecture' },
        { file: 'output/execution-plan.md', name: 'Execution Plan' },
        { file: 'output/code.diff', name: 'Code Changes' },
      ];
      for (const { file, name } of expectedFiles) {
        const filePath = path.join(projectRoot, file);
        if (!fs.existsSync(filePath)) {
          collector.recordArtifactMissing({
            module: name,
            description: `Expected output artifact not found: ${file}`,
            suggestedFix: `Re-run the ${name} stage to generate the missing artifact`,
          });
        }
      }

      const summary = collector.generateSummary();
      return {
        success: true,
        subcommand: 'issue-pattern-collect',
        data: summary,
      };
    },
  },
});
