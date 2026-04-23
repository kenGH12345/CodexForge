'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IStateManager, STATE_MANAGER_METHODS } = require('./state-manager');
const { SCHEMA_VERSION, SESSION_STATUS, STAGE_STATUS, TASK_STATUS } = require('./types');

const DEFAULT_RUNTIME_DIR = path.join(process.cwd(), 'output', 'runtime');

function getRuntimeProjectionScenarioSummary(projectRoot = process.cwd()) {
  const outputDir = path.join(projectRoot, 'output');
  const runtimeDir = path.join(outputDir, 'runtime');
  return {
    outputDir,
    runtimeDir,
    statePath: path.join(runtimeDir, 'session-state.json'),
    indexPath: path.join(runtimeDir, 'index.json'),
    checkpointDir: path.join(runtimeDir, 'checkpoints'),
    legacyOutputs: [
      path.join(outputDir, 'manifest.json'),
      path.join(outputDir, 'workflow-status.json'),
    ],
    recoveryFields: ['resumeState', 'blockedReason', 'pendingCompensationCount'],
  };
}

class FileStateStore extends IStateManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.runtimeDir]
   * @param {Object} [options.projector] - IRuntimeProjector impl for projectCompatibility
   * @param {Object} [options.projection] - Projection trigger configuration
   * @param {boolean} [options.projection.enabled=true] - Enable projection output
   * @param {boolean} [options.projection.sync=true] - Use sync (true) or async (false) projection
   * @param {string} [options.outputDir] - Directory for legacy projection outputs (manifest.json, workflow-status.json)
   */
  constructor(options = {}) {
    super();
    this._runtimeDir = options.runtimeDir || DEFAULT_RUNTIME_DIR;
    this._projector = options.projector || null;
    this._projectionConfig = {
      enabled: options.projection?.enabled !== false,
      sync: options.projection?.sync !== false,
    };
    this._outputDir = options.outputDir || path.join(process.cwd(), 'output');
    this._statePath = path.join(this._runtimeDir, 'session-state.json');
    this._indexPath = path.join(this._runtimeDir, 'index.json');
    this._checkpointDir = path.join(this._runtimeDir, 'checkpoints');
    this._pendingProjection = null;
    this._ensureDirs();
  }

  _ensureDirs() {
    if (!fs.existsSync(this._runtimeDir)) fs.mkdirSync(this._runtimeDir, { recursive: true });
    if (!fs.existsSync(this._checkpointDir)) fs.mkdirSync(this._checkpointDir, { recursive: true });
  }

  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  _readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeIndex(index) {
    this._atomicWrite(this._indexPath, index);
  }

  _readIndex() {
    return this._readJSON(this._indexPath) || { sessions: {} };
  }

  createSession(input) {
    const sessionId = 'wf-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const now = new Date().toISOString();
    const session = {
      sessionId,
      projectId: input.projectId || null,
      requirement: input.requirement,
      requirementFingerprint: input.requirementFingerprint,
      mode: input.mode,
      status: SESSION_STATUS.CREATED,
      currentStage: input.initialStage || null,
      startedAt: now,
      updatedAt: now,
      version: 0,
      stages: {},
      tasks: {},
      recovery: { recoverable: false, pendingRetry: false, resumeState: null, blockedReason: null, pendingCompensationCount: 0, ledger: {} },
    };
    this._atomicWrite(this._statePath, session);
    const index = this._readIndex();
    index.sessions[sessionId] = { status: session.status, updatedAt: now };
    this._writeIndex(index);
    return session;
  }

  /**
   * Load a specific session by sessionId (from runtime state).
   * @param {string} sessionId
   * @returns {Session|null}
   */
  loadSession(sessionId) {
    const session = this._readJSON(this._statePath);
    if (!session) return null;
    if (session.sessionId === sessionId) return session;
    
    const cpPath = path.join(this._checkpointDir, `${sessionId}.json`);
    if (fs.existsSync(cpPath)) {
      return this._readJSON(cpPath);
    }
    return null;
  }

  /**
   * List all sessions in the runtime state (from index).
   * @returns {Array<{sessionId: string, status: string, updatedAt: string}>}
   */
  listSessions() {
    const index = this._readIndex();
    return Object.entries(index.sessions || {}).map(([sessionId, info]) => ({
      sessionId,
      ...info,
    }));
  }

  /**
   * Delete a session and optionally its data.
   * @param {string} sessionId
   * @param {boolean} deleteData - Whether to delete session data files
   * @returns {boolean}
   */
  listExpiredSessions(opts = {}) {
    const ttlMs = opts.ttlMs != null ? opts.ttlMs : (24 * 60 * 60 * 1000);
    const statuses = opts.statuses || [SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED];
    const cutoff = new Date(Date.now() - ttlMs).toISOString();

    return this.listSessions().filter(s => {
      if (!statuses.includes(s.status)) return false;
      if (!s.updatedAt) return false;
      return s.updatedAt < cutoff;
    });
  }

  deleteSession(sessionId, deleteData = false, eventsDir = null) {
    const index = this._readIndex();
    if (!index.sessions[sessionId]) return false;
    delete index.sessions[sessionId];
    this._writeIndex(index);
    if (deleteData) {
      const cpPath = path.join(this._checkpointDir, `${sessionId}.json`);
      if (fs.existsSync(cpPath)) fs.unlinkSync(cpPath);

      if (eventsDir) {
        const evPath = path.join(eventsDir, `${sessionId}.jsonl`);
        if (fs.existsSync(evPath)) fs.unlinkSync(evPath);
      }
    }
    return true;
  }

  saveSession(session, opts) {
    const current = this._readJSON(this._statePath);
    if (opts && opts.expectedVersion != null) {
      if (current && current.version !== opts.expectedVersion) {
        const err = new Error('version_conflict');
        err.code = 'version_conflict';
        throw err;
      }
    }
    const updated = {
      ...session,
      version: (session.version || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    this._atomicWrite(this._statePath, updated);
    const index = this._readIndex();
    index.sessions[updated.sessionId] = { status: updated.status, updatedAt: updated.updatedAt };
    this._writeIndex(index);
    return { success: true, newVersion: updated.version };
  }

  _loadCurrent() {
    return this._readJSON(this._statePath);
  }

  _saveUpdated(session) {
    session.updatedAt = new Date().toISOString();
    session.version = (session.version || 0) + 1;
    this._atomicWrite(this._statePath, session);
    const index = this._readIndex();
    index.sessions[session.sessionId] = { status: session.status, updatedAt: session.updatedAt };
    this._writeIndex(index);
    this._triggerProjection(session);
    return session;
  }

  beginStage(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const existing = session.stages[input.stage];
    if (existing && existing.status === STAGE_STATUS.RUNNING) {
      return existing;
    }
    const now = new Date().toISOString();
    const stageRun = {
      stage: input.stage,
      status: STAGE_STATUS.RUNNING,
      attempt: input.attempt || (existing ? existing.attempt + 1 : 1),
      startedAt: now,
      completedAt: null,
      inputRefs: input.inputRefs || [],
      outputRefs: [],
      resumeToken: null,
      lastEventSeq: input.eventSeq || 0,
    };
    session.stages[input.stage] = stageRun;
    session.currentStage = input.stage;
    session.status = SESSION_STATUS.RUNNING;
    this._saveUpdated(session);
    return stageRun;
  }

  completeStage(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const stageRun = session.stages[input.stage];
    if (!stageRun) throw new Error('invalid_transition: stage not started');
    stageRun.status = STAGE_STATUS.COMPLETED;
    stageRun.completedAt = new Date().toISOString();
    if (input.outputRefs) stageRun.outputRefs = input.outputRefs;
    if (input.eventSeq) stageRun.lastEventSeq = input.eventSeq;
    this._saveUpdated(session);
    return stageRun;
  }

  failStage(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const stageRun = session.stages[input.stage];
    if (!stageRun) throw new Error('invalid_transition: stage not started');
    stageRun.status = STAGE_STATUS.FAILED;
    stageRun.completedAt = new Date().toISOString();
    if (input.eventSeq) stageRun.lastEventSeq = input.eventSeq;
    session.status = SESSION_STATUS.FAILED;
    if (input.error) {
      session.recovery.lastError = input.error;
    }
    this._saveUpdated(session);
    return stageRun;
  }

  beginTask(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const now = new Date().toISOString();
    const taskRun = {
      taskId: input.taskId,
      stage: input.stage,
      subtask: input.subtask,
      status: TASK_STATUS.RUNNING,
      idempotencyKey: input.idempotencyKey,
      resultRef: null,
      error: null,
      startedAt: now,
      completedAt: null,
    };
    session.tasks[input.taskId] = taskRun;
    this._saveUpdated(session);
    return taskRun;
  }

  completeTask(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const taskRun = session.tasks[input.taskId];
    if (!taskRun) throw new Error('invalid_transition: task not started');
    taskRun.status = TASK_STATUS.COMPLETED;
    taskRun.completedAt = new Date().toISOString();
    if (input.resultRef) taskRun.resultRef = input.resultRef;
    if (input.eventSeq && session.stages[taskRun.stage]) {
      session.stages[taskRun.stage].lastEventSeq = input.eventSeq;
    }
    this._saveUpdated(session);
    return taskRun;
  }

  failTask(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const taskRun = session.tasks[input.taskId];
    if (!taskRun) throw new Error('invalid_transition: task not started');
    taskRun.status = TASK_STATUS.FAILED;
    taskRun.completedAt = new Date().toISOString();
    if (input.error) taskRun.error = input.error;
    this._saveUpdated(session);
    return taskRun;
  }

  saveCheckpoint(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    const checkpoint = {
      checkpointId: 'cp-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'),
      sessionId: input.sessionId,
      stage: input.stage,
      snapshotVersion: session.version,
      eventSeq: input.eventSeq,
      taskCursor: input.taskCursor || null,
      createdAt: new Date().toISOString(),
      snapshot: session,
    };
    const cpPath = path.join(this._checkpointDir, `${input.sessionId}.json`);
    this._atomicWrite(cpPath, checkpoint);
    return checkpoint;
  }

  getLatestCheckpoint(sessionId) {
    const cpPath = path.join(this._checkpointDir, `${sessionId}.json`);
    return this._readJSON(cpPath);
  }

  markRollback(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    session.recovery.recoverable = true;
    session.recovery.lastRollback = {
      stage: input.stage,
      info: input.rollbackInfo,
      eventSeq: input.eventSeq || null,
      rolledBackAt: new Date().toISOString(),
    };
    if (session.stages[input.stage]) {
      session.stages[input.stage].status = STAGE_STATUS.ROLLED_BACK;
    }
    this._saveUpdated(session);
    return session.recovery;
  }

  markRetry(input) {
    const session = this._loadCurrent();
    if (!session) throw new Error('session_not_found');
    session.recovery.pendingRetry = true;
    session.recovery.nextRetryAttempt = input.nextAttempt;
    session.recovery.nextRetryStage = input.stage;
    if (input.eventSeq && session.stages[input.stage]) {
      session.stages[input.stage].lastEventSeq = input.eventSeq;
    }
    this._saveUpdated(session);
    return session.recovery;
  }

  projectCompatibility(sessionId) {
    if (this._projector) {
      return {
        manifestLike: this._projector.projectManifest(sessionId),
        workflowStatusLike: this._projector.projectWorkflowStatus(sessionId),
      };
    }
    const session = this.loadSession(sessionId);
    if (!session) return { manifestLike: null, workflowStatusLike: null };
    return {
      manifestLike: { sessionId: session.sessionId, status: session.status, currentStage: session.currentStage, stages: session.stages },
      workflowStatusLike: { sessionId: session.sessionId, status: session.status, updatedAt: session.updatedAt },
    };
  }

  /**
   * Project a simplified view of recovery metadata for compatibility consumers.
   * @param {string} sessionId
   * @returns {{ resumeState: string|null, blockedReason: string|null, pendingCompensationCount: number }}
   */
  projectRecoveryMeta(sessionId) {
    const session = this.loadSession(sessionId);
    if (!session || !session.recovery) {
      return { resumeState: null, blockedReason: null, pendingCompensationCount: 0 };
    }
    return {
      resumeState: session.recovery.resumeState || null,
      blockedReason: session.recovery.blockedReason || null,
      pendingCompensationCount: session.recovery.pendingCompensationCount || 0,
    };
  }

  /**
   * Trigger projection to legacy manifest.json and workflow-status.json files.
   * Called automatically after each state update.
   * @private
   * @param {Object} session
   */
  _triggerProjection(session) {
    if (!this._projectionConfig.enabled || !this._projector) {
      return;
    }

    if (this._projectionConfig.sync) {
      this._projectSync(session);
    } else {
      this._projectAsync(session);
    }
  }

  /**
   * Synchronously project and write legacy outputs.
   * @private
   * @param {Object} session
   */
  _projectSync(session) {
    try {
      const manifest = this._projector.projectManifest(session.sessionId);
      const workflowStatus = this._projector.projectWorkflowStatus(session.sessionId);

      if (manifest) {
        this._writeLegacyFile('manifest.json', manifest);
      }
      if (workflowStatus) {
        this._writeLegacyFile('workflow-status.json', workflowStatus);
      }
    } catch (err) {
      console.error(`[FileStateStore] Projection failed: ${err.message}`);
    }
  }

  /**
   * Asynchronously project and write legacy outputs.
   * Returns immediately, projections happen in background.
   * @private
   * @param {Object} session
   */
  _projectAsync(session) {
    if (this._pendingProjection) {
      clearTimeout(this._pendingProjection);
    }

    this._pendingProjection = setTimeout(() => {
      this._projectSync(session);
      this._pendingProjection = null;
    }, 0);
  }

  /**
   * Write a legacy projection output file.
   * @private
   * @param {string} filename
   * @param {Object} data
   */
  _writeLegacyFile(filename, data) {
    try {
      const filePath = path.join(this._outputDir, filename);
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      this._atomicWrite(filePath, data);
    } catch (err) {
      console.error(`[FileStateStore] Failed to write ${filename}: ${err.message}`);
    }
  }

  /**
   * Get current projection configuration.
   * @returns {{enabled: boolean, sync: boolean}}
   */
  getProjectionConfig() {
    return { ...this._projectionConfig };
  }

  /**
   * Update projection configuration at runtime.
   * @param {Object} config
   * @param {boolean} [config.enabled]
   * @param {boolean} [config.sync]
   */
  setProjectionConfig(config) {
    if (config.enabled !== undefined) {
      this._projectionConfig.enabled = config.enabled;
    }
    if (config.sync !== undefined) {
      this._projectionConfig.sync = config.sync;
    }
  }
}

module.exports = { FileStateStore, getRuntimeProjectionScenarioSummary };
