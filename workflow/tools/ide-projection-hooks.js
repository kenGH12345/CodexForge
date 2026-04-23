'use strict';

/**
 * IdeProjectionHooks — IDE Bridge integration for automatic projection updates.
 * T-7: Monitors runtime state changes and triggers projection generation for IDE consumption.
 *
 * Responsibilities:
 * - Watch runtime state directory for changes
 * - Auto-trigger projection generation when sessions update
 * - Provide IDE-compatible status notifications
 * - Support lazy/on-demand projection modes
 */

const fs = require('fs');
const path = require('path');
const { RuntimeApiAdapter } = require('./runtime-api-adapter');

class IdeProjectionHooks {
  /**
   * @param {Object} options
   * @param {string} options.projectRoot — Project root path
   * @param {string} [options.runtimeDir] — Runtime data directory to watch
   * @param {string} [options.outputDir] — Projection output directory
   * @param {Object} [options.projectionConfig] — Projection behavior config
   * @param {boolean} [options.projectionConfig.lazy=true] — Lazy (on-deman) vs eager (auto) mode
   * @param {number} [options.projectionConfig.debounceMs=500] — Debounce interval for file watching
   */
  constructor(options = {}) {
    this._projectRoot = options.projectRoot || process.cwd();
    this._runtimeDir = options.runtimeDir || path.join(this._projectRoot, 'output', 'runtime');
    this._outputDir = options.outputDir || path.join(this._projectRoot, 'output');
    this._config = {
      lazy: options.projectionConfig?.lazy !== false,
      debounceMs: options.projectionConfig?.debounceMs || 500,
      validate: options.projectionConfig?.validate !== false,
    };

    this._adapter = null;
    this._watcher = null;
    this._pendingUpdate = null;
    this._active = false;
    this._lastSessionIds = new Set();
  }

  /**
   * Initialize hooks and optionally start file watching.
   * @param {Object} [options]
   * @param {boolean} [options.startWatching=true] — Start file watcher immediately
   * @returns {this}
   */
  init(options = {}) {
    this._adapter = new RuntimeApiAdapter({
      projectRoot: this._projectRoot,
      runtimeDir: this._runtimeDir,
      outputDir: this._outputDir,
      projection: { validate: this._config.validate },
    });
    this._adapter.init();

    if (options.startWatching !== false) {
      this.startWatching();
    }

    return this;
  }

  /**
   * Start watching runtime directory for changes.
   * Uses fs.watchFile for cross-platform compatibility (IDE environments vary).
   * @returns {boolean} — True if watching started
   */
  startWatching() {
    if (this._watcher || this._active) {
      return false;
    }

    try {
      const stateFile = path.join(this._runtimeDir, 'session-state.json');
      const indexFile = path.join(this._runtimeDir, 'index.json');

      if (!fs.existsSync(this._runtimeDir)) {
        console.error('[IdeProjectionHooks] Runtime directory does not exist:', this._runtimeDir);
        return false;
      }

      if (fs.existsSync(stateFile)) {
        fs.watchFile(stateFile, { interval: this._config.debounceMs }, () => {
          this._onStateChange();
        });
      }

      if (fs.existsSync(indexFile)) {
        fs.watchFile(indexFile, { interval: this._config.debounceMs }, () => {
          this._onIndexChange();
        });
      }

      this._active = true;
      if (process.env.DEBUG) {
        console.error('[IdeProjectionHooks] Started watching:', this._runtimeDir);
      }
      return true;
    } catch (err) {
      console.error('[IdeProjectionHooks] Failed to start watching:', err.message);
      return false;
    }
  }

  /**
   * Stop file watching.
   */
  stopWatching() {
    if (!this._active) return;

    try {
      const stateFile = path.join(this._runtimeDir, 'session-state.json');
      const indexFile = path.join(this._runtimeDir, 'index.json');

      if (fs.existsSync(stateFile)) {
        fs.unwatchFile(stateFile);
      }
      if (fs.existsSync(indexFile)) {
        fs.unwatchFile(indexFile);
      }

      this._active = false;
      this._watcher = null;

      if (process.env.DEBUG) {
        console.error('[IdeProjectionHooks] Stopped watching');
      }
    } catch (err) {
      console.error('[IdeProjectionHooks] Error stopping watcher:', err.message);
    }
  }

