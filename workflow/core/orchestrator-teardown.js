/**
 * Orchestrator Teardown – Finalization Logic Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from orchestrator-lifecycle.js.
 * Contains the teardown/finalization methods mixed into Orchestrator.prototype:
 *   - _finalizeWorkflow()     – shared teardown sequence
 *
 * This is a FORWARDING module – it re-exports the _finalizeWorkflow method
 * from orchestrator-teardown-impl.js to maintain backward compatibility.
 *
 * The actual implementation lives in orchestrator-teardown-impl.js which is
 * too large to inline here (contains ~700 lines of teardown logic).
 *
 * @module orchestrator-teardown
 */

'use strict';

// Re-export the teardown implementation from the impl file
const { OrchestratorTeardownMixin } = require('./orchestrator-teardown-impl');

module.exports = { OrchestratorTeardownMixin };
