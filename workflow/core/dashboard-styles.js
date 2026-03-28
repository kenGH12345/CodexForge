/**
 * Dashboard Styles & Scripts – CSS and JavaScript for the dashboard HTML
 *
 * Extracted from dashboard-integration.js (ADR-33 Phase 4) to isolate the
 * large CSS/JS string constants from the dashboard logic.
 *
 * @module dashboard-styles
 */

'use strict';

/**
 * Returns the full CSS stylesheet for the dashboard.
 * @returns {string}
 */
function getDashboardCSS() {
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

.header-meta { color: var(--muted); font-size: 14px; }
.header-stats { display: flex; gap: 24px; margin-top: 16px; flex-wrap: wrap; }
.header-stat { text-align: center; }
.header-stat-value { display: block; font-size: 20px; font-weight: 600; }
.header-stat-label { font-size: 12px; color: var(--muted); }
.header-time { margin-top: 16px; font-size: 12px; color: var(--muted); }

/* Alerts */
.alerts-section { margin-bottom: 24px; }
h2 { font-size: 20px; margin-bottom: 16px; color: var(--accent-light); }
.alerts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.alert-card { background: var(--card-bg); border-left: 4px solid; border-radius: 8px; padding: 16px; }
.alert-critical { border-color: var(--danger); }
.alert-warning { border-color: var(--warning); }
.alert-info { border-color: var(--accent); }
.alert-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.alert-category { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
.alert-message { font-weight: 500; margin-bottom: 8px; }
.alert-suggestion { font-size: 13px; color: var(--muted); }

/* Metrics */
.metrics-section { margin-bottom: 24px; }
.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 24px; }
.metric-card { background: var(--card-bg); border-radius: 12px; padding: 20px; text-align: center; border: 1px solid var(--border); transition: transform 0.2s, box-shadow 0.2s; }
.metric-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
.metric-warning { border-color: var(--warning); background: linear-gradient(135deg, var(--card-bg) 0%, rgba(245,158,11,0.1) 100%); }
.metric-icon { font-size: 24px; margin-bottom: 8px; }
.metric-value { font-size: 24px; font-weight: 600; margin-bottom: 4px; }
.metric-label { font-size: 12px; color: var(--muted); }

/* Role Breakdown */
.role-breakdown { background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }
.role-breakdown h3 { font-size: 14px; color: var(--muted); margin-bottom: 16px; }
.role-row { margin-bottom: 12px; }
.role-name { font-weight: 500; margin-bottom: 4px; }
.role-stats { display: flex; gap: 16px; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.role-bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
.role-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-light)); border-radius: 3px; transition: width 0.5s ease; }

/* Timeline */
.timeline-container { background: var(--card-bg); border-radius: 12px; padding: 20px; border: 1px solid var(--border); }
.timeline-item { margin-bottom: 16px; }
.timeline-bar-container { background: var(--border); border-radius: 4px; height: 24px; overflow: hidden; margin-bottom: 8px; }
.timeline-bar { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
.status-ok { background: var(--success); }
.status-error { background: var(--danger); }
.timeline-info { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.timeline-name { font-weight: 500; min-width: 100px; }
.timeline-duration { color: var(--muted); }
.timeline-percent { margin-left: auto; font-weight: 600; color: var(--accent-light); }

/* Bottlenecks */
.bottleneck-section { margin-bottom: 24px; }
.bottleneck-summary { display: flex; gap: 24px; margin-bottom: 16px; color: var(--muted); font-size: 14px; }
.bottleneck-list { background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }
.bottleneck-item { padding: 12px; border-bottom: 1px solid var(--border); }
.bottleneck-item:last-child { border-bottom: none; }
.bottleneck-stage { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
.bottleneck-metrics { display: flex; gap: 16px; margin-bottom: 8px; }
.bottleneck-ratio { font-weight: 600; color: var(--accent-light); }
.ratio-high { color: var(--danger); }
.bottleneck-desc { font-size: 14px; color: var(--muted); margin-bottom: 4px; }
.bottleneck-recommendation { font-size: 13px; color: var(--success); }
.no-bottlenecks { text-align: center; padding: 24px; color: var(--success); }

/* Feedback */
.feedback-section { margin-bottom: 24px; }
.feedback-summary { display: flex; gap: 32px; margin-bottom: 16px; background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }
.feedback-avg, .feedback-count { text-align: center; }
.feedback-avg-value, .feedback-count-value { display: block; font-size: 28px; font-weight: 600; }
.feedback-avg-label, .feedback-count-label { font-size: 12px; color: var(--muted); }
.feedback-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.feedback-card { background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--border); }
.feedback-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.feedback-agent { font-weight: 600; }
.feedback-score { font-size: 20px; font-weight: 600; padding: 4px 12px; border-radius: 16px; }
.score-good { background: rgba(16, 185, 129, 0.2); color: var(--success); }
.score-fair { background: rgba(245, 158, 11, 0.2); color: var(--warning); }
.score-poor { background: rgba(239, 68, 68, 0.2); color: var(--danger); }
.feedback-trend { display: flex; justify-content: space-between; font-size: 13px; color: var(--muted); margin-bottom: 12px; }
.feedback-issues { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.issue-tag { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: var(--border); color: var(--muted); }
.feedback-recommendations { font-size: 13px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 12px; }
.recommendation { margin-bottom: 4px; }

/* Trends */
.trends-section { margin-bottom: 24px; }
.trends-summary { display: flex; gap: 24px; margin-bottom: 16px; }
.trend-stat { background: var(--card-bg); border-radius: 8px; padding: 12px 20px; border: 1px solid var(--border); }
.trend-label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.trend-value { font-size: 16px; font-weight: 500; }
.trends-table-container { background: var(--card-bg); border-radius: 12px; padding: 16px; border: 1px solid var(--border); overflow-x: auto; }
.trends-table { width: 100%; border-collapse: collapse; }
.trends-table th { text-align: left; padding: 8px 12px; font-size: 12px; color: var(--muted); border-bottom: 2px solid var(--border); }
.trends-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }

/* Footer */
.dashboard-footer { text-align: center; padding: 24px; color: var(--muted); font-size: 13px; }
.footer-links { margin-top: 12px; display: flex; justify-content: center; gap: 16px; }
.footer-links a { color: var(--accent); text-decoration: none; }
.footer-links a:hover { text-decoration: underline; }

/* Responsive */
@media (max-width: 768px) {
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
  .header-stats { flex-direction: column; gap: 12px; }
}
`;
}

/**
 * Returns the JavaScript for dashboard interactivity.
 * @returns {string}
 */
function getDashboardJavaScript() {
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

module.exports = {
  getDashboardCSS,
  getDashboardJavaScript,
};
