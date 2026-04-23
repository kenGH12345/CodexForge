'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');

const { ResumeEngine } = require('../../core/runtime/resume-engine');
const { CompensationLedger } = require('../../core/runtime/compensation-ledger');
const { FileStateStore } = require('../../core/runtime/file-state-store');
const { RuntimeEventStore } = require('../../core/runtime/runtime-event-store');
const { JsonlEventStore } = require('../../core/runtime/jsonl-event-store');
const {
  EVENT_KINDS,
  SESSION_STATUS,
  STAGE_STATUS,
  TASK_STATUS,
  RESUME_DECISION,
  RISK_LEVEL,
  COMPENSATION_STATUS,
} = require('../../core/runtime/types');

describe('CompensationLedger', () => {
  const TEST_DIR = path.join(process.cwd(), 'output', 'test-runtime');
  let ledger;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    ledger = new CompensationLedger({ ledgerDir: path.join(TEST_DIR, 'compensation') });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('register', () => {
    it('should create and return a compensation descriptor', () => {
      const desc = ledger.register({
        sessionId: 'test-session',
        stage: 'DEVELOP',
        taskId: 'task-1',
        actionType: 'DELETE_ARTIFACT',
        args: { path: '/tmp/test.txt' },
      });

      assert.strictEqual(desc.sessionId, 'test-session');
      assert.strictEqual(desc.stage, 'DEVELOP');
      assert.strictEqual(desc.actionType, 'DELETE_ARTIFACT');
      assert.strictEqual(desc.status, COMPENSATION_STATUS.PENDING);
      assert.ok(desc.compensationId.startsWith('comp-'));
      assert.ok(desc.idempotencyKey.includes('test-session'));
    });

    it('should persist descriptor to ledger file', () => {
      ledger.register({
        sessionId: 'test-session',
        stage: 'DEVELOP',
        taskId: 'task-1',
        actionType: 'DELETE_ARTIFACT',
        args: { path: '/tmp/test.txt' },
      });

      const pending = ledger.getPending('test-session');
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].actionType, 'DELETE_ARTIFACT');
    });
  });

  describe('getPending', () => {
    it('should return only pending compensations', () => {
      ledger.register({ sessionId: 's1', stage: 'S1', taskId: 't1', actionType: 'DELETE_ARTIFACT', args: {} });
      ledger.register({ sessionId: 's1', stage: 'S1', taskId: 't2', actionType: 'CLEAR_STAGE_CTX', args: {} });

      const all = ledger.getAll('s1');
      assert.strictEqual(all.length, 2);

      const pending = ledger.getPending('s1');
      assert.strictEqual(pending.length, 2);
    });

    it('should return empty array for non-existent session', () => {
      const pending = ledger.getPending('non-existent');
      assert.deepStrictEqual(pending, []);
    });
  });

  describe('execute', () => {
    it('should execute DELETE_ARTIFACT handler', async () => {
      const testFile = path.join(TEST_DIR, 'to-delete.txt');
      fs.writeFileSync(testFile, 'test content');

      ledger.register({
        sessionId: 's1',
        stage: 'S1',
        taskId: 't1',
        actionType: 'DELETE_ARTIFACT',
        args: { path: testFile },
      });

      const result = await ledger.execute('s1');
      assert.strictEqual(result.completed, 1);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(fs.existsSync(testFile), false);
    });

    it('should skip when handler returns skip flag', async () => {
      ledger.register({
        sessionId: 's1',
        stage: 'S1',
        taskId: 't1',
        actionType: 'ROLLBACK_GIT_BRANCH',
        args: {},
      });

      const result = await ledger.execute('s1');
      assert.strictEqual(result.skipped, 1);
    });

    it('should fail when no handler exists', async () => {
      ledger.register({
        sessionId: 's1',
        stage: 'S1',
        taskId: 't1',
        actionType: 'UNKNOWN_ACTION',
        args: {},
      });

      const result = await ledger.execute('s1');
      assert.strictEqual(result.failed, 1);
      assert.strictEqual(result.errors.length, 1);
    });
  });

  describe('clear', () => {
    it('should remove ledger file', () => {
      ledger.register({ sessionId: 's1', stage: 'S1', taskId: 't1', actionType: 'DELETE_ARTIFACT', args: {} });

      ledger.clear('s1');

      const pending = ledger.getAll('s1');
      assert.strictEqual(pending.length, 0);
    });
  });
});

