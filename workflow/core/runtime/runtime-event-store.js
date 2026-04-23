'use strict';

const { IEventStore } = require('./event-store');
const { SCHEMA_VERSION, EVENT_CATEGORY, HOOK_TO_CATEGORY_MAP } = require('./types');

const MAX_STRING_LEN = 500;
const MAX_SANITIZE_DEPTH = 3;

class RuntimeEventStore extends IEventStore {
  /**
   * @param {Object} options
   * @param {import('./jsonl-event-store').JsonlEventStore} options.backingStore - Durable append-only log
   * @param {string} options.sessionId
   */
  constructor(options = {}) {
    super();
    this._store = options.backingStore;
    this._sessionId = options.sessionId;
    this._currentStage = null;
    this._hookAttached = false;
    this._liveSubscribers = new Set();
    this._eventLog = [];
    this._stats = { totalEvents: 0, eventsByCategory: {}, firstEventTs: null, lastEventTs: null };
  }

  append(input) {
    const enriched = this._enrichInput(input);
    const event = this._store.append(enriched);
    const merged = { ...event, category: enriched.category, iso: new Date(event.ts).toISOString() };
    this._eventLog.push(merged);
    this._updateStats(merged);
    this._notifyLive(merged);
    return merged;
  }

  appendBatch(inputs) {
    return inputs.map(input => this.append(input));
  }

  readStream(input) {
    return this._store.readStream(input);
  }

  query(input) {
    return this._store.query(input);
  }

  getLastSeq(sessionId) {
    return this._store.getLastSeq(sessionId);
  }

  replay(input) {
    return this._store.replay(input);
  }

  subscribe(input, handler) {
    return this._store.subscribe(input, handler);
  }

  compact(input) {
    return this._store.compact(input);
  }

  attachToHookSystem(hookSystem) {
    if (this._hookAttached || !hookSystem || typeof hookSystem.emit !== 'function') return;
    this._hookAttached = true;

    const self = this;
    const originalEmit = hookSystem.emit.bind(hookSystem);

    hookSystem.emit = async function wrappedEmit(event, payload = {}) {
      self._trackStage(event, payload);

      const category = HOOK_TO_CATEGORY_MAP[event] || EVENT_CATEGORY.SYSTEM;
      const safePayload = self._sanitizePayload(payload);

      self.append({
        sessionId: self._sessionId,
        kind: event,
        category,
        stage: self._currentStage,
        payload: safePayload,
      });

      return originalEmit(event, payload);
    };
  }

  queryByCategory(category, opts = {}) {
    let filtered = this._eventLog.filter(e => e.category === category);
    if (opts.stage) filtered = filtered.filter(e => e.stage === opts.stage);
    if (opts.limit) filtered = filtered.slice(0, opts.limit);
    return filtered;
  }

  getCausationChain(causationId) {
    if (!causationId) return [];
    const byCausation = new Map();
    for (const e of this._eventLog) {
      if (e.causationId) {
        if (!byCausation.has(e.causationId)) byCausation.set(e.causationId, []);
        byCausation.get(e.causationId).push(e);
      }
    }
    const chain = [];
    let current = causationId;
    const visited = new Set();
    while (current && !visited.has(current)) {
      visited.add(current);
      const children = byCausation.get(current) || [];
      chain.push(...children);
      current = children.length > 0 ? children[0].seq : null;
    }
    return chain;
  }

  getStats() {
    return { ...this._stats, sessionId: this._sessionId };
  }

  subscribeLive(callback) {
    if (typeof callback !== 'function') return () => {};
    this._liveSubscribers.add(callback);
    return () => { this._liveSubscribers.delete(callback); };
  }

  _enrichInput(input) {
    const now = new Date();
    const category = input.category || this._deriveCategory(input.kind);
    return {
      ...input,
      sessionId: input.sessionId || this._sessionId,
      category,
      stage: input.stage || this._currentStage || null,
      payload: this._sanitizePayload(input.payload || {}),
    };
  }

  _deriveCategory(kind) {
    if (!kind) return EVENT_CATEGORY.SYSTEM;
    if (HOOK_TO_CATEGORY_MAP[kind]) return HOOK_TO_CATEGORY_MAP[kind];
    if (kind.startsWith('workflow.')) return EVENT_CATEGORY.LIFECYCLE;
    if (kind.startsWith('llm.') || kind.startsWith('router.')) return EVENT_CATEGORY.LLM;
    if (kind.startsWith('task.')) return EVENT_CATEGORY.AGENT;
    if (kind.startsWith('stage.')) return EVENT_CATEGORY.STAGE;
    return EVENT_CATEGORY.SYSTEM;
  }

  _trackStage(event, payload) {
    if (event === 'stage_started' && payload.stage) {
      this._currentStage = payload.stage;
    } else if (event === 'stage_ended') {
      this._currentStage = null;
    } else if (event === 'before_state_transition' && payload.toState) {
      this._currentStage = `${payload.fromState}→${payload.toState}`;
    }
  }

  _updateStats(event) {
    this._stats.totalEvents++;
    const cat = event.category || EVENT_CATEGORY.SYSTEM;
    this._stats.eventsByCategory[cat] = (this._stats.eventsByCategory[cat] || 0) + 1;
    const now = Date.now();
    if (!this._stats.firstEventTs) this._stats.firstEventTs = now;
    this._stats.lastEventTs = now;
  }

  _notifyLive(event) {
    for (const cb of this._liveSubscribers) {
      try { cb(event); } catch (_) { /* subscriber errors must not affect append */ }
    }
  }

  _sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    return this._sanitize(payload, 0);
  }

  _sanitize(obj, depth) {
    if (depth > MAX_SANITIZE_DEPTH) return '[depth-limited]';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'function') return '[function]';
    if (typeof obj === 'string') {
      return obj.length > MAX_STRING_LEN
        ? obj.slice(0, MAX_STRING_LEN) + `...[truncated:${obj.length}]`
        : obj;
    }
    if (typeof obj !== 'object') return obj;
    if (obj instanceof Error) {
      return { message: obj.message, name: obj.name, stack: (obj.stack || '').slice(0, 300) };
    }
    if (Array.isArray(obj)) {
      return obj.slice(0, 20).map(item => this._sanitize(item, depth + 1));
    }
    const result = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, 30)) {
      try { result[key] = this._sanitize(obj[key], depth + 1); }
      catch (_) { result[key] = '[unserializable]'; }
    }
    if (keys.length > 30) result['...'] = `${keys.length - 30} more keys`;
    return result;
  }
}

module.exports = { RuntimeEventStore };
