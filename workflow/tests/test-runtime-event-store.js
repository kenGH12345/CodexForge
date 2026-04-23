'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JsonlEventStore } = require('../core/runtime/jsonl-event-store');
const { RuntimeEventStore } = require('../core/runtime/runtime-event-store');
const { validateEventStore } = require('../core/runtime/contract-validator');
const { EVENT_CATEGORY, HOOK_TO_CATEGORY_MAP, SCHEMA_VERSION } = require('../core/runtime/types');
const { HookSystem } = require('../hooks/hook-system');
const { HOOK_EVENTS } = require('../core/constants');

const TEST_DIR = path.join(__dirname, '..', 'output', 'test-runtime-event-store');

let passCount = 0;
let failCount = 0;
const asyncTests = [];

function test(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    asyncTests.push(
      fn().then(() => {
        console.log(`  ✅ PASS: ${name}`);
        passCount++;
      }).catch(err => {
        console.log(`  ❌ FAIL: ${name}\n     ${err.message}`);
        failCount++;
      })
    );
    return;
  }
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passCount++;
  } catch (err) {
    console.log(`  ❌ FAIL: ${name}\n     ${err.message}`);
    failCount++;
  }
}

function createStore(sessionId) {
  const backing = new JsonlEventStore({ eventsDir: path.join(TEST_DIR, sessionId) });
  return new RuntimeEventStore({ backingStore: backing, sessionId });
}

console.log('\n── A. IEventStore Contract ──────────────────────────────────');
test('RuntimeEventStore passes validateEventStore() contract', () => {
  const store = createStore('contract-test');
  const result = validateEventStore(store);
  assert.strictEqual(result.pass, true, `Missing: ${result.missing.join(', ')}`);
});

console.log('\n── B. Unified Schema Fields ────────────────────────────────');
test('append() produces event with category field', () => {
  const store = createStore('schema-test');
  const event = store.append({
    sessionId: 'schema-test',
    kind: 'stage_started',
    category: EVENT_CATEGORY.STAGE,
    payload: { stage: 'ANALYSE' },
  });
  assert.strictEqual(event.category, EVENT_CATEGORY.STAGE);
});

test('append() auto-derives category from kind via HOOK_TO_CATEGORY_MAP', () => {
  const store = createStore('derive-test');
  const event = store.append({
    sessionId: 'derive-test',
    kind: 'stage_started',
    payload: { stage: 'ANALYSE' },
  });
  assert.strictEqual(event.category, EVENT_CATEGORY.STAGE);
});

test('append() falls back to SYSTEM for unknown kind', () => {
  const store = createStore('fallback-test');
  const event = store.append({
    sessionId: 'fallback-test',
    kind: 'unknown_event_xyz',
    payload: {},
  });
  assert.strictEqual(event.category, EVENT_CATEGORY.SYSTEM);
});

test('append() auto-derives category from kind prefix', () => {
  const store = createStore('prefix-test');
  const llmEvent = store.append({ sessionId: 'prefix-test', kind: 'llm.custom_call', payload: {} });
  assert.strictEqual(llmEvent.category, EVENT_CATEGORY.LLM);

  const wfEvent = store.append({ sessionId: 'prefix-test', kind: 'workflow.custom_start', payload: {} });
  assert.strictEqual(wfEvent.category, EVENT_CATEGORY.LIFECYCLE);

  const taskEvent = store.append({ sessionId: 'prefix-test', kind: 'task.custom_step', payload: {} });
  assert.strictEqual(taskEvent.category, EVENT_CATEGORY.AGENT);
});

test('SCHEMA_VERSION is 2.0', () => {
  assert.strictEqual(SCHEMA_VERSION, '2.0');
});

console.log('\n── C. HookSystem Integration ────────────────────────────────');
test('attachToHookSystem captures hook events with correct category', async () => {
  const store = createStore('hook-test');
  const hooks = new HookSystem();
  store.attachToHookSystem(hooks);

  await hooks.emit(HOOK_EVENTS.STAGE_STARTED, { stage: 'ANALYSE' });
  await hooks.emit(HOOK_EVENTS.LLM_CALL_RECORDED, { model: 'gpt-4' });

  const stats = store.getStats();
  assert.ok(stats.totalEvents >= 2, `Expected >= 2 events, got ${stats.totalEvents}`);
});

test('attachToHookSystem tracks current stage context', async () => {
  const store = createStore('stage-ctx-test');
  const hooks = new HookSystem();
  store.attachToHookSystem(hooks);

  await hooks.emit(HOOK_EVENTS.STAGE_STARTED, { stage: 'ARCHITECT' });

  const stageEvents = store.queryByCategory(EVENT_CATEGORY.STAGE);
  assert.ok(stageEvents.length > 0, 'Should have at least 1 STAGE category event');

  const customEvent = store.append({ sessionId: 'stage-ctx-test', kind: 'custom_event', payload: {} });
  assert.strictEqual(customEvent.stage, 'ARCHITECT', 'Subsequent event should have stage context');
});

console.log('\n── D. queryByCategory ───────────────────────────────────────');
test('queryByCategory filters events by category', () => {
  const store = createStore('cat-filter-test');
  store.append({ sessionId: 'cat-filter-test', kind: 'stage_started', category: EVENT_CATEGORY.STAGE, payload: {} });
  store.append({ sessionId: 'cat-filter-test', kind: 'llm_call', category: EVENT_CATEGORY.LLM, payload: {} });
  store.append({ sessionId: 'cat-filter-test', kind: 'stage_ended', category: EVENT_CATEGORY.STAGE, payload: {} });

  const stageEvents = store.queryByCategory(EVENT_CATEGORY.STAGE);
  assert.strictEqual(stageEvents.length, 2);
});

