'use strict';

const crypto = require('crypto');
const { CompensationLedger } = require('./compensation-ledger');
const {
  EVENT_KINDS,
  SESSION_STATUS,
  STAGE_STATUS,
  TASK_STATUS,
  RESUME_DECISION,
  RISK_LEVEL,
} = require('./types');

/**
 * ResumeEngine - Unified recovery orchestration layer.
 *
 * Problem it solves:
 *   Previously, recovery ability was scattered across RollbackCoordinator,
 *   IdempotencyJournal, and SagaContext. Each handled a fragment:
 *   - RollbackCoordinator: how to rollback cleanly
 *   - IdempotencyJournal: skip duplicate operations
 *   - SagaContext: in-process compensation (not durable)
 *
 * This engine provides a unified recovery orchestration:
 *   1. inspect()        - Read state + events to understand current situation
 *   2. buildPlan()      - Generate explicit ResumePlan with decision
 *   3. resume()         - Execute recovery based on plan
 *   4. canResume()      - Boolean check if recovery is possible
 *   5. markBlocked()    - Explicitly mark session as blocked with reason
 *
 * All recovery decisions are made from durable sources:
 *   - FileStateStore for current state and checkpoints
 *   - RuntimeEventStore for event timeline
 *   - CompensationLedger for durable compensation metadata
 *
 * See ADR-20260417-01: Runtime Layer uses event-first write protocol.
 */
class ResumeEngine {
  /**
   * @param {Object} options
   * @param {import('./file-state-store').FileStateStore} options.stateStore
   * @param {import('./runtime-event-store').RuntimeEventStore} options.eventStore
   * @param {CompensationLedger} [options.compensationLedger] - Optional ledger instance
   */
  constructor(options = {}) {
    this._stateStore = options.stateStore;
    this._eventStore = options.eventStore;
    this._compensationLedger = options.compensationLedger || null;
  }

  /**
   * Expose compensation ledger for direct access.
   * @returns {CompensationLedger|null}
   */
  get ledger() {
    return this._compensationLedger;
  }

  /**
   * Inspect a session to determine recovery status.
   * Reads session state, checkpoint, event timeline, and pending compensations.
   *
   * @param {string} sessionId
   * @returns {ResumeInspection|null} Inspection result or null if session not found
   */
  inspect(sessionId) {
    if (!this._stateStore) {
      throw new Error('stateStore is required for inspection');
    }

    const session = this._stateStore.loadSession(sessionId);
    if (!session) return null;

    const checkpoint = this._stateStore.getLatestCheckpoint?.(sessionId) || null;
    const events = this._eventStore
      ? this._eventStore.query({ sessionId, limit: 1000 })
      : [];

    const lastEventSeq = events.length > 0 ? Math.max(...events.map(e => e.seq)) : 0;

    const unfinishedOperations = this._findUnfinishedOperations(session);
    const pendingCompensations = this._compensationLedger
      ? this._compensationLedger.getPending(sessionId)
      : [];

    const reusableResults = this._findReusableResults(session, events);
    const inconsistencies = this._detectInconsistencies(session, events, checkpoint);
    const riskLevel = this._assessRiskLevel(session, pendingCompensations, inconsistencies, unfinishedOperations);

    return {
      sessionId,
      currentStage: session.currentStage,
      lastCheckpoint: checkpoint,
      lastEventSeq,
      unfinishedOperations,
      pendingCompensations,
      reusableResults,
      inconsistencies,
      riskLevel,
    };
  }

