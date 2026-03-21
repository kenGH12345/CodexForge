/**
 * DecisionTrail – Structured Decision Audit Log (Direction 4)
 *
 * Records every key decision point during a workflow run as structured entries.
 * Each entry captures: WHAT decision was made, WHY (evidence/signal), and
 * WHAT was the outcome. This transforms the opaque agent execution into an
 * auditable, explainable timeline.
 *
 * Design references:
 *   - NIST AI Risk Management Framework: "decision provenance" tracking
 *   - DARPA XAI: human-interpretable decision logs for autonomous systems
 *   - IEEE P7001: explainability-by-design certification standard
 *   - EU AI Act (2025): structured decision trails for high-risk AI audit
 *   - Chain-of-Thought reasoning traces in modern LLM agent frameworks
 *
 * Decision categories:
 *   - STAGE:      Stage enter, skip, exit, timeout
 *   - ROUTING:    Model tier selection, cost-aware downgrade
 *   - RECOVERY:   Error retry, rollback, compensation
 *   - QUALITY:    QualityGate pass/fail, review round decisions
 *   - RESOURCE:   Budget threshold, token limit, guard intervention
 *   - SKIP:       Stage smart-skip based on complexity assessment
 *
 * Integration:
 *   - _runStage():       Records STAGE decisions (enter, retry, exit)
 *   - RunGuard:          Records ROUTING + RESOURCE decisions
 *   - StageSmartSkip:    Records SKIP decisions
 *   - _finalizeWorkflow: Prints timeline summary
 *
 * @module decision-trail
 */

'use strict';

// ─── Decision Categories ────────────────────────────────────────────────────

const DecisionCategory = {
  STAGE:     'stage',
  ROUTING:   'routing',
  RECOVERY:  'recovery',
  QUALITY:   'quality',
  RESOURCE:  'resource',
  SKIP:      'skip',
};

// ─── DecisionTrail Class ────────────────────────────────────────────────────

