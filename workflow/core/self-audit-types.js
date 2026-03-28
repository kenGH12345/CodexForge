/**
 * Self-Audit Types – Type definitions for issue classification and action routing
 *
 * This module defines the type system for the self-audit mechanism:
 *   - Issue priority levels
 *   - Fix risk levels
 *   - Cost-benefit ratios
 *   - Type annotations for audit results
 */

'use strict';

// ─── Issue Classification Constants ─────────────────────────────────────────

/**
 * Issue priority levels for action routing.
 * Determines whether an issue should be auto-fixed or submitted for user decision.
 */
const IssuePriority = {
  CRITICAL: 'critical',   // Must fix immediately, blocks workflow
  HIGH: 'high',           // Should fix soon, significant impact
  MEDIUM: 'medium',       // Can defer, moderate impact
  LOW: 'low',             // Nice to have, minimal impact
};

/**
 * Issue fix risk levels.
 * Determines whether auto-fix is safe or needs human judgment.
 */
const FixRisk = {
  LOW: 'low',             // Simple, deterministic fix (e.g., typo, formatting)
  MEDIUM: 'medium',       // Requires understanding context (e.g., naming consistency)
  HIGH: 'high',           // Could break other parts (e.g., interface changes)
  CRITICAL: 'critical',   // High chance of regression (e.g., core logic changes)
};

/**
 * Issue fix cost-benefit ratio.
 * Higher ratio = more worth fixing.
 */
const FixCostBenefit = {
  HIGH: 'high',           // Low effort, high impact (quick wins)
  MEDIUM: 'medium',       // Moderate effort, moderate impact
  LOW: 'low',             // High effort, low impact (defer or skip)
};

// ─── Type Definitions ───────────────────────────────────────────────────────

/**
 * @typedef {Object} ClassifiedIssue
 * @property {string} id - Unique issue ID
 * @property {string} module - Module name where issue was found
 * @property {string} path - Module file path
 * @property {string} dimension - Audit dimension
 * @property {string} title - Short description
 * @property {string} description - Detailed description
 * @property {string} severity - CRITICAL | HIGH | MEDIUM | LOW
 * @property {string} priority - CRITICAL | HIGH | MEDIUM | LOW
 * @property {string} fixRisk - LOW | MEDIUM | HIGH | CRITICAL
 * @property {string} costBenefit - HIGH | MEDIUM | LOW
 * @property {string} suggestedFix - Proposed fix
 * @property {string} action - 'auto-fix' | 'user-decision' | 'defer'
 * @property {string} rationale - Why this action was chosen
 * @property {string} [evidence] - Evidence for the issue
 */

/**
 * @typedef {Object} AuditDimension
 * @property {string} dimension - Dimension key (e.g., 'OUTPUT_COMPLETENESS')
 * @property {string} question - The question asked
 * @property {string} answer - Selected answer option
 * @property {number} confidence - Confidence score (0-1)
 * @property {string} [evidence] - Evidence/reasoning for the answer
 * @property {string} [suggestion] - Suggested improvement if confidence < 0.8
 */

/**
 * @typedef {Object} ModuleAuditResult
 * @property {string} module - Module name
 * @property {string} path - Module file path
 * @property {boolean} passed - Overall pass/fail
 * @property {number} confidence - Overall confidence score (0-1)
 * @property {ClassifiedIssue[]} issues - Classified issues
 * @property {ClassifiedIssue[]} autoFixIssues - Issues to auto-fix
 * @property {ClassifiedIssue[]} userDecisionIssues - Issues needing user decision
 */

/**
 * @typedef {Object} AuditResult
 * @property {boolean} passed - Overall pass/fail
 * @property {number} confidence - Overall confidence score (0-1)
 * @property {AuditDimension[]} dimensions - Per-dimension results
 * @property {ClassifiedIssue[]} issues - List of classified issues
 * @property {string[]} suggestions - List of improvement suggestions
 * @property {ModuleAuditResult[]} [moduleResults] - Per-module audit results
 */

/**
 * @typedef {Object} AuditConfig
 * @property {number} confidenceThreshold - Below this = fail (default: 0.7)
 * @property {number} flagThreshold - Below this = flag for review (default: 0.8)
 * @property {boolean} autoFixEnabled - Whether to auto-apply suggestions
 * @property {string} triggerMode - 'automatic' | 'manual' | 'both'
 */

/**
 * @typedef {Object} RawIssue
 * @property {string} type - Issue type identifier
 * @property {string} title - Short description
 * @property {string} description - Detailed description
 * @property {string} [evidence] - Evidence for the issue
 * @property {string} [severity] - Optional override severity
 */

module.exports = {
  IssuePriority,
  FixRisk,
  FixCostBenefit,
};
