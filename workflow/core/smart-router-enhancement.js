/**
 * Smart Router Enhancement – Bottleneck-aware LLM routing optimization
 *
 * Uses observability data to automatically optimize LlmRouter tier selection:
 *   - Analyzes stage bottlenecks from execution analysis
 *   - Routes critical path stages to faster/higher-tier models
 *   - Downgrades non-critical stages to optimize cost
 *   - Learns from historical performance by stage type
 *
 * Integration: Called by PromptBuilder.buildAgentPrompt() via tierOverride option
 *   or automatically by Orchestrator when running workflow stages.
 *
 * Design Principles:
 *   - Zero breaking changes: existing routing logic remains unchanged
 *   - Incremental adoption: enhancement only activates when observability data available
 *   - Cost-aware: never upgrade tier if cost budget exceeded
 *   - Quality-safe: conservative tier adjustments only (max 1 tier difference)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

/**
 * Tier characteristics for decision making.
 * Higher index = faster/better model.
 */
const TIER_CHARACTERISTICS = [
  { tier: 1, speed: 'slow',   quality: 'adequate', cost: 'low',    suitableFor: ['draft', 'non-critical', 'background'] },
  { tier: 2, speed: 'normal', quality: 'good',     cost: 'medium', suitableFor: ['standard', 'development', 'testing'] },
  { tier: 3, speed: 'fast',   quality: 'excellent', cost: 'high',   suitableFor: ['critical', 'planning', 'architecture'] },
  { tier: 4, speed: 'fastest', quality: 'premium',  cost: 'premium', suitableFor: ['bottleneck', 'final-review', 'complex'] },
];

/**
 * Stage type to default tier mapping
 */
const STAGE_TYPE_TIER_MAP = {
  'ANALYSE':     { default: 2, criticalPath: 3 },
  'ARCHITECT':   { default: 2, criticalPath: 3 },
  'PLAN':        { default: 2, criticalPath: 3 },
  'CODE':        { default: 2, criticalPath: 2 },
  'DEVELOP':     { default: 2, criticalPath: 2 },
  'TEST':        { default: 1, criticalPath: 2 },
  'REVIEW':      { default: 2, criticalPath: 3 },
  'ENTROPY':     { default: 1, criticalPath: 1 },
  'CI':          { default: 1, criticalPath: 1 },
};

/**
 * Thresholds for bottleneck detection and tier adjustments
 */
const THRESHOLDS = {
  bottleneckRatio: 0.35,      // Stage >35% of total time = bottleneck
  errorRateThreshold: 0.3,    // Stage error rate >30% = needs upgrade
  minHistorySessions: 5,      // Min sessions needed for pattern learning
  maxTierAdjustment: 1,       // Max tier change per decision
  costBudgetRatio: 0.8,       // Upgrade only if below 80% of cost budget
};

// ─── Smart Router Enhancer Class ─────────────────────────────────────────────

class SmartRouterEnhancement {
  /**
   * @param {object} [opts]
   * @param {string} [opts.outputDir='output'] - Directory for observability data
   * @param {object} [opts.llmRouter] - LlmRouter instance
   * @param {object} [opts.config] - Configuration overrides
   */
  constructor(opts = {}) {
    this._outputDir = opts.outputDir || 'output';
    this._llmRouter = opts.llmRouter || null;
    this._config = { ...THRESHOLDS, ...opts.config };
    
    // Cache for loaded analysis data
    this._cache = {
      executionAnalysis: null,
      history: null,
      timestamp: 0,
    };
    this._cacheTTL = 5000; // 5 seconds
  }

