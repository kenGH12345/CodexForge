/**
 * Socratic Challenger – Confidence Calculator (ADR-56 Decomposition)
 *
 * Extracted from socratic-challenger.js.
 * Handles all confidence scoring, evidence evaluation, and
 * stage-specific confidence assessment logic.
 *
 * Preserves the original evidence-chain-v2 model:
 *   1. F1: Stage-specific evaluator (Agentless/Claude Code pattern)
 *   2. Eleven dimension scoring (semantic signal matching)
 *   3. Content quality score
 *   4. Claim-level evidence chain score
 *   5. Evidence slot coverage (task-specific)
 *   6. Blind spot penalty with cap
 *   7. Red flag penalty with cap
 *   8. isMockLlm branch (P0-B fix)
 *   9. Insufficient-evidence abstain
 *
 * @module workflow/core/socratic-confidence-calculator
 */

'use strict';

const {
  ELEVEN_DIMENSIONS,
  STAGE_POSITION_WEIGHTS,
} = require('./socratic-constants');

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Calculate confidence in the agent's conclusions.
 * P0: abstain (N/A) under mock/evidence-insufficient conditions.
 * P1: cap penalties to avoid collapsing to 0 for noisy blind spots.
 * P2+: evidence-slot + claim-evidence chain hybrid scoring.
 *
 * @param {object} instance - SocraticChallenger instance (for utility methods)
 * @param {string} content - Artifact content
 * @param {string[]} claims - Extracted claims
 * @param {string[]} blindSpots - Detected blind spots
 * @param {object} context - Context with stageName, taskFingerprint, isMockLlm
 * @returns {{ confidence: number, confidenceStatus: string, confidenceReason: string|null, evidenceBreakdown: object|null, dimensionScores: object|null }}
 */
