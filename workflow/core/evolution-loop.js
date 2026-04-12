/**
 * Evolution Loop – Self-Evolution from Multi-Source Signals
 *
 * ADR-55: Real-Time Evolution from Daily Tasks
 *
 * Inspired by RAGEN/SAGE research on reinforcement learning for self-improving agents:
 * - StarPO (State-Thinking-Actions-Reward Policy Optimization) for trajectory-level learning
 * - Skill Library for accumulated knowledge
 * - Multi-turn RL for interactive environments
 *
 * Signal Sources:
 *   1. TEST_FAILURE     – Test failures during workflow
 *   2. SOCRATIC_CHALLENGE – SocraticChallenger questions and blind spots
 *   3. USER_FEEDBACK    – User-Agent conversation feedback
 *   4. QUALITY_GATE     – Quality gate failures
 *   5. EXECUTION_LOG    – Execution log validation findings
 *
 * Evolution Actions:
 *   1. RECORD_PATTERN   – Record negative/positive patterns to ExperienceStore
 *   2. EVOLVE_SKILL     – Update Skill with prevention rules
 *   3. UPDATE_PROMPT    – Refine agent prompts
 *   4. LEARN_EXTERNAL   – Fetch best practices from external sources
 *
 * @module workflow/core/evolution-loop
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 导入 PATHS 常量作为默认 outputDir
const { PATHS, getDefaultOutputDir } = require('./constants');

// ─── Signal Types (Extended from SessionSignalDetector) ───────────────────────

const EvolutionSignalType = {
  // Existing (from SessionSignalDetector)
  ERROR_KEYWORD: 'ERROR_KEYWORD',
  NEGATION: 'NEGATION',
  RETRY_PATTERN: 'RETRY_PATTERN',
  TOOL_DENSITY: 'TOOL_DENSITY',
  COMPLAINT_FILED: 'COMPLAINT_FILED',

  // New signals for evolution
  TEST_FAILURE: 'TEST_FAILURE',           // Test failed during workflow
  SOCRATIC_CHALLENGE: 'SOCRATIC_CHALLENGE', // SocraticChallenger found blind spots
  USER_FEEDBACK: 'USER_FEEDBACK',         // User provided feedback in conversation
  QUALITY_GATE_FAIL: 'QUALITY_GATE_FAIL', // Quality gate validation failed
  EXECUTION_LOG_FAIL: 'EXECUTION_LOG_FAIL', // Execution log validation failed
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',       // SocraticChallenger confidence < threshold
};

const SignalSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

// ─── Structured Log Schema ────────────────────────────────────────────────────

/**
 * Structured log entry for quality assessment.
 * This is the "打点日志" that serves as the basis for final quality.
 */
const LogSchema = {
  timestamp: 'ISO 8601',
  stage: 'ANALYSE|ARCHITECT|PLAN|CODE|TEST',
  signalType: 'EvolutionSignalType',
  severity: 'LOW|MEDIUM|HIGH|CRITICAL',
  source: 'Where the signal came from',
  evidence: 'Concrete evidence/quote',
  context: 'Additional context (stack trace, snippet, etc.)',
  confidence: '0.0-1.0',
  actionTaken: 'What action was taken',
  evolutionTriggered: 'Whether evolution was triggered',
};

// ─── EvolutionLoop Class ──────────────────────────────────────────────────────

class EvolutionLoop {
  /**
   * @param {object} options
   * @param {object} [options.experienceStore] - ExperienceStore instance
   * @param {object} [options.skillEvolution] - SkillEvolutionEngine instance
   * @param {object} [options.sessionSignalDetector] - SessionSignalDetector instance
   * @param {string} [options.outputDir] - Directory for structured logs
   * @param {number} [options.confidenceThreshold=0.5] - Threshold for evolution trigger
   * @param {boolean} [options.verbose=true] - Enable detailed logging
   * @param {function} [options.llmCall] - LLM for semantic analysis
   */
  constructor(options = {}) {
    this.experienceStore = options.experienceStore || null;
    this.skillEvolution = options.skillEvolution || null;
    this.sessionSignalDetector = options.sessionSignalDetector || null;
    // Use injected outputDir or runtime default (not static constant)
    this.outputDir = options.outputDir || getDefaultOutputDir();
    this.confidenceThreshold = options.confidenceThreshold ?? 0.5;
    this.verbose = options.verbose !== false;
    this.llmCall = options.llmCall || null;

    // Structured log buffer (打点日志)
    this._logBuffer = [];
    this._sessionStartTime = Date.now();
    this._sessionId = this._generateSessionId();
    this._signalCounts = new Map();
    this._evolutionActions = [];
  }

  // ─── Core: Signal Processing ────────────────────────────────────────────────

  /**
   * Process a signal from any source and potentially trigger evolution.
   * This is the main entry point for all evolution signals.
   *
   * @param {object} signal
   * @param {string} signal.type - EvolutionSignalType
   * @param {string} signal.severity - SignalSeverity
   * @param {string} signal.stage - Stage where signal was detected
   * @param {string} signal.evidence - Concrete evidence
   * @param {object} [signal.context] - Additional context
   * @param {number} [signal.confidence] - Confidence score (0.0-1.0)
   * @returns {{ logged: boolean, evolutionTriggered: boolean, action?: string }}
   */
  processSignal(signal) {
    const {
      type,
      severity = SignalSeverity.MEDIUM,
      stage = 'UNKNOWN',
      evidence,
      context = {},
      confidence = 1.0,
    } = signal;

    // 1. Create structured log entry
    const logEntry = {
      timestamp: new Date().toISOString(),
      stage,
      signalType: type,
      severity,
      source: this._getSourceForType(type),
      evidence: evidence?.slice(0, 500) || '',
      context,
      confidence,
      actionTaken: null,
      evolutionTriggered: false,
    };

    // 2. Log the signal
    this._logBuffer.push(logEntry);
    this._incrementSignalCount(type);

    this._log(`[EvolutionLoop] 📡 Signal: [${severity.toUpperCase()}] ${type} @ ${stage}`);
    this._log(`[EvolutionLoop]    Evidence: ${evidence?.slice(0, 80) || '(none)'}...`);

    // 3. Determine if evolution should be triggered
    const shouldEvolve = this._shouldTriggerEvolution(signal);

    if (shouldEvolve) {
      logEntry.evolutionTriggered = true;
      const action = this._triggerEvolution(signal);
      logEntry.actionTaken = action;
      this._evolutionActions.push({ signal: type, action, timestamp: logEntry.timestamp });

      this._log(`[EvolutionLoop] 🧬 Evolution triggered: ${action}`);
    }

    return {
      logged: true,
      evolutionTriggered: shouldEvolve,
      action: logEntry.actionTaken,
    };
  }

