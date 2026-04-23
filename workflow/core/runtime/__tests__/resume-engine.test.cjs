'use strict';

(async () => {

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ResumeEngine } = require('../resume-engine');
const { FileStateStore } = require('../file-state-store');
const { CompensationLedger } = require('../compensation-ledger');
const { RESUME_DECISION, COMPENSATION_STATUS, RISK_LEVEL } = require('../types');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resume-engine-test-'));
}

function createStore(projectRoot) {
  const stateDir = path.join(projectRoot, 'output', 'runtime');
  fs.mkdirSync(stateDir, { recursive: true });
  return new FileStateStore({ projectRoot });
}

function createSession(store, sessionId = 'test-session-1') {
  const session = store.createSession({
    projectId: sessionId,
    requirement: 'test',
    requirementFingerprint: 'test-hash',
    mode: 'node',
    initialStage: 'ANALYSE'
  });
  return session.sessionId;
}

function addTaskToSession(store, sessionId, taskId, stage, status, opts = {}) {
  const session = store.loadSession(sessionId);
  if (!session.tasks) session.tasks = {};
  session.tasks[taskId] = {
    taskId, stage, status, subtask: opts.subtask || taskId,
    startedAt: opts.startedAt || new Date().toISOString(),
    idempotencyKey: opts.idempotencyKey || null,
    resultRef: opts.resultRef || null,
    ...(opts.extra || {}),
  };
  if (session.currentStage !== stage) session.currentStage = stage;
  store.saveSession(session);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; console.error(`FAIL: ${message}`); }
}

