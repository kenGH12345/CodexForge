'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const HEARTBEAT_FILENAME = 'shadow-heartbeat.json';

class ShadowHeartbeatChecker {
  constructor(options = {}) {
    this._outputDir = options.outputDir || null;
    this._totalVerifications = 0;
    this._totalFailures = 0;
    this._lastFailureAt = null;
    this._lastFailureReason = null;
    this._status = 'healthy';
  }

  async verify(filePath, _expectedRecord) {
    this._totalVerifications++;
    try {
      const lastLine = await _readLastLine(filePath);
      if (!lastLine) {
        this._markDegraded('Empty or non-existent file');
        return this._getStatus();
      }
      const parsed = JSON.parse(lastLine);
      if (!parsed.schemaVersion) {
        this._markDegraded('Missing schemaVersion field');
        return this._getStatus();
      }
      if (parsed.generatedAt && isNaN(Date.parse(parsed.generatedAt))) {
        this._markDegraded('Invalid generatedAt timestamp');
        return this._getStatus();
      }
      this._status = 'healthy';
    } catch (err) {
      this._markDegraded(`JSON parse error: ${err.message}`);
    }
    this._persist();
    return this._getStatus();
  }

  _markDegraded(reason) {
    this._totalFailures++;
    this._lastFailureAt = new Date().toISOString();
    this._lastFailureReason = reason;
    this._status = 'degraded';
  }

  getStatus() {
    return this._getStatus();
  }

  _getStatus() {
    return {
      schemaVersion: 1,
      lastVerificationAt: new Date().toISOString(),
      totalVerifications: this._totalVerifications,
      totalFailures: this._totalFailures,
      lastFailureAt: this._lastFailureAt,
      lastFailureReason: this._lastFailureReason,
      status: this._status,
    };
  }

  _persist() {
    if (!this._outputDir) return;
    try {
      const fp = path.join(this._outputDir, HEARTBEAT_FILENAME);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(this._getStatus(), null, 2), 'utf-8');
    } catch (_) { /* silent */ }
  }
}

async function _readLastLine(filePath) {
  return new Promise((resolve) => {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return resolve(null);
    }
    if (stat.size === 0) return resolve(null);
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8', start: Math.max(0, stat.size - 8192) });
    const rl = readline.createInterface({ input: stream });
    let lastLine = '';
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) lastLine = trimmed;
    });
    rl.on('close', () => resolve(lastLine || null));
    rl.on('error', () => resolve(null));
  });
}

module.exports = { ShadowHeartbeatChecker };
