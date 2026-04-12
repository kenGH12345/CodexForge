'use strict';

/**
 * Step: Changelog Generation
 *
 * Generate changelog from stage decisions if not disabled.
 *
 * Priority: 68
 * After: deep-audit
 */

const { TeardownStep } = require('../teardown-step');
const { PATHS } = require('../constants');
const path = require('path');
const fs = require('fs');

class ChangelogStep extends TeardownStep {
  constructor() {
    super({
      name: 'changelog',
      description: 'Generate changelog from stage decisions',
      priority: 68,
      after: ['deep-audit'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    const changeLogDisabled = orch._config?.changelog?.disabled;
    if (changeLogDisabled) return;

    try {
      const decisions = orch.decisionTrail ? orch.decisionTrail.getTimeline() : [];
      if (decisions.length === 0) return;

      const entryLines = decisions.map(d => {
        const stage = d.stage || '?';
        const decision = d.decision || d.summary || '';
        const timestamp = d.timestamp ? new Date(d.timestamp).toISOString() : '';
        return `- [${stage}] ${decision}  ${timestamp ? `(${timestamp})` : ''}`;
      });

      const header = `## ${new Date().toISOString().split('T')[0]}\n`;
      const changelog = header + entryLines.join('\n') + '\n';

      const changelogPath = path.join(orch._outputDir || PATHS.OUTPUT, 'changelog.md');

      // Prepend to existing changelog
      let existing = '';
      if (fs.existsSync(changelogPath)) {
        existing = fs.readFileSync(changelogPath, 'utf8');
        // Remove the header if it's the same date
        const todayHeader = `## ${new Date().toISOString().split('T')[0]}`;
        if (existing.startsWith(todayHeader)) {
          const nextHeaderIdx = existing.indexOf('\n## ', todayHeader.length);
          existing = nextHeaderIdx !== -1 ? existing.slice(nextHeaderIdx + 1) : '';
        }
      }

      fs.writeFileSync(changelogPath, changelog + (existing ? '\n' + existing : ''));
      console.log(`[Orchestrator] 📋 Changelog: ${decisions.length} decision(s) recorded`);
    } catch (clErr) {
      console.warn(`[Orchestrator] ⚠️  Changelog generation failed (non-fatal): ${clErr.message}`);
    }
  }
}

module.exports = { ChangelogStep };
