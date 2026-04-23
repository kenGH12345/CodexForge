'use strict';

/**
 * ReflectionCycle - Four-Stage Cognitive Loop for Self-Evolution
 *
 * Implements the Kolb Learning Cycle:
 *   1. DECOMPOSE → Concrete Experience (拆分时序/类型)
 *   2. INDUCE    → Reflective Observation (归纳模式)
 *   3. RELATE    → Abstract Conceptualization (联系因果)
 *   4. DISTILL   → Active Experimentation (提炼行动)
 *
 * References:
 *   - Kolb's Experiential Learning Cycle
 *   - Reflexion (Shinn et al., 2023) - dynamic memory & self-reflection
 *   - Voyager (Wang et al., 2023) - skill library & automatic curriculum
 *   - Double-Loop Learning (Argyris) - changing rules vs. correcting errors
 */

const fs = require('fs');
const path = require('path');

// Signal dimensions from multiple sources
const SignalDimension = {
  PERFORMANCE: 'performance',
  QUALITY: 'quality',
  BLINDSPOT: 'blindspot',
  COGNITIVE: 'cognitive',
  USER: 'user'
};

// Action types derived from reflection
const ActionType = {
  SKILL_UPDATE: 'skill-update',
  CONFIG_ADJUST: 'config-adjust',
  MAPE_TRIGGER: 'mape-trigger',
  EXPERIENCE_UPGRADE: 'experience-upgrade',
  COMPLAINT: 'complaint'
};

/** @typedef {object} ReflectionSignal */
/** @typedef {object} DecomposedSignals */
/** @typedef {object} InducedPatterns */
/** @typedef {object} RelatedInsights */
/** @typedef {object} ReflectionAction */

class ReflectionCycle {
  /**
   * @param {object} options
   * @param {string} options.sessionId - Session identifier
   * @param {string} options.projectRoot - Project root directory
   * @param {number} [options.maxRounds=3] - Maximum iteration rounds
   * @param {number} [options.convergenceThreshold=0.7] - Convergence confidence threshold
   * @param {number} [options.llmTriggerThreshold=3] - Minimum signals to trigger LLM
   * @param {function} [options.cheapLlmCall] - Optional LLM call function
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    this.projectRoot = options.projectRoot;
    this.maxRounds = options.maxRounds ?? 3;
    this.convergenceThreshold = options.convergenceThreshold ?? 0.7;
    this.llmTriggerThreshold = options.llmTriggerThreshold ?? 3;
    this.cheapLlmCall = options.cheapLlmCall || null;

    this._round = 0;
    this._converged = false;
    this._unresolvedSignals = [];
  }

  /**
   * Run the complete reflection cycle with iterative convergence
   * @param {ReflectionSignal[]} signals - Raw input signals
   * @param {object} [options] - Runtime options
   * @returns {ReflectionResult} Complete cycle result
   */
  async runCycle(signals, options = {}) {
    this._round = 0;
    this._converged = false;
    let currentSignals = [...signals];
    let allActions = [];
    let allInsights = [];

    while (this._round < this.maxRounds && !this._converged && currentSignals.length > 0) {
      this._round++;

      const roundResult = await this._runSingleRound(currentSignals, options);
      allActions.push(...roundResult.actions);
      allInsights.push(roundResult.insights);

      const confidence = this._calculateConfidence(roundResult);
      this._converged = confidence >= this.convergenceThreshold && roundResult.unresolved.length === 0;
      currentSignals = roundResult.unresolved;
    }

    const unresolvedComplaints = this._round >= this.maxRounds && currentSignals.length > 0
      ? currentSignals.map(s => this._signalToComplaint(s))
      : [];

    return {
      round: this._round,
      converged: this._converged,
      actions: this._deduplicateActions(allActions),
      insights: allInsights,
      unresolvedComplaints
    };
  }

