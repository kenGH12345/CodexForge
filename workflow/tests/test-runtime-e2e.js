'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  FileStateStore,
  JsonlEventStore,
  RuntimeEventStore,
  RuntimeProjector,
  validateStateManager,
  validateEventStore,
  SCHEMA_VERSION,
  SESSION_STATUS,
} = require('../core/runtime');

let pass = 0;
let fail = 0;
const tmpDirs = [];

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-e2e-'));
  tmpDirs.push(d);
  return d;
}

function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✅ PASS: ${msg}`); }
  else { fail++; console.log(`  ❌ FAIL: ${msg}`); }
}

function cleanup() {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
}

process.on('exit', () => {
  cleanup();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Runtime E2E Integration Tests: ${pass} passed, ${fail} failed`);
  console.log(`${'═'.repeat(60)}`);
  if (fail > 0) process.exitCode = 1;
});

async function run() {
  const dir1 = tmpDir();
  const dir2 = tmpDir();

  console.log('\n── A. Full Session Lifecycle (AC-1) ─────────────────────\n');

  const stateManager = new FileStateStore({ runtimeDir: dir1 });
  const backingStore = new JsonlEventStore({ dir: dir2 });
  const runtimeES = new RuntimeEventStore({ backingStore, sessionId: null });

  const sessionResult = stateManager.createSession({
    projectId: 'e2e-test',
    requirement: 'Test StateManager + EventStore E2E',
  });
  const sessionId = sessionResult.sessionId;
  assert(sessionId && typeof sessionId === 'string', 'createSession returns session ID');

  let session = stateManager.loadSession(sessionId);
  assert(session.currentStage === null, 'initial stage is null');
  assert(session.status === SESSION_STATUS.CREATED, 'initial status is CREATED');

  stateManager.beginStage({ sessionId, stage: 'ANALYSE', stageInput: 'analyzing requirements' });
  session = stateManager.loadSession(sessionId);
  assert(session.currentStage === 'ANALYSE', 'stage transitions to ANALYSE');
  assert(session.stages.ANALYSE.status === 'running', 'ANALYSE stage is running');

  const taskId = 'T-01-' + crypto.randomBytes(4).toString('hex');
  const taskResult = stateManager.beginTask({ taskId, stage: 'ANALYSE', subtask: 'decompose' });
  assert(taskResult && taskResult.taskId === taskId, 'beginTask returns task with ID');

  stateManager.completeTask({ taskId });
  session = stateManager.loadSession(sessionId);
  assert(session.tasks[taskId].status === 'completed', 'task status is completed');

  stateManager.completeStage({ stage: 'ANALYSE', outputRefs: ['output/requirement.md'] });
  session = stateManager.loadSession(sessionId);
  assert(session.stages.ANALYSE.status === 'completed', 'ANALYSE stage completed');
  assert(session.stages.ANALYSE.outputRefs.length === 1, 'output refs recorded');

  console.log('\n── B. Checkpoint & Crash Recovery (AC-2) ────────────────\n');

  const cp = stateManager.saveCheckpoint({ sessionId, stage: 'ANALYSE' });
  assert(cp.checkpointId && cp.snapshot !== undefined, 'saveCheckpoint returns checkpoint with snapshot');
  assert(cp.snapshot.stages.ANALYSE.status === 'completed', 'checkpoint captures completed stage');

  stateManager.beginStage({ sessionId, stage: 'ARCHITECT', stageInput: 'designing' });
  const cp2 = stateManager.saveCheckpoint({ sessionId, stage: 'ARCHITECT' });
  assert(cp2.checkpointId !== cp.checkpointId, 'second checkpoint has different ID');

  const freshSM = new FileStateStore({ runtimeDir: dir1 });
  const recoveredSession = freshSM.loadSession(sessionId);
  assert(recoveredSession !== null, 'session loadable after simulated crash');
  assert(recoveredSession.currentStage === 'ARCHITECT', 'recovered stage is ARCHITECT');
  assert(recoveredSession.stages.ANALYSE.status === 'completed', 'previous stage preserved after crash');

  console.log('\n── C. Event Store Consistency (AC-3) ────────────────────\n');

  runtimeES.append({ sessionId, kind: 'stage_started', stage: 'ANALYSE', payload: {} });
  runtimeES.append({ sessionId, kind: 'task_completed', stage: 'ANALYSE', payload: { taskId } });
  runtimeES.append({ sessionId, kind: 'stage_completed', stage: 'ANALYSE', payload: {} });

  const events = runtimeES.query({ sessionId });
  assert(events.length >= 3, `event store has ${events.length} events (>=3)`);

  const stagedEvents = runtimeES.query({ sessionId, stage: 'ANALYSE' });
  assert(stagedEvents.length >= 2, `ANALYSE stage events: ${stagedEvents.length} (>=2)`);

  console.log('\n── D. Compatibility Projection (AC-4) ───────────────────\n');

  const projector = new RuntimeProjector(stateManager, runtimeES);
  const manifest = projector.projectManifest(sessionId);
  assert(manifest !== null, 'projectManifest returns data');
  assert(manifest.meta.sessionId === sessionId, 'manifest sessionId matches');
  assert(typeof manifest.currentState === 'string', 'manifest has currentState');

  const workflowStatus = projector.projectWorkflowStatus(sessionId);
  assert(workflowStatus !== null, 'projectWorkflowStatus returns data');
  assert(workflowStatus.activeWorkflow !== undefined, 'has activeWorkflow');
  assert(workflowStatus.activeWorkflow.session === sessionId, 'activeWorkflow session matches');
  assert(Array.isArray(workflowStatus.activeWorkflow.completedStages), 'completedStages is array');
  assert(workflowStatus.activeWorkflow.completedStages.includes('ANALYSE'), 'ANALYSE in completedStages');
  assert(typeof workflowStatus.activeWorkflow.stageStartTime === 'string', 'stageStartTime is string');

  const healthTrace = projector.projectHealthTrace(sessionId);
  assert(Array.isArray(healthTrace), 'projectHealthTrace returns array');
  assert(healthTrace.length > 0, 'healthTrace has entries');

  console.log('\n── E. Concurrent Write Conflict (AC-5) ───────────────────\n');

  const conflictDir = tmpDir();
  const sm1 = new FileStateStore({ runtimeDir: conflictDir });
  const sm2 = new FileStateStore({ runtimeDir: conflictDir });

  const cSessionResult = sm1.createSession({ projectId: 'conflict-test', requirement: 'test' });
  const cSessionId = cSessionResult.sessionId;

  sm1.beginStage({ sessionId: cSessionId, stage: 'ANALYSE', stageInput: '' });
  const s1 = sm1.loadSession(cSessionId);
  const s2 = sm2.loadSession(cSessionId);
  assert(s1.version === s2.version, 'both see same initial version');

  sm1.completeStage({ stage: 'ANALYSE' });
  const afterWrite = sm1.loadSession(cSessionId);
  assert(afterWrite.stages.ANALYSE.status === 'completed', 'sm1 write persists to file');
  assert(afterWrite.version > s1.version, 'version advances after write');

  console.log('\n── F. Contract Validation (AC-6) ──────────────────────\n');

  const smResult = validateStateManager(stateManager);
  assert(smResult.pass, 'FileStateStore passes contract validation');

  const esResult = validateEventStore(runtimeES);
  assert(esResult.pass, 'RuntimeEventStore passes contract validation');

  console.log('');
}

run().catch(e => {
  console.error('E2E test error:', e);
  fail++;
});
