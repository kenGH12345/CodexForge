/**
 * Benchmark Report Generator — 基准测试报告生成器
 *
 * Purpose: 生成 WorkflowAgent vs AI IDE 对比评估的可视化报告
 *
 * Output Formats:
 *   - Markdown (human-readable)
 *   - HTML (interactive dashboard)
 *   - JSON (machine-readable)
 *
 * ADR-37 Compliance: Uses fs/path only
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Markdown Report Generator
// ═══════════════════════════════════════════════════════════════════════════

class MarkdownReportGenerator {
  generate(report) {
    const sections = [];
    
    sections.push(this._generateHeader(report));
    sections.push(this._generateExecutiveSummary(report));
    sections.push(this._generateStatisticalSummary(report));
    sections.push(this._generateDimensionBreakdown(report));
    sections.push(this._generateTaskByTaskComparison(report));
    sections.push(this._generateKeyInsights(report));
    sections.push(this._generateRecommendations(report));
    sections.push(this._generateAppendix(report));

    return sections.join('\n\n');
  }

  _generateHeader(report) {
    return `# WorkflowAgent vs AI IDE Benchmark Report

**Report ID:** ${report.id}  
**Generated:** ${new Date(report.createdAt).toLocaleString()}  
**Tasks Evaluated:** ${report.taskCount}

---

## 📋 Table of Contents

1. [Executive Summary](#executive-summary)
2. [Statistical Summary](#statistical-summary)
3. [Dimension Breakdown](#dimension-breakdown)
4. [Task-by-Task Comparison](#task-by-task-comparison)
5. [Key Insights](#key-insights)
6. [Recommendations](#recommendations)
7. [Appendix](#appendix)

---
`;
  }

  _generateExecutiveSummary(report) {
    const { summary } = report;
    const winner = summary.avgScoreDelta > 5 ? '🏆 WorkflowAgent' : 
                   summary.avgScoreDelta < -5 ? '💻 Native IDE' : '🤝 Tie';
    
    return `## 🎯 Executive Summary

### Overall Result
| Metric | WorkflowAgent | Native IDE | Difference |
|--------|---------------|------------|------------|
| Average Score | ${summary.avgWorkflowAgentScore.toFixed(1)} | ${summary.avgIdeScore.toFixed(1)} | ${summary.avgScoreDelta > 0 ? '+' : ''}${summary.avgScoreDelta.toFixed(1)} |
| Win Rate | ${((summary.workflowAgentWins / summary.totalTasks) * 100).toFixed(1)}% | ${((summary.ideWins / summary.totalTasks) * 100).toFixed(1)}% | - |
| **Winner** | **${winner}** | - | - |

### Quick Stats
- **Total Tasks:** ${summary.totalTasks}
- **WorkflowAgent Wins:** ${summary.workflowAgentWins} (${((summary.workflowAgentWins / summary.totalTasks) * 100).toFixed(0)}%)
- **IDE Wins:** ${summary.ideWins} (${((summary.ideWins / summary.totalTasks) * 100).toFixed(0)}%)
- **Ties:** ${summary.ties} (${((summary.ties / summary.totalTasks) * 100).toFixed(0)}%)
- **Statistical Significance:** ${summary.isStatisticallySignificant ? '✅ Yes' : '⚠️ Insufficient sample size'}
`;
  }

  _generateStatisticalSummary(report) {
    const sections = [];
    
    sections.push(`## 📊 Statistical Summary`);
    sections.push('');
    
    // Score distribution
    const scoreRanges = { agent: { high: 0, medium: 0, low: 0 }, ide: { high: 0, medium: 0, low: 0 } };
    
    for (const comp of report.comparisons) {
      const agentScore = comp.workflowAgentScores?.overallScore || 0;
      const ideScore = comp.ideScores?.overallScore || 0;
      
      if (agentScore >= 80) scoreRanges.agent.high++;
      else if (agentScore >= 60) scoreRanges.agent.medium++;
      else scoreRanges.agent.low++;
      
      if (ideScore >= 80) scoreRanges.ide.high++;
      else if (ideScore >= 60) scoreRanges.ide.medium++;
      else scoreRanges.ide.low++;
    }
    
    sections.push('### Score Distribution');
    sections.push('');
    sections.push('| Range | WorkflowAgent | IDE |');
    sections.push('|-------|---------------|-----|');
    sections.push(`| Excellent (80-100) | ${scoreRanges.agent.high} | ${scoreRanges.ide.high} |`);
    sections.push(`| Good (60-79) | ${scoreRanges.agent.medium} | ${scoreRanges.ide.medium} |`);
    sections.push(`| Needs Work (< 60) | ${scoreRanges.agent.low} | ${scoreRanges.ide.low} |`);
    
    return sections.join('\n');
  }

  _generateDimensionBreakdown(report) {
    const sections = [];
    
    sections.push(`## 📈 Dimension Breakdown`);
    sections.push('');
    sections.push('Detailed analysis across four key dimensions:');
    sections.push('');
    
    const dimensionNames = {
      'functional_correctness': 'Functional Correctness (25%) ⭐',
      'functional_completeness': 'Functional Completeness (20%)',
      'code_quality': 'Code Quality (20%)',
      'robustness': 'Robustness (15%)',
      'dev_efficiency': 'Development Efficiency (15%)',
      'user_experience': 'User Experience (5%)',
    };
    
    const dimensionEmojis = {
      'functional_correctness': '✅',
      'functional_completeness': '📋',
      'code_quality': '💎',
      'robustness': '🛡️',
      'dev_efficiency': '⚡',
      'user_experience': '😊',
    };
    
    for (const [dim, data] of Object.entries(report.dimensionSummary)) {
      const name = dimensionNames[dim] || dim;
      const emoji = dimensionEmojis[dim] || '📊';
      const delta = data.delta;
      const winner = delta > 5 ? 'WorkflowAgent' : delta < -5 ? 'IDE' : 'Tie';
      const deltaStr = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
      
      sections.push(`### ${emoji} ${name}`);
      sections.push('');
      sections.push(`| Metric | WorkflowAgent | IDE | Delta | Winner |`);
      sections.push(`|--------|---------------|-----|-------|--------|`);
      sections.push(`| **Score** | ${data.workflowAgent.toFixed(1)} | ${data.ide.toFixed(1)} | ${deltaStr} | ${winner} |`);
      sections.push('');
    }
    
    return sections.join('\n');
  }

  _generateTaskByTaskComparison(report) {
    const sections = [];
    
    sections.push(`## 📝 Task-by-Task Comparison`);
    sections.push('');
    
    for (const comp of report.comparisons) {
      const levelEmoji = { 'simple': '🟢', 'medium': '🟡', 'complex': '🔴', 'production': '🔷' }[comp.taskLevel] || '⚪';
      const winnerEmoji = comp.winner === 'workflow-agent' ? '🏆' : 
                          comp.winner === 'ide' ? '💻' : '🤝';
      
      sections.push(`### ${levelEmoji} ${comp.taskName}`);
      sections.push('');
      sections.push(`**Task ID:** ${comp.taskId} | **Level:** ${comp.taskLevel} | **Winner:** ${winnerEmoji} ${comp.winner}`);
      sections.push('');
      sections.push(`| Tool | Overall Score | Task Completion | Code Quality | Efficiency | UX |`);
      sections.push(`|------|---------------|-----------------|--------------|------------|----|`);
      
      const ide = comp.ideScores || {};
      const agent = comp.workflowAgentScores || {};
      
      sections.push(`| WorkflowAgent | ${agent.overallScore || 0} | ${agent.taskCompletion?.score || 0} | ${agent.codeQuality?.score || 0} | ${agent.devEfficiency?.score || 0} | ${agent.userExperience?.score || 0} |`);
      sections.push(`| IDE | ${ide.overallScore || 0} | ${ide.taskCompletion?.score || 0} | ${ide.codeQuality?.score || 0} | ${ide.devEfficiency?.score || 0} | ${ide.userExperience?.score || 0} |`);
      sections.push(`| **Delta** | **${(agent.overallScore - ide.overallScore) > 0 ? '+' : ''}${(agent.overallScore - ide.overallScore).toFixed(1)}** | - | - | - | - |`);
      
      if (comp.keyInsights.length > 0) {
        sections.push('');
        sections.push('**Insights:**');
        for (const insight of comp.keyInsights) {
          const icon = insight.type === 'strength' ? '✅' : insight.type === 'weakness' ? '⚠️' : 'ℹ️';
          sections.push(`- ${icon} ${insight.message}`);
        }
      }
      
      sections.push('');
    }
    
    return sections.join('\n');
  }

  _generateKeyInsights(report) {
    const sections = [];
    
    sections.push(`## 💡 Key Insights`);
    sections.push('');
    
    // Strengths
    if (report.strengths.length > 0) {
      sections.push('### 🌟 WorkflowAgent Strengths');
      sections.push('');
      for (const strength of report.strengths) {
        sections.push(`- **${strength.dimension}**: +${strength.margin.toFixed(1)} points advantage`);
      }
      sections.push('');
    }
    
    // Weaknesses
    if (report.weaknesses.length > 0) {
      sections.push('### 🔧 Areas for Improvement');
      sections.push('');
      for (const weakness of report.weaknesses) {
        sections.push(`- **${weakness.dimension}**: -${weakness.margin.toFixed(1)} points (IDE performs better)`);
      }
      sections.push('');
    }
    
    // Extract common insights
    const allInsights = report.comparisons.flatMap(c => c.keyInsights || []);
    const insightCounts = {};
    for (const insight of allInsights) {
      const key = `${insight.type}: ${insight.message}`;
      insightCounts[key] = (insightCounts[key] || 0) + 1;
    }
    
    if (Object.keys(insightCounts).length > 0) {
      sections.push('### 📊 Most Common Patterns');
      sections.push('');
      const sortedInsights = Object.entries(insightCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      for (const [insight, count] of sortedInsights) {
        sections.push(`- (${count}x) ${insight}`);
      }
    }
    
    return sections.join('\n');
  }

  _generateRecommendations(report) {
    const sections = [];
    
    sections.push(`## 📋 Recommendations`);
    sections.push('');
    
    if (report.recommendations.length > 0) {
      for (let i = 0; i < report.recommendations.length; i++) {
        sections.push(`${i + 1}. ${report.recommendations[i]}`);
      }
    } else {
      sections.push('No specific recommendations at this time.');
    }
    
    sections.push('');
    sections.push('### Next Steps');
    sections.push('');
    sections.push('1. **Address Weaknesses**: Focus on dimensions where WorkflowAgent underperforms');
    sections.push('2. **Increase Sample Size**: Run more benchmarks for statistical confidence');
    sections.push('3. **Automate Recording**: Integrate execution recording into real workflows');
    sections.push('4. **Track Over Time**: Monitor improvements across releases');
    
    return sections.join('\n');
  }

  _generateAppendix(report) {
    return `## 📎 Appendix

### Methodology

**Evaluation Dimensions (Priority Order):**

1. **Functional Correctness (25%)** ⭐ MOST CRITICAL
   - Core logic correctness (test pass rate)
   - Edge case handling
   - Type correctness (static analysis)
   - Output validation

2. **Functional Completeness (20%)**
   - Requirement coverage
   - Feature completeness
   - API completeness
   - Documentation completeness

3. **Code Quality (20%)**
   - Lint/style compliance
   - Code readability
   - Best practices adherence
   - Documentation quality

4. **Robustness (15%)**
   - Error handling completeness
   - Input validation
   - Exception safety
   - Resource cleanup

5. **Development Efficiency (15%)**
   - Iteration efficiency
   - Time efficiency
   - Token usage efficiency
   - Automation level

6. **User Experience (5%)**
   - Explainability
   - Controllability
   - Interaction smoothness

**Scoring Scale:**
- 90-100: Excellent - Production ready
- 70-89: Good - Minor issues
- 50-69: Acceptable - Needs improvement
- Below 50: Failed - Major issues

### Data Files

- Full JSON Report: \`latest-benchmark-report.json\`
- Raw Execution Data: \`benchmarks/results/\`
- Task Definitions: \`benchmarks/task-bank/tasks.json\`

---

*Generated by WorkflowAgent Benchmark System*
`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: HTML Report Generator
// ═══════════════════════════════════════════════════════════════════════════

class HTMLReportGenerator {
  generate(report) {
    const mdGenerator = new MarkdownReportGenerator();
    const markdown = mdGenerator.generate(report);
    
    // Simple markdown to HTML conversion
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>WorkflowAgent Benchmark Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; line-height: 1.6; }
    h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
    h2 { color: #34495e; border-bottom: 2px solid #ecf0f1; padding-bottom: 5px; margin-top: 30px; }
    h3 { color: #7f8c8d; }
    table { border-collapse: collapse; width: 100%; margin: 15px 0; }
    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
    th { background-color: #3498db; color: white; }
    tr:nth-child(even) { background-color: #f2f2f2; }
    .winner-agent { color: #27ae60; font-weight: bold; }
    .winner-ide { color: #e74c3c; font-weight: bold; }
    .score-high { color: #27ae60; }
    .score-medium { color: #f39c12; }
    .score-low { color: #e74c3c; }
    code { background-color: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: 'Fira Code', monospace; }
    .metric-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px; margin: 10px 0; }
    .metric-card h3 { color: white; margin-top: 0; }
  </style>
</head>
<body>
  ${this._markdownToHTML(markdown)}
</body>
</html>
    `.trim();
    
    return html;
  }

  _markdownToHTML(markdown) {
    // Simple markdown to HTML conversion
    let html = markdown;

    // Headers
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // Tables
    const tableRegex = /\|(.+)\|\n\|[-:\s|]+\|\n((?:\|.+\|\n?)+)/g;
    html = html.replace(tableRegex, (match, header, body) => {
      const headers = header.split('|').filter(h => h.trim()).map(h => `<th>${h.trim()}</th>`).join('');
      const rows = body.trim().split('\n').map(row => {
        const cells = row.split('|').filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join('');
        return `<tr>${cells}</tr>`;
      }).join('');
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    });

    // Lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.+<\/li>\n)+/g, '<ul>$&</ul>');

    // Paragraphs
    html = html.replace(/\n\n/g, '</p><p>');
    
    // Wrap in paragraphs
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs
    html = html.replace(/<p>\s*<\/p>/g, '');

    return html;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Main Report Generator
// ═══════════════════════════════════════════════════════════════════════════

class BenchmarkReportGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, '../../benchmarks/results');
    this.mdGenerator = new MarkdownReportGenerator();
    this.htmlGenerator = new HTMLReportGenerator();
  }

  /**
   * Generates all report formats.
   * @param {BenchmarkReport} report
   * @returns {Object} Paths to generated reports
   */
  generate(report) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = {};

    // Markdown report
    const markdown = this.mdGenerator.generate(report);
    const mdPath = path.join(this.outputDir, `benchmark-report-${timestamp}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf-8');
    results.markdown = mdPath;

    // Latest markdown
    const latestMdPath = path.join(this.outputDir, 'benchmark-report-latest.md');
    fs.writeFileSync(latestMdPath, markdown, 'utf-8');

    // HTML report
    const html = this.htmlGenerator.generate(report);
    const htmlPath = path.join(this.outputDir, `benchmark-report-${timestamp}.html`);
    fs.writeFileSync(htmlPath, html, 'utf-8');
    results.html = htmlPath;

    // Latest HTML
    const latestHtmlPath = path.join(this.outputDir, 'benchmark-report-latest.html');
    fs.writeFileSync(latestHtmlPath, html, 'utf-8');

    console.log('[ReportGenerator] Reports generated:');
    console.log(`  - Markdown: ${mdPath}`);
    console.log(`  - HTML: ${htmlPath}`);

    return results;
  }
}

module.exports = {
  BenchmarkReportGenerator,
  MarkdownReportGenerator,
  HTMLReportGenerator,
};
