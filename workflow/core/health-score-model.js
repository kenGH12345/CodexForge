'use strict';

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, value));
}

function gradeByThreshold(score, thresholds) {
  if (score >= thresholds.A) return 'A';
  if (score >= thresholds.B) return 'B';
  if (score >= thresholds.C) return 'C';
  if (score >= thresholds.D) return 'D';
  return 'F';
}

function createHealthScoringModel(scoringConfig = {}) {
  const scoringWeights = scoringConfig.weights || {};
  const scoringPenalties = scoringConfig.penalties || {};
  const gradeThresholds = scoringConfig.gradeThresholds || {};

  const weights = {
    completeness: toFiniteNumber(scoringWeights.completeness, 0.35),
    process: toFiniteNumber(scoringWeights.process, 0.20),
    delivery: toFiniteNumber(scoringWeights.delivery, 0.30),
    detection: toFiniteNumber(scoringWeights.detection, 0.15),
  };

  const penalties = {
    missingStage: toFiniteNumber(scoringPenalties.missingStage, 20),
    socraticMax: toFiniteNumber(scoringPenalties.socraticMax, 20),
    metricsGatePerFailedStage: toFiniteNumber(scoringPenalties.metricsGatePerFailedStage, 5),
    metricsGateMax: toFiniteNumber(scoringPenalties.metricsGateMax, 25),
    ineffectiveChallengeMax: toFiniteNumber(scoringPenalties.ineffectiveChallengeMax, 15),
  };

  const thresholds = {
    A: toFiniteNumber(gradeThresholds.A, 90),
    B: toFiniteNumber(gradeThresholds.B, 80),
    C: toFiniteNumber(gradeThresholds.C, 70),
    D: toFiniteNumber(gradeThresholds.D, 60),
  };

  return {
    model: scoringConfig.model || 'unified-v2',
    weights,
    penalties,
    thresholds,
  };
}

function computeHealthScore({
  completenessOk,
  missingStages = [],
  presentStages = [],
  socraticCoveredStages = [],
  failedGateStages = [],
  challengedStages = [],
  effectiveChallengeStages = [],
  deliveryScore = 100,
  detectionScore = 100,
  scoringConfig = {},
}) {
  const scoringModel = createHealthScoringModel(scoringConfig);
  const { model, weights, penalties, thresholds } = scoringModel;

  const uniqMissingStages = Array.from(new Set((missingStages || []).filter(Boolean)));
  const uniqPresentStages = Array.from(new Set((presentStages || []).filter(Boolean)));
  const uniqSocraticCoveredStages = Array.from(new Set((socraticCoveredStages || []).filter(Boolean)));
  const uniqFailedGateStages = Array.from(new Set((failedGateStages || []).filter(Boolean)));
  const uniqChallengedStages = Array.from(new Set((challengedStages || []).filter(Boolean)));
  const uniqEffectiveChallengeStages = Array.from(new Set((effectiveChallengeStages || []).filter(Boolean)));

  const completenessScore = completenessOk
    ? 100
    : Math.max(0, 100 - uniqMissingStages.length * penalties.missingStage);

  const completedStagesCount = uniqPresentStages.length;
  const socraticCoveredCount = uniqPresentStages.filter(s => uniqSocraticCoveredStages.includes(s)).length;
  const socraticCoverage = completedStagesCount > 0 ? socraticCoveredCount / completedStagesCount : 0;

  const challengedCount = uniqChallengedStages.length;
  const effectiveCount = uniqEffectiveChallengeStages.filter(s => uniqChallengedStages.includes(s)).length;
  const effectiveChallengeRate = challengedCount > 0 ? effectiveCount / challengedCount : 1;

  const socraticPenalty = Math.round((1 - socraticCoverage) * penalties.socraticMax);
  const metricsGatePenalty = Math.min(
    penalties.metricsGateMax,
    uniqFailedGateStages.length * penalties.metricsGatePerFailedStage
  );
  const ineffectiveChallengePenalty = challengedCount > 0
    ? Math.round((1 - effectiveChallengeRate) * penalties.ineffectiveChallengeMax)
    : 0;

  const processScore = Math.max(0, 100 - socraticPenalty - metricsGatePenalty - ineffectiveChallengePenalty);

  const normalizedDeliveryScore = Number.isFinite(deliveryScore) ? deliveryScore : processScore;
  const normalizedDetectionScore = Number.isFinite(detectionScore) ? detectionScore : processScore;

  const healthScore = clampScore(
    Math.round((
      weights.completeness * completenessScore +
      weights.process * processScore +
      weights.delivery * normalizedDeliveryScore +
      weights.detection * normalizedDetectionScore
    ) * 10) / 10
  );

  const healthGrade = gradeByThreshold(healthScore, thresholds);

  return {
    model,
    score: healthScore,
    grade: healthGrade,
    weights,
    penalties,
    thresholds,
    breakdown: {
      completenessScore,
      processScore,
      deliveryScore: normalizedDeliveryScore,
      detectionScore: normalizedDetectionScore,
      socraticCoverage: Number((socraticCoverage * 100).toFixed(1)),
      effectiveChallengeRate: Number((effectiveChallengeRate * 100).toFixed(1)),
      socraticPenalty,
      metricsGatePenalty,
      ineffectiveChallengePenalty,
      uniqueMissingStages: uniqMissingStages,
      uniquePresentStages: uniqPresentStages,
      uniqueSocraticCoveredStages: uniqSocraticCoveredStages,
      uniqueFailedGateStages: uniqFailedGateStages,
      uniqueChallengedStages: uniqChallengedStages,
      uniqueEffectiveChallengeStages: uniqEffectiveChallengeStages,
    },
  };
}

module.exports = {
  toFiniteNumber,
  clampScore,
  gradeByThreshold,
  createHealthScoringModel,
  computeHealthScore,
};