/**
 * Socratic Challenger – Trigger Engine (ADR-56 Decomposition)
 *
 * Extracted from socratic-challenger.js.
 * Handles the weighted scoring trigger mechanism that decides whether
 * a challenge is warranted for a given artifact.
 *
 * F3: Severity-Based Trigger — only HIGH severity blind spots
 *     (FIRST_PRINCIPLES/LOGIC, miss count >= 4) trigger challenge.
 * ADR-51: Weighted scoring with configurable threshold (0.40).
 *
 * @module workflow/core/socratic-trigger-engine
 */

'use strict';

const {
  STAGE_POSITION_WEIGHTS,
} = require('./socratic-constants');

/**
 * Decide whether to trigger a challenge based on evidence/risk/logic gap.
 * Weighted scoring with configurable threshold (default 0.40).
 *
 * @param {object} params
 * @param {string} params.stageName - Current stage
 * @param {string[]} params.claims - Extracted claims
 * @param {string[]} params.blindSpots - Detected blind spots
 * @param {number} params.confidence - Calculated confidence score
 * @param {string} params.confidenceStatus - Confidence status
 * @param {string|null} params.confidenceReason - Confidence reason
 * @param {object|null} params.evidenceBreakdown - Evidence breakdown
 * @param {object|null} params.dimensionScores - Dimension scores
 * @param {object} params.taskFingerprint - Task type fingerprint
 * @param {object} params.context - Additional context
 * @returns {{ shouldChallenge: boolean, triggerScore: number, triggerThreshold: number, reasons: string[], scoredReasons: Array }}
 */
