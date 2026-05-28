'use strict';

/**
 * Step: Fix-Session Close
 *
 * Close any FixSessions that are still open at workflow teardown time,
 * preventing leaked "ghost sessions" that would skew anti-loop heuristics
 * and pollute future queryExperience() recall.
 *
 * For each open session:
 *   - If it has at least one attempt labelled 'correct' or with result 'success',
 *     close it as `resolved` (so finalExperience is generated and persisted).
 *   - Otherwise, close it as `abandoned` with a teardown-tagged reason.
 *
 * Successfully-resolved sessions whose `finalExperience` is generated are also
 * promoted into ExperienceStore (long-term memory, L5) so downstream stages
 * can recall them via ExperienceStore.search() in addition to the FixSession
 * query path.
 *
 * Priority: 53 (immediately after task-history@52)
 * After: task-history (so ExperienceStore is already wired up)
 */

const { TeardownStep } = require('../teardown-step');

class FixSessionCloseStep extends TeardownStep {
  constructor() {
    super({
      name: 'fix-session-close',
      description: 'Close orphan FixSessions and promote finalExperience to ExperienceStore',
      priority: 53,
      after: ['task-history'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { getConfig } = require('../config-loader');
      const cfg = getConfig?.()?.fixSession;
      if (!cfg || !cfg.enabled || cfg.autoCloseOnTeardown === false) {
        return; // feature disabled — no-op
      }

      const { FixExperienceEngine } = require('../fix-experience-engine');
      const engine = new FixExperienceEngine({ projectRoot: orch.projectRoot });
      const openSessions = engine.store.listSessions('open', 50);

      if (openSessions.length === 0) return;

      let closedResolved = 0;
      let closedAbandoned = 0;
      let promoted = 0;

      for (const session of openSessions) {
        const hasSuccess = (session.attempts || []).some(
          a => a.result === 'success' || a.label === 'correct'
        );

        const closeResult = hasSuccess
          ? engine.closeSession(session.id, {
              status: 'resolved',
              resolution: session.resolution || '(auto-closed at teardown)',
              rootCause: '(inferred from successful attempts)',
              keyInsight: 'Auto-resolved by teardown pipeline.',
            })
          : engine.closeSession(session.id, {
              status: 'abandoned',
              abandonReason: 'workflow-teardown: session left open without success',
            });

        if (!closeResult || !closeResult.success) continue;

        if (closeResult.status === 'resolved') {
          closedResolved++;
          // Promote finalExperience to ExperienceStore (L5 long-term memory)
          if (closeResult.finalExperience && orch.experienceStore) {
            try {
              orch.experienceStore.recordIfAbsent(`fix-${session.id}`, {
                type: 'positive',
                category: 'fix_experience',
                title: `Fix: ${String(session.problem).slice(0, 80)}`,
                content: [
                  `Problem: ${session.problem}`,
                  `Root cause: ${closeResult.finalExperience.rootCause || 'n/a'}`,
                  `Solution: ${closeResult.finalExperience.solution || 'n/a'}`,
                  `Key insight: ${closeResult.finalExperience.keyInsight || 'n/a'}`,
                ].join('\n'),
                tags: ['fix-session', `errorType:${session.errorType}`, 'auto-promoted'],
                ttlDays: 90,
              });
              promoted++;
            } catch (promoteErr) {
              // non-fatal
            }
          }
        } else {
          closedAbandoned++;
        }
      }

      console.log(
        `[Orchestrator] 🔧 FixSession teardown: ${closedResolved} resolved, ` +
        `${closedAbandoned} abandoned, ${promoted} promoted to ExperienceStore.`
      );
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  FixSession teardown skipped (non-fatal): ${err.message}`);
    }
  }
}

module.exports = { FixSessionCloseStep };
