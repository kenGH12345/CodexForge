'use strict';

/**
 * MAPE → EvolutionLoop Signal Adapter
 *
 * Bridges MAPE Engine's analyze() output with EvolutionLoop's processSignal().
 * Converts root causes and correlations into structured EvolutionSignals
 * that drive self-evolution (ADR-55, ADR-35).
 *
 * Design: Pure transformation layer. No side effects — the caller decides
 * whether and when to dispatch signals to EvolutionLoop.
 */

// Severity mapping from MAPE correlation/action types to EvolutionLoop severity
const CORRELATION_SEVERITY = {
  'systematic-degradation': 'critical',
  'unreachable-targets': 'high',
  'prompt-degradation': 'high',
  'experience-bloat': 'high',
  'knowledge-decay': 'medium',
  'config-mistuning': 'medium',
};

const ROOT_CAUSE_SEVERITY = {
  'skill-refresh': 'medium',
  'experience-cleanup': 'medium',
};

// Action type to human-readable description
const ACTION_DESCRIPTION = {
  'config-adjustment': 'Configuration parameters need tuning',
  'skill-refresh': 'Knowledge base is stale and needs refreshing',
  'architecture-fix': 'Systematic regression detected — architecture review needed',
  'target-optimization': 'Performance metric has not reached target',
  'metric-calibration': 'Metric target may be unrealistic — recalibration needed',
  'prompt-evolution': 'Prompt effectiveness has degraded — variant exploration needed',
  'experience-distill': 'Experience store bloated with low hit-rate — distillation needed',
  'self-audit-pipeline': 'Multiple systematic issues detected — proactive audit recommended',
};

class MAPEToEvolutionAdapter {
  /**
   * @param {object} [options]
   * @param {EvolutionLoop} [options.evolutionLoop] — Optional EvolutionLoop instance for direct dispatch
   */
  constructor(options = {}) {
    this._evolutionLoop = options.evolutionLoop || null;
  }

  /**
   * Adapts MAPE analysis results into EvolutionSignal array.
   * Each correlation and root cause becomes an independent signal.
   *
   * @param {object} analysis — Output of MAPEEngine.analyze()
   * @param {object[]} [monitorSignals] — Original signals from MAPEEngine.monitor()
   * @returns {object[]} Array of EvolutionSignal-compatible objects
   */
  adapt(analysis, monitorSignals = []) {
    const signals = [];

    // 1. Convert correlations → MAPE_CORRELATION signals
    for (const corr of (analysis.correlations || [])) {
      const severity = CORRELATION_SEVERITY[corr.type] || 'medium';
      signals.push({
        type: 'MAPE_CORRELATION',
        severity,
        stage: 'MAPE',
        evidence: this._formatCorrelationEvidence(corr),
        context: {
          mapeType: corr.type,
          suggestedAction: corr.suggestedAction,
          signalCount: (corr.signals || []).length,
          monitorSignals: (corr.signals || []).map(s => ({
            source: s.source,
            type: s.type,
            severity: s.severity,
            title: s.title,
          })),
        },
        confidence: this._computeCorrelationConfidence(corr),
      });
    }

    // 2. Convert root causes → MAPE_ROOT_CAUSE signals
    for (const rc of (analysis.rootCauses || [])) {
      const severity = rc.occurrences >= 3 ? 'high' : ROOT_CAUSE_SEVERITY[rc.suggestedAction] || 'low';
      signals.push({
        type: 'MAPE_ROOT_CAUSE',
        severity,
        stage: 'MAPE',
        evidence: this._formatRootCauseEvidence(rc),
        context: {
          pattern: rc.pattern,
          occurrences: rc.occurrences,
          sources: rc.sources,
          suggestedAction: rc.suggestedAction,
          severity: rc.severity,
        },
        confidence: Math.min(0.5 + rc.occurrences * 0.1, 0.95),
      });
    }

    return signals;
  }

  /**
   * Adapts and dispatches signals directly to EvolutionLoop (if configured).
   *
   * @param {object} analysis — Output of MAPEEngine.analyze()
   * @param {object[]} [monitorSignals] — Original signals from MAPEEngine.monitor()
   * @returns {{ dispatched: number, signals: object[] }}
   */
  adaptAndDispatch(analysis, monitorSignals = []) {
    const signals = this.adapt(analysis, monitorSignals);
    let dispatched = 0;

    if (this._evolutionLoop) {
      for (const signal of signals) {
        try {
          const result = this._evolutionLoop.processSignal(signal);
          if (result.evolutionTriggered) dispatched++;
        } catch (err) {
          console.error(`[MAPEAdapter] ⚠️ Dispatch failed for ${signal.type}: ${err.message}`);
        }
      }
    }

    return { dispatched, signals };
  }

  /**
   * Formats correlation evidence into a human-readable string.
   *
   * @param {object} corr
   * @returns {string}
   */
  _formatCorrelationEvidence(corr) {
    const actionDesc = ACTION_DESCRIPTION[corr.suggestedAction] || corr.suggestedAction;
    const signalSummary = (corr.signals || [])
      .map(s => `[${s.source}] ${s.title || s.type}`)
      .join(', ');

    return `[${corr.type}] ${corr.description || actionDesc}. ` +
      `Triggered by: ${signalSummary}`;
  }

  /**
   * Formats root cause evidence into a human-readable string.
   *
   * @param {object} rc
   * @returns {string}
   */
  _formatRootCauseEvidence(rc) {
    const actionDesc = ACTION_DESCRIPTION[rc.suggestedAction] || rc.suggestedAction;
    return `[Recurring pattern: ${rc.pattern}] ` +
      `Occurrences: ${rc.occurrences}, ` +
      `Severity: ${rc.severity}, ` +
      `Action: ${actionDesc}`;
  }

  /**
   * Computes confidence for a correlation based on signal overlap.
   * More overlapping sources = higher confidence.
   *
   * @param {object} corr
   * @returns {number} 0.0-1.0
   */
  _computeCorrelationConfidence(corr) {
    const signalCount = (corr.signals || []).length;
    const uniqueSources = new Set((corr.signals || []).map(s => s.source)).size;
    // More signals + more source diversity = higher confidence
    const base = Math.min(0.5 + signalCount * 0.05, 0.8);
    const diversityBonus = Math.min(uniqueSources * 0.05, 0.15);
    return Math.min(base + diversityBonus, 0.95);
  }
}

module.exports = { MAPEToEvolutionAdapter };
