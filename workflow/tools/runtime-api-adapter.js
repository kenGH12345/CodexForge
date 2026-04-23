'use strict';

/**
 * RuntimeApiAdapter — Provides unified Runtime API access for Bridge/CLI.
 * Wraps StateManager, EventStore, and Projector for consistent projection generation.
 *
 * Responsibilities:
 * - Lazy initialization of runtime components
 * - Projection generation and caching
 * - Session query and management
 * - Health trace aggregation
 */

const path = require('path');
const { FileStateStore } = require('../core/runtime/file-state-store');
const { RuntimeProjector } = require('../core/runtime/runtime-projector');
const { JsonlEventStore } = require('../core/runtime/jsonl-event-store');
const { RuntimeEventStore } = require('../core/runtime/runtime-event-store');
const { ProjectionContractValidator } = require('../core/runtime/projection-contract-validator');

class RuntimeApiAdapter {
  /**
   * @param {Object} options
   * @param {string} options.projectRoot — Project root path
   * @param {string} [options.runtimeDir] — Runtime data directory
   * @param {string} [options.outputDir] — Legacy projection output directory
   */
  constructor(options = {}) {
    this._projectRoot = options.projectRoot || process.cwd();
    this._runtimeDir = options.runtimeDir || path.join(this._projectRoot, 'output', 'runtime');
    this._outputDir = options.outputDir || path.join(this._projectRoot, 'output');
    this._projectionConfig = {
      enabled: options.projection?.enabled !== false,
      sync: options.projection?.sync !== false,
      validate: options.projection?.validate !== false,
    };

    this._stateManager = null;
    this._eventStore = null;
    this._projector = null;
    this._validator = null;
    this._initialized = false;
  }

  /**
   * Initialize runtime components.
   * Creates state manager with projection triggers disabled (Bridge controls projection timing).
   */
  init() {
    if (this._initialized) return this;

    const eventsDir = path.join(this._runtimeDir, 'events');

    this._stateManager = new FileStateStore({
      runtimeDir: this._runtimeDir,
      outputDir: this._outputDir,
      projection: { enabled: false }, // Bridge controls projection timing
    });

    const backingStore = new JsonlEventStore({ eventsDir });
    this._eventStore = new RuntimeEventStore({ backingStore });

    this._projector = new RuntimeProjector(this._stateManager, this._eventStore);
    this._stateManager._projector = this._projector; // Inject for projection triggers

    this._validator = new ProjectionContractValidator();

    this._initialized = true;
    return this;
  }

  /**
   * Check if adapter is initialized.
   * @returns {boolean}
   */
  isInitialized() {
    return this._initialized;
  }

  /**
   * List all sessions in the runtime.
   * @returns {Array<{sessionId: string, status: string, updatedAt: string}>}
   */
  listSessions() {
    this._ensureInit();
    try {
      const index = this._stateManager._readIndex();
      const sessions = index.sessions || {};
      return Object.entries(sessions).map(([sessionId, data]) => ({
        sessionId,
        status: data.status,
        updatedAt: data.updatedAt,
      }));
    } catch (err) {
      return [];
    }
  }

  /**
   * Load a session by ID.
   * @param {string} sessionId
   * @returns {Object|null}
   */
  loadSession(sessionId) {
    this._ensureInit();
    return this._stateManager.loadSession(sessionId);
  }

  /**
   * Generate and optionally validate manifest projection.
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {boolean} [options.validate] — Validate against contract
   * @returns {{manifest: Object|null, validation?: Object, error?: string}}
   */
  generateManifest(sessionId, options = {}) {
    this._ensureInit();

    try {
      const manifest = this._projector.projectManifest(sessionId);

      if (!manifest) {
        return { manifest: null, error: `Session not found: ${sessionId}` };
      }

      const result = { manifest };

      const shouldValidate = options.validate !== undefined
        ? options.validate
        : this._projectionConfig.validate;

      if (shouldValidate) {
        result.validation = this._validator.validateManifest(manifest);
      }

      return result;
    } catch (err) {
      return { manifest: null, error: err.message };
    }
  }

  /**
   * Generate and optionally validate workflow status projection.
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {boolean} [options.validate] — Validate against contract
   * @returns {{workflowStatus: Object|null, validation?: Object, error?: string}}
   */
  generateWorkflowStatus(sessionId, options = {}) {
    this._ensureInit();

    try {
      const workflowStatus = this._projector.projectWorkflowStatus(sessionId);

      if (!workflowStatus) {
        return { workflowStatus: null, error: `Session not found: ${sessionId}` };
      }

      const result = { workflowStatus };

      const shouldValidate = options.validate !== undefined
        ? options.validate
        : this._projectionConfig.validate;

      if (shouldValidate) {
        result.validation = this._validator.validateWorkflowStatus(workflowStatus);
      }

      return result;
    } catch (err) {
      return { workflowStatus: null, error: err.message };
    }
  }

