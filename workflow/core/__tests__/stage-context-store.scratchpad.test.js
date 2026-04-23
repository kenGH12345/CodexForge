/**
 * Unit tests for StageContextStore scratchpad API (T-1).
 *
 * Run: node workflow/core/__tests__/stage-context-store.scratchpad.test.js
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const { StageContextStore } = require('../stage-context-store');

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

console.log('StageContextStore scratchpad API (T-1)');
console.log('─'.repeat(60));

// ── setScratch / getScratch basic contract ────────────────────────────────────
console.log('\nsetScratch() / getScratch()');

test('round-trips a string value', () => {
  const s = new StageContextStore();
  assert.strictEqual(s.setScratch('decision-X', 'use redis for rate limit'), true);
  const got = s.getScratch('decision-X');
  assert.ok(got, 'entry retrievable');
  assert.strictEqual(got.value, 'use redis for rate limit');
  assert.strictEqual(got.scope, 'session');
});

test('round-trips a JSON-serialisable object', () => {
  const s = new StageContextStore();
  s.setScratch('arch-choice', { db: 'postgres', cache: 'redis' }, { fromStage: 'ARCHITECT' });
  const got = s.getScratch('arch-choice');
  assert.deepStrictEqual(got.value, { db: 'postgres', cache: 'redis' });
  assert.strictEqual(got.fromStage, 'ARCHITECT');
});

test('rejects key longer than 120 chars', () => {
  const s = new StageContextStore();
  assert.strictEqual(s.setScratch('x'.repeat(121), 'val'), false);
});

test('rejects value larger than 8000 chars', () => {
  const s = new StageContextStore();
  assert.strictEqual(s.setScratch('k', 'a'.repeat(8001)), false);
});

test('rejects non-serialisable value (circular reference) without throwing', () => {
  const s = new StageContextStore();
  const circ = {}; circ.self = circ;
  assert.strictEqual(s.setScratch('bad', circ), false);
});

test('getScratch returns null for missing key', () => {
  const s = new StageContextStore();
  assert.strictEqual(s.getScratch('nope'), null);
});

// ── TTL expiry ────────────────────────────────────────────────────────────────
console.log('\nTTL expiry');

test('ttlMs=1ms entry expires immediately on next read', async () => {
  const s = new StageContextStore();
  s.setScratch('short', 'v', { ttlMs: 1 });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(s.getScratch('short'), null);
});

test('listScratch purges expired entries lazily', async () => {
  const s = new StageContextStore();
  s.setScratch('a', 'v', { ttlMs: 1 });
  s.setScratch('b', 'v');
  await new Promise(r => setTimeout(r, 10));
  const list = s.listScratch();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].key, 'b');
});

// ── nextStage scope semantics ─────────────────────────────────────────────────
console.log('\nnextStage scope');

test('nextStage entry readable from different stage and consumed on first read', () => {
  const s = new StageContextStore();
  s.setScratch('handoff', 'signal', { scope: 'nextStage', fromStage: 'ARCHITECT' });

  const first = s.getScratch('handoff', { currentStage: 'PLAN' });
  assert.ok(first, 'first read succeeds');
  assert.strictEqual(first.value, 'signal');

  const second = s.getScratch('handoff', { currentStage: 'PLAN' });
  assert.strictEqual(second, null, 'second read returns null (consumed)');
});

test('nextStage entry remains readable from same originating stage (not yet crossed boundary)', () => {
  const s = new StageContextStore();
  s.setScratch('pending', 'v', { scope: 'nextStage', fromStage: 'ANALYSE' });
  const got = s.getScratch('pending', { currentStage: 'ANALYSE' });
  assert.ok(got, 'same-stage read returns entry');
  const again = s.getScratch('pending', { currentStage: 'ANALYSE' });
  assert.ok(again, 'still available on subsequent same-stage reads');
});

// ── deleteScratch / listScratch ───────────────────────────────────────────────
console.log('\ndeleteScratch() / listScratch()');

test('deleteScratch removes the entry and returns true', () => {
  const s = new StageContextStore();
  s.setScratch('gone', 'v');
  assert.strictEqual(s.deleteScratch('gone'), true);
  assert.strictEqual(s.getScratch('gone'), null);
});

test('deleteScratch returns false for unknown key', () => {
  const s = new StageContextStore();
  assert.strictEqual(s.deleteScratch('never-set'), false);
});

test('listScratch filters by scope', () => {
  const s = new StageContextStore();
  s.setScratch('a', 'v', { scope: 'session' });
  s.setScratch('b', 'v', { scope: 'nextStage', fromStage: 'CODE' });
  const sessionOnly = s.listScratch({ scope: 'session' });
  assert.strictEqual(sessionOnly.length, 1);
  assert.strictEqual(sessionOnly[0].key, 'a');
});

test('listScratch filters by tag', () => {
  const s = new StageContextStore();
  s.setScratch('a', 'v', { tags: ['security'] });
  s.setScratch('b', 'v', { tags: ['perf'] });
  const secOnly = s.listScratch({ tag: 'security' });
  assert.strictEqual(secOnly.length, 1);
  assert.strictEqual(secOnly[0].key, 'a');
});

// ── Capacity / LRU eviction ───────────────────────────────────────────────────
console.log('\nScratchpad LRU eviction');

test('exceeding scratchMaxEntries evicts oldest', () => {
  const s = new StageContextStore({ scratchMaxEntries: 3 });
  s.setScratch('a', '1');
  s.setScratch('b', '2');
  s.setScratch('c', '3');
  s.setScratch('d', '4'); // should evict 'a'
  const keys = s.listScratch().map(e => e.key).sort();
  assert.deepStrictEqual(keys, ['b', 'c', 'd']);
});

test('getScratchStats reports totals', () => {
  const s = new StageContextStore({ scratchMaxEntries: 10 });
  s.setScratch('k1', 'hello');
  s.setScratch('k2', 'world');
  const stats = s.getScratchStats();
  assert.strictEqual(stats.entries, 2);
  assert.strictEqual(stats.totalChars, 'hello'.length + 'world'.length);
  assert.strictEqual(stats.maxEntries, 10);
});

test('exceeding scratchMaxTotalChars triggers char-based eviction', () => {
  const s = new StageContextStore({ scratchMaxEntries: 100, scratchMaxTotalChars: 20 });
  s.setScratch('a', 'x'.repeat(10)); // 10 chars
  s.setScratch('b', 'y'.repeat(10)); // 20 chars total — still fits
  s.setScratch('c', 'z'.repeat(10)); // 30 > 20 → evict a
  const keys = s.listScratch().map(e => e.key).sort();
  assert.ok(!keys.includes('a'), 'oldest entry a evicted');
});

// ── Persistence round-trip ────────────────────────────────────────────────────
console.log('\nPersistence round-trip');

test('scratchpad survives persist → reload in same output dir', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scratch-'));
  try {
    const s1 = new StageContextStore({ outputDir: tmp });
    s1.setScratch('persisted', 'value', { fromStage: 'PLAN' });
    // wait for setImmediate debounced persist
    await new Promise(r => setImmediate(r));
    await new Promise(r => setTimeout(r, 20));

    const persistedFile = path.join(tmp, 'stage-context.json');
    assert.ok(fs.existsSync(persistedFile), 'stage-context.json was written');
    const raw = JSON.parse(fs.readFileSync(persistedFile, 'utf-8'));
    assert.ok(raw._scratchpad, '_scratchpad block present');
    assert.ok(raw._scratchpad.persisted, 'specific key persisted');

    const s2 = new StageContextStore({ outputDir: tmp });
    const got = s2.getScratch('persisted');
    assert.ok(got, 'reload retrieved entry');
    assert.strictEqual(got.value, 'value');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});

test('reload skips already-expired scratchpad entries', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-scratch-'));
  try {
    const s1 = new StageContextStore({ outputDir: tmp });
    s1.setScratch('fresh', 'still-alive');
    s1.setScratch('stale', 'gone', { ttlMs: 1 });
    await new Promise(r => setTimeout(r, 20));
    await new Promise(r => setImmediate(r));

    const s2 = new StageContextStore({ outputDir: tmp });
    assert.ok(s2.getScratch('fresh'), 'fresh survives');
    assert.strictEqual(s2.getScratch('stale'), null, 'stale dropped on reload');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
});

// ── Backward compat: existing stage APIs unchanged ────────────────────────────
console.log('\nBackward compatibility');

test('existing set/get/getAll stage APIs still work alongside scratchpad', () => {
  const s = new StageContextStore();
  s.set('ARCHITECT', { summary: 'chose monolith', keyDecisions: ['d1'] });
  s.setScratch('arch-note', 'side-band data');

  const stage = s.get('ARCHITECT');
  assert.strictEqual(stage.summary, 'chose monolith');
  assert.strictEqual(s.getScratch('arch-note').value, 'side-band data');

  const lru = s.getLruStats();
  assert.strictEqual(lru.entries, 1, 'stage LRU counts only stage entries');

  const scratch = s.getScratchStats();
  assert.strictEqual(scratch.entries, 1, 'scratchpad stats independent');
});

// ── Summary ────────────────────────────────────────────────────────────────────
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