  // ─── Signal Source Methods ───────────────────────────────────────────────────

  /**
   * Process test failure signal.
   * Called by Orchestrator when a test fails.
   *
   * @param {string} stage - Stage where test failed
   * @param {string} testName - Name of failed test
   * @param {string} error - Error message
   * @param {string} [stackTrace] - Stack trace
   */
  processTestFailure(stage, testName, error, stackTrace = '') {
    return this.processSignal({
      type: EvolutionSignalType.TEST_FAILURE,
      severity: SignalSeverity.HIGH,
      stage,
      evidence: `Test "${testName}" failed: ${error}`,
      context: { testName, error, stackTrace: stackTrace?.slice(0, 1000) },
      confidence: 0.9,
    });
  }

  /**
   * Process SocraticChallenger result.
   * Called after each stage challenge.
   *
   * @param {string} stage - Stage that was challenged
   * @param {object} challengeResult - Result from SocraticChallenger.challenge()
   */
  processSocraticChallenge(stage, challengeResult) {
    const { questions = [], blindSpots = [], confidence = 1.0 } = challengeResult;

    // Process each blind spot as a signal
    const results = [];

    // Layer 1 — Noise filter (PER-inspired):
    // "未涉及" prefix means "dimension not covered by content" — this is a
    // scoring signal for confidence calculation, NOT a real blind spot.
    // Real blind spots describe concrete problems (e.g. "缺少接口契约").
    // Filtering these prevents 140 noise signals from flooding the evolution log.
    const realBlindSpots = blindSpots.filter(bs => !bs.includes('未涉及'));
    const filteredNoise = blindSpots.length - realBlindSpots.length;

    if (filteredNoise > 0) {
      this._log(`[EvolutionLoop] 🔇 Filtered ${filteredNoise} noise signal(s) ("未涉及" prefix) from ${blindSpots.length} total blind spots`);
    }

    for (const blindSpot of realBlindSpots) {
      const result = this.processSignal({
        type: EvolutionSignalType.SOCRATIC_CHALLENGE,
        severity: confidence < 0.5 ? SignalSeverity.HIGH : SignalSeverity.MEDIUM,
        stage,
        evidence: blindSpot,
        context: { questions: questions.slice(0, 3), allBlindSpots: blindSpots, filteredNoise },
        confidence,
      });
      results.push(result);
    }

    // Low confidence is itself a signal
    if (confidence < this.confidenceThreshold) {
      const result = this.processSignal({
        type: EvolutionSignalType.LOW_CONFIDENCE,
        severity: SignalSeverity.HIGH,
        stage,
        evidence: `Confidence ${confidence} < threshold ${this.confidenceThreshold}`,
        context: { questions, blindSpots },
        confidence,
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Process user feedback from conversation.
   * Called when user provides feedback in the chat.
   *
   * @param {string} feedback - User's feedback
   * @param {string} [context] - Context of the feedback
   */
  processUserFeedback(feedback, context = '') {
    // Determine severity based on feedback content
    let severity = SignalSeverity.MEDIUM;
    if (/critical|blocker|cannot|broken|wrong|bug|error/i.test(feedback)) {
      severity = SignalSeverity.HIGH;
    } else if (/minor|suggestion|could|would|nice/i.test(feedback)) {
      severity = SignalSeverity.LOW;
    }

    return this.processSignal({
      type: EvolutionSignalType.USER_FEEDBACK,
      severity,
      stage: 'CONVERSATION',
      evidence: feedback,
      context: { conversationContext: context },
      confidence: 0.8, // User feedback is usually high-quality
    });
  }

  /**
   * Process quality gate failure.
   *
   * @param {string} stage - Stage where gate failed
   * @param {string} gateName - Name of the gate
   * @param {string} reason - Failure reason
   */
  processQualityGateFailure(stage, gateName, reason) {
    return this.processSignal({
      type: EvolutionSignalType.QUALITY_GATE_FAIL,
      severity: SignalSeverity.HIGH,
      stage,
      evidence: `Gate "${gateName}" failed: ${reason}`,
      context: { gateName, reason },
      confidence: 0.85,
    });
  }

  /**
   * Process execution log validation failure.
   *
   * @param {object} validationResult - From ExecutionLogValidator
   */
  processExecutionLogFailure(validationResult) {
    const { summary } = validationResult.report || {};

    return this.processSignal({
      type: EvolutionSignalType.EXECUTION_LOG_FAIL,
      severity: summary?.score < 50 ? SignalSeverity.CRITICAL : SignalSeverity.HIGH,
      stage: 'VALIDATION',
      evidence: `Execution validation score: ${summary?.score}/100, failed stages: ${summary?.failedStages}`,
      context: { validationResult },
      confidence: 0.9,
    });
  }

  // ─── Evolution Triggers ──────────────────────────────────────────────────────

  /**
   * Determine if a signal should trigger evolution.
   */
  _shouldTriggerEvolution(signal) {
    const { severity, confidence, type } = signal;

    // Always trigger on critical signals
    if (severity === SignalSeverity.CRITICAL) return true;

    // High severity with good confidence
    if (severity === SignalSeverity.HIGH && confidence >= 0.7) return true;

    // Low confidence from SocraticChallenger
    if (type === EvolutionSignalType.LOW_CONFIDENCE && confidence < this.confidenceThreshold) return true;

    // Test failures
    if (type === EvolutionSignalType.TEST_FAILURE) return true;

    // User feedback with high severity
    if (type === EvolutionSignalType.USER_FEEDBACK && severity === SignalSeverity.HIGH) return true;

    // SOCRATIC_CHALLENGE: trigger if evidence is a real blind spot.
    // Inspired by PER (Prioritized Experience Replay, DeepMind 2016):
    // all real signals should be consumed, not silently dropped.
    // Priority is determined by evidence quality, not confidence alone.
    // Note: noise signals ("未涉及" prefix) are already filtered in processSocraticChallenge (Layer 1).
    // This condition handles any remaining real blind spots that reach this point.
    if (type === EvolutionSignalType.SOCRATIC_CHALLENGE) {
      const evidence = signal.evidence || '';
      if (!evidence.includes('未涉及') && evidence.length > 10) return true;
    }

    return false;
  }

  /**
   * Extract a structured Prevention Rule from a signal's evidence.
   *
   * Inspired by Reflexion (NeurIPS 2023): convert task feedback signals into
   * verbal reflections stored in memory — without any LLM calls.
   * Voyager-style quality gate: only valid evidence (real blind spots) passes.
   *
   * @param {string} evidence - The blind spot evidence text
   * @param {string} stage    - Workflow stage (ANALYSE, ARCHITECT, etc.)
   * @param {string} type     - Signal type (SOCRATIC_CHALLENGE, etc.)
   * @returns {{ symptom, dimension, prevention, content, isValid }}
   */
  _extractPreventionRule(evidence, stage, type) {
    // Quality gate (Voyager critic_agent equivalent — rule-based, no LLM):
    // Only valid if evidence describes a real problem, not noise or a placeholder.
    const isValid = (
      typeof evidence === 'string' &&
      evidence.length > 20 &&
      !evidence.includes('未涉及') &&
      !evidence.includes('(To be filled')
    );

    if (!isValid) {
      return { symptom: evidence, dimension: '通用', prevention: '', content: '', isValid: false };
    }

    // Extract dimension label from evidence (e.g. "[清晰度]" → "清晰度")
    const dimMatch = evidence.match(/\[([^\]]+)\]/);
    const dimension = dimMatch ? dimMatch[1] : '通用';

    // Extract symptom (strip dimension prefix tags)
    const symptom = evidence.replace(/\[[^\]]+\]\s*/g, '').trim() || evidence;

    // Generate prevention rule — verbal reflection template (Reflexion pattern)
    const prevention = `在 ${stage} 阶段，检查 ${dimension} 维度：${symptom}。` +
      `下次执行时，在 artifact 中明确说明此维度的处理方式，避免重复出现此盲点。`;

    // Structured content for ExperienceStore (replaces "(To be filled by human review)")
    const content = [
      `**Signal Type**: ${type}`,
      `**Stage**: ${stage}`,
      `**Dimension**: ${dimension}`,
      `**Symptom**: ${symptom}`,
      `**Prevention**: ${prevention}`,
      `> _Source: EvolutionLoop (ADR-55) — auto-extracted via Reflexion verbal reflection pattern_`,
    ].join('\n');

    return { symptom, dimension, prevention, content, isValid };
  }

  /**
   * Enhances a Prevention Rule with specific, actionable guidance using LLM.
   * Inspired by Reflexion (NeurIPS 2023): convert generic verbal reflection into
   * specific action instructions. Non-blocking: called via setImmediate.
   *
   * @param {{ symptom, dimension, prevention }} preventionRule
   * @param {string} stage
   * @returns {Promise<string|null>} Enhanced prevention instruction, or null on failure
   */
  async _enhancePreventionRule(preventionRule, stage) {
    if (!this._cheapLlmCall) return null;
    // Detect language from symptom/dimension (Chinese chars → respond in Chinese)
    const hasChinese = /[\u4e00-\u9fff]/.test(preventionRule.symptom + preventionRule.dimension);
    const langInstruction = hasChinese
      ? `Respond in Chinese (中文). Use the format: "当[具体触发条件]时，[具体行动]，例如：[具体示例]。"`
      : `Respond in English. Use the format: "When [specific trigger condition], [specific action to take], for example: [concrete example]."`;
    const prompt = [
      `You are a workflow quality advisor. Convert this generic prevention rule into a specific, actionable instruction.`,
      ``,
      `Stage: ${stage}`,
      `Dimension: ${preventionRule.dimension}`,
      `Symptom: ${preventionRule.symptom}`,
      ``,
      `Write ONE specific action instruction (max 2 sentences).`,
      langInstruction,
      ``,
      `Respond with ONLY the instruction, no preamble.`,
    ].join('\n');

    try {
      const response = await this._cheapLlmCall(prompt);
      return response?.trim() || null;
    } catch (err) {
      this._log(`[EvolutionLoop]    ⚠️ _enhancePreventionRule LLM call failed: ${err.message}`);
      return null;
    }
  }
  _triggerEvolution(signal) {
    const { type, stage, evidence, context } = signal;

    // Layer 3 — Batch deduplication for SOCRATIC_CHALLENGE (PER rank-based dedup):
    // Multiple blind spots from the same stage in the same session are merged into
    // one ExperienceStore record to prevent bloat. Only the first occurrence per
    // (session, stage) pair triggers a full ExperienceStore write.
    if (type === EvolutionSignalType.SOCRATIC_CHALLENGE) {
      if (!this._socraticDedupeSet) this._socraticDedupeSet = new Set();
      const dedupeKey = `${this._sessionId}:${stage}:SOCRATIC_CHALLENGE`;
      if (this._socraticDedupeSet.has(dedupeKey)) {
        this._log(`[EvolutionLoop]    → Deduped SOCRATIC_CHALLENGE for ${stage} (already recorded this session)`);
        return 'deduplicated';
      }
      this._socraticDedupeSet.add(dedupeKey);
    }

    // Extract structured prevention rule (Reflexion verbal reflection, no LLM)
    const preventionRule = this._extractPreventionRule(evidence, stage, type);

    // 1. Record to ExperienceStore
    if (this.experienceStore) {
      const category = this._getCategoryForSignal(type);
      const title = this._generateTitle(type, stage, evidence);

      this.experienceStore.record({
        type: 'negative',
        category,
        title,
        // Use structured content if valid; fall back to raw evidence for low-quality signals
        content: preventionRule.isValid
          ? preventionRule.content
          : `**Signal Type**: ${type}\n**Stage**: ${stage}\n**Evidence**: ${evidence}\n**Context**: ${JSON.stringify(context).slice(0, 200)}\n> _Source: EvolutionLoop (ADR-55)_`,
        tags: ['evolution-loop', type.toLowerCase(), stage.toLowerCase(), 'auto-captured'],
        ttlDays: 90,
      });

      this._log(`[EvolutionLoop]    → Recorded to ExperienceStore: ${title.slice(0, 50)}...`);

      // Async LLM enhancement: improve Prevention Rule specificity
      // (MemGPT background consolidation pattern — non-blocking, fire-and-forget)
      // Only trigger if cheapLlmCall is available and prevention rule is valid.
      // Token budget: ~200 tokens per enhancement (prompt + response).
      // Bridge mode: _cheapLlmCall is null → silently skipped.
      if (preventionRule.isValid && this._cheapLlmCall && this.experienceStore) {
        const expTitle = title; // capture for async closure
        setImmediate(async () => {
          try {
            const enhancedPrevention = await this._enhancePreventionRule(preventionRule, stage);
            if (enhancedPrevention) {
              this.experienceStore.appendByTitle(expTitle,
                `**Enhanced Prevention** (LLM-generated, Reflexion pattern):\n${enhancedPrevention}`
              );
              this._log(`[EvolutionLoop]    → Enhanced Prevention Rule: ${expTitle.slice(0, 40)}`);
            }
          } catch (err) {
            this._log(`[EvolutionLoop]    ⚠️ Async LLM enhancement failed (non-fatal): ${err.message}`);
          }
        });
      }
    }

    // 2. Evolve relevant Skill
    // Quality gate: only evolve if prevention rule is valid (Voyager critic_agent pattern).
    // Prevents low-quality signals from polluting the Skill library.
    if (this.skillEvolution && preventionRule.isValid) {
      const skillName = this._getSkillForStage(stage);
      if (skillName && this.skillEvolution.registry?.has(skillName)) {
        this.skillEvolution.evolve(skillName, {
          section: 'Prevention Rules',
          title: `[Auto] [${preventionRule.dimension}] ${preventionRule.symptom.slice(0, 40)}`,
          content: preventionRule.content,
          reason: `EvolutionLoop: auto-extracted via Reflexion verbal reflection (ADR-55)`,
        });

        this._log(`[EvolutionLoop]    → Evolved skill: ${skillName} (dimension: ${preventionRule.dimension})`);
        return `recorded+evolved:${skillName}`;
      }
    }

    return 'recorded';
  }

  // ─── Skill Ablation Test ──────────────────────────────────────────────────────

  /**
   * Run a Skill Ablation Test to quantify the ROI of individual skills.
   *
   * Ablation testing is a technique from ML research: remove one component at a
   * time and measure the impact on overall performance. Applied to skills:
   *   1. Record baseline quality metrics (with all skills active)
   *   2. For each candidate skill, simulate removal and estimate quality delta
   *   3. Produce a ranked report showing each skill's contribution
   *
   * This is a non-destructive, read-only analysis. No skills are actually removed.
   *
   * Methodology:
   *   - Uses existing lifecycle data (usageCount, effectiveCount, gatePassCount, gateFailCount)
   *   - Computes per-skill effectiveness rate and adoption rate
   *   - Estimates quality impact using the effectiveness-weighted contribution model
   *   - Flags skills with negative ROI (high injection cost, low effectiveness)
   *
   * @param {object} [options]
   * @param {number} [options.minUsageCount=3] - Minimum usage count to include in analysis
   * @returns {{ success: boolean, report: object, recommendations: object[] }}
   */
  runAblationTest(options = {}) {
    const minUsageCount = options.minUsageCount ?? 3;

    this._log(`[EvolutionLoop] 🧪 Running Skill Ablation Test (minUsage=${minUsageCount})...`);

    if (!this.skillEvolution) {
      this._log(`[EvolutionLoop] ⚠️ Ablation test requires SkillEvolutionEngine`);
      return { success: false, report: null, recommendations: [] };
    }

    const skills = this.skillEvolution.listSkills();
    if (skills.length === 0) {
      return { success: true, report: { totalSkills: 0, analyzed: 0, skipped: 0 }, recommendations: [] };
    }

    // ── Collect per-skill metrics ──────────────────────────────────────────
    const analyzed = [];
    const skipped = [];

    for (const skill of skills) {
      // Skip retired skills
      if (skill.retiredAt) {
        skipped.push({ name: skill.name, reason: 'retired' });
        continue;
      }

      const usageCount = skill.usageCount || 0;
      const effectiveCount = skill.effectiveCount || 0;
      const gatePassCount = skill.gatePassCount || 0;
      const gateFailCount = skill.gateFailCount || 0;
      const maxTokens = skill.maxTokens || 800;

      // Skip skills with insufficient data
      if (usageCount < minUsageCount) {
        skipped.push({ name: skill.name, reason: `insufficient data (${usageCount} < ${minUsageCount})` });
        continue;
      }

      // ── Compute metrics ────────────────────────────────────────────────
      const effectivenessRate = usageCount > 0 ? effectiveCount / usageCount : 0;
      const gatePassRate = (gatePassCount + gateFailCount) > 0
        ? gatePassCount / (gatePassCount + gateFailCount)
        : null; // null = no gate data

      // Token cost estimate (injections × max_tokens)
      const estimatedTokenCost = usageCount * maxTokens;

      // Effectiveness-weighted contribution score:
      //   High effectiveness + high usage = high positive contribution
      //   Low effectiveness + high usage = high negative contribution (wasted tokens)
      const contributionScore = effectivenessRate * usageCount - (1 - effectivenessRate) * usageCount * 0.5;

      // ROI: contribution per token spent
      const roi = estimatedTokenCost > 0 ? contributionScore / (estimatedTokenCost / 1000) : 0;

      analyzed.push({
        name: skill.name,
        usageCount,
        effectiveCount,
        effectivenessRate: Math.round(effectivenessRate * 1000) / 10, // percentage with 1 decimal
        gatePassRate: gatePassRate !== null ? Math.round(gatePassRate * 1000) / 10 : null,
        gatePassCount,
        gateFailCount,
        estimatedTokenCost,
        contributionScore: Math.round(contributionScore * 100) / 100,
        roi: Math.round(roi * 1000) / 1000,
        policyWeight: skill.policyWeight || 1,
        version: skill.version || '0.0.0',
        domains: skill.domains || [],
      });
    }

    // ── Sort by contribution (highest first) ───────────────────────────────
    analyzed.sort((a, b) => b.contributionScore - a.contributionScore);

    // ── Generate recommendations ───────────────────────────────────────────
    const recommendations = [];

    for (const skill of analyzed) {
      if (skill.effectivenessRate < 20 && skill.usageCount >= 5) {
        recommendations.push({
          skill: skill.name,
          action: 'INVESTIGATE',
          severity: 'high',
          reason: `Low effectiveness (${skill.effectivenessRate}%) despite ${skill.usageCount} injections. ` +
                  `Estimated ${skill.estimatedTokenCost} tokens wasted. Consider retiring or rewriting.`,
        });
      } else if (skill.effectivenessRate < 40 && skill.usageCount >= 3) {
        recommendations.push({
          skill: skill.name,
          action: 'REVIEW',
          severity: 'medium',
          reason: `Below-average effectiveness (${skill.effectivenessRate}%). ` +
                  `May benefit from content refinement or keyword tuning.`,
        });
      } else if (skill.effectivenessRate >= 80 && skill.usageCount >= 5) {
        recommendations.push({
          skill: skill.name,
          action: 'PROMOTE',
          severity: 'info',
          reason: `High-value skill (${skill.effectivenessRate}% effective, ${skill.usageCount} uses). ` +
                  `Consider promoting to project-level load or sharing via Marketplace.`,
        });
      }

      // Negative ROI detection
      if (skill.roi < -0.5) {
        recommendations.push({
          skill: skill.name,
          action: 'RETIRE_CANDIDATE',
          severity: 'high',
          reason: `Negative ROI (${skill.roi}). Token cost exceeds contribution. ` +
                  `Ablation suggests removing this skill would improve overall performance.`,
        });
      }
    }

    // ── Build report ───────────────────────────────────────────────────────
    const report = {
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      totalSkills: skills.length,
      analyzed: analyzed.length,
      skipped: skipped.length,
      skippedDetails: skipped,
      // Aggregate metrics
      avgEffectiveness: analyzed.length > 0
        ? Math.round(analyzed.reduce((sum, s) => sum + s.effectivenessRate, 0) / analyzed.length * 10) / 10
        : 0,
      totalTokenCost: analyzed.reduce((sum, s) => sum + s.estimatedTokenCost, 0),
      positiveROICount: analyzed.filter(s => s.roi > 0).length,
      negativeROICount: analyzed.filter(s => s.roi < 0).length,
      // Per-skill breakdown (sorted by contribution)
      skills: analyzed,
      // Actionable recommendations
      recommendations,
    };

    this._log(`[EvolutionLoop] 🧪 Ablation Test Complete: ${analyzed.length} skills analyzed, ` +
      `${recommendations.length} recommendation(s), avg effectiveness: ${report.avgEffectiveness}%`);

    // ── Persist report ─────────────────────────────────────────────────────
    try {
      const reportPath = path.join(this.outputDir, 'skill-ablation-report.json');
      fs.mkdirSync(this.outputDir, { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      this._log(`[EvolutionLoop] 📄 Ablation report saved: ${reportPath}`);
    } catch (err) {
      this._log(`[EvolutionLoop] ⚠️ Failed to save ablation report: ${err.message}`);
    }

    return { success: true, report, recommendations };
  }

  /**
   * Generate a human-readable Markdown ablation report.
   *
   * @param {object} ablationResult - Result from runAblationTest()
   * @returns {string} Markdown report
   */
  formatAblationReport(ablationResult) {
    if (!ablationResult.success || !ablationResult.report) {
      return '# Skill Ablation Report\n\n❌ Ablation test failed or no data available.';
    }

    const r = ablationResult.report;
    const lines = [
      `# Skill Ablation Report`,
      ``,
      `**Generated**: ${r.timestamp}`,
      `**Session**: ${r.sessionId}`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total Skills | ${r.totalSkills} |`,
      `| Analyzed | ${r.analyzed} |`,
      `| Skipped | ${r.skipped} |`,
      `| Avg Effectiveness | ${r.avgEffectiveness}% |`,
      `| Total Token Cost | ~${r.totalTokenCost.toLocaleString()} tokens |`,
      `| Positive ROI | ${r.positiveROICount} skills |`,
      `| Negative ROI | ${r.negativeROICount} skills |`,
      ``,
      `## Per-Skill Breakdown`,
      ``,
      `| Skill | Usage | Effective% | Gate Pass% | Token Cost | Contribution | ROI |`,
      `|-------|-------|-----------|-----------|-----------|-------------|-----|`,
    ];

    for (const s of r.skills) {
      const gateStr = s.gatePassRate !== null ? `${s.gatePassRate}%` : 'N/A';
      const roiIcon = s.roi > 0.5 ? '🟢' : s.roi < -0.5 ? '🔴' : '🟡';
      lines.push(
        `| ${s.name} | ${s.usageCount} | ${s.effectivenessRate}% | ${gateStr} | ~${s.estimatedTokenCost} | ${s.contributionScore} | ${roiIcon} ${s.roi} |`
      );
    }

    if (r.recommendations.length > 0) {
      lines.push(``);
      lines.push(`## Recommendations`);
      lines.push(``);
      for (const rec of r.recommendations) {
        const icon = rec.severity === 'high' ? '🔴' : rec.severity === 'medium' ? '🟡' : 'ℹ️';
        lines.push(`- ${icon} **${rec.action}** \`${rec.skill}\`: ${rec.reason}`);
      }
    }

    if (r.skippedDetails.length > 0) {
      lines.push(``);
      lines.push(`## Skipped Skills`);
      lines.push(``);
      for (const s of r.skippedDetails) {
        lines.push(`- \`${s.name}\`: ${s.reason}`);
      }
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(`_Generated by EvolutionLoop Ablation Test (Agent Skills Spec improvement)_`);

    return lines.join('\n');
  }

  // ─── External Learning ───────────────────────────────────────────────────────

  /**
   * Learn from external sources (best practices, research papers, etc.).
   * Uses web search to find relevant knowledge.
   *
   * @param {string} topic - Topic to learn about
   * @param {object} [options]
   * @param {number} [options.maxResults=3] - Max results to process
   * @returns {Promise<{ learned: boolean, insights: string[] }>}
   */
  async learnFromExternal(topic, options = {}) {
    const maxResults = options.maxResults ?? 3;

    this._log(`[EvolutionLoop] 🌐 Learning from external sources: "${topic}"`);

    try {
      // Note: This would use web_search tool in practice
      // For now, we return a placeholder
      const insights = [];

      // TODO: Integrate with web_search MCP tool
      // const results = await webSearch(topic);
      // for (const result of results.slice(0, maxResults)) {
      //   insights.push(result.summary);
      // }

      this._log(`[EvolutionLoop]    → Learned ${insights.length} insight(s)`);

      return { learned: insights.length > 0, insights };
    } catch (err) {
      this._log(`[EvolutionLoop] ⚠️  External learning failed: ${err.message}`);
      return { learned: false, insights: [] };
    }
  }

  // ─── Structured Log Output ───────────────────────────────────────────────────

  /**
   * Get structured log as JSON.
   * This is the "打点日志" that serves as quality basis.
   */
  getStructuredLog() {
    return {
      sessionId: this._sessionId,
      startTime: new Date(this._sessionStartTime).toISOString(),
      endTime: new Date().toISOString(),
      durationMs: Date.now() - this._sessionStartTime,
      totalSignals: this._logBuffer.length,
      signalCounts: Object.fromEntries(this._signalCounts),
      evolutionActions: this._evolutionActions,
      log: this._logBuffer,
    };
  }

  /**
   * Calculate quality score from structured log.
   * New model:
   *   1) Signal aggregation + dedup (reduce repeated inflation)
   *   2) Piecewise penalty by severity (decreasing marginal penalties)
   *   3) Dual score: deliveryScore + detectionScore
   */
  calculateQualityScore() {
    if (this._logBuffer.length === 0) {
      return {
        score: 100,
        overallScore: 100,
        deliveryScore: 100,
        detectionScore: 100,
        grade: 'A',
        reason: 'No signals detected',
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
        rawSeverityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      };
    }

    // 1) Raw severity counts (before dedup)
    const rawSeverityCounts = {
      critical: this._logBuffer.filter(l => l.severity === 'critical').length,
      high: this._logBuffer.filter(l => l.severity === 'high').length,
      medium: this._logBuffer.filter(l => l.severity === 'medium').length,
      low: this._logBuffer.filter(l => l.severity === 'low').length,
    };

    // 2) Aggregate signals by semantic signature and cap repeated items per bucket
    const perBucketCap = 3;
    const buckets = new Map();

    for (const entry of this._logBuffer) {
      const normalizedEvidence = this._normalizeEvidenceForScoring(entry.evidence || '');
      const signature = `${entry.signalType}|${entry.stage}|${entry.severity}|${normalizedEvidence}`;
      const existing = buckets.get(signature);
      if (!existing) {
        buckets.set(signature, {
          count: 1,
          severity: entry.severity,
          stage: entry.stage,
          signalType: entry.signalType,
        });
      } else if (existing.count < perBucketCap) {
        existing.count += 1;
      }
    }

    const aggregatedEntries = Array.from(buckets.values());

    // Severity counts after aggregation (weighted by capped duplicates)
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of aggregatedEntries) {
      if (severityCounts[item.severity] !== undefined) {
        severityCounts[item.severity] += item.count;
      }
    }

    // 3) Piecewise penalties (decreasing marginal penalties)
    const piecewisePenalty = (count, p1, p2, p3) => {
      if (count <= 0) return 0;
      if (count === 1) return p1;
      if (count === 2) return p1 + p2;
      return p1 + p2 + (count - 2) * p3;
    };

    const totalPenalty =
      piecewisePenalty(severityCounts.critical, 18, 9, 4) +
      piecewisePenalty(severityCounts.high, 8, 4, 2) +
      piecewisePenalty(severityCounts.medium, 4, 2, 1) +
      piecewisePenalty(severityCounts.low, 2, 1, 0.5);

    // Delivery score: issue burden after dedup + bounded evolution bonus
    const evolutionBonus = Math.min(10, this._evolutionActions.length * 2);
    let deliveryScore = 100 - totalPenalty + evolutionBonus;
    deliveryScore = Math.max(0, Math.min(100, deliveryScore));

    // Detection score: how well we observed and responded to issues (independent dimension)
    const uniqueSignalTypes = new Set(this._logBuffer.map(l => l.signalType)).size;
    const diversity = Math.min(1, uniqueSignalTypes / 5);

    const coreStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'];
    const coveredCoreStages = new Set(this._logBuffer.map(l => l.stage).filter(s => coreStages.includes(s))).size;
    const stageCoverage = Math.min(1, coveredCoreStages / coreStages.length);

    const avgConfidence = this._logBuffer.reduce((sum, l) => sum + (Number.isFinite(l.confidence) ? l.confidence : 0.5), 0) / this._logBuffer.length;
    const confidenceHealth = Math.max(0, Math.min(1, avgConfidence));

    const responsiveness = Math.max(0, Math.min(1, this._evolutionActions.length / this._logBuffer.length));

    const detectionScore = Math.max(
      0,
      Math.min(
        100,
        (0.35 * diversity + 0.25 * stageCoverage + 0.2 * confidenceHealth + 0.2 * responsiveness) * 100
      )
    );

    // 4) Dual-score fusion (delivery-focused)
    const overallScore = Math.max(0, Math.min(100, 0.6 * deliveryScore + 0.4 * detectionScore));
    const score = Math.round(overallScore * 10) / 10;

    const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';

    return {
      // Backward-compatible fields
      score,
      grade,
      severityCounts,

      // New dual-score fields
      overallScore: Math.round(overallScore * 10) / 10,
      deliveryScore: Math.round(deliveryScore * 10) / 10,
      detectionScore: Math.round(detectionScore * 10) / 10,
      rawSeverityCounts,
      aggregation: {
        rawSignalCount: this._logBuffer.length,
        aggregatedSignalCount: aggregatedEntries.reduce((sum, e) => sum + e.count, 0),
        uniqueBuckets: buckets.size,
        perBucketCap,
      },
      penaltyBreakdown: {
        critical: piecewisePenalty(severityCounts.critical, 18, 9, 4),
        high: piecewisePenalty(severityCounts.high, 8, 4, 2),
        medium: piecewisePenalty(severityCounts.medium, 4, 2, 1),
        low: piecewisePenalty(severityCounts.low, 2, 1, 0.5),
        totalPenalty: Math.round(totalPenalty * 10) / 10,
        evolutionBonus: Math.round(evolutionBonus * 10) / 10,
      },
      reason: `${this._logBuffer.length} raw signal(s) aggregated to ${buckets.size} bucket(s); delivery=${Math.round(deliveryScore * 10) / 10}, detection=${Math.round(detectionScore * 10) / 10}, overall=${score}.`,
    };
  }

  /**
   * Save structured log to file.
   * @returns {{ path: string, success: boolean, size: number, error?: string }}
   */
  saveStructuredLog(filename = 'evolution-log.json') {
    const logPath = path.join(this.outputDir, filename);
    const logData = this.getStructuredLog();

    try {
      fs.mkdirSync(this.outputDir, { recursive: true });
      fs.writeFileSync(logPath, JSON.stringify(logData, null, 2));

      // Verify file was written
      const stats = fs.statSync(logPath);
      const success = stats.size > 0;

      if (success) {
        this._log(`[EvolutionLoop] 📄 Structured log saved: ${logPath} (${stats.size} bytes)`);
      } else {
        this._log(`[EvolutionLoop] ⚠️  Structured log is empty: ${logPath}`);
      }

      return { path: logPath, success, size: stats.size };
    } catch (err) {
      this._log(`[EvolutionLoop] ❌ Failed to save structured log: ${err.message}`);
      return { path: logPath, success: false, size: 0, error: err.message };
    }
  }

  /**
   * Save quality report to file.
   * @returns {{ path: string, success: boolean, size: number, error?: string }}
   */
  saveQualityReport(filename = 'quality-report.md') {
    const reportPath = path.join(this.outputDir, filename);
    const quality = this.calculateQualityScore();
    const log = this.getStructuredLog();

    const report = [
      `# Quality Report`,
      ``,
      `**Session ID**: ${log.sessionId}`,
      `**Duration**: ${(log.durationMs / 1000).toFixed(2)}s`,
      `**Generated**: ${new Date().toISOString()}`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Overall Quality Score | **${quality.score}** (${quality.grade}) |`,
      `| Delivery Score | ${quality.deliveryScore ?? quality.score} |`,
      `| Detection Score | ${quality.detectionScore ?? quality.score} |`,
      `| Raw Signals | ${quality.aggregation?.rawSignalCount ?? log.totalSignals} |`,
      `| Aggregated Buckets | ${quality.aggregation?.uniqueBuckets ?? log.totalSignals} |`,
      `| Evolution Actions | ${log.evolutionActions.length} |`,
      ``,
      `### Signal Breakdown (Aggregated)`,
      ``,
      Object.entries(quality.severityCounts).map(([sev, count]) =>
        `- **${sev.toUpperCase()}**: ${count}`
      ).join('\n'),
      ``,
      `### Signal Breakdown (Raw)`,
      ``,
      Object.entries(quality.rawSeverityCounts || quality.severityCounts).map(([sev, count]) =>
        `- **${sev.toUpperCase()}**: ${count}`
      ).join('\n'),
      ``,
      `### Piecewise Penalty`,
      ``,
      `- **Critical penalty**: ${quality.penaltyBreakdown?.critical ?? 'N/A'}`,
      `- **High penalty**: ${quality.penaltyBreakdown?.high ?? 'N/A'}`,
      `- **Medium penalty**: ${quality.penaltyBreakdown?.medium ?? 'N/A'}`,
      `- **Low penalty**: ${quality.penaltyBreakdown?.low ?? 'N/A'}`,
      `- **Total penalty**: ${quality.penaltyBreakdown?.totalPenalty ?? 'N/A'}`,
      `- **Evolution bonus**: ${quality.penaltyBreakdown?.evolutionBonus ?? 'N/A'}`,
      ``,
      `## Evolution Actions`,
      ``,
      log.evolutionActions.length > 0
        ? log.evolutionActions.map(a => `- [${a.timestamp}] ${a.signal}: ${a.action}`).join('\n')
        : '_No evolution actions triggered_',
      ``,
      `## Signal Log`,
      ``,
      log.log.map(l =>
        `- [${l.timestamp}] [${l.severity.toUpperCase()}] ${l.signalType} @ ${l.stage}: ${l.evidence.slice(0, 100)}`
      ).join('\n'),
      ``,
      `---`,
      `_Generated by EvolutionLoop (ADR-55)_`,
    ].join('\n');

    try {
      fs.writeFileSync(reportPath, report);

      // Verify file was written
      const stats = fs.statSync(reportPath);
      const success = stats.size > 0;

      if (success) {
        this._log(`[EvolutionLoop] 📊 Quality report saved: ${reportPath} (${stats.size} bytes)`);
      } else {
        this._log(`[EvolutionLoop] ⚠️  Quality report is empty: ${reportPath}`);
      }

      return { path: reportPath, success, size: stats.size };
    } catch (err) {
      this._log(`[EvolutionLoop] ❌ Failed to save quality report: ${err.message}`);
      return { path: reportPath, success: false, size: 0, error: err.message };
    }
  }

  /**
   * Verify all output files exist and have content.
   * This is the "打点日志" validation for quality gate.
   *
   * @returns {{ passed: boolean, files: object[], missingFiles: string[], emptyFiles: string[] }}
   */
  verifyOutputFiles(filenames = ['evolution-log.json', 'quality-report.md']) {
    const results = {
      passed: true,
      files: [],
      missingFiles: [],
      emptyFiles: [],
    };

    for (const filename of filenames) {
      const filePath = path.join(this.outputDir, filename);

      try {
        if (!fs.existsSync(filePath)) {
          results.missingFiles.push(filename);
          results.passed = false;
          continue;
        }

        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
          results.emptyFiles.push(filename);
          results.passed = false;
        }

        results.files.push({
          name: filename,
          path: filePath,
          size: stats.size,
          exists: true,
          hasContent: stats.size > 0,
        });
      } catch (err) {
        results.missingFiles.push(filename);
        results.passed = false;
      }
    }

    // Log results
    if (results.passed) {
      this._log(`[EvolutionLoop] ✅ All ${filenames.length} output file(s) verified`);
    } else {
      if (results.missingFiles.length > 0) {
        this._log(`[EvolutionLoop] ❌ Missing files: ${results.missingFiles.join(', ')}`);
      }
      if (results.emptyFiles.length > 0) {
        this._log(`[EvolutionLoop] ⚠️  Empty files: ${results.emptyFiles.join(', ')}`);
      }
    }

    return results;
  }

  // ─── Integration with SessionSignalDetector ──────────────────────────────────

  /**
   * Inject signals into SessionSignalDetector.
   * This extends the detector with EvolutionLoop signals.
   */
  injectIntoDetector() {
    if (!this.sessionSignalDetector) {
      this._log(`[EvolutionLoop] ⚠️  No SessionSignalDetector to inject into`);
      return;
    }

    // EvolutionLoop signals are now available to the detector
    // The detector can call processSignal() when it detects signals
    this._log(`[EvolutionLoop] 🔗 Integrated with SessionSignalDetector`);
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  _getSourceForType(type) {
    const sources = {
      [EvolutionSignalType.TEST_FAILURE]: 'test-runner',
      [EvolutionSignalType.SOCRATIC_CHALLENGE]: 'socratic-challenger',
      [EvolutionSignalType.USER_FEEDBACK]: 'user-conversation',
      [EvolutionSignalType.QUALITY_GATE_FAIL]: 'quality-gate',
      [EvolutionSignalType.EXECUTION_LOG_FAIL]: 'execution-validator',
      [EvolutionSignalType.LOW_CONFIDENCE]: 'socratic-challenger',
      [EvolutionSignalType.ERROR_KEYWORD]: 'keyword-pattern',
      [EvolutionSignalType.NEGATION]: 'keyword-pattern',
      [EvolutionSignalType.RETRY_PATTERN]: 'retry-tracker',
      [EvolutionSignalType.TOOL_DENSITY]: 'tool-tracker',
      [EvolutionSignalType.COMPLAINT_FILED]: 'complaint-wall',
    };
    return sources[type] || 'unknown';
  }

  _getCategoryForSignal(type) {
    const categories = {
      [EvolutionSignalType.TEST_FAILURE]: 'pitfall',
      [EvolutionSignalType.SOCRATIC_CHALLENGE]: 'blind_spot',
      [EvolutionSignalType.USER_FEEDBACK]: 'feedback',
      [EvolutionSignalType.QUALITY_GATE_FAIL]: 'quality_issue',
      [EvolutionSignalType.EXECUTION_LOG_FAIL]: 'execution_quality',
      [EvolutionSignalType.LOW_CONFIDENCE]: 'uncertainty',
    };
    return categories[type] || 'general';
  }

  _generateTitle(type, stage, evidence) {
    const prefix = `[${type}] ${stage}:`;
    const suffix = evidence?.slice(0, 40) || '(no evidence)';
    return `${prefix} ${suffix}`;
  }

  _getSkillForStage(stage) {
    const skillMap = {
      ANALYSE: 'requirement-analysis',
      ARCHITECT: 'architecture-design',
      PLAN: 'task-planning',
      CODE: 'code-generation',
      TEST: 'test-automation',
      REVIEW: 'code-review',
      DEPLOY: 'troubleshooting',
    };
    return skillMap[stage] || null;
  }

  _normalizeEvidenceForScoring(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/\d+(?:\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9_\-\s]/g, '')
      .trim()
      .slice(0, 120);
  }

  _incrementSignalCount(type) {
    const count = this._signalCounts.get(type) || 0;
    this._signalCounts.set(type, count + 1);
  }

  _generateSessionId() {
    return `evol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  _log(message) {
    if (this.verbose) {
      console.log(message);
    }
  }

  /**
   * Reset for new session.
   */
  reset() {
    this._logBuffer = [];
    this._sessionStartTime = Date.now();
    this._sessionId = this._generateSessionId();
    this._signalCounts.clear();
    this._evolutionActions = [];
  }

  /**
   * Get stats summary.
   */
  getStats() {
    return {
      durationMs: Date.now() - this._sessionStartTime,
      totalSignals: this._logBuffer.length,
      evolutionActions: this._evolutionActions.length,
      signalCounts: Object.fromEntries(this._signalCounts),
      qualityScore: this.calculateQualityScore(),
    };
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  EvolutionLoop,
  EvolutionSignalType,
  SignalSeverity,
  LogSchema,
};
