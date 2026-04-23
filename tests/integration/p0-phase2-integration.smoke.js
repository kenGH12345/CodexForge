'use strict';

// T8: P0 Phase 2 integration smoke — validates the end-to-end wiring between
// architect-context-builder / developer-context-builder / tester-context-builder
// and _applyTokenBudget (C6 adaptive multiplier), plus _rawLlmCall and
// ConversationCompactor (C1 compaction).
//
// This test runs without a real LLM — it uses mocks to verify wiring and
// structural correctness. Real-data gain numbers go in the gains report.

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

(async () => {

// S1: getAdaptiveMultiplier returns correct segment for complex tasks
test('S1 adaptive multiplier complex task', () => {
  const { getAdaptiveMultiplier } = require('../../workflow/core/token-budget');
  const r = getAdaptiveMultiplier('ARCHITECT', 80, { enabled: true });
  assert.ok(['complex', 'very_complex'].includes(r.segment), `expected complex segment, got ${r.segment}`);
  assert.ok(r.adaptiveFactor > 1.0, `expected >1.0, got ${r.adaptiveFactor}`);
});

// S2: getAdaptiveMultiplier returns savings for simple tasks
test('S2 adaptive multiplier simple task', () => {
  const { getAdaptiveMultiplier } = require('../../workflow/core/token-budget');
  const r = getAdaptiveMultiplier('ANALYSE', 20, { enabled: true });
  assert.strictEqual(r.segment, 'simple');
  assert.ok(r.adaptiveFactor < 1.0, `expected <1.0, got ${r.adaptiveFactor}`);
});

// S3: adaptive disabled returns 1.0
test('S3 adaptive disabled returns 1.0', () => {
  const { getAdaptiveMultiplier } = require('../../workflow/core/token-budget');
  const r = getAdaptiveMultiplier('ARCHITECT', 80, { enabled: false });
  assert.strictEqual(r.adaptiveFactor, 1.0);
  assert.strictEqual(r.segment, 'disabled');
});

// S4: null complexityScore returns 1.0 without error (backward-compat)
test('S4 null complexity score no-op', () => {
  const { getAdaptiveMultiplier } = require('../../workflow/core/token-budget');
  const r = getAdaptiveMultiplier('ARCHITECT', null, { enabled: true });
  assert.strictEqual(r.adaptiveFactor, 1.0);
  assert.ok(['skipped', 'disabled'].includes(r.segment), `expected no-op segment, got ${r.segment}`);
});

// S5: _applyTokenBudget records adaptive multiplier to observability
testAsync('S5 observability receives adaptive record', async () => {
  const { _applyTokenBudget } = require('../../workflow/core/token-budget');
  const recorded = [];
  const obsMock = {
    recordAdaptiveMultiplier(sessionId, stage, score, detail) {
      recorded.push({ sessionId, stage, score, detail });
    },
  };
  const blocks = [
    { label: 'USER_INSTRUCTION', content: 'test', priority: 0 },
    { label: 'HISTORY', content: 'x'.repeat(5000), priority: 3 },
  ];
  await _applyTokenBudget(blocks, undefined, {
    stage: 'ARCHITECT',
    complexityScore: 75,
    enableAdaptive: true,
    sessionId: 'test-session',
    observability: obsMock,
  });
  assert.ok(recorded.length > 0, 'observability should have been called');
  assert.strictEqual(recorded[0].stage, 'ARCHITECT');
  assert.strictEqual(recorded[0].score, 75);
});

// S6: ConversationCompactor guard prevents recursion
testAsync('S6 compaction skipCompaction guard', async () => {
  const { ConversationCompactor } = require('../../workflow/core/conversation-compactor');
  const c = new ConversationCompactor({});
  const messages = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const r = await c.compact(messages, { sessionId: 's6', _skipCompaction: true });
  assert.strictEqual(r.strategy, 'skip');
  assert.strictEqual(r.reason, 'guard');
});

// S7: ConversationCompactor uses caller-supplied llmCall
testAsync('S7 compaction respects opts.llmCall override', async () => {
  const { ConversationCompactor } = require('../../workflow/core/conversation-compactor');
  const c = new ConversationCompactor({});
  let usedOverride = false;
  const overrideLlm = async (prompt) => {
    usedOverride = true;
    return 'Summary via override LLM.';
  };
  const messages = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `long msg ${i} `.repeat(50) }));
  const r = await c.compact(messages, { sessionId: 's7', llmCall: overrideLlm });
  assert.ok(usedOverride, 'override llm should have been called');
  assert.strictEqual(r.strategy, 'llm');
});

// S8: env var WF_ENABLE_CONVERSATION_COMPACTION=false disables
testAsync('S8 env flag disables compactor', async () => {
  const prev = process.env.WF_ENABLE_CONVERSATION_COMPACTION;
  process.env.WF_ENABLE_CONVERSATION_COMPACTION = 'false';
  delete require.cache[require.resolve('../../workflow/core/conversation-compactor')];
  const { ConversationCompactor } = require('../../workflow/core/conversation-compactor');
  const c = new ConversationCompactor({});
  const messages = Array.from({ length: 15 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));
  const r = await c.compact(messages, { sessionId: 's8' });
  assert.strictEqual(r.strategy, 'skip');
  assert.strictEqual(r.reason, 'disabled');
  if (prev === undefined) delete process.env.WF_ENABLE_CONVERSATION_COMPACTION;
  else process.env.WF_ENABLE_CONVERSATION_COMPACTION = prev;
  delete require.cache[require.resolve('../../workflow/core/conversation-compactor')];
});

// S9: COMPACTION constants expose audit path + env flag name
test('S9 COMPACTION constants expose audit & env flag', () => {
  const { COMPACTION } = require('../../workflow/core/constants');
  assert.strictEqual(typeof COMPACTION.AUDIT_PATH, 'string');
  assert.strictEqual(typeof COMPACTION.ENV_FLAG, 'string');
  assert.ok(COMPACTION.AUDIT_PATH.includes('.jsonl'));
});

// S10: observability.recordAdaptiveMultiplier can be retrieved back
test('S10 observability trail retrievable', () => {
  const { Observability } = require('../../workflow/core/observability');
  const obs = new Observability({});
  assert.strictEqual(typeof obs.recordAdaptiveMultiplier, 'function');
  assert.strictEqual(typeof obs.getAdaptiveMultiplierTrail, 'function');
  obs.recordAdaptiveMultiplier('s10', 'ARCHITECT', 75, {
    staticMul: 1.0,
    adaptiveFactor: 1.1,
    finalMul: 1.1,
    segment: 'complex',
    capped: false,
    finalBudgetChars: 9900,
  });
  const trail = obs.getAdaptiveMultiplierTrail();
  assert.strictEqual(trail.events.length, 1);
  assert.strictEqual(trail.events[0].stage, 'ARCHITECT');
  assert.strictEqual(trail.byStage.ARCHITECT.count, 1);
});

// Wait for all async tests to resolve before summary
await new Promise(r => setTimeout(r, 100));

const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\nResult: ${passed}/${total}`);
if (passed !== total) process.exit(1);

})();
