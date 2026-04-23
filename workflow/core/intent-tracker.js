/**
 * IntentTracker – Intent-outcome tracking for self-evolution
 * 
 * Captures the "expectation vs reality" gap that EvolutionLoop lacks.
 * Inspired by self-evolving project's intent-result loop pattern.
 * 
 * @module workflow/core/intent-tracker
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { ExperienceType, ExperienceCategory } = require('./experience-types');

/**
 * IntentRecord represents a captured intent before execution
 * @typedef {Object} IntentRecord
 * @property {string} intentId - Unique identifier for this intent
 * @property {string} decisionType - Type of decision (e.g., 'code-generation', 'architecture-design')
 * @property {string} intent - What the agent intended to achieve
 * @property {string} expectedOutcome - What the agent expected to happen
 * @property {number} confidence - Agent's confidence in this decision (0-1)
 * @property {Object} context - Additional context (file paths, task info, etc.)
 * @property {string} timestamp - ISO timestamp when intent was captured
 */

/**
 * GapReport represents the difference between expected and actual outcome
 * @typedef {Object} GapReport
 * @property {string} intentId - Reference to the original intent
 * @property {string} expectedOutcome - What was expected
 * @property {string} actualOutcome - What actually happened
 * @property {boolean} success - Whether the outcome matched expectation
 * @property {string} gapType - Type of gap: 'none' | 'partial' | 'complete'
 * @property {string|null} gapReason - Why there was a gap (if any)
 * @property {number} severity - How severe the gap is (0-1)
 * @property {string} timestamp - ISO timestamp when gap was analyzed
 */

/**
 * IntentTracker captures intents before execution and compares outcomes after.
 * This enables the system to distinguish "expected failures" from "unexpected failures".
 */
class IntentTracker {
  /**
   * @param {Object} options
   * @param {number} [options.maxIntents=50] - Maximum intents to track per session
   * @param {number} [options.minConfidenceForAnalysis=0.7] - Minimum confidence to include in gap analysis
   */
  constructor(options = {}) {
    this.maxIntents = options.maxIntents || 50;
    this.minConfidenceForAnalysis = options.minConfidenceForAnalysis || 0.7;
    
    /** @type {Map<string, IntentRecord>} */
    this._intents = new Map();
    
    /** @type {GapReport[]} */
    this._gapReports = [];
    
    /** @type {string[]} */
    this._intentOrder = []; // For FIFO eviction
  }

  /**
   * Track an intent before executing a decision
   * @param {Object} params
   * @param {string} params.decisionType - Type of decision
   * @param {string} params.intent - What the agent intends to achieve
   * @param {string} params.expectedOutcome - Expected result
   * @param {number} params.confidence - Confidence level (0-1)
   * @param {Object} [params.context] - Additional context
   * @returns {string} intentId - Unique identifier for this intent
   */
  trackIntent(params) {
    const { decisionType, intent, expectedOutcome, confidence, context = {} } = params;
    
    // Evict oldest if at capacity
    if (this._intents.size >= this.maxIntents) {
      const oldestId = this._intentOrder.shift();
      if (oldestId) {
        this._intents.delete(oldestId);
      }
    }
    
    const intentId = `INT-${Date.now()}-${uuidv4().slice(0, 8)}`;
    
    /** @type {IntentRecord} */
    const record = {
      intentId,
      decisionType,
      intent,
      expectedOutcome,
      confidence: Math.max(0, Math.min(1, confidence)),
      context,
      timestamp: new Date().toISOString(),
    };
    
    this._intents.set(intentId, record);
    this._intentOrder.push(intentId);
    
    return intentId;
  }

  /**
   * Compare actual outcome with expected outcome
   * @param {string} intentId - ID from trackIntent()
   * @param {string} actualOutcome - What actually happened
   * @param {boolean} success - Whether the action succeeded
   * @returns {GapReport|null} Gap analysis report, or null if intent not found
   */
  compareOutcome(intentId, actualOutcome, success) {
    const intent = this._intents.get(intentId);
    if (!intent) {
      return null;
    }
    
    // Determine gap type
    let gapType;
    let gapReason = null;
    let severity = 0;
    
    if (success) {
      // Success case: check if outcome matches expectation
      const similarity = this._computeSimilarity(intent.expectedOutcome, actualOutcome);
      if (similarity > 0.8) {
        gapType = 'none';
        severity = 0;
      } else if (similarity > 0.5) {
        gapType = 'partial';
        gapReason = 'Outcome partially matches expectation';
        severity = 0.3;
      } else {
        gapType = 'complete';
        gapReason = 'Outcome differs significantly from expectation despite success';
        severity = 0.6;
      }
    } else {
      // Failure case: was this expected?
      if (intent.confidence < 0.5) {
        gapType = 'none'; // Low confidence = expected failure
        gapReason = 'Failure was expected due to low confidence';
        severity = 0;
      } else if (intent.confidence < this.minConfidenceForAnalysis) {
        gapType = 'partial';
        gapReason = 'Failure was somewhat expected';
        severity = 0.3;
      } else {
        gapType = 'complete';
        gapReason = 'Unexpected failure with high confidence';
        severity = 1.0;
        // the most actionable self-evolution signal: agent was confident but reality diverged
        console.error(`[intent-tracker] HIGH-CONFIDENCE FAILURE id=${intentId} decision=${intent.decisionType} conf=${intent.confidence.toFixed(2)}`);
      }
    }
    
    /** @type {GapReport} */
    const report = {
      intentId,
      expectedOutcome: intent.expectedOutcome,
      actualOutcome,
      success,
      gapType,
      gapReason,
      severity,
      timestamp: new Date().toISOString(),
    };
    
    this._gapReports.push(report);
    
    return report;
  }

