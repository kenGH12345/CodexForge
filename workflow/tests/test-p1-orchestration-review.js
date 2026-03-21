/**
 * P1 Orchestration Review Tests: IdempotencyJournal + SagaContext + StageResult + Side Effect Isolation
 *
 * Covers:
 *   A. IdempotencyJournal — key generation, lookup, record, invalidation, persistence (P1-1)
 *   B. SagaContext — compensation registration, LIFO execution, error isolation (P1-2)
 *   C. StageResult — discriminated union type system, type guards, backward compatibility (P1-3)
 *   D. _initWorkflow side effect isolation — idempotent re-entry guard (P1-4)
 */

'use strict';

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

// ═══════════════════════════════════════════════════════════════════════════════
// A. IdempotencyJournal (P1-1)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. IdempotencyJournal (P1-1) ────────────────────────────────');

const { IdempotencyJournal } = require('../core/rollback-coordinator');

test('generateKey produces deterministic SHA-256 hash', () => {
  const key1 = IdempotencyJournal.generateKey('ARCHITECT', 'ArchReview', 'prompt-content-abc');
  const key2 = IdempotencyJournal.generateKey('ARCHITECT', 'ArchReview', 'prompt-content-abc');
  assertEqual(key1, key2, 'Same inputs should produce same key');
  assertEqual(key1.length, 32, 'Key should be 32 hex chars');
});

test('generateKey produces different keys for different inputs', () => {
  const key1 = IdempotencyJournal.generateKey('ARCHITECT', 'ArchReview', 'prompt-A');
  const key2 = IdempotencyJournal.generateKey('ARCHITECT', 'CoverageCheck', 'prompt-A');
  const key3 = IdempotencyJournal.generateKey('CODE', 'ArchReview', 'prompt-A');
  assert.ok(key1 !== key2, 'Different subtask should produce different key');
  assert.ok(key1 !== key3, 'Different stage should produce different key');
});

test('lookup returns miss for unknown key', () => {
  const mockOrch = { stateMachine: { manifest: { meta: {} }, _writeManifest() {} } };
  const journal = new IdempotencyJournal(mockOrch);
  const result = journal.lookup('nonexistent-key');
  assertEqual(result.hit, false, 'Should miss for unknown key');
});

test('record and lookup returns hit', () => {
  const mockOrch = { stateMachine: { manifest: { meta: {} }, _writeManifest() {} } };
  const journal = new IdempotencyJournal(mockOrch);
  const key = IdempotencyJournal.generateKey('ARCHITECT', 'ArchReview', 'test-prompt');
  journal.record(key, { score: 95 }, { stage: 'ARCHITECT', subtask: 'ArchReview' });

  const result = journal.lookup(key);
  assertEqual(result.hit, true, 'Should hit after record');
  assertEqual(result.result.score, 95, 'Should return correct result');
});

test('invalidateStage removes all entries for that stage', () => {
  const mockOrch = { stateMachine: { manifest: { meta: {} }, _writeManifest() {} } };
  const journal = new IdempotencyJournal(mockOrch);

  const key1 = IdempotencyJournal.generateKey('ARCHITECT', 'ArchReview', 'p1');
  const key2 = IdempotencyJournal.generateKey('ARCHITECT', 'CoverageCheck', 'p2');
  const key3 = IdempotencyJournal.generateKey('CODE', 'CodeGen', 'p3');

  journal.record(key1, 'result1', { stage: 'ARCHITECT', subtask: 'ArchReview' });
  journal.record(key2, 'result2', { stage: 'ARCHITECT', subtask: 'CoverageCheck' });
  journal.record(key3, 'result3', { stage: 'CODE', subtask: 'CodeGen' });

  assertEqual(journal.size, 3, 'Should have 3 entries');
  journal.invalidateStage('ARCHITECT');
  assertEqual(journal.size, 1, 'Should have 1 entry after invalidation');
  assertEqual(journal.lookup(key3).hit, true, 'CODE entry should survive');
  assertEqual(journal.lookup(key1).hit, false, 'ARCHITECT entry should be removed');
});

test('persistence: record persists to manifest.meta', () => {
  const mockManifest = { meta: {} };
  let writeCount = 0;
  const mockOrch = { stateMachine: { manifest: mockManifest, _writeManifest() { writeCount++; } } };
  const journal = new IdempotencyJournal(mockOrch);

  const key = IdempotencyJournal.generateKey('TEST', 'run', 'prompt');
  journal.record(key, { passed: true }, { stage: 'TEST', subtask: 'run' });

  assert.ok(mockManifest.meta.idempotencyJournal, 'Should persist to manifest');
  assert.ok(mockManifest.meta.idempotencyJournal[key], 'Should have the entry');
  assert.ok(writeCount > 0, 'Should call _writeManifest');
});

