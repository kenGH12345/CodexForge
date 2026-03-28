/**
 * Experience Abstraction Mixin – Automatic pattern detection for ExperienceStore
 *
 * This mixin adds Problem Abstraction Engine capabilities to ExperienceStore,
 * enabling automatic pattern detection when experiences are recorded.
 *
 * Usage:
 *   const { ExperienceStore } = require('./experience-store');
 *   const { ExperienceAbstractionMixin } = require('./experience-abstraction-mixin');
 *   Object.assign(ExperienceStore.prototype, ExperienceAbstractionMixin);
 *
 * Features:
 *   - Automatic pattern detection on experience record
 *   - Trend analysis with health monitoring
 *   - Triggered recommendations for architecture evolution
 *   - Async processing to avoid blocking
 *
 * @module experience-abstraction-mixin
 */

'use strict';

const path = require('path');
const { ProblemAbstractionEngine } = require('./problem-abstraction-engine');
const { getGlobalEventBus, ExperienceEvents } = require('./experience-event-bus');

// ─── Experience Abstraction Mixin ───────────────────────────────────────────

const ExperienceAbstractionMixin = {
  /**
   * Initialize the abstraction engine.
   * Called automatically on first use if not already initialized.
   */
  _initAbstractionEngine() {
    if (this._abstractionEngine) return;

    const enginePath = path.join(
      path.dirname(this.storePath),
      'problem-abstraction-metrics.json'
    );

    this._abstractionEngine = new ProblemAbstractionEngine({
      storePath: enginePath,
      detector: {
        maxHistorySize: 1000,
      },
    });

    // Pattern detection cache
    this._patternDetectionCache = new Map();
    this._patternCacheMaxSize = 100;

    console.log('[ExperienceAbstraction] Problem Abstraction Engine initialized');
  },

  /**
   * Record an experience with automatic pattern detection.
   * Wraps the original record() method.
   * Implements bidirectional pattern-experience association.
   *
   * @param {object} options - Experience options
   * @returns {Experience & { patternCheck: QuickCheckResult }}
   */
  recordWithAbstraction(options) {
    // Record the experience first
    const experience = this.record(options);

    // Initialize engine if needed
    this._initAbstractionEngine();

    // Run pattern detection (async, non-blocking)
    const patternCheck = this._detectPatternsAsync(experience);

    // Bidirectional association: Experience <-> Pattern
    if (patternCheck.triggeredPatterns && patternCheck.triggeredPatterns.length > 0) {
      // Forward: Experience -> Pattern IDs
      experience.patternIds = patternCheck.triggeredPatterns.map(p => p.patternId);
      experience.abstractionLevel = this._computeAbstractionLevel(experience, patternCheck.triggeredPatterns);

      // Reverse: Pattern -> Supporting Experience IDs
      for (const triggered of patternCheck.triggeredPatterns) {
        this._abstractionEngine.addSupportingExperience(triggered.patternId, experience.id);
      }

      // Update the experience record with pattern associations
      this._updateExperiencePatternAssociations(experience);

      // Event-Driven: Publish pattern detection events for decoupled handling
      const eventBus = getGlobalEventBus();
      for (const triggered of patternCheck.triggeredPatterns) {
        eventBus.emit(ExperienceEvents.PATTERN_TRIGGERED, {
          patternId: triggered.patternId,
          patternName: triggered.patternName,
          experience: experience,
          severity: triggered.severity,
          recommendations: triggered.recommendations,
        });
      }

      eventBus.emit(ExperienceEvents.ABSTRACTION_DETECTED, {
        experienceId: experience.id,
        patternIds: experience.patternIds,
        abstractionLevel: experience.abstractionLevel,
      });

      console.log(`[ExperienceAbstraction] 🔗 Bidirectional association established`);
      console.log(`[ExperienceAbstraction]    Experience ${experience.id} -> ${experience.patternIds.length} patterns`);
    }

    // Attach pattern check result
    experience.patternCheck = patternCheck;

    return experience;
  },

  /**
   * Compute abstraction level based on triggered patterns.
   *
   * @private
   * @param {Experience} experience - Experience record
   * @param {Array} triggeredPatterns - Array of triggered pattern objects
   * @returns {string} Abstraction level ('CONCRETE' | 'PRACTICE' | 'PATTERN' | 'ABSTRACT')
   */
  _computeAbstractionLevel(experience, triggeredPatterns) {
    if (!triggeredPatterns || triggeredPatterns.length === 0) {
      return 'CONCRETE';
    }

    // Check if any high-abstraction patterns are triggered
    const hasHighAbstraction = triggeredPatterns.some(p => {
      const pattern = this._abstractionEngine.detector._getPattern(p.patternId);
      return pattern && pattern.category === 'architecture';
    });

    const hasStablePattern = triggeredPatterns.some(p => {
      const pattern = this._abstractionEngine.detector._getPattern(p.patternId);
      return pattern && pattern.category === 'stable_pattern';
    });

    // Check if experience itself has abstract content indicators
    const content = `${experience.title} ${experience.content}`.toLowerCase();
    const hasAbstractionIndicators = /pattern|abstraction|architect|design|principle/i.test(content);
    const hasWorkaroundIndicators = /workaround|hack|temporary|quick.?fix/i.test(content);

    if (hasHighAbstraction && hasAbstractionIndicators) return 'ABSTRACT';
    if (hasHighAbstraction || hasAbstractionIndicators) return 'PATTERN';
    if (hasWorkaroundIndicators) return 'PRACTICE';
    if (hasStablePattern) return 'PRACTICE';

    return 'CONCRETE';
  },

  /**
   * Update experience record with pattern associations.
   *
   * @private
   * @param {Experience} experience - Experience to update
   */
  _updateExperiencePatternAssociations(experience) {
    // Find and update the experience in the store
    const index = this.experiences.findIndex(e => e.id === experience.id);
    if (index !== -1) {
      this.experiences[index].patternIds = experience.patternIds;
      this.experiences[index].abstractionLevel = experience.abstractionLevel;
      this._save();
    }
  },

  /**
   * Async pattern detection for an experience.
   *
   * @private
   */
  _detectPatternsAsync(experience) {
    try {
      // Quick check for patterns
      const result = this._abstractionEngine.quickCheck(experience);

      // If patterns triggered, log for attention
      if (result.requiresAttention) {
        for (const triggered of result.triggeredPatterns) {
          console.log(`[ExperienceAbstraction] 🔍 Pattern triggered: ${triggered.patternName}`);
          console.log(`[ExperienceAbstraction]    Occurrences: ${triggered.occurrenceCount}/${triggered.threshold}`);
          console.log(`[ExperienceAbstraction]    Recommendation: ${triggered.recommendation}`);
          console.log(`[ExperienceAbstraction]    Velocity: ${triggered.velocity.toFixed(2)}/week`);

          // Cache the detection
          this._cachePatternDetection(experience.id, triggered);
        }
      }

      return result;
    } catch (err) {
      console.warn(`[ExperienceAbstraction] Pattern detection failed: ${err.message}`);
      return { experienceId: experience.id, patternsMatched: 0, triggeredPatterns: [], requiresAttention: false };
    }
  },

  /**
   * Cache pattern detection result.
   *
   * @private
   */
  _cachePatternDetection(experienceId, detection) {
    if (this._patternDetectionCache.size >= this._patternCacheMaxSize) {
      // Remove oldest entry
      const firstKey = this._patternDetectionCache.keys().next().value;
      this._patternDetectionCache.delete(firstKey);
    }

    if (!this._patternDetectionCache.has(experienceId)) {
      this._patternDetectionCache.set(experienceId, []);
    }
    this._patternDetectionCache.get(experienceId).push(detection);
  },

  /**
   * Get pattern detections for an experience.
   *
   * @param {string} experienceId
   * @returns {PatternDetection[]}
   */
  getPatternDetections(experienceId) {
    return this._patternDetectionCache?.get(experienceId) || [];
  },

  /**
   * Get experience with full pattern context (bidirectional association).
   *
   * @param {string} experienceId
   * @returns {object|null} Experience with pattern details
   */
  getExperienceWithPatternContext(experienceId) {
    const experience = this.getById(experienceId);
    if (!experience) return null;

    const patternDetails = (experience.patternIds || []).map(pid => {
      const pattern = this._abstractionEngine?.detector?._getPattern(pid);
      const supportingExps = this._abstractionEngine?.getSupportingExperiences(pid) || [];
      return {
        patternId: pid,
        name: pattern?.name || pid,
        severity: pattern?.severity,
        recommendation: pattern?.evolutionRecommendation,
        occurrenceCount: supportingExps.length,
        isSharedPattern: supportingExps.length > 1,
        otherExperiences: supportingExps.filter(id => id !== experienceId),
      };
    });

    return {
      ...experience,
      patternContext: {
        abstractionLevel: experience.abstractionLevel || 'CONCRETE',
        patternCount: patternDetails.length,
        patterns: patternDetails,
        hasSharedPatterns: patternDetails.some(p => p.isSharedPattern),
      },
    };
  },

  /**
   * Get all experiences associated with a pattern.
   * Reverse lookup: Pattern -> Experiences
   *
   * @param {string} patternId
   * @returns {object[]}
   */
  getExperiencesByPattern(patternId) {
    this._initAbstractionEngine();
    const experienceIds = this._abstractionEngine.getSupportingExperiences(patternId);
    return experienceIds.map(id => this.getById(id)).filter(Boolean);
  },

  /**
   * Get pattern-to-experiences mapping for visualization.
   *
   * @returns {object} Pattern-Experience graph data
   */
  getPatternExperienceGraph() {
    this._initAbstractionEngine();
    const associations = this._abstractionEngine.getAllPatternAssociations();
    const graph = {
      patterns: [],
      experiences: [],
      edges: [],
    };

    for (const [patternId, expIds] of associations) {
      const pattern = this._abstractionEngine.detector._getPattern(patternId);
      graph.patterns.push({
        id: patternId,
        name: pattern?.name || patternId,
        severity: pattern?.severity,
        category: pattern?.category,
        occurrenceCount: expIds.size,
      });

      for (const expId of expIds) {
        graph.edges.push({ patternId, experienceId: expId });
      }
    }

    // Collect unique experiences
    const uniqueExpIds = new Set(graph.edges.map(e => e.experienceId));
    for (const expId of uniqueExpIds) {
      const exp = this.getById(expId);
      if (exp) {
        graph.experiences.push({
          id: expId,
          title: exp.title,
          category: exp.category,
          abstractionLevel: exp.abstractionLevel || 'CONCRETE',
        });
      }
    }

    return graph;
  },

  /**
   * Run full abstraction analysis on all experiences.
   *
   * @returns {AbstractionResult}
   */
  analyzeAbstractions() {
    this._initAbstractionEngine();

    const experiences = this.getAll();
    const result = this._abstractionEngine.analyze(experiences);

    console.log(`[ExperienceAbstraction] Analysis complete`);
    console.log(`[ExperienceAbstraction]   Patterns detected: ${result.summary.patternsDetected}`);
    console.log(`[ExperienceAbstraction]   Patterns triggered: ${result.summary.patternsTriggered}`);
    console.log(`[ExperienceAbstraction]   Health: ${result.health.health}`);

    return result;
  },

  /**
   * Get current architecture health snapshot.
   *
   * @returns {ArchitectureHealthReport}
   */
  getArchitectureHealth() {
    this._initAbstractionEngine();
    return this._abstractionEngine.getHealthSnapshot();
  },

  /**
   * Get triggered recommendations that require action.
   *
   * @param {object} options
   * @param {string} [options.minPriority='P2'] - Minimum priority level (P0, P1, P2, P3)
   * @returns {EvolutionRecommendation[]}
   */
  getEvolutionRecommendations(options = {}) {
    const { minPriority = 'P2' } = options;
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const minLevel = priorityOrder[minPriority] ?? 2;

    const analysis = this.analyzeAbstractions();

    return analysis.recommendations.filter(r => {
      const level = priorityOrder[r.priority] ?? 3;
      return level <= minLevel;
    });
  },

  /**
   * Check if a specific pattern has been triggered.
   *
   * @param {string} patternId - Pattern identifier
   * @returns {boolean}
   */
  isPatternTriggered(patternId) {
    const analysis = this.analyzeAbstractions();
    return analysis.detection.triggeredPatterns.some(p => p.patternId === patternId);
  },

  /**
   * Get trend analysis for a specific pattern.
   *
   * @param {string} patternId - Pattern identifier
   * @returns {PatternTrend|null}
   */
  getPatternTrend(patternId) {
    this._initAbstractionEngine();
    return this._abstractionEngine.analyzer.getPatternTrend(patternId);
  },

  /**
   * Get statistics about pattern detection.
   *
   * @returns {object}
   */
  getAbstractionStats() {
    const detectorStats = this._abstractionEngine?.detector?.getStats?.() || { totalDetections: 0, byPattern: {}, uniquePatterns: 0 };
    const health = this.getArchitectureHealth();

    return {
      detections: detectorStats,
      health: {
        status: health.health,
        riskLevel: health.riskLevel,
        entropy: health.metrics.currentEntropy,
      },
      cacheSize: this._patternDetectionCache?.size || 0,
    };
  },

  /**
   * Register a custom pattern for detection.
   *
   * @param {string} id - Pattern identifier
   * @param {object} pattern - Pattern definition
   */
  registerPattern(id, pattern) {
    this._initAbstractionEngine();
    this._abstractionEngine.detector.registerPattern(id, pattern);
    console.log(`[ExperienceAbstraction] Registered custom pattern: ${id}`);
  },

  /**
   * Run periodic health check and report.
   * Can be scheduled to run weekly/monthly.
   *
   * @returns {HealthCheckReport}
   */
  runHealthCheck() {
    const health = this.getArchitectureHealth();
    const recommendations = this.getEvolutionRecommendations({ minPriority: 'P2' });

    const report = {
      timestamp: new Date().toISOString(),
      health,
      recommendations,
      requiresAction: recommendations.length > 0,
      summary: {
        healthy: health.health === 'healthy',
        atRisk: health.health === 'at-risk',
        critical: health.health === 'critical',
        activePatterns: health.metrics.activePatterns,
        acceleratingPatterns: health.metrics.acceleratingPatterns,
      },
    };

    // Log critical alerts
    if (report.summary.critical) {
      console.error('[ExperienceAbstraction] 🚨 CRITICAL: Architecture health is critical!');
      console.error('[ExperienceAbstraction] Immediate action required.');
    } else if (report.summary.atRisk) {
      console.warn('[ExperienceAbstraction] ⚠️ WARNING: Architecture is at risk');
    }

    return report;
  },

  /**
   * Get pending architecture proposals from the change queue.
   *
   * @returns {ArchitectureProposal[]}
   */
  getPendingArchitectureProposals() {
    this._initAbstractionEngine();
    return this._abstractionEngine.recommender.getPendingProposals();
  },

  /**
   * Get refactoring guidance for a triggered pattern.
   *
   * @param {string} patternId
   * @returns {RefactoringGuide|null}
   */
  getRefactoringGuide(patternId) {
    this._initAbstractionEngine();
    return this._abstractionEngine.recommender.getRefactoringGuide(patternId);
  },

  /**
   * Generate ADR document for a triggered pattern and save to file.
   *
   * @param {string} patternId
   * @returns {string|null} File path of generated ADR
   */
  generateADR(patternId) {
    this._initAbstractionEngine();

    // Check if pattern is triggered
    const analysis = this.analyzeAbstractions();
    const triggered = analysis.detection.triggeredPatterns.find(p => p.patternId === patternId);

    if (!triggered) {
      console.warn(`[ExperienceAbstraction] Pattern ${patternId} not triggered, skipping ADR generation`);
      return null;
    }

    // Process and save ADR
    const trend = this._abstractionEngine.analyzer.getPatternTrend(patternId);
    const result = this._abstractionEngine.recommender.processTriggeredPattern(triggered, trend);

    const filepath = this._abstractionEngine.recommender.saveADRToFile(result.adr.id);

    if (filepath) {
      console.log(`[ExperienceAbstraction] ADR saved: ${filepath}`);
    }

    return filepath;
  },

  /**
   * Get architecture change queue statistics.
   *
   * @returns {object}
   */
  getArchitectureQueueStats() {
    this._initAbstractionEngine();
    return this._abstractionEngine.recommender.getQueueStats();
  },

  // ─── Phase 3: Code Generation ─────────────────────────────────────────

  /**
   * Preview code refactoring for an ADR proposal.
   *
   * @param {string} adrId – ADR identifier
   * @returns {RefactoringPreview|null}
   */
  previewCodeRefactoring(adrId) {
    this._initAbstractionEngine();

    const adrs = this._abstractionEngine.recommender.adrGenerator.getGeneratedADRs();
    const adr = adrs.find(a => a.id === adrId);

    if (!adr) {
      console.warn(`[ExperienceAbstraction] ADR ${adrId} not found`);
      return null;
    }

    return this._abstractionEngine.refactoringEngine.preview(adr);
  },

  /**
   * Generate code files from ADR proposal.
   *
   * @param {string} adrId – ADR identifier
   * @param {object} options
   * @param {boolean} options.dryRun – Preview without writing (default: true)
   * @returns {RefactoringExecutionResult|null}
   */
  generateCodeFromADR(adrId, options = {}) {
    this._initAbstractionEngine();

    const adrs = this._abstractionEngine.recommender.adrGenerator.getGeneratedADRs();
    const adr = adrs.find(a => a.id === adrId);

    if (!adr) {
      console.warn(`[ExperienceAbstraction] ADR ${adrId} not found`);
      return null;
    }

    // Set dry run mode
    this._abstractionEngine.refactoringEngine.generator.dryRun =
      options.dryRun !== false;

    const result = this._abstractionEngine.refactoringEngine.executeFromADR(adr, options);

    if (result.success) {
      console.log(`[ExperienceAbstraction] Code generation complete for ${adrId}`);
      result.operations.forEach(op => {
        if (op.type === 'generate' && op.results) {
          op.results.forEach(r => {
            console.log(`  📄 ${r.filePath}`);
          });
        }
      });
    } else {
      console.error(`[ExperienceAbstraction] Code generation failed: ${result.errors.join(', ')}`);
    }

    return result;
  },

  /**
   * Generate complete Provider Pattern implementation.
   *
   * @param {object} options
   * @returns {GenerationResult[]}
   */
  generateProviderPattern(options = {}) {
    this._initAbstractionEngine();

    const generator = this._abstractionEngine.refactoringEngine.generator;
    const results = generator.generateProviderPattern(options);

    console.log('[ExperienceAbstraction] Generated Provider Pattern files:');
    results.forEach(r => {
      if (r.success) {
        console.log(`  ✅ ${path.basename(r.filePath || r.previewPath)}`);
      } else {
        console.log(`  ❌ ${r.errors.join(', ')}`);
      }
    });

    return results;
  },

  /**
   * Get refactoring audit log.
   *
   * @returns {object[]}
   */
  getRefactoringLog() {
    this._initAbstractionEngine();
    return this._abstractionEngine.refactoringEngine.getAuditLog();
  },
};

// ─── Backward-Compatible Exports ────────────────────────────────────────────

module.exports = {
  ExperienceAbstractionMixin,
};
