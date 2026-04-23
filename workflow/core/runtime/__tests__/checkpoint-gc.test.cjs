'use strict';

(async () => {

const path = require('path');
const fs = require('fs');
const os = require('os');
const { CheckpointGC, DEFAULT_TTL_MS, GCABLE_STATUSES } = require('../checkpoint-gc');
const { FileStateStore } = require('../file-state-store');
const { JsonlEventStore } = require('../jsonl-event-store');
const { SESSION_STATUS } = require('../types');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-gc-test-'));
}

function createSession(store, sessionId, status, updatedAt) {
  const session = store.createSession({
    projectId: sessionId,
    requirement: 'gc-test',
    requirementFingerprint: 'test-hash',
    mode: 'node',
    initialStage: 'ANALYSE',
  });
  const realSid = session.sessionId;
  if (status !== SESSION_STATUS.CREATED || updatedAt) {
    const index = store._readIndex();
    index.sessions[realSid] = {
      status,
      updatedAt: updatedAt || new Date().toISOString(),
    };
    store._writeIndex(index);
  }
  return realSid;
}

// ── Test 1: CheckpointGC.run() with no expired sessions ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  const eventsDir = path.join(tmp, 'runtime', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });
  const eventStore = new JsonlEventStore({ eventsDir });

  createSession(stateStore, 'fresh-1', SESSION_STATUS.COMPLETED, new Date().toISOString());

  const gc = new CheckpointGC({ stateStore, eventStore });
  const result = gc.run({ ttlMs: DEFAULT_TTL_MS });

  assert(result.count === 0, 'no expired sessions should be deleted');
  assert(result.deleted.length === 0, 'deleted array should be empty');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 2: CheckpointGC.run() deletes expired sessions ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  const eventsDir = path.join(tmp, 'runtime', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });
  const eventStore = new JsonlEventStore({ eventsDir });

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  createSession(stateStore, 'old-1', SESSION_STATUS.COMPLETED, oldDate);

  const gc = new CheckpointGC({ stateStore, eventStore });
  const result = gc.run({ ttlMs: DEFAULT_TTL_MS });

  assert(result.count === 1, 'one expired session should be deleted');
  assert(result.deleted.length === 1, 'deleted array should have one entry');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 3: dryRun does not delete anything ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  const eventsDir = path.join(tmp, 'runtime', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });
  const eventStore = new JsonlEventStore({ eventsDir });

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const sid = createSession(stateStore, 'dry-1', SESSION_STATUS.COMPLETED, oldDate);

  const gc = new CheckpointGC({ stateStore, eventStore });
  const result = gc.run({ ttlMs: DEFAULT_TTL_MS, dryRun: true });

  assert(result.dryRun === true, 'result should have dryRun=true');
  assert(result.candidates.length === 1, 'should find one candidate');
  assert(result.count === 1, 'count should be 1');

  const sessions = stateStore.listSessions();
  assert(sessions.length === 1, 'dryRun should not delete sessions');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 4: RUNNING sessions are never garbage collected ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  const eventsDir = path.join(tmp, 'runtime', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });
  const eventStore = new JsonlEventStore({ eventsDir });

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  createSession(stateStore, 'running-1', SESSION_STATUS.RUNNING, oldDate);

  const gc = new CheckpointGC({ stateStore, eventStore });
  const result = gc.run({ ttlMs: DEFAULT_TTL_MS });

  assert(result.count === 0, 'RUNNING sessions should never be GCed');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 5: Event log is deleted when session is collected ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  const eventsDir = path.join(tmp, 'runtime', 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });
  const eventStore = new JsonlEventStore({ eventsDir });

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const sid = createSession(stateStore, 'ev-1', SESSION_STATUS.COMPLETED, oldDate);

  eventStore.append({ sessionId: sid, kind: 'stage_start', stage: 'ANALYSE' });
  const evPath = path.join(eventsDir, `${sid}.jsonl`);
  assert(fs.existsSync(evPath), 'event log should exist before GC');

  const gc = new CheckpointGC({ stateStore, eventStore });
  gc.run({ ttlMs: DEFAULT_TTL_MS });

  assert(!fs.existsSync(evPath), 'event log should be deleted after GC');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 6: compact() truncates events before given seq ──
{
  const tmp = createTempDir();
  const eventsDir = path.join(tmp, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const eventStore = new JsonlEventStore({ eventsDir });

  eventStore.append({ sessionId: 'compact-1', kind: 'stage_start', stage: 'ANALYSE' });
  eventStore.append({ sessionId: 'compact-1', kind: 'stage_end', stage: 'ANALYSE' });
  eventStore.append({ sessionId: 'compact-1', kind: 'stage_start', stage: 'PLAN' });
  eventStore.append({ sessionId: 'compact-1', kind: 'stage_end', stage: 'PLAN' });

  const result = eventStore.compact({ sessionId: 'compact-1', beforeSeq: 3 });
  assert(result.success === true, 'compact should succeed');
  assert(result.removed === 2, 'should remove 2 events (seq 1,2)');
  assert(result.kept === 2, 'should keep 2 events (seq 3,4)');

  const remaining = eventStore.readStream({ sessionId: 'compact-1' });
  assert(remaining.length === 2, 'should have 2 events after compact');
  assert(remaining[0].seq === 3, 'first remaining event should be seq 3');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 7: deleteEventLog() removes event file and index entry ──
{
  const tmp = createTempDir();
  const eventsDir = path.join(tmp, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const eventStore = new JsonlEventStore({ eventsDir });

  eventStore.append({ sessionId: 'del-1', kind: 'stage_start', stage: 'ANALYSE' });
  const evPath = path.join(eventsDir, `del-1.jsonl`);
  assert(fs.existsSync(evPath), 'event log should exist');

  const existed = eventStore.deleteEventLog('del-1');
  assert(existed === true, 'deleteEventLog should return true');
  assert(!fs.existsSync(evPath), 'event log file should be removed');

  const index = eventStore._readIndex();
  assert(!index.sessions['del-1'], 'index entry should be removed');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 8: listExpiredSessions() on FileStateStore ──
{
  const tmp = createTempDir();
  const stateDir = path.join(tmp, 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });

  const stateStore = new FileStateStore({ runtimeDir: stateDir });

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  createSession(stateStore, 'exp-1', SESSION_STATUS.COMPLETED, oldDate);
  createSession(stateStore, 'fresh-1', SESSION_STATUS.COMPLETED, new Date().toISOString());

  const expired = stateStore.listExpiredSessions({ ttlMs: DEFAULT_TTL_MS });
  assert(expired.length === 1, 'should find 1 expired session');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 9: compact() with missing session returns gracefully ──
{
  const tmp = createTempDir();
  const eventsDir = path.join(tmp, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const eventStore = new JsonlEventStore({ eventsDir });

  const result = eventStore.compact({ sessionId: 'nonexistent', beforeSeq: 5 });
  assert(result.success === true, 'compact on nonexistent session should succeed');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 10: compact() with invalid input returns error ──
{
  const tmp = createTempDir();
  const eventsDir = path.join(tmp, 'events');
  fs.mkdirSync(eventsDir, { recursive: true });

  const eventStore = new JsonlEventStore({ eventsDir });

  const result = eventStore.compact({});
  assert(result.success === false, 'compact without required params should fail');
  assert(result.error != null, 'should have error message');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(50)}`);
console.log(`CheckpointGC Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}`);

if (failed > 0) process.exit(1);

})();
