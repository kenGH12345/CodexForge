'use strict';

const DEFAULT_CONTEXT_BUDGET_POLICY = {
  enabled: true,
  requirementMaxChars: 8000,
  stageBudgets: {
    ANALYSE: 12000,
    ARCHITECT: 14000,
    PLAN: 10000,
    CODE: 14000,
    TEST: 12000,
  },
};

function createContextBudgetPolicy(config = {}) {
  const userCfg = config.contextBudgetPolicy && typeof config.contextBudgetPolicy === 'object'
    ? config.contextBudgetPolicy
    : {};
  return {
    ...DEFAULT_CONTEXT_BUDGET_POLICY,
    ...userCfg,
    stageBudgets: {
      ...DEFAULT_CONTEXT_BUDGET_POLICY.stageBudgets,
      ...(userCfg.stageBudgets || {}),
    },
  };
}

function enforceRequirementBudget(requirement, config = {}) {
  const policy = createContextBudgetPolicy(config);
  const text = String(requirement || '');

  if (!policy.enabled || text.length <= policy.requirementMaxChars) {
    return {
      requirement: text,
      truncated: false,
      maxChars: policy.requirementMaxChars,
    };
  }

  // silent truncation hides prompt-budget bugs; make it visible
  console.error(`[context-budget] requirement truncated: ${text.length} -> ${policy.requirementMaxChars} chars`);
  return {
    requirement: text.slice(0, policy.requirementMaxChars),
    truncated: true,
    maxChars: policy.requirementMaxChars,
  };
}

function buildStageBudgetPlan(config = {}) {
  const policy = createContextBudgetPolicy(config);
  return {
    enabled: policy.enabled,
    stageBudgets: policy.stageBudgets,
    totalBudget: Object.values(policy.stageBudgets).reduce((sum, n) => sum + Number(n || 0), 0),
  };
}

module.exports = {
  DEFAULT_CONTEXT_BUDGET_POLICY,
  createContextBudgetPolicy,
  enforceRequirementBudget,
  buildStageBudgetPlan,
};