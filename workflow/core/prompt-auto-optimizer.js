/**
 * Prompt Auto-Optimizer – Feedback-driven prompt improvement system
 *
 * Analyzes AgentFeedbackSystem history and prompt traces to:
 *   - Identify common failure patterns by agent type
 *   - Generate evidence-based prompt improvement suggestions
 *   - Auto-apply proven optimizations (opt-in)
 *   - Track A/B test outcomes for prompt variants
 *   - Maintain prompt evolution history
 *
 * Integration:
 *   - Called by Orchestrator._finalizeWorkflow() to analyze and optimize
 *   - Reads from output/agent-feedback-history.jsonl, output/prompt-traces.jsonl
 *   - Writes to output/prompt-optimization-suggestions.json
 *   - Applied by PromptBuilder via OPTIMIZED_PROMPTS registry
 *
 * Design Principles:
 *   - Evidence-based: only suggest optimizations with data backing
 *   - Conservative: no changes that could break existing workflows
 *   - Measurable: track prompt effectiveness changes
 *   - Reversible: maintain prompt evolution history
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Confidence thresholds for auto-application of optimizations
 */
const CONFIDENCE_THRESHOLDS = {
  autoApply: 0.85,      // 85%+ confidence = auto-apply
  suggestHigh: 0.70,    // 70%+ = high priority suggestion
  suggestMedium: 0.50,  // 50%+ = medium priority
  suggestLow: 0.30,     // 30%+ = low priority (IDEA status)
};

/**
 * Minimum sample sizes for statistical validity
 */
const SAMPLE_SIZES = {
  minFeedbackForAnalysis: 5,
  minPromptVariantsForAB: 10,
  minSuccessRateDiff: 0.15, // 15% improvement required
};

/**
 * Issue type to prompt optimization mapping
 */
const ISSUE_TO_OPTIMIZATION = {
  'missing_tests': {
    type: 'instruction_enhancement',
    description: 'Add explicit test coverage requirement',
    template: '## TESTING REQUIREMENT\nYou MUST include comprehensive tests covering:\n- [ ] Happy path scenarios\n- [ ] Edge cases and error handling\n- [ ] Boundary conditions\n\nTests should be production-ready, not placeholder code.',
  },
  'syntax_error': {
    type: 'instruction_enhancement',  
    description: 'Add syntax validation requirement',
    template: '## SYNTAX VALIDATION\nBefore outputting any code:\n1. Validate syntax for the target language\n2. Ensure all brackets, parentheses, and quotes are balanced\n3. Verify imports/dependencies are correctly declared\n4. Only output code that would pass a basic compilation/parsing check.',
  },
  'incomplete_implementation': {
    type: 'requirement_checklist',
    description: 'Add requirement checklist to prompt',
    template: '## COMPLETENESS CHECKLIST\nReview against all requirements:\n- [ ] Every functional requirement addressed\n- [ ] No TODOs or placeholder implementations\n- [ ] Error handling implemented for all error paths\n- [ ] Integration points verified\n\nDo not mark complete unless ALL items checked.',
  },
  'poor_naming': {
    type: 'style_guidance',
    description: 'Add naming convention guidance',
    template: '## NAMING CONVENTIONS\nFollow these standards:\n- Functions: verbNoun format (e.g., calculateTotal, validateInput)\n- Variables: descriptive, no abbreviations (e.g., userCount not uc)\n- Constants: UPPER_SNAKE_CASE\n- Classes: PascalCase descriptive nouns\n\nNames should reveal intent and be searchable.',
  },
  'missing_documentation': {
    type: 'instruction_enhancement',
    description: 'Require inline documentation',
    template: '## DOCUMENTATION REQUIREMENTS\nEvery public API must include:\n- Clear description of purpose and behavior\n- Parameter descriptions\n- Return value description\n- Exception/error cases\n\nComplex algorithms should have inline comments explaining the approach.',
  },
  'inconsistent_style': {
    type: 'style_guidance',
    description: 'Enforce style consistency',
    template: '## STYLE CONSISTENCY\nMaintain consistent formatting:\n- Use consistent spacing and indentation\n- Apply same patterns for similar constructs\n- Follow project conventions for structure\n- Run through linter if available\n\nStyle consistency aids maintainability and readability.',
  },
  'incorrect_logic': {
    type: 'thinking_framework',
    description: 'Add step-by-step reasoning',
    template: '## REASONING FRAMEWORK\nBefore implementing:\n1. Break down the problem into steps\n2. Consider edge cases explicitly\n3. Walk through your logic mentally\n4. Verify your approach handles all scenarios\n\nExplain your approach in comments before implementation.',
  },
  'hallucinated_api': {
    type: 'constraint_reinforcement',
    description: 'Add API verification requirement',
    template: '## API VERIFICATION\nWhen using external APIs:\n- Only use methods that exist in the actual API\n- Verify parameter names and types\n- Check return value structure\n- If unsure, use most common/standard patterns\n\nDo not invent API methods or parameters.',
  },
};

