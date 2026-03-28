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

  // ─── Styling ────────────────────────────────────────────────────────────────

  _getCSS() {
    return `
:root {
  --bg: #0f172a;
  --card-bg: #1e293b;
  --text: #f8fafc;
  --muted: #94a3b8;
  --accent: #3b82f6;
  --accent-light: #60a5fa;
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;
  --border: #334155;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

.dashboard-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

/* Header */
.dashboard-header {
  background: linear-gradient(135deg, var(--card-bg) 0%, #2d3a4f 100%);
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 24px;
  border: 1px solid var(--border);
}

.header-title h1 {
  font-size: 28px;
  margin-bottom: 8px;
  background: linear-gradient(90deg, var(--accent-light), var(--accent));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.header-meta {
  color: var(--muted);
  font-size: 14px;
}

.header-stats {
  display: flex;
  gap: 24px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.header-stat {
  text-align: center;
}

.header-stat-value {
  display: block;
  font-size: 20px;
  font-weight: 600;
}

.header-stat-label {
  font-size: 12px;
  color: var(--muted);
}

.header-time {
  margin-top: 16px;
  font-size: 12px;
  color: var(--muted);
}

/* Alerts */
.alerts-section {
  margin-bottom: 24px;
}

h2 {
  font-size: 20px;
  margin-bottom: 16px;
  color: var(--accent-light);
}

.alerts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.alert-card {
  background: var(--card-bg);
  border-left: 4px solid;
  border-radius: 8px;
  padding: 16px;
}

.alert-critical { border-color: var(--danger); }
.alert-warning { border-color: var(--warning); }
.alert-info { border-color: var(--accent); }

.alert-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.alert-category {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
}

.alert-message {
  font-weight: 500;
  margin-bottom: 8px;
}

.alert-suggestion {
  font-size: 13px;
  color: var(--muted);
}

/* Metrics */
.metrics-section {
  margin-bottom: 24px;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.metric-card {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 20px;
  text-align: center;
  border: 1px solid var(--border);
  transition: transform 0.2s, box-shadow 0.2s;
}

.metric-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}

.metric-warning {
  border-color: var(--warning);
  background: linear-gradient(135deg, var(--card-bg) 0%, rgba(245,158,11,0.1) 100%);
}

.metric-icon {
  font-size: 24px;
  margin-bottom: 8px;
}

.metric-value {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 4px;
}

.metric-label {
  font-size: 12px;
  color: var(--muted);
}

/* Role Breakdown */
.role-breakdown {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border);
}

.role-breakdown h3 {
  font-size: 14px;
  color: var(--muted);
  margin-bottom: 16px;
}

.role-row {
  margin-bottom: 12px;
}

.role-name {
  font-weight: 500;
  margin-bottom: 4px;
}

.role-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}

.role-bar {
  height: 6px;
  background: var(--border);
  border-radius: 3px;
  overflow: hidden;
}

.role-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-light));
  border-radius: 3px;
  transition: width 0.5s ease;
}

/* Timeline */
.timeline-container {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 20px;
  border: 1px solid var(--border);
}

.timeline-item {
  margin-bottom: 16px;
}

.timeline-bar-container {
  background: var(--border);
  border-radius: 4px;
  height: 24px;
  overflow: hidden;
  margin-bottom: 8px;
}

.timeline-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.5s ease;
}

.status-ok { background: var(--success); }
.status-error { background: var(--danger); }

.timeline-info {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
}

.timeline-name {
  font-weight: 500;
  min-width: 100px;
}

.timeline-duration {
  color: var(--muted);
}

.timeline-percent {
  margin-left: auto;
  font-weight: 600;
  color: var(--accent-light);
}

/* Bottlenecks */
.bottleneck-section {
  margin-bottom: 24px;
}

.bottleneck-summary {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
  color: var(--muted);
  font-size: 14px;
}

.bottleneck-list {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border);
}

.bottleneck-item {
  padding: 12px;
  border-bottom: 1px solid var(--border);
}

.bottleneck-item:last-child {
  border-bottom: none;
}

.bottleneck-stage {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 4px;
}

.bottleneck-metrics {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
}

.bottleneck-ratio {
  font-weight: 600;
  color: var(--accent-light);
}

.ratio-high {
  color: var(--danger);
}

.bottleneck-desc {
  font-size: 14px;
  color: var(--muted);
  margin-bottom: 4px;
}

.bottleneck-recommendation {
  font-size: 13px;
  color: var(--success);
}

.no-bottlenecks {
  text-align: center;
  padding: 24px;
  color: var(--success);
}

/* Feedback */
.feedback-section {
  margin-bottom: 24px;
}

.feedback-summary {
  display: flex;
  gap: 32px;
  margin-bottom: 16px;
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border);
}

.feedback-avg, .feedback-count {
  text-align: center;
}

.feedback-avg-value, .feedback-count-value {
  display: block;
  font-size: 28px;
  font-weight: 600;
}

.feedback-avg-label, .feedback-count-label {
  font-size: 12px;
  color: var(--muted);
}

.feedback-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}

.feedback-card {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border);
}

.feedback-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.feedback-agent {
  font-weight: 600;
}

.feedback-score {
  font-size: 20px;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 16px;
}

.score-good { background: rgba(16, 185, 129, 0.2); color: var(--success); }
.score-fair { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
.score-poor { background: rgba(239, 68, 68, 0.2); color: var(--danger); }

.feedback-trend {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 12px;
}

.feedback-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.issue-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--border);
  color: var(--muted);
}

.feedback-recommendations {
  font-size: 13px;
  color: var(--muted);
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.recommendation {
  margin-bottom: 4px;
}

/* Trends */
.trends-section {
  margin-bottom: 24px;
}

.trends-summary {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.trend-stat {
  background: var(--card-bg);
  border-radius: 8px;
  padding: 12px 20px;
  border: 1px solid var(--border);
}

.trend-label {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}

.trend-value {
  font-size: 16px;
  font-weight: 500;
}

.trends-table-container {
  background: var(--card-bg);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  overflow-x: auto;
}

.trends-table {
  width: 100%;
  border-collapse: collapse;
}

.trends-table th {
  text-align: left;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 2px solid var(--border);
}

.trends-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

/* Footer */
.dashboard-footer {
  text-align: center;
  padding: 24px;
  color: var(--muted);
  font-size: 13px;
}

.footer-links {
  margin-top: 12px;
  display: flex;
  justify-content: center;
  gap: 16px;
}

.footer-links a {
  color: var(--accent);
  text-decoration: none;
}

.footer-links a:hover {
  text-decoration: underline;
}

/* Responsive */
@media (max-width: 768px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .header-stats {
    flex-direction: column;
    gap: 12px;
  }
}
`;
  }

  // ─── JavaScript for Interactivity ───────────────────────────────────────────

  _getJavaScript() {
    return `
// Dashboard interactivity
(function() {
  // Auto-refresh configuration (if served via server)
  const AUTO_REFRESH_INTERVAL = 30000; // 30 seconds
  
  // Animate progress bars on load
  document.querySelectorAll('.timeline-bar, .role-bar-fill').forEach(bar => {
    const width = bar.style.width;
    bar.style.width = '0';
    setTimeout(() => {
      bar.style.width = width;
    }, 100);
  });
  
  // Collapsible sections
  document.querySelectorAll('h2').forEach(header => {
    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      const section = header.nextElementSibling;
      if (section) {
        section.style.display = section.style.display === 'none' ? 'block' : 'none';
      }
    });
  });
  
  // Export metrics
  window.exportMetrics = function(format) {
    if (format === 'json') {
      window.open('run-metrics.json', '_blank');
    } else if (format === 'csv') {
      alert('CSV export coming in future release');
    }
  };
})();
`;
  }
}

// ─── Convenience API ────────────────────────────────────────────────────────

/**
 * Generates a dashboard for the current session.
 * Convenience function for direct usage.
 *
 * @param {object} [opts]
 * @param {string} [opts.outputDir='output']
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
