'use strict';

/**
 * Step: Staleness Checks (TechRadar + ArticleScout)
 *
 * Check if tech radar and article scout are stale.
 *
 * Priority: 54
 * After: task-history
 */

const { TeardownStep } = require('../teardown-step');

class StalenessCheckStep extends TeardownStep {
  constructor() {
    super({
      name: 'staleness-check',
      description: 'Check TechRadar and ArticleScout staleness',
      priority: 54,
      after: ['task-history'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    // ADR-38: TechRadar Staleness Check
    try {
      const { isTechRadarStale } = require('../techradar');
      const staleness = isTechRadarStale(orch._manifest && orch._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 TechRadar: ${daysText} since last tech scan.`);
        console.log(`[Orchestrator]    Run /techradar to discover new techniques and evaluate upgrades.`);
      }
    } catch (trErr) { /* Non-fatal */ }

    // ADR-32 P3: ArticleScout Staleness Check
    try {
      const { isArticleScoutStale } = require('../article-scout');
      const staleness = isArticleScoutStale(orch._manifest && orch._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 ArticleScout: ${daysText} since last article discovery.`);
        console.log(`[Orchestrator]    Run /article-scout to discover high-value AI/Agent articles.`);
      }
    } catch (asErr) { /* Non-fatal */ }
  }
}

module.exports = { StalenessCheckStep };