// ─── Prompt Optimizer Class ────────────────────────────────────────────────

class PromptAutoOptimizer {
  /**
   * @param {object} [opts]
   * @param {string} [opts.outputDir='output'] - Directory for data files
   * @param {boolean} [opts.autoApply=false] - Whether to auto-apply high-confidence optimizations
   * @param {object} [opts.config] - Configuration overrides
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || 'output';
    this._autoApply = opts.autoApply || false;
    this._config = { ...CONFIDENCE_THRESHOLDS, ...SAMPLE_SIZES, ...opts.config };
    
    // Optimization registry (loaded from disk or empty)
    this._optimizations = this._loadOptimizations();
  }

  /**
   * Analyzes feedback history and generates optimization suggestions.
   * Main entry point called after workflow completion.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.dryRun=false] - If true, don't write files
   * @returns {OptimizationAnalysisResult} Analysis and suggestions
   */
  analyzeAndOptimize(opts = {}) {
    const dryRun = opts.dryRun || false;
    
    // Load data
    const feedbackHistory = this._loadFeedbackHistory();
    const promptTraces = this._loadPromptTraces();
    
    if (feedbackHistory.length < this._config.minFeedbackForAnalysis) {
      console.log(`[PromptAutoOptimizer] ⚠️ Insufficient feedback (${feedbackHistory.length}/${this._config.minFeedbackForAnalysis} min), skipping analysis`);
      return { status: 'skipped', reason: 'insufficient_feedback' };
    }
    
    // Analyze patterns
    const patterns = this._analyzeFeedbackPatterns(feedbackHistory);
    const abTestResults = this._analyzeABTests(feedbackHistory, promptTraces);
    
    // Generate suggestions
    const suggestions = this._generateSuggestions(patterns, abTestResults);
    
    // Apply high-confident optimizations
    const applied = [];
    if (this._autoApply && !dryRun) {
      for (const suggestion of suggestions) {
        if (suggestion.confidence >= this._config.autoApply) {
          const result = this._applyOptimization(suggestion);
          if (result.success) {
            applied.push(suggestion);
          }
        }
      }
    }
    
    // Save results
    const result = {
      status: 'completed',
      timestamp: new Date().toISOString(),
      dataStats: {
        feedbackCount: feedbackHistory.length,
        promptTraceCount: promptTraces.length,
        uniqueAgents: Object.keys(patterns.agentStats || {}).length,
      },
      patterns,
      abTestResults,
      suggestions,
      applied,
      pending: suggestions.filter(s => !applied.includes(s)),
    };
    
    if (!dryRun) {
      this._saveResults(result);
    }
    
    // Log summary
    console.log(`[PromptAutoOptimizer] ✅ Analysis complete: ${suggestions.length} suggestions, ${applied.length} auto-applied`);
    
    return result;
  }

