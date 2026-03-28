/**
 * Deep Audit Report Generator
 *
 * Extracted from deep-audit-orchestrator.js for maintainability (ADR-41).
 * Generates Markdown and JSON reports from audit findings.
 *
 * @module workflow/core/deep-audit-report
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Report Generation ───────────────────────────────────────────────────────

/**
 * Generates a Markdown report from audit findings.
 *
 * @param {object} options
 * @param {Array<object>} options.findings - Array of audit findings
 * @param {object} options.stats - Stats object { total, critical, high, medium, low, info }
 * @param {number} options.startTime - Start timestamp (ms)
 * @param {object} options.AuditSeverity - Severity enum
 * @param {object} options.AuditCategory - Category enum
 * @returns {string} Markdown report
 */
function generateMarkdownReport({ findings, stats, startTime, AuditSeverity, AuditCategory }) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const byCategory = {};
  for (const f of findings) {
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category].push(f);
  }

  const lines = [
    `# Deep Audit Report`,
    ``,
    `> Generated: ${new Date().toISOString()}`,
    `> Duration: ${elapsed}s`,
    `> Total findings: ${stats.total} (Critical: ${stats.critical} | High: ${stats.high} | Medium: ${stats.medium} | Low: ${stats.low} | Info: ${stats.info})`,
    ``,
    `---`,
    ``,
  ];

  if (stats.total === 0) {
    lines.push(`## ✅ No Issues Found`, ``, `All audit dimensions passed. The system is in good health.`);
  } else {
    // Top priority items
    const topPriority = findings.filter(f =>
      f.severity === AuditSeverity.CRITICAL || f.severity === AuditSeverity.HIGH
    );
    if (topPriority.length > 0) {
      lines.push(`## 🔴 Top Priority (${topPriority.length})`);
      lines.push(``);
      for (const f of topPriority) {
        lines.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
        lines.push(`- **Category**: ${f.category}`);
        lines.push(`- **Description**: ${f.description}`);
        lines.push(`- **Suggestion**: ${f.suggestion}`);
        if (f.locations) {
          lines.push(`- **Locations**: ${JSON.stringify(f.locations).slice(0, 200)}`);
        }
        lines.push(``);
      }
    }

    // By category
    for (const [cat, catFindings] of Object.entries(byCategory)) {
      const filtered = catFindings.filter(f =>
        f.severity !== AuditSeverity.CRITICAL && f.severity !== AuditSeverity.HIGH
      );
      if (filtered.length === 0) continue;
      lines.push(`## ${getCategoryEmoji(cat, AuditCategory)} ${cat} (${filtered.length})`);
      lines.push(``);
      for (const f of filtered) {
        lines.push(`- **[${f.severity}]** ${f.title}: ${f.description.slice(0, 150)}${f.description.length > 150 ? '...' : ''}`);
        if (f.suggestion) lines.push(`  > 💡 ${f.suggestion}`);
      }
      lines.push(``);
    }
  }

  return lines.join('\n');
}

/**
 * Gets emoji for a category.
 */
function getCategoryEmoji(cat, AuditCategory) {
  const map = {
    [AuditCategory.LOGIC]: '🔀',
    [AuditCategory.CONFIG]: '⚙️',
    [AuditCategory.FUNCTION]: '📋',
    [AuditCategory.COUPLING]: '🔗',
    [AuditCategory.ARCHITECTURE]: '🏗️',
    [AuditCategory.PERFORMANCE]: '⚡',
    [AuditCategory.KNOWLEDGE]: '📚',
  };
  return map[cat] || '📌';
}

/**
 * Writes reports to disk.
 *
 * @param {object} options
 * @param {string} options.outputDir - Output directory
 * @param {string} options.markdown - Markdown report content
 * @param {Array<object>} options.findings - Array of audit findings
 * @param {object} options.stats - Stats object
 */
function writeReports({ outputDir, markdown, findings, stats }) {
  try {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Markdown report
    const mdPath = path.join(outputDir, 'deep-audit-report.md');
    fs.writeFileSync(mdPath, markdown, 'utf-8');

    // JSON report (machine-readable)
    const jsonPath = path.join(outputDir, 'deep-audit-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      stats,
      findings,
    }, null, 2), 'utf-8');

    console.log(`[DeepAudit] 📄 Reports written: ${mdPath}`);
  } catch (err) {
    console.warn(`[DeepAudit] ⚠️  Failed to write reports: ${err.message}`);
  }
}

/**
 * Computes stats from findings.
 *
 * @param {Array<object>} findings - Array of audit findings
 * @param {object} AuditSeverity - Severity enum
 * @returns {object} Stats object
 */
function computeStats(findings, AuditSeverity) {
  const stats = { total: findings.length, critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === AuditSeverity.CRITICAL) stats.critical++;
    else if (f.severity === AuditSeverity.HIGH) stats.high++;
    else if (f.severity === AuditSeverity.MEDIUM) stats.medium++;
    else if (f.severity === AuditSeverity.LOW) stats.low++;
    else if (f.severity === AuditSeverity.INFO) stats.info++;
  }
  return stats;
}

module.exports = {
  generateMarkdownReport,
  getCategoryEmoji,
  writeReports,
  computeStats,
};
