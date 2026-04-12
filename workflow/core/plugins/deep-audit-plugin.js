'use strict';

/**
 * Deep Audit Orchestrator Plugin — Declarative lifecycle integration
 *
 * Phase 2 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in orchestrator-teardown-impl.js and
 * the deep-audit subcommand in ide-workflow-bridge.js.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { orchestrator, outputDir, verbose } (orchestrator can be null for IDE mode)
 *   - run(opts?) → { findings, stats: { critical, high, medium, low, info }, reportPath, elapsedMs }
 *   - getExpertPanel() → array of expert objects
 *   - buildExpertReviewPrompt(finding) → string
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'deep-audit',
  phase: PluginPhase.TEARDOWN,
  priority: PluginPriority.BACKGROUND, // Fire-and-forget at teardown end
  description: 'Cross-module health assessment — runs as the last step of teardown',

  async activate(orch) {
    const { DeepAuditOrchestrator } = require('../deep-audit-orchestrator');
    const { PATHS } = require('../constants');

    const auditor = new DeepAuditOrchestrator({
      orchestrator: orch,  // Provides services + context for ExperienceStore injection
      outputDir: orch._outputDir || PATHS.OUTPUT,
      experienceStore: orch.experienceStore || null,
      verbose: orch._verbose,
    });

    return auditor;
  },

  async deactivate(orch) {
    const auditor = orch._pluginInstances?.['deep-audit'];
    if (!auditor) return;

    try {
      const auditReport = await auditor.run();

      if (auditReport && auditReport.stats) {
        const { critical = 0, high = 0, medium = 0, low = 0, info = 0 } = auditReport.stats;
        const totalFindings = critical + high + medium + low + info;
        if (totalFindings > 0) {
          console.log(`[Plugin:da] 🔎 ${totalFindings} finding(s) (${critical} critical, ${high} high, ${medium} medium)`);
        } else {
          console.log(`[Plugin:da] ✅ No cross-module issues found`);
        }
      }
    } catch (err) {
      console.warn(`[Plugin:da] ⚠️  Deep Audit failed (non-fatal): ${err.message}`);
    }
  },

  bridge: {
    subcommand: 'deep-audit',
    handler: async (args) => {
      const { DeepAuditOrchestrator } = require('../deep-audit-orchestrator');

      // Dimension mapping
      const dimMap = {
        logic: 'LOGIC',
        config: 'CONFIG',
        function: 'FUNCTION',
        coupling: 'COUPLING',
        architecture: 'ARCHITECTURE',
        performance: 'PERFORMANCE',
        knowledge: 'KNOWLEDGE',
      };

      let dimensions = undefined;
      if (args.dimension) {
        const dimKey = args.dimension.toLowerCase();
        if (dimMap[dimKey]) {
          dimensions = [dimMap[dimKey]];
        } else {
          return {
            success: false,
            subcommand: 'deep-audit',
            error: `Unknown dimension: "${args.dimension}". Available: ${Object.keys(dimMap).join(', ')}`,
          };
        }
      }

      const audit = new DeepAuditOrchestrator({
        orchestrator: null, // No orchestrator in IDE mode
        verbose: args.verbose || false,
      });

      const result = await audit.run({
        dimensions: dimensions || undefined,
        autoInjectExperience: true,
      });

      // Categorize findings by severity
      const bySeverity = { critical: [], high: [], medium: [], low: [], info: [] };
      for (const f of result.findings) {
        if (bySeverity[f.severity]) {
          bySeverity[f.severity].push({
            title: f.title,
            description: (f.description || '').slice(0, 300),
            category: f.category,
            suggestion: f.suggestion || null,
          });
        }
      }

      return {
        success: true,
        subcommand: 'deep-audit',
        data: {
          totalFindings: result.findings.length,
          stats: result.stats,
          elapsedMs: result.elapsedMs,
          reportPath: result.reportPath || null,
          topPriority: [...bySeverity.critical, ...bySeverity.high].slice(0, 10),
          bySeverity: {
            critical: bySeverity.critical.length,
            high: bySeverity.high.length,
            medium: bySeverity.medium.length,
            low: bySeverity.low.length,
            info: bySeverity.info.length,
          },
          recommendation: result.findings.length === 0
            ? 'All clear — no issues found across all audit dimensions.'
            : `${bySeverity.critical.length + bySeverity.high.length} critical/high priority issue(s) need attention. See output/deep-audit-report.md for full details.`,
        },
      };
    },
  },
});
