'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDefaultOutputDir } = require('./constants');

const DEFAULT_ERROR_MSG_LIMIT = 1200;
const DEFAULT_CODE_CHANGES_LIMIT = 2000;

/**
 * Resolve sessionsDir given the constructor options. Three layers of priority:
 *   1. Explicit sessionsDir (caller knows exactly where to read/write).
 *   2. projectRoot → `<projectRoot>/.workflow/fix-sessions`
 *      (used by RuntimeSafetyGuard / TestFixLoop unit tests).
 *   3. Process-default (legacy): `cwd()/output/fix-sessions`
 *      (used by FixExperienceEngine when caller passes nothing).
 */
function _resolveSessionsDir(options) {
  if (options.sessionsDir) return options.sessionsDir;
  if (options.projectRoot) {
    return path.join(options.projectRoot, '.workflow', 'fix-sessions');
  }
  return path.join(getDefaultOutputDir(), 'fix-sessions');
}

function _truncate(text, limit) {
  if (typeof text !== 'string') return text;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `…[truncated ${text.length - limit} chars]`;
}

function _approachHash(approach) {
  return crypto.createHash('sha1').update(String(approach || '').toLowerCase().trim()).digest('hex').slice(0, 12);
}

class FixSessionStore {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || null;
    this.sessionsDir = _resolveSessionsDir(options);
    // Backward-compat anti-loop knobs (used by startSession/shouldBlockApproach).
    this._maxSameApproachAttempts = options.maxSameApproachAttempts ?? 2;
    this._similarityWarnThreshold = options.similarityWarnThreshold ?? 0.5;
    this._similarityBlockThreshold = options.similarityBlockThreshold ?? 0.85;
    this._errorMsgLimit = options.errorMsgLimit ?? DEFAULT_ERROR_MSG_LIMIT;
    this._codeChangesLimit = options.codeChangesLimit ?? DEFAULT_CODE_CHANGES_LIMIT;
  }

  // ─── Low-level CRUD (used by FixExperienceEngine) ──────────────────────────

  createSession(session) {
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
    const filePath = this._getSessionPath(session.id);
    this._atomicWriteJson(filePath, session);
    return session;
  }

  getSession(sessionId) {
    const filePath = this._getSessionPath(sessionId);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  updateSession(sessionId, updates) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, updates, { updatedAt: new Date().toISOString() });
    this._atomicWriteJson(this._getSessionPath(sessionId), session);
    return session;
  }

  addAttempt(sessionId, attempt) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (!session.attempts) session.attempts = [];
    session.attempts.push(attempt);
    session.attemptCount = session.attempts.length;
    session.updatedAt = new Date().toISOString();
    this._atomicWriteJson(this._getSessionPath(sessionId), session);
    return session;
  }

  listSessions(status = null, limit = 50) {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
    const sessions = [];
    for (const f of files.slice(0, limit * 2)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8'));
        if (!status || s.status === status) sessions.push(s);
        if (sessions.length >= limit) break;
      } catch { /* skip corrupt */ }
    }
    return sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  deleteSession(sessionId) {
    const filePath = this._getSessionPath(sessionId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  }

  // ─── High-level API (used by TestFixLoop + unit tests) ─────────────────────

  /**
   * Start a new fix session. Truncates oversized error messages.
   * Returns the persisted session object.
   */
  startSession({ problem = '', errorMsg = '', errorType = 'other', taskId = null } = {}) {
    const id = `fix_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const session = {
      id,
      taskId,
      problem,
      errorMsg: _truncate(errorMsg, this._errorMsgLimit),
      errorType,
      status: 'open',
      attempts: [],
      attemptCount: 0,
      deadEnds: [],
      finalExperience: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this.createSession(session);
  }

  /**
   * Record an attempt. Returns { attempt } so callers can inspect truncated content.
   * If the attempt is labelled dead_end (or its result is 'failed' and shouldBlockApproach
   * tagged it), append to session.deadEnds with an approachHash for fast lookup.
   */
  recordAttempt(sessionId, attempt = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const truncatedAttempt = {
      ...attempt,
      approach: attempt.approach || '',
      result: attempt.result || 'unknown',
      codeChanges: _truncate(attempt.codeChanges, this._codeChangesLimit),
      resultDetail: _truncate(attempt.resultDetail, this._errorMsgLimit),
      createdAt: new Date().toISOString(),
    };

    this.addAttempt(sessionId, truncatedAttempt);

    // Dead-end bookkeeping (used by anti-loop similarity checks).
    const isDeadEnd = truncatedAttempt.label === 'dead_end'
      || truncatedAttempt.result === 'skipped' && truncatedAttempt.label === 'dead_end';
    if (isDeadEnd) {
      const updated = this.getSession(sessionId);
      if (!updated.deadEnds) updated.deadEnds = [];
      updated.deadEnds.push({
        approach: truncatedAttempt.approach,
        approachHash: _approachHash(truncatedAttempt.approach),
        labelReason: truncatedAttempt.labelReason || '',
        recordedAt: truncatedAttempt.createdAt,
      });
      this._atomicWriteJson(this._getSessionPath(sessionId), updated);
    }

    return { attempt: truncatedAttempt };
  }

  /**
   * Decide whether a proposed approach should be blocked or warned.
   * - Block: same approach already failed >= maxSameApproachAttempts times,
   *   OR matches an existing deadEnd entry (exact hash).
   * - Warn: similar (Jaccard overlap >= warnThreshold) but not identical.
   */
  shouldBlockApproach(sessionId, { approach = '' } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return { block: false, warn: false, reason: 'session_not_found' };

    const newHash = _approachHash(approach);
    const newKeywords = _extractKeywords(approach);

    // Exact dead-end hash match — block immediately.
    const deadHit = (session.deadEnds || []).find(d => d.approachHash === newHash);
    if (deadHit) {
      return { block: true, warn: false, reason: 'dead_end_repeat', similarity: 1.0, matched: deadHit };
    }

    // Count failures with the same exact approach.
    let sameFailures = 0;
    let maxSimilarity = 0;
    let mostSimilarApproach = null;
    for (const a of (session.attempts || [])) {
      if (a.result === 'success') continue;
      if (_approachHash(a.approach) === newHash) sameFailures++;
      const sim = _jaccard(newKeywords, _extractKeywords(a.approach));
      if (sim > maxSimilarity) {
        maxSimilarity = sim;
        mostSimilarApproach = a.approach;
      }
    }

    if (sameFailures >= this._maxSameApproachAttempts) {
      return {
        block: true,
        warn: false,
        reason: 'same_approach_repeated',
        similarity: 1.0,
        sameFailures,
      };
    }

    if (maxSimilarity >= this._similarityBlockThreshold) {
      return { block: true, warn: false, reason: 'high_similarity_block', similarity: maxSimilarity };
    }

    if (maxSimilarity >= this._similarityWarnThreshold) {
      return {
        block: false,
        warn: true,
        reason: 'similar_approach',
        similarity: maxSimilarity,
        mostSimilarApproach,
      };
    }

    return { block: false, warn: false, reason: 'novel_approach', similarity: maxSimilarity };
  }

  /**
   * Close a session. Generates a finalExperience block from successful attempts
   * and dead-ends. Returns the updated session.
   */
  closeSession(sessionId, { status = 'resolved', resolution = '', rootCause = '', keyInsight = '' } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const updates = {
      status,
      resolution,
      updatedAt: new Date().toISOString(),
    };

    if (status === 'resolved') {
      updates.resolvedAt = new Date().toISOString();
      const fixPath = (session.attempts || [])
        .filter(a => a.result === 'success' || a.label === 'correct')
        .map(a => a.approach);
      const deadEnds = (session.attempts || [])
        .filter(a => a.label === 'dead_end' || a.result === 'failed')
        .map(a => a.approach);
      updates.finalExperience = {
        problem: session.problem,
        rootCause,
        solution: resolution,
        fixPath,
        deadEnds,
        keyInsight,
        confidence: fixPath.length > 0 ? 0.85 : 0.6,
      };
    } else if (status === 'abandoned') {
      updates.abandonedAt = new Date().toISOString();
    }

    return this.updateSession(sessionId, updates);
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  _getSessionPath(sessionId) {
    const safeId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  _atomicWriteJson(filePath, value) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }
}

// ─── Lightweight similarity helpers (kept inline to avoid a hard dep) ────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'to', 'of', 'in', 'for', 'on', 'with', 'and', 'or',
  'try', 'add', 'use', 'fix',
]);

function _extractKeywords(text) {
  if (!text) return [];
  return String(text).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)
    .map(w => w.trim()).filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

function _jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const k of sa) if (sb.has(k)) inter++;
  return inter / (sa.size + sb.size - inter);
}

module.exports = { FixSessionStore };