  /**
   * Build a recovery plan for a session.
   * Determines whether to replay, rollback, compensate, or abort.
   *
   * @param {string} sessionId
   * @returns {ResumePlan|null} Recovery plan or null if session not found
   */
  buildPlan(sessionId) {
    const inspection = this.inspect(sessionId);
    if (!inspection) return null;

    const session = this._stateStore?.loadSession(sessionId);
    if (!session) return null;

    const { unfinishedOperations, pendingCompensations, reusableResults, inconsistencies, riskLevel } = inspection;

    // HIGH/CRITICAL risk with inconsistencies -> ABORT
    if (riskLevel === RISK_LEVEL.CRITICAL || (riskLevel === RISK_LEVEL.HIGH && inconsistencies.length > 0)) {
      return this._createPlan(sessionId, {
        decision: RESUME_DECISION.ABORT,
        why: `Critical inconsistencies detected: ${inconsistencies.map(i => i.detail).join('; ')}`,
        riskLevel,
      });
    }

    // Failed session without recovery path -> ABORT
    if (session.status === SESSION_STATUS.FAILED && !session.recovery?.recoverable) {
      return this._createPlan(sessionId, {
        decision: RESUME_DECISION.ABORT,
        why: 'Session failed without recovery path',
        riskLevel,
      });
    }

    // Pending compensations -> need to compensate first
    if (pendingCompensations.length > 0) {
      const lastFailedTask = unfinishedOperations.find(op => op.status === TASK_STATUS.FAILED);
      return this._createPlan(sessionId, {
        decision: RESUME_DECISION.COMPENSATE_THEN_RETRY,
        resumeFromStage: lastFailedTask?.stage || session.currentStage,
        resumeFromTaskId: lastFailedTask?.taskId || null,
        compensationsToRun: pendingCompensations,
        operationsToSkip: Object.keys(reusableResults),
        operationsToReplay: unfinishedOperations
          .filter(op => !reusableResults[op.taskId])
          .map(op => op.taskId),
        why: `${pendingCompensations.length} pending compensation(s) must run before resuming`,
        riskLevel,
      });
    }

    // Check for systemic failure patterns
    const hasSystemicFailure = this._detectSystemicFailure(session);

    if (hasSystemicFailure) {
      return this._createPlan(sessionId, {
        decision: RESUME_DECISION.FULL_STAGE_ROLLBACK,
        resumeFromStage: this._getRollbackTarget(session.currentStage),
        operationsToSkip: [],
        operationsToReplay: [],
        why: 'Systemic failure detected (timeout, OOM, etc.) - full rollback required',
        riskLevel: RISK_LEVEL.HIGH,
      });
    }

    // Has reusable results -> can skip some operations
    const reusableTaskIds = Object.keys(reusableResults);
    if (reusableTaskIds.length > 0 && unfinishedOperations.length > 0) {
      const failedTask = unfinishedOperations.find(op => op.status === TASK_STATUS.FAILED || op.status === TASK_STATUS.RUNNING);
      if (failedTask) {
        return this._createPlan(sessionId, {
          decision: RESUME_DECISION.SUBTASK_RETRY,
          resumeFromStage: failedTask.stage,
          resumeFromTaskId: failedTask.taskId,
          operationsToSkip: reusableTaskIds,
          operationsToReplay: [failedTask.taskId],
          why: `${reusableTaskIds.length} task(s) have reusable results; only failed/running tasks need retry`,
          riskLevel: RISK_LEVEL.LOW,
        });
      }
    }

    // Safe replay mode
    const firstUnfinished = unfinishedOperations[0];
    return this._createPlan(sessionId, {
      decision: RESUME_DECISION.REPLAY_SAFE,
      resumeFromStage: firstUnfinished?.stage || session.currentStage,
      resumeFromTaskId: firstUnfinished?.taskId || null,
      operationsToSkip: reusableTaskIds,
      operationsToReplay: unfinishedOperations.map(op => op.taskId),
      why: 'Replay from last checkpoint with idempotent execution',
      riskLevel: RISK_LEVEL.LOW,
    });
  }

  /**
   * Execute recovery for a session based on the generated plan.
   *
   * @param {string} sessionId
   * @returns {Promise<{success:boolean,plan:ResumePlan|null,error:string|null}>}
   */
  async resume(sessionId) {
    const plan = this.buildPlan(sessionId);
    if (!plan) {
      return { success: false, plan: null, error: 'Session not found', skipped: [], compensationResult: null };
    }

    if (plan.decision === RESUME_DECISION.ABORT) {
      await this.markBlocked(sessionId, plan.why);
      await this._emitEvent(sessionId, EVENT_KINDS.RESUME_BLOCKED, {
        reason: plan.why,
        riskLevel: plan.riskLevel,
      });
      return {
        success: false,
        plan,
        error: `Recovery aborted: ${plan.why}`,
        skipped: [],
        compensationResult: null,
      };
    }

    // Emit resume started
    await this._emitEvent(sessionId, EVENT_KINDS.RESUME_STARTED, {
      planId: plan.planId,
      decision: plan.decision,
      resumeFromStage: plan.resumeFromStage,
    });

    try {
      // Execute compensations if needed
      let compensationResult = null;
      if (plan.compensationsToRun?.length > 0 && this._compensationLedger) {
        compensationResult = await this._compensationLedger.execute(sessionId);
        if (compensationResult.failed > 0) {
          // Some compensations failed - this is serious
          await this.markBlocked(sessionId, `Compensation failed: ${compensationResult.errors.map(e => e.message).join('; ')}`);
          return {
            success: false,
            plan,
            error: 'Compensation execution failed',
            skipped: [],
            compensationResult,
          };
        }
      }

      // Update session state for retry
      const session = this._stateStore.loadSession(sessionId);
      if (session) {
        session.recovery.pendingRetry = true;
        session.recovery.nextRetryStage = plan.resumeFromStage;
        session.recovery.resumeState = plan.decision;
        session.status = SESSION_STATUS.PAUSED;
        this._stateStore.saveSession?.(session) || this._stateStore._saveUpdated?.(session);
      }

      // Emit resume completed
      await this._emitEvent(sessionId, EVENT_KINDS.RESUME_COMPLETED, {
        planId: plan.planId,
        decision: plan.decision,
        operationsToSkip: plan.operationsToSkip,
        operationsToReplay: plan.operationsToReplay,
      });

      return {
        success: true,
        plan,
        error: null,
        skipped: plan.operationsToSkip || [],
        compensationResult: compensationResult || { completed: 0, failed: 0, skipped: 0, errors: [] },
      };
    } catch (err) {
      await this._emitEvent(sessionId, EVENT_KINDS.RESUME_BLOCKED, {
        planId: plan.planId,
        error: err.message,
      });
      return {
        success: false,
        plan,
        error: err.message,
        skipped: [],
        compensationResult: null,
      };
    }
  }

