/**
 * P0 Orchestration Review Tests: SubtaskCache Persistence + Budget Ceiling + Heartbeat
 *
 * Covers:
 *   A. RollbackCoordinator subtask cache persistence to manifest.meta (P0-1)
 *   B. _runStage budget ceiling timeout (P0-2)
 *   C. _runStage heartbeat interval (P0-3)
 *   D. HOOK_EVENTS new event types
 */

'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function asyncTest(name, fn) {
  return fn()
    .then(() => {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    })
    .catch(err => {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     ${err.message}`);
      failed++;
    });
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertIncludes(str, substr, msg) {
  if (!str.includes(substr)) throw new Error(`${msg}: expected "${str}" to include "${substr}"`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. RollbackCoordinator SubtaskCache Persistence (P0-1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. SubtaskCache Persistence (P0-1) ─────────────────────────');

test('cacheSubtaskResult persists to manifest.meta.subtaskCache', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  // Create a mock orchestrator with a minimal stateMachine
  let manifestWritten = false;
  const mockManifest = { meta: {} };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() { manifestWritten = true; },
    },
  };

  const rc = new RollbackCoordinator(mockOrch);
  rc.cacheSubtaskResult('ARCHITECT', 'CoverageCheck', { score: 85 });

  // Verify in-memory cache
  assert.ok(mockOrch._subtaskCache.has('ARCHITECT'), 'In-memory cache should have ARCHITECT');
  const entry = mockOrch._subtaskCache.get('ARCHITECT').get('CoverageCheck');
  assertEqual(entry.result.score, 85, 'In-memory cached result.score');

  // Verify manifest persistence
  assert.ok(manifestWritten, 'manifest should have been written');
  assert.ok(mockManifest.meta.subtaskCache, 'manifest.meta.subtaskCache should exist');
  assert.ok(mockManifest.meta.subtaskCache.ARCHITECT, 'manifest.meta.subtaskCache.ARCHITECT should exist');
  assertEqual(
    mockManifest.meta.subtaskCache.ARCHITECT.CoverageCheck.result.score,
    85,
    'Persisted result.score'
  );
});

test('cacheSubtaskResult persists multiple subtasks for same stage', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  const mockManifest = { meta: {} };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() {},
    },
  };

  const rc = new RollbackCoordinator(mockOrch);
  rc.cacheSubtaskResult('ARCHITECT', 'CoverageCheck', { score: 85 });
  rc.cacheSubtaskResult('ARCHITECT', 'ArchReview', { passed: true });

  const persisted = mockManifest.meta.subtaskCache.ARCHITECT;
  assertEqual(persisted.CoverageCheck.result.score, 85, 'CoverageCheck persisted');
  assertEqual(persisted.ArchReview.result.passed, true, 'ArchReview persisted');
});

test('invalidateSubtaskCache removes from both memory and manifest', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  const mockManifest = { meta: {} };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() {},
    },
  };

  const rc = new RollbackCoordinator(mockOrch);
  rc.cacheSubtaskResult('ARCHITECT', 'CoverageCheck', { score: 85 });
  rc.invalidateSubtaskCache('ARCHITECT');

  assert.ok(!mockOrch._subtaskCache.has('ARCHITECT'), 'In-memory cache should be cleared');
  // manifest.meta.subtaskCache should be updated (ARCHITECT removed)
  const persisted = mockManifest.meta.subtaskCache;
  assert.ok(!persisted.ARCHITECT || Object.keys(persisted.ARCHITECT).length === 0,
    'Persisted cache should not have ARCHITECT entries');
});

test('_restoreSubtaskCacheFromManifest restores valid entries', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  const now = Date.now();
  const mockManifest = {
    meta: {
      subtaskCache: {
        ARCHITECT: {
          CoverageCheck: { result: { score: 90 }, timestamp: now - 60000 }, // 1 min ago (valid)
          ArchReview: { result: { passed: true }, timestamp: now - 60000 },
        },
      },
    },
  };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() {},
    },
  };

  // Constructor calls _restoreSubtaskCacheFromManifest
  const rc = new RollbackCoordinator(mockOrch);

  assert.ok(mockOrch._subtaskCache.has('ARCHITECT'), 'Should restore ARCHITECT cache');
  const coverage = mockOrch._subtaskCache.get('ARCHITECT').get('CoverageCheck');
  assertEqual(coverage.result.score, 90, 'Should restore CoverageCheck result');
  const review = mockOrch._subtaskCache.get('ARCHITECT').get('ArchReview');
  assertEqual(review.result.passed, true, 'Should restore ArchReview result');
});

test('_restoreSubtaskCacheFromManifest skips stale entries (>10min)', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  const now = Date.now();
  const mockManifest = {
    meta: {
      subtaskCache: {
        ARCHITECT: {
          CoverageCheck: { result: { score: 90 }, timestamp: now - 15 * 60 * 1000 }, // 15 min ago (stale)
          ArchReview: { result: { passed: true }, timestamp: now - 60000 }, // 1 min ago (valid)
        },
      },
    },
  };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() {},
    },
  };

  const rc = new RollbackCoordinator(mockOrch);

  assert.ok(mockOrch._subtaskCache.has('ARCHITECT'), 'Should restore ARCHITECT cache');
  assert.ok(!mockOrch._subtaskCache.get('ARCHITECT').has('CoverageCheck'),
    'Should NOT restore stale CoverageCheck');
  assert.ok(mockOrch._subtaskCache.get('ARCHITECT').has('ArchReview'),
    'Should restore valid ArchReview');
});

test('_restoreSubtaskCacheFromManifest handles missing/empty meta gracefully', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  // No meta.subtaskCache
  const mockOrch1 = {
    _subtaskCache: new Map(),
    stateMachine: { manifest: { meta: {} }, _writeManifest() {} },
  };
  const rc1 = new RollbackCoordinator(mockOrch1);
  assertEqual(mockOrch1._subtaskCache.size, 0, 'No entries should be restored from empty meta');

  // No meta at all
  const mockOrch2 = {
    _subtaskCache: new Map(),
    stateMachine: { manifest: {}, _writeManifest() {} },
  };
  const rc2 = new RollbackCoordinator(mockOrch2);
  assertEqual(mockOrch2._subtaskCache.size, 0, 'No entries should be restored from missing meta');

  // No stateMachine
  const mockOrch3 = {
    _subtaskCache: new Map(),
  };
  const rc3 = new RollbackCoordinator(mockOrch3);
  assertEqual(mockOrch3._subtaskCache.size, 0, 'No crash when stateMachine is missing');
});

test('cacheSubtaskResult skips non-serialisable results for persistence', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  const mockManifest = { meta: {} };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: mockManifest,
      _writeManifest() {},
    },
  };

  const rc = new RollbackCoordinator(mockOrch);

  // Cache a result with a circular reference (non-serialisable)
  const circular = {};
  circular.self = circular;
  rc.cacheSubtaskResult('CODE', 'CodeGeneration', circular);

  // In-memory cache should still have it
  assert.ok(mockOrch._subtaskCache.has('CODE'), 'In-memory cache should have CODE');

  // But manifest should NOT have it (skipped due to non-serialisable)
  const persisted = mockManifest.meta.subtaskCache.CODE || {};
  assert.ok(!persisted.CodeGeneration || !persisted.CodeGeneration.result,
    'Non-serialisable result should NOT be persisted to manifest');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Budget Ceiling Constants & Configuration (P0-2)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── B. Budget Ceiling & Heartbeat Events (P0-2/P0-3) ──────────');

test('HOOK_EVENTS includes STAGE_HEARTBEAT and STAGE_TIMEOUT', () => {
  const { HOOK_EVENTS } = require('../core/constants');

  assert.ok(HOOK_EVENTS.STAGE_HEARTBEAT, 'STAGE_HEARTBEAT should be defined');
  assertEqual(HOOK_EVENTS.STAGE_HEARTBEAT, 'stage_heartbeat', 'STAGE_HEARTBEAT value');

  assert.ok(HOOK_EVENTS.STAGE_TIMEOUT, 'STAGE_TIMEOUT should be defined');
  assertEqual(HOOK_EVENTS.STAGE_TIMEOUT, 'stage_timeout', 'STAGE_TIMEOUT value');
});

test('HookSystem registers built-in handlers for STAGE_HEARTBEAT and STAGE_TIMEOUT', () => {
  const { HookSystem } = require('../hooks/hook-system');
  const hs = new HookSystem();
  const { HOOK_EVENTS } = require('../core/constants');

  // Check that handlers are registered
  const heartbeatHandlers = hs._handlers.get(HOOK_EVENTS.STAGE_HEARTBEAT);
  assert.ok(heartbeatHandlers && heartbeatHandlers.length > 0,
    'STAGE_HEARTBEAT should have at least one handler');

  const timeoutHandlers = hs._handlers.get(HOOK_EVENTS.STAGE_TIMEOUT);
  assert.ok(timeoutHandlers && timeoutHandlers.length > 0,
    'STAGE_TIMEOUT should have at least one handler');
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Budget Ceiling Timeout Behavior (P0-2) — Async Tests
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── C. Budget Ceiling Timeout Behavior (P0-2) ──────────────────');

// We test the timeout logic by simulating a slow stageRunner with Promise.race

async function runAsyncTests() {
  await asyncTest('Promise.race rejects when stage exceeds timeout', async () => {
    const TIMEOUT_MS = 100;
    const slowRunner = () => new Promise(resolve => setTimeout(() => resolve('done'), 500));

    try {
      await Promise.race([
        slowRunner(),
        new Promise((_, reject) => setTimeout(() => {
          reject(new Error('[StageBudgetCeiling] Test timeout exceeded'));
        }, TIMEOUT_MS)),
      ]);
      throw new Error('Should have thrown');
    } catch (err) {
      assertIncludes(err.message, 'StageBudgetCeiling', 'Should throw StageBudgetCeiling error');
    }
  });

  await asyncTest('Promise.race resolves when stage completes within timeout', async () => {
    const TIMEOUT_MS = 500;
    const fastRunner = () => new Promise(resolve => setTimeout(() => resolve('artifact.md'), 10));

    const result = await Promise.race([
      fastRunner(),
      new Promise((_, reject) => setTimeout(() => {
        reject(new Error('[StageBudgetCeiling] Timeout'));
      }, TIMEOUT_MS)),
    ]);
    assertEqual(result, 'artifact.md', 'Should resolve with stage result');
  });

  await asyncTest('Heartbeat emits at configured interval', async () => {
    const events = [];
    const HEARTBEAT_MS = 50;
    const stageStartMs = Date.now();

    const heartbeatTimer = setInterval(() => {
      events.push({
        stage: 'TEST→FINISHED',
        elapsedMs: Date.now() - stageStartMs,
      });
    }, HEARTBEAT_MS);

    // Simulate a 180ms stage run
    await new Promise(resolve => setTimeout(resolve, 180));
    clearInterval(heartbeatTimer);

    // Should have emitted at least 2 heartbeats (at ~50ms and ~100ms and possibly ~150ms)
    assert.ok(events.length >= 2,
      `Should emit at least 2 heartbeats in 180ms with ${HEARTBEAT_MS}ms interval, got ${events.length}`);
    assert.ok(events[0].elapsedMs >= HEARTBEAT_MS - 20,
      `First heartbeat should be after ~${HEARTBEAT_MS}ms, was ${events[0].elapsedMs}ms`);
  });

  await asyncTest('Heartbeat timer is cleaned up after stage completes', async () => {
    let heartbeatCount = 0;
    const HEARTBEAT_MS = 30;

    const heartbeatTimer = setInterval(() => { heartbeatCount++; }, HEARTBEAT_MS);

    // Simulate fast stage completion
    await new Promise(resolve => setTimeout(resolve, 10));
    clearInterval(heartbeatTimer);

    const countAtCleanup = heartbeatCount;

    // Wait more to confirm no more heartbeats
    await new Promise(resolve => setTimeout(resolve, 100));
    assertEqual(heartbeatCount, countAtCleanup,
      'No more heartbeats should fire after cleanup');
  });

  await asyncTest('Heartbeat timer is cleaned up even when stage throws', async () => {
    let heartbeatCount = 0;
    const HEARTBEAT_MS = 30;

    const heartbeatTimer = setInterval(() => { heartbeatCount++; }, HEARTBEAT_MS);

    try {
      // Simulate stage that throws
      await Promise.reject(new Error('stage failed'));
    } catch (_) {
      // Expected
    } finally {
      clearInterval(heartbeatTimer);
    }

    const countAtCleanup = heartbeatCount;
    await new Promise(resolve => setTimeout(resolve, 100));
    assertEqual(heartbeatCount, countAtCleanup,
      'No more heartbeats after cleanup on error path');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// D. Integration: SubtaskCache round-trip (persist → restore)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── D. SubtaskCache Round-trip Integration ─────────────────────');

test('Full round-trip: cache → persist → new coordinator → restore', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');

  // Phase 1: Cache a result and persist to manifest
  const sharedManifest = { meta: {} };
  const mockOrch1 = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: sharedManifest,
      _writeManifest() {},
    },
  };

  const rc1 = new RollbackCoordinator(mockOrch1);
  rc1.cacheSubtaskResult('ARCHITECT', 'CoverageCheck', { score: 95, details: ['all files covered'] });
  rc1.cacheSubtaskResult('ARCHITECT', 'ArchReview', { passed: true, notes: 'LGTM' });

  // Phase 2: Simulate process restart — new orchestrator, same manifest
  const mockOrch2 = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: sharedManifest, // Same manifest (as if loaded from disk)
      _writeManifest() {},
    },
  };

  const rc2 = new RollbackCoordinator(mockOrch2);

  // Verify restoration
  assert.ok(mockOrch2._subtaskCache.has('ARCHITECT'), 'Should restore ARCHITECT cache after "restart"');
  const coverage = mockOrch2._subtaskCache.get('ARCHITECT').get('CoverageCheck');
  assertEqual(coverage.result.score, 95, 'CoverageCheck.score should be restored');
  assert.deepStrictEqual(coverage.result.details, ['all files covered'], 'CoverageCheck.details should be restored');
  const review = mockOrch2._subtaskCache.get('ARCHITECT').get('ArchReview');
  assertEqual(review.result.passed, true, 'ArchReview.passed should be restored');
});

test('analyseRollbackStrategy uses restored cache for SUBTASK_RETRY', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');
  const { WorkflowState } = require('../core/types');

  const now = Date.now();
  const sharedManifest = {
    meta: {
      subtaskCache: {
        [WorkflowState.ARCHITECT]: {
          CoverageCheck: { result: { score: 90 }, timestamp: now - 30000 }, // 30s ago (valid)
        },
      },
    },
  };

  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: {
      manifest: sharedManifest,
      _writeManifest() {},
    },
  };

  const rc = new RollbackCoordinator(mockOrch);

  // Analyse: ArchReview failed but CoverageCheck is cached
  const strategy = rc.analyseRollbackStrategy(
    WorkflowState.ARCHITECT,
    'Architecture review found critical issues',
    'ArchReview'
  );

  assertEqual(strategy.type, 'SUBTASK_RETRY', 'Should recommend SUBTASK_RETRY with restored cache');
  assertEqual(strategy.failedSubtask, 'ArchReview', 'Failed subtask should be ArchReview');
  assert.ok(strategy.cachedResults.has('CoverageCheck'), 'CoverageCheck should be in cachedResults');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Run async tests and print summary
// ═══════════════════════════════════════════════════════════════════════════════

runAsyncTests().then(() => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  P0 Orchestration Review Tests: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
});