  /**
   * Trigger projection generation for all sessions.
   * In lazy mode, marks dirty and returns; in eager mode, generates immediately.
   * @param {Object} [options]
   * @param {boolean} [options.force=false] — Force immediate generation even in lazy mode
   * @returns {Object} — Result of projection generation (or deferred status)
   */
  triggerProjection(options = {}) {
    if (this._config.lazy && !options.force) {
      this._pendingUpdate = true;
      return { status: 'deferred', message: 'Projection queued for next IDE request' };
    }

    return this._generateAllProjections();
  }

  /**
   * Handle state file change event.
   * @private
   */
  _onStateChange() {
    if (this._config.lazy) {
      this._pendingUpdate = true;
      return;
    }

    this._debouncedGenerate();
  }

  /**
   * Handle index file change event.
   * @private
   */
  _onIndexChange() {
    const currentSessions = this._getCurrentSessionIds();
    const newSessions = [...currentSessions].filter(id => !this._lastSessionIds.has(id));

    if (newSessions.length > 0 && process.env.DEBUG) {
      console.error('[IdeProjectionHooks] New sessions detected:', newSessions);
    }

    this._lastSessionIds = currentSessions;

    if (!this._config.lazy) {
      this._debouncedGenerate();
    }
  }

  /**
   * Debounced projection generation.
   * @private
   */
  _debouncedGenerate() {
    if (this._pendingUpdate) return;

    this._pendingUpdate = setTimeout(() => {
      this._generateAllProjections();
      this._pendingUpdate = null;
    }, this._config.debounceMs);
  }

  /**
   * Generate projections for all active sessions.
   * @private
   * @returns {Object}
   */
  _generateAllProjections() {
    try {
      const sessions = this._adapter.listSessions();
      const results = [];

      for (const session of sessions) {
        if (session.status === 'active' || session.status === 'running') {
          const result = this._adapter.generateBoth(session.sessionId, {
            validate: this._config.validate,
            writeLegacy: true,
          });
          results.push({ sessionId: session.sessionId, ...result });
        }
      }

      const writtenPaths = results
        .map(r => r.written)
        .filter(Boolean);

      return {
        status: 'completed',
        sessionsProcessed: results.length,
        written: writtenPaths,
        errors: results.flatMap(r => r.errors || []),
      };
    } catch (err) {
      console.error('[IdeProjectionHooks] Generation failed:', err.message);
      return { status: 'failed', error: err.message };
    }
  }

  /**
   * Get current session IDs from adapter.
   * @private
   * @returns {Set<string>}
   */
  _getCurrentSessionIds() {
    try {
      const sessions = this._adapter.listSessions();
      return new Set(sessions.map(s => s.sessionId));
    } catch (_) {
      return new Set();
    }
  }

  /**
   * Force immediate projection generation and clear pending flag.
   * Called by IDE when it needs fresh projections (open panel, refresh, etc.)
   * @returns {Object}
   */
  flushPending() {
    if (!this._pendingUpdate) {
      return { status: 'no-pending', message: 'No pending projections' };
    }

    if (this._pendingUpdate === true) {
      this._pendingUpdate = false;
      return this._generateAllProjections();
    }

    clearTimeout(this._pendingUpdate);
    this._pendingUpdate = null;
    return this._generateAllProjections();
  }

  /**
   * Get current hook status for IDE status bar.
   * @returns {{active: boolean, lazy: boolean, pending: boolean, lastCheck: string}}
   */
  getStatus() {
    return {
      active: this._active,
      lazy: this._config.lazy,
      pending: this._pendingUpdate === true || (this._pendingUpdate !== null && this._pendingUpdate !== false),
      lastCheck: new Date().toISOString(),
    };
  }

  /**
   * Check if projections are stale (older than threshold).
   * @param {number} [thresholdMinutes=5]
   * @returns {{stale: boolean, files: Array<{file: string, ageMinutes: number}>}}
   */
  checkStaleProjections(thresholdMinutes = 5) {
    const fs = require('fs');
    const results = { stale: false, files: [] };
    const now = Date.now();
    const threshold = thresholdMinutes * 60 * 1000;

    const files = ['manifest.json', 'workflow-status.json'];

    for (const filename of files) {
      const filePath = path.join(this._outputDir, filename);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const age = now - stats.mtime.getTime();
        const ageMinutes = Math.round(age / 60000);
        if (age > threshold) {
          results.stale = true;
          results.files.push({ file: filename, ageMinutes });
        }
      }
    }

    return results;
  }

  /**
   * Destroy hooks and release resources.
   */
  destroy() {
    this.stopWatching();
    this._adapter = null;
    this._lastSessionIds.clear();
  }
}

module.exports = { IdeProjectionHooks };
