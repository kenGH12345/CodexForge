'use strict';

/**
 * Step: AEF Self-Refinement
 *
 * Auto-evolve skills from resolved complaints.
 * Must run early so that refined skills are available for later analysis.
 *
 * Priority: 15
 * After: plugin-activate
 * Requires: complaintWall, skillEvolution
 */

const { TeardownStep } = require('../teardown-step');
const { ComplaintStatus } = require('../complaint-wall');

class AefRefinementStep extends TeardownStep {
  constructor() {
    super({
      name: 'aef-refinement',
      description: 'Auto-evolve skills from resolved complaints (AEF self-refinement)',
      priority: 15,
      after: ['plugin-activate'],
      requires: ['complaintWall', 'skillEvolution'],
      shouldSkip: (ctx) => {
        if (!ctx.shouldEvolve.aefRefinement) {
          return 'No open complaints or negative experiences';
        }
        return false;
      },
    });
  }

  async execute(ctx) {
    const { orch } = ctx;

    try {
      const resolvedComplaints = orch.complaintWall.complaints.filter(
        c => c.status === ComplaintStatus.RESOLVED && c.rootCause
      );
      for (const rc of resolvedComplaints.slice(-3)) {
        const skillName = rc.targetType === 'skill' ? rc.targetId : 'troubleshooting';
        if (orch.skillEvolution.registry.has(skillName)) {
          orch.skillEvolution.evolve(skillName, {
            section: 'Prevention Rules',
            title: `[Auto] Prevention for ${rc.rootCause}: ${rc.description.slice(0, 60)}`,
            content: `**Root Cause**: ${rc.rootCause}\n**Prevention**: ${rc.suggestion}\n**Source**: Complaint ${rc.id}`,
            sourceExpId: rc.id,
            reason: `AEF self-refinement: auto-evolve from resolved complaint`,
          });
        }
      }
    } catch (srErr) {
      console.warn(`[Orchestrator] ⚠️  AEF Self-Refinement analysis failed (non-fatal): ${srErr.message}`);
    }
  }
}

module.exports = { AefRefinementStep };