class DecisionTrail {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=true]  - Set false to create a no-op trail
   * @param {number}  [opts.maxEntries=200] - Max entries before oldest are trimmed
   */
  constructor(opts = {}) {
    this._enabled = opts.enabled !== false;
    this._maxEntries = opts.maxEntries || 200;

    /** @type {DecisionEntry[]} */
    this._entries = [];

    /** @type {number} Monotonically increasing sequence */
    this._seq = 0;

    /** @type {number} Start timestamp */
    this._startMs = Date.now();
  }

  // ─── Recording API ──────────────────────────────────────────────────────

  /**
   * Records a decision point.
   *
   * @param {object} decision
   * @param {string}   decision.category  - DecisionCategory value
   * @param {string}   decision.stage     - Current stage name (e.g. 'ANALYSE')
   * @param {string}   decision.action    - What was decided (e.g. 'enter_stage', 'skip_stage', 'retry')
   * @param {string}   decision.reason    - Why this decision was made
   * @param {object}   [decision.evidence] - Supporting data (e.g. complexity score, budget %)
   * @param {string}   [decision.outcome]  - Result of the decision (filled in later if needed)
   * @returns {number} The sequence number of this entry
   */
  record(decision) {
    if (!this._enabled) return -1;

    const now = Date.now();
    const entry = {
      seq: this._seq++,
      ts: now,
      elapsed: `${((now - this._startMs) / 1000).toFixed(1)}s`,
      category: decision.category || DecisionCategory.STAGE,
      stage: decision.stage || null,
      action: decision.action || 'unknown',
      reason: decision.reason || '',
      evidence: decision.evidence || null,
      outcome: decision.outcome || null,
    };

    this._entries.push(entry);

    // Trim if over limit
    if (this._entries.length > this._maxEntries) {
      this._entries = this._entries.slice(-this._maxEntries);
    }

    return entry.seq;
  }

  /**
   * Updates the outcome of a previously recorded decision.
   * Useful for recording the result after execution completes.
   *
   * @param {number} seq - The sequence number returned by record()
   * @param {string} outcome - The outcome to set
   */
  setOutcome(seq, outcome) {
    if (!this._enabled || seq < 0) return;
    const entry = this._entries.find(e => e.seq === seq);
    if (entry) entry.outcome = outcome;
  }

  // ─── Query API ──────────────────────────────────────────────────────────

  /**
   * Returns all recorded decisions, optionally filtered.
   *
   * @param {object} [filter]
   * @param {string} [filter.category]
   * @param {string} [filter.stage]
   * @param {string} [filter.action]
   * @returns {DecisionEntry[]}
   */
  query(filter = {}) {
    let results = [...this._entries];
    if (filter.category) results = results.filter(e => e.category === filter.category);
    if (filter.stage) results = results.filter(e => e.stage === filter.stage);
    if (filter.action) results = results.filter(e => e.action === filter.action);
    return results;
  }

  /**
   * Returns the total number of recorded decisions.
   * @returns {number}
   */
  get length() {
    return this._entries.length;
  }

  // ─── Summary / Report ─────────────────────────────────────────────────

  /**
   * Returns a structured summary of all decisions.
   * @returns {{ total: number, byCategory: object, byStage: object, entries: DecisionEntry[] }}
   */
  getSummary() {
    const byCategory = {};
    const byStage = {};

    for (const e of this._entries) {
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      if (e.stage) {
        byStage[e.stage] = (byStage[e.stage] || 0) + 1;
      }
    }

    return {
      total: this._entries.length,
      byCategory,
      byStage,
      entries: [...this._entries],
    };
  }

  /**
   * Formats the decision trail as a human-readable timeline for console output.
   *
   * @returns {string} Formatted timeline string
   */
  formatTimeline() {
    if (!this._enabled || this._entries.length === 0) return '';

    const CATEGORY_ICONS = {
      [DecisionCategory.STAGE]:    '📋',
      [DecisionCategory.ROUTING]:  '🔀',
      [DecisionCategory.RECOVERY]: '🔄',
      [DecisionCategory.QUALITY]:  '✅',
      [DecisionCategory.RESOURCE]: '💰',
      [DecisionCategory.SKIP]:     '⏭️',
    };

    const lines = [
      ``,
      `${'─'.repeat(70)}`,
      `  📋  DECISION TRAIL — Structured Decision Audit Log`,
      `${'─'.repeat(70)}`,
      ``,
    ];

    // Group by stage for readability
    let currentStage = null;
    for (const entry of this._entries) {
      if (entry.stage && entry.stage !== currentStage) {
        currentStage = entry.stage;
        lines.push(`  ┌─── ${currentStage} ${'─'.repeat(Math.max(0, 55 - currentStage.length))}`);
      }

      const icon = CATEGORY_ICONS[entry.category] || '•';
      const elapsed = entry.elapsed.padStart(7);
      const outcome = entry.outcome ? ` → ${entry.outcome}` : '';
      const evidence = entry.evidence
        ? ` [${Object.entries(entry.evidence).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed ? v.toFixed(1) : v : v}`).join(', ')}]`
        : '';

      lines.push(`  │ ${elapsed} ${icon} ${entry.action}: ${entry.reason}${evidence}${outcome}`);
    }

    if (currentStage) {
      lines.push(`  └${'─'.repeat(69)}`);
    }

    // Summary footer
    const summary = this.getSummary();
    lines.push(``);
    lines.push(`  Total decisions: ${summary.total}`);

    const catSummary = Object.entries(summary.byCategory)
      .map(([cat, count]) => `${cat}=${count}`)
      .join(', ');
    if (catSummary) lines.push(`  By category: ${catSummary}`);

    lines.push(`${'─'.repeat(70)}`);
    return lines.join('\n');
  }
}

module.exports = { DecisionTrail, DecisionCategory };
