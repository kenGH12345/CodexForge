'use strict';

const { TeardownStep } = require('../teardown-step');
const { isReflectionCycleEnabled } = require('../reflection-cycle');

class ReflectionCycleStep extends TeardownStep {
  constructor() {
    super({
      name: 'reflection-cycle',
      description: 'Run reflection cycle: decompose → induce → relate → distill actionable insights',
      priority: 33,
      after: ['self-reflection'],
      requires: ['_selfReflection'],
      shouldSkip: (ctx) => {
        if (!isReflectionCycleEnabled(ctx.projectRoot)) {
          return 'ReflectionCycle disabled by feature flag';
        }
        if (!ctx.shouldEvolve?.selfReflection) {
          return 'No errors, short session';
        }
        return false;
      },
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const signals = this._collectSignals(orch);

      if (signals.length === 0) {
        ctx.logger?.log('reflection-cycle', 'No signals to process, skipping cycle');
        return;
      }

      const result = await orch._selfReflection.runReflectionCycle(signals, {
        maxRounds: 3,
        convergenceThreshold: 0.7,
      });

      if (result.error) {
        console.warn(`[Orchestrator] ⚠️ Reflection cycle failed: ${result.error}`);
        return;
      }

      console.log(`[Orchestrator] 🔄 Reflection cycle: ${result.round} round(s), converged=${result.converged}`);

      if (result.actions?.length > 0) {
        await this._triggerMAPE(result.actions, orch);
      }

      if (result.unresolvedComplaints?.length > 0) {
        this._submitComplaints(result.unresolvedComplaints, orch);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️ Reflection cycle step failed (non-fatal): ${err.message}`);
    }
  }

  _collectSignals(orch) {
    const signals = [];

    if (orch._evolutionLoop?._signals?.length > 0) {
      signals.push(...orch._evolutionLoop._signals.slice(-50));
    }

    if (orch._selfReflection?._reflections?.length > 0) {
      const recent = orch._selfReflection._reflections
        .filter(r => r.status === 'OPEN')
        .slice(-20);
      signals.push(...recent.map(r => ({
        id: r.id,
        source: r.source || 'self-reflection',
        dimension: r.type,
        title: r.title,
        content: r.description,
        confidence: r.severity === 'critical' ? 0.9 : r.severity === 'high' ? 0.7 : 0.5,
        timestamp: r.createdAt,
      })));
    }

    return signals;
  }

  async _triggerMAPE(actions, orch) {
    try {
      const { MAPEEngine } = require('../mape-engine');
      const mape = new MAPEEngine({ projectRoot: orch.projectRoot });
      await mape.plan(actions);
    } catch {
      console.warn('[Orchestrator] ⚠️ MAPE trigger failed (non-fatal)');
    }
  }

  _submitComplaints(complaints, orch) {
    for (const complaint of complaints) {
      try {
        orch._selfReflection?.recordIssue({
          type: 'unresolved-complaint',
          severity: complaint.severity || 'medium',
          title: `Unresolved: ${complaint.target}`,
          description: complaint.evidence || complaint.reason || '',
          source: 'reflection-cycle',
        });
      } catch {
        // Non-fatal
      }
    }
  }
}

module.exports = { ReflectionCycleStep };
