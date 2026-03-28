/**
 * Benchmark Types — 评估框架类型定义
 *
 * Purpose: 定义 WorkflowAgent vs AI IDE 对比评估的数据结构
 *
 * ADR-37 Compliance: Pure type definitions, no external deps
 */

'use strict';

/**
 * Benchmark Task Level — 任务复杂度等级
 */
const TaskLevel = Object.freeze({
  SIMPLE: 'simple',           // 简单功能开发 (CRUD, API封装)
  MEDIUM: 'medium',           // 中等复杂度 (重构、跨模块改动)
  COMPLEX: 'complex',         // 复杂问题 (Bug修复、架构调整)
  PRODUCTION: 'production',   // SWE-bench 风格真实 Issues
});

/**
 * Evaluation Dimension — 评估维度
 *
 * 核心原则：功能正确性 > 功能完整性 > 代码质量 > 效率 > 体验
 * 参考：SWE-bench, HumanEval 等业界标准
 */
const EvaluationDimension = Object.freeze({
  FUNCTIONAL_CORRECTNESS: 'functional_correctness',  // 功能正确性 (25%) - MOST CRITICAL
  FUNCTIONAL_COMPLETENESS: 'functional_completeness', // 功能完整性 (20%)
  CODE_QUALITY: 'code_quality',          // 代码质量/规范 (20%)
  ROBUSTNESS: 'robustness',              // 鲁棒性/健壮性 (15%)
  DEV_EFFICIENCY: 'dev_efficiency',      // 开发效率 (15%)
  USER_EXPERIENCE: 'user_experience',    // 用户体验 (5%)
});

/**
 * Task Definition — 标准化任务定义
 */
class BenchmarkTask {
  constructor(props = {}) {
    this.id = props.id || `task-${Date.now()}`;
    this.name = props.name || 'Unnamed Task';
    this.description = props.description || '';
    this.level = props.level || TaskLevel.SIMPLE;
    
    // 任务来源 (GitHub Issue URL, or local description)
    this.source = props.source || 'internal';
    this.sourceUrl = props.sourceUrl || null;
    
    // 预期交付产物
    this.expectedArtifacts = props.expectedArtifacts || [];
    
    // 评估标准
    this.evaluationCriteria = props.evaluationCriteria || {};
    
    // 环境配置
    this.environment = props.environment || {};
    
    // 时间限制 (分钟)
    this.timeLimitMinutes = props.timeLimitMinutes || 30;
    
    // Token 预算
    this.tokenBudget = props.tokenBudget || 100000;
  }
}

/**
 * Execution Result — 单次执行结果
 */
class ExecutionResult {
  constructor(props = {}) {
    this.taskId = props.taskId || null;
    this.executor = props.executor || 'unknown'; // 'ide' or 'workflow-agent'
    
    // 时间指标
    this.startTime = props.startTime || null;
    this.endTime = props.endTime || null;
    this.durationMs = props.durationMs || 0;
    
    // 交互指标
    this.iterationCount = props.iterationCount || 0;  // 迭代/对话轮次
    this.userInterventionCount = props.userInterventionCount || 0;  // 人工介入次数
    
    // 资源消耗
    this.tokensConsumed = props.tokensConsumed || 0;
    this.apiCalls = props.apiCalls || 0;
    
    // 产物
    this.artifacts = props.artifacts || {};  // { filename: content }
    
    // 产出代码统计
    this.codeMetrics = props.codeMetrics || {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      testFilesAdded: 0,
    };
    
    // 执行状态
    this.status = props.status || 'pending'; // pending, success, partial, failed
    this.errorMessage = props.errorMessage || null;
    
    // 原始日志
    this.executionLog = props.executionLog || '';
  }
}

/**
 * Quality Scores — 各维度质量评分
 */
