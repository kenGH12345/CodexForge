/**
 * Unit tests for context-decision-signals.js (T-0)
 *
 * Run: node workflow/core/__tests__/context-decision-signals.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

const signals = require('../context-decision-signals');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('context-decision-signals.js tests');
console.log('─'.repeat(60));

// ── getModelTier ─────────────────────────────────────────────────────────────
console.log('\ngetModelTier()');

test('returns medium by default (no env, no config override)', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  delete process.env.WF_MODEL_TIER;
  try {
    const tier = signals.getModelTier();
    assert.strictEqual(tier, 'medium');
  } finally {
    if (origEnv !== undefined) process.env.WF_MODEL_TIER = origEnv;
  }
});

test('respects WF_MODEL_TIER env var (small)', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'small';
  try {
    assert.strictEqual(signals.getModelTier(), 'small');
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

test('respects WF_MODEL_TIER env var (large, uppercase)', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'LARGE';
  try {
    assert.strictEqual(signals.getModelTier(), 'large');
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

test('ignores unknown tier values and falls back to medium', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'xlarge-cheesecake';
  try {
    assert.strictEqual(signals.getModelTier(), 'medium');
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

// ── getModelCapability ───────────────────────────────────────────────────────
console.log('\ngetModelCapability()');

test('medium tier returns maxInject=8000 contextWindow=128000', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  delete process.env.WF_MODEL_TIER;
  try {
    const cap = signals.getModelCapability();
    assert.strictEqual(cap.tier, 'medium');
    assert.strictEqual(cap.maxInject, 8000);
    assert.strictEqual(cap.contextWindow, 128000);
    assert.strictEqual(cap.source, 'default-tier');
  } finally {
    if (origEnv !== undefined) process.env.WF_MODEL_TIER = origEnv;
  }
});

test('small tier returns maxInject=2800 (backward compat with legacy default)', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'small';
  try {
    const cap = signals.getModelCapability();
    assert.strictEqual(cap.tier, 'small');
    assert.strictEqual(cap.maxInject, 2800);
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

test('large tier returns maxInject=24000', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'large';
  try {
    const cap = signals.getModelCapability();
    assert.strictEqual(cap.tier, 'large');
    assert.strictEqual(cap.maxInject, 24000);
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

// ── getStageSignal ───────────────────────────────────────────────────────────
console.log('\ngetStageSignal()');

test('ANALYSE returns multiplier 0.6 (from token-budget.js)', () => {
  const s = signals.getStageSignal('ANALYSE');
  assert.strictEqual(s.stage, 'ANALYSE');
  assert.strictEqual(s.multiplier, 0.6);
});

test('ARCHITECT returns multiplier 0.85', () => {
  const s = signals.getStageSignal('ARCHITECT');
  assert.strictEqual(s.multiplier, 0.85);
});

test('CODE is normalized to DEVELOPER (multiplier 1.0)', () => {
  const s = signals.getStageSignal('CODE');
  assert.strictEqual(s.stage, 'DEVELOPER');
  assert.strictEqual(s.rawStage, 'CODE');
  assert.strictEqual(s.multiplier, 1.0);
});

test('TEST is normalized to TESTER (multiplier 0.85)', () => {
  const s = signals.getStageSignal('TEST');
  assert.strictEqual(s.stage, 'TESTER');
  assert.strictEqual(s.multiplier, 0.85);
});

test('unknown stage returns multiplier 1.0 (safe default)', () => {
  const s = signals.getStageSignal('MYSTERY_STAGE');
  assert.strictEqual(s.multiplier, 1.0);
});

test('null/undefined stage returns null stage with multiplier 1.0', () => {
  const s = signals.getStageSignal(null);
  assert.strictEqual(s.stage, null);
  assert.strictEqual(s.multiplier, 1.0);
});

// ── getTaskImportance ────────────────────────────────────────────────────────
console.log('\ngetTaskImportance()');

test('score > 80 returns HIGH / boost 1.3', () => {
  const t = signals.getTaskImportance(85);
  assert.strictEqual(t.level, 'HIGH');
  assert.strictEqual(t.boost, 1.3);
});

test('score 51-80 returns MEDIUM / boost 1.15', () => {
  const t = signals.getTaskImportance(65);
  assert.strictEqual(t.level, 'MEDIUM');
  assert.strictEqual(t.boost, 1.15);
});

test('score 0-50 returns NORMAL / boost 1.0', () => {
  const t = signals.getTaskImportance(30);
  assert.strictEqual(t.level, 'NORMAL');
  assert.strictEqual(t.boost, 1.0);
});

test('non-numeric score returns NORMAL', () => {
  const t = signals.getTaskImportance('not-a-number');
  assert.strictEqual(t.level, 'NORMAL');
  assert.strictEqual(t.score, null);
});

test('null score returns NORMAL', () => {
  const t = signals.getTaskImportance(null);
  assert.strictEqual(t.level, 'NORMAL');
});

test('boundary score=80 stays MEDIUM (strictly greater than)', () => {
  const t = signals.getTaskImportance(80);
  assert.strictEqual(t.level, 'MEDIUM');
});

test('boundary score=81 becomes HIGH', () => {
  const t = signals.getTaskImportance(81);
  assert.strictEqual(t.level, 'HIGH');
});

// ── resolveInjectBudget ──────────────────────────────────────────────────────
console.log('\nresolveInjectBudget()');

test('medium + DEVELOPER + normal task → 8000 × 1.0 × 1.0 = 8000', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  delete process.env.WF_MODEL_TIER;
  try {
    const b = signals.resolveInjectBudget({ stage: 'DEVELOPER', taskScore: 30 });
    assert.strictEqual(b.final, 8000);
    assert.strictEqual(b.tier, 'medium');
    assert.strictEqual(b.taskLevel, 'NORMAL');
  } finally {
    if (origEnv !== undefined) process.env.WF_MODEL_TIER = origEnv;
  }
});

test('medium + ARCHITECT + HIGH task → 8000 × 0.85 × 1.3 = 8840', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  delete process.env.WF_MODEL_TIER;
  try {
    const b = signals.resolveInjectBudget({ stage: 'ARCHITECT', taskScore: 85 });
    assert.strictEqual(b.final, 8840);
    assert.strictEqual(b.tier, 'medium');
    assert.strictEqual(b.stage, 'ARCHITECT');
    assert.strictEqual(b.taskLevel, 'HIGH');
  } finally {
    if (origEnv !== undefined) process.env.WF_MODEL_TIER = origEnv;
  }
});

test('small tier backward compat → 2800 × 1.0 × 1.0 = 2800 (matches legacy MAX_INJECT_TOKENS)', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'small';
  try {
    const b = signals.resolveInjectBudget({ stage: 'DEVELOPER' });
    assert.strictEqual(b.final, 2800);
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

test('large tier + DEVELOPER + HIGH task → 24000 × 1.0 × 1.3 = 31200', () => {
  const origEnv = process.env.WF_MODEL_TIER;
  process.env.WF_MODEL_TIER = 'large';
  try {
    const b = signals.resolveInjectBudget({ stage: 'CODE', taskScore: 90 });
    assert.strictEqual(b.final, 31200);
    assert.strictEqual(b.stage, 'DEVELOPER');
  } finally {
    if (origEnv === undefined) delete process.env.WF_MODEL_TIER;
    else process.env.WF_MODEL_TIER = origEnv;
  }
});

test('exposes signal sub-objects for downstream logging', () => {
  const b = signals.resolveInjectBudget({ stage: 'ANALYSE', taskScore: 70 });
  assert.ok(b.signals && typeof b.signals === 'object', 'signals field present');
  assert.ok(b.signals.capability, 'capability signal present');
  assert.ok(b.signals.stageSignal, 'stageSignal present');
  assert.ok(b.signals.taskImportance, 'taskImportance present');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.stack || err.message}`);
  }
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}