  /**
   * Check if a session can be resumed.
   * Quick boolean check without building full plan.
   *
   * @param {string} sessionId
   * @returns {{canResume:boolean,reason:string|null}}
   */
  canResume(sessionId) {
    const inspection = this.inspect(sessionId);
    if (!inspection) {
      return { canResume: false, resumable: false, reason: 'Session not found' };
    }

    if (inspection.riskLevel === RISK_LEVEL.CRITICAL) {
      return { canResume: false, resumable: false, reason: 'Critical risk level' };
    }

    const hasUnfinished = inspection.unfinishedOperations.length > 0;
    const isFailed = inspection.inconsistencies.some(i => i.type === 'STAGE_FAILED');

    if (!hasUnfinished && !isFailed) {
      return { canResume: false, resumable: false, reason: 'No unfinished operations to resume' };
    }

    return { canResume: true, resumable: true, reason: null };
  }

  /**
   * Mark a session as blocked with a specific reason.
   * Used when automatic recovery is not possible or safe.
   *
   * @param {string} sessionId
   * @param {string} reason
   * @returns {boolean} Success
   */
  markBlocked(sessionId, reason) {
    const session = this._stateStore?.loadSession(sessionId);
    if (!session) return false;

    if (!session.recovery) {
      session.recovery = {};
    }
    session.recovery.recoverable = false;
    session.recovery.blockedReason = reason;
    session.recovery.blockedAt = new Date().toISOString();
    session.recovery.resumeState = 'blocked';
    session.status = SESSION_STATUS.FAILED;

    this._stateStore.saveSession?.(session) || this._stateStore._saveUpdated?.(session);

    this._emitEvent(sessionId, EVENT_KINDS.RESUME_BLOCKED, {
      reason,
      previousState: session.recovery.resumeState,
    });

    return true;
  }

  /**
   * Register a compensation action for crash recovery.
   * Dual-layer registration: durable ledger + saga closure.
   *
   * @param {string} sessionId
   * @param {Object} descriptor - Compensation descriptor
   * @param {string} descriptor.stage
   * @param {string} descriptor.taskId
   * @param {string} descriptor.actionType - e.g. 'DELETE_ARTIFACT', 'CLEAR_STAGE_CTX'
   * @param {Object} descriptor.args - Serializable arguments
   * @param {Function} [descriptor.closure] - Optional in-process closure for SagaContext
   * @param {Object} [sagaContext] - Optional SagaContext to register closure
   * @returns {CompensationDescriptor} The registered descriptor
   */
  registerCompensation(sessionId, descriptor, sagaContext = null) {
    if (!this._compensationLedger) {
      throw new Error('compensationLedger is required for registration');
    }

    const { stage, taskId, actionType, args, closure } = descriptor;

    const durableDesc = this._compensationLedger.register({
      sessionId,
      stage,
      taskId,
      actionType,
      args,
    });

    if (sagaContext && closure && typeof closure === 'function') {
      sagaContext.addCompensation(`${actionType}:${taskId}`, closure);
    }

    return durableDesc;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Helper methods
  // ───────────────────────────────────────────────────────────────────────────

  _findUnfinishedOperations(session) {
    const unfinished = [];
    for (const [taskId, task] of Object.entries(session.tasks || {})) {
      if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.FAILED) {
        unfinished.push({
          taskId,
          stage: task.stage,
          subtask: task.subtask,
          status: task.status,
          idempotencyKey: task.idempotencyKey,
          error: task.error,
        });
      }
    }
    return unfinished.sort((a, b) => (a.taskId > b.taskId ? 1 : -1));
  }