  /**
   * Gets optimization suggestions for a specific agent.
   *
   * @param {string} agent - Agent name (e.g., 'DEVELOPER', 'TESTER')
   * @returns {Array<OptimizationSuggestion>} Suggestions for the agent
   */
  getSuggestionsForAgent(agent) {
    const results = this._loadResults();
    if (!results?.suggestions) return [];
    
    return results.suggestions.filter(s => s.agent === agent || s.targetAgents?.includes(agent));
  }

  /**
   * Applies a specific optimization suggestion.
   *
   * @param {string} suggestionId - ID of the suggestion to apply
   * @returns {ApplyResult} Application result
   */
  applySuggestion(suggestionId) {
    const results = this._loadResults();
    const suggestion = results?.suggestions?.find(s => s.id === suggestionId);
    
    if (!suggestion) {
      return { success: false, error: 'Suggestion not found' };
    }
    
    return this._applyOptimization(suggestion);
  }

  /**
   * Reverts an applied optimization.
   *
   * @param {string} optimizationId - ID of optimization to revert
   * @returns {RevertResult} Revert result
   */
  revertOptimization(optimizationId) {
    const optIndex = this._optimizations.applied?.findIndex(o => o.id === optimizationId);
    if (optIndex === -1) {
      return { success: false, error: 'Optimization not found' };
    }
    
    const optimization = this._optimizations.applied[optIndex];
    
    // Remove from registry
    this._optimizations.applied.splice(optIndex, 1);
    this._optimizations.reverted.push({
      ...optimization,
      revertedAt: new Date().toISOString(),
    });
    
    this._saveOptimizations();
    
    console.log(`[PromptAutoOptimizer] ↩️ Reverted optimization "${optimization.id}"`);
    
    return { success: true, optimization };
  }

  /**
   * Records the outcome of an A/B test.
   *
   * @param {object} params - A/B test outcome
   */
  recordABOutcome(params) {
    const { variantA, variantB, winner, winRate, sampleSize } = params;
    
    if (!this._optimizations.abTests) {
      this._optimizations.abTests = [];
    }
    
    this._optimizations.abTests.push({
      id: `ab-${Date.now()}`,
      variantA,
      variantB,
      winner,
      winRate,
      sampleSize,
      timestamp: new Date().toISOString(),
    });
    
    this._saveOptimizations();
    
    console.log(`[PromptAutoOptimizer] 🧪 A/B recorded: ${winner} wins (${(winRate * 100).toFixed(0)}% win rate, n=${sampleSize})`);
  }

