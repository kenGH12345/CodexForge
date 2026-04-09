/**
 * Skill Evolution Triggers – Multi-dimensional evolution trigger system
 *
 * Inspired by OpenSpace's 3-trigger architecture, adapted for our rule-first philosophy:
 *
 *   OpenSpace triggers:                    Our triggers:
 *   1. Post-execution analysis (LLM)  →   1. Anomaly-driven (from SelfReflectionEngine)
 *   2. Tool degradation detection      →   2. Skill degradation (from HealthAuditor Check 7)
 *   3. Quality metric check            →   3. Quality gate failure (from QualityGate)
 *   (existing)                         →   4. Hit-count threshold (existing, unchanged)
 *
 * Architecture:
 *   - Listens to events from ExperienceEventBus
 *   - Evaluates trigger conditions using rule-based thresholds
 *   - Emits SKILL_EVOLUTION_TRIGGERED events for the evolution pipeline
 *   - Trigger evaluation is pure rule-based (zero LLM calls)
 *   - High-value triggers (degradation, quality gate failure) invoke SkillLlmRefiner
 *     downstream via cheapLlmCall (~$0.003/call, non-blocking, graceful fallback)
 *
 * @module skill-evolution-triggers
 */

'use strict';

const { getGlobalEventBus, ExperienceEvents, HandlerPriority } = require('./experience-event-bus');
const { introspectionCollector } = require('./workflow-introspection-collector');

// ─── Trigger Types ──────────────────────────────────────────────────────────

const TriggerType = {
  HIT_COUNT:          'hit_count',          // Existing: experience hitCount ≥ threshold
  ANOMALY_DETECTED:   'anomaly_detected',   // SelfReflectionEngine recurring pattern
  SKILL_DEGRADATION:  'skill_degradation',  // HealthAuditor skill effectiveness drop
  QUALITY_GATE_FAIL:  'quality_gate_fail',  // QualityGate breach linked to a skill
  SKILL_STALE:        'skill_stale',        // Skill content not updated in >N days
  SKILL_CONFLICT:     'skill_conflict',     // Two skills with overlapping keywords give contradictory advice
  VERSION_REGRESSION: 'version_regression', // Skill effectiveness dropped after a refine/fix evolution
};

// ─── Configuration ──────────────────────────────────────────────────────────

const TRIGGER_CONFIG = {
  // Trigger 1: Anomaly-driven evolution
  // When a recurring pattern (count ≥ threshold) is detected by SelfReflectionEngine,
  // and the pattern is linked to a skill domain, trigger skill refinement.
  ANOMALY_PATTERN_COUNT_THRESHOLD: 3,  // Pattern must recur ≥3 times

  // Trigger 2: Skill degradation
  // When a skill's effectiveness drops below threshold across recent sessions.
  DEGRADATION_HIT_RATE_THRESHOLD: 0.15,  // hitRate < 15% = degraded
  DEGRADATION_MIN_SESSIONS: 3,           // Need ≥3 sessions of data
  DEGRADATION_MIN_USAGE: 5,              // Need ≥5 total usages

  // Trigger 3: Quality gate failure
  // When a quality gate fails and the failing stage had skills injected,
  // those skills may need updating.
  GATE_FAIL_CONSECUTIVE_THRESHOLD: 2,    // ≥2 consecutive failures for same gate

  // Trigger 4: Skill staleness
  // When a skill hasn't been evolved in >N days but is still being used.
  STALE_DAYS_THRESHOLD: 60,             // 60 days without evolution
  STALE_MIN_USAGE: 3,                   // Must have been used ≥3 times

  // Trigger 5: Skill conflict detection
  // When two active skills share >50% keyword overlap AND both have been injected
  // in the same session, they may give contradictory advice.
  CONFLICT_KEYWORD_OVERLAP_THRESHOLD: 0.5,  // Jaccard overlap ≥ 50%
  CONFLICT_MIN_SHARED_KEYWORDS: 2,          // At least 2 shared keywords

  // Trigger 6: Version regression detection
  // After a refine/fix evolution, if the skill's hitRate drops compared to
  // pre-evolution baseline, the evolution may have degraded the skill.
  REGRESSION_HITRATE_DROP_THRESHOLD: 0.15,  // hitRate dropped by ≥15 percentage points
  REGRESSION_MIN_POST_USAGE: 3,             // Need ≥3 usages after evolution to judge

  // Cooldown: prevent trigger storms
  TRIGGER_COOLDOWN_MS: 24 * 60 * 60 * 1000, // 24 hours per skill per trigger type
};

