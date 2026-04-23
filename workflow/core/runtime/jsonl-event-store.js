'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { IEventStore, EVENT_STORE_METHODS } = require('./event-store');
const { SCHEMA_VERSION, EVENT_KINDS } = require('./types');

const DEFAULT_EVENTS_DIR = path.join(process.cwd(), 'output', 'runtime', 'events');

class JsonlEventStore extends IEventStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.eventsDir]
   */
  constructor(options = {}) {
    super();
    this._eventsDir = options.eventsDir || DEFAULT_EVENTS_DIR;
    this._indexPath = path.join(this._eventsDir, 'index.json');
    this._subscribers = [];
    this._seqCounters = {};
    this._ensureDirs();
  }

  _ensureDirs() {
    if (!fs.existsSync(this._eventsDir)) fs.mkdirSync(this._eventsDir, { recursive: true });
  }

  _atomicWrite(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  _readIndex() {
    try {
      if (!fs.existsSync(this._indexPath)) return { sessions: {} };
      return JSON.parse(fs.readFileSync(this._indexPath, 'utf8'));
    } catch {
      return { sessions: {} };
    }
  }

  _writeIndex(index) {
    this._atomicWrite(this._indexPath, index);
  }

  _getSessionFilePath(sessionId) {
    const index = this._readIndex();
    if (index.sessions[sessionId] && index.sessions[sessionId].filePath) {
      return index.sessions[sessionId].filePath;
    }
    return path.join(this._eventsDir, `${sessionId}.jsonl`);
  }

  _nextSeq(sessionId) {
    if (!(sessionId in this._seqCounters)) {
      this._seqCounters[sessionId] = this.getLastSeq(sessionId);
    }
    this._seqCounters[sessionId]++;
    return this._seqCounters[sessionId];
  }

  _buildEvent(sessionId, input, seq) {
    return {
      seq,
      ts: new Date().toISOString(),
      sessionId,
      kind: input.kind,
      stage: input.stage || null,
      taskId: input.taskId || null,
      attempt: input.attempt || null,
      payload: input.payload || {},
      causationId: input.causationId || null,
      correlationId: input.correlationId || null,
      snapshotHint: input.snapshotHint || false,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  append(input) {
    const sessionId = input.sessionId;
    const filePath = this._getSessionFilePath(sessionId);
    const seq = this._nextSeq(sessionId);
    const event = this._buildEvent(sessionId, input, seq);

    const line = JSON.stringify(event) + '\n';
    if (!fs.existsSync(filePath)) {
      const header = JSON.stringify({ schemaVersion: SCHEMA_VERSION, sessionId, createdAt: new Date().toISOString() }) + '\n';
      fs.writeFileSync(filePath, header, 'utf8');
    }
    fs.appendFileSync(filePath, line, 'utf8');

    const index = this._readIndex();
    index.sessions[sessionId] = {
      lastSeq: seq,
      filePath,
      updatedAt: new Date().toISOString(),
    };
    this._writeIndex(index);

    this._notifySubscribers(event);
    return event;
  }

  appendBatch(inputs) {
    const results = [];
    for (const input of inputs) {
      results.push(this.append(input));
    }
    return results;
  }

  readStream(input) {
    const filePath = this._getSessionFilePath(input.sessionId);
    if (!fs.existsSync(filePath)) return [];

    const events = [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.schemaVersion && parsed.seq != null) {
          if (input.fromSeq != null && parsed.seq < input.fromSeq) continue;
          if (input.untilSeq != null && parsed.seq > input.untilSeq) continue;
          events.push(parsed);
        }
      } catch {
        // skip malformed lines
      }
    }
    return events;
  }

  query(input) {
    const sessions = input.sessionId
      ? [input.sessionId]
      : Object.keys(this._readIndex().sessions);

    let allEvents = [];
    for (const sid of sessions) {
      const filePath = this._getSessionFilePath(sid);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.schemaVersion && parsed.seq != null) {
            allEvents.push(parsed);
          }
        } catch {
          // skip
        }
      }
    }

    if (input.stage) allEvents = allEvents.filter(e => e.stage === input.stage);
    if (input.taskId) allEvents = allEvents.filter(e => e.taskId === input.taskId);
    if (input.kind) allEvents = allEvents.filter(e => e.kind === input.kind);
    if (input.fromSeq != null) allEvents = allEvents.filter(e => e.seq >= input.fromSeq);
    if (input.untilSeq != null) allEvents = allEvents.filter(e => e.seq <= input.untilSeq);

    allEvents.sort((a, b) => a.seq - b.seq);
    if (input.limit) allEvents = allEvents.slice(0, input.limit);
    return allEvents;
  }

  getLastSeq(sessionId) {
    const index = this._readIndex();
    if (index.sessions[sessionId] && typeof index.sessions[sessionId].lastSeq === 'number') {
      return index.sessions[sessionId].lastSeq;
    }
    // fallback: scan JSONL file tail
    const filePath = this._getSessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) return 0;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed.seq != null) return parsed.seq;
        } catch {
          // continue
        }
      }
    } catch {
      // ignore
    }
    return 0;
  }

  replay(input) {
    const events = this.readStream({
      sessionId: input.sessionId,
      fromSeq: input.fromSeq,
      untilSeq: input.untilSeq,
    });
    let eventsApplied = 0;
    let lastSeq = input.fromSeq - 1;
    for (const event of events) {
      if (input.handler) {
        input.handler(event);
      }
      eventsApplied++;
      lastSeq = event.seq;
    }
    return {
      eventsApplied,
      lastSeq,
      checkpointUsed: null,
    };
  }

  subscribe(input, handler) {
    const sub = { sessionId: input.sessionId, kinds: input.kinds || null, handler };
    this._subscribers.push(sub);
    return () => {
      const idx = this._subscribers.indexOf(sub);
      if (idx !== -1) this._subscribers.splice(idx, 1);
    };
  }

  _notifySubscribers(event) {
    for (const sub of this._subscribers) {
      if (sub.sessionId !== event.sessionId) continue;
      if (sub.kinds && !sub.kinds.includes(event.kind)) continue;
      try {
        sub.handler(event);
      } catch {
        // subscriber errors must not break append
      }
    }
  }

  compact(input) {
    const { sessionId, beforeSeq } = input || {};
    if (!sessionId || beforeSeq == null) {
      return { success: false, error: 'sessionId and beforeSeq are required' };
    }

    const filePath = this._getSessionFilePath(sessionId);
    if (!fs.existsSync(filePath)) {
      return { success: true, removed: 0, message: 'no event log found' };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      return { success: true, removed: 0 };
    }

    const headerLine = lines[0];
    let header;
    try {
      header = JSON.parse(headerLine);
    } catch {
      return { success: false, error: 'corrupt event log header' };
    }
    if (header.schemaVersion == null || header.sessionId !== sessionId) {
      return { success: false, error: 'invalid event log header' };
    }

    const kept = [];
    let removed = 0;
    for (let i = 1; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.seq != null && parsed.seq < beforeSeq) {
          removed++;
        } else {
          kept.push(lines[i]);
        }
      } catch {
        removed++;
      }
    }

    const tmpPath = filePath + '.tmp';
    let output = headerLine + '\n';
    for (const line of kept) {
      output += line + '\n';
    }
    fs.writeFileSync(tmpPath, output, 'utf8');
    fs.renameSync(tmpPath, filePath);

    delete this._seqCounters[sessionId];
    return { success: true, removed, kept: kept.length };
  }

  deleteEventLog(sessionId) {
    const filePath = this._getSessionFilePath(sessionId);
    const existed = fs.existsSync(filePath);
    if (existed) {
      fs.unlinkSync(filePath);
    }

    const index = this._readIndex();
    if (index.sessions[sessionId]) {
      delete index.sessions[sessionId];
      this._writeIndex(index);
    }

    delete this._seqCounters[sessionId];
    return existed;
  }
}

module.exports = { JsonlEventStore };
