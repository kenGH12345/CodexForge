/**
 * Socratic Challenger – Runtime Conclusion Questioning Mechanism (Facade)
 *
 * ADR-54: Proactive Quality Assurance through Socratic Questioning
 * ADR-56: P0 Decomposition — Facade pattern (like CodeGraph ADR-33)
 *
 * This file is the FACADE for the Socratic Challenger system.
 * It delegates to 5 sub-modules:
 *   1. socratic-constants.js          — Dimensions, schemas, quality config
 *   2. socratic-confidence-calculator.js — Confidence scoring + evidence eval
 *   3. socratic-question-generator.js  — Question generation pipeline
 *   4. socratic-blind-spot-detector.js — Blind spot detection + rule engine
 *   5. socratic-entity-extractor.js    — Entity extraction + artifact analysis
 *   6. socratic-trigger-engine.js      — Trigger decision + P2 revision protocol
 *
 * Original: 157 KB / 3749 lines (God class)
 * Refactored: ~8 KB / ~280 lines (Facade + delegation)
 *
 * @module workflow/core/socratic-challenger
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config-loader');

// ADR-56: Sub-module imports
const socraticConstants = require('./socratic-constants');
const { calculateConfidence, scoreClaimEvidence, evaluateStageSpecificConfidence } = require('./socratic-confidence-calculator');
const { generateSocraticQuestions, inferTaskFingerprint, generateCrossStageQuestions } = require('./socratic-question-generator');
const { detectBlindSpots, detectDimensionBlindSpots, collectRuleDrivenQuestions, buildRuleConfig } = require('./socratic-blind-spot-detector');
const { extractEntities, generateEntityGroundedQuestions, extractArtifactStructure } = require('./socratic-entity-extractor');
const { decideChallengeTrigger, buildP2RevisionProtocol } = require('./socratic-trigger-engine');

// Re-export constants for backward compatibility
const {
  TEN_DIMENSIONS,
  ELEVEN_DIMENSIONS,
  TWELVE_DIMENSIONS,
  SEVEN_DIMENSIONS,
  SIX_DIMENSIONS,
  FIVE_DIMENSIONS,
  SOCRATIC_LAYERS,
  STAGE_CHALLENGES,
  STAGE_ARTIFACT_SCHEMA,
  STAGE_POSITION_WEIGHTS,
  QUALITY_CHECK_PATTERNS,
  ANSWER_QUALITY_CONFIG,
  evaluateAnswerQuality,
} = socraticConstants;

class SocraticChallenger {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();

    let loadedConfig = {};
    try { loadedConfig = getConfig(this.projectRoot) || {}; } catch { loadedConfig = {}; }

    const socraticCfg = loadedConfig.socraticChallenge || {};
    this.maxQuestions = options.maxQuestions ?? socraticCfg.maxQuestions ?? 3;
    this.verbose = options.verbose !== false;
    this.llmCall = options.llmCall || null;
    this.ruleConfig = buildRuleConfig(null, '', socraticCfg);
    this._challengeHistory = new Map();
    this._questionHistory = [];
    this._lastRuleDiagnostics = null;
    this._lastHeadingClaims = [];
    this._lastArtifactStructure = null;
    this._sessionQuestionCoreHashes = new Set();
  }

  async challenge(stageName, output, context = {}) {
    this._log(`\n${'═'.repeat(50)}`);
    this._log(`[SocraticChallenger] 🤔 DEVIL'S ADVOCATE for stage: ${stageName}`);
    this._log(`${'═'.repeat(50)}`);

    const content = this._extractContent(output);

    if (String(content || '').includes('[LIGHTWEIGHT]')) {
      this._log(`[SocraticChallenger] 💤 LIGHTWEIGHT artifact detected — skipping all challenges`);
      return this._buildSkippedResult('lightweight_artifact', 'LIGHTWEIGHT artifact — no substantive content to challenge');
    }

    // ADR-XX: REVIEW and DEPLOY now have stage-specific evaluators.
    // Previously skipped because they lacked evaluators, causing generic
    // path to produce extremely low confidence (0.171). Now that evaluators
    // exist, they should participate in normal confidence assessment.
    const SKIP_CHALLENGE_STAGES = new Set([]);
    if (SKIP_CHALLENGE_STAGES.has(String(stageName || '').toUpperCase())) {
      const reason = `terminal_stage_${String(stageName).toLowerCase()}`;
      this._log(`[SocraticChallenger] 💤 Terminal stage ${stageName} — skipping challenge`);
      return this._buildSkippedResult(reason, `${stageName} is a terminal stage — challenge skipped`);
    }

    const claims = this._extractClaims(stageName, content, context);
    this._log(`[SocraticChallenger] 📋 Agent claims: ${claims.join(', ') || '(none explicit)'}`);

    const artifactStructure = this._lastArtifactStructure || extractArtifactStructure(content, stageName, this._truncate.bind(this));
    const detectedBlindSpots = detectBlindSpots(stageName, content, claims, context, artifactStructure, this);
    this._log(`[SocraticChallenger] 🕳️  Detected ${detectedBlindSpots.length} potential blind spots`);

    let generatedQuestions = generateSocraticQuestions(this, stageName, claims, content, context, detectedBlindSpots);

    if (this.llmCall && generatedQuestions.length > 0) {
      this._log(`[SocraticChallenger] 🧠 Rewriting questions dynamically using LLM...`);
      generatedQuestions = await this._rewriteQuestionsWithLLM(stageName, generatedQuestions, content, context);
    }

    this._log(`[SocraticChallenger] ❓ Generated ${generatedQuestions.length} challenge questions`);

    const taskFingerprint = inferTaskFingerprint(stageName, content, context);
    const confidenceResult = calculateConfidence(this, content, claims, detectedBlindSpots, { ...context, stageName, taskFingerprint });
    const { confidence, confidenceStatus, confidenceReason, evidenceBreakdown, dimensionScores } = confidenceResult;

    const confidenceLabel = confidenceStatus === 'na'
      ? `N/A (${confidenceReason || 'insufficient evidence'})`
      : `${(confidence * 100).toFixed(0)}%`;
    this._log(`[SocraticChallenger] 📊 Confidence in conclusions: ${confidenceLabel}`);

    const triggerDecision = decideChallengeTrigger({
      stageName, claims, blindSpots: detectedBlindSpots, confidence, confidenceStatus,
      confidenceReason, evidenceBreakdown, dimensionScores, taskFingerprint, context,
    });

    const challenged = triggerDecision.shouldChallenge;
    const questions = challenged ? generatedQuestions : [];
    const advisoryQuestions = !challenged ? generatedQuestions : [];
    const blindSpots = challenged ? detectedBlindSpots : [];
    const advisoryBlindSpots = !challenged ? detectedBlindSpots : [];

    this._logChallengeResult(challenged, questions, blindSpots, advisoryQuestions, triggerDecision);

    this._challengeHistory.set(stageName, {
      timestamp: new Date().toISOString(), claims, questions, blindSpots,
      confidence, confidenceStatus, confidenceReason, evidenceBreakdown, trigger: triggerDecision,
    });

    const shouldRetry = challenged && confidenceStatus === 'ok' && confidence < 0.30;
    const advisoryOnly = challenged && confidenceStatus === 'ok' && confidence >= 0.30;
    const requiresRevision = challenged && !advisoryOnly;
    const p2Protocol = challenged
      ? buildP2RevisionProtocol(stageName, { questions, blindSpots, triggerReasons: triggerDecision.reasons, context })
      : null;

    return {
      challenged, triggerReasons: triggerDecision.reasons, triggerScore: triggerDecision.triggerScore,
      triggerThreshold: triggerDecision.triggerThreshold, questions, advisoryQuestions, blindSpots,
      advisoryBlindSpots, confidence, confidenceStatus, confidenceReason, evidenceBreakdown,
      dimensionScores, shouldRetry, advisoryOnly: advisoryOnly || false, requiresRevision,
      p2Protocol, revisionSummary: {
        required: requiresRevision, reason: triggerDecision.reasons[0] || null,
        questionCount: questions.length, advisoryQuestionCount: advisoryQuestions.length,
        blindSpotCount: blindSpots.length, verificationQuestionCount: p2Protocol?.verificationQuestions?.length || 0,
        protocol: p2Protocol?.name || null,
      },
      ruleDiagnostics: this._lastRuleDiagnostics || null,
    };
  }

  _log(msg) { if (this.verbose) console.error(msg); }
  _truncate(s, maxLen = 80) { const str = String(s || ''); return str.length > maxLen ? str.slice(0, maxLen) + '…' : str; }

  _extractContent(output) {
    if (!output) return '';

    if (typeof output === 'string') {
      // Check if it looks like a file path
      if (output.includes(path.sep) || output.endsWith('.md') || output.endsWith('.txt')) {
        try {
          if (fs.existsSync(output)) {
            return fs.readFileSync(output, 'utf-8');
          }
        } catch (err) {
          this._log(`[SocraticChallenger] ⚠️  Could not read file: ${err.message}`);
        }
      }
      return output;
    }

    if (typeof output === 'object' && output.artifactPath) {
      try {
        if (fs.existsSync(output.artifactPath)) {
          return fs.readFileSync(output.artifactPath, 'utf-8');
        }
      } catch (err) {
        this._log(`[SocraticChallenger] ⚠️  Could not read artifact: ${err.message}`);
      }
    }

    if (typeof output === 'object' && output.content) {
      return output.content;
    }

    return String(output);
  }

  _extractClaims(stageName, content, context = {}) {
    const claims = [];
    const contentStr = String(content || '');

    // Get stage-specific default claims
    const stageConfig = STAGE_CHALLENGES[stageName];
    if (stageConfig && stageConfig.claims) {
      claims.push(...stageConfig.claims);
    }

    // D6: Extract heading-level claims (## headings are implicit claims about what was done)
    const headingClaims = [];
    const headingRe = /^#{1,3}\s+(.+)/gm;
    let hMatch;
    while ((hMatch = headingRe.exec(contentStr)) !== null) {
      const title = hMatch[1].trim();
      // Skip generic headings like "Overview", "Summary"
      if (title.length > 5 && !/^(overview|summary|概述|总结|table of contents|目录)$/i.test(title)) {
        headingClaims.push(title);
      }
    }

    // D6: Extract decision/conclusion statements
    const decisionPatterns = [
      /(?:决定|选择|采用|确定|结论是|因此|所以|therefore|decided to|chose|concluded)\s*[：:?\s]*\s*([^\n.。]{10,80})/gi,
      /(?:The|This)\s+(?:architecture|design|implementation|solution)\s+(?:is|provides|supports)\s+([^.]{10,80})/gi,
    ];
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = (match[1] || match[0]).trim();
        if (claim && claim.length > 10 && !claims.includes(claim)) {
          claims.push(claim);
        }
      }
    }

    // D6: Extract quantitative assertions (numbers that imply a claim)
    const quantPatterns = [
      /(?:coverage|覆盖率)\s*(?:is|at|为|达到)?\s*(\d+%?)/gi,
      /(?:performance|性能)\s+(?:improved?|提升)\s+(?:by\s+)?(\d+%?)/gi,
      /(\d+)\s*(?:tests?|测试)\s+(?:passed?|通过)/gi,
    ];
    for (const pattern of quantPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = match[0].trim();
        if (claim && !claims.includes(claim)) {
          claims.push(claim);
        }
      }
    }

    // Extract explicit claims from content (original patterns)
    const claimPatterns = [
      /(?:I have|I've|We have|completed|finished|implemented|created|designed|verified|tested)\s+([^.]+)/gi,
      /(?:All|The)\s+tests?\s+(?:passed?|passing)/gi,
    ];
    for (const pattern of claimPatterns) {
      let match;
      while ((match = pattern.exec(contentStr)) !== null) {
        const claim = match[1] || match[0];
        if (claim && !claims.includes(claim)) {
          claims.push(claim.trim());
        }
      }
    }

    // Add claims from context
    if (context.claims) {
      claims.push(...context.claims);
    }

    // D6: Store heading claims separately for targeted challenge
    this._lastHeadingClaims = headingClaims;

    // D6: Promote heading claims that contain decision/conclusion keywords to main claims
    const decisionKeywords = /决定|选择|采用|结论|方案|设计|implemented|decided|chose|selected|conclusion/i;
    for (const hc of headingClaims) {
      if (decisionKeywords.test(hc) && !claims.includes(hc)) {
        claims.push(hc);
      }
    }

    return claims;
  }

  _extractRequirementText(context) {
    if (!context) return '';
    return String(context.requirement || context.rawRequirement || '').trim();
  }

  _extractStageSnippets(content, stageName) {
    const text = String(content || '');
    const stageHeader = text.match(new RegExp(`#+\\s*${stageName}`, 'i'));
    if (!stageHeader) return [];
    const startIdx = stageHeader.index + stageHeader[0].length;
    const nextHeader = text.slice(startIdx).match(/\n#{1,4}\s+/);
    const endIdx = nextHeader ? startIdx + nextHeader.index : text.length;
    return text.slice(startIdx, endIdx).trim().split(/[。\n.!?！？]/).map(s => s.trim()).filter(s => s.length > 15).slice(0, 3);
  }

  async _rewriteQuestionsWithLLM(stageName, questions, content, context) {
    if (!this.llmCall || questions.length === 0) return questions;
    try {
      const requirement = this._extractRequirementText(context);
      const truncatedContent = String(content || '').slice(0, 3000);
      const prompt = `You are a Socratic Challenger. Rewrite the following template-based questions to be highly specific to the current context.
Do NOT change the core intent, just make them natural and directly reference specific details.
Do NOT answer the questions. Output ONLY the rewritten questions in Chinese (中文).

Stage: ${stageName}
Requirement: ${requirement}

Content Snippet:
${truncatedContent}

Original Questions:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Output ONLY the rewritten questions in Chinese, one per line, numbered (e.g., "1. ..."). Keep them concise and sharp.`;

      const response = await this.llmCall(prompt, `socratic-rewrite-${stageName.toLowerCase()}`);
      if (!response) return questions;
      const rewritten = response.split('\n').map(l => l.trim()).filter(l => /^\d+\.\s+/.test(l)).map(l => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
      return rewritten.length > 0 ? rewritten.slice(0, questions.length) : questions;
    } catch (err) {
      this._log(`[SocraticChallenger] ⚠️ LLM rewrite failed: ${err.message}`);
      return questions;
    }
  }

  _buildSkippedResult(reason, confidenceReason) {
    return {
      challenged: false, triggerReasons: [reason], triggerScore: 0, triggerThreshold: 0,
      questions: [], advisoryQuestions: [], blindSpots: [], advisoryBlindSpots: [],
      confidence: 1.0, confidenceStatus: 'na', confidenceReason, evidenceBreakdown: null,
      dimensionScores: null, shouldRetry: false, advisoryOnly: false, requiresRevision: false,
      p2Protocol: null, revisionSummary: {
        required: false, reason, questionCount: 0, advisoryQuestionCount: 0,
        blindSpotCount: 0, verificationQuestionCount: 0, protocol: null,
      },
      ruleDiagnostics: null,
    };
  }

  _logChallengeResult(challenged, questions, blindSpots, advisoryQuestions, triggerDecision) {
    if (challenged && questions.length > 0) {
      this._log(`[SocraticChallenger] ── CHALLENGE QUESTIONS ──`);
      questions.forEach((q, i) => this._log(`  ${i + 1}. ${q}`));
    }
    if (challenged && blindSpots.length > 0) {
      this._log(`[SocraticChallenger] ── BLIND SPOTS ──`);
      blindSpots.forEach((bs, i) => this._log(`  ${i + 1}. ${bs}`));
    }
    if (!challenged) {
      const scoreInfo = triggerDecision.triggerScore !== undefined ? ` (score=${triggerDecision.triggerScore}/${triggerDecision.triggerThreshold})` : '';
      this._log(`[SocraticChallenger] 💤 Trigger gate skipped challenge${scoreInfo}: ${triggerDecision.reasons.join('; ') || 'no critical evidence gap'}`);
      if (advisoryQuestions.length > 0) {
        this._log(`[SocraticChallenger] 📝 Advisory questions (${advisoryQuestions.length}):`);
        advisoryQuestions.forEach((q, i) => this._log(`  ${i + 1}. ${q}`));
      }
    }
    this._log(`${'═'.repeat(50)}\n`);
  }

  // Backward-compatible instance method wrappers
  _generateSocraticQuestions(stageName, claims, content, context = {}) { return generateSocraticQuestions(this, stageName, claims, content, context, []); }
  _detectBlindSpots(stageName, content, claims, context) { return detectBlindSpots(stageName, content, claims, context, this._lastArtifactStructure, this); }
  _calculateConfidence(content, claims, blindSpots, context = {}) { return calculateConfidence(this, content, claims, blindSpots, context); }
  _decideChallengeTrigger(params) { return decideChallengeTrigger(params); }
  _extractEntities(content, stageName) { return extractEntities(content, stageName); }
  _generateEntityGroundedQuestions(entities, stageName, content, requirement) { return generateEntityGroundedQuestions(entities, stageName, content, requirement, this._truncate.bind(this)); }
  _extractArtifactStructure(content, stageName) { return extractArtifactStructure(content, stageName, this._truncate.bind(this)); }
  _inferTaskFingerprint(stageName, content, context) { return inferTaskFingerprint(stageName, content, context); }
  _buildRuleConfig(socraticCfg) { return buildRuleConfig(null, '', socraticCfg); }
  _buildP2RevisionProtocol(stageName, params) { return buildP2RevisionProtocol(stageName, params); }
}

module.exports = {
  SocraticChallenger,
  evaluateAnswerQuality,
  ANSWER_QUALITY_CONFIG,
  SOCRATIC_LAYERS,
  STAGE_CHALLENGES,
  FIVE_DIMENSIONS,
  SIX_DIMENSIONS,
  SEVEN_DIMENSIONS,
  TEN_DIMENSIONS,
  ELEVEN_DIMENSIONS,
  TWELVE_DIMENSIONS,
  STAGE_POSITION_WEIGHTS,
  socraticConstants,
  socraticConfidenceCalculator: require('./socratic-confidence-calculator'),
  socraticQuestionGenerator: require('./socratic-question-generator'),
  socraticBlindSpotDetector: require('./socratic-blind-spot-detector'),
  socraticEntityExtractor: require('./socratic-entity-extractor'),
  socraticTriggerEngine: require('./socratic-trigger-engine'),
};