// ─── Skill Evolution Triggers ───────────────────────────────────────────────

class SkillEvolutionTriggers {
  /**
   * @param {object} options
   * @param {object}   options.skillEvolution  – SkillEvolutionEngine instance
   * @param {object}   [options.skillRefiner]  – SkillLlmRefiner instance (optional, uses cheapLlmCall)
   * @param {object}   [options.config]        – Override TRIGGER_CONFIG values
   */
  constructor(options = {}) {
    this._skillEvolution = options.skillEvolution;
    this._skillRefiner = options.skillRefiner || null;
    this._config = { ...TRIGGER_CONFIG, ...options.config };

    /** @type {Map<string, number>} "skillName:triggerType" → last trigger timestamp */
    this._cooldowns = new Map();

    /** @type {Map<string, number>} "gateName" → consecutive failure count */
    this._gateFailCounts = new Map();

    /** @type {Map<string, { hitRate: number, usageCount: number, effectiveCount: number, timestamp: number }>}
     *  Snapshots of skill metrics taken just before a refine/fix evolution.
     *  Used by Trigger 6 (version regression) to detect post-evolution degradation. */
    this._preEvolutionSnapshots = new Map();

    /** @type {{ triggered: number, cooledDown: number, byType: object }} */
    this._stats = {
      triggered: 0,
      cooledDown: 0,
      byType: {},
    };

    this._unregisters = [];
  }

  // ─── Event Registration ───────────────────────────────────────────────────

  /**
   * Registers event handlers on the global event bus.
   * Call this after all modules are initialised.
   *
   * @returns {Function} Unregister function
   */
  register() {
    const eventBus = getGlobalEventBus();

    // Trigger 1: Anomaly-driven — listen for recurring patterns from SelfReflection
    this._unregisters.push(
      eventBus.on(ExperienceEvents.HEALTH_DEGRADED, (data) => {
        this._handleAnomalyTrigger(data);
      }, { priority: HandlerPriority.LOW })
    );

    // Trigger 2: Skill degradation — listen for health audit findings
    // (HealthAuditor publishes findings via recordIssue → SelfReflection → event)
    // We also check proactively when QUALITY_GATE_PASSED (end of successful run)
    this._unregisters.push(
      eventBus.on(ExperienceEvents.QUALITY_GATE_PASSED, (data) => {
        this._handleDegradationCheck(data);
      }, { priority: HandlerPriority.BACKGROUND })
    );

    // Trigger 3: Quality gate failure — listen for gate failures
    this._unregisters.push(
      eventBus.on(ExperienceEvents.QUALITY_GATE_FAILED, (data) => {
        this._handleQualityGateFailure(data);
      }, { priority: HandlerPriority.LOW })
    );

    // Trigger 4: Staleness check — piggyback on quality gate pass (end of run)
    this._unregisters.push(
      eventBus.on(ExperienceEvents.QUALITY_GATE_PASSED, (data) => {
        this._handleStalenessCheck(data);
      }, { priority: HandlerPriority.BACKGROUND })
    );

    // Trigger 5: Skill conflict detection — check after each run for overlapping skills
    this._unregisters.push(
      eventBus.on(ExperienceEvents.QUALITY_GATE_PASSED, (data) => {
        this._handleConflictCheck(data);
      }, { priority: HandlerPriority.BACKGROUND })
    );

    // Trigger 6: Version regression — listen for skill evolution events
    // Snapshot pre-evolution metrics, then check post-evolution performance
    this._unregisters.push(
      eventBus.on(ExperienceEvents.SKILL_EVOLVED, (data) => {
        this._handleVersionRegressionSnapshot(data);
      }, { priority: HandlerPriority.LOW })
    );
    this._unregisters.push(
      eventBus.on(ExperienceEvents.QUALITY_GATE_PASSED, (data) => {
        this._handleVersionRegressionCheck(data);
      }, { priority: HandlerPriority.BACKGROUND })
    );

    console.log(`[SkillEvolutionTriggers] Registered 7 evolution trigger handlers`);

    return () => {
      this._unregisters.forEach(u => u());
      this._unregisters = [];
      console.log('[SkillEvolutionTriggers] All trigger handlers unregistered');
    };
  }