// ── Test: inspect returns complete ResumeInspection ─────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'completed', { idempotencyKey: 'ik-1', resultRef: 'output/analyse-result.json' });
  addTaskToSession(store, sid, 't2', 'ARCHITECT', 'running');

  const insp = engine.inspect(sid);
  assert(insp.sessionId === sid, 'inspect sessionId');
  assert(insp.currentStage === 'ARCHITECT', 'inspect currentStage');
  assert(insp.unfinishedOperations.length === 1, 'one unfinished operation');
  assert(insp.unfinishedOperations[0].taskId === 't2', 'unfinished is t2');
  assert(insp.reusableResults['t1'] !== undefined, 't1 is reusable');
  assert(insp.riskLevel === RISK_LEVEL.MEDIUM, 'riskLevel is medium');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: inspect with pending compensations ────────────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ ledgerDir: path.join(tmp, 'compensation') });
  const engine = new ResumeEngine({ stateStore: store, compensationLedger: ledger });

  engine.ledger.register({ sessionId: sid, stage: 'ANALYSE', taskId: 't1', actionType: 'DELETE_ARTIFACT' });
  engine.ledger.register({ sessionId: sid, stage: 'ANALYSE', taskId: 't2', actionType: 'CLEAR_STAGE_CTX' });

  const insp = engine.inspect(sid);
  assert(insp.pendingCompensations.length === 2, 'two pending compensations detected');
  assert(insp.riskLevel === RISK_LEVEL.HIGH, 'riskLevel is high with compensations');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: buildPlan REPLAY_SAFE (all completed + idempotency) ───────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'completed', { idempotencyKey: 'ik-1', resultRef: 'output/analyse.json' });
  addTaskToSession(store, sid, 't2', 'ARCHITECT', 'completed', { idempotencyKey: 'ik-2', resultRef: 'output/architect.json' });

  const plan = engine.buildPlan(sid);
  assert(plan.decision === RESUME_DECISION.REPLAY_SAFE, 'decision is REPLAY_SAFE');
  assert(plan.operationsToSkip.length === 2, 'both tasks skipped');
  assert(plan.operationsToReplay.length === 0, 'no tasks to replay');
  assert(plan.why.includes('idempotent'), 'why explains safe replay');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: buildPlan SUBTASK_RETRY (partial failure) ────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'completed', { idempotencyKey: 'ik-1', resultRef: 'output/analyse.json' });
  addTaskToSession(store, sid, 't2', 'ARCHITECT', 'running');

  const plan = engine.buildPlan(sid);
  assert(plan.decision === RESUME_DECISION.SUBTASK_RETRY, 'decision is SUBTASK_RETRY');
  assert(plan.operationsToReplay.includes('t2'), 't2 needs replay');
  assert(plan.operationsToSkip.includes('t1'), 't1 is skipped');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: buildPlan COMPENSATE_THEN_RETRY (pending compensation + unfinished) ──
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ ledgerDir: path.join(tmp, 'compensation') });
  const engine = new ResumeEngine({ stateStore: store, compensationLedger: ledger });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'completed', { idempotencyKey: 'ik-1' });
  addTaskToSession(store, sid, 't2', 'ARCHITECT', 'running');
  engine.ledger.register({ sessionId: sid, stage: 'ANALYSE', taskId: 't1', actionType: 'DELETE_ARTIFACT' });

  const plan = engine.buildPlan(sid);
  assert(plan.decision === RESUME_DECISION.COMPENSATE_THEN_RETRY, 'decision is COMPENSATE_THEN_RETRY');
  assert(plan.compensationsToRun.length === 1, 'one compensation to run');
  assert(plan.operationsToReplay.includes('t2'), 't2 needs replay after compensation');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: buildPlan ABORT (critical inconsistency) ──────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  // Simulate critical inconsistency: session failed without rollback
  const session = store.loadSession(sid);
  session.status = 'failed';
  store.saveSession(session);

  const plan = engine.buildPlan(sid);
  assert(plan.decision === RESUME_DECISION.ABORT, 'decision is ABORT for failed session without rollback');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: canResume returns false for critical risk ─────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  const session = store.loadSession(sid);
  session.status = 'failed';
  store.saveSession(session);

  const { resumable, reason } = engine.canResume(sid);
  assert(resumable === false, 'not resumable for failed session');
  assert(reason.length > 0, 'reason provided');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: canResume returns true for recoverable session ────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'running');

  const { resumable } = engine.canResume(sid);
  assert(resumable === true, 'resumable for running session');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: markBlocked writes blocked state ──────────────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  engine.markBlocked(sid, 'Manual intervention required');

  const session = store.loadSession(sid);
  assert(session.recovery.resumeState === 'blocked', 'resumeState is blocked');
  assert(session.recovery.blockedReason === 'Manual intervention required', 'blockedReason preserved');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: registerCompensation dual-layer ───────────────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const ledger = new CompensationLedger({ ledgerDir: path.join(tmp, 'compensation') });
  const engine = new ResumeEngine({ stateStore: store, compensationLedger: ledger });

  let closureCalled = false;
  const mockSaga = {
    addCompensation(label, fn) { closureCalled = true; },
  };

  const desc = engine.registerCompensation(sid, {
    stage: 'ANALYSE', taskId: 't1', actionType: 'DELETE_ARTIFACT',
    args: { filePath: '/tmp/x.md' }, closure: () => 'compensated',
  }, mockSaga);

  assert(desc.compensationId.startsWith('comp-'), 'durable descriptor created');
  assert(desc.actionType === 'DELETE_ARTIFACT', 'actionType in durable descriptor');
  assert(closureCalled === true, 'SagaContext closure registered');

  // Verify durable survives crash
  const store2 = createStore(tmp);
  const ledger2 = new CompensationLedger({ ledgerDir: path.join(tmp, 'compensation') });
  const engine2 = new ResumeEngine({ stateStore: store2, compensationLedger: ledger2 });
  const pending = engine2.ledger.listPending(sid);
  assert(pending.length === 1, 'durable descriptor survives restart');
  assert(pending[0].actionType === 'DELETE_ARTIFACT', 'actionType survives restart');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: resume executes plan with REPLAY_SAFE ────────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  addTaskToSession(store, sid, 't1', 'ANALYSE', 'completed', { idempotencyKey: 'ik-1', resultRef: 'output/analyse.json' });

  const result = await engine.resume(sid);
  assert(result.plan.decision === RESUME_DECISION.REPLAY_SAFE, 'resume plan is REPLAY_SAFE');
  assert(result.skipped.includes('t1'), 't1 is in skipped list');
  assert(result.compensationResult.completed === 0, 'no compensations executed');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test: resume with ABORT marks blocked ───────────────────────────────────────
{
  const tmp = createTempDir();
  const store = createStore(tmp);
  const sid = createSession(store);
  const engine = new ResumeEngine({ stateStore: store });

  const session = store.loadSession(sid);
  session.status = 'failed';
  store.saveSession(session);

  const result = await engine.resume(sid);
  assert(result.plan.decision === RESUME_DECISION.ABORT, 'resume plan is ABORT');

  const updated = store.loadSession(sid);
  assert(updated.recovery.resumeState === 'blocked', 'session marked as blocked');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Summary ─────────────────────────────────────────────────────────────────────
console.error(`\nResumeEngine Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
