'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { CompensationLedger } = require('../compensation-ledger');
const { FileStateStore } = require('../file-state-store');
const { COMPENSATION_STATUS, EVENT_KINDS } = require('../types');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'comp-ledger-test-'));
}

function createStore(projectRoot) {
  const stateDir = path.join(projectRoot, 'output', 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  return new FileStateStore({ projectRoot });
}

function createSession(store, sessionId = 'test-session-1') {
  store.createSession(sessionId, 'test', 'node');
  return sessionId;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; console.error(`FAIL: ${message}`); }
}

// Test 1: register → listPending round-trip
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ stateStore: store });

  const desc = ledger.register({
    sessionId: sid, stage: 'ANALYSE', taskId: 'task-1',
    actionType: 'DELETE_ARTIFACT', args: { filePath: '/tmp/test.md' },
  });

  assert(desc.compensationId.startsWith('comp-'), 'compensationId prefix');
  assert(desc.status === COMPENSATION_STATUS.PENDING, 'status is pending');
  assert(desc.actionType === 'DELETE_ARTIFACT', 'actionType preserved');
  assert(desc.sessionId === sid, 'sessionId preserved');

  const pending = ledger.listPending(sid);
  assert(pending.length === 1, 'one pending descriptor');
  assert(pending[0].compensationId === desc.compensationId, 'pending ID matches');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 2: markCompleted / markFailed state transitions
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ stateStore: store });

  const d1 = ledger.register({ sessionId: sid, stage: 'S1', taskId: 't1', actionType: 'A1' });
  const d2 = ledger.register({ sessionId: sid, stage: 'S1', taskId: 't2', actionType: 'A2' });

  ledger.markCompleted(sid, d1.compensationId);
  ledger.markFailed(sid, d2.compensationId, new Error('boom'));

  assert(ledger.get(sid, d1.compensationId).status === COMPENSATION_STATUS.COMPLETED, 'd1 completed');
  assert(ledger.get(sid, d2.compensationId).status === COMPENSATION_STATUS.FAILED, 'd2 failed');
  assert(ledger.get(sid, d2.compensationId).error.name === 'Error', 'd2 error name');
  assert(ledger.get(sid, d2.compensationId).error.message === 'boom', 'd2 error message');

  const pending = ledger.listPending(sid);
  assert(pending.length === 0, 'no pending after marking all');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 3: idempotency — repeated markCompleted is a no-op
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ stateStore: store });

  const d = ledger.register({ sessionId: sid, stage: 'S1', taskId: 't1', actionType: 'A1' });
  const r1 = ledger.markCompleted(sid, d.compensationId);
  const r2 = ledger.markCompleted(sid, d.compensationId);

  assert(r1.status === COMPENSATION_STATUS.COMPLETED, 'first markCompleted succeeds');
  assert(r2.status === COMPENSATION_STATUS.COMPLETED, 'second markCompleted is no-op');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 4: crash recovery — reload from FileStateStore
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger1 = new CompensationLedger({ stateStore: store });

  ledger1.register({ sessionId: sid, stage: 'S1', taskId: 't1', actionType: 'DELETE_ARTIFACT', args: { f: 'x' } });
  ledger1.register({ sessionId: sid, stage: 'S2', taskId: 't2', actionType: 'CLEAR_STAGE_CTX' });

  // Simulate process restart — create new store + ledger instances
  const store2 = createStore(tmp);
  const ledger2 = new CompensationLedger({ stateStore: store2 });

  const pending = ledger2.listPending(sid);
  assert(pending.length === 2, 'two pending descriptors after reload');
  assert(pending.some(d => d.actionType === 'DELETE_ARTIFACT'), 'found DELETE_ARTIFACT after reload');
  assert(pending.some(d => d.actionType === 'CLEAR_STAGE_CTX'), 'found CLEAR_STAGE_CTX after reload');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 5: clearStage only removes matching stage descriptors
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ stateStore: store });

  ledger.register({ sessionId: sid, stage: 'S1', taskId: 't1', actionType: 'A1' });
  ledger.register({ sessionId: sid, stage: 'S2', taskId: 't2', actionType: 'A2' });

  const removed = ledger.clearStage(sid, 'S1');
  assert(removed === 1, 'one descriptor removed');

  const remaining = ledger.listAll(sid);
  assert(remaining.length === 1, 'one descriptor remaining');
  assert(remaining[0].stage === 'S2', 'remaining is from S2');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Test 6: listAll returns all statuses
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ stateStore: store });

  const d1 = ledger.register({ sessionId: sid, stage: 'S1', taskId: 't1', actionType: 'A1' });
  const d2 = ledger.register({ sessionId: sid, stage: 'S1', taskId: 't2', actionType: 'A2' });
  ledger.markCompleted(sid, d1.compensationId);

  const all = ledger.listAll(sid);
  assert(all.length === 2, 'two descriptors total');
  assert(all.filter(d => d.status === COMPENSATION_STATUS.COMPLETED).length === 1, 'one completed');
  assert(all.filter(d => d.status === COMPENSATION_STATUS.PENDING).length === 1, 'one pending');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.error(`\nCompensationLedger Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
