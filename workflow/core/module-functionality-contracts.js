/**
 * Module Functionality Contracts – Unified validation layer
 *
 * Architecture:
 *   - agent-functionality-contracts.js: Agent contracts (~150 lines)
 *   - core-module-functionality-contracts.js: Core module contracts (~80 lines)
 *   - module-functionality-contracts.js: THIS FILE - Validation logic (~120 lines)
 *
 * This enables SelfAudit to ask: "Is this module working as designed?"
 */

'use strict';

const { AGENT_FUNCTIONALITY_CONTRACTS, ANALYST_FUNCTIONALITY, ARCHITECT_FUNCTIONALITY, PLANNER_FUNCTIONALITY, DEVELOPER_FUNCTIONALITY, TESTER_FUNCTIONALITY } = require('./agent-functionality-contracts');
const { CORE_MODULE_CONTRACTS, STATE_MACHINE_FUNCTIONALITY, EXPERIENCE_STORE_FUNCTIONALITY, SELF_REFLECTION_FUNCTIONALITY } = require('./core-module-functionality-contracts');

// ─── Unified Registry ─────────────────────────────────────────────────────────

const MODULE_FUNCTIONALITY_CONTRACTS = {
  ...AGENT_FUNCTIONALITY_CONTRACTS,
  ...CORE_MODULE_CONTRACTS,
};

// ─── Validation Functions ─────────────────────────────────────────────────────

/**
 * Validates a module's output against its functionality contract.
 *
 * @param {string} moduleName - Module name (e.g., 'AnalystAgent')
 * @param {object} output - The output to validate (e.g., parsed JSON block)
 * @returns {{ valid: boolean, violations: string[], warnings: string[] }}
 */
function validateModuleFunctionality(moduleName, output) {
  const contract = MODULE_FUNCTIONALITY_CONTRACTS[moduleName];
  if (!contract) {
    return { valid: true, violations: [], warnings: [`No functionality contract for module: ${moduleName}`] };
  }

  const violations = [];
  const warnings = [];
  const jsonBlock = output;

  for (const rule of contract.validationRules) {
    try {
      // Safe evaluation using Function constructor with limited scope
      // This is safer than eval() as it doesn't have access to local scope
      const result = _safeEval(rule.check, { jsonBlock });
      if (!result) {
        if (rule.severity === 'error') {
          violations.push(`[${rule.name}] ${rule.errorMessage}`);
        } else {
          warnings.push(`[${rule.name}] ${rule.errorMessage}`);
        }
      }
    } catch (err) {
      warnings.push(`[${rule.name}] Could not evaluate rule: ${err.message}`);
    }
  }

  return { valid: violations.length === 0, violations, warnings };
}

/**
 * Safe expression evaluator.
 * Uses Function constructor with explicit scope binding.
 * @param {string} expr - Expression to evaluate
 * @param {object} scope - Variables to expose to the expression
 * @returns {boolean}
 */
function _safeEval(expr, scope) {
  // Build function parameters and arguments from scope
  const params = Object.keys(scope);
  const args = Object.values(scope);
  
  // Create a function with the expression as its body
  // The expression must return a boolean
  const fn = new Function(...params, `return (${expr});`);
  return fn(...args);
}

/**
 * Gets the functionality contract for a module.
 */
function getModuleFunctionalityContract(moduleName) {
  return MODULE_FUNCTIONALITY_CONTRACTS[moduleName];
}

/**
 * Lists all modules with functionality contracts.
 */
function listModuleFunctionalityContracts() {
  return Object.keys(MODULE_FUNCTIONALITY_CONTRACTS);
}

/**
 * Generates a functionality audit question for SelfAuditSocratic.
 */
function generateFunctionalityAuditQuestion(moduleName, actualOutput) {
  const contract = MODULE_FUNCTIONALITY_CONTRACTS[moduleName];
  if (!contract) {
    return {
      question: `Is ${moduleName} working correctly?`,
      context: 'No functionality contract defined for this module.',
      expectedBehavior: 'Unknown',
    };
  }

  const { valid, violations, warnings } = validateModuleFunctionality(moduleName, actualOutput);
  const status = valid ? '✅ Passed' : '❌ Failed';

  return {
    question: `Is ${moduleName} producing output that matches its expected behavior?`,
    context: [
      `**Expected:** ${contract.expectedBehavior.description}`,
      `**Postconditions:** ${contract.expectedBehavior.postconditions.join('; ')}`,
      `**Validation:** ${status}`,
      violations.length > 0 ? `**Violations:** ${violations.join('; ')}` : '',
      warnings.length > 0 ? `**Warnings:** ${warnings.join('; ')}` : '',
    ].filter(Boolean).join('\n'),
    expectedBehavior: contract.expectedBehavior.description,
  };
}

module.exports = {
  MODULE_FUNCTIONALITY_CONTRACTS,
  ANALYST_FUNCTIONALITY,
  ARCHITECT_FUNCTIONALITY,
  PLANNER_FUNCTIONALITY,
  DEVELOPER_FUNCTIONALITY,
  TESTER_FUNCTIONALITY,
  STATE_MACHINE_FUNCTIONALITY,
  EXPERIENCE_STORE_FUNCTIONALITY,
  SELF_REFLECTION_FUNCTIONALITY,
  validateModuleFunctionality,
  getModuleFunctionalityContract,
  listModuleFunctionalityContracts,
  generateFunctionalityAuditQuestion,
};