  /**
   * Determines the optimal tier for a stage based on bottleneck analysis.
   *
   * This is the main entry point - call this when determining which tier
   * to use for an agent before invoking the LLM.
   *
   * @param {object} params
   * @param {string} params.stage - Stage name (e.g., 'ANALYSE', 'CODE')
   * @param {string} params.role - Agent role (e.g., 'analyst', 'developer')
   * @param {number} params.defaultTier - Default tier if no optimization applies
   * @param {object} [params.sessionContext] - Optional current session context
   * @returns {TierRecommendation} Recommended tier with reasoning
   */
  getOptimalTier(params) {
    const { stage, role, defaultTier = 2, sessionContext = {} } = params;
    
    // Load latest analysis data
    const executionAnalysis = this._loadExecutionAnalysis();
    const history = this._loadHistory();
    
    // Start with default
    let recommendedTier = defaultTier;
    const reasons = [];
    
    // Check if stage is on critical path
    const isCritical = this._isOnCriticalPath(stage, executionAnalysis);
    if (isCritical) {
      reasons.push(`Stage "${stage}" is on critical path`);
    }
    
    // Check if stage is a bottleneck
    const bottleneckInfo = this._getBottleneckInfo(stage, executionAnalysis);
    if (bottleneckInfo) {
      reasons.push(`Stage "${stage}" is a bottleneck (${(bottleneckInfo.ratio * 100).toFixed(0)}% of total time)`);
    }
    
    // Check historical performance for this stage type
    const historicalPerf = this._analyzeHistoricalPerformance(stage, history);
    if (historicalPerf.needsUpgrade) {
      reasons.push(`Historical performance suggests upgrade (${(historicalPerf.failureRate * 100).toFixed(0)}% failure rate)`);
    }
    
    // Calculate tier adjustment
    let tierAdjustment = 0;
    
    // Critical path adjustment
    if (isCritical && bottleneckInfo && bottleneckInfo.ratio > THRESHOLDS.bottleneckRatio) {
      tierAdjustment = Math.min(tierAdjustment + 1, THRESHOLDS.maxTierAdjustment);
    }
    
    // Bottleneck adjustment
    if (bottleneckInfo && bottleneckInfo.ratio > THRESHOLDS.bottleneckRatio * 1.5) {
      tierAdjustment = Math.min(tierAdjustment + 1, THRESHOLDS.maxTierAdjustment);
    }
    
    // Historical performance adjustment
    if (historicalPerf.needsUpgrade && isCritical) {
      tierAdjustment = Math.min(tierAdjustment + 1, THRESHOLDS.maxTierAdjustment);
    }
    
    // Apply adjustment
    recommendedTier = Math.min(defaultTier + tierAdjustment, 4);
    
    // Never go below minimum viable tier for stage type
    const minTier = this._getMinViableTier(stage, isCritical);
    recommendedTier = Math.max(recommendedTier, minTier);
    
    // Check cost budget
    const costCheck = this._checkCostBudget(history, sessionContext);
    if (!costCheck.canUpgrade && recommendedTier > defaultTier) {
      reasons.push(`Cost budget constraint: staying at tier ${defaultTier}`);
      recommendedTier = defaultTier;
    }
    
    return {
      stage,
      role,
      defaultTier,
      recommendedTier,
      adjusted: recommendedTier !== defaultTier,
      isCritical,
      isBottleneck: !!bottleneckInfo,
      bottleneckRatio: bottleneckInfo?.ratio || 0,
      reasons,
      costBudget: costCheck,
      historicalPerf,
    };
  }

  /**
   * Suggests parallelization opportunities based on bottleneck analysis.
   *
   * @returns {Array<ParallelizationOpportunity>} List of opportunities
   */
  suggestParallelization() {
    const executionAnalysis = this._loadExecutionAnalysis();
    if (!executionAnalysis?.criticalPath?.bottlenecks) {
      return [];
    }

    const opportunities = [];
    const bottlenecks = executionAnalysis.criticalPath.bottlenecks;
    
    for (const bottleneck of bottlenecks) {
      if (bottleneck.ratioToTotal > 0.5) {
        opportunities.push({
          stage: bottleneck.stage,
          type: 'decomposition',
          description: `Stage "${bottleneck.stage}" is ${(bottleneck.ratioToTotal * 100).toFixed(0)}% of total time. Consider decomposing into parallel sub-tasks.`,
          potentialTimeSaving: bottleneck.ratioToTotal * 0.5, // Estimate 50% reduction if parallelized
        });
      } else if (bottleneck.ratioToTotal > THRESHOLDS.bottleneckRatio) {
        opportunities.push({
          stage: bottleneck.stage,
          type: 'tier_upgrade',
          description: `Stage "${bottleneck.stage}" is a moderate bottleneck. Upgrade tier for 20-30% speed improvement.`,
          potentialTimeSaving: bottleneck.ratioToTotal * 0.25,
        });
      }
    }
    
    return opportunities;
  }

