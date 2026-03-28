/**
 * Issue Classifier – Classifies issues for action routing
 *
 * Determines whether an issue should be:
 *   - Auto-fixed (low risk, high benefit)
 *   - Submitted for user decision (needs human judgment)
 *   - Deferred (low priority)
 */

'use strict';

const { IssuePriority, FixRisk, FixCostBenefit } = require('./self-audit-types');

// ─── Classification Maps ────────────────────────────────────────────────────

/**
 * Maps issue types to severity levels.
 */
const SEVERITY_MAP = {
  'incomplete-module': IssuePriority.HIGH,
  'missing-error-handling': IssuePriority.HIGH,
  'naming-consistency': IssuePriority.MEDIUM,
  'data-flow-break': IssuePriority.HIGH,
  'architecture-violation': IssuePriority.MEDIUM,
  'historical-pitfall': IssuePriority.HIGH,
};

/**
 * Maps issue types to fix risk levels.
 */
const RISK_MAP = {
  'incomplete-module': FixRisk.HIGH,
  'missing-error-handling': FixRisk.MEDIUM,
  'naming-consistency': FixRisk.LOW,
  'data-flow-break': FixRisk.HIGH,
  'architecture-violation': FixRisk.HIGH,
  'historical-pitfall': FixRisk.MEDIUM,
};

/**
 * Issue types that pose workflow risk (could break pipeline).
 */
const WORKFLOW_RISK_TYPES = ['incomplete-module', 'data-flow-break', 'architecture-violation'];

/**
 * Maps issue types to suggested fixes.
 */
const FIX_SUGGESTION_MAP = {
  'incomplete-module': 'Complete the implementation, adding missing entry points or exports',
  'missing-error-handling': 'Add try-catch blocks for error-prone operations',
  'naming-consistency': 'Standardize naming convention (choose either camelCase or snake_case)',
  'data-flow-break': 'Verify data flow: ensure exports are used or remove unused ones',
  'architecture-violation': 'Reduce file size by refactoring or splitting into smaller modules',
  'historical-pitfall': 'Review against known pitfall pattern and apply mitigation',
};

// ─── Classification Function ────────────────────────────────────────────────

/**
 * Classifies an issue to determine the appropriate action.
 *
 * Action routing rules:
 *   - AUTO-FIX: severity ∈ {CRITICAL, HIGH} AND fixRisk = LOW AND costBenefit ∈ {HIGH, MEDIUM}
 *   - USER-DECISION: All others (need human judgment)
 *
 * @param {object} issue - Raw issue from module check
 * @param {object} module - Module where issue was found
 * @param {string} stage - Stage name
 * @returns {object} Classified issue with action recommendation
 */
function classifyIssue(issue, module, stage) {
  const id = `ISS-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // Determine severity
  const severity = issue.severity || SEVERITY_MAP[issue.type] || IssuePriority.MEDIUM;

  // Determine fix risk
  const fixRisk = RISK_MAP[issue.type] || FixRisk.MEDIUM;

  // Determine cost-benefit based on severity and risk
  let costBenefit;
  if (severity === IssuePriority.CRITICAL || severity === IssuePriority.HIGH) {
    costBenefit = fixRisk === FixRisk.LOW ? FixCostBenefit.HIGH : FixCostBenefit.MEDIUM;
  } else {
    costBenefit = fixRisk === FixRisk.LOW ? FixCostBenefit.MEDIUM : FixCostBenefit.LOW;
  }

  // Determine action
  const shouldAutoFix =
    (severity === IssuePriority.CRITICAL || severity === IssuePriority.HIGH) &&
    fixRisk === FixRisk.LOW &&
    (costBenefit === FixCostBenefit.HIGH || costBenefit === FixCostBenefit.MEDIUM);

  const isWorkflowRisk = WORKFLOW_RISK_TYPES.includes(issue.type);
  const action = shouldAutoFix && !isWorkflowRisk ? 'auto-fix' : 'user-decision';

  // Generate rationale
  let rationale;
  if (action === 'auto-fix') {
    rationale = `${severity} severity, ${fixRisk} risk, ${costBenefit} cost-benefit → safe to auto-fix`;
  } else if (isWorkflowRisk) {
    rationale = `${severity} severity but workflow risk detected → needs user decision`;
  } else {
    rationale = `${severity} severity, ${fixRisk} risk, ${costBenefit} cost-benefit → needs user judgment`;
  }

  // Generate suggested fix
  const suggestedFix = issue.suggestedFix || FIX_SUGGESTION_MAP[issue.type] || `Fix the issue in ${module.name}`;

  return {
    id,
    module: module.name,
    path: module.path,
    dimension: issue.type,
    title: issue.title,
    description: issue.description,
    severity,
    priority: severity,
    fixRisk,
    costBenefit,
    suggestedFix,
    action,
    rationale,
    evidence: issue.evidence,
  };
}

/**
 * Generates a suggested fix for an issue type.
 *
 * @param {string} issueType - Type of issue
 * @param {string} moduleName - Name of the module
 * @returns {string} Suggested fix
 */
function generateSuggestedFix(issueType, moduleName) {
  return FIX_SUGGESTION_MAP[issueType] || `Fix the issue in ${moduleName}`;
}

/**
 * Checks if an issue is eligible for auto-fix.
 *
 * @param {object} classifiedIssue - Classified issue
 * @returns {boolean}
 */
function isAutoFixEligible(classifiedIssue) {
  return classifiedIssue.action === 'auto-fix';
}

/**
 * Separates issues into auto-fix and user-decision categories.
 *
 * @param {object[]} classifiedIssues - Array of classified issues
 * @returns {{ autoFix: object[], userDecision: object[] }}
 */
function separateByAction(classifiedIssues) {
  return {
    autoFix: classifiedIssues.filter(i => i.action === 'auto-fix'),
    userDecision: classifiedIssues.filter(i => i.action === 'user-decision'),
  };
}

module.exports = {
  classifyIssue,
  generateSuggestedFix,
  isAutoFixEligible,
  separateByAction,
  SEVERITY_MAP,
  RISK_MAP,
  WORKFLOW_RISK_TYPES,
  FIX_SUGGESTION_MAP,
};
