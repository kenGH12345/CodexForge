'use strict';

const DEFAULT_LIMITS = {
  maxGlobalSkills: 8,
  maxProjectSkills: 16,
  maxBuiltinSkills: 64,
  maxClassificationRules: 40,
  maxCustomDetectionRulesPerType: 20,
  maxSocraticUniversalRules: 16,
  maxSocraticStageRulesPerStage: 12,
  maxSocraticArtifactRules: 12,
  maxHookPolicies: 24,
  maxToolHookMetricsHistory: 5000,
};

function applyConfigGovernance(inputConfig = {}) {
  const config = cloneObject(inputConfig);
  const governance = {
    ...(config.configurationGovernance || {}),
  };

  const enabled = governance.enabled !== false;
  const limits = {
    ...DEFAULT_LIMITS,
    ...(governance.limits || {}),
  };

  const report = {
    enabled,
    limits,
    warnings: [],
    metrics: {
      skills: {},
      rules: {},
      hooks: {},
    },
  };

  if (!enabled) {
    return { config, report };
  }

  // ── Skills governance ────────────────────────────────────────────────────
  config.globalSkills = normalizeUniqueStringArray(config.globalSkills, 'globalSkills', report);
  config.projectSkills = normalizeUniqueStringArray(config.projectSkills, 'projectSkills', report);

  config.globalSkills = capArray(config.globalSkills, limits.maxGlobalSkills, 'globalSkills', report);
  config.projectSkills = capArray(config.projectSkills, limits.maxProjectSkills, 'projectSkills', report);

  if (Array.isArray(config.builtinSkills)) {
    const dedupedBuiltin = [];
    const seenBuiltin = new Set();
    for (const item of config.builtinSkills) {
      const name = item && typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      if (seenBuiltin.has(name)) {
        report.warnings.push(`[ConfigGovernance] Duplicate builtin skill removed: ${name}`);
        continue;
      }
      seenBuiltin.add(name);
      dedupedBuiltin.push(item);
    }
    config.builtinSkills = capArray(dedupedBuiltin, limits.maxBuiltinSkills, 'builtinSkills', report);
  }

  report.metrics.skills = {
    globalSkills: Array.isArray(config.globalSkills) ? config.globalSkills.length : 0,
    projectSkills: Array.isArray(config.projectSkills) ? config.projectSkills.length : 0,
    builtinSkills: Array.isArray(config.builtinSkills) ? config.builtinSkills.length : 0,
  };

  // ── Rules governance ─────────────────────────────────────────────────────
  if (Array.isArray(config.classificationRules)) {
    config.classificationRules = capArray(
      config.classificationRules,
      limits.maxClassificationRules,
      'classificationRules',
      report
    );
  }

  if (config.customDetectionRules && typeof config.customDetectionRules === 'object') {
    const cdr = config.customDetectionRules;
    if (Array.isArray(cdr.frameworks)) {
      cdr.frameworks = capArray(cdr.frameworks, limits.maxCustomDetectionRulesPerType, 'customDetectionRules.frameworks', report);
    }
    if (Array.isArray(cdr.dataLayer)) {
      cdr.dataLayer = capArray(cdr.dataLayer, limits.maxCustomDetectionRulesPerType, 'customDetectionRules.dataLayer', report);
    }
    if (Array.isArray(cdr.testFrameworks)) {
      cdr.testFrameworks = capArray(cdr.testFrameworks, limits.maxCustomDetectionRulesPerType, 'customDetectionRules.testFrameworks', report);
    }
  }

  if (config.socraticChallenge && typeof config.socraticChallenge === 'object') {
    const sc = config.socraticChallenge;

    if (Array.isArray(sc.universalRules)) {
      sc.universalRules = capArray(sc.universalRules, limits.maxSocraticUniversalRules, 'socraticChallenge.universalRules', report);
    }

    if (sc.stageRules && typeof sc.stageRules === 'object') {
      for (const [stage, rules] of Object.entries(sc.stageRules)) {
        if (!Array.isArray(rules)) continue;
        sc.stageRules[stage] = capArray(
          rules,
          limits.maxSocraticStageRulesPerStage,
          `socraticChallenge.stageRules.${stage}`,
          report
        );
      }
    }

    if (Array.isArray(sc.artifactRules)) {
      sc.artifactRules = capArray(sc.artifactRules, limits.maxSocraticArtifactRules, 'socraticChallenge.artifactRules', report);
    }
  }

  report.metrics.rules = {
    classificationRules: Array.isArray(config.classificationRules) ? config.classificationRules.length : 0,
    socraticUniversalRules: Array.isArray(config.socraticChallenge?.universalRules) ? config.socraticChallenge.universalRules.length : 0,
    socraticArtifactRules: Array.isArray(config.socraticChallenge?.artifactRules) ? config.socraticChallenge.artifactRules.length : 0,
  };

  // ── Hooks governance ─────────────────────────────────────────────────────
  if (Array.isArray(config.hookPolicies)) {
    config.hookPolicies = capArray(config.hookPolicies, limits.maxHookPolicies, 'hookPolicies', report);
  }

  if (config.toolHooks && typeof config.toolHooks === 'object') {
    const current = Number(config.toolHooks.maxMetricsHistory || 0);
    if (current > limits.maxToolHookMetricsHistory) {
      report.warnings.push(
        `[ConfigGovernance] toolHooks.maxMetricsHistory capped: ${current} -> ${limits.maxToolHookMetricsHistory}`
      );
      config.toolHooks.maxMetricsHistory = limits.maxToolHookMetricsHistory;
    }
  }

  report.metrics.hooks = {
    hookPolicies: Array.isArray(config.hookPolicies) ? config.hookPolicies.length : 0,
    toolHooksEnabled: config.toolHooks?.enabled !== false,
    maxMetricsHistory: Number(config.toolHooks?.maxMetricsHistory || 0),
  };

  config.configurationGovernance = {
    ...governance,
    enabled: true,
    limits,
    _lastAppliedAt: new Date().toISOString(),
  };

  if (report.warnings.length > 0) {
    // config governance warnings are silent by default; surface them so operators can act
    console.error(`[config-governance] applied with ${report.warnings.length} warning(s): ${report.warnings.slice(0, 3).join(' | ')}${report.warnings.length > 3 ? ' ...' : ''}`);
  }

  return { config, report };
}

function normalizeUniqueStringArray(arr, label, report) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (seen.has(value)) {
      report.warnings.push(`[ConfigGovernance] Duplicate ${label} entry removed: ${value}`);
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function capArray(arr, max, label, report) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= max) return arr;
  report.warnings.push(`[ConfigGovernance] ${label} capped: ${arr.length} -> ${max}`);
  return arr.slice(0, max);
}

function cloneObject(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

module.exports = {
  DEFAULT_LIMITS,
  applyConfigGovernance,
};