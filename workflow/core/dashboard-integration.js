/**
 * Dashboard Integration – Visual analytics and feedback reporting
 *
 * Provides a comprehensive, interactive dashboard that unifies:
 *   - Session metrics from Observability
 *   - Agent feedback from AgentFeedbackSystem
 *   - Bottleneck analysis for optimization insights
 *   - Cross-session trend visualization
 *
 * Architecture:
 *   - Reads from output/run-metrics.json and output/agent-feedback-report.json
 *   - Generates a self-contained HTML file with interactive visualizations
 *   - Supports real-time alerts for bottlenecks and quality regressions
 *
 * Design: zero-dependency (inline CSS/JS), backward-compatible.
 * Integration: Called by Orchestrator._finalizeWorkflow() after feedback flush.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Observability = require('./observability');
const { AgentFeedbackSystem } = require('./agent-feedback-system');
const { getDashboardCSS, getDashboardJavaScript } = require('./dashboard-styles');

// ─── Dashboard Manager Class ────────────────────────────────────────────────

class DashboardIntegration {
  /**
   * @param {object} [opts]
   * @param {string} [opts.outputDir='output'] - Directory for metrics and reports
   * @param {object} [opts.orchestrator] - Orchestrator reference for runtime access
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || 'output';
    this._orchestrator = opts.orchestrator || null;
    
    // Alert configuration
    this._alertThresholds = {
      bottleneckRatio: 0.4,      // Stage taking >40% of total time
      errorRateSpike: 0.5,       // Error rate increase >50% vs baseline
      feedbackScoreDrop: 0.2,    // Agent score drop >20%
      tokenSpike: 1.5,           // Token usage >1.5x baseline
    };
  }

  /**
   * Generates the unified dashboard report.
   * Should be called after workflow completion.
   *
   * @param {object} [opts]
   * @param {string} [opts.outputPath] - Override output path
   * @param {boolean} [opts.includeFeedback=true] - Include feedback data
   * @param {boolean} [opts.includeAnalysis=true] - Include bottleneck analysis
   * @returns {string} Path to generated HTML file
   */
  generateDashboard(opts = {}) {
    const outputPath = opts.outputPath || path.join(this._outputDir, 'dashboard.html');
    const includeFeedback = opts.includeFeedback !== false;
    const includeAnalysis = opts.includeAnalysis !== false;

    // Load current session metrics
    const metrics = this._loadCurrentMetrics();
    
    // Load feedback report
    const feedbackData = includeFeedback ? this._loadFeedbackData() : null;
    
    // Load execution analysis (bottlenecks, critical path)
    const executionAnalysis = includeAnalysis ? this._loadExecutionAnalysis() : null;
    
    // Load cross-session history
    const history = Observability.loadHistory(this._outputDir);
    
    // Generate alerts based on current session
    const alerts = this._generateAlerts(metrics, feedbackData, executionAnalysis, history);
    
    // Build HTML
    const html = this._buildDashboardHTML({
      metrics,
      feedbackData,
      executionAnalysis,
      history,
      alerts,
      generatedAt: new Date().toISOString(),
    });

    // Write to file
    this._writeFile(outputPath, html);
    console.log(`[DashboardIntegration] 📊 Dashboard generated: ${outputPath}`);

    return outputPath;
  }

  // ─── Data Loading ───────────────────────────────────────────────────────────

  _loadCurrentMetrics() {
    const metricsPath = path.join(this._outputDir, 'run-metrics.json');
    if (!fs.existsSync(metricsPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  _loadFeedbackData() {
    const feedbackPath = path.join(this._outputDir, 'agent-feedback-report.json');
    if (!fs.existsSync(feedbackPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  _loadExecutionAnalysis() {
    const analysisPath = path.join(this._outputDir, 'execution-analysis.json');
    if (!fs.existsSync(analysisPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  // ─── Alert Generation ───────────────────────────────────────────────────────

  _generateAlerts(metrics, feedbackData, executionAnalysis, history) {
    const alerts = [];
    
    if (!metrics) return alerts;

    // Bottleneck alerts
    if (executionAnalysis?.criticalPath?.bottlenecks?.length > 0) {
      for (const bottleneck of executionAnalysis.criticalPath.bottlenecks) {
        if (bottleneck.ratioToTotal >= this._alertThresholds.bottleneckRatio) {
          alerts.push({
            severity: 'warning',
            category: 'bottleneck',
            message: `Stage "${bottleneck.stage}" is a bottleneck (${(bottleneck.ratioToTotal * 100).toFixed(0)}% of total time)`,
            suggestion: 'Consider parallelization or tier upgrade for this stage',
          });
        }
      }
    }

    // Error rate spike detection
    if (history.length >= 3) {
      const recent = history.slice(0, 3);
      const recentErrors = recent.reduce((sum, h) => sum + (h.errorCount || 0), 0) / recent.length;
      const allErrors = history.reduce((sum, h) => sum + (h.errorCount || 0), 0) / history.length;
      
      if (allErrors > 0 && recentErrors / allErrors > this._alertThresholds.errorRateSpike) {
        alerts.push({
          severity: 'critical',
          category: 'quality',
          message: `Error rate increased ${(recentErrors / allErrors).toFixed(1)}x vs baseline`,
          suggestion: 'Review recent changes and consider prompt adjustments',
        });
      }
    }

    // Feedback score degradation
    if (feedbackData?.reports) {
      for (const [agent, report] of Object.entries(feedbackData.reports)) {
        if (report.overallScore < 0.5) {
          alerts.push({
            severity: 'critical',
            category: 'agent_quality',
            message: `${agent} has critically low quality score (${(report.overallScore * 100).toFixed(0)}%)`,
            suggestion: 'Review agent prompt and consider redesign',
          });
        }
        if (report.trend === 'degrading') {
          alerts.push({
            severity: 'warning',
            category: 'agent_quality',
            message: `${agent} quality is degrading`,
            suggestion: 'Investigate recent changes affecting output quality',
          });
        }
      }
    }

    // Token usage spike
    if (history.length >= 3 && metrics.llm?.totalTokensEst) {
      const recentTokens = history.slice(0, 3).reduce((sum, h) => sum + (h.tokensEst || 0), 0) / 3;
      if (recentTokens > 0 && metrics.llm.totalTokensEst / recentTokens > this._alertThresholds.tokenSpike) {
        alerts.push({
          severity: 'warning',
          category: 'cost',
          message: `Token usage ${(metrics.llm.totalTokensEst / recentTokens).toFixed(1)}x above recent average`,
          suggestion: 'Consider context optimization or tier selection',
        });
      }
    }

    return alerts;
  }

  // ─── HTML Generation ────────────────────────────────────────────────────────

  _buildDashboardHTML({ metrics, feedbackData, executionAnalysis, history, alerts, generatedAt }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WorkFlowAgent Dashboard – ${metrics?.projectId || 'Session'}</title>
  <style>${this._getCSS()}</style>
</head>
<body>

<div class="dashboard-container">
  ${this._buildHeaderSection(metrics, generatedAt)}
  ${alerts.length > 0 ? this._buildAlertsSection(alerts) : ''}
  ${this._buildMetricsSection(metrics)}
  ${this._buildStageTimelineSection(metrics)}
  ${executionAnalysis ? this._buildBottleneckSection(executionAnalysis) : ''}
  ${feedbackData ? this._buildFeedbackSection(feedbackData) : ''}
  ${history.length > 0 ? this._buildTrendsSection(history) : ''}
  ${this._buildFooterSection()}
</div>

<script>${this._getJavaScript()}</script>
</body>
</html>`;
  }

  // ─── UI Section Builders ────────────────────────────────────────────────────

  _buildHeaderSection(metrics, generatedAt) {
    const sessionId = metrics?.sessionId || 'N/A';
    const projectId = metrics?.projectId || 'N/A';
    const duration = metrics?.totalDurationMs ? (metrics.totalDurationMs / 1000).toFixed(1) + 's' : 'N/A';
    const statusIcon = metrics?.errors?.count > 0 ? '⚠️' : '✅';
    
    return `
    <header class="dashboard-header">
      <div class="header-title">
        <h1>📊 WorkFlowAgent Dashboard</h1>
        <span class="header-meta">${statusIcon} ${sessionId}</span>
      </div>
      <div class="header-stats">
        <div class="header-stat">
          <span class="header-stat-value">${projectId}</span>
          <span class="header-stat-label">Project</span>
        </div>
        <div class="header-stat">
          <span class="header-stat-value">${duration}</span>
          <span class="header-stat-label">Duration</span>
        </div>
        <div class="header-stat">
          <span class="header-stat-value">${metrics?.llm?.totalCalls || 0}</span>
          <span class="header-stat-label">LLM Calls</span>
        </div>
      </div>
      <div class="header-time">Generated: ${new Date(generatedAt).toLocaleString()}</div>
    </header>`;
  }

  _buildAlertsSection(alerts) {
    const alertCards = alerts.map(alert => {
      const severityClass = `alert-${alert.severity}`;
      const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '🟠' : '🔵';
      return `
        <div class="alert-card ${severityClass}">
          <div class="alert-header">
            <span class="alert-icon">${icon}</span>
            <span class="alert-category">${alert.category}</span>
          </div>
          <div class="alert-message">${alert.message}</div>
          <div class="alert-suggestion">💡 ${alert.suggestion}</div>
        </div>`;
    }).join('');

    return `
    <section class="alerts-section">
      <h2>⚠️ Active Alerts</h2>
      <div class="alerts-grid">
        ${alertCards}
      </div>
    </section>`;
  }

  _buildMetricsSection(metrics) {
    const m = metrics || {};
    const llm = m.llm || {};
    const tokenDisplay = llm.totalTokensActual 
      ? `${llm.totalTokensActual.toLocaleString()} (actual)`
      : `~${(llm.totalTokensEst || 0).toLocaleString()} (est)`;
    const errorRate = m.llm?.totalCalls > 0 && m.errors?.count > 0
      ? ((m.errors.count / m.llm.totalCalls) * 100).toFixed(1) + '%'
      : '0%';

    return `
    <section class="metrics-section">
      <h2>📈 Session Metrics</h2>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-icon">⏱️</div>
          <div class="metric-value">${(m.totalDurationMs / 1000).toFixed(1)}s</div>
          <div class="metric-label">Total Duration</div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">🤖</div>
          <div class="metric-value">${llm.totalCalls || 0}</div>
          <div class="metric-label">LLM Calls</div>
        </div>
        <div class="metric-card">
          <div class="metric-icon">📝</div>
          <div class="metric-value">${tokenDisplay}</div>
          <div class="metric-label">Tokens Used</div>
        </div>
        <div class="metric-card ${m.errors?.count > 0 ? 'metric-warning' : ''}">
          <div class="metric-icon">${m.errors?.count > 0 ? '⚠️' : '✅'}</div>
          <div class="metric-value">${m.errors?.count || 0}</div>
          <div class="metric-label">Errors (${errorRate})</div>
        </div>
      </div>
      
      ${llm.callsByRole ? this._buildRoleBreakdown(llm.callsByRole, llm.tokensByRole) : ''}
    </section>`;
  }

  _buildRoleBreakdown(callsByRole, tokensByRole) {
    const roles = Object.entries(callsByRole).sort((a, b) => b[1] - a[1]);
    const maxTokens = Math.max(1, ...Object.values(tokensByRole || {}).map(Number));
    
    const roleRows = roles.map(([role, calls]) => {
      const tokens = tokensByRole?.[role] || 0;
      const percent = maxTokens > 0 ? (tokens / maxTokens) * 100 : 0;
      return `
        <div class="role-row">
          <div class="role-name">${role}</div>
          <div class="role-stats">
            <span>${calls} calls</span>
            <span>~${tokens.toLocaleString()} tokens</span>
          </div>
          <div class="role-bar">
            <div class="role-bar-fill" style="width: ${percent}%"></div>
          </div>
        </div>`;
    }).join('');

    return `
    <div class="role-breakdown">
      <h3>Usage by Role</h3>
      ${roleRows}
    </div>`;
  }

  _buildStageTimelineSection(metrics) {
    const stages = metrics?.stages || [];
    const totalDuration = metrics?.totalDurationMs || 1;
    
    const timelineItems = stages.map(stage => {
      const statusClass = stage.status === 'ok' ? 'status-ok' : 'status-error';
      const icon = stage.status === 'ok' ? '✅' : '❌';
      const width = (stage.durationMs / totalDuration) * 100;
      const duration = (stage.durationMs / 1000).toFixed(1) + 's';
      
      return `
        <div class="timeline-item">
          <div class="timeline-bar-container">
            <div class="timeline-bar ${statusClass}" style="width: ${Math.max(width, 2)}%"></div>
          </div>
          <div class="timeline-info">
            <span class="timeline-icon">${icon}</span>
            <span class="timeline-name">${stage.name}</span>
            <span class="timeline-duration">${duration}</span>
            <span class="timeline-percent">${width.toFixed(0)}%</span>
          </div>
        </div>`;
    }).join('');

    return `
    <section class="stage-section">
      <h2>🔄 Stage Timeline</h2>
      <div class="timeline-container">
        ${timelineItems}
      </div>
    </section>`;
  }

  _buildBottleneckSection(executionAnalysis) {
    const cp = executionAnalysis.criticalPath;
    const bottlenecks = cp?.bottlenecks || [];
    
    const bottleneckItems = bottlenecks.length > 0 
      ? bottlenecks.map(b => `
          <div class="bottleneck-item">
            <div class="bottleneck-stage">${b.stage}</div>
            <div class="bottleneck-metrics">
              <span>${(b.durationMs / 1000).toFixed(1)}s</span>
              <span class="bottleneck-ratio ${b.ratioToTotal > 0.4 ? 'ratio-high' : ''}">${(b.ratioToTotal * 100).toFixed(0)}%</span>
            </div>
            <div class="bottleneck-desc">${b.description || 'Critical path bottleneck'}</div>
            ${b.recommendation ? `<div class="bottleneck-recommendation">💡 ${b.recommendation}</div>` : ''}
          </div>`).join('')
      : '<div class="no-bottlenecks">✅ No significant bottlenecks detected</div>';

    return `
    <section class="bottleneck-section">
      <h2>🎯 Bottleneck Analysis</h2>
      <div class="bottleneck-summary">
        <span>Total Duration: ${((cp?.totalDurationMs || 0) / 1000).toFixed(1)}s</span>
        <span>Critical Path: ${(cp?.stages || []).join(' → ')}</span>
      </div>
      <div class="bottleneck-list">
        ${bottleneckItems}
      </div>
    </section>`;
  }

  _buildFeedbackSection(feedbackData) {
    const reports = feedbackData?.reports || {};
    const agents = Object.keys(reports);
    
    if (agents.length === 0) {
      return '';
    }

    const feedbackCards = agents.map(agent => {
      const report = reports[agent];
      const score = (report.overallScore * 100).toFixed(0);
      const scoreClass = report.overallScore >= 0.7 ? 'score-good' : report.overallScore >= 0.5 ? 'score-fair' : 'score-poor';
      const trendIcon = report.trend === 'improving' ? '📈' : report.trend === 'degrading' ? '📉' : '➡️';
      
      const topIssues = (report.topIssues || []).slice(0, 3).map(([issue, count]) => 
        `<span class="issue-tag">${issue}: ${count}x</span>`
      ).join('');

      return `
        <div class="feedback-card">
          <div class="feedback-header">
            <span class="feedback-agent">${agent}</span>
            <span class="feedback-score ${scoreClass}">${score}%</span>
          </div>
          <div class="feedback-trend">
            <span>${trendIcon} ${report.trend}</span>
            <span>${report.feedbackCount} feedback items</span>
          </div>
          ${topIssues ? `<div class="feedback-issues">${topIssues}</div>` : ''}
          ${report.recommendations?.length > 0 ? `
            <div class="feedback-recommendations">
              ${report.recommendations.map(r => `<div class="recommendation">• ${r}</div>`).join('')}
            </div>` : ''}
        </div>`;
    }).join('');

    const avgScore = agents.length > 0
      ? (agents.reduce((sum, a) => sum + reports[a].overallScore, 0) / agents.length * 100).toFixed(0)
      : 0;

    return `
    <section class="feedback-section">
      <h2>💬 Agent Feedback</h2>
      <div class="feedback-summary">
        <div class="feedback-avg">
          <span class="feedback-avg-value">${avgScore}%</span>
          <span class="feedback-avg-label">Avg Quality Score</span>
        </div>
        <div class="feedback-count">
          <span class="feedback-count-value">${feedbackData.summary?.totalFeedback || 0}</span>
          <span class="feedback-count-label">Total Feedback</span>
        </div>
      </div>
      <div class="feedback-grid">
        ${feedbackCards}
      </div>
    </section>`;
  }

  _buildTrendsSection(history) {
    const recent = history.slice(0, 10);
    const trends = Observability.computeTrends(history) || {};
    
    const trendRows = recent.map((h, i) => {
      const date = new Date(h.startedAt).toLocaleDateString();
      const statusIcon = h.errorCount > 0 ? '⚠️' : '✅';
      return `
        <tr>
          <td>${recent.length - i}</td>
          <td>${date}</td>
          <td>${(h.totalDurationMs / 1000).toFixed(1)}s</td>
          <td>~${(h.tokensEst || 0).toLocaleString()}</td>
          <td>${h.errorCount || 0}</td>
          <td>${statusIcon}</td>
        </tr>`;
    }).join('');

    return `
    <section class="trends-section">
      <h2>📊 Cross-Session Trends (${history.length} sessions)</h2>
      <div class="trends-summary">
        ${trends.durationTrend ? `
          <div class="trend-stat">
            <span class="trend-label">Duration</span>
            <span class="trend-value">${this._formatTrend(trends.durationTrend)}</span>
          </div>` : ''}
        ${trends.tokenTrend ? `
          <div class="trend-stat">
            <span class="trend-label">Tokens</span>
            <span class="trend-value">${this._formatTrend(trends.tokenTrend)}</span>
          </div>` : ''}
        ${trends.errorTrend ? `
          <div class="trend-stat">
            <span class="trend-label">Errors</span>
            <span class="trend-value">${this._formatTrend(trends.errorTrend)}</span>
          </div>` : ''}
      </div>
      <div class="trends-table-container">
        <table class="trends-table">
          <thead>
            <tr><th>#</th><th>Date</th><th>Duration</th><th>Tokens</th><th>Errors</th><th>Status</th></tr>
          </thead>
          <tbody>
            ${trendRows}
          </tbody>
        </table>
      </div>
    </section>`;
  }

  _buildFooterSection() {
    return `
    <footer class="dashboard-footer">
      <p>Generated by WorkFlowAgent Dashboard Integration</p>
      <p class="footer-links">
        <a href="run-metrics.json">📄 Metrics JSON</a>
        <a href="agent-feedback-report.json">💬 Feedback JSON</a>
        <a href="execution-analysis.json">🎯 Analysis JSON</a>
      </p>
    </footer>`;
  }

  // ─── Helper Methods ─────────────────────────────────────────────────────────

  _formatTrend(trend) {
    const icons = { increasing: '📈', decreasing: '📉', stable: '➡️' };
    return `${icons[trend] || '➡️'} ${trend}`;
  }

  _writeFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  // ─── Styling (delegated to dashboard-styles.js, ADR-33 Phase 4) ──────────

  _getCSS() {
    return getDashboardCSS();
  }

  // ─── JavaScript for Interactivity (delegated to dashboard-styles.js, ADR-33 Phase 4) ──

  _getJavaScript() {
    return getDashboardJavaScript();
  }
}

// --- Convenience API ---

/**
 * Generates a dashboard for the current session.
 * Convenience function for direct usage.
 *
 * @param {object} [opts]
 * @param {string} [opts.outputDir]
 * @param {string} [opts.outputPath]
 * @returns {string} Path to generated HTML file
 */
function generateDashboard(opts = {}) {
  const dashboard = new DashboardIntegration(opts);
  return dashboard.generateDashboard(opts);
}

module.exports = {
  DashboardIntegration,
  generateDashboard,
};
