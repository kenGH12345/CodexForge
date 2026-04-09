/**
 * Observability Flush Logic
 *
 * Extracted from observability.js for maintainability (ADR-41).
 * Contains metrics aggregation and file writing logic.
 *
 * @module workflow/core/observability-flush
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Builds a metrics object from the observability instance state.
 *
 * @param {object} state - The observability instance state
 * @returns {object} The metrics object
 */
function buildMetrics(state) {
  const {
    _sessionId,
    _projectId,
    _startedAt,
    _stages,
    _llmCalls,
    _errors,
    _testResult,
    _entropyResult,
    _ciResult,
    _codeGraphResult,
    _clarificationQuality,
    _taskComplexity,
    _blockTelemetry,
    _toolSearchStats,
    _toolResultFilterStats,
    _reflectionGating,
    _skillInjectedCounts,
    _skillEffectiveSet,
    _skillGatePassCounts,
    _skillGateFailCounts,
    _skillFalsePositiveSignals,
    _promptTraces,
    _expHitDetails,
    _routeDecisions,
    getPromptTraceSummary,
  } = state;

  const totalMs = Date.now() - _startedAt;
  const totalTokensEst = _llmCalls.reduce((s, c) => s + (c.estimatedTokens || 0), 0);
  const totalTokensActual = _llmCalls.reduce((s, c) => s + (c.actualTokens || 0), 0);
  const callsByRole = {};
  const tokensByRole = {};
  for (const c of _llmCalls) {
    callsByRole[c.role] = (callsByRole[c.role] || 0) + 1;
    tokensByRole[c.role] = (tokensByRole[c.role] || 0) + (c.actualTokens || c.estimatedTokens || 0);
  }

  const stagesArr = [];
  for (const [name, entry] of _stages) {
    stagesArr.push({ name, ...entry });
  }

  return {
    sessionId: _sessionId,
    projectId: _projectId,
    startedAt: new Date(_startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    totalDurationMs: totalMs,
    stages: stagesArr,
    llm: {
      totalCalls: _llmCalls.length,
      totalTokensEst,
      totalTokensActual: totalTokensActual > 0 ? totalTokensActual : null,
      callsByRole,
      tokensByRole,
    },
    errors: {
      count: _errors.length,
      details: _errors,
    },
    testResult: _testResult,
    entropyResult: _entropyResult,
    ciResult: _ciResult,
    codeGraphResult: _codeGraphResult,
    clarificationQuality: _clarificationQuality,
    taskComplexity: _taskComplexity,
    blockTelemetry: _blockTelemetry,
    toolSearchStats: _toolSearchStats,
    toolResultFilterStats: _toolResultFilterStats,
    reflectionGating: _reflectionGating,
    promptTraceSummary: getPromptTraceSummary(),
    skillUsage: _skillInjectedCounts.size > 0 ? {
      injected: Object.fromEntries(_skillInjectedCounts),
      effective: [..._skillEffectiveSet],
      gatePass: Object.fromEntries(_skillGatePassCounts || new Map()),
      gateFail: Object.fromEntries(_skillGateFailCounts || new Map()),
      falsePositiveSignals: Object.fromEntries(_skillFalsePositiveSignals || new Map()),
      totalInjected: [..._skillInjectedCounts.values()].reduce((s, c) => s + c, 0),
      totalEffective: _skillEffectiveSet.size,
    } : null,
    routeDecisions: (_routeDecisions && _routeDecisions.length > 0) ? {
      total: _routeDecisions.length,
      fallbackTriggered: _routeDecisions.filter(r => !!r.routeMeta?.fallback?.triggered).length,
      byRole: _routeDecisions.reduce((acc, item) => {
        acc[item.role] = (acc[item.role] || 0) + 1;
        return acc;
      }, {}),
      recent: _routeDecisions.slice(-20),
    } : null,
    // P2: Detailed experience attribution records
    expHitDetails: (_expHitDetails && _expHitDetails.length > 0) ? _expHitDetails : null,
  };
}

/**
 * Builds a history line object for metrics-history.jsonl.
 *
 * @param {object} metrics - The metrics object from buildMetrics()
 * @param {object} state - The observability instance state
 * @returns {object} The history line object
 */
function buildHistoryLine(metrics, state) {
  const {
    _expInjectedCount,
    _expHitCount,
    _expHitDetails,
    _clarificationQuality,
    _taskComplexity,
    _promptVariantStats,
    _blockTelemetry,
    _toolSearchStats,
    _toolResultFilterStats,
    _reflectionGating,
    _skillInjectedCounts,
    _skillEffectiveSet,
    _skillGatePassCounts,
    _skillGateFailCounts,
    _skillFalsePositiveSignals,
    _promptTraces,
    _stageRetries,
    _routeDecisions,
  } = state;

  return {
    sessionId: metrics.sessionId,
    projectId: metrics.projectId,
    startedAt: metrics.startedAt,
    totalDurationMs: metrics.totalDurationMs,
    llmCalls: metrics.llm.totalCalls,
    tokensEst: metrics.llm.totalTokensEst,
    tokensActual: metrics.llm.totalTokensActual,
    errorCount: metrics.errors.count,
    testPassed: metrics.testResult?.passed ?? null,
    testFailed: metrics.testResult?.failed ?? null,
    entropyViolations: metrics.entropyResult?.violations ?? null,
    ciStatus: metrics.ciResult?.status ?? null,
    codeGraphSymbols: metrics.codeGraphResult?.symbolCount ?? null,
    expInjectedCount: _expInjectedCount,
    expHitCount: _expHitCount,
    // P2: Count of unique experiences confirmed effective (with attribution)
    expHitDetailCount: (_expHitDetails && _expHitDetails.length > 0) ? _expHitDetails.length : null,
    clarificationEffectiveness: _clarificationQuality?.effectivenessScore ?? null,
    clarificationRounds: _clarificationQuality?.rounds ?? null,
    clarificationTextChangePct: _clarificationQuality?.textChangePct ?? null,
    clarificationNewSignals: _clarificationQuality?.newSignalsIntroduced ?? null,
    taskComplexityScore: _taskComplexity?.score ?? null,
    taskComplexityLevel: _taskComplexity?.level ?? null,
    promptVariantStats: _promptVariantStats ?? null,
    blockTelemetrySummary: _blockTelemetry?.summary ?? null,
    blockTelemetryRecommendations: _blockTelemetry?.recommendations ?? null,
    toolSearchSkippedByKeyword: _toolSearchStats?.skippedByKeyword ?? null,
    toolSearchTotalPlugins: _toolSearchStats?.totalPlugins ?? null,
    toolSearchExecuted: _toolSearchStats?.executed ?? null,
    toolResultFilterSaved: _toolResultFilterStats?.totalSaved ?? null,
    toolResultFilterBlocks: _toolResultFilterStats?.filteredBlocks ?? null,
    reflectionGatingPassed: _reflectionGating?.passed ?? null,
    reflectionGatingFailedGates: _reflectionGating?.failedGates ?? null,
    promptTraceCount: _promptTraces.length,
    promptTraceUniqueCount: new Set(_promptTraces.map(t => t.promptHash)).size,
    promptTraceAvgLength: _promptTraces.length > 0
      ? Math.round(_promptTraces.reduce((s, t) => s + t.promptLength, 0) / _promptTraces.length)
      : null,
    routeDecisionCount: (_routeDecisions && _routeDecisions.length > 0) ? _routeDecisions.length : 0,
    routeFallbackCount: (_routeDecisions && _routeDecisions.length > 0)
      ? _routeDecisions.filter(r => !!r.routeMeta?.fallback?.triggered).length
      : 0,
    skillInjectedNames: _skillInjectedCounts.size > 0 ? [..._skillInjectedCounts.keys()] : null,
    skillInjectedTotal: _skillInjectedCounts.size > 0 ? [..._skillInjectedCounts.values()].reduce((s, c) => s + c, 0) : null,
    skillEffectiveNames: _skillEffectiveSet.size > 0 ? [..._skillEffectiveSet] : null,
    skillEffectiveCount: _skillEffectiveSet.size > 0 ? _skillEffectiveSet.size : null,
    skillGatePassByName: (_skillGatePassCounts && _skillGatePassCounts.size > 0) ? Object.fromEntries(_skillGatePassCounts) : null,
    skillGateFailByName: (_skillGateFailCounts && _skillGateFailCounts.size > 0) ? Object.fromEntries(_skillGateFailCounts) : null,
    skillFalsePositiveSignalsByName: (_skillFalsePositiveSignals && _skillFalsePositiveSignals.size > 0) ? Object.fromEntries(_skillFalsePositiveSignals) : null,
    stageRetryCount: (_stageRetries && _stageRetries.length) || 0,
    stageRetries: (_stageRetries && _stageRetries.length > 0) ? _stageRetries : null,
  };
}

/**
 * Writes metrics to files (run-metrics.json and metrics-history.jsonl).
 *
 * @param {object} metrics - The metrics object
 * @param {object} historyLine - The history line object
 * @param {string} outputDir - Output directory
 * @returns {boolean} True if successful
 */
function writeMetricsFiles(metrics, historyLine, outputDir) {
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write run-metrics.json
    const outPath = path.join(outputDir, 'run-metrics.json');
    fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf-8');

    // Append to metrics-history.jsonl (atomic write)
    const historyPath = path.join(outputDir, 'metrics-history.jsonl');
    const historyLineStr = JSON.stringify(historyLine) + '\n';

    const historyTmpPath = historyPath + '.tmp';
    fs.writeFileSync(historyTmpPath, historyLineStr, 'utf-8');
    fs.appendFileSync(historyPath, historyLineStr, 'utf-8');
    try { fs.unlinkSync(historyTmpPath); } catch (_) { /* cleanup best-effort */ }

    return true;
  } catch (err) {
    console.warn(`[Observability] Failed to write metrics: ${err.message}`);
    return false;
  }
}

module.exports = {
  buildMetrics,
  buildHistoryLine,
  writeMetricsFiles,
};