  /**
   * Stage 1: DECOMPOSE - Split input signals by dimension and filter noise
   * @param {ReflectionSignal[]} signals - Raw signals from multiple sources
   * @returns {DecomposedSignals} Structured and filtered signals
   */
  async decompose(signals) {
    if (!signals || signals.length === 0) {
      return { dimensionSignals: {}, crossRefs: [], stats: { total: 0, filtered: 0 } };
    }

    const dimensionSignals = {};
    const crossRefs = [];
    let filtered = 0;

    for (const signal of signals) {
      if ((signal.confidence || 0) < 0.3) {
        filtered++;
        continue;
      }

      const signalTime = new Date(signal.timestamp || Date.now()).getTime();
      const ageHours = (Date.now() - signalTime) / (1000 * 60 * 60);
      if (ageHours > 24) {
        filtered++;
        continue;
      }

      const dim = signal.dimension || this._inferDimension(signal);

      if (!dimensionSignals[dim]) {
        dimensionSignals[dim] = [];
      }
      dimensionSignals[dim].push(signal);

      if (signal.crossDimensions) {
        crossRefs.push({
          signalId: signal.id || this._generateSignalId(signal),
          dimensions: signal.crossDimensions
        });
      }
    }

    return {
      dimensionSignals,
      crossRefs,
      stats: { total: signals.length, filtered, remaining: signals.length - filtered }
    };
  }

