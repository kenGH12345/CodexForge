/**
 * Experience System Integration Test
 *
 * Validates the core experience system components work together:
 *   1. ExperienceEventBus: pub/sub, priority ordering, once handlers
 *   2. ExperienceStore: record, query, dedup, event emission
 *   3. Knowledge Layer routing (ADR-43)
 *   4. SessionSignalDetector integration
 *
 * Run: node workflow/tests/test-experience-system.js
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Test Harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ❌ ${message}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(60 - name.length)}`);
}

// ─── Test 1: EventBus Core ────────────────────────────────────────────────────

section('EventBus: Basic Pub/Sub');

const {
  ExperienceEvents,
  HandlerPriority,
  ExperienceEventBus,
  getGlobalEventBus,
  resetGlobalEventBus,
} = require('../core/experience-event-bus');

{
  const bus = new ExperienceEventBus({ debug: false });

  // Test basic subscription and emission
  let received = null;
  bus.on(ExperienceEvents.EXPERIENCE_RECORDED, (data) => {
    received = data;
  });

  bus.emit(ExperienceEvents.EXPERIENCE_RECORDED, { id: 'test-1', title: 'Test Experience' })
    .then(result => {
      assert(received !== null, 'Handler received event data');
      assert(received.id === 'test-1', 'Event data is correct');
      assert(result.handlersExecuted === 1, 'One handler executed');
      assert(result.errors.length === 0, 'No errors');
    });
}

// ─── Test 2: EventBus Priority Ordering ───────────────────────────────────────

section('EventBus: Priority Ordering');

{
  const bus = new ExperienceEventBus({ debug: false });
  const order = [];

  bus.on('test:priority', () => order.push('LOW'), { priority: HandlerPriority.LOW });
  bus.on('test:priority', () => order.push('CRITICAL'), { priority: HandlerPriority.CRITICAL });
  bus.on('test:priority', () => order.push('NORMAL'), { priority: HandlerPriority.NORMAL });
  bus.on('test:priority', () => order.push('HIGH'), { priority: HandlerPriority.HIGH });

  // Use sync mode to guarantee order
  bus.emit('test:priority', {}, { async: false }).then(() => {
    assert(order[0] === 'CRITICAL', 'CRITICAL handler executes first');
    assert(order[1] === 'HIGH', 'HIGH handler executes second');
    assert(order[2] === 'NORMAL', 'NORMAL handler executes third');
    assert(order[3] === 'LOW', 'LOW handler executes fourth');
  });
}

// ─── Test 3: EventBus Once Handler ────────────────────────────────────────────

section('EventBus: Once Handler');

{
  const bus = new ExperienceEventBus({ debug: false });
  let callCount = 0;

  bus.once('test:once', () => { callCount++; });

  bus.emit('test:once', {}).then(() => {
    return bus.emit('test:once', {});
  }).then(() => {
    assert(callCount === 1, 'Once handler called exactly once');
  });
}

// ─── Test 4: EventBus Wildcard ────────────────────────────────────────────────

section('EventBus: Wildcard Handler');

{
  const bus = new ExperienceEventBus({ debug: false });
  const wildcardEvents = [];

  bus.onAny((type, data) => {
    wildcardEvents.push(type);
  });

  Promise.all([
    bus.emit('event:a', {}),
    bus.emit('event:b', {}),
    bus.emit('event:c', {}),
  ]).then(() => {
    assert(wildcardEvents.length === 3, 'Wildcard handler received all 3 events');
  });
}

// ─── Test 5: EventBus Error Resilience ────────────────────────────────────────

section('EventBus: Error Resilience');

{
  const bus = new ExperienceEventBus({ debug: false });
  let secondHandlerCalled = false;

  bus.on('test:error', () => { throw new Error('Handler crash'); });
  bus.on('test:error', () => { secondHandlerCalled = true; });

  bus.emit('test:error', {}).then(result => {
    assert(secondHandlerCalled, 'Second handler still executes after first throws');
    assert(result.errors.length === 1, 'Error is captured');
  });
}

// ─── Test 6: EventBus History ─────────────────────────────────────────────────

section('EventBus: Event History');

{
  const bus = new ExperienceEventBus({ maxHistorySize: 5, debug: false });

  const emits = [];
  for (let i = 0; i < 7; i++) {
    emits.push(bus.emit(`test:history-${i}`, { index: i }));
  }

  Promise.all(emits).then(() => {
    const history = bus.getHistory();
    assert(history.length === 5, 'History capped at maxHistorySize (5)');
    assert(history[0].type === 'test:history-2', 'Oldest events evicted (FIFO)');
  });
}

// ─── Test 7: EventBus Singleton ───────────────────────────────────────────────

section('EventBus: Global Singleton');

{
  resetGlobalEventBus();
  const bus1 = getGlobalEventBus();
  const bus2 = getGlobalEventBus();
  assert(bus1 === bus2, 'getGlobalEventBus returns same instance');

  resetGlobalEventBus();
  const bus3 = getGlobalEventBus();
  assert(bus1 !== bus3, 'resetGlobalEventBus creates new instance');
}

// ─── Test 8: EventBus waitFor ─────────────────────────────────────────────────

section('EventBus: waitFor');

{
  const bus = new ExperienceEventBus({ debug: false });

  // Emit after a short delay
  setTimeout(() => bus.emit('test:wait', { value: 42 }), 50);

  bus.waitFor('test:wait', 1000).then(data => {
    assert(data.value === 42, 'waitFor resolves with event data');
  }).catch(err => {
    assert(false, 'waitFor should not timeout: ' + err.message);
  });
}

// ─── Test 9: ExperienceStore Record + Event Emission ──────────────────────────

section('ExperienceStore: Record + Event Emission');

{
  // Use temp directory for store
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-test-'));
  const storePath = path.join(tmpDir, 'experiences.json');

  // Reset global bus to capture events
  resetGlobalEventBus();
  const bus = getGlobalEventBus();

  let recordedEvent = null;
  const targetTitle = 'Test: Integration test experience ' + Date.now();
  bus.on(ExperienceEvents.EXPERIENCE_RECORDED, (data) => {
    if (data.experience && data.experience.title === targetTitle) {
      recordedEvent = data;
    }
  });

  // Clear require cache to ensure ExperienceStore uses the fresh global bus
  delete require.cache[require.resolve('../core/experience-store')];
  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(storePath);

  const exp = store.record({
    type: 'positive',
    category: 'code_quality',
    title: targetTitle,
    content: 'This is a test experience for integration testing.',
    tags: ['test', 'integration'],
  });

  assert(exp.id.startsWith('EXP-'), 'Experience ID has correct prefix');
  assert(exp.type === 'positive', 'Experience type is correct');
  assert(exp.tags.includes('test'), 'Tags are preserved');

  // Give event bus time to process
  setTimeout(() => {
    assert(recordedEvent !== null, 'EXPERIENCE_RECORDED event was emitted');
    if (recordedEvent) {
      // Debug: check what we actually received
      const hasExp = recordedEvent.experience != null;
      const idMatch = hasExp && recordedEvent.experience.id === exp.id;
      assert(idMatch,
        `Event contains correct experience (expected: ${exp.id}, got: ${hasExp ? recordedEvent.experience.id : 'no experience field'})`);
    }

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }, 200);
}

// ─── Test 10: ExperienceStore Dedup ───────────────────────────────────────────

section('ExperienceStore: Title Dedup');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-dedup-'));
  const storePath = path.join(tmpDir, 'experiences.json');

  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(storePath);

  store.record({
    type: 'positive',
    category: 'code_quality',
    title: 'Dedup Test Title',
    content: 'First experience.',
  });

  const dup = store.recordIfAbsent('Dedup Test Title', {
    type: 'positive',
    category: 'code_quality',
    title: 'Dedup Test Title',
    content: 'Duplicate experience.',
  });

  assert(dup === null, 'recordIfAbsent returns null for duplicate title');
  assert(store.experiences.length === 1, 'Only one experience stored');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Test 11: ExperienceStore Batch Record ────────────────────────────────────

section('ExperienceStore: Batch Record');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-batch-'));
  const storePath = path.join(tmpDir, 'experiences.json');

  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(storePath);

  const result = store.batchRecord([
    { type: 'positive', category: 'code_quality', title: 'Batch 1', content: 'Content 1' },
    { type: 'negative', category: 'bug_fix', title: 'Batch 2', content: 'Content 2' },
    { type: 'positive', category: 'code_quality', title: 'Batch 1', content: 'Duplicate' }, // dup
  ]);

  assert(result.added === 2, 'Batch added 2 unique experiences');
  assert(result.skipped === 1, 'Batch skipped 1 duplicate');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Test 12: SessionSignalDetector ───────────────────────────────────────────

section('SessionSignalDetector');

{
  try {
    const { SessionSignalDetector } = require('../core/session-signal-detector');
    assert(typeof SessionSignalDetector === 'function' || typeof SessionSignalDetector === 'object',
      'SessionSignalDetector module loads successfully');

    if (typeof SessionSignalDetector === 'function') {
      const detector = new SessionSignalDetector();
      assert(typeof detector.detectSignals === 'function',
        'SessionSignalDetector has detectSignals method');
      assert(typeof detector.trackFileEdit === 'function',
        'SessionSignalDetector has trackFileEdit method');
      assert(typeof detector.trackToolCall === 'function',
        'SessionSignalDetector has trackToolCall method');
    }
  } catch (err) {
    assert(false, 'SessionSignalDetector failed to load: ' + err.message);
  }
}

// ─── Test 13: ExperienceStore Multi-Index ─────────────────────────────────────

section('ExperienceStore: Multi-Dimensional Index');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-index-'));
  const storePath = path.join(tmpDir, 'experiences.json');

  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(storePath);

  store.record({
    type: 'positive',
    category: 'code_quality',
    title: 'Index Test: Code Quality',
    content: 'Testing multi-index lookup.',
    skill: 'code-review',
    tags: ['quality', 'review'],
  });

  store.record({
    type: 'negative',
    category: 'bug_fix',
    title: 'Index Test: Bug Fix',
    content: 'Testing bug fix category.',
    skill: 'debugging',
    tags: ['bug', 'fix'],
  });

  // Test category index
  const codeQualityIds = store._categoryIndex.get('code_quality');
  assert(codeQualityIds && codeQualityIds.size >= 1, 'Category index has code_quality entries');

  // Test skill index
  const codeReviewIds = store._skillIndex.get('code-review');
  assert(codeReviewIds && codeReviewIds.size >= 1, 'Skill index has code-review entries');

  // Test tag index
  const qualityTagIds = store._tagIndex.get('quality');
  assert(qualityTagIds && qualityTagIds.size >= 1, 'Tag index has quality entries');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
}

// ─── Test 14: EventBus Unsubscribe ────────────────────────────────────────────

section('EventBus: Unsubscribe');

{
  const bus = new ExperienceEventBus({ debug: false });
  let callCount = 0;

  const unsub = bus.on('test:unsub', () => { callCount++; });

  bus.emit('test:unsub', {}).then(() => {
    unsub(); // Unsubscribe
    return bus.emit('test:unsub', {});
  }).then(() => {
    assert(callCount === 1, 'Handler not called after unsubscribe');
  });
}

// ─── Test 15: EventBus Stats ──────────────────────────────────────────────────

section('EventBus: Statistics');

{
  const bus = new ExperienceEventBus({ debug: false });

  bus.on('test:stats', () => {});
  bus.on('test:stats', () => { throw new Error('intentional'); });

  bus.emit('test:stats', {}).then(() => {
    const stats = bus.getStats();
    assert(stats.published >= 1, 'Stats track published events');
    assert(stats.handled >= 1, 'Stats track handled events');
    assert(stats.errors >= 1, 'Stats track errors');
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────

// Wait for all async operations to complete
setTimeout(() => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Experience System Integration Test Results`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log(`${'═'.repeat(60)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}, 500);
