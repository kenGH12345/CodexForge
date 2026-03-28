/**
 * Benchmark Runner — 基准测试运行器
 *
 * Purpose: 执行 WorkflowAgent vs AI IDE 的对照实验
 *
 * Features:
 *   - Load benchmark tasks from task bank
 *   - Execute tasks with both IDE and WorkflowAgent
 *   - Collect execution metrics and quality scores
 *   - Generate comparison reports
 *
 * ADR-37 Compliance: Uses fs/path only, IDE-native tooling
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  BenchmarkTask,
  ExecutionResult,
  QualityScores,
  ComparisonResult,
  BenchmarkReport,
  TaskLevel,
  EvaluationDimension,
} = require('./benchmark-types');

const { CodeQualityEvaluator } = require('./code-quality-evaluator');
const { FunctionalityEvaluator } = require('./functionality-evaluator');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Task Bank Loader
// ═══════════════════════════════════════════════════════════════════════════

class TaskBankLoader {
  constructor(taskBankPath) {
    this.taskBankPath = taskBankPath || path.join(__dirname, '../../benchmarks/task-bank');
  }

  /**
   * Loads all tasks from task bank.
   * @returns {BenchmarkTask[]}
   */
  loadAllTasks() {
    const tasksPath = path.join(this.taskBankPath, 'tasks.json');
    
    if (!fs.existsSync(tasksPath)) {
      throw new Error(`Task bank not found: ${tasksPath}`);
    }

    const data = JSON.parse(fs.readFileSync(tasksPath, 'utf-8'));
    return data.tasks.map(t => new BenchmarkTask(t));
  }

  /**
   * Loads tasks filtered by level.
   * @param {string} level - TaskLevel
   * @returns {BenchmarkTask[]}
   */
  loadTasksByLevel(level) {
    return this.loadAllTasks().filter(t => t.level === level);
  }

  /**
   * Loads a specific task.
   * @param {string} taskId
   * @returns {BenchmarkTask|null}
   */
  loadTask(taskId) {
    return this.loadAllTasks().find(t => t.id === taskId) || null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Execution Recorder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Records real executions for benchmark comparison.
 * Note: In actual use, this would integrate with real IDE/Agent executions.
 * For this implementation, we provide the structure for manual or automated recording.
 */
class ExecutionRecorder {
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, '../../benchmarks/results');
    this.ensureOutputDir();
  }

  ensureOutputDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Records a single execution result.
   * @param {string} benchmarkId
   * @param {ExecutionResult} result
   * @returns {string} Path to saved result
   */
  recordExecution(benchmarkId, result) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${benchmarkId}-${result.executor}-${result.taskId}-${timestamp}.json`;
    const filepath = path.join(this.outputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(result, null, 2), 'utf-8');
    return filepath;
  }

  /**
   * Loads execution results for a benchmark.
   * @param {string} benchmarkId
   * @returns {Object} { ide: ExecutionResult[], workflowAgent: ExecutionResult[] }
   */
  loadExecutions(benchmarkId) {
    const files = fs.readdirSync(this.outputDir).filter(f => f.startsWith(benchmarkId));
    
    const results = {
      ide: [],
      workflowAgent: [],
    };

    for (const file of files) {
      const filepath = path.join(this.outputDir, file);
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
      const result = new ExecutionResult(data);

      if (result.executor === 'ide') {
        results.ide.push(result);
      } else if (result.executor === 'workflow-agent') {
        results.workflowAgent.push(result);
      }
    }

    return results;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Quality Scorer
// ═══════════════════════════════════════════════════════════════════════════

class QualityScorer {
  constructor(options = {}) {
    this.projectPath = options.projectPath || process.cwd();
    
    // 新权重：功能正确性 > 完整性 > 代码质量 > 鲁棒性 > 效率 > 体验
    this.dimensionWeights = options.dimensionWeights || {
      [EvaluationDimension.FUNCTIONAL_CORRECTNESS]: 0.25, // MOST CRITICAL
      [EvaluationDimension.FUNCTIONAL_COMPLETENESS]: 0.20,
      [EvaluationDimension.CODE_QUALITY]: 0.20,
      [EvaluationDimension.ROBUSTNESS]: 0.15,
      [EvaluationDimension.DEV_EFFICIENCY]: 0.15,
      [EvaluationDimension.USER_EXPERIENCE]: 0.05,
    };
    
    this.codeEvaluator = new CodeQualityEvaluator({ projectPath: this.projectPath });
    this.functionalityEvaluator = new FunctionalityEvaluator({ verbose: options.verbose });
  }

  /**
   * Computes quality scores for an execution result.
   * @param {ExecutionResult} result
   * @param {BenchmarkTask} task
   * @returns {Promise<QualityScores>}
   */
  async scoreExecution(result, task) {
    const scores = new QualityScores();

    // 1. Functional Correctness (25%) - MOST CRITICAL
    const funcAssessment = await this.functionalityEvaluator.evaluate(result, task);
    scores.functionalCorrectness = funcAssessment.functionalCorrectness;

    // 2. Functional Completeness (20%)
    scores.functionalCompleteness = funcAssessment.functionalCompleteness;

    // 3. Code Quality (20%)
    scores.codeQuality = await this._scoreCodeQuality(result, task);

    // 4. Robustness (15%)
    scores.robustness = await this._scoreRobustness(result, task);

    // 5. Development Efficiency (15%)
    scores.devEfficiency = this._scoreDevEfficiency(result, task);

    // 6. User Experience (5%)
    scores.userExperience = this._scoreUserExperience(result, task);

    // Calculate overall weighted score
    scores.overallScore = this._computeOverallScore(scores);

    return scores;
  }

  async _scoreCodeQuality(result, task) {
    // Use code quality evaluator
    const qualityEvaluation = await this.codeEvaluator.evaluate(result);

    // Read code content for additional checks
    const codeContent = Object.values(result.artifacts || {}).join('\n\n');
    
    return {
      lintScore: qualityEvaluation.lint?.score || 0,
      readability: this._assessReadability(codeContent),
      bestPractices: this._assessBestPractices(codeContent),
      documentationQuality: this._assessDocumentationQuality(result),
      score: qualityEvaluation.overallScore,
    };
  }

  _assessReadability(codeContent) {
    let score = 70; // Base score

    // Check for long lines
    const longLines = (codeContent.match(/.{100,}/g) || []).length;
    score -= Math.min(20, longLines);

    // Check for meaningful variable names (heuristic)
    const shortVars = (codeContent.match(/\b[a-zA-Z]\b/g) || []).length;
    score -= Math.min(10, shortVars);

    // Check for consistent indentation
    if (/\t/.test(codeContent)) score -= 5; // Mixed tabs/spaces

    // Check for function length (average)
    const functions = codeContent.match(/function\s+\w+\s*\([^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
    if (functions.length > 0) {
      const avgLength = functions.reduce((sum, f) => sum + f.split('\n').length, 0) / functions.length;
      if (avgLength > 50) score -= 10;
      else if (avgLength > 30) score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  _assessBestPractices(codeContent) {
    let score = 60; // Base score
    let checks = 0;
    let passed = 0;

    const practices = [
      { pattern: /const |let /, name: 'uses const/let' },
      { pattern: /async |await /, name: 'uses async/await' },
      { pattern: /try\s*\{|catch/, name: 'has error handling' },
      { pattern: /\/\*\*[\s\S]*?\*\//, name: 'has JSDoc' },
      { pattern: /module\.exports|export/, name: 'proper exports' },
      { pattern: /process\.env/, name: 'uses env vars' },
      { pattern: /\.test\(|\.spec\(/, name: 'has tests' },
    ];

    for (const practice of practices) {
      checks++;
      if (practice.pattern.test(codeContent)) passed++;
    }

    score += (passed / checks) * 40;

    return Math.min(100, score);
  }

  _assessDocumentationQuality(result) {
    const artifacts = result.artifacts || {};
    let score = 50;

    // Has README
    if (Object.keys(artifacts).some(f => /readme/i.test(f))) score += 20;

    // Has inline comments
    const codeContent = Object.values(artifacts).join('\n\n');
    const commentRatio = (codeContent.match(/\/\/.*/g) || []).length / 
                         (codeContent.split('\n').length || 1);
    if (commentRatio > 0.1) score += 15;

    // Has JSDoc/TSDoc
    if (codeContent.includes('/**')) score += 15;

    return Math.min(100, score);
  }

  async _scoreRobustness(result, task) {
    const codeContent = Object.values(result.artifacts || {}).join('\n\n');

    const errorHandling = this._assessErrorHandling(codeContent);
    const inputValidation = this._assessInputValidation(codeContent);
    const exceptionSafety = this._assessExceptionSafety(codeContent);
    const resourceCleanup = this._assessResourceCleanup(codeContent);
    const testPassRate = this._extractTestPassRate(result);

    // Compute weighted average
    const score = Math.round(
      errorHandling * 0.30 +
      inputValidation * 0.25 +
      exceptionSafety * 0.20 +
      resourceCleanup * 0.10 +
      testPassRate * 0.15
    );

    return {
      errorHandling,
      inputValidation,
      exceptionSafety,
      resourceCleanup,
      testPassRate,
      score,
    };
  }

  _assessErrorHandling(codeContent) {
    let score = 40;

    // Has try-catch blocks
    const tryCatchCount = (codeContent.match(/try\s*\{/g) || []).length;
    score += Math.min(30, tryCatchCount * 5);

    // Has error throwing
    const throwCount = (codeContent.match(/throw\s+/g) || []).length;
    score += Math.min(20, throwCount * 5);

    // Has error classes/types
    if (/class\s+\w+Error|extends\s+Error/.test(codeContent)) score += 10;

    return Math.min(100, score);
  }

  _assessInputValidation(codeContent) {
    let score = 40;

    const patterns = [
      { pattern: /if\s*\([^)]*(?:null|undefined|None)/, score: 15 },
      { pattern: /typeof|instanceof/, score: 15 },
      { pattern: /\.validate|validator|zod|joi/, score: 20 },
      { pattern: /Array\.isArray|isArray/, score: 10 },
      { pattern: /Number\.isNaN|isNaN/, score: 10 },
    ];

    for (const { pattern, score: addScore } of patterns) {
      if (pattern.test(codeContent)) score += addScore;
    }

    return Math.min(100, score);
  }

  _assessExceptionSafety(codeContent) {
    let score = 60;

    // Has finally blocks (ensures cleanup)
    if (/finally\s*\{/.test(codeContent)) score += 20;

    // Has Promise catch
    const catchCount = (codeContent.match(/\.catch\(/g) || []).length;
    score += Math.min(20, catchCount * 5);

    return Math.min(100, score);
  }

  _assessResourceCleanup(codeContent) {
    let score = 50;

    // Has cleanup patterns
    if (/\.close\(\)|\.destroy\(\)|\.end\(\)|\.release\(\)/.test(codeContent)) score += 25;

    // Has signal handling
    if (/process\.on\(['"]SIG/.test(codeContent)) score += 25;

    return Math.min(100, score);
  }

  _scoreDevEfficiency(result, task) {
    const scores = {
      iterationEfficiency: 0,
      timeEfficiency: 0,
      tokenEfficiency: 0,
      automationLevel: 0,
      score: 0,
    };

    // Iteration efficiency (lower is better, normalized to 0-100)
    const iterations = result.iterationCount || 1;
    scores.iterationEfficiency = iterations <= 3 ? 100 : Math.max(0, 100 - (iterations - 3) * 10);

    // Time efficiency
    const timeLimit = (task.timeLimitMinutes || 30) * 60 * 1000;
    const duration = result.durationMs || timeLimit;
    scores.timeEfficiency = duration <= timeLimit 
      ? 100 
      : Math.max(0, 100 - (duration - timeLimit) / timeLimit * 50);

    // Token efficiency (renamed from resourceEfficiency for clarity)
    const tokenBudget = task.tokenBudget || 100000;
    const tokensUsed = result.tokensConsumed || tokenBudget;
    scores.tokenEfficiency = tokensUsed <= tokenBudget 
      ? Math.round(100 * (1 - tokensUsed / tokenBudget * 0.5)) 
      : Math.max(0, 100 - (tokensUsed - tokenBudget) / tokenBudget * 30);

    // Automation level
    const interventions = result.userInterventionCount || 0;
    scores.automationLevel = interventions === 0 ? 100 : Math.max(0, 100 - interventions * 20);

    // Weighted score
    scores.score = (
      scores.iterationEfficiency * 0.25 +
      scores.timeEfficiency * 0.25 +
      scores.tokenEfficiency * 0.25 +
      scores.automationLevel * 0.25
    );

    return scores;
  }

  _scoreUserExperience(result, task) {
    const explainability = this._assessExplainability(result);
    const controllability = 80; // Placeholder - would require manual survey
    const interactionSmoothness = 85; // Placeholder

    // Compute weighted average (UX focuses on explainability)
    const score = Math.round(
      explainability * 0.40 +
      controllability * 0.30 +
      interactionSmoothness * 0.30
    );

    return {
      explainability,
      controllability,
      interactionSmoothness,
      score,
    };
  }

  _assessExplainability(result) {
    const log = result.executionLog || '';
    let score = 50;

    // Has reasoning steps
    if (/(?:thinking|reasoning|分析|analysis|步骤|step)/i.test(log)) score += 20;

    // Has plan
    if (/(?:plan|strategy|approach|计划)/i.test(log)) score += 15;

    // Has progress updates
    if (/(?:progress|completed|finished|完成)/i.test(log)) score += 15;

    return Math.min(100, score);
  }

  _extractTestPassRate(result) {
    const testReport = result.artifacts?.['test-report.md'] || '';
    const passMatch = testReport.match(/(?:pass|通过)[:\s]*(\d+)%/i);
    if (passMatch) return parseInt(passMatch[1], 10);
    if (/all tests? passed/i.test(testReport)) return 100;
    if (/no tests? failed/i.test(testReport)) return 100;
    return 50;
  }

  _computeOverallScore(scores) {
    return Math.round(
      scores.functionalCorrectness.score * this.dimensionWeights[EvaluationDimension.FUNCTIONAL_CORRECTNESS] +
      scores.functionalCompleteness.score * this.dimensionWeights[EvaluationDimension.FUNCTIONAL_COMPLETENESS] +
      scores.codeQuality.score * this.dimensionWeights[EvaluationDimension.CODE_QUALITY] +
      scores.robustness.score * this.dimensionWeights[EvaluationDimension.ROBUSTNESS] +
      scores.devEfficiency.score * this.dimensionWeights[EvaluationDimension.DEV_EFFICIENCY] +
      scores.userExperience.score * this.dimensionWeights[EvaluationDimension.USER_EXPERIENCE]
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 4: Comparison Analyzer
// ═══════════════════════════════════════════════════════════════════════════

class ComparisonAnalyzer {
  /**
   * Analyzes differences between IDE and WorkflowAgent results.
   * @param {ComparisonResult} comparison
   * @returns {Object} Analysis results
   */
  static analyze(comparison) {
    const deltas = {};
    const insights = [];

    // Calculate deltas for each dimension (new 6-dimension framework)
    const dimensions = [
      'functionalCorrectness',   // 25% - MOST CRITICAL
      'functionalCompleteness',  // 20%
      'codeQuality',             // 20%
      'robustness',              // 15%
      'devEfficiency',           // 15%
      'userExperience',          // 5%
    ];
    
    for (const dim of dimensions) {
      const ideScore = comparison.ideScores?.[dim]?.score || 0;
      const agentScore = comparison.workflowAgentScores?.[dim]?.score || 0;
      
      deltas[dim] = {
        ide: ideScore,
        workflowAgent: agentScore,
        absolute: agentScore - ideScore,
        relative: ideScore > 0 ? ((agentScore - ideScore) / ideScore) * 100 : 0,
      };

      // Generate insights with priority for correctness
      const isCritical = dim === 'functionalCorrectness';
      const threshold = isCritical ? 5 : 10; // Lower threshold for critical dimensions
      
      if (agentScore > ideScore + threshold) {
        insights.push({
          dimension: dim,
          type: isCritical ? 'critical_strength' : 'strength',
          priority: isCritical ? 1 : 2,
          message: `WorkflowAgent ${isCritical ? 'CRITICAL' : ''} advantage in ${dim} (+${(agentScore - ideScore).toFixed(1)} pts)`,
        });
      } else if (ideScore > agentScore + threshold) {
        insights.push({
          dimension: dim,
          type: isCritical ? 'critical_weakness' : 'weakness',
          priority: isCritical ? 1 : 2,
          message: `IDE ${isCritical ? 'CRITICAL' : ''} advantage in ${dim} (+${(ideScore - agentScore).toFixed(1)} pts)`,
        });
      }
    }

    // Determine winner
    const agentOverall = comparison.workflowAgentScores?.overallScore || 0;
    const ideOverall = comparison.ideScores?.overallScore || 0;
    
    let winner = 'tie';
    let margin = 0;
    
    if (agentOverall > ideOverall + 5) {
      winner = 'workflow-agent';
      margin = agentOverall - ideOverall;
    } else if (ideOverall > agentOverall + 5) {
      winner = 'ide';
      margin = ideOverall - agentOverall;
    }

    return {
      deltas,
      insights,
      winner,
      winnerMargin: margin,
    };
  }

  /**
   * Performs statistical analysis on multiple comparisons.
   * @param {ComparisonResult[]} comparisons
   * @returns {Object} Statistical summary
   */
  static statisticalAnalysis(comparisons) {
    if (comparisons.length === 0) return null;

    const scores = {
      ide: comparisons.map(c => c.ideScores?.overallScore || 0),
      agent: comparisons.map(c => c.workflowAgentScores?.overallScore || 0),
    };

    // Calculate means
    const meanIde = scores.ide.reduce((a, b) => a + b, 0) / scores.ide.length;
    const meanAgent = scores.agent.reduce((a, b) => a + b, 0) / scores.agent.length;

    // Calculate standard deviations
    const stdIde = Math.sqrt(scores.ide.reduce((sq, n) => sq + Math.pow(n - meanIde, 2), 0) / scores.ide.length);
    const stdAgent = Math.sqrt(scores.agent.reduce((sq, n) => sq + Math.pow(n - meanAgent, 2), 0) / scores.agent.length);

    // Count wins
    let agentWins = 0;
    let ideWins = 0;
    let ties = 0;

    for (const c of comparisons) {
      const agentScore = c.workflowAgentScores?.overallScore || 0;
      const ideScore = c.ideScores?.overallScore || 0;
      
      if (agentScore > ideScore + 5) agentWins++;
      else if (ideScore > agentScore + 5) ideWins++;
      else ties++;
    }

    return {
      sampleSize: comparisons.length,
      means: { ide: meanIde, agent: meanAgent, delta: meanAgent - meanIde },
      stdDevs: { ide: stdIde, agent: stdAgent },
      winCounts: { agent: agentWins, ide: ideWins, ties },
      winRate: { agent: agentWins / comparisons.length, ide: ideWins / comparisons.length },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 5: Main Benchmark Runner
// ═══════════════════════════════════════════════════════════════════════════

class BenchmarkRunner {
  constructor(options = {}) {
    this.config = options;
    this.taskLoader = new TaskBankLoader(options.taskBankPath);
    this.recorder = new ExecutionRecorder({ outputDir: options.outputDir });
    this.scorer = new QualityScorer({ 
      projectPath: options.projectPath,
      dimensionWeights: options.dimensionWeights,
    });
  }

  /**
   * Runs a complete benchmark suite.
   * @param {Object} options
   * @returns {Promise<BenchmarkReport>}
   */
  async runBenchmark(options = {}) {
    const {
      taskFilter = null,      // Filter by task IDs or levels
      recordOnly = false,     // If true, just record without scoring
    } = options;

    console.log('[BenchmarkRunner] Starting benchmark run...');

    // Load tasks
    let tasks = this.taskLoader.loadAllTasks();
    
    if (taskFilter) {
      if (Array.isArray(taskFilter)) {
        tasks = tasks.filter(t => taskFilter.includes(t.id));
      } else if (taskFilter.level) {
        tasks = tasks.filter(t => t.level === taskFilter.level);
      }
    }

    console.log(`[BenchmarkRunner] Loaded ${tasks.length} tasks`);

    const report = new BenchmarkReport({
      name: `Benchmark-${new Date().toISOString()}`,
      description: `Comparing IDE vs WorkflowAgent on ${tasks.length} tasks`,
      taskCount: tasks.length,
    });

    // Run comparisons for each task
    for (const task of tasks) {
      console.log(`\n[BenchmarkRunner] Processing task: ${task.name} (${task.id})`);
      
      const comparison = await this._compareTask(task);
      report.comparisons.push(comparison);
      
      // Categorize by level
      if (!report.resultsByLevel[task.level]) {
        report.resultsByLevel[task.level] = [];
      }
      report.resultsByLevel[task.level].push(comparison);
    }

    // Generate summary
    this._generateSummary(report);

    // Save report
    this._saveReport(report);

    return report;
  }

  async _compareTask(task) {
    // Load execution results
    const benchmarkId = `benchmark-${Date.now()}`;
    
    // In a real scenario, these would be recorded during actual executions
    // For now, we create placeholder structures
    const ideResult = this._loadOrCreateExecution(benchmarkId, 'ide', task);
    const agentResult = this._loadOrCreateExecution(benchmarkId, 'workflow-agent', task);

    // Score both executions
    const ideScores = await this.scorer.scoreExecution(ideResult, task);
    const agentScores = await this.scorer.scoreExecution(agentResult, task);

    // Create comparison
    const comparison = new ComparisonResult({
      taskId: task.id,
      taskName: task.name,
      taskLevel: task.level,
      ideResult,
      workflowAgentResult: agentResult,
      ideScores,
      workflowAgentScores: agentScores,
    });

    // Analyze differences
    const analysis = ComparisonAnalyzer.analyze(comparison);
    comparison.deltas = analysis.deltas;
    comparison.winner = analysis.winner;
    comparison.winnerMargin = analysis.winnerMargin;
    comparison.keyInsights = analysis.insights;

    return comparison;
  }

  _loadOrCreateExecution(benchmarkId, executor, task) {
    // Try to load from recordings
    const executions = this.recorder.loadExecutions(benchmarkId);
    const existing = (executor === 'ide' ? executions.ide : executions.workflowAgent)
      .find(e => e.taskId === task.id);
    
    if (existing) return existing;

    // Create placeholder
    return new ExecutionResult({
      taskId: task.id,
      executor,
      status: 'pending',
      startTime: new Date().toISOString(),
      artifacts: {},
    });
  }

  _generateSummary(report) {
    const stats = ComparisonAnalyzer.statisticalAnalysis(report.comparisons);
    
    if (stats) {
      report.summary = {
        totalTasks: report.comparisons.length,
        workflowAgentWins: stats.winCounts.agent,
        ideWins: stats.winCounts.ide,
        ties: stats.winCounts.ties,
        avgIdeScore: stats.means.ide,
        avgWorkflowAgentScore: stats.means.agent,
        avgScoreDelta: stats.means.delta,
        confidenceLevel: 0.95,
        isStatisticallySignificant: stats.sampleSize >= 30,
      };

      // Dimension summary
      for (const dim of Object.values(EvaluationDimension)) {
        const ideScores = report.comparisons.map(c => c.ideScores?.[dim]?.score || 0);
        const agentScores = report.comparisons.map(c => c.workflowAgentScores?.[dim]?.score || 0);
        
        report.dimensionSummary[dim] = {
          ide: ideScores.reduce((a, b) => a + b, 0) / ideScores.length,
          workflowAgent: agentScores.reduce((a, b) => a + b, 0) / agentScores.length,
          delta: 0,
        };
        report.dimensionSummary[dim].delta = 
          report.dimensionSummary[dim].workflowAgent - report.dimensionSummary[dim].ide;
      }

      // Identify strengths and weaknesses
      for (const [dim, scores] of Object.entries(report.dimensionSummary)) {
        if (scores.delta > 10) {
          report.strengths.push({ dimension: dim, margin: scores.delta });
        } else if (scores.delta < -10) {
          report.weaknesses.push({ dimension: dim, margin: Math.abs(scores.delta) });
        }
      }

      // Generate recommendations
      if (report.strengths.length > 0) {
        report.recommendations.push(`WorkflowAgent excels in: ${report.strengths.map(s => s.dimension).join(', ')}`);
      }
      if (report.weaknesses.length > 0) {
        report.recommendations.push(`Areas for improvement: ${report.weaknesses.map(w => w.dimension).join(', ')}`);
      }
      if (stats.sampleSize < 30) {
        report.recommendations.push('Increase sample size for statistical significance');
      }
    }
  }

  _saveReport(report) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `benchmark-report-${timestamp}.json`;
    const filepath = path.join(this.config.outputDir || './benchmarks/results', filename);

    fs.writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`\n[BenchmarkRunner] Report saved: ${filepath}`);

    // Also save as latest
    const latestPath = path.join(this.config.outputDir || './benchmarks/results', 'latest-benchmark-report.json');
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf-8');
  }
}

module.exports = {
  BenchmarkRunner,
  TaskBankLoader,
  ExecutionRecorder,
  QualityScorer,
  ComparisonAnalyzer,
};