  /**
   * Stage 2: INDUCE - Pattern recognition and clustering
   * @param {DecomposedSignals} decomposed - Structured signals from DECOMPOSE
   * @returns {InducedPatterns} Recognized patterns and conflicts
   */
  async induce(decomposed) {
    const patterns = [];
    const conflicts = [];

    for (const [dimension, signals] of Object.entries(decomposed.dimensionSignals)) {
      if (signals.length === 0) continue;

      let clusters;
      try {
        const { ExperienceDistillationMixin } = require('./experience-distillation');
        const distiller = new ExperienceDistillationMixin({
          cheapLlmCall: this.cheapLlmCall
        });
        clusters = await distiller.inducePatterns(signals, dimension);
      } catch {
        clusters = this._ruleBasedClustering(signals, dimension);
      }

      patterns.push(...clusters.patterns || []);
      conflicts.push(...clusters.conflicts || []);
    }

    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        if (patterns[i].dimension !== patterns[j].dimension) {
          const similarity = this._patternSimilarity(patterns[i], patterns[j]);
          if (similarity > 0.6) {
            patterns[i].relatedPatterns = patterns[i].relatedPatterns || [];
            patterns[i].relatedPatterns.push({
              id: patterns[j].id,
              dimension: patterns[j].dimension,
              similarity
            });
          }
        }
      }
    }

    return { patterns, conflicts, coverage: patterns.length > 0 ? 'full' : 'partial' };
  }

  /**
   * Stage 3: RELATE - Cross-signal relationship and causal inference
   * @param {InducedPatterns} induced - Patterns from INDUCE
   * @param {object} [history] - Historical experiences for trend analysis
   * @returns {RelatedInsights} Causal hypotheses, trends, and rule challenges
   */
  async relate(induced, history = []) {
    const causalHypotheses = [];
    const trends = [];
    const ruleChallenges = [];

    const { patterns } = induced;

    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        const p1 = patterns[i];
        const p2 = patterns[j];

        const temporalCorr = this._checkTemporalCorrelation(p1, p2);
        const semanticSim = this._patternSimilarity(p1, p2);

        if (temporalCorr > 0.5 && semanticSim > 0.3) {
          causalHypotheses.push({
            cause: p1.summary,
            causeId: p1.id,
            effect: p2.summary,
            effectId: p2.id,
            confidence: (temporalCorr + semanticSim) / 2,
            type: temporalCorr > 0.8 ? 'strong' : 'weak'
          });
        }
      }
    }

    if (history.length > 0) {
      for (const pattern of patterns) {
        const trend = this._analyzeTrend(pattern, history);
        if (trend.direction !== 'stable') {
          trends.push(trend);
        }
      }
    }

    const frequencyMap = new Map();
    for (const pattern of patterns) {
      const key = pattern.category || pattern.summary;
      frequencyMap.set(key, (frequencyMap.get(key) || 0) + 1);
    }

    for (const [key, count] of frequencyMap.entries()) {
      if (count >= 3) {
        ruleChallenges.push({
          type: 'double_loop',
          pattern: key,
          count,
          suggestion: 'Consider changing the underlying rule/method, not just correcting instances',
          isRuleChange: true
        });
      }
    }

    return { causalHypotheses, trends, ruleChallenges };
  }

  /**
   * Stage 4: DISTILL ACTION - Generate actionable outputs
   * @param {RelatedInsights} insights - Insights from RELATE
   * @param {DecomposedSignals} [decomposed] - Original decomposed signals
   * @returns {ActionableOutputs} Actions ready for execution
   */
  async distillAction(insights, decomposed = null) {
    const actions = [];

    for (const challenge of insights.ruleChallenges || []) {
      if (challenge.isRuleChange) {
        actions.push({
          type: ActionType.SKILL_UPDATE,
          priority: 'HIGH',
          target: `skill/${this._slugify(challenge.pattern)}`,
          current: 'existing rule handling',
          proposed: 'revised rule with systemic fix',
          rationale: `Pattern "${challenge.pattern}" repeated ${challenge.count} times indicates systemic issue`,
          confidence: Math.min(challenge.count / 5, 0.9),
          isRuleChange: true,
          evidence: [challenge.pattern]
        });
      }
    }

    for (const hypothesis of insights.causalHypotheses || []) {
      if (hypothesis.confidence > 0.7) {
        actions.push({
          type: ActionType.CONFIG_ADJUST,
          priority: 'MEDIUM',
          target: `config/${this._slugify(hypothesis.cause)}`,
          current: 'default configuration',
          proposed: `optimize to prevent ${hypothesis.effect}`,
          rationale: `Strong causal link detected: ${hypothesis.cause} → ${hypothesis.effect}`,
          confidence: hypothesis.confidence,
          isRuleChange: false,
          evidence: [hypothesis.causeId, hypothesis.effectId]
        });
      }
    }

    for (const trend of insights.trends || []) {
      if (trend.direction === 'degrading') {
        actions.push({
          type: ActionType.MAPE_TRIGGER,
          priority: trend.severity === 'critical' ? 'CRITICAL' : 'HIGH',
          target: `mape/${trend.metric}`,
          current: 'normal monitoring',
          proposed: 'enhanced monitoring with intervention',
          rationale: `Degrading trend detected: ${trend.metric} declining`,
          confidence: trend.confidence,
          isRuleChange: false,
          evidence: [trend.patternId]
        });
      }
    }

    actions.sort((a, b) => {
      const priorityScore = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
      const scoreA = (priorityScore[a.priority] || 0) * a.confidence;
      const scoreB = (priorityScore[b.priority] || 0) * b.confidence;
      return scoreB - scoreA;
    });

    return {
      actions,
      ruleChanges: actions.filter(a => a.isRuleChange),
      skillUpdates: actions.filter(a => a.type === ActionType.SKILL_UPDATE)
    };
  }

  // Private helper methods...
  async _runSingleRound(signals, options) {
    const decomposed = await this.decompose(signals);

    let history = [];
    try {
      const { ExperienceStore } = require('./experience-store');
      const store = new ExperienceStore({ projectRoot: this.projectRoot });
      history = await store.search({ skill: 'reflection', limit: 50 });
    } catch {
      // History unavailable, proceed without
    }

    const induced = await this.induce(decomposed);
    const insights = await this.relate(induced, history);
    const actionable = await this.distillAction(insights, decomposed);

    const resolvedIds = new Set();
    for (const action of actionable.actions) {
      for (const evidence of action.evidence || []) {
        resolvedIds.add(evidence);
      }
    }

    const unresolved = signals.filter(s => !resolvedIds.has(s.id));

    return {
      decomposed,
      induced,
      insights,
      actions: actionable.actions,
      unresolved
    };
  }

  _inferDimension(signal) {
    if (signal.source?.includes('metric')) return SignalDimension.PERFORMANCE;
    if (signal.source?.includes('test')) return SignalDimension.QUALITY;
    if (signal.source?.includes('blind')) return SignalDimension.BLINDSPOT;
    if (signal.source?.includes('user')) return SignalDimension.USER;
    return SignalDimension.COGNITIVE;
  }

  _ruleBasedClustering(signals, dimension) {
    const clusters = [];
    const visited = new Set();

    for (let i = 0; i < signals.length; i++) {
      if (visited.has(i)) continue;

      const cluster = [signals[i]];
      visited.add(i);

      for (let j = i + 1; j < signals.length; j++) {
        if (visited.has(j)) continue;

        const sim = this._signalSimilarity(signals[i], signals[j]);
        if (sim > 0.7) {
          cluster.push(signals[j]);
          visited.add(j);
        }
      }

      if (cluster.length >= 2) {
        clusters.push({
          id: `pattern-${dimension}-${i}`,
          dimension,
          summary: this._summarizeCluster(cluster),
          signals: cluster.map(s => s.id),
          confidence: cluster.length / signals.length
        });
      }
    }

    return { patterns: clusters, conflicts: [], coverage: clusters.length > 0 ? 'full' : 'partial' };
  }

  _signalSimilarity(s1, s2) {
    const titleSim = this._jaccardSimilarity(
      (s1.title || '').toLowerCase().split(/\s+/),
      (s2.title || '').toLowerCase().split(/\s+/)
    );
    const contentSim = this._jaccardSimilarity(
      (s1.content || '').toLowerCase().split(/\s+/).slice(0, 20),
      (s2.content || '').toLowerCase().split(/\s+/).slice(0, 20)
    );
    return 0.6 * titleSim + 0.4 * contentSim;
  }

  _patternSimilarity(p1, p2) {
    return this._jaccardSimilarity(
      (p1.summary || '').toLowerCase().split(/\s+/),
      (p2.summary || '').toLowerCase().split(/\s+/)
    );
  }

  _checkTemporalCorrelation(p1, p2) {
    const t1 = new Date(p1.firstSeen || Date.now()).getTime();
    const t2 = new Date(p2.firstSeen || Date.now()).getTime();
    const hourDiff = Math.abs(t1 - t2) / (1000 * 60 * 60);

    if (hourDiff < 1) return 0.9;
    if (hourDiff < 6) return 0.7;
    if (hourDiff < 24) return 0.5;
    return 0.3;
  }

  _analyzeTrend(pattern, history) {
    const related = history.filter(h =>
      h.pattern === pattern.category ||
      h.summary?.includes(pattern.summary?.slice(0, 20))
    );

    if (related.length < 3) {
      return { direction: 'stable', confidence: 0.5 };
    }

    const sorted = related.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const mid = Math.floor(sorted.length / 2);
    const earlyCount = sorted.slice(0, mid).length;
    const recentCount = sorted.slice(mid).length;

    if (recentCount > earlyCount * 1.5) {
      return {
        direction: 'degrading',
        metric: pattern.category || pattern.summary,
        window: `${sorted.length} occurrences`,
        confidence: Math.min(recentCount / earlyCount - 1, 0.9),
        severity: recentCount > earlyCount * 2 ? 'critical' : 'high',
        patternId: pattern.id
      };
    }

    return { direction: 'stable', confidence: 0.5, patternId: pattern.id };
  }

  _calculateConfidence(roundResult) {
    const patternCount = roundResult.induced?.patterns?.length || 0;
    const actionCount = roundResult.actions?.length || 0;
    const unresolvedCount = roundResult.unresolved?.length || 0;
    const totalSignals = (roundResult.decomposed?.stats?.remaining || 0) + unresolvedCount;

    if (totalSignals === 0) return 1.0;

    const resolutionRate = 1 - (unresolvedCount / totalSignals);
    const actionDensity = Math.min(actionCount / Math.max(patternCount, 1), 1);

    return (resolutionRate * 0.6) + (actionDensity * 0.4);
  }

  _deduplicateActions(actions) {
    const seen = new Set();
    return actions.filter(a => {
      const key = `${a.type}:${a.target}:${a.proposed}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _signalToComplaint(signal) {
    return {
      target: signal.source || 'unknown',
      evidence: signal.evidence || signal.content || JSON.stringify(signal),
      severity: signal.severity || 'medium',
      reason: 'Unresolved after maximum reflection rounds'
    };
  }

  _summarizeCluster(cluster) {
    if (cluster.length === 0) return '';
    if (cluster.length === 1) return cluster[0].title || cluster[0].content?.slice(0, 50) || 'single signal';

    const titles = cluster.map(c => c.title || c.content || '');
    const common = this._findCommonPrefix(titles);
    return common || `Cluster of ${cluster.length} similar signals`;
  }

  _findCommonPrefix(strings) {
    if (strings.length === 0) return '';
    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
      while (!strings[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (prefix === '') return '';
      }
    }
    return prefix.slice(0, 100);
  }

  _jaccardSimilarity(setA, setB) {
    const intersection = new Set([...setA].filter(x => setB.includes(x)));
    const union = new Set([...setA, ...setB]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  _slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  }

  _generateSignalId(signal) {
    const content = signal.title || signal.content || JSON.stringify(signal);
    return `sig-${Date.now()}-${this._hash(content)}`;
  }

  _hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36).slice(0, 8);
  }
}

function isReflectionCycleEnabled(projectRoot) {
  try {
    const configPath = path.resolve(projectRoot || process.cwd(), 'workflow.config.js');
    const config = require(configPath);
    return config.reflectionCycle?.enabled !== false;
  } catch {
    return true;
  }
}

module.exports = {
  ReflectionCycle,
  SignalDimension,
  ActionType,
  isReflectionCycleEnabled,
};