describe('ResumeEngine', () => {
  const TEST_DIR = path.join(process.cwd(), 'output', 'test-runtime');
  let stateStore;
  let eventStore;
  let ledger;
  let engine;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }

    const eventFilePath = path.join(TEST_DIR, 'events.jsonl');
    const jsonlStore = new JsonlEventStore(eventFilePath);

    stateStore = new FileStateStore({ runtimeDir: TEST_DIR });
    eventStore = new RuntimeEventStore({
      backingStore: jsonlStore,
      sessionId: 'test-session',
    });
    ledger = new CompensationLedger({ ledgerDir: path.join(TEST_DIR, 'compensation') });

    engine = new ResumeEngine({
      stateStore,
      eventStore,
      compensationLedger: ledger,
    });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  function createTestSession(sessionId, status = SESSION_STATUS.FAILED) {
    return stateStore.createSession({
      sessionId,
      requirement: 'Test requirement',
      requirementFingerprint: 'abc123',
      mode: 'orchestrator',
      initialStage: 'DEVELOP',
    });
  }

  describe('inspect', () => {
    it('should return null for non-existent session', () => {
      const inspection = engine.inspect('non-existent');
      assert.strictEqual(inspection, null);
    });

    it('should return inspection with session info', () => {
      const session = createTestSession('s1');
      const inspection = engine.inspect(session.sessionId);

      assert.ok(inspection);
      assert.strictEqual(inspection.sessionId, session.sessionId);
      assert.strictEqual(inspection.currentStage, 'DEVELOP');
      assert.ok(Array.isArray(inspection.unfinishedOperations));
      assert.ok(Array.isArray(inspection.pendingCompensations));
      assert.ok(Array.isArray(inspection.inconsistencies));
      assert.ok(['low', 'medium', 'high', 'critical'].includes(inspection.riskLevel));
    });

    it('should detect unfinished operations', () => {
      const session = createTestSession('s1');

      // Add a running task
      stateStore.beginTask({
        taskId: 'task-1',
        stage: 'DEVELOP',
        subtask: 'coding',
        idempotencyKey: 'dev-1',
      });

      const inspection = engine.inspect(session.sessionId);
      assert.strictEqual(inspection.unfinishedOperations.length, 1);
      assert.strictEqual(inspection.unfinishedOperations[0].taskId, 'task-1');
    });
  });

  describe('buildPlan', () => {
    it('should return null for non-existent session', () => {
      const plan = engine.buildPlan('non-existent');
      assert.strictEqual(plan, null);
    });

    it('should create ABORT plan for critical risk', () => {
      const session = createTestSession('s1', SESSION_STATUS.FAILED);

      // Mark with systemic failure to trigger high risk
      stateStore.markRollback({
        sessionId: session.sessionId,
        stage: 'DEVELOP',
        rollbackInfo: { error: new Error('OOM: out of memory') },
      });

      const plan = engine.buildPlan(session.sessionId);
      assert.ok(plan);
      assert.strictEqual(plan.sessionId, session.sessionId);
      assert.ok(plan.planId.startsWith('plan-'));
      assert.ok(plan.why);
    });

    it('should create COMPENSATE_THEN_RETRY plan with pending compensations', () => {
      const session = createTestSession('s1', SESSION_STATUS.FAILED);

      // Add pending compensation
      ledger.register({
        sessionId: session.sessionId,
        stage: 'DEVELOP',
        taskId: 'task-1',
        actionType: 'DELETE_ARTIFACT',
        args: { path: '/tmp/test.txt' },
      });

      const plan = engine.buildPlan(session.sessionId);
      assert.ok(plan);
      assert.strictEqual(plan.compensationsToRun.length, 1);
    });

    it('should include operationsToSkip for reusable results', () => {
      const session = createTestSession('s1', SESSION_STATUS.FAILED);

      // Add completed task with result ref
      stateStore.beginTask({
        taskId: 'task-1',
        stage: 'DEVELOP',
        subtask: 'coding',
        idempotencyKey: 'dev-1',
      });
      stateStore.completeTask({
        taskId: 'task-1',
        resultRef: { path: 'output/file.js' },
      });

      // Add running task
      stateStore.beginTask({
        taskId: 'task-2',
        stage: 'DEVELOP',
        subtask: 'testing',
        idempotencyKey: 'dev-2',
      });

      const plan = engine.buildPlan(session.sessionId);
      assert.strictEqual(plan.operationsToSkip.includes('task-1'), true);
      assert.strictEqual(plan.operationsToReplay.includes('task-2'), true);
    });
  });

  describe('canResume', () => {
    it('should return false for non-existent session', () => {
      const result = engine.canResume('non-existent');
      assert.strictEqual(result.canResume, false);
      assert.ok(result.reason);
    });

    it('should return true for recoverable session', () => {
      const session = createTestSession('s1', SESSION_STATUS.FAILED);

      // Add a running task to make it recoverable
      stateStore.beginTask({
        taskId: 'task-1',
        stage: 'DEVELOP',
        subtask: 'coding',
        idempotencyKey: 'dev-1',
      });

      const result = engine.canResume(session.sessionId);
      assert.strictEqual(result.canResume, true);
      assert.strictEqual(result.reason, null);
    });

    it('should return false when no unfinished operations', () => {
      const session = createTestSession('s1', SESSION_STATUS.COMPLETED);

      const result = engine.canResume(session.sessionId);
      assert.strictEqual(result.canResume, false);
      assert.ok(result.reason.includes('No unfinished'));
    });
  });

  describe('resume', () => {
    it('should return error for non-existent session', async () => {
      const result = await engine.resume('non-existent');
      assert.strictEqual(result.success, false);
      assert.ok(result.error.includes('not found'));
    });

    it('should execute compensation and update session', async () => {
      const session = createTestSession('s1', SESSION_STATUS.FAILED);

      ledger.register({
        sessionId: session.sessionId,
        stage: 'DEVELOP',
        taskId: 'task-1',
        actionType: 'DELETE_ARTIFACT',
        args: { path: '/tmp/non-existent.txt' },
      });

      const result = await engine.resume(session.sessionId);

      // Even though DELETE_ARTIFACT file doesn't exist, it should succeed (idempotent)
      assert.strictEqual(result.success, true);
      assert.ok(result.plan);
      assert.strictEqual(result.error, null);
    });
  });

  describe('markBlocked', () => {
    it('should mark session as blocked', () => {
      const session = createTestSession('s1');
      const result = engine.markBlocked(session.sessionId, 'Manual intervention required');

      assert.strictEqual(result, true);

      const updated = stateStore.loadSession(session.sessionId);
      assert.strictEqual(updated.recovery.blockedReason, 'Manual intervention required');
      assert.strictEqual(updated.recovery.recoverable, false);
    });

    it('should return false for non-existent session', () => {
      const result = engine.markBlocked('non-existent', 'Test');
      assert.strictEqual(result, false);
    });
  });
});