console.log('\n── E. getCausationChain ──────────────────────────────────────');
test('getCausationChain returns empty for unknown ID', () => {
  const store = createStore('chain-empty-test');
  const chain = store.getCausationChain(99999);
  assert.strictEqual(chain.length, 0);
});

test('getCausationChain traces linked events', () => {
  const store = createStore('chain-test');
  store.append({ sessionId: 'chain-test', kind: 'task_claimed', payload: { id: 1 } });
  store.append({ sessionId: 'chain-test', kind: 'task_completed', causationId: 1, payload: { id: 2 } });

  const chain = store.getCausationChain(1);
  assert.ok(chain.length >= 1, 'Expected at least 1 event in chain');
});

console.log('\n── F. getStats ──────────────────────────────────────────────');
test('getStats returns correct structure', () => {
  const store = createStore('stats-test');
  store.append({ sessionId: 'stats-test', kind: 'stage_started', category: EVENT_CATEGORY.STAGE, payload: {} });
  store.append({ sessionId: 'stats-test', kind: 'llm_call', category: EVENT_CATEGORY.LLM, payload: {} });

  const stats = store.getStats();
  assert.strictEqual(stats.totalEvents, 2);
  assert.strictEqual(stats.eventsByCategory[EVENT_CATEGORY.STAGE], 1);
  assert.strictEqual(stats.eventsByCategory[EVENT_CATEGORY.LLM], 1);
  assert.ok(stats.firstEventTs);
  assert.ok(stats.lastEventTs);
  assert.strictEqual(stats.sessionId, 'stats-test');
});

console.log('\n── G. Payload Sanitization ──────────────────────────────────');
test('sanitize truncates long strings', () => {
  const store = createStore('sanitize-test');
  const longStr = 'x'.repeat(1000);
  const event = store.append({
    sessionId: 'sanitize-test',
    kind: 'test_event',
    payload: { data: longStr },
  });
  assert.ok(event.payload.data.length < 1000, 'Long string should be truncated');
  assert.ok(event.payload.data.includes('truncated'));
});

test('sanitize handles circular references', () => {
  const store = createStore('circular-test');
  const obj = { name: 'test' };
  obj.self = obj;
  const event = store.append({
    sessionId: 'circular-test',
    kind: 'test_event',
    payload: obj,
  });
  assert.strictEqual(event.payload.name, 'test');
  assert.ok(
    event.payload.self === '[depth-limited]' || event.payload.self.name === 'test',
    'Circular reference should be depth-limited'
  );
});

test('sanitize handles Error objects', () => {
  const store = createStore('error-sanitize-test');
  const event = store.append({
    sessionId: 'error-sanitize-test',
    kind: 'test_event',
    payload: { err: new Error('test error') },
  });
  assert.strictEqual(event.payload.err.message, 'test error');
  assert.strictEqual(event.payload.err.name, 'Error');
});

test('sanitize handles functions', () => {
  const store = createStore('fn-sanitize-test');
  const event = store.append({
    sessionId: 'fn-sanitize-test',
    kind: 'test_event',
    payload: { callback: () => {} },
  });
  assert.strictEqual(event.payload.callback, '[function]');
});

console.log('\n── H. subscribeLive ─────────────────────────────────────────');
test('subscribeLive receives real-time events', () => {
  const store = createStore('live-test');
  const received = [];
  const unsub = store.subscribeLive((event) => received.push(event));

  store.append({ sessionId: 'live-test', kind: 'test_event', payload: {} });
  assert.strictEqual(received.length, 1);

  unsub();
  store.append({ sessionId: 'live-test', kind: 'test_event2', payload: {} });
  assert.strictEqual(received.length, 1, 'Should not receive after unsubscribe');
});

test('subscribeLive subscriber errors do not affect append', () => {
  const store = createStore('live-err-test');
  store.subscribeLive(() => { throw new Error('subscriber error'); });

  const event = store.append({ sessionId: 'live-err-test', kind: 'test_event', payload: {} });
  assert.ok(event, 'append should succeed even if subscriber throws');
});

console.log('\n── I. Backward Compatibility ────────────────────────────────');
test('EventJournal with runtimeEventStore option works correctly', () => {
  const { EventJournal } = require('../core/event-journal');
  const journalDir = path.join(TEST_DIR, 'compat-test');

  const backing = new JsonlEventStore({ eventsDir: path.join(journalDir, 'runtime') });
  const runtimeES = new RuntimeEventStore({ backingStore: backing, sessionId: 'compat-session' });

  const journal = new EventJournal({
    outputDir: journalDir,
    sessionId: 'compat-session',
    runtimeEventStore: runtimeES,
  });

  journal.append('test_event', { key: 'value' });
  const stats = journal.getStats();
  assert.strictEqual(stats.totalEvents, 2); // journal_start + test_event

  const rtStats = runtimeES.getStats();
  assert.ok(rtStats.totalEvents >= 1, 'RuntimeEventStore should have at least 1 delegated event');

  journal.close();
});

console.log('\n── J. HOOK_TO_CATEGORY_MAP Completeness ────────────────────');
test('HOOK_TO_CATEGORY_MAP covers all HOOK_EVENTS', () => {
  const hookEventValues = Object.values(HOOK_EVENTS);
  const missing = hookEventValues.filter(e => !HOOK_TO_CATEGORY_MAP[e]);
  assert.strictEqual(missing.length, 0, `Missing: ${missing.join(', ')}`);
});

console.log(`\n${'═'.repeat(60)}`);
Promise.all(asyncTests).then(() => {
  console.log(`  RuntimeEventStore Tests: ${passCount} passed, ${failCount} failed`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(failCount > 0 ? 1 : 0);
});