class QualityScores {
  constructor(props = {}) {
    // ═══════════════════════════════════════════════════════════════════
    // 1. 功能正确性 (25%) - MOST CRITICAL
    // ═══════════════════════════════════════════════════════════════════
    this.functionalCorrectness = {
      // 核心功能是否正确实现
      coreLogicCorrectness: props.coreLogicCorrectness || 0,        // 核心逻辑正确性
      edgeCaseHandling: props.edgeCaseHandling || 0,                // 边界情况处理
      typeCorrectness: props.typeCorrectness || 0,                  // 类型正确性 (TS/静态检查)
      outputValidation: props.outputValidation || 0,                // 输出验证准确性
      score: props.functionalCorrectnessScore || 0,
    };

    // ═══════════════════════════════════════════════════════════════════
    // 2. 功能完整性 (20%) - SECOND MOST IMPORTANT
    // ═══════════════════════════════════════════════════════════════════
    this.functionalCompleteness = {
      // 需求覆盖程度
      requirementCoverage: props.requirementCoverage || 0,          // 需求覆盖率
      featureCompleteness: props.featureCompleteness || 0,          // 功能完整度
      apiCompleteness: props.apiCompleteness || 0,                  // API 完整度
      documentationCompleteness: props.documentationCompleteness || 0, // 文档完整度
      score: props.functionalCompletenessScore || 0,
    };

    // ═══════════════════════════════════════════════════════════════════
    // 3. 代码质量 (20%)
    // ═══════════════════════════════════════════════════════════════════
    this.codeQuality = {
      lintScore: props.lintScore || 0,                              // Lint/风格规范
      readability: props.readability || 0,                          // 可读性
      bestPractices: props.bestPractices || 0,                      // 最佳实践遵循
      documentationQuality: props.documentationQuality || 0,        // 代码注释/文档质量
      score: props.codeQualityScore || 0,
    };

    // ═══════════════════════════════════════════════════════════════════
    // 4. 鲁棒性 (15%)
    // ═══════════════════════════════════════════════════════════════════
    this.robustness = {
      errorHandling: props.errorHandling || 0,                      // 错误处理完整性
      inputValidation: props.inputValidation || 0,                  // 输入验证
      exceptionSafety: props.exceptionSafety || 0,                  // 异常安全性
      resourceCleanup: props.resourceCleanup || 0,                  // 资源清理
      testPassRate: props.testPassRate || 0,                        // 测试通过率
      score: props.robustnessScore || 0,
    };
    
    // ═══════════════════════════════════════════════════════════════════
    // 5. 开发效率 (15%)
    // ═══════════════════════════════════════════════════════════════════
    this.devEfficiency = {
      iterationEfficiency: props.iterationEfficiency || 0,          // 迭代轮次效率
      timeEfficiency: props.timeEfficiency || 0,                    // 时间效率
      tokenEfficiency: props.tokenEfficiency || 0,                  // Token 使用效率
      automationLevel: props.automationLevel || 0,                  // 自动化程度
      score: props.devEfficiencyScore || 0,
    };
    
    // ═══════════════════════════════════════════════════════════════════
    // 6. 用户体验 (5%)
    // ═══════════════════════════════════════════════════════════════════
    this.userExperience = {
      explainability: props.explainability || 0,                    // 可解释性
      controllability: props.controllability || 0,                  // 可控性
      interactionSmoothness: props.interactionSmoothness || 0,      // 交互流畅度
      score: props.userExperienceScore || 0,
    };
    
    // 总体加权得分 (按新权重计算)
    this.overallScore = props.overallScore || 0;
  }
}

/**
 * Comparison Result — 单任务对比结果
 */
class ComparisonResult {
  constructor(props = {}) {
    this.taskId = props.taskId || null;
    this.taskName = props.taskName || '';
    this.taskLevel = props.taskLevel || TaskLevel.SIMPLE;
    
    // 两组执行结果
    this.ideResult = props.ideResult || null;           // ExecutionResult
    this.workflowAgentResult = props.workflowAgentResult || null; // ExecutionResult
    
    // 质量评分对比
    this.ideScores = props.ideScores || null;           // QualityScores
    this.workflowAgentScores = props.workflowAgentScores || null; // QualityScores
    
    // 差异分析
    this.deltas = props.deltas || {};  // { dimension: { absolute: x, relative: x% } }
    
    // 胜出者
    this.winner = props.winner || 'tie'; // 'ide', 'workflow-agent', 'tie'
    this.winnerMargin = props.winnerMargin || 0; // 胜出幅度 (百分点)
    
    // 关键洞察
    this.keyInsights = props.keyInsights || [];
    
    // 原始数据路径
    this.rawDataPath = props.rawDataPath || null;
  }
}

