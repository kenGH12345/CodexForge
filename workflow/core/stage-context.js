/**
 * Stage Context — Shared context builder for REQUIRED_OBSERVATION and retry context
 *
 * Provides unified context construction for both IDE Agent mode and
 * Node Orchestrator mode. Eliminates the dual-implementation gap.
 *
 * @module stage-context
 */

'use strict';

const { generatePreStageQuestions } = require('./pre-stage-questions');

function buildRequiredObservation(stage, requirement, options) {
  const opts = options || {};
  const outputPath = opts.outputPath || null;
  const requiredSchema = opts.requiredSchema || null;
  const adr37Enforcement = opts.adr37Enforcement || null;
  const crossStageContext = opts.crossStageContext || null;
  const pendingBlindSpots = opts.pendingBlindSpots || null;

  return {
    outputPath,
    requiredSchema,
    instruction: requiredSchema
      ? `After completing work, verify output/${requiredSchema.file} contains ALL required sections: ${(requiredSchema.requiredSections || []).join(', ')}. Then call stage-complete.`
      : `After completing work, call stage-complete.`,
    verificationNote: 'stage-complete will HARD-REJECT if artifact is missing or does not contain required sections.',
    adr37Enforcement,
    preStageThinking: generatePreStageQuestions(stage, requirement || ''),
    ...(crossStageContext ? { crossStageContext } : {}),
    ...(pendingBlindSpots && pendingBlindSpots.length > 0 ? { pendingBlindSpots } : {}),
  };
}

function buildRetryContext(previousChallenge, options) {
  if (!previousChallenge && !options) return null;
  const opts = options || {};

  return {
    revisionSummary: previousChallenge?.revisionSummary || null,
    questions: previousChallenge?.questions || opts.socraticQuestions || [],
    blindSpots: previousChallenge?.blindSpots || opts.blindSpots || [],
    previousConfidence: previousChallenge?.previousConfidence || opts.confidence || null,
    triggerReasons: previousChallenge?.triggerReasons || opts.triggerReasons || [],
    p2Protocol: previousChallenge?.p2Protocol || null,
    ...(opts.retryCount !== undefined ? { retryCount: opts.retryCount } : {}),
    ...(opts.maxRetry !== undefined ? { maxRetry: opts.maxRetry } : {}),
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.instruction ? { instruction: opts.instruction } : {}),
  };
}

module.exports = { buildRequiredObservation, buildRetryContext };