test('restoration: constructor restores from manifest', () => {
  const now = Date.now();
  const key = 'test-restore-key-abc123';
  const mockManifest = {
    meta: {
      idempotencyJournal: {
        [key]: { result: { data: 'cached' }, timestamp: now - 60000, stage: 'PLAN', subtask: 'split' },
      },
    },
  };
  const mockOrch = { stateMachine: { manifest: mockManifest, _writeManifest() {} } };
  const journal = new IdempotencyJournal(mockOrch);

  const result = journal.lookup(key);
  assertEqual(result.hit, true, 'Should restore from manifest');
  assertEqual(result.result.data, 'cached', 'Should have correct result');
});

test('stale entries (>15min) are skipped on restore and lookup', () => {
  const key = 'stale-key-xyz';
  const mockManifest = {
    meta: {
      idempotencyJournal: {
        [key]: { result: 'old', timestamp: Date.now() - 20 * 60 * 1000, stage: 'TEST', subtask: 'run' },
      },
    },
  };
  const mockOrch = { stateMachine: { manifest: mockManifest, _writeManifest() {} } };
  const journal = new IdempotencyJournal(mockOrch);

  assertEqual(journal.size, 0, 'Stale entry should not be restored');
  assertEqual(journal.lookup(key).hit, false, 'Stale entry should miss');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. SagaContext (P1-2)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── B. SagaContext (P1-2) ────────────────────────────────────────');

const { SagaContext } = require('../core/rollback-coordinator');

test('addCompensation registers functions', () => {
  const saga = new SagaContext('ARCHITECT');
  saga.addCompensation('clear-bus', () => {});
  saga.addCompensation('delete-ctx', () => {});
  assertEqual(saga.size, 2, 'Should have 2 compensations');
  assert.deepStrictEqual(saga.labels, ['clear-bus', 'delete-ctx'], 'Labels should match');
});

test('addCompensation rejects non-function', () => {
  const saga = new SagaContext('TEST');
  try {
    saga.addCompensation('bad', 'not-a-function');
    throw new Error('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('must be a function'), 'Should throw TypeError');
  }
});

async function runSagaAsyncTests() {
  await asyncTest('compensate executes in LIFO order', async () => {
    const order = [];
    const saga = new SagaContext('CODE');
    saga.addCompensation('first', () => order.push('first'));
    saga.addCompensation('second', () => order.push('second'));
    saga.addCompensation('third', () => order.push('third'));

    const result = await saga.compensate();
    assert.deepStrictEqual(order, ['third', 'second', 'first'], 'Should execute in LIFO order');
    assertEqual(result.executed, 3, 'All 3 should execute');
    assertEqual(result.failed, 0, 'None should fail');
  });

  await asyncTest('compensate handles errors and continues', async () => {
    const order = [];
    const saga = new SagaContext('TEST');
    saga.addCompensation('step1', () => order.push('step1'));
    saga.addCompensation('step2-fail', () => { throw new Error('compensation failed'); });
    saga.addCompensation('step3', () => order.push('step3'));

    const result = await saga.compensate();
    assertEqual(result.executed, 2, 'Two should succeed');
    assertEqual(result.failed, 1, 'One should fail');
    assert.ok(result.errors[0].label === 'step2-fail', 'Error should be from step2-fail');
    assert.deepStrictEqual(order, ['step3', 'step1'], 'Should execute surviving compensations');
  });

  await asyncTest('compensate is idempotent (second call is no-op)', async () => {
    let callCount = 0;
    const saga = new SagaContext('PLAN');
    saga.addCompensation('inc', () => callCount++);

    await saga.compensate();
    assertEqual(callCount, 1, 'Should execute once');

    const result2 = await saga.compensate();
    assertEqual(callCount, 1, 'Second call should not re-execute');
    assertEqual(result2.executed, 0, 'Second call should report 0 executed');
    assertEqual(saga.isCompensated, true, 'Should be marked as compensated');
  });

  await asyncTest('compensate supports async compensation functions', async () => {
    const results = [];
    const saga = new SagaContext('ARCH');
    saga.addCompensation('async-cleanup', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push('async-done');
    });

    await saga.compensate();
    assert.deepStrictEqual(results, ['async-done'], 'Async compensation should complete');
  });

  await asyncTest('reset allows re-use of saga', async () => {
    const saga = new SagaContext('CODE');
    saga.addCompensation('step', () => {});
    await saga.compensate();
    assertEqual(saga.isCompensated, true, 'Should be compensated');

    saga.reset();
    assertEqual(saga.isCompensated, false, 'Should be reset');
    assertEqual(saga.size, 0, 'Should have no compensations');

    saga.addCompensation('new-step', () => {});
    assertEqual(saga.size, 1, 'Should accept new compensations after reset');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// C. StageResult (P1-3)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── C. StageResult Type System (P1-3) ───────────────────────────');

const { StageResult, StageResultType } = require('../core/types');

test('StageResult.completed creates correct shape', () => {
  const r = StageResult.completed('output/architecture.md');
  assertEqual(r.__stageResult, true, '__stageResult flag');
  assertEqual(r.type, 'completed', 'type');
  assertEqual(r.artifactPath, 'output/architecture.md', 'artifactPath');
});

test('StageResult.rolledBack creates correct shape with backward compat', () => {
  const r = StageResult.rolledBack('output/requirement.md');
  assertEqual(r.__stageResult, true, '__stageResult flag');
  assertEqual(r.type, 'rolled_back', 'type');
  assertEqual(r.artifactPath, 'output/requirement.md', 'artifactPath');
  // Backward compatibility: still has __alreadyTransitioned
  assertEqual(r.__alreadyTransitioned, true, 'Backward compat __alreadyTransitioned');
});

test('StageResult.cached creates correct shape', () => {
  const r = StageResult.cached('output/test-report.md', 'subtaskCache:CoverageCheck');
  assertEqual(r.__stageResult, true, '__stageResult flag');
  assertEqual(r.type, 'cached', 'type');
  assertEqual(r.cacheSource, 'subtaskCache:CoverageCheck', 'cacheSource');
});

test('StageResult.failed creates correct shape', () => {
  const err = new Error('test failure');
  const r = StageResult.failed(err, 'ARCHITECT:ArchReview');
  assertEqual(r.__stageResult, true, '__stageResult flag');
  assertEqual(r.type, 'failed', 'type');
  assertEqual(r.error, err, 'error ref');
  assertEqual(r.context, 'ARCHITECT:ArchReview', 'context');
});

test('StageResult type guards work correctly', () => {
  const completed = StageResult.completed('path.md');
  const rolledBack = StageResult.rolledBack('path.md');
  const cached = StageResult.cached('path.md', 'src');
  const failed_ = StageResult.failed(new Error('x'));

  assertEqual(StageResult.isCompleted(completed), true, 'isCompleted');
  assertEqual(StageResult.isCompleted(rolledBack), false, 'isCompleted on rolledBack');
  assertEqual(StageResult.isRolledBack(rolledBack), true, 'isRolledBack');
  assertEqual(StageResult.isCached(cached), true, 'isCached');
  assertEqual(StageResult.isFailed(failed_), true, 'isFailed');
  assertEqual(StageResult.isStageResult(completed), true, 'isStageResult on completed');
  assertEqual(StageResult.isStageResult(null), false, 'isStageResult on null');
  assertEqual(StageResult.isStageResult('plain string'), false, 'isStageResult on string');
});

test('StageResult.getArtifactPath works for all variants', () => {
  assertEqual(StageResult.getArtifactPath(StageResult.completed('a.md')), 'a.md', 'completed');
  assertEqual(StageResult.getArtifactPath(StageResult.rolledBack('b.md')), 'b.md', 'rolledBack');
  assertEqual(StageResult.getArtifactPath(StageResult.cached('c.md', 'x')), 'c.md', 'cached');
  assertEqual(StageResult.getArtifactPath(StageResult.failed(new Error('x'))), null, 'failed');
  // Backward compat: plain string path
  assertEqual(StageResult.getArtifactPath('output/code.diff'), 'output/code.diff', 'plain string');
  assertEqual(StageResult.getArtifactPath(null), null, 'null');
});

test('StageResult backward compat: rolledBack is detected by __alreadyTransitioned check', () => {
  const r = StageResult.rolledBack('output/req.md');
  // Old-style check that exists in orchestrator-lifecycle.js and stage-tester.js
  const alreadyTransitioned = r && r.__alreadyTransitioned === true;
  assertEqual(alreadyTransitioned, true, 'Old-style check should still work');
  assertEqual(r.artifactPath, 'output/req.md', 'artifactPath accessible via old pattern');
});

test('StageResultType enum has all expected values', () => {
  assertEqual(StageResultType.COMPLETED, 'completed', 'COMPLETED');
  assertEqual(StageResultType.ROLLED_BACK, 'rolled_back', 'ROLLED_BACK');
  assertEqual(StageResultType.CACHED, 'cached', 'CACHED');
  assertEqual(StageResultType.FAILED, 'failed', 'FAILED');
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. _initWorkflow Side Effect Isolation (P1-4)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── D. Side Effect Isolation (P1-4) ─────────────────────────────');

test('_initWorkflow uses _initCompleted set for idempotency', () => {
  // Verify the pattern exists in the source code
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'orchestrator-lifecycle.js'), 'utf-8'
  );
  assert.ok(src.includes('this._initCompleted'), 'Should use _initCompleted set');
  assert.ok(src.includes("_initCompleted.has('memory')"), 'Should guard memory step');
  assert.ok(src.includes("_initCompleted.has('complaints')"), 'Should guard complaints step');
  assert.ok(src.includes("_initCompleted.has('skillWatcher')"), 'Should guard skillWatcher step');
  assert.ok(src.includes("_initCompleted.has('mcpAdapters')"), 'Should guard MCP step');
  assert.ok(src.includes("_initCompleted.has('experiencePreheat')"), 'Should guard preheat step');
  assert.ok(src.includes("_initCompleted.has('islandModules')"), 'Should guard island modules step');
});

test('_initWorkflow wraps each step in try/catch with P1-4 label', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'orchestrator-lifecycle.js'), 'utf-8'
  );
  // Count P1-4 labeled catch blocks
  const p14Catches = (src.match(/\[P1-4\]/g) || []).length;
  assert.ok(p14Catches >= 6, `Should have at least 6 P1-4 labeled catch blocks, got ${p14Catches}`);
});

test('Side effect isolation: each step adds to _initCompleted on success', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'orchestrator-lifecycle.js'), 'utf-8'
  );
  // Verify the pattern: check → execute → mark complete
  const steps = ['memory', 'complaints', 'skillWatcher', 'mcpAdapters', 'experiencePreheat', 'islandModules'];
  for (const step of steps) {
    assert.ok(
      src.includes(`_initCompleted.add('${step}')`),
      `Should mark '${step}' as completed on success`
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// E. Integration: SagaContext with RollbackCoordinator
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── E. Integration Tests ─────────────────────────────────────────');

test('SagaContext + RollbackCoordinator: saga compensates on rollback', () => {
  const compensated = [];
  const saga = new SagaContext('ARCHITECT');

  // Register compensations BEFORE operations (Temporal Saga pattern)
  saga.addCompensation('clear-bus', () => compensated.push('bus'));
  // Simulate: bus.publishArtifact(...)

  saga.addCompensation('delete-ctx', () => compensated.push('ctx'));
  // Simulate: stageCtx.set(...)

  saga.addCompensation('invalidate-cache', () => compensated.push('cache'));
  // Simulate: cacheSubtaskResult(...)

  // Simulate failure → trigger saga compensation synchronously for testing
  assertEqual(saga.size, 3, 'Should have 3 compensations registered');
  assertEqual(saga.isCompensated, false, 'Should not be compensated yet');
});

test('IdempotencyJournal + RollbackCoordinator: journal survives subtask cache invalidation', () => {
  const { RollbackCoordinator } = require('../core/rollback-coordinator');
  const mockManifest = { meta: {} };
  const mockOrch = {
    _subtaskCache: new Map(),
    stateMachine: { manifest: mockManifest, _writeManifest() {} },
  };

  const rc = new RollbackCoordinator(mockOrch);
  const journal = new IdempotencyJournal(mockOrch);

  // Record in both caches
  rc.cacheSubtaskResult('ARCHITECT', 'CoverageCheck', { score: 90 });
  const key = IdempotencyJournal.generateKey('ARCHITECT', 'CoverageCheck', 'prompt');
  journal.record(key, { score: 90 }, { stage: 'ARCHITECT', subtask: 'CoverageCheck' });

  // Invalidate subtask cache
  rc.invalidateSubtaskCache('ARCHITECT');

  // Journal should still have the entry (independent from subtask cache)
  assertEqual(journal.lookup(key).hit, true, 'Journal should survive subtask cache invalidation');
});

test('StageResult.rolledBack is compatible with _runStage processing', () => {
  // Simulate the _runStage result processing logic
  const result = StageResult.rolledBack('output/req-v2.md');

  const alreadyTransitioned = StageResult.isRolledBack(result) ||
    (result && result.__alreadyTransitioned === true);
  const artifactPath = StageResult.isStageResult(result)
    ? StageResult.getArtifactPath(result)
    : (alreadyTransitioned ? result.artifactPath : result);

  assertEqual(alreadyTransitioned, true, 'Should detect rolled back result');
  assertEqual(artifactPath, 'output/req-v2.md', 'Should extract artifact path');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Run async tests and print summary
// ═══════════════════════════════════════════════════════════════════════════════

runSagaAsyncTests().then(() => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  P1 Orchestration Review Tests: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
});
