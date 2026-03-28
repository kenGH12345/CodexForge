/**
 * Problem Abstraction Engine – Three-layer abstraction for self-evolution
 *
 * This engine bridges the gap between "symptom fixation" and "constitution evolution".
 * It detects patterns from experience records, analyzes trends, and recommends
 * architecture changes when patterns reach critical thresholds.
 *
 * Phase 1 Implementation:
 *   1. PatternDetector – Rule-based pattern recognition from experience records
 *   2. TrendAnalyzer – Statistical trend analysis for architectural health monitoring
 *
 * Phase 2 Implementation:
 *   3. EvolutionRecommender – ADR generation and architecture change management
 *
 * Phase 3 Implementation:
 *   4. CodeGenerator – AST-based code transformation and safe refactoring
 *   5. RefactoringEngine – High-level orchestration of architecture evolution
 *
 * Architecture:
 *   - Rule-based first, LLM fallback only for complex patterns
 *   - Zero LLM calls for known patterns (ADR-37 compliance)
 *   - Async processing to avoid blocking the main workflow
 *
 * @module problem-abstraction-engine
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EvolutionRecommender } = require('./evolution-recommender');
const { RefactoringEngine } = require('./code-generator');

// ─── Pattern Definitions ────────────────────────────────────────────────────

/**
 * Pre-defined fix patterns that indicate potential architecture issues.
 * These patterns are detected via rule-based matching (regex/content analysis).
 *
 * Pattern structure:
 *   - id: Unique identifier for the pattern
 *   - name: Human-readable name
 *   - description: What this pattern indicates
 *   - symptoms: Array of regex patterns to match in experience content
 *   - severity: 'low' | 'medium' | 'high' | 'critical'
 *   - triggerThreshold: Number of occurrences before triggering evolution recommendation
 *   - evolutionRecommendation: Suggested architecture improvement
 *   - detectionConfidence: Base confidence score (0.0-1.0)
 */
