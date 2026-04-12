'use strict';

/**
 * Step: Task History + Arch Knowledge Cache
 *
 * Record task/session memory and rebuild arch knowledge cache.
 *
 * Priority: 52
 * After: flush-external
 */

const { TeardownStep } = require('../teardown-step');
const { ExperienceType, ExperienceCategory, KnowledgeLayer, getLayerForCategory } = require('../experience-types');

class TaskHistoryStep extends TeardownStep {
  constructor() {
    super({
      name: 'task-history',
      description: 'Record task/session memory and rebuild arch knowledge cache',
      priority: 52,
      after: ['flush-external'],
    });
  }

  async execute(ctx) {
    const { orch, mode } = ctx;

    try {
      // Record task/session memory to ExperienceStore (L5 long-term memory)
      if (orch.experienceStore) {
        // Capture session-level experience
        const sessionMetrics = orch.obs?.getMetricsSnapshot?.() || {};
        const stageResults = orch.stageCtx ? Object.keys(orch.stageCtx) : [];

        orch.experienceStore.recordIfAbsent(`session-${Date.now()}`, {
          type: 'positive',
          category: 'session_summary',
          title: `Workflow session completed (${mode} mode)`,
          content: `Stages executed: ${stageResults.join(', ')}. ` +
                   `Quality score: ${sessionMetrics.qualityScore || 'N/A'}. ` +
                   `Token usage: ${sessionMetrics.tokenUsage || 'N/A'}.`,
          tags: ['long-term-memory', 'pitfall', `mode:${mode}`],
          ttlDays: 120,
        });

        console.log(`[Orchestrator] 🧠 Long-term memory extraction completed (L5).`);
      }

      // Rebuild arch knowledge cache
      try {
        const { rebuildCache } = require('../arch-knowledge-cache');
        rebuildCache(orch.projectRoot, { projectProfile: orch._config && orch._config.projectProfile });
      } catch (cacheErr) {
        console.warn(`[Orchestrator] ⚠️  Arch knowledge cache rebuild failed (non-fatal): ${cacheErr.message}`);
      }
    } catch (thErr) {
      console.warn(`[Orchestrator] ⚠️  Task/session memory recording failed (non-fatal): ${thErr.message}`);
    }
  }
}

module.exports = { TaskHistoryStep };
