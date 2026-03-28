/**
 * Observability HTML Report Generator
 *
 * Extracted from observability.js for maintainability (ADR-41).
 * Generates interactive HTML reports from session metrics.
 *
 * @module workflow/core/observability-html-report
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CSS Styles ──────────────────────────────────────────────────────────────

const CSS_STYLES = `
:root {
  --bg: #0f1419;
  --card-bg: #1a1f26;
  --text: #e6e6e6;
  --muted: #8b949e;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --border: #30363d;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 24px;
}

h1 { font-size: 24px; margin-bottom: 8px; }
h2 { font-size: 18px; margin: 24px 0 12px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; }
h3 { font-size: 14px; margin-bottom: 8px; color: var(--muted); }

.card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}

.overview { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }

.stat-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 24px;
  text-align: center;
  min-width: 120px;
}

.stat-card .value { font-size: 28px; font-weight: 600; }
.stat-card .label { font-size: 12px; color: var(--muted); margin-top: 4px; }

table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
th { font-size: 12px; color: var(--muted); text-transform: uppercase; }

.status-ok { color: var(--green); }
.status-error { color: var(--red); }
.status-warn { color: var(--yellow); }

.bar-container { width: 100%; height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
.bar { height: 100%; border-radius: 4px; }
.bar.status-ok { background: var(--green); }
.bar.status-error { background: var(--red); }
.bar.status-warn { background: var(--yellow); }
.bar.bar-tokens { background: var(--accent); }

.grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }

.header { margin-bottom: 24px; }
.header-meta { font-size: 14px; color: var(--muted); margin-top: 8px; }

.trend-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 24px; }
.trend-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); }
.trend-row:last-child { border-bottom: none; }
.trend-value { font-weight: 600; }

.footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); }
`;

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Escapes HTML special characters.
 */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Formats milliseconds to seconds string.
 */
function dur(ms) {
  return ms != null ? `${(ms / 1000).toFixed(1)}s` : '–';
}

/**
 * Calculates percentage.
 */
function pct(n, total) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

// ─── HTML Section Builders ───────────────────────────────────────────────────

/**
 * Builds stage timeline table rows.
 */
function buildStageRows(stages, totalDurationMs) {
  return (stages || []).map(s => {
    const statusClass = s.status === 'ok' ? 'status-ok' : s.status === 'error' ? 'status-error' : 'status-warn';
    const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️';
    const barWidth = totalDurationMs > 0 ? Math.max(2, (s.durationMs || 0) / totalDurationMs * 100) : 0;
    return `<tr>
      <td>${icon} ${esc(s.name)}</td>
      <td class="${statusClass}">${esc(s.status || '–')}</td>
      <td>${dur(s.durationMs)}</td>
      <td><div class="bar-container"><div class="bar ${statusClass}" style="width: ${barWidth}%"></div></div></td>
    </tr>`;
  }).join('\n');
}

/**
 * Builds LLM usage by role table rows.
 */
function buildLLMRoleRows(callsByRole, tokensByRole) {
  const roleEntries = Object.entries(callsByRole || {});
  const maxRoleTokens = Math.max(1, ...Object.values(tokensByRole || {}).map(Number));
  return roleEntries.map(([role, cnt]) => {
    const tokens = tokensByRole?.[role] || 0;
    const barWidth = (tokens / maxRoleTokens) * 100;
    return `<tr>
      <td>${esc(role)}</td>
      <td>${cnt}</td>
      <td>~${tokens.toLocaleString()}</td>
      <td><div class="bar-container"><div class="bar bar-tokens" style="width: ${barWidth}%"></div></div></td>
    </tr>`;
  }).join('\n');
}

/**
 * Builds error details table rows.
 */
function buildErrorRows(errors) {
  return (errors || []).map(e => {
    return `<tr>
      <td>${esc(e.stage)}</td>
      <td>${esc(e.message)}</td>
      <td>${new Date(e.ts).toLocaleTimeString()}</td>
    </tr>`;
  }).join('\n');
}

/**
 * Builds test result section HTML.
 */
