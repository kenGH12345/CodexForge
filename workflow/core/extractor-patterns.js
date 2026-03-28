/**
 * Business Logic Extractor Patterns
 *
 * Entry point patterns, naming conventions, and symbol classification rules.
 * Extracted from business-logic-extractor.js for maintainability.
 *
 * @module workflow/core/extractor-patterns
 */

'use strict';

// ─── Entry Point Patterns ─────────────────────────────────────────────────────

/**
 * Common entry point naming patterns across languages/frameworks.
 * These patterns identify functions/methods that are likely entry points
 * for business logic flows.
 */
const ENTRY_POINT_PATTERNS = {
  // HTTP/API handlers
  handlers: [
    /^handle[A-Z]/,           // handleLogin, handleRequest
    /^process[A-Z]/,          // processPayment, processOrder
    /^execute[A-Z]/,          // executeCommand, executeTask
    /^run[A-Z]/,              // runJob, runMigration
    /^dispatch[A-Z]/,         // dispatchEvent, dispatchAction
    /^on[A-Z]/,               // onClick, onSubmit (event handlers)
  ],
  // Controller actions
  controllers: [
    /^(get|post|put|delete|patch)[A-Z]/,  // getUser, postOrder
    /^(create|read|update|delete)[A-Z]/,  // createUser, readOrder
    /^(list|search|find)[A-Z]/,           // listUsers, searchProducts
  ],
  // Service methods
  services: [
    /^(validate|verify|check)[A-Z]/,      // validateUser, verifyToken
    /^(calculate|compute)[A-Z]/,          // calculateTotal, computeScore
    /^(transform|convert|parse)[A-Z]/,    // transformData, parseResponse
    /^(send|receive|fetch|load)[A-Z]/,    // sendEmail, fetchUser
    /^(save|persist|store)[A-Z]/,         // saveOrder, persistData
  ],
  // Background jobs / tasks
  jobs: [
    /^(schedule|queue|enqueue)[A-Z]/,     // scheduleTask, queueJob
    /^(start|stop|init|bootstrap)[A-Z]/,  // startServer, initApp
  ],
};

/**
 * Patterns that indicate a symbol is NOT a business logic entry point.
 * These are typically infrastructure, logging, or utility functions.
 */
const NON_ENTRY_PATTERNS = [
  /^(log|warn|error|info|debug|trace)$/i,
  /^(get|set|has|add|remove|delete|clear)$/i,
  /^(toString|valueOf|toJSON|parse|stringify)$/i,
  /^(clone|copy|deepClone|shallowClone)$/i,
  /^(map|filter|reduce|forEach|find|some|every)$/i,
  /^(test|match|replace|split|join|trim|slice)$/i,
];

/**
 * Patterns indicating a symbol belongs to a specific architectural layer.
 */
const LAYER_PATTERNS = {
  controller: [
    /controller/i,
    /handler/i,
    /route/i,
    /endpoint/i,
  ],
  service: [
    /service/i,
    /manager/i,
    /facade/i,
    /orchestrator/i,
  ],
  repository: [
    /repository/i,
    /dao/i,
    /store/i,
    /mapper/i,
  ],
  model: [
    /model/i,
    /entity/i,
    /domain/i,
    /aggregate/i,
  ],
  util: [
    /util/i,
    /helper/i,
    /common/i,
    /shared/i,
  ],
};

/**
 * Core service category thresholds.
 */
const CATEGORY_THRESHOLDS = {
  foundation: { minCalledBy: 10, maxCallsOut: 5 },
  hub: { minCalledBy: 5, minCallsOut: 5 },
  leaf: { maxCalledBy: 3, minCallsOut: 0 },
  isolated: { maxCalledBy: 1, maxCallsOut: 1 },
};

// ─── Pattern Matching Functions ───────────────────────────────────────────────

/**
 * Checks if a symbol name matches any entry point pattern.
 *
 * @param {string} symbolName - Symbol name to check
 * @returns {{ isEntryPoint: boolean, category: string|null }}
 */
function matchEntryPointPattern(symbolName) {
  if (!symbolName || typeof symbolName !== 'string') {
    return { isEntryPoint: false, category: null };
  }

  // First check non-entry patterns
  for (const pattern of NON_ENTRY_PATTERNS) {
    if (pattern.test(symbolName)) {
      return { isEntryPoint: false, category: null };
    }
  }

  // Check each category
  for (const [category, patterns] of Object.entries(ENTRY_POINT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(symbolName)) {
        return { isEntryPoint: true, category };
      }
    }
  }

  return { isEntryPoint: false, category: null };
}