function calculateConfidence(instance, content, claims, blindSpots, context = {}) {
  const contentLower = String(content || '').toLowerCase();
  const isMockLlm = context.isMockLlm === true || String(context.llmSource || '').toLowerCase() === 'mock';
  const stageName = context.stageName || context.stage || '';
  const taskFingerprint = context.taskFingerprint || {};

  // ── F1: Stage-Specific Evaluator (Agentless/Claude Code pattern) ──────────
  // Instead of a universal keyword-matching confidence model, use stage-specific
  // completion detectors that understand each stage's output format.
  // TEST stage: parse pass/fail counts directly (test-based verification).
  // DEVELOP stage: check for code evidence (file paths, diffs).
  // This eliminates the "floor effect" where 9/9 passed gets 8.7% confidence.
  const stageSpecificResult = evaluateStageSpecificConfidence(instance, stageName, content, contentLower, claims, blindSpots);
  if (stageSpecificResult) {
    return stageSpecificResult;
  }

  // ── Eleven Dimension Score (semantic signal matching) ───────────────────
  const dimensionScores = {};

  for (const [dimKey, dim] of Object.entries(ELEVEN_DIMENSIONS)) {
    const coveredChecks = (dim.checks || []).filter(check => {
      const signals = _expandCheckSignals(check);
      return signals.some(s => _containsSignal(contentLower, s));
    });
    const score = (dim.checks || []).length > 0 ? coveredChecks.length / dim.checks.length : 0.5;
    dimensionScores[dimKey] = score;
  }

  const weights = {
    RELEVANCE: 0.07,
    BREADTH: 0.06,
    DEPTH: 0.08,
    LOGIC: 0.12,
    CLARITY: 0.10,
    PRECISION: 0.10,
    BOUNDARY: 0.07,
    EVIDENCE: 0.08,
    DATA: 0.07,
    INDUSTRY_COMPARISON: 0.04,
    ROI_ASSESSMENT: 0.08,
    FIRST_PRINCIPLES: 0.13,
  };

  let dimensionScore = 0;
  for (const [dimKey, score] of Object.entries(dimensionScores)) {
    dimensionScore += score * (weights[dimKey] || 0.10);
  }

  // ── Content Quality Score ────────────────────────────────────────────────
  let contentScore = 0.5;
  if (content.length > 500) contentScore += 0.1;
  if (content.length > 1000) contentScore += 0.1;
  if (/because|since|therefore|due to|因为|由于/i.test(content)) contentScore += 0.15;
  if (/tested|verified|validated|confirmed|测试|验证/i.test(content)) contentScore += 0.15;
  contentScore = Math.min(1, contentScore);

  // ── Claim-level Evidence Chain Score ─────────────────────────────────────
  const evidence = scoreClaimEvidence(instance, content, claims);
  const evidenceChainScore = evidence.score;

  // ── Evidence Slot Coverage (task-specific) ───────────────────────────────
  const slotCoverage = _scoreEvidenceSlots(content, taskFingerprint, stageName);

  // ── Blind Spot Penalty with Cap ──────────────────────────────────────────
  const highPriorityBlindSpots = (blindSpots || []).filter(bs => bs.includes('数据支撑') || bs.includes('结论依据'));
  const otherBlindSpots = (blindSpots || []).filter(bs => !bs.includes('数据支撑') && !bs.includes('结论依据'));
  const blindSpotPenaltyRaw = (highPriorityBlindSpots.length * 0.08) + (otherBlindSpots.length * 0.04);
  const blindSpotPenalty = Math.min(0.25, blindSpotPenaltyRaw);

  // ── Red Flags with Cap ───────────────────────────────────────────────────
  let redFlagPenaltyRaw = 0;
  if (/TODO|TBD|FIXME|placeholder|待定|待办/i.test(content)) redFlagPenaltyRaw += 0.2;
  if (/假设|推测|可能大概/i.test(content)) redFlagPenaltyRaw += 0.1;
  const redFlagPenalty = Math.min(0.2, redFlagPenaltyRaw);

  // ── P0: Abstain when confidence signal is not meaningful ────────────────
  const coverageEvidence = [
    dimensionScores.EVIDENCE || 0,
    dimensionScores.DATA || 0,
    dimensionScores.LOGIC || 0,
    evidence.coverage || 0,
    slotCoverage.coverage || 0,
  ];
  const avgCoverageEvidence = coverageEvidence.reduce((a, b) => a + b, 0) / coverageEvidence.length;

  if (isMockLlm) {
    // ── P0-B Fix: isMockLlm does NOT mean the artifact is mock ──────────────
    // isMockLlm=true means the LLM *call* was mocked (no LLM rewrite of questions),
    // but the artifact content is REAL (written by the IDE Agent).
    const rawScore = (dimensionScore * 0.6) + (contentScore * 0.4);
    const finalConfidence = Math.max(0, Math.min(1, rawScore - blindSpotPenalty - redFlagPenalty));
    return {
      confidence: finalConfidence,
      confidenceStatus: 'ok',  // 'ok' enables shouldRetry evaluation
      confidenceReason: 'artifact_content_score',
      dimensionScores,
      evidenceBreakdown: {
        model: 'evidence-chain-v2',
        mode: 'mock_llm_real_artifact',
        claimCount: evidence.claimCount,
        coveredClaims: evidence.coveredClaims,
        supportRatio: evidence.coverage,
        reasoningSignal: evidence.reasoningSignal,
        evidenceSignal: evidence.evidenceSignal,
        slotCoverage: slotCoverage.coverage,
        expectedSlots: slotCoverage.expectedSlots,
        hitSlots: slotCoverage.hitSlots,
        missingSlots: slotCoverage.missingSlots,
        dimensionScore,
        contentScore,
        blindSpotPenalty,
        redFlagPenalty,
        finalConfidence,
      },
    };
  }

  if ((evidence.claimCount < 2 && slotCoverage.hitCount === 0) || avgCoverageEvidence < 0.15) {
    return {
      confidence: 0,
      confidenceStatus: 'na',
      confidenceReason: 'insufficient_evidence',
      dimensionScores,
      evidenceBreakdown: {
        model: 'evidence-chain-v2',
        mode: 'insufficient',
        claimCount: evidence.claimCount,
        coveredClaims: evidence.coveredClaims,
        supportRatio: evidence.coverage,
        reasoningSignal: evidence.reasoningSignal,
        evidenceSignal: evidence.evidenceSignal,
        slotCoverage: slotCoverage.coverage,
        expectedSlots: slotCoverage.expectedSlots,
        hitSlots: slotCoverage.hitSlots,
        missingSlots: slotCoverage.missingSlots,
        avgCoverageEvidence,
        dimensionScore,
        contentScore,
      },
    };
  }

  // ── Final Score ──────────────────────────────────────────────────────────
  // Evidence chain and slot coverage dominate; dimensions are hygiene factors.
  const finalScore =
    evidenceChainScore * 0.45 +
    slotCoverage.coverage * 0.2 +
    dimensionScore * 0.2 +
    contentScore * 0.15 -
    blindSpotPenalty -
    redFlagPenalty;

  const confidence = Math.max(0, Math.min(1, finalScore));

  return {
    confidence,
    confidenceStatus: 'ok',
    confidenceReason: null,
    dimensionScores,
    evidenceBreakdown: {
      model: 'evidence-chain-v2',
      mode: 'normal',
      claimCount: evidence.claimCount,
      coveredClaims: evidence.coveredClaims,
      supportRatio: evidence.coverage,
      reasoningSignal: evidence.reasoningSignal,
      evidenceSignal: evidence.evidenceSignal,
      evidenceChainScore,
      slotCoverage: slotCoverage.coverage,
      expectedSlots: slotCoverage.expectedSlots,
      hitSlots: slotCoverage.hitSlots,
      missingSlots: slotCoverage.missingSlots,
      dimensionScore,
      contentScore,
      blindSpotPenalty,
      blindSpotPenaltyRaw,
      redFlagPenalty,
      redFlagPenaltyRaw,
    },
  };
}