const FIX_PATTERNS = {
  HARDCODED_CONFIG_ENTRY: {
    id: 'HARDCODED_CONFIG_ENTRY',
    name: 'Hardcoded Configuration Entry',
    description: 'Repeated additions to hardcoded lists (IDE signatures, config values, etc.)',
    symptoms: [
      /added.*to.*(?:IDE_SIGNATURES|config|configuration)/i,
      /hardcoded.*list/i,
      /added.*support.*for.*(?:cursor|vscode|claude|windsurf|roo)/i,
      /new.*entry.*in.*SIGNATURES/i,
    ],
    severity: 'medium',
    triggerThreshold: 3,
    evolutionRecommendation: 'Implement Provider Pattern for dynamic configuration',
    detectionConfidence: 0.9,
    category: 'config_system',
  },

  SIMILAR_CONDITIONALS: {
    id: 'SIMILAR_CONDITIONALS',
    name: 'Similar Conditional Branches',
    description: 'Multiple if/else or switch branches with similar logic structure',
    symptoms: [
      /duplicate.*condition/i,
      /similar.*if.*else/i,
      /repeated.*switch.*case/i,
      /copy.*paste.*logic/i,
    ],
    severity: 'medium',
    triggerThreshold: 4,
    evolutionRecommendation: 'Extract Strategy Pattern or use polymorphism',
    detectionConfidence: 0.85,
    category: 'architecture',
  },

  STRING_COMPARISON_CASCADE: {
    id: 'STRING_COMPARISON_CASCADE',
    name: 'String Comparison Cascade',
    description: 'Multiple string equality checks in sequence',
    symptoms: [
      /if.*===.*['"].*['"].*else.*if.*===.*['"]/i,
      /switch.*case.*['"].*:/i,
    ],
    severity: 'low',
    triggerThreshold: 5,
    evolutionRecommendation: 'Replace with Map/Object lookup or enum',
    detectionConfidence: 0.88,
    category: 'stable_pattern',
  },

  DUPLICATE_ERROR_HANDLING: {
    id: 'DUPLICATE_ERROR_HANDLING',
    name: 'Duplicate Error Handling',
    description: 'Same error handling pattern repeated across multiple locations',
    symptoms: [
      /catch.*\{.*console\.error.*\}/i,
      /try.*catch.*finally.*with.*same.*logic/i,
      /repeated.*error.*handling/i,
    ],
    severity: 'medium',
    triggerThreshold: 3,
    evolutionRecommendation: 'Create centralized error handling middleware',
    detectionConfidence: 0.82,
    category: 'stable_pattern',
  },

  MAGIC_NUMBER_MULTIPLE: {
    id: 'MAGIC_NUMBER_MULTIPLE',
    name: 'Magic Numbers in Multiple Places',
    description: 'Same numeric literal used in multiple places without constant',
    symptoms: [
      /magic.*number/i,
      /hardcoded.*\d+.*in.*multiple.*files/i,
      /literal.*value.*should.*be.*constant/i,
    ],
    severity: 'low',
    triggerThreshold: 5,
    evolutionRecommendation: 'Extract named constants or configuration values',
    detectionConfidence: 0.8,
    category: 'stable_pattern',
  },
};

// ─── Pattern Detector ───────────────────────────────────────────────────────

/**
 * PatternDetector – Rule-based pattern recognition from experience records.
 *
 * Analyzes experience records (both positive and negative) to detect
 * recurring fix patterns that indicate deeper architectural issues.
 *
 * Design principles:
 *   1. Rule-based matching first (zero LLM calls for known patterns)
 *   2. Pattern definitions are extensible via configuration
 *   3. Detection results include confidence scores and evidence
 */
class PatternDetector {
  constructor(options = {}) {
    this.patterns = options.patterns || FIX_PATTERNS;
    this.customPatterns = new Map();
    this.detectionHistory = [];
    this.maxHistorySize = options.maxHistorySize || 1000;
  }

  /**
   * Register a custom pattern for detection.
   *
   * @param {string} id - Pattern identifier
   * @param {object} pattern - Pattern definition
   */
  registerPattern(id, pattern) {
    this.customPatterns.set(id, { ...pattern, id, isCustom: true });
  }

  /**
   * Detect patterns in a single experience record.
   *
   * @param {object} experience - Experience record from ExperienceStore
   * @returns {PatternMatch[]}
   */
  detectInExperience(experience) {
    const matches = [];
    const content = `${experience.title} ${experience.content}`.toLowerCase();
    const codeExample = experience.codeExample || '';

    // Check built-in patterns
    for (const [id, pattern] of Object.entries(this.patterns)) {
      const match = this._matchPattern(pattern, content, codeExample, experience);
      if (match) {
        matches.push(match);
      }
    }

    // Check custom patterns
    for (const [id, pattern] of this.customPatterns) {
      const match = this._matchPattern(pattern, content, codeExample, experience);
      if (match) {
        matches.push(match);
      }
    }

    // Record detection
    matches.forEach(m => this._recordDetection(m, experience));

    return matches;
  }

  /**
   * Batch detect patterns across multiple experiences.
   *
   * @param {object[]} experiences - Array of experience records
   * @returns {PatternDetectionResult}
   */
  detectBatch(experiences) {
    const allMatches = [];
    const patternCounts = {};
    const evidenceByPattern = {};

    for (const exp of experiences) {
      const matches = this.detectInExperience(exp);
      allMatches.push(...matches);

      for (const match of matches) {
        patternCounts[match.patternId] = (patternCounts[match.patternId] || 0) + 1;

        if (!evidenceByPattern[match.patternId]) {
          evidenceByPattern[match.patternId] = [];
        }
        evidenceByPattern[match.patternId].push({
          experienceId: exp.id,
          title: exp.title,
          confidence: match.confidence,
          matchedSymptom: match.matchedSymptom,
          timestamp: exp.createdAt,
        });
      }
    }

    // Identify patterns reaching threshold
    const triggeredPatterns = [];
    for (const [patternId, count] of Object.entries(patternCounts)) {
      const pattern = this._getPattern(patternId);
      if (pattern && count >= pattern.triggerThreshold) {
        triggeredPatterns.push({
          patternId,
          patternName: pattern.name,
          occurrenceCount: count,
          threshold: pattern.triggerThreshold,
          severity: pattern.severity,
          recommendation: pattern.evolutionRecommendation,
          evidence: evidenceByPattern[patternId],
          confidence: this._calculateAggregateConfidence(evidenceByPattern[patternId]),
        });
      }
    }

    return {
      totalExperiences: experiences.length,
      totalMatches: allMatches.length,
      uniquePatterns: Object.keys(patternCounts).length,
      patternCounts,
      triggeredPatterns: triggeredPatterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount),
    };
  }

  /**
   * Match a single pattern against experience content.
   *
   * @private
   */
  _matchPattern(pattern, content, codeExample, experience) {
    for (let i = 0; i < pattern.symptoms.length; i++) {
      const symptom = pattern.symptoms[i];
      const regex = symptom instanceof RegExp ? symptom : new RegExp(symptom, 'i');

      const contentMatch = regex.test(content);
      const codeMatch = codeExample && regex.test(codeExample.toLowerCase());

      if (contentMatch || codeMatch) {
        return {
          patternId: pattern.id,
          patternName: pattern.name,
          severity: pattern.severity,
          confidence: pattern.detectionConfidence,
          matchedSymptom: i,
          matchedContent: contentMatch ? 'content' : 'codeExample',
          evidence: {
            experienceId: experience.id,
            category: experience.category,
            createdAt: experience.createdAt,
          },
        };
      }
    }

    return null;
  }

  /**
   * Get pattern definition by ID.
   *
   * @private
   */
  _getPattern(id) {
    return this.patterns[id] || this.customPatterns.get(id);
  }

  /**
   * Calculate aggregate confidence from multiple evidence items.
   *
   * @private
   */
  _calculateAggregateConfidence(evidence) {
    if (!evidence || evidence.length === 0) return 0;
    const avgConfidence = evidence.reduce((sum, e) => sum + e.confidence, 0) / evidence.length;
    // Boost confidence with more evidence, capped at 0.95
    const boost = Math.min(0.15, (evidence.length - 1) * 0.03);
    return Math.min(0.95, avgConfidence + boost);
  }

  /**
   * Record detection for history tracking.
   *
   * @private
   */
  _recordDetection(match, experience) {
    this.detectionHistory.push({
      timestamp: new Date().toISOString(),
      patternId: match.patternId,
      experienceId: experience.id,
      confidence: match.confidence,
    });

    // Trim history if too large
    if (this.detectionHistory.length > this.maxHistorySize) {
      this.detectionHistory = this.detectionHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get detection statistics.
   *
   * @returns {object}
   */
  getStats() {
    const stats = {};
    for (const entry of this.detectionHistory) {
      stats[entry.patternId] = (stats[entry.patternId] || 0) + 1;
    }
    return {
      totalDetections: this.detectionHistory.length,
      byPattern: stats,
      uniquePatterns: Object.keys(stats).length,
    };
  }
}

// ─── Trend Analyzer ─────────────────────────────────────────────────────────

/**
 * TrendAnalyzer – Statistical trend analysis for architectural health monitoring.
 *
 * Tracks metrics over time to identify:
 *   - Increasing frequency of certain fix types
 *   - Architecture entropy growth
 *   - Technical debt accumulation patterns
 *
 * Metrics tracked:
 *   - Pattern occurrence velocity (fixes per week)
 *   - Pattern diversity (how many different patterns)
 *   - Category concentration (which categories dominate)
 *   - Time-to-fix trends
 */
class TrendAnalyzer {
  constructor(options = {}) {
    this.storePath = options.storePath || null;
    this.metrics = {
      daily: new Map(),
      weekly: new Map(),
      monthly: new Map(),
    };
    this.patternTrends = new Map();
    this.architectureEntropy = {
      current: 0,
      history: [],
      maxHistory: 52, // Keep 52 weeks of history
    };
    this._loadMetrics();
  }

  /**
   * Record a pattern occurrence for trend tracking.
   *
   * @param {string} patternId - Pattern identifier
   * @param {object} experience - Experience record
   * @param {Date} [timestamp] - Optional timestamp (defaults to now)
   */
  recordOccurrence(patternId, experience, timestamp = new Date()) {
    const dateKey = this._getDateKey(timestamp);
    const weekKey = this._getWeekKey(timestamp);
    const monthKey = this._getMonthKey(timestamp);

    // Record in time buckets
    this._incMetric(this.metrics.daily, dateKey, patternId);
    this._incMetric(this.metrics.weekly, weekKey, patternId);
    this._incMetric(this.metrics.monthly, monthKey, patternId);

    // Update pattern trend
    if (!this.patternTrends.has(patternId)) {
      this.patternTrends.set(patternId, {
        occurrences: [],
        firstSeen: timestamp.toISOString(),
        category: experience.category,
      });
    }
    this.patternTrends.get(patternId).occurrences.push({
      timestamp: timestamp.toISOString(),
      experienceId: experience.id,
    });

    // Recalculate architecture entropy
    this._recalculateEntropy(timestamp);

    // Persist metrics
    this._saveMetrics();
  }

  /**
   * Get trend analysis for a specific pattern.
   *
   * @param {string} patternId - Pattern identifier
   * @returns {PatternTrend|null}
   */
  getPatternTrend(patternId) {
    const trend = this.patternTrends.get(patternId);
    if (!trend) return null;

    const occurrences = trend.occurrences;
    if (occurrences.length < 2) {
      return { ...trend, velocity: 0, growthRate: 0, trend: 'stable' };
    }

    // Calculate velocity (occurrences per week over last 4 weeks)
    const now = Date.now();
    const fourWeeksAgo = now - 28 * 24 * 60 * 60 * 1000;
    const recentOccurrences = occurrences.filter(o => new Date(o.timestamp).getTime() > fourWeeksAgo);
    const velocity = recentOccurrences.length / 4; // per week

    // Calculate growth rate
    const firstHalf = occurrences.slice(0, Math.floor(occurrences.length / 2));
    const secondHalf = occurrences.slice(Math.floor(occurrences.length / 2));
    const firstHalfRate = firstHalf.length > 0
      ? firstHalf.length / ((new Date(firstHalf[firstHalf.length - 1]?.timestamp || now) - new Date(firstHalf[0]?.timestamp || now)) / (7 * 24 * 60 * 60 * 1000) + 1)
      : 0;
    const secondHalfRate = secondHalf.length > 0
      ? secondHalf.length / ((new Date(secondHalf[secondHalf.length - 1]?.timestamp || now) - new Date(secondHalf[0]?.timestamp || now)) / (7 * 24 * 60 * 60 * 1000) + 1)
      : 0;
    const growthRate = firstHalfRate > 0 ? ((secondHalfRate - firstHalfRate) / firstHalfRate) * 100 : 0;

    // Determine trend direction
    let trendDirection = 'stable';
    if (growthRate > 50) trendDirection = 'accelerating';
    else if (growthRate > 20) trendDirection = 'growing';
    else if (growthRate < -20) trendDirection = 'declining';

    return {
      ...trend,
      totalOccurrences: occurrences.length,
      velocity: Math.round(velocity * 10) / 10,
      growthRate: Math.round(growthRate * 10) / 10,
      trend: trendDirection,
      lastOccurrence: occurrences[occurrences.length - 1]?.timestamp,
    };
  }

  /**
   * Get all pattern trends.
   *
   * @returns {PatternTrend[]}
   */
  getAllTrends() {
    const trends = [];
    for (const patternId of this.patternTrends.keys()) {
      trends.push({
        patternId,
        ...this.getPatternTrend(patternId),
      });
    }
    return trends.sort((a, b) => b.velocity - a.velocity);
  }

  /**
   * Get architecture health report.
   *
   * @returns {ArchitectureHealthReport}
   */
  getHealthReport() {
    const trends = this.getAllTrends();
    const activePatterns = trends.filter(t => t.velocity > 0.5);
    const acceleratingPatterns = trends.filter(t => t.trend === 'accelerating');

    // Calculate category distribution
    const categoryDist = {};
    for (const trend of trends) {
      if (trend.category) {
        categoryDist[trend.category] = (categoryDist[trend.category] || 0) + 1;
      }
    }

    // Calculate entropy trend
    const entropyTrend = this._calculateEntropyTrend();

    // Determine overall health
    let health = 'healthy';
    let riskLevel = 'low';
    if (acceleratingPatterns.length > 2) {
      health = 'critical';
      riskLevel = 'high';
    } else if (activePatterns.length > 5 || entropyTrend === 'increasing') {
      health = 'at-risk';
      riskLevel = 'medium';
    }

    return {
      timestamp: new Date().toISOString(),
      health,
      riskLevel,
      metrics: {
        totalPatterns: trends.length,
        activePatterns: activePatterns.length,
        acceleratingPatterns: acceleratingPatterns.length,
        currentEntropy: Math.round(this.architectureEntropy.current * 100) / 100,
        entropyTrend,
      },
      categoryDistribution: categoryDist,
      topConcerns: acceleratingPatterns.slice(0, 5),
      recommendations: this._generateRecommendations(trends, health),
    };
  }

  /**
   * Increment metric counter.
   *
   * @private
   */
  _incMetric(map, key, patternId) {
    if (!map.has(key)) {
      map.set(key, new Map());
    }
    const patterns = map.get(key);
    patterns.set(patternId, (patterns.get(patternId) || 0) + 1);
  }

  /**
   * Recalculate architecture entropy.
   *
   * @private
   */
  _recalculateEntropy(timestamp) {
    // Shannon entropy of pattern distribution
    const totalOccurrences = Array.from(this.patternTrends.values())
      .reduce((sum, t) => sum + t.occurrences.length, 0);

    if (totalOccurrences === 0) {
      this.architectureEntropy.current = 0;
      return;
    }

    let entropy = 0;
    for (const trend of this.patternTrends.values()) {
      const p = trend.occurrences.length / totalOccurrences;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    this.architectureEntropy.current = entropy;

    // Record weekly snapshot
    const weekKey = this._getWeekKey(timestamp);
    const lastEntry = this.architectureEntropy.history[this.architectureEntropy.history.length - 1];
    if (!lastEntry || lastEntry.week !== weekKey) {
      this.architectureEntropy.history.push({
        week: weekKey,
        entropy: Math.round(entropy * 100) / 100,
        timestamp: timestamp.toISOString(),
      });

      // Trim history
      if (this.architectureEntropy.history.length > this.architectureEntropy.maxHistory) {
        this.architectureEntropy.history = this.architectureEntropy.history.slice(-this.architectureEntropy.maxHistory);
      }
    }
  }

  /**
   * Calculate entropy trend direction.
   *
   * @private
   */
  _calculateEntropyTrend() {
    const history = this.architectureEntropy.history;
    if (history.length < 4) return 'stable';

    const recent = history.slice(-4);
    const first = recent[0].entropy;
    const last = recent[recent.length - 1].entropy;
    const change = ((last - first) / (first || 1)) * 100;

    if (change > 20) return 'increasing';
    if (change < -10) return 'decreasing';
    return 'stable';
  }

  /**
   * Generate recommendations based on trends.
   *
   * @private
   */
  _generateRecommendations(trends, health) {
    const recommendations = [];

    if (health === 'critical') {
      recommendations.push({
        priority: 'P0',
        type: 'architecture_review',
        message: 'Multiple patterns are accelerating—schedule an architecture review immediately',
      });
    }

    const highVelocityPatterns = trends.filter(t => t.velocity >= 2);
    if (highVelocityPatterns.length > 0) {
      recommendations.push({
        priority: 'P1',
        type: 'pattern_abstraction',
        message: `High-velocity patterns detected: ${highVelocityPatterns.map(p => p.patternId).join(', ')}`,
        action: 'Consider creating abstraction layers for these patterns',
      });
    }

    return recommendations;
  }

  /**
   * Get date key for bucketing.
   *
   * @private
   */
  _getDateKey(date) {
    return date.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  /**
   * Get week key for bucketing.
   *
   * @private
   */
  _getWeekKey(date) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10); // Week starts on Sunday
  }

  /**
   * Get month key for bucketing.
   *
   * @private
   */
  _getMonthKey(date) {
    return date.toISOString().slice(0, 7); // YYYY-MM
  }

  /**
   * Load persisted metrics.
   *
   * @private
   */
  _loadMetrics() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (data.patternTrends) {
        this.patternTrends = new Map(Object.entries(data.patternTrends));
      }
      if (data.architectureEntropy) {
        this.architectureEntropy = data.architectureEntropy;
      }
    } catch (err) {
      console.warn(`[TrendAnalyzer] Could not load metrics: ${err.message}`);
    }
  }

  /**
   * Save metrics to disk.
   *
   * @private
   */
  _saveMetrics() {
    if (!this.storePath) return;

    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        patternTrends: Object.fromEntries(this.patternTrends),
        architectureEntropy: this.architectureEntropy,
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[TrendAnalyzer] Could not save metrics: ${err.message}`);
    }
  }
}

// ─── Problem Abstraction Engine ─────────────────────────────────────────────

/**
 * ProblemAbstractionEngine – Main facade for three-layer abstraction.
 *
 * Integrates PatternDetector and TrendAnalyzer to provide:
 *   - Pattern detection from experiences
 *   - Trend analysis and health monitoring
 *   - Evolution recommendations
 *   - Bidirectional pattern-experience association
 */
class ProblemAbstractionEngine {
  constructor(options = {}) {
    this.detector = new PatternDetector(options.detector);
    this.analyzer = new TrendAnalyzer(options.analyzer);
    this.recommender = new EvolutionRecommender({
      adr: {
        outputDir: options.adrOutputDir || './docs/adr-auto',
      },
      queue: {
        storePath: options.storePath || null,
      },
    });

    this.refactoringEngine = new RefactoringEngine({
      generator: {
        outputDir: options.refactorOutputDir || './refactored',
        dryRun: options.dryRun !== false, // Default to dry-run for safety
      },
    });
    this.storePath = options.storePath || null;
    this.triggeredRecommendations = [];
    this.options = options;

    // Bidirectional association: patternId -> Set of supporting experience IDs
    this._patternToExperiences = new Map();
    this._loadSupportingExperiences();
  }

  /**
   * Add supporting experience ID to a pattern (bidirectional association).
   *
   * @param {string} patternId - Pattern identifier
   * @param {string} experienceId - Experience identifier
   */
  addSupportingExperience(patternId, experienceId) {
    if (!this._patternToExperiences.has(patternId)) {
      this._patternToExperiences.set(patternId, new Set());
    }
    this._patternToExperiences.get(patternId).add(experienceId);
    this._saveSupportingExperiences();
  }

  /**
   * Get all supporting experience IDs for a pattern.
   *
   * @param {string} patternId - Pattern identifier
   * @returns {string[]} Array of experience IDs
   */
  getSupportingExperiences(patternId) {
    const experiences = this._patternToExperiences.get(patternId);
    return experiences ? Array.from(experiences) : [];
  }

  /**
   * Get patterns that have supporting experiences.
   *
   * @returns {Map<string, Set<string>>}
   */
  getAllPatternAssociations() {
    return new Map(this._patternToExperiences);
  }

  /**
   * Load supporting experience associations from disk.
   *
   * @private
   */
  _loadSupportingExperiences() {
    if (!this.storePath) return;

    const associationPath = this._getAssociationPath();
    if (!fs.existsSync(associationPath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(associationPath, 'utf-8'));
      if (data.patternToExperiences) {
        this._patternToExperiences = new Map(
          Object.entries(data.patternToExperiences).map(([k, v]) => [k, new Set(v)])
        );
      }
    } catch (err) {
      console.warn(`[ProblemAbstractionEngine] Could not load associations: ${err.message}`);
    }
  }

  /**
   * Save supporting experience associations to disk.
   *
   * @private
   */
  _saveSupportingExperiences() {
    if (!this.storePath) return;

    try {
      const associationPath = this._getAssociationPath();
      const dir = path.dirname(associationPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        patternToExperiences: Object.fromEntries(
          Array.from(this._patternToExperiences.entries()).map(([k, v]) => [k, Array.from(v)])
        ),
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(associationPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[ProblemAbstractionEngine] Could not save associations: ${err.message}`);
    }
  }

  /**
   * Get the path for storing pattern-experience associations.
   *
   * @private
   * @returns {string}
   */
  _getAssociationPath() {
    const dir = path.dirname(this.storePath);
    const base = path.basename(this.storePath, '.json');
    return path.join(dir, `${base}-associations.json`);
  }

  /**
   * Analyze experiences and detect patterns.
   *
   * @param {object[]} experiences - Experience records from ExperienceStore
   * @returns {AbstractionResult}
   */
  analyze(experiences) {
    // Detect patterns
    const detectionResult = this.detector.detectBatch(experiences);

    // Record occurrences for trend analysis
    for (const triggered of detectionResult.triggeredPatterns) {
      for (const evidence of triggered.evidence) {
        const exp = experiences.find(e => e.id === evidence.experienceId);
        if (exp) {
          this.analyzer.recordOccurrence(triggered.patternId, exp, new Date(evidence.timestamp));
        }
      }
    }

    // Get health report
    const healthReport = this.analyzer.getHealthReport();

    // Build recommendations
    const recommendations = this._buildRecommendations(detectionResult, healthReport);

    // Generate ADR proposals for triggered patterns (Phase 2)
    const adrProposals = [];
    for (const triggered of detectionResult.triggeredPatterns) {
      const trend = this.analyzer.getPatternTrend(triggered.patternId);
      const evolutionResult = this.recommender.processTriggeredPattern(triggered, trend);
      adrProposals.push(evolutionResult);
    }

    return {
      timestamp: new Date().toISOString(),
      detection: detectionResult,
      health: healthReport,
      recommendations,
      adrProposals,
      queueStats: this.recommender.getQueueStats(),
      summary: {
        totalExperiencesAnalyzed: experiences.length,
        patternsDetected: detectionResult.uniquePatterns,
        patternsTriggered: detectionResult.triggeredPatterns.length,
        healthStatus: healthReport.health,
        adrProposalsGenerated: adrProposals.length,
        pendingInQueue: this.recommender.getQueueStats().total,
      },
    };
  }

  /**
   * Quick check for a single new experience.
   *
   * @param {object} experience - New experience record
   * @returns {QuickCheckResult}
   */
  quickCheck(experience) {
    const matches = this.detector.detectInExperience(experience);

    const triggeredPatterns = [];
    for (const match of matches) {
      const trend = this.analyzer.getPatternTrend(match.patternId);
      const occurrenceCount = (trend?.occurrences?.length || 0) + 1;
      const pattern = this.detector._getPattern(match.patternId);

      if (pattern && occurrenceCount >= pattern.triggerThreshold) {
        triggeredPatterns.push({
          ...match,
          occurrenceCount,
          threshold: pattern.triggerThreshold,
          recommendation: pattern.evolutionRecommendation,
          velocity: trend?.velocity || 0,
        });
      }

      // Record for trend tracking
      this.analyzer.recordOccurrence(match.patternId, experience);
    }

    return {
      experienceId: experience.id,
      patternsMatched: matches.length,
      triggeredPatterns,
      requiresAttention: triggeredPatterns.length > 0,
    };
  }

  /**
   * Get current architecture health snapshot.
   *
   * @returns {ArchitectureHealthReport}
   */
  getHealthSnapshot() {
    return this.analyzer.getHealthReport();
  }

  /**
   * Build evolution recommendations.
   *
   * @private
   */
  _buildRecommendations(detectionResult, healthReport) {
    const recommendations = [];

    // Pattern-based recommendations
    for (const triggered of detectionResult.triggeredPatterns) {
      const trend = this.analyzer.getPatternTrend(triggered.patternId);
      recommendations.push({
        type: 'pattern_evolution',
        priority: triggered.severity === 'critical' ? 'P0' : triggered.severity === 'high' ? 'P1' : 'P2',
        patternId: triggered.patternId,
        patternName: triggered.patternName,
        occurrenceCount: triggered.occurrenceCount,
        confidence: triggered.confidence,
        message: `${triggered.patternName} detected ${triggered.occurrenceCount} times (threshold: ${triggered.threshold})`,
        recommendation: triggered.recommendation,
        trend: trend?.trend || 'unknown',
        velocity: trend?.velocity || 0,
      });
    }

    // Health-based recommendations
    recommendations.push(...healthReport.recommendations);

    return recommendations.sort((a, b) => {
      const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Core classes
  ProblemAbstractionEngine,
  PatternDetector,
  TrendAnalyzer,

  // Constants
  FIX_PATTERNS,

  // Factory function for easy instantiation
  createEngine: (options) => new ProblemAbstractionEngine(options),
};