  /**
   * Generate both projections at once.
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {boolean} [options.validate] — Validate against contracts
   * @param {boolean} [options.writeLegacy] — Write to legacy output files
   * @returns {Object}
   */
  generateBoth(sessionId, options = {}) {
    this._ensureInit();

    const manifestResult = this.generateManifest(sessionId, options);
    const statusResult = this.generateWorkflowStatus(sessionId, options);

    const result = {
      manifest: manifestResult.manifest,
      workflowStatus: statusResult.workflowStatus,
      errors: [],
    };

    if (manifestResult.error) result.errors.push(manifestResult.error);
    if (statusResult.error) result.errors.push(statusResult.error);

    if (manifestResult.validation) {
      result.manifestValidation = manifestResult.validation;
    }
    if (statusResult.validation) {
      result.workflowStatusValidation = statusResult.validation;
    }

    if (options.writeLegacy) {
      result.written = this._writeLegacyOutputs(sessionId, manifestResult.manifest, statusResult.workflowStatus);
    }

    return result;
  }

  /**
   * Generate health trace for a session.
   * @param {string} sessionId
   * @returns {{trace: Array, error?: string}}
   */
  generateHealthTrace(sessionId) {
    this._ensureInit();

    try {
      const trace = this._projector.projectHealthTrace(sessionId);
      return { trace };
    } catch (err) {
      return { trace: [], error: err.message };
    }
  }

  /**
   * Write legacy projection outputs to disk.
   * @private
   * @param {string} sessionId
   * @param {Object} manifest
   * @param {Object} workflowStatus
   * @returns {{manifestPath?: string, workflowStatusPath?: string, errors: Array}}
   */
  _writeLegacyOutputs(sessionId, manifest, workflowStatus) {
    const fs = require('fs');
    const written = { errors: [] };

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      if (manifest) {
        const manifestPath = path.join(this._outputDir, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
        written.manifestPath = manifestPath;
      }

      if (workflowStatus) {
        const statusPath = path.join(this._outputDir, 'workflow-status.json');
        fs.writeFileSync(statusPath, JSON.stringify(workflowStatus, null, 2), 'utf-8');
        written.workflowStatusPath = statusPath;
      }
    } catch (err) {
      written.errors.push(err.message);
    }

    return written;
  }

  /**
   * Bridge-compatible command handler for projection generation.
   * Used by ide-workflow-bridge.js CLI.
   * @param {Object} args
   * @param {string} [args.sessionId] — Session ID (uses latest if not provided)
   * @param {string} [args.format='both'] — 'manifest' | 'status' | 'both' | 'trace'
   * @param {boolean} [args.validate=true] — Validate projections
   * @param {boolean} [args.writeLegacy=false] — Write to legacy files
   * @returns {Object}
   */
  handleProjectionCommand(args = {}) {
    this._ensureInit();

    const sessionId = args.sessionId || this._getLatestSessionId();
    if (!sessionId) {
      return { success: false, error: 'No session found. Run a workflow first.' };
    }

    const format = args.format || 'both';
    const validate = args.validate !== false;
    const writeLegacy = args.writeLegacy === true;

    try {
      switch (format) {
        case 'manifest': {
          const manifestResult = this.generateManifest(sessionId, { validate });
          if (writeLegacy && manifestResult.manifest) {
            this._writeLegacyOutputs(sessionId, manifestResult.manifest, null);
          }
          return {
            success: !manifestResult.error,
            sessionId,
            manifest: manifestResult.manifest,
            validation: manifestResult.validation,
            error: manifestResult.error,
          };
        }

        case 'status': {
          const statusResult = this.generateWorkflowStatus(sessionId, { validate });
          if (writeLegacy && statusResult.workflowStatus) {
            this._writeLegacyOutputs(sessionId, null, statusResult.workflowStatus);
          }
          return {
            success: !statusResult.error,
            sessionId,
            workflowStatus: statusResult.workflowStatus,
            validation: statusResult.validation,
            error: statusResult.error,
          };
        }

        case 'trace': {
          const traceResult = this.generateHealthTrace(sessionId);
          return {
            success: !traceResult.error,
            sessionId,
            trace: traceResult.trace,
            error: traceResult.error,
          };
        }

        case 'both':
        default: {
          const bothResult = this.generateBoth(sessionId, { validate, writeLegacy });
          return {
            success: bothResult.errors.length === 0,
            sessionId,
            manifest: bothResult.manifest,
            workflowStatus: bothResult.workflowStatus,
            manifestValidation: bothResult.manifestValidation,
            workflowStatusValidation: bothResult.workflowStatusValidation,
            errors: bothResult.errors.length > 0 ? bothResult.errors : undefined,
            written: bothResult.written,
          };
        }
      }
    } catch (err) {
      return { success: false, sessionId, error: err.message };
    }
  }

  /**
   * Get the most recent session ID.
   * @private
   * @returns {string|null}
   */
  _getLatestSessionId() {
    try {
      const sessions = this._stateManager.listSessions();
      if (sessions.length === 0) return null;

      sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return sessions[0].sessionId;
    } catch (_) {
      return null;
    }
  }

  /**
   * Ensure adapter is initialized.
   * @private
   */
  _ensureInit() {
    if (!this._initialized) {
      this.init();
    }
  }

  /**
   * Get current projection configuration.
   * @returns {Object}
   */
  getProjectionConfig() {
    return { ...this._projectionConfig };
  }

  /**
   * Update projection configuration.
   * @param {Object} config
   */
  setProjectionConfig(config) {
    if (config.enabled !== undefined) this._projectionConfig.enabled = config.enabled;
    if (config.sync !== undefined) this._projectionConfig.sync = config.sync;
    if (config.validate !== undefined) this._projectionConfig.validate = config.validate;
  }
}

module.exports = { RuntimeApiAdapter };
