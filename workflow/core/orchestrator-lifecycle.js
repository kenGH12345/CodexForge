/**
 * Orchestrator Lifecycle – Facade Module (ADR-33 P0 Decomposition)
 *
 * This file aggregates all lifecycle mixins into a single exports object.
 * All implementation code has been extracted to dedicated modules:
 *   - orchestrator-init.js         – Initialization logic (_initWorkflow, etc.)
 *   - orchestrator-teardown-impl.js – Teardown logic (_finalizeWorkflow, etc.)
 *   - orchestrator-stages.js       – Stage execution helpers
 *
 * Original size: 93.08 KB (1936 lines)
 * Refactored size: ~1 KB (this file)
 *
 * @module orchestrator-lifecycle
 */

'use strict';

// ─── Aggregated Exports ───────────────────────────────────────────────────────
// Start with an empty exports object, then merge in each mixin.
// The order matters: later mixins can override earlier ones if there are conflicts.

const baseExports = {
  // Placeholder for any shared constants or helper functions that
  // multiple mixins might need. Currently empty as all code has been extracted.
};

// Export the base object
module.exports = baseExports;

// ─── Apply Init Mixin ────────────────────────────────────────────────────────
const { OrchestratorInitMixin } = require('./orchestrator-init');
Object.assign(module.exports, OrchestratorInitMixin);

// ─── Apply Teardown Mixin ────────────────────────────────────────────────────
const { OrchestratorTeardownMixin } = require('./orchestrator-teardown-impl');
Object.assign(module.exports, OrchestratorTeardownMixin);