  /**
   * Flush all gap reports to ExperienceStore
   * @param {Object} store - ExperienceStore instance
   * @returns {{ added: number, skipped: number }} Result from batchRecord
   */
  flushToExperienceStore(store) {
    const experiences = [];
    
    for (const report of this._gapReports) {
      const intent = this._intents.get(report.intentId);
      if (!intent) continue;
      
      // Only record significant gaps (severity > 0.3)
      if (report.severity <= 0.3) continue;
      
      // Determine experience type based on gap type
      const type = report.success 
        ? ExperienceType.POSITIVE 
        : ExperienceType.NEGATIVE;
      
      const category = report.success
        ? ExperienceCategory.STABLE_PATTERN
        : ExperienceCategory.PITFALL;
      
      experiences.push({
        type,
        category,
        title: this._generateTitle(intent, report),
        content: this._generateContent(intent, report),
        skill: intent.decisionType,
        tags: ['intent-tracking', report.gapType, intent.decisionType],
        ttlDays: report.success ? 365 : 90,
      });
    }
    
    if (experiences.length === 0) {
      return { added: 0, skipped: 0 };
    }
    const result = store.batchRecord(experiences);
    // flush is invisible by default; expose it so operators know self-evolution is actually learning
    console.error(`[intent-tracker] flushed to experience-store: added=${result.added} skipped=${result.skipped}`);
    return result;
  }

  /**
   * Get statistics about tracked intents
   * @returns {Object} Stats object
   */
  getStats() {
    const totalIntents = this._intents.size;
    const totalReports = this._gapReports.length;
    
    const gapBreakdown = {
      none: 0,
      partial: 0,
      complete: 0,
    };
    
    for (const report of this._gapReports) {
      gapBreakdown[report.gapType]++;
    }
    
    const avgSeverity = totalReports > 0
      ? this._gapReports.reduce((sum, r) => sum + r.severity, 0) / totalReports
      : 0;
    
    return {
      totalIntents,
      totalReports,
      gapBreakdown,
      avgSeverity,
      maxIntents: this.maxIntents,
    };
  }

  /**
   * Clear all tracked data (for session reset)
   */
  clear() {
    this._intents.clear();
    this._gapReports = [];
    this._intentOrder = [];
  }

  /**
   * Compute text similarity (simple word overlap)
   * @private
   */
  _computeSimilarity(expected, actual) {
    const expectedWords = new Set(expected.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const actualWords = new Set(actual.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    
    if (expectedWords.size === 0 || actualWords.size === 0) {
      return 0;
    }
    
    let overlap = 0;
    for (const word of expectedWords) {
      if (actualWords.has(word)) overlap++;
    }
    
    return overlap / Math.max(expectedWords.size, actualWords.size);
  }

  /**
   * Generate title for experience
   * @private
   */
  _generateTitle(intent, report) {
    const prefix = report.success ? '[Intent Success]' : '[Intent Gap]';
    const gapDesc = report.gapType === 'none' ? 'matched' : `${report.gapType} gap`;
    return `${prefix} ${intent.decisionType}: ${gapDesc}`;
  }

  /**
   * Generate content for experience
   * @private
   */
  _generateContent(intent, report) {
    const lines = [
      `**Decision Type**: ${intent.decisionType}`,
      `**Confidence**: ${(intent.confidence * 100).toFixed(0)}%`,
      `**Intent**: ${intent.intent}`,
      `**Expected**: ${intent.expectedOutcome}`,
      `**Actual**: ${report.actualOutcome}`,
      `**Gap Type**: ${report.gapType}`,
    ];
    
    if (report.gapReason) {
      lines.push(`**Gap Reason**: ${report.gapReason}`);
    }
    
    lines.push(`**Severity**: ${(report.severity * 100).toFixed(0)}%`);
    
    return lines.join('\n');
  }
}

module.exports = { IntentTracker };
