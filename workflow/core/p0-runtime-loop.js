'use strict';

const fs = require('fs');
const path = require('path');

class P0RuntimeLoop {
  constructor(options = {}) {
    this._outputDir = options.outputDir || path.join(__dirname, '..', 'output');
    this._projectId = options.projectId || 'unknown';
    this._stateMachine = options.stateMachine || null;
    this._obs = options.obs || null;
    this._verbose = !!options.verbose;

    this._checkpointPath = path.join(this._outputDir, 'task-recovery-checkpoint.json');
    this._metricsCachePath = path.join(this._outputDir, 'metrics-history-cache.json');
    this._metricsHistoryPath = path.join(this._outputDir, 'metrics-history.jsonl');

    this._unsubscribe = null;
    this._metricsCache = null;
    this._metricsHistoryMtimeMs = 0;
  }

  attachEventJournal(eventJournal) {
    if (!eventJournal || typeof eventJournal.subscribe !== 'function') return;
    if (this._unsubscribe) this._unsubscribe();

    this._unsubscribe = eventJournal.subscribe((entry) => {
      this._onEvent(entry);
    });

    this._log('P0 runtime loop attached to event stream');
  }

  detachEventJournal() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  restoreCheckpoint() {
    if (!fs.existsSync(this._checkpointPath)) {
      return { restored: false, reason: 'checkpoint_not_found' };
    }

    try {
      const raw = fs.readFileSync(this._checkpointPath, 'utf-8');
      const cp = JSON.parse(raw);
      return {
        restored: true,
        checkpoint: cp,
      };
    } catch (err) {
      return { restored: false, reason: `checkpoint_parse_failed:${err.message}` };
    }
  }

  markWorkflowStart(data = {}) {
    const payload = {
      status: 'running',
      projectId: this._projectId,
      startedAt: new Date().toISOString(),
      resumedFromState: this._stateMachine && this._stateMachine.getState ? this._stateMachine.getState() : null,
      ...data,
    };
    this._writeCheckpoint(payload);
  }

  markStageStart(stageName, meta = {}) {
    this._writeCheckpoint({
      status: 'running',
      lastStageStarted: stageName,
      lastStageStartAt: new Date().toISOString(),
      currentState: this._stateMachine && this._stateMachine.getState ? this._stateMachine.getState() : null,
      ...meta,
    });
  }

  markStageEnd(stageName, meta = {}) {
    this._writeCheckpoint({
      status: 'running',
      lastStageCompleted: stageName,
      lastStageEndAt: new Date().toISOString(),
      currentState: this._stateMachine && this._stateMachine.getState ? this._stateMachine.getState() : null,
      ...meta,
    });
  }

  markWorkflowEnd(meta = {}) {
    this._writeCheckpoint({
      status: 'completed',
      completedAt: new Date().toISOString(),
      currentState: this._stateMachine && this._stateMachine.getState ? this._stateMachine.getState() : null,
      ...meta,
    });
  }

  refreshMetricsCache() {
    const historyStat = fs.existsSync(this._metricsHistoryPath)
      ? fs.statSync(this._metricsHistoryPath)
      : null;
    const latestMtimeMs = historyStat ? historyStat.mtimeMs : 0;

    if (this._metricsCache && this._metricsHistoryMtimeMs === latestMtimeMs) {
      return { hit: true, cache: this._metricsCache };
    }

    const history = this._loadMetricsHistory();
    const latest = history.length > 0 ? history[history.length - 1] : null;
    const snapshot = this._obs && typeof this._obs.getMetricsSnapshot === 'function'
      ? this._obs.getMetricsSnapshot()
      : null;

    this._metricsCache = {
      generatedAt: new Date().toISOString(),
      projectId: this._projectId,
      historyCount: history.length,
      latestFromHistory: latest,
      runtimeSnapshot: snapshot,
    };
    this._metricsHistoryMtimeMs = latestMtimeMs;

    this._atomicWriteJson(this._metricsCachePath, this._metricsCache);
    return { hit: false, cache: this._metricsCache };
  }

  _onEvent(entry) {
    if (!entry || typeof entry !== 'object') return;

    if (entry.event === 'stage_started' && entry.data && entry.data.stage) {
      this.markStageStart(entry.data.stage);
      return;
    }
    if (entry.event === 'stage_ended' && entry.data && entry.data.stage) {
      this.markStageEnd(entry.data.stage, {
        lastArtifactPath: entry.data.artifactPath || null,
      });
      return;
    }
    if (entry.event === 'workflow_complete') {
      this.markWorkflowEnd({ viaEvent: true });
    }
  }

  _loadMetricsHistory() {
    if (!fs.existsSync(this._metricsHistoryPath)) return [];
    try {
      return fs.readFileSync(this._metricsHistoryPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  _writeCheckpoint(partial) {
    const prev = fs.existsSync(this._checkpointPath)
      ? this.restoreCheckpoint().checkpoint || {}
      : {};
    const next = {
      ...prev,
      ...partial,
      updatedAt: new Date().toISOString(),
    };
    this._atomicWriteJson(this._checkpointPath, next);
  }

  _atomicWriteJson(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      this._log(`write failed: ${err.message}`);
    }
  }

  _log(msg) {
    if (this._verbose) {
      console.log(`[P0RuntimeLoop] ${msg}`);
    }
  }
}

module.exports = { P0RuntimeLoop };