'use strict';

const { STATE_MANAGER_METHODS } = require('./state-manager');
const { EVENT_STORE_METHODS } = require('./event-store');
const { RUNTIME_PROJECTOR_METHODS } = require('./runtime-projector');

/**
 * @param {Object} impl - The object to validate
 * @param {string[]} requiredMethods - List of method names that must exist
 * @param {string} contractName - Human-readable contract name for error messages
 * @returns {{ pass: boolean, missing: string[], extra: string[] }}
 */
function validateContract(impl, requiredMethods, contractName) {
  if (!impl || typeof impl !== 'object') {
    return { pass: false, missing: [...requiredMethods], extra: [] };
  }

  const implMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(impl))
    .filter(name => name !== 'constructor' && typeof impl[name] === 'function');

  const ownMethods = Object.keys(impl).filter(name => typeof impl[name] === 'function');
  const allImplMethods = new Set([...implMethods, ...ownMethods]);

  const missing = requiredMethods.filter(m => !allImplMethods.has(m));
  const extra = [...allImplMethods].filter(m => !requiredMethods.includes(m));

  return {
    pass: missing.length === 0,
    missing,
    extra,
  };
}

/**
 * @param {Object} impl
 * @returns {{ pass: boolean, missing: string[], extra: string[] }}
 */
function validateStateManager(impl) {
  return validateContract(impl, STATE_MANAGER_METHODS, 'IStateManager');
}

/**
 * @param {Object} impl
 * @returns {{ pass: boolean, missing: string[], extra: string[] }}
 */
function validateEventStore(impl) {
  return validateContract(impl, EVENT_STORE_METHODS, 'IEventStore');
}

/**
 * @param {Object} impl
 * @returns {{ pass: boolean, missing: string[], extra: string[] }}
 */
function validateRuntimeProjector(impl) {
  return validateContract(impl, RUNTIME_PROJECTOR_METHODS, 'IRuntimeProjector');
}

/**
 * @param {Object} impl
 * @returns {{ pass: boolean, results: Record<string, {pass: boolean, missing: string[], extra: string[]}> }}
 */
function validateAll(impl) {
  const results = {
    stateManager: validateStateManager(impl),
    eventStore: validateEventStore(impl),
    runtimeProjector: validateRuntimeProjector(impl),
  };
  return {
    pass: Object.values(results).every(r => r.pass),
    results,
  };
}

module.exports = { validateStateManager, validateEventStore, validateRuntimeProjector, validateAll };