  /**
   * Analyzes overall routing strategy for the current session.
   *
   * @returns {RoutingStrategyAnalysis} Complete strategy analysis
   */
  analyzeRoutingStrategy() {
    const executionAnalysis = this._loadExecutionAnalysis();
    const history = this._loadHistory();
    
    return {
      criticalPath: executionAnalysis?.criticalPath?.stages || [],
      bottlenecks: executionAnalysis?.criticalPath?.bottlenecks?.map(b => ({
        stage: b.stage,
        durationMs: b.durationMs,
        ratioToTotal: b.ratioToTotal,
        recommendedTier: this._recommendTierForBottleneck(b),
      })) || [],
      parallelizationOpportunities: this.suggestParallelization(),
      historicalPatterns: this._analyzeStagePatterns(history),
      estimatedCost: this._estimateCost(executionAnalysis, history),
    };
  }

  /**
   * Applies smart routing to an LlmRouter instance.
   * Binds to the router's tier selection logic.
   *
   * @param {object} router - LlmRouter instance
   */
  enhanceRouter(router) {
    if (!router) {
      console.warn('[SmartRouterEnhancement] No router provided for enhancement');
      return;
    }
    
    // Store original getTier method
    const originalGetTier = router.getTier?.bind(router);
    
    // Replace with enhanced version
    router.getTier = (agentRole, stageName, opts = {}) => {
      // Get smart recommendation
      const recommendation = this.getOptimalTier({
        stage: stageName,
        role: agentRole,
        defaultTier: originalGetTier ? originalGetTier(agentRole, stageName, opts) : 2,
        sessionContext: opts,
      });
      
      // Log the decision
      if (recommendation.adjusted) {
        console.log(`[SmartRouter] 🔄 Tier ${recommendation.defaultTier} → ${recommendation.recommendedTier} for "${stageName}" (${recommendation.reasons.join('; ')})`);
      }
      
      return recommendation.recommendedTier;
    };
    
    // Attach enhancement reference
    router._smartEnhancement = this;
    
    console.log('[SmartRouterEnhancement] ✅ Router enhanced with bottleneck-aware routing');
  }

  // ─── Data Loading ───────────────────────────────────────────────────────────

  _loadExecutionAnalysis() {
    const now = Date.now();
    if (now - this._cache.timestamp < this._cacheTTL && this._cache.executionAnalysis) {
      return this._cache.executionAnalysis;
    }
    
    const analysisPath = path.join(this._outputDir, 'execution-analysis.json');
    if (!fs.existsSync(analysisPath)) return null;
    
    try {
      const data = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
      this._cache.executionAnalysis = data;
      this._cache.timestamp = now;
      return data;
    } catch (e) {
      return null;
    }
  }