/**
 * Determines the architectural layer of a symbol.
 *
 * @param {string} symbolName - Symbol name
 * @param {string} filePath - File path (optional, for additional context)
 * @returns {string} Layer name (controller, service, repository, model, util, unknown)
 */
function determineLayer(symbolName, filePath = '') {
  const combined = `${symbolName} ${filePath}`.toLowerCase();

  for (const [layer, patterns] of Object.entries(LAYER_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        return layer;
      }
    }
  }

  return 'unknown';
}

/**
 * Classifies a symbol into a category based on call metrics.
 *
 * @param {number} calledByCount - Number of incoming calls
 * @param {number} callsOutCount - Number of outgoing calls
 * @returns {string} Category (foundation, hub, leaf, isolated)
 */
function classifyByCallMetrics(calledByCount, callsOutCount) {
  if (calledByCount >= CATEGORY_THRESHOLDS.foundation.minCalledBy &&
      callsOutCount <= CATEGORY_THRESHOLDS.foundation.maxCallsOut) {
    return 'foundation';
  }

  if (calledByCount >= CATEGORY_THRESHOLDS.hub.minCalledBy &&
      callsOutCount >= CATEGORY_THRESHOLDS.hub.minCallsOut) {
    return 'hub';
  }

  if (calledByCount <= CATEGORY_THRESHOLDS.leaf.maxCalledBy) {
    return 'leaf';
  }

  if (calledByCount <= CATEGORY_THRESHOLDS.isolated.maxCalledBy &&
      callsOutCount <= CATEGORY_THRESHOLDS.isolated.maxCallsOut) {
    return 'isolated';
  }

  return 'normal';
}

/**
 * Calculates an importance weight for a symbol.
 * Used for ranking symbols in call chain tracing.
 *
 * @param {object} symbol - Symbol object with metrics
 * @param {number} symbol.calledByCount - Incoming call count
 * @param {number} symbol.callsOutCount - Outgoing call count
 * @param {string} symbol.category - Symbol category
 * @returns {number} Importance weight (higher = more important)
 */
function calculateImportanceWeight(symbol) {
  if (!symbol) return 0;

  let weight = 0;

  // Called-by count is the strongest signal
  weight += (symbol.calledByCount || 0) * 10;

  // Category bonus
  if (symbol.category === 'foundation') weight += 20;
  if (symbol.category === 'hub') weight += 15;

  // Layer bonus
  const layer = determineLayer(symbol.name || '', symbol.file || '');
  if (layer === 'service') weight += 10;
  if (layer === 'controller') weight += 5;

  // Entry point bonus
  const { isEntryPoint } = matchEntryPointPattern(symbol.name);
  if (isEntryPoint) weight += 5;

  return weight;
}

/**
 * Filters out noise symbols from a call chain.
 * Noise symbols are typically getters, setters, or trivial utilities.
 *
 * @param {string[]} chain - Array of symbol names
 * @returns {string[]} Filtered chain
 */
function filterNoiseFromChain(chain) {
  if (!chain || !Array.isArray(chain)) return [];

  const NOISE_PATTERNS = [
    /^get[A-Z][a-z]*$/,      // Simple getters: getName, getId
    /^set[A-Z][a-z]*$/,      // Simple setters: setName, setId
    /^is[A-Z][a-z]*$/,       // Boolean getters: isValid, isActive
    /^has[A-Z][a-z]*$/,      // Boolean checks: hasPermission
    /^_[a-z]+$/,             // Private trivial methods
  ];

  return chain.filter(name => {
    // Keep symbols that don't match noise patterns
    return !NOISE_PATTERNS.some(p => p.test(name));
  });
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Pattern definitions
  ENTRY_POINT_PATTERNS,
  NON_ENTRY_PATTERNS,
  LAYER_PATTERNS,
  CATEGORY_THRESHOLDS,

  // Pattern matching functions
  matchEntryPointPattern,
  determineLayer,
  classifyByCallMetrics,
  calculateImportanceWeight,
  filterNoiseFromChain,
};
