/**
 * Workflow Introspection Manager
 *
 * Central management module for the workflow introspection system.
 * Provides a simplified API for initializing, using, and reporting
 * on the 7 core modules' activity and consistency.
 *
 * This is the main entry point - most code should use this instead
 * of the individual modules directly.
 *
 * Usage:
 *   const { introspectionManager } = require('./introspection-manager');
 *
 *   // Initialize at workflow start
 *   introspectionManager.initialize({ sessionId, outputDir });
 *
 *   // During workflow execution, log events via the collector
 *   introspectionManager.collector.recordSkill('registered', { skillName: 'go_crud' });
 *
 *   // At workflow end, generate reports
 *   introspectionManager.generateReports();
 *   introspectionManager.finalize();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { WorkflowIntrospectionCollector, introspectionCollector } = require('./workflow-introspection-collector');
const { ConsistencyValidator } = require('./consistency-validator');
const { IntrospectionReportGenerator } = require('./introspection-report-generator');

// ─── Introspection Manager ─────────────────────────────────────────────────────

class IntrospectionManager {
  constructor() {
    this.collector = introspectionCollector;
    this._validator = null;
    this._generator = null;
    this._initialized = false;
    this._config = {
      enabled: true,
      autoGenerateReports: true,
      validationCategories: ['skill-prompt', 'experience-skill', 'architecture-scan', 'framework-experience', 'data-flow', 'version'],
    };
  }

  /**
   * Initialize the introspection system.
   *
   * @param {object} options
   * @param {string} options.sessionId - Unique session identifier
   * @param {string} options.outputDir - Output directory for reports
   * @param {boolean} [options.enabled=true] - Whether introspection is enabled
   * @param {boolean} [options.autoGenerateReports=true] - Auto-generate reports on finalize
   * @param {string[]} [options.validationCategories] - Categories to validate
   */
  initialize(options) {
    const { sessionId, outputDir, enabled = true, autoGenerateReports = true, validationCategories } = options;

    this._config.enabled = enabled;
    this._config.autoGenerateReports = autoGenerateReports;
    if (validationCategories) {
      this._config.validationCategories = validationCategories;
    }

    if (!enabled) {
      console.log('[IntrospectionManager] Introspection disabled');
      return;
    }

    this.collector.initialize({ sessionId, outputDir, enabled });
    this._validator = new ConsistencyValidator(this.collector);
    this._generator = new IntrospectionReportGenerator(this.collector, this._validator);
    this._initialized = true;

    console.log(`[IntrospectionManager] Initialized for session: ${sessionId}`);
  }

  /**
   * Set the current workflow stage.
   * This helps organize logs by workflow phase.
   *
   * @param {string} stage
   */
  setStage(stage) {
    if (!this._config.enabled) return;
    this.collector.setStage(stage);
  }

  /**
   * Validate consistency across all modules.
   *
   * @returns {object} Validation report
   */
  validate() {
    if (!this._config.enabled || !this._validator) {
      return { summary: { totalIssues: 0, errors: 0, warnings: 0, passRate: 100 } };
    }
    return this._validator.validateAll();
  }

  /**
   * Validate a specific category.
   *
   * @param {string} category
   * @returns {object} Validation report
   */
  validateCategory(category) {
    if (!this._config.enabled || !this._validator) {
      return { summary: { totalIssues: 0, errors: 0, warnings: 0, passRate: 100 } };
    }
    return this._validator.validateCategory(category);
  }

  /**
   * Generate reports (JSON and Markdown).
   *
   * @returns {{ jsonPath: string, markdownPath: string }}
   */
  generateReports() {
    if (!this._config.enabled || !this._generator || !this.collector._outputDir) {
      console.warn('[IntrospectionManager] Cannot generate reports - not initialized');
      return { jsonPath: null, markdownPath: null };
    }

    const result = this._generator.generateBoth(this.collector._outputDir);
    console.log(`[IntrospectionManager] Reports generated:`, result);
    return result;
  }

  /**
   * Finalize the introspection session.
   * Persists logs and optionally generates final reports.
   */
  finalize() {
    if (!this._config.enabled) return;

    // Persist raw introspection data
    const logPath = this.collector.persist();
    if (logPath) {
      console.log(`[IntrospectionManager] Introspection log persisted: ${logPath}`);
    }

    // Generate reports if enabled
    if (this._config.autoGenerateReports) {
      this.generateReports();
    }

    // Print summary
    const stats = this.collector.getStats();
    console.log(`[IntrospectionManager] Session summary:`, stats);

    this._initialized = false;
  }

  /**
   * Get current session statistics.
   *
   * @returns {object}
   */
  getStats() {
    if (!this._config.enabled) {
      return { totalEntries: 0, uniqueTraces: 0, byModule: {}, moduleCoverage: 0 };
    }
    return this.collector.getStats();
  }

  /**
   * Check if the system is initialized.
   * @returns {boolean}
   */
  isInitialized() {
    return this._initialized;
  }

  /**
   * Get a quick health check summary.
   *
   * @returns {{ healthy: boolean, issues: object, suggestion: string }}
   */
  healthCheck() {
    if (!this._config.enabled) {
      return { healthy: true, issues: {}, suggestion: 'Introspection disabled' };
    }

    const validation = this.validate();
    const stats = this.getStats();

    const healthy = validation.summary.errors === 0 && validation.summary.warnings <= 3;

    let suggestion = '';
    if (validation.summary.errors > 0) {
      suggestion = `Fix ${validation.summary.errors} critical consistency issues`;
    } else if (validation.summary.warnings > 3) {
      suggestion = `Review ${validation.summary.warnings} warnings for potential issues`;
    } else if (stats.moduleCoverage < 7) {
      const inactive = 7 - stats.moduleCoverage;
      suggestion = `${inactive} modules have no activity recorded`;
    } else {
      suggestion = 'All systems operating normally';
    }

    return {
      healthy,
      issues: {
        errors: validation.summary.errors,
        warnings: validation.summary.warnings,
      },
      moduleCoverage: `${stats.moduleCoverage}/7`,
      suggestion,
    };
  }

  /**
   * Subscribe to workflow hooks for automatic stage tracking.
   *
   * @param {HookSystem} hooks - The orchestrator's HookSystem instance
   */
  hookSubscribe(hooks) {
    if (!this._config.enabled || !hooks) return;

    const { HOOK_EVENTS } = require('./constants');

    // Track stage transitions
    hooks.on(HOOK_EVENTS.BEFORE_STATE_TRANSITION, (payload) => {
      if (payload?.toState) {
        this.setStage(payload.toState);
        this.collector.record('State', 'transition_start', {
          fromState: payload.fromState,
          toState: payload.toState,
          artifactPath: payload.artifactPath,
          rollback: payload.rollback || false,
          jump: payload.jump || false,
        });
      }
    });

    hooks.on(HOOK_EVENTS.AFTER_STATE_TRANSITION, (payload) => {
      if (payload?.toState) {
        this.collector.record('State', 'transition_complete', {
          fromState: payload.fromState,
          toState: payload.toState,
          artifactPath: payload.artifactPath,
          rollback: payload.rollback || false,
          jump: payload.jump || false,
        });
      }
    });

    // Track workflow lifecycle
    hooks.on(HOOK_EVENTS.WORKFLOW_COMPLETE, (payload) => {
      this.collector.record('Workflow', 'completed', {
        finalState: payload?.manifest?.currentState,
        historyLength: payload?.manifest?.history?.length || 0,
      });
      console.log('[IntrospectionManager] Workflow completion detected, finalizing...');
    });

    hooks.on(HOOK_EVENTS.WORKFLOW_ERROR, (payload) => {
      this.collector.record('Workflow', 'error', {
        error: payload?.error?.message || 'Unknown error',
        state: payload?.state,
      });
    });

    // Track agent executions
    hooks.on(HOOK_EVENTS.AGENT_START, (payload) => {
      if (payload?.agent) {
        this.collector.record('Agent', 'execution_start', {
          agentName: payload.agent,
          inputPath: payload.inputPath,
        });
      }
    });

    hooks.on(HOOK_EVENTS.AGENT_COMPLETE, (payload) => {
      if (payload?.agent) {
        this.collector.record('Agent', 'execution_complete', {
          agentName: payload.agent,
          outputPath: payload.outputPath,
          duration: payload.duration,
        });
      }
    });

    console.log('[IntrospectionManager] Subscribed to workflow hooks');
  }

  /**
   * Clear all collected data.
   * Use with caution - typically only for testing.
   */
  clear() {
    if (this.collector) {
      this.collector.clear();
    }
    console.log('[IntrospectionManager] All introspection data cleared');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const introspectionManager = new IntrospectionManager();

// ─── Convenience Exports ──────────────────────────────────────────────────────

module.exports = {
  introspectionManager,
  IntrospectionManager,
  
  // Re-export for direct access if needed
  WorkflowIntrospectionCollector,
  introspectionCollector,
  ConsistencyValidator,
  IntrospectionReportGenerator,
};