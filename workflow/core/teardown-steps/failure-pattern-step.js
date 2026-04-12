'use strict';

/**
 * Step: Failure Pattern Analysis (P1)
 *
 * Cluster similar failures from introspection data and generate Skill suggestions.
 * Closes the loop: failure → pattern → skill suggestion → evolution.
 *
 * Priority: 22
 * After: plugin-activate
 * Requires: experienceStore
 * Condition: shouldEvolve.selfReflection
 */

const { TeardownStep } = require('../teardown-step');

class FailurePatternStep extends TeardownStep {
  constructor() {
    super({
      name: 'failure-pattern',
      description: 'Cluster similar failures and generate skill suggestions',
      priority: 22,
      after: ['plugin-activate'],
      requires: ['experienceStore'],
      shouldSkip: (ctx) => {
        if (!ctx.shouldEvolve.selfReflection) {
          return 'Self-reflection not triggered (no errors or short session)';
        }
        return false;
      },
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const { FailurePatternAnalyzer } = require('../failure-pattern-analyzer');
      const analyzer = new FailurePatternAnalyzer({
        cheapLlmCall: orch._rawLlmCall || null,
        minOccurrenceThreshold: 2,
      });

      const result = await analyzer.analyzeRecentFailures();
      const patterns = result.patterns || [];
      if (patterns.length > 0) {
        console.log(`[Orchestrator] 🔍 FailurePatternAnalyzer: ${patterns.length} pattern(s) identified`);
        for (const p of patterns.slice(0, 5)) {
          const sig = p.signature || {};
          console.log(`  → ${sig.compoundKey || sig.failureType || 'unknown'} (occurrences: ${p.occurrences || p.count || '?'}, skill suggestion: ${p.suggestedSkillName || p.skillProposal?.name || 'none'})`);
        }

        for (const p of patterns) {
          const sig = p.signature || {};
          const occ = p.occurrences || p.count || 1;
          if (occ >= 2) {
            orch.experienceStore.recordIfAbsent(`failure-pattern:${sig.hash || Date.now()}`, {
              type: 'negative',
              category: 'failure_pattern',
              title: `Failure pattern: ${sig.failureType || 'unknown'} in ${sig.stage || 'unknown'}`,
              content: `Root cause: ${sig.rootCause || 'unknown'}. Error signatures: ${(sig.errorSignatures || []).join(', ')}. ` +
                       `Occurred ${occ} time(s). Suggested skill: ${p.suggestedSkillName || p.skillProposal?.name || 'none'}`,
              tags: ['failure-pattern', `stage:${sig.stage || 'unknown'}`, `root-cause:${sig.rootCause || 'unknown'}`],
              ttlDays: 90,
            });
          }
        }
      }
    } catch (fpaErr) {
      console.warn(`[Orchestrator] ⚠️  Failure Pattern Analyzer failed (non-fatal): ${fpaErr.message}`);
    }
  }
}

module.exports = { FailurePatternStep };
