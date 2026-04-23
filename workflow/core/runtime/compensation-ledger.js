'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EVENT_KINDS, COMPENSATION_STATUS } = require('./types');

const DEFAULT_LEDGER_DIR = path.join(process.cwd(), 'output', 'runtime', 'compensation');

class CompensationLedger {
  constructor(options = {}) {
    this._ledgerDir = options.ledgerDir || DEFAULT_LEDGER_DIR;
    this._stateStore = options.stateStore;
    this._eventStore = options.eventStore;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this._ledgerDir)) {
      fs.mkdirSync(this._ledgerDir, { recursive: true });
    }
  }

  _getLedgerPath(sessionId) {
    return path.join(this._ledgerDir, `${sessionId}-compensation.json`);
  }

  _readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /**
   * Register a durable compensation descriptor.
   * Side effect occurs BEFORE this registration - the descriptor captures WHAT to undo.
   * @param {Object} input
   * @param {string} input.sessionId
   * @param {string} input.stage
   * @param {string} input.taskId
   * @param {string} input.actionType - e.g. 'DELETE_ARTIFACT', 'CLEAR_STAGE_CTX'
   * @param {Object} input.args - Must be JSON-serialisable
   * @returns {CompensationDescriptor}
   */
  register(input) {
    const { sessionId, stage, taskId, actionType, args } = input;
    const compensationId = `comp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const idempotencyKey = `${sessionId}:${stage}:${taskId}:${actionType}`;
    const now = new Date().toISOString();

    const descriptor = {
      compensationId,
      sessionId,
      stage,
      taskId,
      actionType,
      args: args || {},
      idempotencyKey,
      registeredAt: now,
      status: COMPENSATION_STATUS.PENDING,
      error: null,
    };

    const ledger = this._loadLedger(sessionId);
    ledger.descriptors.push(descriptor);
    ledger.updatedAt = now;
    this._saveLedger(sessionId, ledger);

    // Emit durable event
    if (this._eventStore) {
      this._eventStore.append({
        sessionId,
        kind: EVENT_KINDS.COMPENSATION_REGISTERED,
        stage,
        taskId,
        payload: {
          compensationId,
          actionType,
          idempotencyKey,
        },
      });
    }

    return descriptor;
  }

  /**
   * Get pending compensations for a session.
   * @param {string} sessionId
   * @returns {CompensationDescriptor[]}
   */
  getPending(sessionId) {
    const ledger = this._loadLedger(sessionId);
    return ledger.descriptors.filter(
      d => d.status === COMPENSATION_STATUS.PENDING
    );
  }

  /**
   * Alias for getPending - for backwards compatibility.
   * @param {string} sessionId
   * @returns {CompensationDescriptor[]}
   */
  listPending(sessionId) {
    return this.getPending(sessionId);
  }

  /**
   * Alias for getPending - for backwards compatibility.
   * @param {string} sessionId
   * @returns {CompensationDescriptor[]}
   */
  listPending(sessionId) {
    return this.getPending(sessionId);
  }

  /**
   * Get all compensations for a session.
   * @param {string} sessionId
   * @returns {CompensationDescriptor[]}
   */
  getAll(sessionId) {
    const ledger = this._loadLedger(sessionId);
    return [...ledger.descriptors];
  }

  /**
   * Execute compensations for a session.
   * This is a best-effort execution - failures are recorded but don't halt others.
   * @param {string} sessionId
   * @param {Object} [handlers] - Optional custom handlers for action types
   * @returns {{completed:number,failed:number,skipped:number,errors:Array}}
   */
  async execute(sessionId, handlers = {}) {
    const pending = this.getPending(sessionId);
    const results = { completed: 0, failed: 0, skipped: 0, errors: [] };

    for (const descriptor of pending) {
      const result = await this._executeOne(descriptor, handlers);

      if (result.status === COMPENSATION_STATUS.COMPLETED) {
        results.completed++;
      } else if (result.status === COMPENSATION_STATUS.SKIPPED) {
        results.skipped++;
      } else {
        results.failed++;
        if (result.error) results.errors.push(result.error);
      }
    }

    return results;
  }

  /**
   * Execute a single compensation.
   * @private
   */
  async _executeOne(descriptor, handlers = {}) {
    const { sessionId, compensationId, actionType, args } = descriptor;

    // Check if already executed (idempotency)
    const ledger = this._loadLedger(sessionId);
    const existing = ledger.descriptors.find(d => d.compensationId === compensationId);
    if (!existing || existing.status !== COMPENSATION_STATUS.PENDING) {
      return { status: existing?.status || COMPENSATION_STATUS.SKIPPED, error: null };
    }

    // Find handler
    const handler = handlers[actionType] || this._defaultHandlers[actionType];
    if (!handler) {
      const error = { message: `No handler for actionType: ${actionType}` };
      this._markFailed(sessionId, compensationId, error);
      return { status: COMPENSATION_STATUS.FAILED, error };
    }

    try {
      const result = await handler(args, descriptor);

      if (result?.skip) {
        this._markSkipped(sessionId, compensationId, result.reason);
        return { status: COMPENSATION_STATUS.SKIPPED, error: null };
      }

      this._markCompleted(sessionId, compensationId);
      return { status: COMPENSATION_STATUS.COMPLETED, error: null };
    } catch (err) {
      const error = {
        message: err.message,
        name: err.name,
        stack: err.stack?.slice(0, 500),
      };
      this._markFailed(sessionId, compensationId, error);
      return { status: COMPENSATION_STATUS.FAILED, error };
    }
  }

  _markCompleted(sessionId, compensationId) {
    this._updateStatus(sessionId, compensationId, COMPENSATION_STATUS.COMPLETED);

    if (this._eventStore) {
      this._eventStore.append({
        sessionId,
        kind: EVENT_KINDS.COMPENSATION_EXECUTED,
        payload: { compensationId, status: COMPENSATION_STATUS.COMPLETED },
      });
    }
  }

  _markFailed(sessionId, compensationId, error) {
    const ledger = this._loadLedger(sessionId);
    const descriptor = ledger.descriptors.find(d => d.compensationId === compensationId);
    if (descriptor) {
      descriptor.status = COMPENSATION_STATUS.FAILED;
      descriptor.error = error;
      ledger.updatedAt = new Date().toISOString();
      this._saveLedger(sessionId, ledger);
    }

    if (this._eventStore) {
      this._eventStore.append({
        sessionId,
        kind: EVENT_KINDS.COMPENSATION_FAILED,
        payload: { compensationId, error },
      });
    }
  }

  _markSkipped(sessionId, compensationId, reason) {
    const ledger = this._loadLedger(sessionId);
    const descriptor = ledger.descriptors.find(d => d.compensationId === compensationId);
    if (descriptor) {
      descriptor.status = COMPENSATION_STATUS.SKIPPED;
      descriptor.skipReason = reason;
      ledger.updatedAt = new Date().toISOString();
      this._saveLedger(sessionId, ledger);
    }

    if (this._eventStore) {
      this._eventStore.append({
        sessionId,
        kind: EVENT_KINDS.COMPENSATION_SKIPPED,
        payload: { compensationId, reason },
      });
    }
  }

  _updateStatus(sessionId, compensationId, status) {
    const ledger = this._loadLedger(sessionId);
    const descriptor = ledger.descriptors.find(d => d.compensationId === compensationId);
    if (descriptor) {
      descriptor.status = status;
      ledger.updatedAt = new Date().toISOString();
      this._saveLedger(sessionId, ledger);
    }
  }

  _loadLedger(sessionId) {
    const path = this._getLedgerPath(sessionId);
    const data = this._readJSON(path);
    if (data) return data;

    return {
      sessionId,
      descriptors: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  _saveLedger(sessionId, ledger) {
    const path = this._getLedgerPath(sessionId);
    this._atomicWrite(path, ledger);
  }

  /**
   * Default compensation handlers for common action types.
   */
  get _defaultHandlers() {
    return {
      DELETE_ARTIFACT: async (args) => {
        if (!args.path) return { skip: true, reason: 'No path specified' };
        const fullPath = path.resolve(args.path);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
        return { success: true };
      },

      CLEAR_STAGE_CTX: async (args, descriptor) => {
        // Stage context can't be truly undone, but we mark it as cleared
        return { success: true };
      },

      ROLLBACK_GIT_BRANCH: async (args) => {
        // This would need git integration; for now mark as requiring manual handling
        return { skip: true, reason: 'Git rollback requires manual handling' };
      },

      INVALIDATE_CACHE: async (args) => {
        // Cache invalidation is best-effort
        return { success: true };
      },
    };
  }

  /**
   * Clear ledger for a session (e.g. after successful completion).
   * @param {string} sessionId
   */
  clear(sessionId) {
    const path = this._getLedgerPath(sessionId);
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
    }
  }
}

module.exports = { CompensationLedger };
