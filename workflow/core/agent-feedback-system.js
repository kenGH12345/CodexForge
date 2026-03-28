/**
 * Agent Feedback System – Inter-agent quality feedback loop
 *
 * Design Goals:
 *   - Enable downstream agents to provide quality feedback to upstream agents
 *   - Track performance metrics across sessions for trend analysis
 *   - Generate prompt optimization suggestions based on feedback patterns
 *   - Support continuous improvement of agent outputs
 *   - Integrate with ExperienceEventBus for real-time feedback events
 *   - Integrate with ExperienceStore for persistent feedback history
 *
 * Integration Points:
 *   - Called by TESTER agent to provide feedback to DEVELOPER
 *   - Called by DEVELOPER agent to provide feedback to PLANNER
 *   - Called by QualityGate when validation fails
 *   - Emits events via ExperienceEventBus (ExperienceEvents.AGENT_FEEDBACK)
 *   - Reads/writes to output/agent-feedback-history.jsonl
 *
 * Feedback Flow:
 *   1. Downstream agent detects quality issues (e.g., TESTER finds bugs)
 *   2. Calls collectFeedback() with score and specific issues
 *   3. System analyzes feedback pattern and generates suggestions
 *   4. If score < threshold, triggers prompt adjustment recommendations
 *   5. Trend analysis identifies agent strengths and weaknesses
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceEvents } = require('./experience-event-bus');

// ─── Feedback Types & Categories ────────────────────────────────────────────

const FeedbackType = {
  QUALITY: 'quality',         // Overall output quality
  CLARITY: 'clarity',         // Readability and understanding
  COMPLETENESS: 'completeness', // Coverage of requirements
  CORRECTNESS: 'correctness', // Technical correctness
  STYLE: 'style',             // Code/writing style consistency
  PERFORMANCE: 'performance', // Efficiency and optimization
};

const FeedbackCategory = {
  EXCELLENT: { min: 0.9, label: 'Excellent', icon: '🌟' },
  GOOD: { min: 0.7, label: 'Good', icon: '👍' },
  FAIR: { min: 0.5, label: 'Fair', icon: '⚠️' },
  POOR: { min: 0.0, label: 'Poor', icon: '❌' },
};

// ─── Performance Metrics Tracking ───────────────────────────────────────────

class PerformanceMetrics {
  constructor() {
    this.scores = [];
    this.feedbackCounts = 0;
    this.categoryCounts = { excellent: 0, good: 0, fair: 0, poor: 0 };
    this.issueTypes = new Map(); // issue type -> count
    this.averageByType = {};
  }

  addFeedback(feedback) {
    this.feedbackCounts++;
    this.scores.push(feedback.score);

    // Category counting
    const category = this._getCategory(feedback.score);
    this.categoryCounts[category]++;

    // Issue type tracking
    if (feedback.issues) {
      for (const issue of feedback.issues) {
        const type = issue.type || 'general';
        this.issueTypes.set(type, (this.issueTypes.get(type) || 0) + 1);
      }
    }
  }

  _getCategory(score) {
    if (score >= FeedbackCategory.EXCELLENT.min) return 'excellent';
    if (score >= FeedbackCategory.GOOD.min) return 'good';
    if (score >= FeedbackCategory.FAIR.min) return 'fair';
    return 'poor';
  }

  get averageScore() {
    if (this.scores.length === 0) return 0;
    return this.scores.reduce((a, b) => a + b, 0) / this.scores.length;
  }

  get trend() {
    if (this.scores.length < 5) return { direction: 'insufficient', change: 0 };

    // Compare recent 5 with previous 5
    const recent = this.scores.slice(-5);
    const previous = this.scores.slice(-10, -5);

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const prevAvg = previous.reduce((a, b) => a + b, 0) / previous.length;

    const change = recentAvg - prevAvg;
    const direction = change > 0.1 ? 'improving' : change < -0.1 ? 'degrading' : 'stable';

    return { direction, change };
  }

  get topIssues() {
    return Array.from(this.issueTypes.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }
}

// ─── Agent Feedback System ──────────────────────────────────────────────────

class AgentFeedbackSystem {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.outputDir]     - Directory for feedback persistence
   * @param {string}  [opts.sessionId]     - Session identifier
   * @param {object}  [opts.eventBus]      - ExperienceEventBus instance
   * @param {boolean} [opts.verbose=true]  - Print feedback logs to console
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || null;
    this._sessionId = opts.sessionId || null;
    this._eventBus = opts.eventBus || null;
    this._verbose = opts.verbose !== false;

    this._feedbackHistory = []; // All feedback records this session
    this._performanceMetrics = new Map(); // agent -> PerformanceMetrics
    this._feedbackStream = null;
  }

  /**
   * Set the output directory for persistence.
   */
  setOutputDir(outputDir) {
    this._outputDir = outputDir;
  }

  /**
   * Set the session ID for correlation.
   */
  setSessionId(sessionId) {
    this._sessionId = sessionId;
  }

  /**
   * Inject the event bus for real-time feedback events.
   * @param {ExperienceEventBus} eventBus
   */
  setEventBus(eventBus) {
    this._eventBus = eventBus;
  }

  // ─── Feedback Collection ──────────────────────────────────────────────────

  /**
   * Collects feedback from a downstream agent about an upstream agent's output.
   *
   * @param {string} sourceAgent   - Agent providing feedback (e.g., 'TESTER')
   * @param {string} targetAgent   - Agent being evaluated (e.g., 'DEVELOPER')
   * @param {object} feedback
   * @param {string} feedback.type          - FeedbackType value
   * @param {number} feedback.score         - 0.0-1.0 quality score
   * @param {string} [feedback.artifactId]  - Reference to the artifact evaluated
   * @param {Array<{type:string, message:string, severity:string}>} [feedback.issues] - Specific issues found
   * @param {string} [feedback.comments]    - Free-form comments
   * @param {object} [feedback.metadata]    - Additional context
   * @returns {object} The feedback record
   */
  collectFeedback(sourceAgent, targetAgent, feedback) {
    const record = {
      id: `${targetAgent}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      source: sourceAgent,
      target: targetAgent,
      type: feedback.type || FeedbackType.QUALITY,
      score: Math.max(0, Math.min(1, feedback.score)), // Clamp to [0, 1]
      artifactId: feedback.artifactId || null,
      issues: feedback.issues || [],
      comments: feedback.comments || null,
      metadata: feedback.metadata || {},
    };

    this._feedbackHistory.push(record);

    // Update performance metrics for target agent
    if (!this._performanceMetrics.has(targetAgent)) {
      this._performanceMetrics.set(targetAgent, new PerformanceMetrics());
    }
    this._performanceMetrics.get(targetAgent).addFeedback(record);

    // Emit event if event bus is available
    if (this._eventBus && this._eventBus.emit) {
      this._eventBus.emit(ExperienceEvents.AGENT_FEEDBACK, {
        source: sourceAgent,
        target: targetAgent,
        score: record.score,
        issues: record.issues.length,
      });
    }

    // Trigger improvement suggestion if score is low
    if (record.score < 0.7) {
      this._generateImprovementSuggestion(targetAgent, record);
    }

    // Log to console if verbose
    if (this._verbose) {
      this._logFeedback(record);
    }

    // Persist to file
    this._persistFeedback(record);

    return record;
  }

  /**
   * Records a quality gate failure as negative feedback.
   * Used when QualityGate rejects an agent's output.
   *
   * @param {string} agent      - Agent that failed quality gate
   * @param {string} stage      - Stage where failure occurred
   * @param {string} reason     - Reason for failure
   * @param {object} [context]  - Additional context
   */
  recordQualityGateFailure(agent, stage, reason, context = {}) {
    // Infer upstream agent based on stage
    const upstreamMap = {
      'TEST': 'DEVELOPER',
      'CODE': 'PLANNER',
      'PLAN': 'ARCHITECT',
      'ARCHITECT': 'ANALYST',
    };

    const upstreamAgent = upstreamMap[stage];
    if (!upstreamAgent) return null;

    return this.collectFeedback('QualityGate', upstreamAgent, {
      type: FeedbackType.QUALITY,
      score: 0.3,
      artifactId: context.artifactId,
      issues: [{
        type: 'quality_gate_failure',
        message: reason,
        severity: 'high',
        stage,
      }],
      comments: `Quality gate failed at ${stage}: ${reason.slice(0, 200)}`,
      metadata: {
        qualityGateFailure: true,
        stage,
        ...context,
      },
    });
  }

  // ─── Analysis & Suggestions ────────────────────────────────────────────────

  /**
   * Generates improvement suggestions based on feedback patterns.
   * @private
   */
  _generateImprovementSuggestion(agent, recentFeedback) {
    const metrics = this._performanceMetrics.get(agent);
    if (!metrics) return null;

    const suggestions = [];

    // Trend-based suggestions
    const trend = metrics.trend;
    if (trend.direction === 'degrading') {
      suggestions.push({
        type: 'trend_alert',
        severity: 'high',
        message: `${agent} output quality is degrading (↓${(Math.abs(trend.change) * 100).toFixed(1)}%). Review recent changes.`,
      });
    }

    // Issue-type based suggestions
    const topIssues = metrics.topIssues;
    for (const [issueType, count] of topIssues.slice(0, 3)) {
      const suggestion = this._getSuggestionForIssueType(issueType, agent);
      if (suggestion) {
        suggestions.push({
          type: 'issue_pattern',
          issueType,
          count,
          ...suggestion,
        });
      }
    }

    // Score-based suggestions
    if (recentFeedback.score < 0.5) {
      suggestions.push({
        type: 'score_critical',
        severity: 'critical',
        message: `${agent} received critically low score (${(recentFeedback.score * 100).toFixed(0)}%). Immediate review recommended.`,
        actions: ['Review output manually', 'Check input requirements', 'Verify prompt configuration'],
      });
    }

    // Log suggestions if verbose
    if (this._verbose && suggestions.length > 0) {
      console.log(`\n  💡 Suggestions for ${agent}:`);
      for (const s of suggestions) {
        const icon = s.severity === 'critical' ? '🔴' : s.severity === 'high' ? '🟠' : '🟡';
        console.log(`     ${icon} ${s.message}`);
      }
    }

    return suggestions;
  }

  _getSuggestionForIssueType(issueType, agent) {
    const suggestionMap = {
      'missing_tests': {
        message: `Add comprehensive test coverage, including edge cases`,
        promptAdjustment: 'Emphasize test completeness in prompt',
      },
      'syntax_error': {
        message: `Review generated code for syntax errors before output`,
        promptAdjustment: 'Add syntax validation requirement to prompt',
      },
      'incomplete_implementation': {
        message: `Ensure all requirements are fully implemented`,
        promptAdjustment: 'Add requirement checklist to prompt',
      },
      'poor_naming': {
        message: `Follow naming conventions consistently`,
        promptAdjustment: 'Specify naming convention requirements',
      },
      'missing_documentation': {
        message: `Include inline documentation and docstrings`,
        promptAdjustment: 'Require documentation for public APIs',
      },
      'inconsistent_style': {
        message: `Maintain consistent code style throughout`,
        promptAdjustment: 'Reference style guide in prompt',
      },
    };

    return suggestionMap[issueType] || {
      message: `Review and address ${issueType} issues`,
      promptAdjustment: `Add guidance for ${issueType}`,
    };
  }

  // ─── Reports & Analysis ────────────────────────────────────────────────────

  /**
   * Generates a performance report for a specific agent.
   *
   * @param {string} agent - Agent name
   * @returns {object|null} Performance report
   */
  generatePerformanceReport(agent) {
    const metrics = this._performanceMetrics.get(agent);
    if (!metrics) return null;

    const trend = metrics.trend;
    const category = this._getScoreCategory(metrics.averageScore);

    return {
      agent,
      overallScore: metrics.averageScore,
      category,
      trend: trend.direction,
      trendChange: trend.change,
      feedbackCount: metrics.feedbackCounts,
      distribution: metrics.categoryCounts,
      topIssues: metrics.topIssues,
      recommendations: this._generateRecommendations(agent, metrics),
    };
  }

  _getScoreCategory(score) {
    if (score >= FeedbackCategory.EXCELLENT.min) return FeedbackCategory.EXCELLENT;
    if (score >= FeedbackCategory.GOOD.min) return FeedbackCategory.GOOD;
    if (score >= FeedbackCategory.FAIR.min) return FeedbackCategory.FAIR;
    return FeedbackCategory.POOR;
  }

  _generateRecommendations(agent, metrics) {
    const recommendations = [];

    if (metrics.averageScore < 0.6) {
      recommendations.push(`Consider prompt redesign for ${agent}`);
    }

    if (metrics.trend.direction === 'degrading') {
      recommendations.push(`Investigate recent quality degradation in ${agent}`);
    }

    const topIssue = metrics.topIssues[0];
    if (topIssue && topIssue[1] > 3) {
      recommendations.push(`Address recurring issue: ${topIssue[0]}`);
    }

    return recommendations;
  }

  /**
   * Prints a comprehensive feedback summary report.
   */
  printFeedbackSummary() {
    if (this._feedbackHistory.length === 0) {
      console.log('\n  ℹ️  No feedback recorded.');
      return;
    }

    console.log('\n' + '═'.repeat(70));
    console.log('           📊 A G E N T   F E E D B A C K   S U M M A R Y');
    console.log('═'.repeat(70));

    // Per-agent reports
    for (const [agent, metrics] of this._performanceMetrics) {
      const report = this.generatePerformanceReport(agent);
      const icon = report.category.icon;

      console.log(`\n  ${icon} ${agent}`);
      console.log(`     Overall Score: ${(report.overallScore * 100).toFixed(1)}% (${report.category.label})`);
      console.log(`     Trend: ${report.trend === 'improving' ? '📈' : report.trend === 'degrading' ? '📉' : '➡️'} ${report.trend}`);
      console.log(`     Feedback Count: ${report.feedbackCount}`);

      if (report.topIssues.length > 0) {
        console.log(`     Top Issues:`);
        for (const [issue, count] of report.topIssues.slice(0, 3)) {
          console.log(`       • ${issue}: ${count}x`);
        }
      }
    }

    // Session-wide statistics
    const avgScore = this._feedbackHistory.reduce((s, f) => s + f.score, 0) / this._feedbackHistory.length;
    console.log(`\n  📈 Session Average: ${(avgScore * 100).toFixed(1)}%`);
    console.log(`  📝 Total Feedback: ${this._feedbackHistory.length}`);

    console.log('═'.repeat(70));
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  /**
   * Persists a feedback record to JSONL file.
   * @private
   */
  _persistFeedback(record) {
    if (!this._outputDir) return;

    try {
      if (!this._feedbackStream) {
        if (!fs.existsSync(this._outputDir)) {
          fs.mkdirSync(this._outputDir, { recursive: true });
        }
        const logPath = path.join(this._outputDir, 'agent-feedback-history.jsonl');
        this._feedbackStream = fs.createWriteStream(logPath, { flags: 'a' });
      }

      this._feedbackStream.write(JSON.stringify(record) + '\n');
    } catch (e) {
      this._warn(`Failed to persist feedback: ${e.message}`);
    }
  }

  /**
   * Saves the complete feedback history and reports.
   * @returns {string|null} Path to saved file
   */
  saveFeedbackReport() {
    if (!this._outputDir) return null;

    const reportPath = path.join(this._outputDir, 'agent-feedback-report.json');

    const reports = {};
    for (const [agent, metrics] of this._performanceMetrics) {
      reports[agent] = this.generatePerformanceReport(agent);
    }

    const data = {
      sessionId: this._sessionId,
      generatedAt: new Date().toISOString(),
      summary: {
        totalFeedback: this._feedbackHistory.length,
        averageScore: this._feedbackHistory.reduce((s, f) => s + f.score, 0) / this._feedbackHistory.length,
        agents: Array.from(this._performanceMetrics.keys()),
      },
      reports,
      feedbackHistory: this._feedbackHistory,
    };

    try {
      const tmpPath = reportPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, reportPath);

      if (this._verbose) {
        console.log(`\n  💾 Feedback report saved to: ${reportPath}`);
      }
    } catch (e) {
      this._warn(`Failed to save feedback report: ${e.message}`);
    }

    return reportPath;
  }

  /**
   * Closes the feedback stream and flushes data.
   */
  flush() {
    if (this._feedbackStream) {
      try { this._feedbackStream.end(); } catch (_) {}
      this._feedbackStream = null;
    }
    return this.saveFeedbackReport();
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  _logFeedback(record) {
    const category = this._getScoreCategory(record.score);
    const icon = category.icon;
    const issueCount = record.issues ? record.issues.length : 0;

    console.log(`\n  ${icon} ${record.source} → ${record.target}: ${(record.score * 100).toFixed(0)}%`);
    if (record.comments) {
      console.log(`     "${record.comments.slice(0, 80)}${record.comments.length > 80 ? '...' : ''}"`);
    }
    if (issueCount > 0) {
      console.log(`     Issues: ${issueCount}`);
    }
  }

  _warn(msg) {
    console.warn(`[AgentFeedbackSystem] ⚠️  ${msg}`);
  }

  // ─── Cross-Session History Loading ─────────────────────────────────────────

  /**
   * Loads feedback history from previous sessions.
   * 
   * @param {string} outputDir - Directory containing feedback-history.jsonl
   * @returns {Array} Array of feedback records
   */
  static loadHistory(outputDir) {
    const historyPath = path.join(outputDir, 'agent-feedback-history.jsonl');
    if (!fs.existsSync(historyPath)) return [];

    const records = [];
    const lines = fs.readFileSync(historyPath, 'utf-8').split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (e) {
        // Skip malformed lines
      }
    }

    return records;
  }

  /**
   * Computes feedback trends across all sessions.
   * 
   * @param {Array} history - Feedback history from loadHistory()
   * @returns {object} Trend analysis by agent
   */
  static computeTrends(history) {
    const byAgent = {};

    for (const record of history) {
      const agent = record.target;
      if (!byAgent[agent]) {
        byAgent[agent] = { scores: [], recentScores: [] };
      }
      byAgent[agent].scores.push(record.score);
      
      // Keep last 20 for recent trend
      byAgent[agent].recentScores.push(record.score);
      if (byAgent[agent].recentScores.length > 20) {
        byAgent[agent].recentScores.shift();
      }
    }

    const trends = {};
    for (const [agent, data] of Object.entries(byAgent)) {
      const allAvg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
      const recentAvg = data.recentScores.reduce((a, b) => a + b, 0) / data.recentScores.length;
      
      trends[agent] = {
        allTimeAverage: allAvg,
        recentAverage: recentAvg,
        totalFeedback: data.scores.length,
        direction: recentAvg > allAvg + 0.05 ? 'improving' : 
                   recentAvg < allAvg - 0.05 ? 'degrading' : 'stable',
      };
    }

    return trends;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  AgentFeedbackSystem,
  PerformanceMetrics,
  FeedbackType,
  FeedbackCategory,
};
