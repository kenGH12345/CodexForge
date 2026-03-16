'use strict';

const { ExperienceType, ExperienceCategory } = require('./experience-store');

/**
 * QualityGate – Stage pass/fail decision layer.
 *
 * Problem it solves (P0-A):
 *   Previously, quality gate decisions (should we pass? should we rollback?)
 *   were embedded inside _runArchitect, _runDeveloper, _runTester alongside
 *   Agent calls, file I/O, and state machine transitions. This violated SRP
 *   and made the rollback logic hard to reason about.
 *
 * This class extracts the DECISION logic into a dedicated layer:
 *   - evaluate(reviewResult, stage) → { pass, rollback, needsHumanReview }
 *   - recordExperience(decision, stage, reviewResult) → void
 *
 * The Orchestrator's _runXxx functions remain responsible for:
 *   - Calling the Agent (execution layer)
 *   - Injecting context (execution layer)
 *   - Driving the state machine (control layer)
 *
 * see CHANGELOG: P0-A
 */
class QualityGate {
  /**
   * @param {object} opts
   * @param {object} opts.experienceStore - ExperienceStore instance for recording outcomes
   * @param {number} [opts.maxRollbacks=1] - Max rollback attempts per stage before escalating
   */
  constructor({ experienceStore, maxRollbacks = 1 } = {}) {
    this.experienceStore = experienceStore;
    this.maxRollbacks    = maxRollbacks;
  }

  /**
   * Evaluates a review result and returns a gate decision.
   *
   * @param {object} reviewResult - Output from SelfCorrectionEngine or ReviewAgent
   * @param {string} stageName    - e.g. 'ARCHITECT', 'CODE', 'TEST'
   * @param {number} rollbackCount - How many times this stage has already rolled back
   * @returns {{ pass: boolean, rollback: boolean, needsHumanReview: boolean, reason: string }}
   */
  evaluate(reviewResult, stageName, rollbackCount = 0) {
    // Case 1: All issues resolved AND no human-review flag → PASS
    // P1-C fix: must also check needsHumanReview here.
    // SelfCorrectionEngine can return { failed: 0, needsHumanReview: true } when
    // oscillation is detected (signals array is empty because _detectSignals threw,
    // so failed = signals.filter(high).length = 0, but needsHumanReview = true).
    // Without this guard, oscillation is silently treated as a clean PASS.
    if (reviewResult.failed === 0 && !reviewResult.needsHumanReview) {
      return {
        pass:             true,
        rollback:         false,
        needsHumanReview: false,
        reason:           `${stageName} review passed (0 failed items)`,
      };
    }

    // Case 1b: failed === 0 but needsHumanReview === true (oscillation / forced escalation)
    // Fall through to Case 3/4 so the rollback budget is consulted.
    // We treat this as "1 virtual high-severity issue" to trigger the normal rollback path.
    if (reviewResult.failed === 0 && reviewResult.needsHumanReview) {
      // Synthesise a failed count of 1 so Cases 3/4 below fire correctly.
      reviewResult = { ...reviewResult, failed: 1 };
    }

    // Case 2: Issues remain but no high-severity → PASS with warnings
    if (!reviewResult.needsHumanReview) {
      return {
        pass:             true,
        rollback:         false,
        needsHumanReview: false,
        reason:           `${stageName} review passed with ${reviewResult.failed} low/medium issue(s) (no high-severity)`,
      };
    }

    // Case 3: High-severity issues remain, rollback budget available → ROLLBACK
    if (rollbackCount < this.maxRollbacks) {
      return {
        pass:             false,
        rollback:         true,
        needsHumanReview: false,
        reason:           `${stageName} review failed: ${reviewResult.failed} high-severity issue(s) remain (rollback ${rollbackCount + 1}/${this.maxRollbacks})`,
      };
    }

    // Case 4: High-severity issues remain, rollback budget exhausted → ESCALATE
    return {
      pass:             false,
      rollback:         false,
      needsHumanReview: true,
      reason:           `${stageName} review failed after ${rollbackCount} rollback(s): ${reviewResult.failed} high-severity issue(s) remain. Human review required.`,
    };
  }