function decideChallengeTrigger(params) {
  const {
    stageName,
    claims = [],
    blindSpots = [],
    confidence,
    confidenceStatus,
    confidenceReason,
    evidenceBreakdown,
    dimensionScores,
    taskFingerprint,
    context = {},
  } = params;

  const reasons = [];

  const highRiskStages = new Set(['ARCHITECT', 'CODE', 'TEST']);
  const isHighRiskStage = highRiskStages.has(String(stageName || '').toUpperCase());

  // ── Claim gap detection ────────────────────────────────────────────────
  const supportedClaims = Number(evidenceBreakdown?.coveredClaims || 0);
  const totalClaims = Number(evidenceBreakdown?.claimCount || 0);
  const hasClaimGap = totalClaims > 0 && supportedClaims < totalClaims;
  if (hasClaimGap) {
    reasons.push(`claim_gap:${supportedClaims}/${totalClaims}`);
  }

  // ── Low confidence signal ──────────────────────────────────────────────
  const lowConfidence = confidenceStatus === 'ok' && Number.isFinite(confidence) && confidence < 0.62;
  if (lowConfidence) {
    reasons.push(`low_confidence:${(confidence * 100).toFixed(0)}%`);
  }

  // ── Low dimension signals ──────────────────────────────────────────────
  const lowLogic = Number.isFinite(dimensionScores?.LOGIC) && dimensionScores.LOGIC < 0.60;
  const lowFirstPrinciples = Number.isFinite(dimensionScores?.FIRST_PRINCIPLES) && dimensionScores.FIRST_PRINCIPLES < 0.60;
  const lowEvidence = Number.isFinite(dimensionScores?.EVIDENCE) && dimensionScores.EVIDENCE < 0.60;
  if (lowLogic) reasons.push('low_logic');
  if (lowFirstPrinciples) reasons.push('low_first_principles');
  if (lowEvidence) reasons.push('low_evidence');

  // ── F3: Severity-Based Trigger ─────────────────────────────────────────
  // After D4 aggregation, blind spots are max 5 and always >= 2 for non-trivial
  // artifacts, making the old threshold meaningless. Now only HIGH severity
  // blind spots (involving FIRST_PRINCIPLES or LOGIC dimensions) trigger challenge.
  // Industry reference: Claude Code has no blind_spots counter — model self-judges.
  const blindSpotCount = Array.isArray(blindSpots) ? blindSpots.length : 0;

  // Plan A: Tighten high-severity blind spot trigger — require severity=high AND miss count >= 4
  const hasHighSeverityBlindSpot = Array.isArray(blindSpots) && blindSpots.some(bs => {
    const isHighSev = /严重度: high/i.test(bs);
    const missCountMatch = bs.match(/(\d+)项检查未通过/);
    const missCount = missCountMatch ? parseInt(missCountMatch[1], 10) : 0;
    return isHighSev && missCount >= 4;
  });
  if (hasHighSeverityBlindSpot) {
    reasons.push(`blind_spots_high_severity:${blindSpotCount}`);
  }

  // ── High risk stage + low confidence ───────────────────────────────────
  const taskRiskProfile = Array.isArray(taskFingerprint?.riskProfile) ? taskFingerprint.riskProfile : [];
  const hasRiskProfileForStage = taskRiskProfile.some(r => ['security', 'latency', 'rollback', 'compatibility'].includes(r));
  if (isHighRiskStage && hasRiskProfileForStage && lowConfidence) {
    reasons.push('high_risk_stage_low_confidence');
  }

  // ── Explicit overrides ─────────────────────────────────────────────────
  const explicitForce = context?.forceChallenge === true;
  const explicitSkip = context?.skipChallenge === true;

  if (explicitSkip) {
    return { shouldChallenge: false, triggerScore: 0, triggerThreshold: 0.40, scoredReasons: [], reasons: ['explicit_skip'] };
  }

  if (explicitForce) {
    return { shouldChallenge: true, triggerScore: 1.0, triggerThreshold: 0.40, scoredReasons: [{ reason: 'explicit_force', weight: 1.0 }], reasons: ['explicit_force', ...reasons] };
  }

  // ── ADR-51: Weighted scoring trigger ──────────────────────────────────
  const REASON_WEIGHTS = {
    claim_gap: 0.40,                    // Strong signal: evidence doesn't cover claims
    low_confidence: 0.35,               // Strong signal: overall confidence below 62%
    blind_spots_high_severity: 0.35,     // Strong signal: critical blind spots
    high_risk_stage_low_confidence: 0.30, // Compound signal: risk × low confidence
    low_logic: 0.15,                    // Moderate signal: logic dimension weak
    low_first_principles: 0.15,         // Moderate signal: first-principles dimension weak
    low_evidence: 0.12,                 // Moderate signal: evidence dimension weak
  };

  let triggerScore = 0;
  const scoredReasons = [];
  for (const r of reasons) {
    const prefix = Object.keys(REASON_WEIGHTS).find(k => r.startsWith(k));
    const weight = prefix ? REASON_WEIGHTS[prefix] : 0.05;
    triggerScore += weight;
    scoredReasons.push({ reason: r, weight });
  }

  // Stage position bonus: earlier stages (ANALYSE, ARCHITECT) get a small boost
  const stageBonus = STAGE_POSITION_WEIGHTS[String(stageName || '').toUpperCase()] || 0;
  triggerScore += stageBonus;

  // ── Dynamic Threshold Calculation ──────────────────────────────────────
  let TRIGGER_THRESHOLD = 0.40; // Default strict threshold
  
  const triageScore = Number(context?.triageScore);
  const hasHighRiskProfile = taskRiskProfile.some(r => ['security', 'latency', 'rollback', 'compatibility', 'auth', 'database'].includes(r));
  
  if (!hasHighRiskProfile && !Number.isNaN(triageScore)) {
    if (triageScore < 40) {
      TRIGGER_THRESHOLD = 0.65; // Low risk, low complexity -> relax threshold
    } else if (triageScore < 70) {
      TRIGGER_THRESHOLD = 0.50; // Medium risk/complexity -> moderate threshold
    }
  }

  const shouldChallenge = triggerScore >= TRIGGER_THRESHOLD;

  return {
    shouldChallenge,
    triggerScore: Math.round(triggerScore * 100) / 100,
    triggerThreshold: TRIGGER_THRESHOLD,
    scoredReasons,
    reasons: reasons.length > 0 ? reasons : ['no_critical_gap'],
  };
}

