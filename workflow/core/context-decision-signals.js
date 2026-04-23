/**
 * context-decision-signals.js
 *
 * T-0: Shared decision signal infrastructure for context engineering modules (B group: G3/G4/G5/G6).
 *
 * PROBLEM: ContextLoader, StageContextStore, ExperienceQuery, SemanticCompressor each
 * made independent static decisions. When we want dynamic behavior (budget adaptive to
 * model/stage/task), every module reinvents the same signal wheel and drifts apart.
 *
 * SOLUTION: One canonical place that returns the 3 signals every context-engineering
 * module needs:
 *   1. Model capability   → how much we CAN inject
 *   2. Stage signal       → how much a stage SHOULD get of that capacity
 *   3. Task importance    → how much a specific task deserves a boost
 *
 * This module is a pure lookup layer — no side effects, no state. Every callable is
 * deterministic given current env + config.
 */

'use strict';

const DEFAULT_TIERS = {
  small:  { maxInject: 2800,  contextWindow: 32000,   description: 'GPT-3.5 class / local 7B' },
  medium: { maxInject: 8000,  contextWindow: 128000,  description: 'GPT-4 class / Claude Haiku' },
  large:  { maxInject: 24000, contextWindow: 1000000, description: 'Claude Sonnet / GPT-4o / Gemini 1.5' },
};

const DEFAULT_TIER = 'medium';

const TASK_BOOST = {
  HIGH:   1.3,
  MEDIUM: 1.15,
  NORMAL: 1.0,
};

function _loadConfigSafe() {
  try {
    const { getConfig } = require('./config-loader');
    return getConfig() || {};
  } catch (_) {
    return {};
  }
}

/**
 * Resolve the current model tier from (in priority order):
 *   1. env var WF_MODEL_TIER  (CI/override)
 *   2. config llm.tier        (project default)
 *   3. DEFAULT_TIER            (safe middle)
 *
 * Rationale: we intentionally do NOT reuse hallucinationRiskThreshold (16K chars default)
 * as a tier proxy — that field measures hallucination warning threshold, not context window.
 * Conflating them would make small-context models appear "medium" and vice versa.
 */
function getModelTier() {
  const envTier = (process.env.WF_MODEL_TIER || '').toLowerCase().trim();
  if (envTier && DEFAULT_TIERS[envTier]) return envTier;

  const cfg = _loadConfigSafe();
  const cfgTier = cfg && cfg.llm && typeof cfg.llm.tier === 'string' ? cfg.llm.tier.toLowerCase() : null;
  if (cfgTier && DEFAULT_TIERS[cfgTier]) return cfgTier;

  return DEFAULT_TIER;
}

/**
 * Returns { tier, maxInject, contextWindow, description } for the active model.
 * maxInject can be overridden per-tier via config.llm.maxInject.<tier>.
 */
function getModelCapability() {
  const tier = getModelTier();
  const base = DEFAULT_TIERS[tier] || DEFAULT_TIERS[DEFAULT_TIER];

  const cfg = _loadConfigSafe();
  const overrides = cfg && cfg.llm && cfg.llm.maxInject && typeof cfg.llm.maxInject === 'object'
    ? cfg.llm.maxInject
    : null;
  const override = overrides && typeof overrides[tier] === 'number' ? overrides[tier] : null;

  return {
    tier,
    maxInject: override || base.maxInject,
    contextWindow: base.contextWindow,
    description: base.description,
    source: override ? 'config-override' : 'default-tier',
  };
}

/**
 * Returns { stage, multiplier } for the given stage name.
 * Reuses STAGE_BUDGET_MULTIPLIERS from token-budget.js so upstream behavior stays consistent.
 *
 * Note: the canonical stage name in token-budget.js is DEVELOPER (not CODE) and TESTER (not TEST).
 * Callers passing CODE/TEST are normalized to DEVELOPER/TESTER for compatibility.
 */
function getStageSignal(stage) {
  let { STAGE_BUDGET_MULTIPLIERS } = {};
  try {
    ({ STAGE_BUDGET_MULTIPLIERS } = require('./token-budget'));
  } catch (_) {
    STAGE_BUDGET_MULTIPLIERS = {};
  }

  const normalized = _normalizeStage(stage);
  const multiplier = STAGE_BUDGET_MULTIPLIERS && typeof STAGE_BUDGET_MULTIPLIERS[normalized] === 'number'
    ? STAGE_BUDGET_MULTIPLIERS[normalized]
    : 1.0;

  return { stage: normalized, rawStage: stage, multiplier };
}

function _normalizeStage(stage) {
  if (!stage || typeof stage !== 'string') return null;
  const upper = stage.toUpperCase();
  if (upper === 'CODE') return 'DEVELOPER';
  if (upper === 'TEST') return 'TESTER';
  return upper;
}

/**
 * Returns a boost multiplier based on triage score (0-100). Higher = more important task
 * deserves larger share of budget.
 *
 * Thresholds (empirically chosen, matches RequestTriage's 3-tier complexity):
 *   > 80  → HIGH  (1.3x)
 *   > 50  → MEDIUM (1.15x)
 *   else  → NORMAL (1.0x)
 *
 * Non-numeric / null scores return NORMAL so behavior degrades gracefully.
 */
function getTaskImportance(triageScore) {
  if (typeof triageScore !== 'number' || !Number.isFinite(triageScore)) {
    return { level: 'NORMAL', boost: TASK_BOOST.NORMAL, score: null };
  }
  if (triageScore > 80) return { level: 'HIGH',   boost: TASK_BOOST.HIGH,   score: triageScore };
  if (triageScore > 50) return { level: 'MEDIUM', boost: TASK_BOOST.MEDIUM, score: triageScore };
  return { level: 'NORMAL', boost: TASK_BOOST.NORMAL, score: triageScore };
}

/**
 * Convenience: combine the 3 signals into a single budget value.
 *   final = capability.maxInject × stage.multiplier × task.boost
 *
 * @param {object} opts
 * @param {string} [opts.stage]      - stage name (ANALYSE/ARCHITECT/PLAN/DEVELOPER/TESTER/...)
 * @param {number} [opts.taskScore]  - triage complexity score 0-100
 * @returns {object} { tier, maxInject, stageMultiplier, taskBoost, final, signals }
 */
function resolveInjectBudget(opts = {}) {
  const capability = getModelCapability();
  const stageSignal = getStageSignal(opts.stage || null);
  const taskImportance = getTaskImportance(opts.taskScore);

  const final = Math.round(capability.maxInject * stageSignal.multiplier * taskImportance.boost);

  return {
    tier: capability.tier,
    maxInject: capability.maxInject,
    stageMultiplier: stageSignal.multiplier,
    stage: stageSignal.stage,
    taskBoost: taskImportance.boost,
    taskLevel: taskImportance.level,
    final,
    signals: { capability, stageSignal, taskImportance },
  };
}

module.exports = {
  getModelTier,
  getModelCapability,
  getStageSignal,
  getTaskImportance,
  resolveInjectBudget,
  _DEFAULT_TIERS: DEFAULT_TIERS,
};