  _findReusableResults(session, events) {
    const reusable = {};
    const completedTasks = Object.entries(session.tasks || {}).filter(
      ([, t]) => t.status === TASK_STATUS.COMPLETED
    );

    for (const [taskId, task] of completedTasks) {
      const cachedEvent = events.find(e =>
        e.kind === EVENT_KINDS.TASK_CACHED_REUSED &&
        e.payload?.taskId === taskId
      );

      if (cachedEvent || task.resultRef) {
        reusable[taskId] = {
          idempotencyKey: task.idempotencyKey,
          resultRef: task.resultRef,
        };
      }
    }

    return reusable;
  }

  _detectInconsistencies(session, events, checkpoint) {
    const inconsistencies = [];

    // Check event-state mismatch
    const stageEvents = events.filter(e =>
      e.kind === EVENT_KINDS.STAGE_COMPLETED || e.kind === EVENT_KINDS.STAGE_FAILED
    );

    for (const event of stageEvents) {
      const stageName = event.stage || event.payload?.stage;
      if (!stageName) continue;

      const stage = session.stages?.[stageName];
      if (!stage) {
        inconsistencies.push({
          type: 'MISSING_STAGE',
          detail: `Event shows ${event.kind} for ${stageName} but stage not in session`,
          severity: 'high',
        });
        continue;
      }

      const eventStatus = event.kind === EVENT_KINDS.STAGE_COMPLETED
        ? STAGE_STATUS.COMPLETED
        : STAGE_STATUS.FAILED;

      if (stage.status !== eventStatus && stage.status !== STAGE_STATUS.ROLLED_BACK) {
        inconsistencies.push({
          type: 'STAGE_STATUS_MISMATCH',
          detail: `Stage ${stageName} has status ${stage.status} but events show ${eventStatus}`,
          severity: 'medium',
        });
      }
    }

    // Check checkpoint-session version mismatch
    if (checkpoint && checkpoint.snapshotVersion !== session.version) {
      inconsistencies.push({
        type: 'CHECKPOINT_VERSION_MISMATCH',
        detail: `Session version ${session.version} != checkpoint version ${checkpoint.snapshotVersion}`,
        severity: 'medium',
      });
    }

    // Check for running tasks in a failed session
    if (session.status === SESSION_STATUS.FAILED) {
      const runningTasks = Object.values(session.tasks || {}).filter(
        t => t.status === TASK_STATUS.RUNNING
      );
      if (runningTasks.length > 0) {
        inconsistencies.push({
          type: 'RUNNING_TASKS_IN_FAILED_SESSION',
          detail: `${runningTasks.length} task(s) still marked as running in failed session`,
          severity: 'high',
        });
      }
    }

    return inconsistencies;
  }

  _assessRiskLevel(session, pendingCompensations, inconsistencies, unfinishedOperations = []) {
    let score = 0;

    // Failed session with recovery not marked
    if (session.status === SESSION_STATUS.FAILED && !session.recovery?.recoverable) {
      score += 3;
    }

    // Pending compensations increase risk
    score += pendingCompensations.length * 3;

    // Unfinished operations increase risk
    score += unfinishedOperations.length * 2;

    // Inconsistencies increase risk
    for (const inc of inconsistencies) {
      score += inc.severity === 'critical' ? 10 : inc.severity === 'high' ? 5 : 2;
    }

    if (score >= 10) return RISK_LEVEL.CRITICAL;
    if (score >= 5) return RISK_LEVEL.HIGH;
    if (score >= 2) return RISK_LEVEL.MEDIUM;
    return RISK_LEVEL.LOW;
  }

  _detectSystemicFailure(session) {
    if (!session || !session.recovery) return false;
    const lastError = session.recovery?.lastError;
    if (!lastError) return false;

    const systemicPatterns = /timeout|ETIMEDOUT|ECONNRESET|OOM|out of memory|all items? failed|rate.?limit|quota|systemic/i;
    return systemicPatterns.test(lastError.message || lastError.toString());
  }

  _getRollbackTarget(currentStage) {
    const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
    const idx = stageOrder.indexOf(currentStage);
    if (idx <= 0) return currentStage;
    return stageOrder[idx - 1];
  }

  _createPlan(sessionId, input) {
    return {
      planId: `plan-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      sessionId,
      decision: input.decision,
      resumeFromStage: input.resumeFromStage || null,
      resumeFromTaskId: input.resumeFromTaskId || null,
      operationsToSkip: input.operationsToSkip || [],
      operationsToReplay: input.operationsToReplay || [],
      compensationsToRun: input.compensationsToRun || [],
      why: input.why,
      riskLevel: input.riskLevel || RISK_LEVEL.LOW,
    };
  }

  async _emitEvent(sessionId, kind, payload) {
    if (this._eventStore) {
      this._eventStore.append({
        sessionId,
        kind,
        payload,
      });
    }
  }
}

module.exports = { ResumeEngine };