function buildTestSection(testResult) {
  if (!testResult) return '';
  const icon = testResult.failed === 0 ? '✅' : '❌';
  return `
    <div class="card">
      <h3>${icon} Test Results</h3>
      <table>
        <tr><td>Passed</td><td><strong>${testResult.passed}</strong></td></tr>
        <tr><td>Failed</td><td><strong>${testResult.failed}</strong></td></tr>
        <tr><td>Skipped</td><td>${testResult.skipped}</td></tr>
        <tr><td>Rounds</td><td>${testResult.rounds}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds entropy result section HTML.
 */
function buildEntropySection(entropyResult) {
  if (!entropyResult) return '';
  const icon = entropyResult.violations === 0 ? '✅' : '⚠️';
  return `
    <div class="card">
      <h3>${icon} Entropy GC</h3>
      <table>
        <tr><td>Violations</td><td><strong>${entropyResult.violations}</strong></td></tr>
        <tr><td>Files Scanned</td><td>${entropyResult.filesScanned}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds CI result section HTML.
 */
function buildCISection(ciResult) {
  if (!ciResult) return '';
  const icon = ciResult.status === 'success' ? '✅' : '❌';
  return `
    <div class="card">
      <h3>${icon} CI Pipeline [${esc(ciResult.provider)}]</h3>
      <table>
        <tr><td>Status</td><td><strong>${esc(ciResult.status)}</strong></td></tr>
        <tr><td>Duration</td><td>${dur(ciResult.durationMs)}</td></tr>
        <tr><td>Steps</td><td>${(ciResult.steps || []).length}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds code graph section HTML.
 */
function buildGraphSection(codeGraphResult) {
  if (!codeGraphResult) return '';
  return `
    <div class="card">
      <h3>📊 Code Graph</h3>
      <table>
        <tr><td>Symbols</td><td><strong>${codeGraphResult.symbolCount}</strong></td></tr>
        <tr><td>Call Edges</td><td>${codeGraphResult.edgeCount}</td></tr>
        <tr><td>Files</td><td>${codeGraphResult.fileCount}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds complexity section HTML.
 */
function buildComplexitySection(complexity) {
  if (!complexity) return '';
  return `
    <div class="card">
      <h3>🎯 Task Complexity</h3>
      <table>
        <tr><td>Level</td><td><strong>${esc(complexity.level)}</strong></td></tr>
        <tr><td>Score</td><td>${complexity.score}</td></tr>
        <tr><td>Signals</td><td>${(complexity.signals || []).length}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds tool search section HTML.
 */
function buildToolSearchSection(toolSearchStats) {
  if (!toolSearchStats) return '';
  const skipRatio = toolSearchStats.totalPlugins > 0
    ? ((toolSearchStats.skippedByKeyword / toolSearchStats.totalPlugins) * 100).toFixed(0)
    : 0;
  return `
    <div class="card">
      <h3>🔍 Tool Search</h3>
      <table>
        <tr><td>Plugins Skipped</td><td><strong>${toolSearchStats.skippedByKeyword}</strong> / ${toolSearchStats.totalPlugins}</td></tr>
        <tr><td>Savings</td><td>${skipRatio}%</td></tr>
      </table>
    </div>`;
}

/**
 * Builds tool result filter section HTML.
 */
function buildToolResultFilterSection(toolResultFilterStats) {
  if (!toolResultFilterStats) return '';
  return `
    <div class="card">
      <h3>✂️ ToolResultFilter</h3>
      <table>
        <tr><td>Chars Saved</td><td><strong>${(toolResultFilterStats.totalSaved || 0).toLocaleString()}</strong></td></tr>
        <tr><td>Blocks Filtered</td><td>${toolResultFilterStats.filteredBlocks || 0}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds quality gates section HTML.
 */
function buildGatingSection(reflectionGating) {
  if (!reflectionGating) return '';
  const icon = reflectionGating.passed ? '✅' : '❌';
  const status = reflectionGating.passed
    ? 'ALL PASSED'
    : `${reflectionGating.failedGates.length} of ${reflectionGating.gateCount} FAILED [${reflectionGating.failedGates.join(', ')}]`;
  return `
    <div class="card">
      <h3>${icon} Quality Gates</h3>
      <table>
        <tr><td>Status</td><td><strong>${esc(status)}</strong></td></tr>
        <tr><td>Total Gates</td><td>${reflectionGating.gateCount}</td></tr>
      </table>
    </div>`;
}

/**
 * Builds trend history section HTML.
 */
function buildTrendSection(history) {
  if (!history || history.length < 2) return '';

  const recent = history.slice(-10);
  const rows = recent.map((h, i) => {
    const statusIcon = h.errors?.count === 0 ? '✅' : '⚠️';
    return `<tr>
      <td>${i + 1}</td>
      <td>${new Date(h.startedAt).toLocaleDateString()}</td>
      <td>${dur(h.totalDurationMs)}</td>
      <td>~${(h.llm?.totalTokensEst || 0).toLocaleString()}</td>
      <td class="${h.errors?.count > 0 ? 'status-error' : 'status-ok'}">${h.errors?.count || 0}</td>
      <td>${statusIcon}</td>
    </tr>`;
  }).join('\n');

  return `
    <h2>📈 Session History (last ${recent.length})</h2>
    <div class="card">
      <table>
        <thead><tr><th>#</th><th>Date</th><th>Duration</th><th>Tokens</th><th>Errors</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ─── Main HTML Builder ───────────────────────────────────────────────────────

/**
 * Builds the complete HTML report.
 *
 * @param {object} m - Metrics object from Observability.flush()
 * @param {object[]} history - Historical session data
 * @returns {string} Complete HTML document
 */
function buildHTMLReport(m, history = []) {
  const tokenDisplay = m.llm.totalTokensActual
    ? `${m.llm.totalTokensActual.toLocaleString()} (actual)`
    : `~${m.llm.totalTokensEst.toLocaleString()}`;

  const stageRows = buildStageRows(m.stages, m.totalDurationMs);
  const llmRoleRows = buildLLMRoleRows(m.llm.callsByRole, m.llm.tokensByRole);
  const errorRows = buildErrorRows(m.errors.details);

  const testSection = buildTestSection(m.testResult);
  const entropySection = buildEntropySection(m.entropyResult);
  const ciSection = buildCISection(m.ciResult);
  const graphSection = buildGraphSection(m.codeGraphResult);
  const complexitySection = buildComplexitySection(m.complexity);
  const toolSearchSection = buildToolSearchSection(m.toolSearchStats);
  const toolResultFilterSection = buildToolResultFilterSection(m.toolResultFilterStats);
  const gatingSection = buildGatingSection(m.reflectionGating);
  const trendSection = buildTrendSection(history);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Session Report – ${esc(m.projectId)}</title>
  <style>${CSS_STYLES}</style>
</head>
<body>

<div class="header">
  <h1>📊 Session Report</h1>
  <div class="header-meta">
    <strong>${esc(m.sessionId)}</strong> &nbsp;|&nbsp;
    ${esc(m.startedAt)} → ${esc(m.finishedAt)}
  </div>
</div>

<div class="overview">
  <div class="stat-card">
    <div class="value">${dur(m.totalDurationMs)}</div>
    <div class="label">Duration</div>
  </div>
  <div class="stat-card">
    <div class="value">${m.llm.totalCalls}</div>
    <div class="label">LLM Calls</div>
  </div>
  <div class="stat-card">
    <div class="value">${tokenDisplay}</div>
    <div class="label">Tokens</div>
  </div>
  <div class="stat-card">
    <div class="value" style="color: ${m.errors.count > 0 ? 'var(--red)' : 'var(--green)'}">${m.errors.count}</div>
    <div class="label">Errors</div>
  </div>
  <div class="stat-card">
    <div class="value">${m.stages.length}</div>
    <div class="label">Stages</div>
  </div>
</div>

<h2>🔄 Stage Timeline</h2>
<div class="card">
  <table>
    <thead><tr><th>Stage</th><th>Status</th><th>Duration</th><th>Timeline</th></tr></thead>
    <tbody>${stageRows}</tbody>
  </table>
</div>

<h2>🤖 LLM Usage by Role</h2>
<div class="card">
  <table>
    <thead><tr><th>Role</th><th>Calls</th><th>Tokens</th><th>Distribution</th></tr></thead>
    <tbody>${llmRoleRows}</tbody>
  </table>
</div>

${m.errors.count > 0 ? `
<h2>❌ Errors (${m.errors.count})</h2>
<div class="card">
  <table>
    <thead><tr><th>Stage</th><th>Message</th><th>Time</th></tr></thead>
    <tbody>${errorRows}</tbody>
  </table>
</div>` : ''}

<h2>📋 Details</h2>
<div class="grid-2">
  ${testSection}
  ${entropySection}
  ${ciSection}
  ${graphSection}
  ${complexitySection}
  ${toolSearchSection}
  ${toolResultFilterSection}
  ${gatingSection}
</div>

${trendSection}

<div class="footer">
  Generated by WorkFlowAgent Observability &nbsp;|&nbsp; ${new Date().toISOString()}
</div>

</body>
</html>`;
}

// ─── Report Generator Class ──────────────────────────────────────────────────

/**
 * HTML Report Generator class.
 * Provides a clean interface for generating session reports.
 */
class HTMLReportGenerator {
  /**
   * @param {string} outputDir - Output directory for reports
   */
  constructor(outputDir) {
    this._outputDir = outputDir;
  }

  /**
   * Generates an HTML report from metrics.
   *
   * @param {object} options
   * @param {object} [options.metrics] - Pre-computed metrics
   * @param {object[]} [options.history] - Historical session data
   * @param {string} [options.outputPath] - Override output path
   * @returns {string} Absolute path to generated HTML file
   */
  generate(options = {}) {
    const { metrics, history = [], outputPath } = options;
    if (!metrics) throw new Error('metrics is required');

    const html = buildHTMLReport(metrics, history);
    const finalPath = outputPath || path.join(this._outputDir, 'session-report.html');

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      fs.writeFileSync(finalPath, html, 'utf-8');
      console.log(`[HTMLReport] 📊 Report generated: ${finalPath}`);
    } catch (err) {
      console.warn(`[HTMLReport] Failed to write report: ${err.message}`);
    }

    return finalPath;
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Main builder
  buildHTMLReport,

  // Section builders (for testing/customization)
  buildStageRows,
  buildLLMRoleRows,
  buildErrorRows,
  buildTestSection,
  buildEntropySection,
  buildCISection,
  buildGraphSection,
  buildComplexitySection,
  buildToolSearchSection,
  buildToolResultFilterSection,
  buildGatingSection,
  buildTrendSection,

  // Helpers
  esc,
  dur,
  pct,

  // CSS
  CSS_STYLES,

  // Class
  HTMLReportGenerator,
};
