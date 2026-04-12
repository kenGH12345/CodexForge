'use strict';

/**
 * Step: Issue Pattern Collector (P1)
 *
 * Record orphaned modules, broken routes, and missing artifacts
 * into the experience store for self-evolution awareness.
 *
 * Priority: 23
 * After: plugin-activate
 * Requires: experienceStore
 */

const { TeardownStep } = require('../teardown-step');

class IssuePatternStep extends TeardownStep {
  constructor() {
    super({
      name: 'issue-pattern',
      description: 'Record orphaned modules and broken routes into ExperienceStore',
      priority: 23,
      after: ['plugin-activate'],
      requires: ['experienceStore'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { IssuePatternCollector, IssueType, IssueSeverity } = require('../issue-pattern-collector');
      const collector = new IssuePatternCollector(orch.experienceStore, {
        projectContext: orch.projectId || 'workflow',
        verbose: orch._verbose,
      });

      // Scan for known issue types from introspection data
      if (orch.introspectionManager) {
        const healthCheck = orch.introspectionManager.healthCheck?.() || {};
        if (healthCheck.issues) {
          const uncovered = healthCheck.issues.uncoveredModules || [];
          for (const mod of uncovered) {
            const modName = typeof mod === 'string' ? mod : (mod.name || 'unknown');
            collector.recordFeatureOrphaned({
              feature: modName,
              location: `core/${modName}`,
              mainFlow: 'orchestrator pipeline',
              integrationPoint: '_finalizeWorkflow()',
              evidence: healthCheck.issues,
            });
          }
        }
      }

      const summary = collector.generateSummary();
      if (summary.total > 0) {
        console.log(`[Orchestrator] 🐛 IssuePatternCollector: ${summary.total} issue(s) recorded to ExperienceStore`);
        if (summary.critical.length > 0) {
          console.warn(`[Orchestrator] 🚨 ${summary.critical.length} critical issue(s) detected!`);
        }
      }
    } catch (ipcErr) {
      console.warn(`[Orchestrator] ⚠️  Issue Pattern Collector failed (non-fatal): ${ipcErr.message}`);
    }
  }
}

module.exports = { IssuePatternStep };