  /**
   * Records a single feedback entry from a retrospective signal.
   * Written to agent-feedback-history.jsonl for consumption by analyzeAndOptimize().
   *
   * @param {object} params
   * @param {string} params.stage - Workflow stage (e.g. 'FINISHED')
   * @param {string} params.evidence - Retrospective content (truncated to 200 chars)
   * @param {string} params.signalType - EvolutionSignalType value
   * @param {number} [params.score=0.6] - Quality score (0-1)
   */
  recordFeedback(params) {
    const { stage, evidence, signalType, score = 0.6 } = params;
    const record = {
      id: `FB-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
      target: stage || 'UNKNOWN',
      score,
      issues: [{ type: 'process_improvement', description: (evidence || '').slice(0, 200) }],
      timestamp: new Date().toISOString(),
      metadata: { signalType, source: 'retrospective' },
    };
    const historyPath = path.join(this._outputDir, 'agent-feedback-history.jsonl');
    try {
      const dir = path.dirname(historyPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(historyPath, JSON.stringify(record) + '\n', 'utf-8');
      console.log(`[PromptAutoOptimizer] 📝 Feedback recorded: stage=${stage} signalType=${signalType} id=${record.id}`);
      return record;
    } catch (e) {
      console.log(`[PromptAutoOptimizer] ⚠️ recordFeedback failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  // ─── Private Analysis Methods ───────────────────────────────────────────────

  _analyzeFeedbackPatterns(feedbackHistory) {
    const agentStats = {};
    const issueTypeStats = {};
    const scoreTimeline = [];
    
    for (const record of feedbackHistory) {
      const target = record.target;
      
      // Agent-level stats
      if (!agentStats[target]) {
        agentStats[target] = {
          feedbackCount: 0,
          scores: [],
          issues: {},
          recentScores: [],
        };
      }
      
      const agentStat = agentStats[target];
      agentStat.feedbackCount++;
      agentStat.scores.push(record.score);
      
      // Keep last 10 scores for trending
      agentStat.recentScores.push(record.score);
      if (agentStat.recentScores.length > 10) {
        agentStat.recentScores.shift();
      }
      
      // Issue tracking
      if (record.issues) {
        for (const issue of record.issues) {
          const issueType = issue.type || 'general';
          agentStat.issues[issueType] = (agentStat.issues[issueType] || 0) + 1;
          issueTypeStats[issueType] = (issueTypeStats[issueType] || 0) + 1;
        }
      }
      
      // Timeline
      scoreTimeline.push({
        timestamp: record.timestamp,
        agent: target,
        score: record.score,
      });
    }
    
    // Calculate derived stats
    for (const [agent, stats] of Object.entries(agentStats)) {
      stats.averageScore = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
      stats.recentAverage = stats.recentScores.reduce((a, b) => a + b, 0) / stats.recentScores.length;
      
      // Trend calculation
      if (stats.recentAverage < stats.averageScore - 0.1) {
        stats.trend = 'degrading';
      } else if (stats.recentAverage > stats.averageScore + 0.1) {
        stats.trend = 'improving';
      } else {
        stats.trend = 'stable';
      }
      
      // Top issues
      stats.topIssues = Object.entries(stats.issues)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      // Reliability classification
      if (stats.averageScore >= 0.8) {
        stats.reliability = 'high';
      } else if (stats.averageScore >= 0.6) {
        stats.reliability = 'medium';
      } else {
        stats.reliability = 'low';
      }
    }
    
    return { agentStats, issueTypeStats, scoreTimeline };
  }

  _analyzeABTests(feedbackHistory, promptTraces) {
    // Group feedback by prompt hash (from prompt traces)
    const feedbackByPrompt = {};
    
    for (const record of feedbackHistory) {
      // Simple grouping by metadata or timestamp matching
      const promptId = record.metadata?.promptVariant || 'default';
      if (!feedbackByPrompt[promptId]) {
        feedbackByPrompt[promptId] = [];
      }
      feedbackByPrompt[promptId].push(record);
    }
    
    const results = [];
    
    // Compare variants with sufficient data
    for (const [promptId, feedbacks] of Object.entries(feedbackByPrompt)) {
      if (feedbacks.length >= this._config.minPromptVariantsForAB) {
        const avgScore = feedbacks.reduce((s, f) => s + f.score, 0) / feedbacks.length;
        
        results.push({
          promptId,
          sampleSize: feedbacks.length,
          averageScore: avgScore,
          confidence: this._calculateConfidence(feedbacks.length, avgScore),
        });
      }
    }
    
    return results.sort((a, b) => b.averageScore - a.averageScore);
  }

  _generateSuggestions(patterns, abTestResults) {
    const suggestions = [];
    
    // Generate suggestions based on agent patterns
    for (const [agent, stats] of Object.entries(patterns.agentStats || {})) {
      // Skip if performance is already good
      if (stats.reliability === 'high' && stats.trend !== 'degrading') {
        continue;
      }
      
      // Generate suggestions for top issues
      for (const [issueType, count] of stats.topIssues || []) {
        const optimization = ISSUE_TO_OPTIMIZATION[issueType];
        if (!optimization) continue;
        
        // Calculate confidence based on issue frequency
        const issueRate = count / stats.feedbackCount;
        const confidence = Math.min(0.95, issueRate * 2 + stats.feedbackCount * 0.02);
        
        suggestions.push({
          id: `opt-${agent}-${issueType}-${Date.now()}`,
          agent,
          issueType,
          type: optimization.type,
          description: optimization.description,
          confidence,
          evidence: {
            affectedFeedback: count,
            totalFeedback: stats.feedbackCount,
            issueRate,
            agentAverageScore: stats.averageScore,
            agentTrend: stats.trend,
          },
          suggestion: optimization.template,
          priority: confidence >= this._config.suggestHigh ? 'high' : 
                   confidence >= this._config.suggestMedium ? 'medium' : 'low',
          autoApplicable: confidence >= this._config.autoApply,
        });
      }
      
      // Trend-based suggestions
      if (stats.trend === 'degrading' && stats.averageScore < 0.7) {
        suggestions.push({
          id: `opt-${agent}-trend-${Date.now()}`,
          agent,
          issueType: 'general_quality_decline',
          type: 'quality_review',
          description: `Overall quality declining for ${agent} - comprehensive prompt review recommended`,
          confidence: 0.6,
          evidence: {
            recentAverage: stats.recentAverage,
            overallAverage: stats.averageScore,
            decline: stats.averageScore - stats.recentAverage,
          },
          suggestion: 'Consider full prompt audit and potential rewrite based on recent performance',
          priority: 'high',
          autoApplicable: false,
        });
      }
    }
    
    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  _applyOptimization(suggestion) {
    // Register the optimization
    const optimization = {
      ...suggestion,
      appliedAt: new Date().toISOString(),
      status: 'active',
    };
    
    if (!this._optimizations.applied) {
      this._optimizations.applied = [];
    }
    
    this._optimizations.applied.push(optimization);
    this._saveOptimizations();
    
    console.log(`[PromptAutoOptimizer] ✅ Applied optimization for ${suggestion.agent}: "${suggestion.description}"`);
    
    return { success: true, optimization };
  }

  // ─── Utility Methods ────────────────────────────────────────────────────────

  _calculateConfidence(sampleSize, score) {
    // Simple confidence calculation:
    // - More samples = higher confidence
    // - Scores near 0.5 = lower confidence
    const sampleFactor = Math.min(1, sampleSize / 30); // 30 samples = 100% sample confidence
    const scoreFactor = score > 0.5 ? score : 1 - score; // Confidence in the direction
    return sampleFactor * scoreFactor;
  }

  _loadFeedbackHistory() {
    const historyPath = path.join(this._outputDir, 'agent-feedback-history.jsonl');
    if (!fs.existsSync(historyPath)) return [];
    
    try {
      return fs.readFileSync(historyPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
    } catch (e) {
      return [];
    }
  }

  _loadPromptTraces() {
    const tracesPath = path.join(this._outputDir, 'prompt-traces.jsonl');
    if (!fs.existsSync(tracesPath)) return [];
    
    try {
      return fs.readFileSync(tracesPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
    } catch (e) {
      return [];
    }
  }

  _loadOptimizations() {
    const optPath = path.join(this._outputDir, 'prompt-optimizations-registry.json');
    if (!fs.existsSync(optPath)) {
      return { applied: [], reverted: [], abTests: [] };
    }
    
    try {
      return JSON.parse(fs.readFileSync(optPath, 'utf-8'));
    } catch (e) {
      return { applied: [], reverted: [], abTests: [] };
    }
  }

  _saveOptimizations() {
    const optPath = path.join(this._outputDir, 'prompt-optimizations-registry.json');
    this._writeFile(optPath, JSON.stringify(this._optimizations, null, 2));
  }

  _loadResults() {
    const resultsPath = path.join(this._outputDir, 'prompt-optimization-suggestions.json');
    if (!fs.existsSync(resultsPath)) return null;
    
    try {
      return JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  _saveResults(results) {
    const resultsPath = path.join(this._outputDir, 'prompt-optimization-suggestions.json');
    this._writeFile(resultsPath, JSON.stringify(results, null, 2));
  }

  _writeFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  // ─── Public Report Generation ───────────────────────────────────────────────

  /**
   * Generates a human-readable optimization report.
   *
   * @param {string} [outputPath] - Override output path
   * @returns {string} Generated markdown report
   */
  generateReport(outputPath) {
    const results = this._loadResults();
    if (!results) {
      console.log('[PromptAutoOptimizer] ⚠️ No results to report');
      return null;
    }
    
    const lines = [
      '# Prompt Optimization Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      '',
      `- **Total Feedback Analyzed**: ${results.dataStats?.feedbackCount || 0}`,
      `- **Suggestions Generated**: ${results.suggestions?.length || 0}`,
      `- **Auto-Applied**: ${results.applied?.length || 0}`,
      `- **Pending**: ${results.pending?.length || 0}`,
      '',
      '## Agent Performance',
      '',
    ];
    
    const agentStats = results.patterns?.agentStats || {};
    for (const [agent, stats] of Object.entries(agentStats)) {
      const trendIcon = stats.trend === 'improving' ? '📈' : stats.trend === 'degrading' ? '📉' : '➡️';
      const reliabilityIcon = stats.reliability === 'high' ? '🟢' : stats.reliability === 'medium' ? '🟡' : '🔴';
      
      lines.push(`### ${agent} ${reliabilityIcon}`);
      lines.push('');
      lines.push(`- **Average Score**: ${(stats.averageScore * 100).toFixed(0)}%`);
      lines.push(`- **Trend**: ${trendIcon} ${stats.trend}`);
      lines.push(`- **Feedback Count**: ${stats.feedbackCount}`);
      
      if (stats.topIssues?.length > 0) {
        lines.push('- **Top Issues**:');
        for (const [issue, count] of stats.topIssues) {
          lines.push(`  - ${issue}: ${count}x`);
        }
      }
      lines.push('');
    }
    
    // Suggestions section
    if (results.suggestions?.length > 0) {
      lines.push('## Suggestions');
      lines.push('');
      
      for (const suggestion of results.suggestions) {
        const priorityIcon = suggestion.priority === 'high' ? '🔴' : suggestion.priority === 'medium' ? '🟠' : '🟡';
        lines.push(`### ${priorityIcon} ${suggestion.description}`);
        lines.push('');
        lines.push(`- **Agent**: ${suggestion.agent}`);
        lines.push(`- **Type**: ${suggestion.type}`);
        lines.push(`- **Issue**: ${suggestion.issueType}`);
        lines.push(`- **Confidence**: ${(suggestion.confidence * 100).toFixed(0)}%`);
        lines.push(`- **Priority**: ${suggestion.priority}`);
        lines.push(`- **Auto-Applicable**: ${suggestion.autoApplicable ? '✅' : '❌'}`);
        lines.push('');
        lines.push('**Suggestion**:');
        lines.push('```');
        lines.push(suggestion.suggestion);
        lines.push('```');
        lines.push('');
      }
    }
    
    const reportContent = lines.join('\n');
    
    if (outputPath) {
      this._writeFile(outputPath, reportContent);
      console.log(`[PromptAutoOptimizer] 📝 Report saved: ${outputPath}`);
    }
    
    return reportContent;
  }
}

// ─── Types (JSDoc) ───────────────────────────────────────────────────────────

/**
 * @typedef {object} OptimizationSuggestion
 * @property {string} id
 * @property {string} agent
 * @property {string} issueType
 * @property {string} type
 * @property {string} description
 * @property {number} confidence
 * @property {object} evidence
 * @property {string} suggestion
 * @property {string} priority
 * @property {boolean} autoApplicable
 */

/**
 * @typedef {object} OptimizationAnalysisResult
 * @property {string} status
 * @property {string} timestamp
 * @property {object} dataStats
 * @property {object} patterns
 * @property {Array} abTestResults
 * @property {Array<OptimizationSuggestion>} suggestions
 * @property {Array} applied
 * @property {Array<OptimizationSuggestion>} pending
 */

/**
 * @typedef {object} ApplyResult
 * @property {boolean} success
 * @property {object} [optimization]
 * @property {string} [error]
 */

/**
 * @typedef {object} RevertResult
 * @property {boolean} success
 * @property {object} [optimization]
 * @property {string} [error]
 */

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  PromptAutoOptimizer,
  ISSUE_TO_OPTIMIZATION,
  CONFIDENCE_THRESHOLDS,
};