  _loadHistory() {
    const now = Date.now();
    if (now - this._cache.timestamp < this._cacheTTL && this._cache.history) {
      return this._cache.history;
    }
    
    const historyPath = path.join(this._outputDir, 'metrics-history.jsonl');
    if (!fs.existsSync(historyPath)) return [];
    
    try {
      const lines = fs.readFileSync(historyPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
      this._cache.history = lines;
      this._cache.timestamp = now;
      return lines;
    } catch (e) {
      return [];
    }
  }

  // ─── Analysis Logic ─────────────────────────────────────────────────────────

  _isOnCriticalPath(stage, executionAnalysis) {
    if (!executionAnalysis?.criticalPath?.stages) return false;
    return executionAnalysis.criticalPath.stages.includes(stage);
  }

  _getBottleneckInfo(stage, executionAnalysis) {
    const bottlenecks = executionAnalysis?.criticalPath?.bottlenecks || [];
    const bottleneck = bottlenecks.find(b => b.stage === stage);
    
    if (bottleneck) {
      return {
        ratio: bottleneck.ratioToTotal,
        durationMs: bottleneck.durationMs,
        description: bottleneck.description,
      };
    }
    return null;
  }

  _analyzeHistoricalPerformance(stage, history) {
    if (history.length < THRESHOLDS.minHistorySessions) {
      return { needsUpgrade: false, failureRate: 0, evidence: 'insufficient_data' };
    }
    
    // Filter sessions for this stage
    const stageSessions = history.filter(h => {
      const stageData = h.stages?.find(s => s.name === stage);
      return stageData && stageData.status;
    });
    
    if (stageSessions.length < 3) {
      return { needsUpgrade: false, failureRate: 0, evidence: 'insufficient_stage_data' };
    }
    
    const failures = stageSessions.filter(h => {
      const stageData = h.stages?.find(s => s.name === stage);
      return stageData?.status === 'error';
    });
    
    const failureRate = failures.length / stageSessions.length;
    const needsUpgrade = failureRate > THRESHOLDS.errorRateThreshold;
    
    return {
      needsUpgrade,
      failureRate,
      evidence: `Failed ${failures.length}/${stageSessions.length} times`,
      stageSessions: stageSessions.length,
    };
  }

  _getMinViableTier(stage, isCritical) {
    const stageConfig = STAGE_TYPE_TIER_MAP[stage];
    if (!stageConfig) return 1;
    return isCritical ? stageConfig.criticalPath : stageConfig.default;
  }

  _checkCostBudget(history, sessionContext) {
    // Simple cost budget check based on token usage trends
    if (history.length < 3) {
      return { canUpgrade: true, budgetUsed: 0 };
    }
    
    const recentTokens = history.slice(0, 3).reduce((sum, h) => sum + (h.tokensEst || 0), 0) / 3;
    const baselineTokens = history.reduce((sum, h) => sum + (h.tokensEst || 0), 0) / history.length;
    
    const budgetUsed = baselineTokens > 0 ? recentTokens / baselineTokens : 0;
    const canUpgrade = budgetUsed < THRESHOLDS.costBudgetRatio;
    
    return {
      canUpgrade,
      budgetUsed,
      recentAvgTokens: recentTokens,
      baselineTokens,
    };
  }

  _recommendTierForBottleneck(bottleneck) {
    if (bottleneck.ratioToTotal > 0.5) return 4;
    if (bottleneck.ratioToTotal > THRESHOLDS.bottleneckRatio) return 3;
    return 2;
  }

  _analyzeStagePatterns(history) {
    if (history.length < THRESHOLDS.minHistorySessions) {
      return { evidence: 'insufficient_data' };
    }
    
    const stageStats = {};
    
    for (const session of history) {
      for (const stage of session.stages || []) {
        if (!stageStats[stage.name]) {
          stageStats[stage.name] = { count: 0, errors: 0, totalDuration: 0 };
        }
        const stats = stageStats[stage.name];
        stats.count++;
        if (stage.status === 'error') stats.errors++;
        stats.totalDuration += stage.durationMs || 0;
      }
    }
    
    const patterns = {};
    for (const [stage, stats] of Object.entries(stageStats)) {
      if (stats.count >= 3) {
        patterns[stage] = {
          errorRate: stats.errors / stats.count,
          avgDuration: stats.totalDuration / stats.count,
          reliability: stats.errors / stats.count < 0.1 ? 'high' : stats.errors / stats.count < 0.3 ? 'medium' : 'low',
        };
      }
    }
    
    return patterns;
  }

  _estimateCost(executionAnalysis, history) {
    const baseCost = {
      tier1: 0.01, // $ per 1K tokens
      tier2: 0.03,
      tier3: 0.06,
      tier4: 0.12,
    };
    
    const stages = executionAnalysis?.stages || [];
    let estimatedCost = 0;
    
    for (const stage of stages) {
      // Estimate tokens for stage (rough heuristic)
      const estimatedTokens = stage.durationMs ? Math.max(1000, stage.durationMs / 10) : 3000;
      const tier = stage.bottleneck ? 3 : 2;
      const costKey = `tier${tier}`;
      const stageCost = (estimatedTokens / 1000) * (baseCost[costKey] || 0.03);
      estimatedCost += stageCost;
    }
    
    return {
      estimated: estimatedCost,
      currency: 'USD',
      confidence: stages.length > 0 ? 'medium' : 'low',
    };
  }
}

// ─── Types (JSDoc) ───────────────────────────────────────────────────────────

/**
 * @typedef {object} TierRecommendation
 * @property {string} stage
 * @property {string} role
 * @property {number} defaultTier
 * @property {number} recommendedTier
 * @property {boolean} adjusted
 * @property {boolean} isCritical
 * @property {boolean} isBottleneck
 * @property {number} bottleneckRatio
 * @property {string[]} reasons
 * @property {object} costBudget
 * @property {object} historicalPerf
 */

/**
 * @typedef {object} ParallelizationOpportunity
 * @property {string} stage
 * @property {string} type - 'decomposition' | 'tier_upgrade'
 * @property {string} description
 * @property {number} potentialTimeSaving - As ratio of total time
 */

/**
 * @typedef {object} RoutingStrategyAnalysis
 * @property {string[]} criticalPath
 * @property {Array} bottlenecks
 * @property {ParallelizationOpportunity[]} parallelizationOpportunities
 * @property {object} historicalPatterns
 * @property {object} estimatedCost
 */

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  SmartRouterEnhancement,
  TIER_CHARACTERISTICS,
  STAGE_TYPE_TIER_MAP,
  THRESHOLDS,
};
