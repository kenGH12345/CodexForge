/**
 * Module Audit Checkers – Per-module validation functions
 *
 * This module provides granular module-level checks:
 *   - Module completeness (entry, logic, error handling, exports)
 *   - Naming consistency
 *   - Data flow integrity
 *   - Architecture constraints
 *   - Historical pitfall detection
 */

'use strict';

const { IssuePriority, FixRisk } = require('./self-audit-types');

// ─── Size Limits by Module Type ─────────────────────────────────────────────

const SIZE_LIMITS = {
  'core/': 400,
  'agents/': 300,
  'index.js': 600,
  'default': 500,
};

// ─── Module Completeness Checker ────────────────────────────────────────────

/**
 * Checks if a module is complete (entry, logic, error handling, exports).
 *
 * @param {object} module - Module object with name, path, content
 * @param {string} stage - Stage name
 * @returns {object[]} Array of issues found
 */
function checkModuleCompleteness(module, stage) {
  const issues = [];
  const content = module.content || '';

  if (stage === 'CODE') {
    // Check for entry point (function/class definition)
    const hasEntry = /(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=|export\s+)/.test(content);
    if (!hasEntry) {
      issues.push({
        type: 'incomplete-module',
        title: 'Missing entry point',
        description: `Module ${module.name} has no function/class definition or exports`,
        evidence: 'No function/class/const/export found in module content',
      });
    }

    // Check for error handling
    const hasErrorHandling = /(?:try\s*\{|catch\s*\(|throw\s+|\.catch\s*\()/.test(content);
    if (!hasErrorHandling && content.length > 200) {
      issues.push({
        type: 'missing-error-handling',
        title: 'Missing error handling',
        description: `Module ${module.name} has no try-catch or error handling for ${content.length} chars of code`,
        evidence: 'No try/catch/throw/.catch found in module content',
      });
    }

    // Check for TODO/FIXME stubs
    const hasStubs = /(?:TODO|FIXME|HACK|XXX|STUB)/i.test(content);
    if (hasStubs) {
      issues.push({
        type: 'incomplete-module',
        title: 'Contains stub/placeholder code',
        description: `Module ${module.name} contains TODO/FIXME/HACK markers`,
        evidence: content.match(/(?:TODO|FIXME|HACK|XXX|STUB)[^\n]*/i)?.[0] || 'Stub found',
      });
    }
  }

  return issues;
}

// ─── Naming Consistency Checker ──────────────────────────────────────────────

/**
 * Checks naming consistency within a module.
 *
 * @param {object} module - Module object
 * @param {string} stage - Stage name
 * @returns {object[]} Array of issues found
 */
function checkNamingConsistency(module, stage) {
  const issues = [];
  const content = module.content || '';

  // Check for camelCase vs snake_case mixing
  const camelCase = content.match(/[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g) || [];
  const snakeCase = content.match(/[a-z]+_[a-z_]+/g) || [];

  if (camelCase.length > 5 && snakeCase.length > 5) {
    const camelExamples = camelCase.slice(0, 3).join(', ');
    const snakeExamples = snakeCase.slice(0, 3).join(', ');
    issues.push({
      type: 'naming-consistency',
      title: 'Mixed naming conventions',
      description: `Module ${module.name} mixes camelCase (${camelExamples}) and snake_case (${snakeExamples})`,
      evidence: 'Both naming styles detected in same module',
    });
  }

  return issues;
}

// ─── Data Flow Checker ───────────────────────────────────────────────────────

/**
 * Checks data flow (producer-consumer links).
 *
 * @param {object} module - Module object
 * @param {string} stage - Stage name
 * @param {object} context - Audit context
 * @returns {object[]} Array of issues found
 */
function checkDataFlow(module, stage, context) {
  const issues = [];
  const content = module.content || '';

  // Check for orphan outputs (produced but never used)
  const exports = content.match(/export\s+(?:const|let|var|function|class)\s+(\w+)/g) || [];
  const localUsage = exports.map(e => {
    const name = e.replace(/export\s+(?:const|let|var|function|class)\s+/, '');
    const usagePattern = new RegExp(`\\b${name}\\b`, 'g');
    const usages = (content.match(usagePattern) || []).length;
    return { name, usages };
  });

  const orphans = localUsage.filter(u => u.usages <= 1);
  if (orphans.length > 0) {
    issues.push({
      type: 'data-flow-break',
      title: 'Potential orphan exports',
      description: `Module ${module.name} has ${orphans.length} export(s) with no internal usage: ${orphans.map(o => o.name).join(', ')}`,
      evidence: `Exports without usage: ${orphans.map(o => o.name).join(', ')}`,
    });
  }

  return issues;
}

// ─── Architecture Constraints Checker ────────────────────────────────────────

/**
 * Checks architecture constraints (file size, IDE-first).
 *
 * @param {object} module - Module object
 * @param {string} stage - Stage name
 * @returns {object[]} Array of issues found
 */
function checkArchitectureConstraints(module, stage) {
  const issues = [];
  const content = module.content || '';

  // Determine size limit based on module path
  let sizeLimit = SIZE_LIMITS.default;
  for (const [prefix, limit] of Object.entries(SIZE_LIMITS)) {
    if (prefix !== 'default' && module.path.startsWith(prefix)) {
      sizeLimit = limit;
      break;
    }
  }
  if (module.path === 'index.js' || module.path.endsWith('/index.js')) {
    sizeLimit = SIZE_LIMITS['index.js'];
  }

  const lineCount = content.split('\n').length;
  if (lineCount > sizeLimit) {
    issues.push({
      type: 'architecture-violation',
      title: 'File size exceeds limit',
      description: `Module ${module.name} has ${lineCount} lines, exceeds limit of ${sizeLimit}`,
      evidence: `Line count: ${lineCount}, limit: ${sizeLimit}`,
    });
  }

  return issues;
}

// ─── Historical Pitfalls Checker ─────────────────────────────────────────────

/**
 * Checks for historical pitfalls from reflections.
 *
 * @param {object} module - Module object
 * @param {string} stage - Stage name
 * @param {object[]} knownPitfalls - Array of known pitfall patterns
 * @returns {object[]} Array of issues found
 */
function checkHistoricalPitfalls(module, stage, knownPitfalls = []) {
  const issues = [];
  const content = module.content || '';

  for (const pitfall of knownPitfalls) {
    if (pitfall.pattern) {
      try {
        const regex = new RegExp(pitfall.pattern, 'i');
        if (regex.test(content)) {
          issues.push({
            type: 'historical-pitfall',
            title: `Repeats known pitfall: ${pitfall.title}`,
            description: `Module ${module.name} contains pattern similar to past issue: ${pitfall.title}`,
            evidence: `Pattern ${pitfall.pattern} matched`,
            severity: pitfall.severity,
          });
        }
      } catch (_) { /* Invalid regex, skip */ }
    }
  }

  return issues;
}

// ─── Run All Checks ──────────────────────────────────────────────────────────

/**
 * Runs all module-level checks and returns combined issues.
 *
 * @param {object} module - Module object
 * @param {string} stage - Stage name
 * @param {object} context - Audit context
 * @param {object[]} [knownPitfalls=[]] - Known pitfall patterns
 * @returns {object[]} Array of all issues found
 */
function runAllChecks(module, stage, context, knownPitfalls = []) {
  return [
    ...checkModuleCompleteness(module, stage),
    ...checkNamingConsistency(module, stage),
    ...checkDataFlow(module, stage, context),
    ...checkArchitectureConstraints(module, stage),
    ...checkHistoricalPitfalls(module, stage, knownPitfalls),
  ];
}

module.exports = {
  checkModuleCompleteness,
  checkNamingConsistency,
  checkDataFlow,
  checkArchitectureConstraints,
  checkHistoricalPitfalls,
  runAllChecks,
  SIZE_LIMITS,
};
