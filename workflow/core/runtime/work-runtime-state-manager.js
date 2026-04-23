'use strict';

const { ResumeEngine } = require('./resume-engine');
const { FileStateStore } = require('./file-state-store');
const { RuntimeEventStore } = require('./runtime-event-store');
const { JsonlEventStore } = require('./jsonl-event-store');
const { CompensationLedger } = require('./compensation-ledger');
const { CheckpointGC } = require('./checkpoint-gc');
const path = require('path');

class WorkRuntimeStateManager {
  constructor(config = {}) {
    this._stateStore = config.stateStore || new FileStateStore(config);
    this._eventsDir = config.eventsDir || path.join(process.cwd(), 'output', 'runtime', 'events');
    this._jsonlStore = new JsonlEventStore({ eventsDir: this._eventsDir });
  }

  _getEngineForSession(sessionId) {
    const eventStore = new RuntimeEventStore({
      sessionId,
      backingStore: this._jsonlStore,
    });
    const compensationLedger = new CompensationLedger({
      stateStore: this._stateStore,
      eventStore,
    });
    return new ResumeEngine({
      stateStore: this._stateStore,
      eventStore,
      compensationLedger,
    });
  }

  // ── Session Lifecycle ──

  createSession(input) {
    return this._stateStore.createSession(input);
  }

  getSession(sessionId) {
    return this._stateStore.loadSession(sessionId);
  }

  listSessions(filters = {}) {
    const sessions = this._stateStore.listSessions();
    if (!filters.status) {
      return sessions;
    }
    return sessions.filter((s) => s.status === filters.status);
  }

  deleteSession(sessionId, deleteData = true) {
    return this._stateStore.deleteSession(sessionId, deleteData);
  }

  // ── State Queries ──

  getCurrentStage(sessionId) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session) return null;
    return session.currentStage;
  }

  getStageStatus(sessionId, stageName) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session || !session.stages) return null;
    return session.stages[stageName] || null;
  }

  getTaskStatus(sessionId, taskId) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session || !session.tasks) return null;
    return session.tasks[taskId] || null;
  }

  getOverallStatus(sessionId) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      status: session.status,
      currentStage: session.currentStage,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      stageCount: Object.keys(session.stages || {}).length,
      taskCount: Object.keys(session.tasks || {}).length,
    };
  }

  // ── Resume Operations ──

  inspect(sessionId) {
    const engine = this._getEngineForSession(sessionId);
    return engine.inspect(sessionId);
  }

  buildPlan(sessionId) {
    const engine = this._getEngineForSession(sessionId);
    return engine.buildPlan(sessionId);
  }

  canResume(sessionId) {
    const engine = this._getEngineForSession(sessionId);
    return engine.canResume(sessionId);
  }

  async resume(sessionId) {
    const engine = this._getEngineForSession(sessionId);
    return await engine.resume(sessionId);
  }

  markBlocked(sessionId, reason) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session || !session.recovery) {
      return { success: false, error: 'Session not found' };
    }
    session.recovery.blockedReason = reason;
    session.recovery.recoverable = false;
    this._stateStore.saveSession(session);
    return { success: true, sessionId, blockedReason: reason };
  }

  async unblock(sessionId) {
    const session = this._stateStore.loadSession(sessionId);
    if (!session || !session.recovery) {
      return { success: false, error: 'Session not found' };
    }
    const wasBlocked = session.recovery.blockedReason;
    session.recovery.blockedReason = null;
    session.recovery.recoverable = true;
    this._stateStore.saveSession(session);
    return { success: true, sessionId, wasBlocked, recoverable: true };
  }

  gc(opts = {}) {
    const gc = new CheckpointGC({
      stateStore: this._stateStore,
      eventStore: this._jsonlStore,
    });
    return gc.run(opts);
  }
}

module.exports = { WorkRuntimeStateManager };