  // ─── Trigger 1: Anomaly-Driven ────────────────────────────────────────────

  /**
   * When SelfReflectionEngine detects a recurring pattern (≥3 occurrences),
   * check if any skill covers that domain and trigger refinement.
   *
   * @param {object} data – Event payload with pattern info
   * @private
   */
  _handleAnomalyTrigger(data) {
    if (!this._skillEvolution) return;
    const { patternKey, occurrenceCount, severity, relatedSkills } = data || {};

    if (!patternKey) return;
    if ((occurrenceCount || 0) < this._config.ANOMALY_PATTERN_COUNT_THRESHOLD) return;

    // Find skills related to this anomaly pattern
    const targetSkills = relatedSkills || this._findSkillsByPatternKey(patternKey);

    for (const skillName of targetSkills) {
      if (this._isCooledDown(skillName, TriggerType.ANOMALY_DETECTED)) continue;

      this._recordTrigger(skillName, TriggerType.ANOMALY_DETECTED, {
        patternKey,
        occurrenceCount,
        severity,
        action: 'refine',
        reason: `Recurring anomaly pattern "${patternKey}" (${occurrenceCount}x) affects skill domain`,
      });
    }
  }

  // ─── Trigger 2: Skill Degradation ─────────────────────────────────────────

  /**
   * After a successful run, check all skills for effectiveness degradation.
   * Skills with hitRate below threshold are candidates for LLM fix.
   *
   * @param {object} data – Event payload (may contain metrics)
   * @private
   */
  _handleDegradationCheck(data) {
    if (!this._skillEvolution) return;

    for (const meta of this._skillEvolution.registry.values()) {
      if (meta.retiredAt) continue;

      const usage = meta.usageCount || 0;
      const effective = meta.effectiveCount || 0;

      if (usage < this._config.DEGRADATION_MIN_USAGE) continue;

      const hitRate = effective / usage;
      if (hitRate >= this._config.DEGRADATION_HIT_RATE_THRESHOLD) continue;

      if (this._isCooledDown(meta.name, TriggerType.SKILL_DEGRADATION)) continue;

      this._recordTrigger(meta.name, TriggerType.SKILL_DEGRADATION, {
        hitRate: +(hitRate * 100).toFixed(1),
        usageCount: usage,
        effectiveCount: effective,
        action: 'fix',
        reason: `Skill effectiveness degraded: hitRate=${(hitRate * 100).toFixed(1)}% (threshold: ${(this._config.DEGRADATION_HIT_RATE_THRESHOLD * 100)}%)`,
      });
    }
  }

  // ─── Trigger 3: Quality Gate Failure ──────────────────────────────────────

