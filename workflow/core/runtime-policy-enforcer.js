'use strict';

const DEFAULT_RUNTIME_POLICY = {
  enabled: true,
  requireReadBeforeWrite: true,
  blockScopeExpansion: true,
  requireApprovalForRiskyOps: true,
  riskyPatterns: [
    /\brm\s+-rf\b/i,
    /\bdrop\s+table\b/i,
    /\btruncate\s+table\b/i,
    /\bdelete\s+from\b/i,
    /\bshutdown\b/i,
    /\bformat\s+disk\b/i,
  ],
  maxRequirementChars: 8000,
};

function createRuntimePolicy(config = {}) {
  const userPolicy = config.runtimePolicy && typeof config.runtimePolicy === 'object'
    ? config.runtimePolicy
    : {};
  return {
    ...DEFAULT_RUNTIME_POLICY,
    ...userPolicy,
  };
}

function enforceRuntimePolicy(requirement, opts = {}) {
  const policy = createRuntimePolicy(opts.config || {});
  const text = String(requirement || '');
  const violations = [];

  if (!policy.enabled) {
    return { ok: true, policy, violations, warnings: [] };
  }

  if (!text.trim()) {
    violations.push('Requirement is empty.');
  }

  if (text.length > policy.maxRequirementChars) {
    violations.push(`Requirement too long (${text.length} chars, max ${policy.maxRequirementChars}).`);
  }

  if (policy.blockScopeExpansion) {
    const scopeExpansionSignals = ['顺便', '另外加', 'and also', 'by the way', 'extra feature'];
    const hit = scopeExpansionSignals.find(s => text.toLowerCase().includes(String(s).toLowerCase()));
    if (hit) {
      violations.push(`Potential scope expansion detected: "${hit}"`);
    }
  }

  const riskyMatches = [];
  if (policy.requireApprovalForRiskyOps && Array.isArray(policy.riskyPatterns)) {
    for (const pattern of policy.riskyPatterns) {
      if (pattern && typeof pattern.test === 'function' && pattern.test(text)) {
        riskyMatches.push(String(pattern));
      }
    }
  }

  const warnings = [];
  if (policy.requireReadBeforeWrite) {
    warnings.push('Policy active: must read target code/files before any write action.');
  }

  return {
    ok: violations.length === 0,
    policy,
    violations,
    warnings,
    requiresManualApproval: riskyMatches.length > 0,
    riskyMatches,
  };
}

module.exports = {
  DEFAULT_RUNTIME_POLICY,
  createRuntimePolicy,
  enforceRuntimePolicy,
};