  /**
   * Records the gate outcome in the experience store.
   *
   * Defect A fix: records DIAGNOSTIC information ("why" and "how"), not just
   * conclusions ("passed/failed"). The previous implementation recorded only
   * "ARCHITECT quality gate passed" which has zero guidance value for the next run.
   *
   * Pass case: records WHAT was checked, HOW MANY correction rounds were needed,
   *   and WHAT specific issues were fixed (extracted from reviewResult.history).
   *   This gives the next ArchitectAgent concrete patterns to follow.
   *
   * Fail case: records WHICH specific issues remained unresolved (riskNotes),
   *   HOW MANY rounds were attempted, and WHY the gate rejected the output.
   *   This gives the next run a concrete list of failure modes to avoid.
   *
   * @param {{ pass, rollback, needsHumanReview, reason }} decision
   * @param {string} stageName
   * @param {object} reviewResult
   * @param {object} [stageConfig] - Stage-specific config (skill name, tags, etc.)
   */
  recordExperience(decision, stageName, reviewResult, stageConfig = {}) {
    if (!this.experienceStore) return;

    const skill    = stageConfig.skill    || stageName.toLowerCase();
    const category = stageConfig.category || ExperienceCategory.STABLE_PATTERN;

    // ── Extract diagnostic details from reviewResult ──────────────────────────
    const rounds    = reviewResult.rounds    ?? 0;
    const total     = reviewResult.total     ?? 0;
    const failed    = reviewResult.failed    ?? 0;
    const riskNotes = Array.isArray(reviewResult.riskNotes) ? reviewResult.riskNotes : [];

    // Extract what was actually fixed from correction history (Defect E data).
    // reviewResult.history shape: [{ round, failures: [{id, finding}], ... }]
    // or SelfCorrectionEngine shape: [{ round, signals: [{label, severity}], ... }]
    const fixedIssues = _extractFixedIssues(reviewResult.history);

    if (decision.pass) {
      // ── Diagnostic PASS experience ──────────────────────────────────────────
      // Title is unique per (stage, rounds, fixed-count) so different pass patterns
      // accumulate as separate experiences rather than collapsing into one entry.
      const roundsLabel = rounds > 0 ? `after ${rounds} correction round(s)` : 'on first attempt';
      const title = `${stageName} passed quality gate ${roundsLabel}`;

      // Build a diagnostic content block that tells the NEXT run:
      //   1. How many items were checked (scope)
      //   2. How many rounds of self-correction were needed (effort signal)
      //   3. What specific issues were fixed in each round (actionable patterns)
      //   4. What risk notes were present (context)
      const contentLines = [
        `${stageName} passed quality gate ${roundsLabel}.`,
        `Scope: ${total} item(s) checked, ${failed} low/medium issue(s) remaining (no high-severity blockers).`,
      ];

      if (fixedIssues.length > 0) {
        contentLines.push(`\nIssues resolved during self-correction (${fixedIssues.length} fix(es)):`);
        fixedIssues.slice(0, 5).forEach(f => contentLines.push(`  - [Round ${f.round}] ${f.description}`));
      } else if (rounds === 0) {
        contentLines.push(`\nNo self-correction needed – output passed review on first attempt.`);
      }

      if (riskNotes.length > 0) {
        contentLines.push(`\nResidual risk notes (low/medium, non-blocking):`);
        riskNotes.slice(0, 3).forEach(n => contentLines.push(`  - ${n}`));
      }

      this.experienceStore.recordIfAbsent(title, {
        type:     ExperienceType.POSITIVE,
        category,
        title,
        content:  contentLines.join('\n'),
        skill,
        tags:     [stageName.toLowerCase(), 'passed', 'quality-gate', `rounds-${rounds}`],
      });

    } else {
      // ── Diagnostic FAIL experience ──────────────────────────────────────────
      // Title is stable (no round count) so repeated failures accumulate context
      // via appendByTitle() rather than creating duplicate entries.
      const title = `${stageName} quality gate: unresolved high-severity issues`;

      // Build a diagnostic content block that tells the NEXT run:
      //   1. What specific issues blocked the gate (actionable avoidance list)
      //   2. How many rounds were attempted (effort context)
      //   3. What was tried but failed (partial fix history)
      const contentLines = [
        `${stageName} failed quality gate after ${rounds} correction round(s).`,
        `${failed} high-severity issue(s) remained unresolved.`,
      ];

      if (riskNotes.length > 0) {
        contentLines.push(`\nUnresolved issues (avoid these patterns in future runs):`);
        riskNotes.slice(0, 5).forEach(n => contentLines.push(`  - ${n}`));
      }

      if (fixedIssues.length > 0) {
        contentLines.push(`\nPartially fixed issues (these were addressed but did not resolve all blockers):`);
        fixedIssues.slice(0, 3).forEach(f => contentLines.push(`  - [Round ${f.round}] ${f.description}`));
      }

      contentLines.push(`\nGate decision: ${decision.reason}`);

      const diagnosticContent = contentLines.join('\n');
      if (!this.experienceStore.appendByTitle(title, diagnosticContent)) {
        this.experienceStore.record({
          type:     ExperienceType.NEGATIVE,
          category: ExperienceCategory.PITFALL,
          title,
          content:  diagnosticContent,
          skill,
          tags:     [stageName.toLowerCase(), 'failed', 'quality-gate', 'pitfall', 'high-severity'],
        });
      }
    }
  }
}

module.exports = { QualityGate };

// ─── Module-private helpers ───────────────────────────────────────────────────

/**
 * Defect A fix: Extracts a flat list of fixed issues from a correction history array.
 *
 * Handles two history shapes:
 *   ReviewAgent:          [{ round, failures: [{id, finding}], before, after }]
 *   SelfCorrectionEngine: [{ round, signals: [{label, severity}], before, after, source? }]
 *
 * Returns: [{ round: number, description: string }]
 *   Each entry describes one issue that was fixed in a specific correction round.
 *   `before`/`after` content is intentionally excluded (too large for experience content).
 *
 * @param {object[]} history
 * @returns {{ round: number, description: string }[]}
 */
function _extractFixedIssues(history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const result = [];
  for (const h of history) {
    const round = h.round ?? '?';

    // ReviewAgent history: failures[].finding contains the issue description
    if (Array.isArray(h.failures) && h.failures.length > 0) {
      for (const f of h.failures.slice(0, 3)) {
        const desc = f.finding ? f.finding.slice(0, 150) : (f.id || 'unspecified issue');
        result.push({ round, description: desc });
      }
    }
    // SelfCorrectionEngine history: signals[].label contains the issue description
    else if (Array.isArray(h.signals) && h.signals.length > 0) {
      for (const s of h.signals.slice(0, 3)) {
        const sev = s.severity ? `[${s.severity}] ` : '';
        const desc = s.label ? `${sev}${s.label.slice(0, 130)}` : 'signal resolved';
        result.push({ round, description: desc });
      }
    }
  }
  return result;
}