  /**
   * When a quality gate fails, check if the failing stage had skills injected.
   * If the same gate fails consecutively, the injected skills may need updating.
   *
   * @param {object} data – Event payload with gate failure info
   * @private
   */
  _handleQualityGateFailure(data) {
    if (!this._skillEvolution) return;
    const { gateName, injectedSkills, metrics } = data || {};

    if (!gateName) return;

    // Track consecutive failures
    const count = (this._gateFailCounts.get(gateName) || 0) + 1;
    this._gateFailCounts.set(gateName, count);

    if (count < this._config.GATE_FAIL_CONSECUTIVE_THRESHOLD) return;

    // Find skills that were injected during the failing stage
    const targetSkills = injectedSkills || [];

    for (const skillName of targetSkills) {
      if (this._isCooledDown(skillName, TriggerType.QUALITY_GATE_FAIL)) continue;

      this._recordTrigger(skillName, TriggerType.QUALITY_GATE_FAIL, {
        gateName,
        consecutiveFailures: count,
        metrics,
        action: 'refine',
        reason: `Quality gate "${gateName}" failed ${count}x consecutively with skill injected`,
      });
    }
  }

  // ─── Trigger 4: Staleness Check ──────────────────────────────────────────

  /**
   * Check for skills that haven't been evolved recently but are still in use.
   * Stale skills may contain outdated advice.
   *
   * @param {object} data – Event payload
   * @private
   */
  _handleStalenessCheck(data) {
    if (!this._skillEvolution) return;

    const now = Date.now();
    const staleThresholdMs = this._config.STALE_DAYS_THRESHOLD * 24 * 60 * 60 * 1000;

    for (const meta of this._skillEvolution.registry.values()) {
      if (meta.retiredAt) continue;

      const usage = meta.usageCount || 0;
      if (usage < this._config.STALE_MIN_USAGE) continue;

      const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
      const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
      const latestActivity = Math.max(lastEvolved, created);

      if (latestActivity > 0 && (now - latestActivity) > staleThresholdMs) {
        if (this._isCooledDown(meta.name, TriggerType.SKILL_STALE)) continue;

        const daysSinceActivity = Math.round((now - latestActivity) / (24 * 60 * 60 * 1000));

        this._recordTrigger(meta.name, TriggerType.SKILL_STALE, {
          daysSinceActivity,
          usageCount: usage,
          action: 'refine',
          reason: `Skill not evolved in ${daysSinceActivity} days but used ${usage} times`,
        });
      }
    }
  }

  // ─── Trigger Execution ────────────────────────────────────────────────────

  /**
   * Records a trigger event and optionally executes the LLM-Lite action.
   *
   * @param {string} skillName
   * @param {string} triggerType – TriggerType value
   * @param {object} details – Trigger details
   * @private
   */
  _recordTrigger(skillName, triggerType, details) {
    // Update cooldown
    this._cooldowns.set(`${skillName}:${triggerType}`, Date.now());

    // Update stats
    this._stats.triggered++;
    this._stats.byType[triggerType] = (this._stats.byType[triggerType] || 0) + 1;

    console.log(`[SkillEvolutionTriggers] 🎯 Trigger fired: ${triggerType} → "${skillName}" (${details.reason})`);

    // Emit event for downstream processing
    const eventBus = getGlobalEventBus();
    eventBus.emit(ExperienceEvents.SKILL_EVOLVED, {
      skillName,
      triggerType,
      ...details,
      timestamp: new Date().toISOString(),
    });

    // Introspection logging
    introspectionCollector.recordSkill('evolution-triggered', {
      skillName,
      triggerType,
      action: details.action,
      reason: details.reason,
    });

    // LLM-Lite: For high-value triggers (degradation, quality gate failure),
    // invoke SkillLlmRefiner downstream via cheapLlmCall.
    // Low-value triggers (anomaly, staleness) only detect + record + emit.
    // ADR-37: LLM is enhancement, not dependency (graceful fallback on failure).
    const HIGH_VALUE_TRIGGERS = [TriggerType.SKILL_DEGRADATION, TriggerType.QUALITY_GATE_FAIL, TriggerType.VERSION_REGRESSION];
    if (this._skillRefiner && details.action && HIGH_VALUE_TRIGGERS.includes(triggerType)) {
      this._executeLlmLiteAction(skillName, details.action, details).catch(err => {
        console.warn(`[SkillEvolutionTriggers] LLM-Lite action failed for "${skillName}": ${err.message}`);
      });
    }
  }

