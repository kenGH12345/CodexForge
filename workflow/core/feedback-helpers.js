/**
 * Feedback Helpers – Lightweight integration for Agent Feedback System
 *
 * Design Goals:
 *   - Provide easy-to-use functions for agents to submit feedback
 *   - Avoid tight coupling between agents and feedback system
 *   - Support both programmatic feedback and quality gate failures
 *   - Integrate with existing orchestrator lifecycle
 *
 * Usage:
 *   const { setGlobalFeedbackSystem, submitCodeQualityFeedback } = require('./feedback-helpers');
 *   
 *   // In orchestrator initialization:
 *   setGlobalFeedbackSystem(orchestrator.feedbackSystem);
 *   
 *   // In TESTER agent:
 *   submitCodeQualityFeedback({
 *     source: 'TESTER',
 *     target: 'DEVELOPER',
 *     score: 0.85,
 *     issues: [{ type: 'missing_tests', message: '...', severity: 'medium' }],
 *   });
 */

'use strict';

// ─── Global State ───────────────────────────────────────────────────────────

let _globalFeedbackSystem = null;

/**
 * Sets the global feedback system instance.
 * Called by orchestrator during initialization.
 *
 * @param {AgentFeedbackSystem} feedbackSystem
 */
function setGlobalFeedbackSystem(feedbackSystem) {
  _globalFeedbackSystem = feedbackSystem;
}

/**
 * Gets the current global feedback system.
 * @returns {AgentFeedbackSystem|null}
 */
function getGlobalFeedbackSystem() {
  return _globalFeedbackSystem;
}

/**
 * Clears the global feedback system.
 * Called during teardown.
 */
function clearGlobalFeedbackSystem() {
  _globalFeedbackSystem = null;
}

/**
 * Checks if feedback system is available.
 * @returns {boolean}
 */
function isFeedbackSystemAvailable() {
  return _globalFeedbackSystem !== null && typeof _globalFeedbackSystem.collectFeedback === 'function';
}

// ─── Feedback Submissions ───────────────────────────────────────────────────

/**
 * Submits code quality feedback from TESTER to DEVELOPER.
 * This is the primary feedback channel for code quality issues.
 *
 * @param {object} opts
 * @param {number} opts.score - Quality score (0.0-1.0)
 * @param {Array<{type:string, message:string, severity:string}>} opts.issues - Issues found
 * @param {string} [opts.comments] - Additional comments
 * @param {string} [opts.artifactId] - Reference to test report or code
 * @param {object} [opts.context] - Additional context
 */
function submitCodeQualityFeedback(opts) {
  if (!isFeedbackSystemAvailable()) {
    if (process.env.DEBUG) {
      console.log('[FeedbackHelpers] ⚠️  Feedback system not available, skipping code quality feedback');
    }
    return null;
  }

  const {
    score,
    issues = [],
    comments,
    artifactId,
    context = {},
  } = opts;

  return _globalFeedbackSystem.collectFeedback('TESTER', 'DEVELOPER', {
    type: 'quality',
    score,
    issues,
    comments,
    artifactId,
    metadata: {
      feedbackType: 'code_quality',
      ...context,
    },
  });
}

/**
 * Submits plan quality feedback from DEVELOPER to PLANNER.
 * Used when implementation reveals issues in the plan.
 *
 * @param {object} opts
 * @param {number} opts.score - Plan quality score (0.0-1.0)
 * @param {Array<{type:string, message:string}>} opts.issues - Plan issues
 * @param {string} [opts.comments] - Additional comments
 * @param {string} [opts.artifactId] - Reference to implementation
 */
function submitPlanQualityFeedback(opts) {
  if (!isFeedbackSystemAvailable()) return null;

  const {
    score,
    issues = [],
    comments,
    artifactId,
  } = opts;

  return _globalFeedbackSystem.collectFeedback('DEVELOPER', 'PLANNER', {
    type: 'clarity',
    score,
    issues,
    comments,
    artifactId,
    metadata: {
      feedbackType: 'plan_quality',
    },
  });
}

/**
 * Submits architecture design feedback from PLANNER to ARCHITECT.
 *
 * @param {object} opts
 * @param {number} opts.score - Design quality score (0.0-1.0)
 * @param {Array<{type:string, message:string}>} opts.issues - Design issues
 * @param {string} [opts.comments] - Additional comments
 */
function submitArchitectureFeedback(opts) {
  if (!isFeedbackSystemAvailable()) return null;

  const {
    score,
    issues = [],
    comments,
  } = opts;

  return _globalFeedbackSystem.collectFeedback('PLANNER', 'ARCHITECT', {
    type: 'correctness',
    score,
    issues,
    comments,
    metadata: {
      feedbackType: 'architecture_quality',
    },
  });
}

/**
 * Records a quality gate failure.
 * Automatically generates negative feedback to the upstream agent.
 *
 * @param {object} opts
 * @param {string} opts.stage - Stage where quality gate failed
 * @param {string} opts.agent - Agent being evaluated
 * @param {string} opts.reason - Reason for failure
 * @param {object} [opts.context] - Additional context
 * @returns {object|null} Feedback record
 */
