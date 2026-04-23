'use strict';

const { SESSION_STATUS } = require('./types');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const GCABLE_STATUSES = [SESSION_STATUS.COMPLETED, SESSION_STATUS.FAILED];

class CheckpointGC {
  constructor({ stateStore, eventStore }) {
    this._stateStore = stateStore;
    this._eventStore = eventStore;
  }

  run(opts = {}) {
    const ttlMs = opts.ttlMs != null ? opts.ttlMs : DEFAULT_TTL_MS;
    const dryRun = opts.dryRun || false;
    const statuses = opts.statuses || GCABLE_STATUSES;

    const now = Date.now();
    const cutoff = new Date(now - ttlMs).toISOString();

    const candidates = this._findCandidates(statuses, cutoff);

    if (dryRun) {
      return { dryRun: true, candidates, count: candidates.length };
    }

    const results = { deleted: [], errors: [], count: 0 };
    for (const session of candidates) {
      try {
        this._collectSession(session.sessionId);
        results.deleted.push(session.sessionId);
      } catch (err) {
        results.errors.push({ sessionId: session.sessionId, error: err.message });
      }
    }
    results.count = results.deleted.length;
    return results;
  }

  _findCandidates(statuses, cutoff) {
    const sessions = this._stateStore.listSessions();
    return sessions.filter(s => {
      if (!statuses.includes(s.status)) return false;
      if (!s.updatedAt) return false;
      return s.updatedAt < cutoff;
    });
  }

  _collectSession(sessionId) {
    if (this._eventStore && typeof this._eventStore.deleteEventLog === 'function') {
      this._eventStore.deleteEventLog(sessionId);
    }
    this._stateStore.deleteSession(sessionId, true);
  }
}

module.exports = { CheckpointGC, DEFAULT_TTL_MS, GCABLE_STATUSES };