  /**
   * Executes the LLM-Lite action (refine or fix) for a triggered skill.
   * Only called for high-value triggers. Uses cheapLlmCall (~$0.003/call).
   *
   * @param {string} skillName
   * @param {string} action – 'refine' or 'fix'
   * @param {object} details – Trigger details
   * @private
   */
  async _executeLlmLiteAction(skillName, action, details) {
    if (!this._skillEvolution || !this._skillRefiner) return;

    const meta = this._skillEvolution.registry.get(skillName);
    if (!meta) return;

    const content = this._skillEvolution.readSkill(skillName);
    if (!content) return;

    if (action === 'fix') {
      const result = await this._skillRefiner.fixSkill(meta, content);
      if (result) {
        if (result.action === 'fix' && result.content) {
          this._writeSkillContent(meta, result.content, 'llm-fix', details.reason);
        } else if (result.action === 'retire') {
          meta.retiredAt = new Date().toISOString();
          this._skillEvolution.flushLifecycleStats();
          console.log(`[SkillEvolutionTriggers] 📦 Skill "${skillName}" retired by LLM recommendation`);
        }
      }
    } else if (action === 'refine') {
      const refined = await this._skillRefiner.refineSkill(meta, content);
      if (refined) {
        this._writeSkillContent(meta, refined, 'llm-refine', details.reason);
      }
    }
  }