/**
 * Benchmark Report — 完整评估报告
 */
class BenchmarkReport {
  constructor(props = {}) {
    this.id = props.id || `benchmark-${Date.now()}`;
    this.name = props.name || 'WorkflowAgent Benchmark';
    this.description = props.description || '';
    
    // 元数据
    this.createdAt = props.createdAt || new Date().toISOString();
    this.taskCount = props.taskCount || 0;
    
    // 任务级别汇总
    this.resultsByLevel = props.resultsByLevel || {
      [TaskLevel.SIMPLE]: [],
      [TaskLevel.MEDIUM]: [],
      [TaskLevel.COMPLEX]: [],
      [TaskLevel.PRODUCTION]: [],
    };
    
    // 所有对比结果
    this.comparisons = props.comparisons || []; // ComparisonResult[]
    
    // 统计汇总
    this.summary = props.summary || {
      totalTasks: 0,
      workflowAgentWins: 0,
      ideWins: 0,
      ties: 0,
      
      // 平均得分
      avgIdeScore: 0,
      avgWorkflowAgentScore: 0,
      avgScoreDelta: 0,  // 平均增量 (正数表示 Agent 胜出)
      
      // 统计置信度
      confidenceLevel: 0.95,
      pValue: null,
      isStatisticallySignificant: false,
    };
    
    // 维度级对比 (6 维评估框架)
    this.dimensionSummary = props.dimensionSummary || {
      [EvaluationDimension.FUNCTIONAL_CORRECTNESS]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.25 },
      [EvaluationDimension.FUNCTIONAL_COMPLETENESS]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.20 },
      [EvaluationDimension.CODE_QUALITY]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.20 },
      [EvaluationDimension.ROBUSTNESS]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.15 },
      [EvaluationDimension.DEV_EFFICIENCY]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.15 },
      [EvaluationDimension.USER_EXPERIENCE]: { ide: 0, workflowAgent: 0, delta: 0, weight: 0.05 },
    };
    
    // 强项与弱项
    this.strengths = props.strengths || [];  // Agent 显著优于 IDE 的维度
    this.weaknesses = props.weaknesses || []; // Agent 弱于 IDE 的维度
    
    // 改进建议
    this.recommendations = props.recommendations || [];
  }
}

/**
 * Benchmark Config — 评估配置
 */
class BenchmarkConfig {
  constructor(props = {}) {
    // 评估维度权重 (6维框架，功能正确性优先)
    this.dimensionWeights = props.dimensionWeights || {
      [EvaluationDimension.FUNCTIONAL_CORRECTNESS]: 0.25,   // MOST CRITICAL
      [EvaluationDimension.FUNCTIONAL_COMPLETENESS]: 0.20,
      [EvaluationDimension.CODE_QUALITY]: 0.20,
      [EvaluationDimension.ROBUSTNESS]: 0.15,
      [EvaluationDimension.DEV_EFFICIENCY]: 0.15,
      [EvaluationDimension.USER_EXPERIENCE]: 0.05,
    };
    
    // 任务库路径
    this.taskBankPath = props.taskBankPath || './benchmarks/task-bank';
    
    // 输出路径
    this.outputPath = props.outputPath || './benchmarks/results';
    
    // 执行配置
    this.parallelExecutions = props.parallelExecutions || false;
    this.maxConcurrency = props.maxConcurrency || 1;
    
    // 统计配置
    this.confidenceLevel = props.confidenceLevel || 0.95;
    this.requireSignificance = props.requireSignificance || true;
    
    // IDE 配置
    this.ideConfig = props.ideConfig || {
      type: 'cursor', // cursor, claude-code, windsurf
      model: 'claude-3-5-sonnet-latest',
    };
    
    // WorkflowAgent 配置
    this.workflowAgentConfig = props.workflowAgentConfig || {
      enableAllFeatures: true,
      qualityGate: true,
      deepAudit: true,
    };
  }
}

module.exports = {
  TaskLevel,
  EvaluationDimension,
  BenchmarkTask,
  ExecutionResult,
  QualityScores,
  ComparisonResult,
  BenchmarkReport,
  BenchmarkConfig,
};
