'use strict';

/**
 * Step: Skill Lifecycle Sync
 *
 * Sync skill usage/effectiveness stats, apply effectiveness policy,
 * detect stale skills, and auto-refresh them.
 *
 * Priority: 38
 * After: obs-flush
 * Requires: skillEvolution
 */

const { TeardownStep } = require('../teardown-step');

class SkillLifecycleStep extends TeardownStep {
  constructor() {
    super({
      name: 'skill-lifecycle',
      description: 'Sync skill usage stats and apply effectiveness policy',
      priority: 38,
      after: ['obs-flush'],
      requires: ['skillEvolution'],
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    if (!orch.obs._skillInjectedCounts) return;

    try {
      for (const [skillName, count] of orch.obs._skillInjectedCounts) {
        orch.skillEvolution.recordUsage(skillName, count);
      }
      for (const skillName of orch.obs._skillEffectiveSet) {
        orch.skillEvolution.recordEffective(skillName);
      }

      // P2: sync quality-gate effectiveness signals
      const skillSnapshot = orch.obs.getSkillEffectivenessSnapshot
        ? orch.obs.getSkillEffectivenessSnapshot()
        : null;
      if (skillSnapshot) {
        const gatePass = skillSnapshot.gatePass || {};
        const gateFail = skillSnapshot.gateFail || {};
        const fpSignals = skillSnapshot.falsePositiveSignals || {};
        const allNames = new Set([
          ...Object.keys(gatePass),
          ...Object.keys(gateFail),
          ...Object.keys(fpSignals),
        ]);
        for (const skillName of allNames) {
          const passCount = Number(gatePass[skillName] || 0);
          const failCount = Number(gateFail[skillName] || 0);
          const fpCount = Number(fpSignals[skillName] || 0);

          for (let i = 0; i < passCount; i++) {
            orch.skillEvolution.recordGateOutcome(skillName, { passed: true, falsePositiveSignals: 0 });
          }
          for (let i = 0; i < failCount; i++) {
            orch.skillEvolution.recordGateOutcome(skillName, { passed: false, falsePositiveSignals: 0 });
          }
          if (fpCount > 0) {
            orch.skillEvolution.recordGateOutcome(skillName, { passed: true, falsePositiveSignals: fpCount });
          }
        }
      }

      orch.skillEvolution.flushLifecycleStats();

      // Auto downweight/retire low-adoption high-noise skills
      const policyResult = orch.skillEvolution.applyEffectivenessPolicy
        ? orch.skillEvolution.applyEffectivenessPolicy()
        : { downweighted: [], retired: [] };
      if (policyResult.downweighted.length > 0 || policyResult.retired.length > 0) {
        console.log(`[Orchestrator] 🧪 Skill effectiveness policy: ${policyResult.downweighted.length} downweighted, ${policyResult.retired.length} retired.`);
        for (const s of policyResult.downweighted.slice(0, 5)) {
          console.log(`[Orchestrator]   ↓ ${s.name}: weight ${s.oldWeight} → ${s.newWeight} (adoption=${s.adoptionRate}, fpRate=${s.falsePositiveRate})`);
        }
        for (const s of policyResult.retired.slice(0, 5)) {
          console.log(`[Orchestrator]   📦 retired ${s.name} (gateFail=${s.gateFailCount}, fpRate=${s.falsePositiveRate})`);
        }
      }

      const { stale } = orch.skillEvolution.retireStaleSkills({ dryRun: true });
      if (stale.length > 0) {
        console.log(`[Orchestrator] 📦 Stale skill detection: ${stale.length} skill(s) underperforming:`);
        for (const s of stale) {
          const hr = ((s.effectiveCount || 0) / (s.usageCount || 1) * 100).toFixed(0);
          console.log(`[Orchestrator]   - ${s.name}: ${hr}% effective (${s.usageCount} uses)`);
        }
      }

      // ADR-32 P4: Stale Skill Auto-Refresh
      this._autoRefreshStaleSkills(orch);
    } catch (skillSyncErr) {
      console.warn(`[Orchestrator] ⚠️  Skill lifecycle sync failed (non-fatal): ${skillSyncErr.message}`);
    }
  }

  _autoRefreshStaleSkills(orch) {
    try {
      const STALE_DAYS = 90;
      const now = Date.now();
      const refreshCandidates = [];

      for (const meta of orch.skillEvolution.registry.values()) {
        if (meta.retiredAt) continue;
        const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
        const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
        const latestActivity = Math.max(lastEvolved, created);
        const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

        if (daysSince > STALE_DAYS && (meta.usageCount || 0) > 0) {
          refreshCandidates.push(meta.name);
        }
      }

      if (refreshCandidates.length > 0) {
        console.log(`[Orchestrator] 🔄 Auto-refreshing ${refreshCandidates.length} stale skill(s)`);
        const { enrichSkillFromExternalKnowledge } = require('../context-budget-manager');
        for (const skillName of refreshCandidates.slice(0, 3)) {
          enrichSkillFromExternalKnowledge(orch, skillName, { maxSearchResults: 3, maxFetchPages: 2 })
            .then(r => {
              if (r.success && r.sectionsAdded > 0) {
                console.log(`[Orchestrator] 🔄→📝 Auto-refreshed stale skill "${skillName}": ${r.sectionsAdded} entries updated.`);
              }
            })
            .catch(() => { /* non-fatal */ });
        }
      }
    } catch (refreshErr) {
      console.warn(`[Orchestrator] ⚠️ Stale skill auto-refresh failed (non-fatal): ${refreshErr.message}`);
    }
  }
}

module.exports = { SkillLifecycleStep };
