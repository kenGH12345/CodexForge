'use strict';

/**
 * Failure Pattern Analyzer Plugin — Declarative lifecycle integration
 *
 * Phase 1 of Lifecycle Plugin Registry migration.
 * Replaces the hand-coded integration in orchestrator-teardown-impl.js.
 *
 * Verified API (2026-04-11):
 *   - Constructor: { cheapLlmCall, minOccurrenceThreshold, analysisCooldownMs, patternExpiryMs }
 *   - analyzeRecentFailures() → { patterns, skillProposals, stats }
 *   - getPatternStats(), isPatternCovered(), exportPatterns(), reset()
 */

const { LifecyclePlugin, PluginPriority, PluginPhase } = require('../lifecycle-plugin-registry');

module.exports = new LifecyclePlugin({
  name: 'failure-pattern-analyzer',
  phase: PluginPhase.TEARDOWN,
  priority: PluginPriority.NORMAL,
  description: 'Cluster similar failures from introspection data and generate Skill evolution suggestions',

  async activate(orch) {
    // Lazy require to avoid circular deps
    const { FailurePatternAnalyzer } = require('../failure-pattern-analyzer');

    const analyzer = new FailurePatternAnalyzer({
      cheapLlmCall: orch._rawLlmCall || null,
      minOccurrenceThreshold: 2,
    });

    return analyzer;
  },

  async deactivate(orch) {
    const analyzer = orch._pluginInstances?.['failure-pattern-analyzer'];
    if (!analyzer) return;

    // Only run analysis if self-reflection evolution is triggered
    const shouldEvolve = orch._shouldTriggerEvolution?.();
    if (!shouldEvolve?.selfReflection || !orch.experienceStore) return;

    try {
      const result = await analyzer.analyzeRecentFailures();
      const patterns = result.patterns || [];

      if (patterns.length > 0) {
        console.log(`[Plugin:fpa] 🔍 ${patterns.length} pattern(s) identified`);
        for (const p of patterns.slice(0, 5)) {
          const sig = p.signature || {};
          console.log(`  → ${sig.compoundKey || sig.failureType || 'unknown'} (occurrences: ${p.occurrences || p.count || '?'}, skill suggestion: ${p.suggestedSkillName || p.skillProposal?.name || 'none'})`);
        }

        // Auto-record patterns as negative experiences for future routing
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
    } catch (err) {
      console.warn(`[Plugin:fpa] ⚠️  Failure Pattern Analyzer failed (non-fatal): ${err.message}`);
    }
  },
});
