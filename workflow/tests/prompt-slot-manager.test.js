/**
 * Integration test for PromptSlotManager – Prefix-Level A/B Testing
 * Validates the full lifecycle: register → resolve → record → promote/rollback
 */
'use strict';

const fs = require('fs');
const { PromptSlotManager } = require('../core/prompt-slot-manager');

const VARIANTS_PATH = './test-ab-integration.json';
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ PASS: ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function cleanup() {
  try { fs.unlinkSync(VARIANTS_PATH); } catch (_) {}
  try { fs.unlinkSync(VARIANTS_PATH + '.tmp'); } catch (_) {}
}

// ── Test 1: Empty resolve returns null ──────────────────────────────────────
cleanup();
const mgr1 = new PromptSlotManager(VARIANTS_PATH);
assert(mgr1.resolve('analyst') === null, 'Empty resolve returns null');

// ── Test 2: Register and resolve ────────────────────────────────────────────
mgr1.registerVariant('analyst', 'fixed_prefix', 'default', 'You are Alistair Cockburn.', true);
mgr1.registerVariant('analyst', 'fixed_prefix', 'variant_B', 'As Alistair Cockburn, inventor of Use-Case methodology.');

const r1 = mgr1.resolve('analyst');
assert(r1 !== null, 'Resolve returns non-null after registration');
assert(typeof r1.content === 'string' && r1.content.length > 0, 'Resolved content is a non-empty string');
assert(typeof r1.variantId === 'string', 'Resolved variantId is a string');

// ── Test 3: Session tracking ────────────────────────────────────────────────
const sv = mgr1.getSessionVariant('analyst');
assert(sv === r1.variantId, 'getSessionVariant returns the last resolved variantId');

// ── Test 4: Outcome recording ────────────────────────────────────────────────
mgr1.recordOutcome('analyst', 'fixed_prefix', 'default', { gatePassed: true, correctionRounds: 1 });
mgr1.recordOutcome('analyst', 'fixed_prefix', 'default', { gatePassed: true, correctionRounds: 0 });
const stats = mgr1.getStats();
assert(stats['analyst:fixed_prefix'].variants['default'].totalTrials === 2, 'Default variant has 2 trials');
assert(stats['analyst:fixed_prefix'].variants['default'].gatePassRate === '1.000', 'Default variant has 100% pass rate');

// ── Test 5: Persistence ─────────────────────────────────────────────────────
assert(fs.existsSync(VARIANTS_PATH), 'prompt-variants.json was persisted to disk');
const mgr2 = new PromptSlotManager(VARIANTS_PATH);
const r2 = mgr2.resolve('analyst');
assert(r2 !== null, 'Reloaded manager can still resolve variants');
const stats2 = mgr2.getStats();
assert(stats2['analyst:fixed_prefix'].variants['default'].totalTrials === 2, 'Stats survived reload');

// ── Test 6: Promotion ────────────────────────────────────────────────────────
// Simulate variant_B being much better than default over 10 trials
cleanup();
const mgr3 = new PromptSlotManager(VARIANTS_PATH);
mgr3.registerVariant('dev', 'fixed_prefix', 'default', 'Default prompt', true);
mgr3.registerVariant('dev', 'fixed_prefix', 'better', 'Better prompt');

// Record 10 mediocre default outcomes
for (let i = 0; i < 10; i++) {
  mgr3.recordOutcome('dev', 'fixed_prefix', 'default', { gatePassed: i < 5, correctionRounds: 2 });
}
// Record 10 excellent better outcomes
for (let i = 0; i < 10; i++) {
  mgr3.recordOutcome('dev', 'fixed_prefix', 'better', { gatePassed: true, correctionRounds: 0 });
}

const stats3 = mgr3.getStats();
assert(stats3['dev:fixed_prefix'].activeVariant === 'better', 'Better variant was promoted to active');

// ── Test 7: Rollback on consecutive failures ─────────────────────────────────
cleanup();
const mgr4 = new PromptSlotManager(VARIANTS_PATH);
mgr4.registerVariant('tester', 'fixed_prefix', 'baseline', 'Baseline prompt', true);
mgr4.registerVariant('tester', 'fixed_prefix', 'risky', 'Risky prompt');

// Manually set risky as active (simulate a previous promotion)
mgr4._data.slots['tester:fixed_prefix'].activeVariant = 'risky';

// Record 3 consecutive failures on the risky variant
for (let i = 0; i < 3; i++) {
  mgr4.recordOutcome('tester', 'fixed_prefix', 'risky', { gatePassed: false, correctionRounds: 3 });
}

const stats4 = mgr4.getStats();
assert(stats4['tester:fixed_prefix'].activeVariant === 'baseline', 'Risky variant rolled back to baseline after 3 consecutive failures');

// ── Test 8: Exploration rate (statistical) ───────────────────────────────────
cleanup();
const mgr5 = new PromptSlotManager(VARIANTS_PATH);
mgr5.registerVariant('arch', 'fixed_prefix', 'A', 'Prompt A', true);
mgr5.registerVariant('arch', 'fixed_prefix', 'B', 'Prompt B');

let explorationCount = 0;
const N = 1000;
for (let i = 0; i < N; i++) {
  const r = mgr5.resolve('arch');
  if (r.isExploration) explorationCount++;
}
const explorationRate = explorationCount / N;
assert(explorationRate > 0.10 && explorationRate < 0.35, `Exploration rate ${(explorationRate * 100).toFixed(1)}% is within expected range [10%, 35%]`);

// ── Cleanup & Summary ────────────────────────────────────────────────────────
cleanup();

console.log('\n============================================================');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('============================================================');

process.exit(failed > 0 ? 1 : 0);
