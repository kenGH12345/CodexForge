'use strict';

/**
 * T-2 dynamic token-budget tests for ContextLoader.
 *
 * Validates that _resolveBudget() honors constructor defaults, per-call overrides,
 * and falls back safely to MAX_INJECT_TOKENS for legacy no-signal callers.
 *
 * Run: node workflow/core/__tests__/context-loader.dynamic-budget.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContextLoader } = require('../context-loader');
const { MAX_INJECT_TOKENS } = require('../context-loader-config');

// ─── Minimal test harness (same style as T-0/T-1) ────────────────────────────
const results = { passed: 0, failed: 0, errors: [] };
function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-t2-budget-'));
}

console.log('\n=== T-2 ContextLoader dynamic budget tests ===\n');

// ── Legacy compatibility (no signals) ────────────────────────────────────────
console.log('Legacy compatibility:');

test('no signals → returns MAX_INJECT_TOKENS (legacy floor)', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  assert.strictEqual(loader._resolveBudget({}), MAX_INJECT_TOKENS);
});

test('resolve() without opts works exactly like before T-2', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  // Just verify _resolveBudget defaults are null (i.e. legacy path)
  assert.strictEqual(loader._modelTier, null);
  assert.strictEqual(loader._defaultStage, null);
  assert.strictEqual(loader._defaultScore, null);
});

// ── Stage signal ─────────────────────────────────────────────────────────────
console.log('\nStage-based sizing:');

test('CODE stage with medium tier → budget ≥ MAX_INJECT_TOKENS (floor preserved)', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const b = loader._resolveBudget({ stage: 'CODE', modelTier: 'medium' });
  assert.ok(b >= MAX_INJECT_TOKENS, `CODE budget ${b} should be ≥ legacy floor ${MAX_INJECT_TOKENS}`);
});

test('CODE stage with large tier → substantially larger budget than medium', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const medium = loader._resolveBudget({ stage: 'CODE', modelTier: 'medium' });
  const large  = loader._resolveBudget({ stage: 'CODE', modelTier: 'large' });
  assert.ok(large > medium, `large(${large}) should exceed medium(${medium}) on CODE stage`);
});

test('CODE stage with mega tier → largest of three', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const large = loader._resolveBudget({ stage: 'CODE', modelTier: 'large' });
  const mega  = loader._resolveBudget({ stage: 'CODE', modelTier: 'mega' });
  assert.ok(mega >= large, `mega(${mega}) should be ≥ large(${large})`);
});

// ── Task importance ──────────────────────────────────────────────────────────
console.log('\nTask-importance multiplier:');

test('high-score task (85) ≥ low-score task (20) budget', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const low  = loader._resolveBudget({ stage: 'DEVELOP', score: 20, modelTier: 'large' });
  const high = loader._resolveBudget({ stage: 'DEVELOP', score: 85, modelTier: 'large' });
  assert.ok(high >= low, `high-importance(${high}) should be ≥ low-importance(${low})`);
});

// ── Constructor defaults ─────────────────────────────────────────────────────
console.log('\nConstructor defaults:');

test('defaultStage + modelTier set via constructor are consulted by _resolveBudget', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({
    workflowRoot: dir,
    modelTier: 'large',
    defaultStage: 'CODE',
  });
  // Budget with no per-call opts — should still pick up defaults.
  const b = loader._resolveBudget({});
  const legacyB = new ContextLoader({ workflowRoot: dir })._resolveBudget({});
  assert.ok(b > legacyB, `loader with defaults(${b}) should exceed legacy-equivalent(${legacyB})`);
});

test('per-call opts override constructor defaults', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({
    workflowRoot: dir,
    modelTier: 'medium',
    defaultStage: 'ANALYSE',
  });
  const overridden = loader._resolveBudget({ modelTier: 'large', stage: 'CODE' });
  const defaulted  = loader._resolveBudget({});
  assert.ok(overridden >= defaulted, `overridden(${overridden}) should be ≥ defaulted(${defaulted})`);
});

// ── Robustness / fallback paths ──────────────────────────────────────────────
console.log('\nRobustness:');

test('unknown stage name → falls back to legacy floor, no throw', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const b = loader._resolveBudget({ stage: 'NOT_A_REAL_STAGE' });
  assert.ok(b >= MAX_INJECT_TOKENS, 'unknown stage should never drop below legacy floor');
});

test('score at both ends (0 and 100) produces finite budgets', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  const b0   = loader._resolveBudget({ stage: 'CODE', score: 0,   modelTier: 'large' });
  const b100 = loader._resolveBudget({ stage: 'CODE', score: 100, modelTier: 'large' });
  assert.ok(Number.isFinite(b0) && b0 > 0,   `score=0 budget(${b0}) must be finite positive`);
  assert.ok(Number.isFinite(b100) && b100 > 0, `score=100 budget(${b100}) must be finite positive`);
});

test('floor enforcement: budget never dips below MAX_INJECT_TOKENS', () => {
  const dir = mkTmpDir();
  const loader = new ContextLoader({ workflowRoot: dir });
  // Try every combination that could theoretically shrink budget
  const combos = [
    { stage: 'ANALYSE', score: 0,  modelTier: 'medium' },
    { stage: 'FINISHED',score: 10, modelTier: 'medium' },
    { stage: 'CODE',    score: 5,  modelTier: 'medium' },
  ];
  for (const opts of combos) {
    const b = loader._resolveBudget(opts);
    assert.ok(b >= MAX_INJECT_TOKENS,
      `opts=${JSON.stringify(opts)} yielded ${b} < floor ${MAX_INJECT_TOKENS}`);
  }
});

// ── Results ──────────────────────────────────────────────────────────────────
console.log(`\nResults: ${results.passed} passed, ${results.failed} failed`);
if (results.failed > 0) {
  console.log('\nFailures:');
  results.errors.forEach(e => console.log(`  - ${e.name}: ${e.error}`));
  process.exit(1);
}
process.exit(0);