// ─── F1: Stage-Specific Evaluator ────────────────────────────────────────────
// Instead of a universal keyword-matching confidence model, each stage has its own
// "completion detector" that understands the stage's output format.
// This eliminates the "floor effect" where TEST stage 9/9 passed gets 8.7% confidence.
//
// Returns a confidence result object if stage-specific evaluation applies, or null
// to fall through to the generic evaluator.
function evaluateStageSpecificConfidence(instance, stageName, content, contentLower, claims, blindSpots) {
  const stageUpper = String(stageName || '').toUpperCase();

  // ── TEST stage: parse pass/fail counts directly (test-based verification) ──
  if (stageUpper === 'TEST') {
    const passFailPatterns = [
      /(\d+)\s*\/\s*(\d+)\s*(?:passed|通过|成功)/i,
      /(\d+)\s*(?:passed|通过|成功)\s*[,，]\s*(\d+)\s*(?:failed|失败)/i,
      /pass(?:ed)?[:\s]+(\d+)\s*[,，\s]+fail(?:ed)?[:\s]+(\d+)/i,
      /tests?[:\s]+(\d+)\s*passed/i,
      /(\d+)\s*tests?\s*passed\s*[,，]\s*(\d+)\s*tests?\s*failed/i,
    ];

    let testPassed = 0, testTotal = 0, testFailed = 0;
    let matched = false;

    for (const pattern of passFailPatterns) {
      const m = contentLower.match(pattern);
      if (m) {
        if (pattern === passFailPatterns[0]) {
          testPassed = parseInt(m[1], 10);
          testTotal = parseInt(m[2], 10);
          testFailed = testTotal - testPassed;
        } else if (pattern === passFailPatterns[3]) {
          testPassed = parseInt(m[1], 10);
          testTotal = testPassed;
          testFailed = 0;
        } else {
          testPassed = parseInt(m[1], 10);
          testFailed = parseInt(m[2], 10);
          testTotal = testPassed + testFailed;
        }
        matched = true;
        break;
      }
    }

    if (!matched && /all\s+(?:\d+\s+)?tests?\s+passed|所有.*测试.*通过/i.test(content)) {
      const numMatch = content.match(/all\s+(\d+)\s+tests?\s+passed/i);
      testPassed = numMatch ? parseInt(numMatch[1], 10) : 1;
      testTotal = testPassed;
      testFailed = 0;
      matched = true;
    }

    if (matched && testTotal > 0) {
      const passRate = testPassed / testTotal;
      const baseConfidence = 0.05 + passRate * 0.90;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const hasExecutionEvidence = /\$|npm test|jest|pytest|mocha|vitest|go test|cargo test|dotnet test/i.test(content);
      const executionBonus = hasExecutionEvidence ? 0.05 : 0;
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty + executionBonus));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_test_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'test_evaluator',
          testPassed,
          testFailed,
          testTotal,
          passRate,
          baseConfidence,
          blindSpotPenalty: bsPenalty,
          executionBonus,
          hasExecutionEvidence,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── DEVELOP stage: check for code evidence (file paths, diffs) ──
  if (stageUpper === 'DEVELOP' || stageUpper === 'CODE') {
    const hasDiffMarkers = /^[+-]{3}\s|^@@\s|^diff --git/m.test(content);
    const hasFilePaths = /\b[\w\-./]+\.(js|ts|py|go|java|cs|rb|rs|cpp|c|h|jsx|tsx|vue|svelte)\b/i.test(content);
    const hasCodeBlocks = (content.match(/```/g) || []).length >= 2;

    if (hasDiffMarkers || (hasFilePaths && hasCodeBlocks)) {
      const addedLines = (content.match(/^\+[^+]/gm) || []).length;
      const removedLines = (content.match(/^-[^-]/gm) || []).length;
      const totalChanges = addedLines + removedLines;

      const changeScore = Math.min(1, Math.log10(Math.max(1, totalChanges)) / 2.5);
      const baseConfidence = 0.4 + changeScore * 0.5;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_develop_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'develop_evaluator',
          hasDiffMarkers,
          hasFilePaths,
          hasCodeBlocks,
          addedLines,
          removedLines,
          totalChanges,
          changeScore,
          baseConfidence,
          blindSpotPenalty: bsPenalty,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── ANALYSE stage: check for root cause analysis structure ──
  if (stageUpper === 'ANALYSE') {
    const hasRootCause = /root\s*cause|根因|根本原因|impact|影响范围|affected/i.test(content);
    const hasFileRefs = /\b[\w\-./]+\.(js|ts|py|go|java|cs)\b/i.test(content);
    const hasHeadings = (content.match(/^#+\s+/gm) || []).length >= 3;

    if (hasRootCause && hasFileRefs && hasHeadings) {
      const baseConfidence = 0.75;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));
      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_analyse_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'analyse_evaluator',
          hasRootCause,
          hasFileRefs,
          hasHeadings,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── ARCHITECT stage: check for architecture decision evidence ──
  if (stageUpper === 'ARCHITECT') {
    const hasComponents = /component|module|layer|service|interface|接口|组件|模块|架构/i.test(content);
    const hasDecisions = /decision|选择|选型|trade.?off|权衡|rationale|理由/i.test(content);
    const hasHeadings = (content.match(/^#+\s+/gm) || []).length >= 2;

    if (hasComponents && hasHeadings) {
      const baseConfidence = hasDecisions ? 0.70 : 0.60;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_architect_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'architect_evaluator',
          hasComponents,
          hasDecisions,
          hasHeadings,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── PLAN stage: check for task list and execution structure ──
  if (stageUpper === 'PLAN') {
    const hasTaskList = /task|任务|step|步骤|phase|阶段|T\d+|#+ Task/i.test(content);
    const hasPriority = /priority|优先|P[012]|顺序|order|依赖|depend/i.test(content);
    const hasHeadings = (content.match(/^#+\s+/gm) || []).length >= 2;

    if (hasTaskList && hasHeadings) {
      const baseConfidence = hasPriority ? 0.70 : 0.60;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_plan_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'plan_evaluator',
          hasTaskList,
          hasPriority,
          hasHeadings,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── REVIEW stage: check for review verdict and risk assessment ──
  if (stageUpper === 'REVIEW') {
    // LIGHTWEIGHT branch: short artifact with no substantive content
    const isLightweight = /\[LIGHTWEIGHT\]/i.test(content);
    if (isLightweight) {
      return {
        confidence: 0.40,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_review_evaluator_lightweight',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'review_evaluator_lightweight',
          isLightweight: true,
          finalConfidence: 0.40,
        },
      };
    }

    const hasReviewVerdict = /approved|rejected|通过|否决|needs?\s*changes?|APPROVED|REJECTED|审查通过|审查拒绝/i.test(content);
    const hasRiskRating = /P[0123]|critical|high\s*risk|medium\s*risk|low\s*risk|严重|高风险|中风险|低风险/i.test(content);
    const hasFileRefs = /\b[\w\-./]+\.(js|ts|py|go|java|cs|md|rb|rs)\b/i.test(content);
    const hasHeadings = (content.match(/^#+\s+/gm) || []).length >= 2;

    if (hasReviewVerdict && hasHeadings) {
      let baseConfidence = 0.55;
      if (hasRiskRating) baseConfidence += 0.15;
      if (hasFileRefs) baseConfidence += 0.05;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_review_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'review_evaluator',
          hasReviewVerdict,
          hasRiskRating,
          hasFileRefs,
          hasHeadings,
          baseConfidence,
          blindSpotPenalty: bsPenalty,
          finalConfidence: confidence,
        },
      };
    }
  }

  // ── DEPLOY stage: check for deployment evidence and file changes ──
  if (stageUpper === 'DEPLOY') {
    // LIGHTWEIGHT branch
    const isLightweight = /\[LIGHTWEIGHT\]/i.test(content);
    if (isLightweight) {
      return {
        confidence: 0.40,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_deploy_evaluator_lightweight',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'deploy_evaluator_lightweight',
          isLightweight: true,
          finalConfidence: 0.40,
        },
      };
    }

    const hasDeployEvidence = /deployed|deploy|部署|激活|activated|changes?\s*live|修改.*生效|已上线/i.test(content);
    const hasFileChanges = /\d+\s*files?\s*(modified|changed|updated)|\d+\s*个文件|checkout|rollback|回滚|git\s+push/i.test(content);
    const hasRollbackStrategy = /rollback|回滚|revert|撤回|fallback|降级/i.test(content);

    if (hasDeployEvidence) {
      let baseConfidence = 0.55;
      if (hasFileChanges) baseConfidence += 0.15;
      if (hasRollbackStrategy) baseConfidence += 0.05;
      const bsPenalty = Math.min(0.15, (blindSpots?.length || 0) * 0.03);
      const confidence = Math.max(0, Math.min(1, baseConfidence - bsPenalty));

      return {
        confidence,
        confidenceStatus: 'ok',
        confidenceReason: 'stage_specific_deploy_evaluator',
        dimensionScores: null,
        evidenceBreakdown: {
          model: 'stage-specific-v1',
          mode: 'deploy_evaluator',
          hasDeployEvidence,
          hasFileChanges,
          hasRollbackStrategy,
          baseConfidence,
          blindSpotPenalty: bsPenalty,
          finalConfidence: confidence,
        },
      };
    }
  }

  // No stage-specific evaluator matched → fall through to generic
  return null;
}

// ─── Signal Matching ─────────────────────────────────────────────────────────

/**
 * Check if content contains a signal (using expanded check signals).
 */
function _containsSignal(contentLower, signal) {
  const normalized = String(contentLower || '').toLowerCase();
  const candidates = _expandCheckSignals(signal);
  return candidates.some(s => normalized.includes(String(s).toLowerCase()));
}

/**
 * Expand a check name into a list of content signals.
 */
function _expandCheckSignals(check) {
  const key = String(check || '').toLowerCase();
  const dict = {
    'stakeholders identified': ['stakeholder', 'stakeholders', '利益相关方', '相关方'],
    'use cases covered': ['use case', '场景', '用例', '覆盖'],
    'alternatives considered': ['alternative', 'trade-off', '备选方案', '替代方案'],
    'dependencies mapped': ['dependency', 'dependencies', '依赖'],
    'impacts analyzed': ['impact', '影响'],
    'root cause identified': ['root cause', '根因', '本质原因'],
    'assumptions challenged': ['assumption', '假设'],
    'trade-offs analyzed': ['trade-off', '权衡'],
    'technical depth': ['algorithm', '复杂度', '技术细节', '实现细节'],
    'rationale provided': ['because', 'therefore', 'reason', '依据', '原因'],
    'reasoning chain valid': ['推理', 'reasoning', '因果链', '逻辑链'],
    'premises consistent with conclusion': ['前提', '结论', 'premise', 'conclusion'],
    'terms clearly defined': ['定义', 'definition', '术语'],
    'no ambiguous language': ['歧义', 'ambiguous', '清晰'],
    'specific numbers provided': ['%', 'ms', 'qps', '数字', '数值'],
    'timeline defined': ['timeline', '截止', '日期', '里程碑'],
    'constraints explicit': ['constraint', '约束'],
    'edge cases handled': ['edge case', '边界', '异常场景'],
    'failure modes identified': ['failure', '故障', '失败模式'],
    'recovery strategy': ['rollback', '回滚', '降级', '恢复'],
    'tests referenced': ['test', '测试', '断言'],
    'benchmarks cited': ['benchmark', '基准', '压测'],
    'metrics defined': ['metric', '指标'],
    'quantified goals': ['目标', '量化'],
    'baseline established': ['baseline', '基线'],
    'industry best practices referenced': ['best practice', '最佳实践', '行业标准'],
    'competitor analysis': ['竞品', 'competitor', '对比'],
    'standards compliance': ['standard', 'compliance', '规范'],
    'proven patterns used': ['pattern', '模式', '成熟方案'],
    'fundamental facts identified': ['fundamental', '基本事实', '本质约束'],
    'analogies challenged': ['类比', '惯例', 'analog'],
    'assumptions decomposed': ['假设拆解', 'assumption'],
    'derived from basics': ['推导', 'derived', '从零'],
    'convention questioned': ['惯例', 'convention'],
    'benefits quantified': ['benefit', '收益', '收益量化', '价值', 'value', '提升', 'improvement'],
    'risks assessed with probability': ['risk', '风险', '概率', 'probability', '发生概率', 'likelihood'],
    'cost estimated': ['cost', '成本', '代价', '投入', 'effort', '工时', '复杂度'],
    'roi calculated or argued': ['roi', '投入产出', '性价比', 'cost-benefit', 'worth', '值得'],
    'worst case acceptable': ['worst', '最坏', '最差', 'worst.case', '底线', '可接受'],
  };
  return dict[key] || [check];
}

// ─── Evidence Slot Scoring ───────────────────────────────────────────────────

/**
 * Build expected evidence slots based on task fingerprint and stage.
 */
function _buildEvidenceSlots(taskFingerprint = {}, stageName = '') {
  const slots = new Set();
  slots.add('reasoning');
  slots.add('tests');

  const taskType = taskFingerprint.taskType || 'feature';
  if (taskType === 'bugfix') {
    slots.add('logs');
    slots.add('repro');
    slots.add('root_cause');
  }
  if (taskType === 'ops') {
    slots.add('metrics');
    slots.add('rollback_proof');
  }
  if (taskType === 'research') {
    slots.add('benchmark');
    slots.add('industry_comparison');
  }
  if (taskType === 'refactor') {
    slots.add('diff_scope');
    slots.add('compatibility');
  }
  if (taskType === 'enhancement') {
    slots.add('baseline_comparison');
    slots.add('metrics');
  }
  if (taskType === 'migration') {
    slots.add('compatibility');
    slots.add('rollback_proof');
    slots.add('data_integrity');
  }
  if (taskType === 'integration') {
    slots.add('interfaces');
    slots.add('error_handling');
    slots.add('timeout_strategy');
  }

  const risks = Array.isArray(taskFingerprint.riskProfile) ? taskFingerprint.riskProfile : [];
  if (risks.includes('latency')) slots.add('metrics');
  if (risks.includes('security')) slots.add('threat_model');
  if (risks.includes('rollback')) slots.add('rollback_proof');
  if (risks.includes('compatibility')) slots.add('compatibility');
  if (risks.includes('data_integrity')) slots.add('data_integrity');

  if (stageName === 'ARCHITECT') slots.add('interfaces');
  if (stageName === 'PLAN') slots.add('dependencies');
  if (stageName === 'TEST') slots.add('coverage');

  return [...slots];
}

/**
 * Score evidence slot coverage for the given content.
 */
function _scoreEvidenceSlots(content, taskFingerprint = {}, stageName = '') {
  const contentLower = String(content || '').toLowerCase();
  const expectedSlots = _buildEvidenceSlots(taskFingerprint, stageName);

  const slotSignals = {
    reasoning: [/because|therefore|due to|since|因为|所以|因此|推导/i],
    tests: [/test|测试|assert|spec|case/i],
    logs: [/log|trace|日志|链路/i],
    repro: [/repro|复现|步骤|scenario/i],
    root_cause: [/root cause|根因|本质原因|causal/i],
    metrics: [/metric|指标|qps|latency|p95|p99|throughput/i],
    rollback_proof: [/rollback|回滚|降级|fallback|恢复/i],
    benchmark: [/benchmark|基准|对比实验|ab test/i],
    industry_comparison: [/industry|best practice|业界|竞品|标准/i],
    diff_scope: [/diff|变更范围|scope|impact/i],
    compatibility: [/compat|兼容|migration|breaking change/i],
    threat_model: [/threat|auth|permission|security|攻击/i],
    interfaces: [/api|interface|contract|协议|输入输出/i],
    dependencies: [/depend|依赖|前置|blocked by/i],
    coverage: [/coverage|覆盖率|path coverage|分支覆盖/i],
  };

  const hitSlots = [];
  for (const slot of expectedSlots) {
    const patterns = slotSignals[slot] || [];
    if (patterns.some(p => p.test(contentLower))) {
      hitSlots.push(slot);
    }
  }

  const coverage = expectedSlots.length > 0 ? hitSlots.length / expectedSlots.length : 0;

  return {
    coverage,
    hitCount: hitSlots.length,
    expectedSlots,
    hitSlots,
    missingSlots: expectedSlots.filter(s => !hitSlots.includes(s)),
  };
}

// ─── Claim Evidence Scoring ──────────────────────────────────────────────────

/**
 * Score claim evidence — how well claims are supported by content.
 */
function scoreClaimEvidence(instance, content, claims = []) {
  const normalizedContent = String(content || '');
  const contentLower = normalizedContent.toLowerCase();

  const extractedClaims = (claims || [])
    .map(c => String(c || '').trim())
    .filter(Boolean)
    .slice(0, 12);

  const fallbackClaims = extractedClaims.length > 0
    ? extractedClaims
    : _extractFallbackClaimsFromContent(normalizedContent);

  const claimCount = fallbackClaims.length;
  if (claimCount === 0) {
    return { score: 0, claimCount: 0, coveredClaims: 0, coverage: 0, reasoningSignal: 0, evidenceSignal: 0 };
  }

  let coveredClaims = 0;
  for (const claim of fallbackClaims) {
    if (_isClaimSupported(claim, contentLower)) coveredClaims++;
  }

  const coverage = coveredClaims / claimCount;
  const reasoningSignal = _computeReasoningSignal(contentLower);
  const evidenceSignal = _computeEvidenceSignal(contentLower);

  const score = Math.max(0, Math.min(1, coverage * 0.6 + reasoningSignal * 0.2 + evidenceSignal * 0.2));

  return { score, claimCount, coveredClaims, coverage, reasoningSignal, evidenceSignal };
}

function _extractFallbackClaimsFromContent(content) {
  const text = String(content || '');
  const candidates = text
    .split(/\n|\.|。|;|；/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => /实现|完成|支持|提供|improve|optimiz|implement|support|deliver|ensure|verified|tested/i.test(s));
  return candidates.slice(0, 8);
}

function _isClaimSupported(claim, contentLower) {
  const claimText = String(claim || '').trim().toLowerCase();
  if (!claimText) return false;

  const tokens = claimText.split(/\s+/).filter(t => t.length >= 4).slice(0, 6);
  const tokenHit = tokens.some(t => contentLower.includes(t));

  const hasEvidenceNear = /(test|验证|evidence|proof|benchmark|metric|coverage|assert|日志|trace)/i.test(contentLower);
  const hasReasoningNear = /(because|therefore|due to|since|因为|所以|因此|由于|推导)/i.test(contentLower);

  if (tokens.length === 0) return hasEvidenceNear || hasReasoningNear;
  return tokenHit && (hasEvidenceNear || hasReasoningNear);
}

function _computeReasoningSignal(contentLower) {
  const markers = [
    /because|therefore|due to|since|derived|hence/i,
    /因为|所以|因此|由于|推导|因果|逻辑链/,
  ];
  const hitCount = markers.reduce((sum, p) => sum + (p.test(contentLower) ? 1 : 0), 0);
  return Math.min(1, hitCount / markers.length);
}

function _computeEvidenceSignal(contentLower) {
  const markers = [
    /test|verified|validated|coverage|assert|benchmark|metric|trace|log/i,
    /测试|验证|覆盖率|断言|基准|指标|日志|证据/,
    /\d+\s*(ms|s|qps|%|kb|mb|gb|x)/i,
  ];
  const hitCount = markers.reduce((sum, p) => sum + (p.test(contentLower) ? 1 : 0), 0);
  return Math.min(1, hitCount / markers.length);
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  calculateConfidence,
  scoreClaimEvidence,
  evaluateStageSpecificConfidence,
  _expandCheckSignals,   // shared with other modules
  _containsSignal,       // shared with other modules
  _buildEvidenceSlots,   // shared with other modules
  _scoreEvidenceSlots,   // shared with other modules
};
