/**
 * Observability Dashboard - Console Output
 *
 * Extracted from observability.js for maintainability (ADR-41).
 * Generates human-readable dashboard output for the workflow session.
 *
 * @module workflow/core/observability-dashboard
 */

'use strict';

const ObsStrategy = require('./observability-strategy');

// ─── Dashboard Printing ───────────────────────────────────────────────────────

/**
 * Prints a human-readable dashboard to stdout.
 *
 * @param {object} m - Metrics object from Observability.flush()
 * @param {string} outputDir - Output directory for history loading
 */
function printDashboard(m, outputDir) {
  const bar = '─'.repeat(58);
  console.log(`\n${bar}`);
  console.log(`  📊 WORKFLOW OBSERVABILITY DASHBOARD`);
  console.log(`  Session : ${m.sessionId}`);
  console.log(`  Duration: ${(m.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(bar);

  // Stage timings
  console.log(`  Stages:`);
  for (const s of m.stages) {
    const icon   = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️ ';
    const dur    = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
    console.log(`    ${icon} ${s.name.padEnd(14)} ${dur}`);
  }

  // LLM usage
  const tokenDisplay = m.llm.totalTokensActual != null
    ? `${m.llm.totalTokensActual.toLocaleString()} actual (est: ~${m.llm.totalTokensEst.toLocaleString()})`
    : `~${m.llm.totalTokensEst.toLocaleString()} est.`;
  console.log(`  LLM Calls: ${m.llm.totalCalls} total | ${tokenDisplay} tokens`);
  for (const [role, cnt] of Object.entries(m.llm.callsByRole)) {
    const roleTokens = m.llm.tokensByRole?.[role] || 0;
    console.log(`    • ${role}: ${cnt} call(s), ~${roleTokens.toLocaleString()} tokens`);
  }

  // Errors
  if (m.errors.count > 0) {
    console.log(`  ⚠️  Errors: ${m.errors.count}`);
    for (const e of m.errors.details.slice(0, 3)) {
      console.log(`    [${e.stage}] ${e.message.slice(0, 80)}`);
    }
  }

  // Test result
  if (m.testResult) {
    const t = m.testResult;
    const icon = t.failed === 0 ? '✅' : '❌';
    console.log(`  ${icon} Tests: ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
  }

  // Entropy
  if (m.entropyResult) {
    const e = m.entropyResult;
    const icon = e.violations === 0 ? '✅' : '⚠️ ';
    console.log(`  ${icon} Entropy GC: ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
    if (e.reportPath) console.log(`    Report: ${e.reportPath}`);
  }

  // CI result
  if (m.ciResult) {
    const c    = m.ciResult;
    const icon = c.status === 'success' ? '✅' : c.status === 'failed' ? '❌' : '🔄';
    console.log(`  ${icon} CI [${c.provider}]: ${c.status} (${(c.durationMs / 1000).toFixed(1)}s)`);
  }

  // Code graph
  if (m.codeGraphResult) {
    const g = m.codeGraphResult;
    console.log(`  📊 Code Graph: ${g.symbolCount} symbols | ${g.edgeCount} call edges | ${g.fileCount} files`);
  }

  // P1 Tool Search stats
  if (m.toolSearchStats) {
    const ts = m.toolSearchStats;
    const skipRatio = ts.totalPlugins > 0 ? ((ts.skippedByKeyword / ts.totalPlugins) * 100).toFixed(0) : 0;
    console.log(`  🔍 Tool Search: ${ts.skippedByKeyword} of ${ts.totalPlugins} plugins skipped by keyword (${skipRatio}% savings)`);
  }

  // P1 ToolResultFilter stats
  if (m.toolResultFilterStats) {
    const trf = m.toolResultFilterStats;
    console.log(`  ✂️  ToolResultFilter: ${trf.totalSaved.toLocaleString()} chars saved across ${trf.filteredBlocks} block(s)`);
  }

  // Self-Reflection quality gates
  if (m.reflectionGating) {
    const rg = m.reflectionGating;
    const icon = rg.passed ? '✅' : '❌';
    console.log(`  ${icon} Quality Gates: ${rg.passed ? 'ALL PASSED' : `${rg.failedGates.length} of ${rg.gateCount} FAILED [${rg.failedGates.join(', ')}]`}`);
  }

  // Skill Lifecycle: injection & effectiveness
  if (m.skillUsage) {
    const su = m.skillUsage;
    const uniqueCount = Object.keys(su.injected).length;
    const injectedNames = Object.keys(su.injected).join(', ');
    console.log(`  📚 Skills: ${uniqueCount} unique skill(s) injected (${su.totalInjected} total), ${su.totalEffective} effective`);
    if (injectedNames) console.log(`    Injected: ${injectedNames}`);
    if (su.effective.length > 0) console.log(`    Effective: ${su.effective.join(', ')}`);
  }

  console.log(bar);
  console.log(`  Full metrics: output/run-metrics.json`);
  console.log(`  History:      output/metrics-history.jsonl`);
  console.log(`${bar}\n`);

  // Cross-session trend summary (if history exists)
  printTrendSummary(outputDir);
}

/**
 * Prints cross-session trend summary.
 *
 * @param {string} outputDir - Output directory for history loading
 */
function printTrendSummary(outputDir) {
  try {
    const history = ObsStrategy.loadHistory(outputDir);
    if (history.length < 2) return; // Need at least 2 sessions for trends

    const trends = ObsStrategy.computeTrends(history);
    if (!trends) return;

    const bar = '─'.repeat(58);
    console.log(`  📈 TREND ANALYSIS (last ${trends.sessionCount} sessions)`);

    const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';
    console.log(`  Avg Duration : ${(trends.avgDurationMs / 1000).toFixed(1)}s  ${trendIcon(trends.durationTrend)} ${trends.durationTrend}`);
    console.log(`  Avg Tokens   : ~${trends.avgTokensEst.toLocaleString()}  ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend}`);
    console.log(`  Avg Errors   : ${trends.avgErrorCount}  ${trendIcon(trends.errorTrend)} ${trends.errorTrend}`);
    if (trends.avgEntropyViolations != null) {
      console.log(`  Avg Entropy  : ${trends.avgEntropyViolations} violations  ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend}`);
    }
    if (trends.ciSuccessRate != null) {
      console.log(`  CI Success   : ${(trends.ciSuccessRate * 100).toFixed(0)}%`);
    }
    console.log(`${bar}\n`);
  } catch (err) {
    console.warn(`[Observability] Failed to print trends: ${err.message}`);
  }
}

module.exports = {
  printDashboard,
  printTrendSummary,
};