function submitQualityGateFailure(opts) {
  if (!isFeedbackSystemAvailable()) return null;

  const {
    stage,
    agent,
    reason,
    context = {},
  } = opts;

  // Map stage to upstream agent
  const upstreamMap = {
    'TEST': 'DEVELOPER',
    'CODE': 'PLANNER',
    'PLAN': 'ARCHITECT',
    'ARCHITECT': 'ANALYST',
  };

  const targetAgent = upstreamMap[stage];
  if (!targetAgent) {
    console.warn(`[FeedbackHelpers] ⚠️  Unknown stage for quality gate: ${stage}`);
    return null;
  }

  return _globalFeedbackSystem.recordQualityGateFailure(targetAgent, stage, reason, {
    downstreamAgent: agent,
    ...context,
  });
}

/**
 * Records a correction/rollback event as feedback.
 * When a correction is needed, it implies the previous output had quality issues.
 *
 * @param {object} opts
 * @param {string} opts.targetAgent - Agent whose output needed correction
 * @param {number} opts.round - Correction round number
 * @param {Array} opts.failures - Failures found that triggered correction
 * @param {string} [opts.comments] - Additional context
 */
function submitCorrectionFeedback(opts) {
  if (!isFeedbackSystemAvailable()) return null;

  const {
    targetAgent,
    round,
    failures = [],
    comments,
  } = opts;

  // Calculate score based on correction round
  // Round 1 correction: 0.7, Round 2: 0.5, Round 3+: 0.3
  const baseScore = Math.max(0.3, 0.9 - (round * 0.2));

  const issues = failures.map(f => ({
    type: f.type || 'correction_needed',
    message: f.finding || f.message || f.description || 'Issue found',
    severity: f.severity || 'medium',
  }));

  // Derive source from target
  const sourceMap = {
    'DEVELOPER': 'TESTER',
    'PLANNER': 'DEVELOPER',
    'ARCHITECT': 'PLANNER',
    'ANALYST': 'ARCHITECT',
  };
  const sourceAgent = sourceMap[targetAgent] || 'QualityGate';

  return _globalFeedbackSystem.collectFeedback(sourceAgent, targetAgent, {
    type: 'quality',
    score: baseScore,
    issues,
    comments: comments || `Correction round ${round} required`,
    metadata: {
      feedbackType: 'correction',
      round,
    },
  });
}

// ─── Integration Helpers ────────────────────────────────────────────────────

/**
 * Integrates feedback system with orchestrator lifecycle.
 * Called once during orchestrator initialization.
 *
 * @param {object} orchestrator - The orchestrator instance
 */
function integrateWithOrchestrator(orchestrator) {
  if (!orchestrator || !orchestrator.feedbackSystem) {
    console.log('[FeedbackHelpers] ℹ️  No feedback system in orchestrator, skipping integration');
    return false;
  }

  setGlobalFeedbackSystem(orchestrator.feedbackSystem);

  // Hook into orchestrator teardown
  const originalTeardown = orchestrator._finalizeWorkflow;
  if (originalTeardown) {
    orchestrator._finalizeWorkflow = async function(...args) {
      // Original teardown
      const result = await originalTeardown.apply(this, args);
      
      // Clear global reference
      clearGlobalFeedbackSystem();
      
      return result;
    };
  }

  console.log('[FeedbackHelpers] ✅ Integrated with orchestrator lifecycle');
  return true;
}

/**
 * Analyzes test results to generate quality score and issues.
 * Helper for TESTER agent to convert test results into feedback.
 *
 * @param {object} testResults - Test results from TESTER
 * @param {object} [opts] - Options
 * @returns {{ score: number, issues: Array, summary: string }}
 */
function analyzeTestResults(testResults, opts = {}) {
  const {
    totalTests = 0,
    passedTests = 0,
    failedTests = 0,
    errors = [],
    warnings = [],
  } = testResults;

  // Calculate base score
  let score = totalTests > 0 ? passedTests / totalTests : 0;

  // Deduct for errors and warnings
  score -= (errors.length * 0.15);
  score -= (warnings.length * 0.05);
  score = Math.max(0, Math.min(1, score));

  // Convert to issues
  const issues = [
    ...errors.map(e => ({
      type: e.type || 'test_failure',
      message: e.message || e.description || String(e),
      severity: 'high',
    })),
    ...warnings.map(w => ({
      type: w.type || 'test_warning',
      message: w.message || w.description || String(w),
      severity: 'medium',
    })),
  ];

  // Summary
  const summary = `${passedTests}/${totalTests} tests passed. ${errors.length} errors, ${warnings.length} warnings.`;

  return { score, issues, summary };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Global management
  setGlobalFeedbackSystem,
  getGlobalFeedbackSystem,
  clearGlobalFeedbackSystem,
  isFeedbackSystemAvailable,

  // Feedback submissions
  submitCodeQualityFeedback,
  submitPlanQualityFeedback,
  submitArchitectureFeedback,
  submitQualityGateFailure,
  submitCorrectionFeedback,

  // Integration
  integrateWithOrchestrator,

  // Utilities
  analyzeTestResults,
};