/**
 * Build P2 revision protocol when challenge is triggered.
 * [T-004] Upgraded to cove-self-refine-v2 with effect tracking integration.
 * When effectRecord.deltaOverall < 0.05, adds reChallengeInstructions
 * targeting remaining blind spots (CoVe-lite verification loop).
 * @param {string} stageName - Current stage
 * @param {object} params - { questions, blindSpots, triggerReasons, context, effectRecord }
 * @returns {{ name: string, verificationQuestions: string[], steps: string[], evidenceChecks: string[], rewriteInstructions: string[], reChallengeInstructions?: object, promptHint: string }|null}
 */
function buildP2RevisionProtocol(stageName, params) {
  if (!params) return null;

  const { questions = [], blindSpots = [], triggerReasons = [], context = {}, effectRecord = null } = params;

  if (questions.length === 0 && blindSpots.length === 0) return null;

  const requirement = context ? String(context.requirement || context.rawRequirement || '').trim() : '';
  const selectedQuestions = (questions || []).slice(0, Math.max(2, 3));

  const verificationQuestions = selectedQuestions.map((q, idx) => {
    const normalized = String(q || '').trim();
    return `V${idx + 1}: ${normalized}`;
  });

  const evidenceChecks = (blindSpots || []).slice(0, 3).map((bs, idx) => `E${idx + 1}: 针对"${_truncateBlindSpot(bs, 80)}"补充可验证证据`);

  const rewriteInstructions = [
    '仅修改被验证问题命中的段落，避免整篇重写。',
    '每个核心结论至少补充一条证据（测试、日志、指标或推导链）。',
    '若结论无法被证据支持，必须明确降级为假设并标注后续验证。',
    '输出末尾追加"Revision Notes"说明回答了哪些验证问题与具体改动。',
  ];

  // [T-004] CoVe-lite verification loop: low effect delta triggers re-challenge
  let reChallengeInstructions = null;
  if (effectRecord && typeof effectRecord.deltaOverall === 'number' && effectRecord.deltaOverall < 0.05) {
    reChallengeInstructions = {
      trigger: 'low_effect_delta',
      deltaOverall: effectRecord.deltaOverall,
      remainingBlindSpots: effectRecord.blindSpotsAfter || [],
      instruction: `追问效果不足（信心度仅提升 ${(effectRecord.deltaOverall * 100).toFixed(1)}%），请针对以下未消除盲点补充验证：${(effectRecord.blindSpotsAfter || []).join('、')}`,
    };
  }

  const protocolName = effectRecord && typeof effectRecord.deltaOverall === 'number' && effectRecord.deltaOverall < 0.05
    ? 'cove-self-refine-v2'
    : 'cove-self-refine-lite';
  return {
    name: protocolName,
    requirement: requirement ? _truncateText(requirement, 120) : '',
    triggerReasons: triggerReasons || [],
    verificationQuestions,
    evidenceChecks,
    rewriteInstructions,
    reChallengeInstructions,
    promptHint: `使用 ${protocolName}: 先逐条回答 verificationQuestions，再按 rewriteInstructions 修订产物。${reChallengeInstructions ? ' 最后检查 reChallengeInstructions 判断是否需要二次追问。' : ''}`,
  };
}

function _truncateBlindSpot(bs, maxLen) {
  const str = String(bs || '').replace(/⚠️\s*\[BLIND SPOT\]\s*/, '');
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function _truncateText(s, maxLen) {
  const str = String(s || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  decideChallengeTrigger,
  buildP2RevisionProtocol,
};
