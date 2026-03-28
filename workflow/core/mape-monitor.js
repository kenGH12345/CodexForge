/**
 * MAPE Monitor Phase
 *
 * Extracted from mape-engine.js for maintainability (ADR-41).
 * Contains signal collection logic from multiple sources.
 *
 * @module workflow/core/mape-monitor
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Collects signals from multiple sources for MAPE analysis.
 *
 * Sources:
 * 1. Metrics History — cross-session trends
 * 2. Self-Reflection — quality gate failures and recurring patterns
 * 3. Quality gate history — recent failures
 * 4. Entropy — structural violations
 * 5. Metric calibration — unreachable targets
 * 6. Prompt performance — low gate-pass rate
 * 7. Experience store bloat — high count + low hit-rate
 *
 * @param {object} opts
 * @param {object} opts.orch - Orchestrator instance
 * @param {string} opts.outputDir - Output directory path
 * @param {boolean} [opts.verbose] - Verbose logging
 * @returns {object[]} Array of signals
 */
function collectSignals(opts) {
  const { orch, outputDir, verbose } = opts;
  const signals = [];

  // Source 1: Metrics History — cross-session trends
  try {
    const ObsStrategy = require('./observability-strategy');
    const history = ObsStrategy.loadHistory(outputDir);

    if (history.length >= 3) {
      const trends = ObsStrategy.computeTrends(history);
      if (trends) {
        // Token trend increasing?
        if (trends.tokenTrend > 0.1) {
          signals.push({
            source: 'metrics-history', type: 'anomaly', severity: 'medium',
            title: 'Token usage trending upward',
            data: { trend: trends.tokenTrend, sessions: history.length },
          });
        }
        // Error rate increasing?
        if (trends.errorTrend > 0) {
          signals.push({
            source: 'metrics-history', type: 'anomaly', severity: 'high',
            title: 'Error rate trending upward',
            data: { trend: trends.errorTrend, sessions: history.length },
          });
        }
        // Duration regression?
        if (trends.durationTrend > 0.2) {
          signals.push({
            source: 'metrics-history', type: 'anomaly', severity: 'medium',
            title: 'Workflow duration trending longer',
            data: { trend: trends.durationTrend, sessions: history.length },
          });
        }
      }

      // Experience hit-rate check
      const recent = history.slice(0, 5);
      const avgHitRate = recent.reduce((s, h) => {
        const injected = h.expInjectedCount || 0;
        const hit = h.expHitCount || 0;
        return s + (injected > 0 ? hit / injected : 1);
      }, 0) / recent.length;

      if (avgHitRate < 0.3 && recent.some(h => (h.expInjectedCount || 0) > 0)) {
        signals.push({
          source: 'metrics-history', type: 'anomaly', severity: 'high',
          title: 'Low experience hit-rate (< 30%)',
          data: { avgHitRate: (avgHitRate * 100).toFixed(1) + '%', recentSessions: recent.length },
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // Source 2: Self-Reflection — quality gate failures and recurring patterns
  try {
    if (orch?._selfReflection) {
      const sr = orch._selfReflection;
      const report = sr.reflect({ limit: 20, openOnly: true });

      for (const entry of (report.prioritised || []).slice(0, 10)) {
        signals.push({
          source: 'self-reflection', type: entry.type,
          severity: entry.severity || 'medium',
          title: entry.title,
          data: { patternKey: entry.patternKey, count: entry.metrics?.patternCount },
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // Source 3: Quality gate history — recent failures
  try {
    const metricsPath = path.join(outputDir, 'run-metrics.json');
    if (fs.existsSync(metricsPath)) {
      const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
      if (metrics.reflectionGating && !metrics.reflectionGating.passed) {
        const failed = (metrics.reflectionGating.gates || []).filter(g => !g.passed);
        for (const gate of failed) {
          signals.push({
            source: 'quality-gate', type: 'gate-failure', severity: 'high',
            title: `Quality gate failed: ${gate.name}`,
            data: { actual: gate.actual, threshold: gate.threshold },
          });
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  // Source 4: Entropy — structural violations
  try {
    const entropyPath = path.join(outputDir, 'entropy-report.json');
    if (fs.existsSync(entropyPath)) {
      const entropy = JSON.parse(fs.readFileSync(entropyPath, 'utf-8'));
      for (const v of (entropy.violations || []).slice(0, 5)) {
        signals.push({
          source: 'entropy', type: 'violation', severity: v.severity || 'medium',
          title: v.message || v.rule || 'Entropy violation',
          data: v,
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // Source 5: Metric calibration — unreachable targets (dead-end signal)
  try {
    const { RegressionGuard } = require('./regression-guard');
    const guard = new RegressionGuard({ outputDir });
    const snapshot = guard.snapshotMetrics();
    const gaps = guard._computeTargetGaps(snapshot.metrics);

    // Check for metrics stuck far from target (>100% gap = likely unreachable)
    for (const gap of gaps.filter(g => g.gapPct > 100).slice(0, 3)) {
      signals.push({
        source: 'metric-calibration', type: 'unreachable-target', severity: 'medium',
        title: `Metric "${gap.metric}" far from target (${gap.gapPct}% gap)`,
        data: { metric: gap.metric, current: gap.current, target: gap.target, gapPct: gap.gapPct },
      });
    }
  } catch (_) { /* non-fatal */ }

  // Source 6: Prompt performance — low gate-pass rate on prompt slots
  try {
    if (orch?.promptSlotManager) {
      const stats = orch.promptSlotManager.getStats();
      for (const [slotKey, slotInfo] of Object.entries(stats)) {
        const active = slotInfo.variants[slotInfo.activeVariant];
        if (!active || active.totalTrials < 3) continue;
        const passRate = parseFloat(active.gatePassRate);
        if (!isNaN(passRate) && passRate < 0.7) {
          signals.push({
            source: 'prompt-performance', type: 'low-pass-rate', severity: 'medium',
            title: `Prompt slot "${slotKey}" has low pass rate (${(passRate * 100).toFixed(0)}%)`,
            data: { slotKey, passRate, trials: active.totalTrials, activeVariant: slotInfo.activeVariant },
          });
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  // Source 7: Experience store bloat — high count + low hit-rate
  try {
    if (orch?.experienceStore) {
      const count = orch.experienceStore.experiences.length;
      // Cross-reference with hit-rate signal
      const hasLowHitRateSignal = signals.some(s => s.title?.includes('hit-rate'));
      if (count > 100 || (count > 50 && hasLowHitRateSignal)) {
        signals.push({
          source: 'experience-store', type: 'bloat', severity: 'low',
          title: `Experience store bloated (${count} entries)${hasLowHitRateSignal ? ' with low hit-rate' : ''}`,
          data: { experienceCount: count, hasLowHitRate: hasLowHitRateSignal },
        });
      }
    }
  } catch (_) { /* non-fatal */ }

  // Sort by severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  signals.sort((a, b) => (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5));

  if (verbose) {
    console.log(`[MAPE:Monitor] Collected ${signals.length} signal(s) from ${new Set(signals.map(s => s.source)).size} source(s)`);
  }

  return signals;
}

module.exports = {
  collectSignals,
};