  /**
   * Writes updated skill content to disk with lineage tracking.
   *
   * @param {object} meta – Skill metadata
   * @param {string} content – New skill content
   * @param {string} lineageType – Lineage node type
   * @param {string} reason – Reason for the update
   * @private
   */
  _writeSkillContent(meta, content, lineageType, reason) {
    const fs = require('fs');

    try {
      const tmpPath = meta.filePath + '.tmp';
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, meta.filePath);

      // Update version
      let [major, minor, patch] = (meta.version || '1.0.0').split('.').map(Number);
      minor += 1;
      if (minor >= 10) { minor = 0; major += 1; }
      const oldVersion = meta.version;
      meta.version = `${major}.${minor}.0`;
      meta.lastEvolvedAt = new Date().toISOString();
      meta.evolutionCount = (meta.evolutionCount || 0) + 1;

      // Record lineage
      this._skillEvolution._recordLineage(meta.name, {
        version: meta.version,
        parentVersion: oldVersion,
        type: lineageType,
        timestamp: meta.lastEvolvedAt,
        summary: reason.slice(0, 120),
        sourceExpId: null,
      });

      this._skillEvolution._saveRegistry();

      console.log(`[SkillEvolutionTriggers] ✅ Skill "${meta.name}" updated: v${oldVersion} → v${meta.version} (${lineageType})`);
    } catch (err) {
      console.warn(`[SkillEvolutionTriggers] Failed to write skill "${meta.name}": ${err.message}`);
    }
  }

  // ─── Trigger 5: Skill Conflict Detection ─────────────────────────────────

  /**
   * Detects active skill pairs with overlapping keywords that may give
   * contradictory advice. Uses Jaccard similarity on keyword sets.
   *
   * Unlike HealthAuditor Check 9 (which runs once per audit), this trigger
   * fires after every successful run, catching conflicts introduced by
   * newly created or evolved skills.
   *
   * @param {object} data – Event payload
   * @private
   */
  _handleConflictCheck(data) {
    if (!this._skillEvolution) return;

    const skillKeywordMap = new Map();
    for (const meta of this._skillEvolution.registry.values()) {
      if (meta.retiredAt) continue;
      const keywords = (meta.triggers && meta.triggers.keywords) || [];
      if (keywords.length >= 2) {
        skillKeywordMap.set(meta.name, new Set(keywords.map(k => k.toLowerCase())));
      }
    }

    const skillNames = [...skillKeywordMap.keys()];
    for (let i = 0; i < skillNames.length; i++) {
      for (let j = i + 1; j < skillNames.length; j++) {
        const nameA = skillNames[i];
        const nameB = skillNames[j];
        const setA = skillKeywordMap.get(nameA);
        const setB = skillKeywordMap.get(nameB);

        let intersection = 0;
        for (const kw of setA) {
          if (setB.has(kw)) intersection++;
        }

        const smaller = Math.min(setA.size, setB.size);
        const overlapRatio = smaller > 0 ? intersection / smaller : 0;

        if (overlapRatio >= this._config.CONFLICT_KEYWORD_OVERLAP_THRESHOLD &&
            intersection >= this._config.CONFLICT_MIN_SHARED_KEYWORDS) {
          // Check cooldown for both skills in the pair
          const pairKey = [nameA, nameB].sort().join(':');
          if (this._isCooledDown(pairKey, TriggerType.SKILL_CONFLICT)) continue;

          const sharedKeywords = [...setA].filter(k => setB.has(k));

          this._recordTrigger(pairKey, TriggerType.SKILL_CONFLICT, {
            skillA: nameA,
            skillB: nameB,
            overlapRatio: +(overlapRatio * 100).toFixed(0),
            sharedKeywords,
            action: 'refine',
            reason: `Skill conflict: "${nameA}" ↔ "${nameB}" share ${intersection} keywords (${(overlapRatio * 100).toFixed(0)}% overlap: [${sharedKeywords.join(', ')}])`,
          });
        }
      }
    }
  }

  // ─── Trigger 6: Version Regression Detection ──────────────────────────────

  /**
   * Snapshots a skill's metrics just before a refine/fix evolution.
   * Called when SKILL_EVOLVED event fires with type 'refine', 'llm-refine',
   * 'llm-fix', or 'restore'.
   *
   * @param {object} data – Event payload from SKILL_EVOLVED
   * @private
   */
  _handleVersionRegressionSnapshot(data) {
    if (!this._skillEvolution) return;
    const { skillName, triggerType } = data || {};
    if (!skillName) return;

    // Only snapshot for LLM-driven evolutions (refine/fix) — these are the ones
    // that might degrade quality. Regular 'evolve' (append) is additive and safe.
    const llmEvolutionTypes = ['refine', 'llm-refine', 'llm-fix', 'restore'];
    const lineageType = data.type || data.lineageType || '';
    if (!llmEvolutionTypes.includes(lineageType) &&
        !llmEvolutionTypes.includes(triggerType)) return;

    const meta = this._skillEvolution.registry.get(skillName);
    if (!meta) return;

    const usage = meta.usageCount || 0;
    const effective = meta.effectiveCount || 0;
    const hitRate = usage > 0 ? effective / usage : 0;

    this._preEvolutionSnapshots.set(skillName, {
      hitRate,
      usageCount: usage,
      effectiveCount: effective,
      version: meta.version,
      timestamp: Date.now(),
    });

    console.log(`[SkillEvolutionTriggers] 📸 Snapshot taken for "${skillName}" before LLM evolution (hitRate=${(hitRate * 100).toFixed(1)}%)`);
  }

  /**
   * After a run completes, checks if any recently-evolved skills have regressed.
   * Compares current hitRate against the pre-evolution snapshot.
   *
   * @param {object} data – Event payload
   * @private
   */
  _handleVersionRegressionCheck(data) {
    if (!this._skillEvolution) return;

    for (const [skillName, snapshot] of this._preEvolutionSnapshots) {
      const meta = this._skillEvolution.registry.get(skillName);
      if (!meta || meta.retiredAt) continue;

      // Calculate post-evolution metrics (only count usage AFTER the snapshot)
      const currentUsage = meta.usageCount || 0;
      const currentEffective = meta.effectiveCount || 0;
      const postUsage = currentUsage - snapshot.usageCount;

      // Need enough post-evolution data to judge
      if (postUsage < this._config.REGRESSION_MIN_POST_USAGE) continue;

      const postEffective = currentEffective - snapshot.effectiveCount;
      const postHitRate = postUsage > 0 ? postEffective / postUsage : 0;
      const hitRateDrop = snapshot.hitRate - postHitRate;

      if (hitRateDrop >= this._config.REGRESSION_HITRATE_DROP_THRESHOLD) {
        if (this._isCooledDown(skillName, TriggerType.VERSION_REGRESSION)) continue;

        this._recordTrigger(skillName, TriggerType.VERSION_REGRESSION, {
          preHitRate: +(snapshot.hitRate * 100).toFixed(1),
          postHitRate: +(postHitRate * 100).toFixed(1),
          hitRateDrop: +(hitRateDrop * 100).toFixed(1),
          preVersion: snapshot.version,
          currentVersion: meta.version,
          postUsage,
          postEffective,
          action: 'fix',
          reason: `Version regression: "${skillName}" hitRate dropped ${(hitRateDrop * 100).toFixed(1)}pp after v${snapshot.version} → v${meta.version} (${(snapshot.hitRate * 100).toFixed(1)}% → ${(postHitRate * 100).toFixed(1)}%)`,
        });

        // Clean up snapshot after triggering
        this._preEvolutionSnapshots.delete(skillName);
      }

      // Clean up old snapshots (>7 days)
      if (Date.now() - snapshot.timestamp > 7 * 24 * 60 * 60 * 1000) {
        this._preEvolutionSnapshots.delete(skillName);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Finds skills whose domains or keywords match a pattern key.
   *
   * @param {string} patternKey – e.g. 'token-trend-increasing', 'error-trend-increasing'
   * @returns {string[]} Matching skill names
   * @private
   */
  _findSkillsByPatternKey(patternKey) {
    if (!this._skillEvolution) return [];

    const keywords = patternKey.toLowerCase().split(/[-_]/);
    const matches = [];

    for (const meta of this._skillEvolution.registry.values()) {
      if (meta.retiredAt) continue;

      const skillKeywords = (meta.triggers?.keywords || []).map(k => k.toLowerCase());
      const skillDomains = (meta.domains || []).map(d => d.toLowerCase());
      const allTerms = [...skillKeywords, ...skillDomains, meta.name.toLowerCase()];

      const overlap = keywords.filter(kw => allTerms.some(t => t.includes(kw)));
      if (overlap.length >= 2) {
        matches.push(meta.name);
      }
    }

    return matches;
  }

  /**
   * Checks if a trigger is in cooldown.
   *
   * @param {string} skillName
   * @param {string} triggerType
   * @returns {boolean}
   * @private
   */
  _isCooledDown(skillName, triggerType) {
    const key = `${skillName}:${triggerType}`;
    const lastTrigger = this._cooldowns.get(key);
    if (!lastTrigger) return false;

    const cooledDown = (Date.now() - lastTrigger) < this._config.TRIGGER_COOLDOWN_MS;
    if (cooledDown) {
      this._stats.cooledDown++;
    }
    return cooledDown;
  }

  /**
   * Resets consecutive gate failure count (called on gate pass).
   * @param {string} gateName
   */
  resetGateFailCount(gateName) {
    this._gateFailCounts.delete(gateName);
  }

  /**
   * Returns trigger statistics.
   * @returns {object}
   */
  getStats() {
    return { ...this._stats, byType: { ...this._stats.byType } };
  }
}

module.exports = { SkillEvolutionTriggers, TriggerType, TRIGGER_CONFIG };
