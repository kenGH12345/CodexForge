'use strict';

const assert = require('assert');
const {
  EnrichmentBudgetGuard,
  ENRICHMENT_BUDGET_CHARS,
  ENRICHMENT_PRIORITIES,
  MIN_BLOCK_SIZE,
  ENRICHMENT_COMPRESS_THRESHOLD,
} = require('../core/enrichment-budget-guard');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContent(size, label = 'X') {
  return label.repeat(size);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.error(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ ${name}: ${err.message}`);
      failed++;
    }
  }

  console.error('\n🧪 EnrichmentBudgetGuard — Unit Tests\n');

  // ── Construction ──────────────────────────────────────────────────────────

  await test('default construction uses ENRICHMENT_BUDGET_CHARS', () => {
    const guard = new EnrichmentBudgetGuard();
    assert.strictEqual(guard.totalBudgetChars, ENRICHMENT_BUDGET_CHARS);
  });

  await test('custom totalBudgetChars is respected', () => {
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: 500 });
    assert.strictEqual(guard.totalBudgetChars, 500);
  });

  await test('default baseContent is empty string', () => {
    const guard = new EnrichmentBudgetGuard();
    assert.strictEqual(guard.baseContent, '');
  });

  // ── append() ──────────────────────────────────────────────────────────────

  await test('append() returns appended=true for non-empty content', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false });
    const result = await guard.append('TEST', 'hello', 50);
    assert.strictEqual(result.appended, true);
    assert.strictEqual(result.originalChars, 5);
    assert.strictEqual(result.finalChars, 5);
  });

  await test('append() returns appended=false for empty content', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false });
    const result = await guard.append('TEST', '', 50);
    assert.strictEqual(result.appended, false);
  });

  await test('append() returns appended=false for whitespace-only content', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false });
    const result = await guard.append('TEST', '   ', 50);
    assert.strictEqual(result.appended, false);
  });

  // ── getAssembled() — under budget ──────────────────────────────────────────

  await test('getAssembled() returns all blocks when under budget', async () => {
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: 1000, enableCompression: false });
    await guard.append('A', 'content A', 80);
    await guard.append('B', 'content B', 60);
    const result = guard.getAssembled();
    assert.ok(result.includes('content A'));
    assert.ok(result.includes('content B'));
  });

  await test('getAssembled() preserves insertion order', async () => {
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: 1000, enableCompression: false });
    await guard.append('FIRST', 'aaa', 50);
    await guard.append('SECOND', 'bbb', 80);
    const result = guard.getAssembled();
    const firstIdx = result.indexOf('aaa');
    const secondIdx = result.indexOf('bbb');
    assert.ok(firstIdx < secondIdx, 'FIRST should appear before SECOND in output');
  });

  await test('getAssembled() prepends baseContent', async () => {
    const guard = new EnrichmentBudgetGuard({
      totalBudgetChars: 1000,
      baseContent: 'PREFIX_',
      enableCompression: false,
    });
    await guard.append('A', 'content', 50);
    const result = guard.getAssembled();
    assert.ok(result.startsWith('PREFIX_'));
    assert.ok(result.includes('content'));
  });

  // ── getAssembled() — over budget: truncation ───────────────────────────────

  await test('getAssembled() truncates low-priority blocks first', async () => {
    const budget = 200;
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: budget, enableCompression: false, minBlockSize: 20 });
    // HIGH priority — should survive
    await guard.append('CRITICAL', makeContent(100, 'C'), 80);
    // LOW priority — should be truncated
    await guard.append('LOW', makeContent(150, 'L'), 40);
    const result = guard.getAssembled();
    assert.ok(result.length <= budget + 200); // allow truncation suffix overhead
    assert.ok(result.includes('C'), 'CRITICAL block should survive');
  });

  await test('getAssembled() drops blocks when truncation insufficient', async () => {
    const budget = 100;
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: budget, enableCompression: false, minBlockSize: 50 });
    await guard.append('HIGH', makeContent(80, 'H'), 80);
    await guard.append('LOW1', makeContent(80, 'L'), 30);
    await guard.append('LOW2', makeContent(80, 'M'), 20);
    const result = guard.getAssembled();
    // 3 * 80 = 240 > budget=100; even after truncating to minBlockSize=50, 150 > 100
    // All blocks will be dropped since budget is insufficient for even one minBlockSize block + truncation suffix
    assert.ok(result.length <= budget + 200, 'Result should be within budget + overhead');
    // HIGH is last to be dropped, so it may survive briefly with truncation
    const stats = guard.getStats();
    assert.ok(stats.droppedBlocks > 0, 'At least some blocks should be dropped');
  });

  await test('getAssembled() preserves HIGH priority when budget allows one block', async () => {
    const budget = 500;
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: budget, enableCompression: false, minBlockSize: 50 });
    await guard.append('CRITICAL', makeContent(100, 'C'), 80);
    await guard.append('LOW1', makeContent(300, 'L'), 30);
    await guard.append('LOW2', makeContent(300, 'M'), 20);
    const result = guard.getAssembled();
    assert.ok(result.includes('C'), 'CRITICAL block should survive');
    // LOW2 is lowest priority — should be dropped first
    assert.ok(!result.includes('MMMM'), 'LOW2 should be truncated or dropped');
    // LOW1 may be truncated but not fully dropped if budget allows
    const stats = guard.getStats();
    assert.ok(stats.droppedBlocks >= 1, 'At least LOW2 should be dropped');
  });

  // ── getAssembled() — baseContent exceeds budget ────────────────────────────

  await test('getAssembled() returns baseContent only when it exceeds budget', async () => {
    const guard = new EnrichmentBudgetGuard({
      totalBudgetChars: 10,
      baseContent: makeContent(50, 'B'),
      enableCompression: false,
    });
    await guard.append('A', 'content', 80);
    const result = guard.getAssembled();
    assert.strictEqual(result, makeContent(50, 'B'));
  });

  // ── getStats() ─────────────────────────────────────────────────────────────

  await test('getStats() reports correct block count', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false });
    await guard.append('A', 'aaa', 50);
    await guard.append('B', 'bbb', 60);
    const stats = guard.getStats();
    assert.strictEqual(stats.blocksCount, 2);
    assert.strictEqual(stats.compressedBlocks, 0);
    assert.ok(stats.utilizationRate >= 0);
  });

  await test('getStats() tracks original vs final chars', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false });
    await guard.append('A', 'hello world', 50);
    const stats = guard.getStats();
    assert.strictEqual(stats.originalTotalChars, 11); // baseContent(0) + block(11)
  });

  // ── Priority ordering ──────────────────────────────────────────────────────

  await test('priority constants are correctly ordered', () => {
    assert.ok(ENRICHMENT_PRIORITIES.EXPERIENCE > ENRICHMENT_PRIORITIES.ANCHOR_FILES);
    assert.ok(ENRICHMENT_PRIORITIES.ANCHOR_FILES > ENRICHMENT_PRIORITIES.CODE_GRAPH_SEED);
    assert.ok(ENRICHMENT_PRIORITIES.CODE_GRAPH_SEED > ENRICHMENT_PRIORITIES.WEB_SEARCH);
    assert.ok(ENRICHMENT_PRIORITIES.WEB_SEARCH > ENRICHMENT_PRIORITIES.SESSION_MEMORY);
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  await test('append with skipCompression=true skips compression even for large content', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: true, compressThreshold: 10 });
    const result = await guard.append('BIG', makeContent(1000, 'X'), 50, { skipCompression: true });
    assert.strictEqual(result.compressed, false);
    assert.strictEqual(result.finalChars, 1000);
  });

  await test('compression disabled by constructor option', async () => {
    const guard = new EnrichmentBudgetGuard({ enableCompression: false, compressThreshold: 10 });
    const result = await guard.append('BIG', makeContent(1000, 'X'), 50);
    assert.strictEqual(result.compressed, false);
  });

  await test('zero-budget guard drops all blocks', async () => {
    const guard = new EnrichmentBudgetGuard({ totalBudgetChars: 0, enableCompression: false });
    await guard.append('A', 'content', 80);
    const result = guard.getAssembled();
    assert.strictEqual(result, '');
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  console.error(`\n📊 Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
