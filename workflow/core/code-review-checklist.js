/**
 * Code Review Checklist and Dimensions
 *
 * Extracted from code-review-agent.js for maintainability (ADR-41).
 * Contains the default review checklist, dimensions, and security coverage matrix.
 *
 * @module workflow/core/code-review-checklist
 */

'use strict';

// ─── Review Dimensions ───────────────────────────────────────────────────────

/**
 * AEF-inspired Review Dimensions (from workflow-code-review).
 * Used to categorise findings and support targeted re-review.
 */
const REVIEW_DIMENSIONS = {
  SPEC_COMPLIANCE: 'spec-compliance',   // Does the code match the spec?
  STANDARDS:       'standards',          // Does the code follow coding standards?
  PERFORMANCE:     'performance',        // Are there performance concerns?
  ROBUSTNESS:      'robustness',         // Are edge cases and errors handled?
};

/**
 * Maps each checklist item to its review dimension.
 * This enables targeted re-review: when fixing a PERF issue,
 * only the performance dimension is re-reviewed.
 */
const ITEM_TO_DIMENSION = {
  'SEC':    REVIEW_DIMENSIONS.ROBUSTNESS,
  'ERR':    REVIEW_DIMENSIONS.ROBUSTNESS,
  'PERF':   REVIEW_DIMENSIONS.PERFORMANCE,
  'STYLE':  REVIEW_DIMENSIONS.STANDARDS,
  'REQ':    REVIEW_DIMENSIONS.SPEC_COMPLIANCE,
  'SYNTAX': REVIEW_DIMENSIONS.STANDARDS,
  'EDGE':   REVIEW_DIMENSIONS.ROBUSTNESS,
  'INTF':   REVIEW_DIMENSIONS.SPEC_COMPLIANCE,
  'EXPORT': REVIEW_DIMENSIONS.STANDARDS,
  'CONST':  REVIEW_DIMENSIONS.STANDARDS,
};

// ─── Security Coverage Matrix ────────────────────────────────────────────────

/**
 * 10-dimension security coverage matrix, inspired by code-audit Skill article.
 * After a review pass, each dimension is checked: was it actually evaluated?
 * Dimensions with zero coverage are flagged as blind spots.
 */
const SECURITY_COVERAGE_DIMENSIONS = [
  { id: 'COV-INJ',    name: 'Injection',           checklistPrefixes: ['SEC-001'],          keywords: ['sql', 'nosql', 'injection', 'query', 'concatenat'] },
  { id: 'COV-AUTH',   name: 'AuthN/AuthZ',         checklistPrefixes: ['SEC-004'],          keywords: ['auth', 'permission', 'role', 'token', 'session', 'login'] },
  { id: 'COV-SECRET', name: 'Secrets Management',   checklistPrefixes: ['SEC-002'],          keywords: ['secret', 'password', 'key', 'token', 'credential', 'env'] },
  { id: 'COV-INPUT',  name: 'Input Validation',     checklistPrefixes: ['SEC-003'],          keywords: ['input', 'valid', 'sanitiz', 'escape', 'xss', 'csrf'] },
  { id: 'COV-ERRLEAK',name: 'Error Info Leak',      checklistPrefixes: ['ERR-003'],          keywords: ['stack', 'trace', 'leak', 'internal', 'debug'] },
  { id: 'COV-RACE',   name: 'Race Condition',       checklistPrefixes: [],                   keywords: ['race', 'concurren', 'atomic', 'lock', 'mutex', 'async'] },
  { id: 'COV-DOS',    name: 'Resource Exhaustion',  checklistPrefixes: ['PERF-001','PERF-002'], keywords: ['memory', 'leak', 'loop', 'timeout', 'limit', 'ddos'] },
  { id: 'COV-CRYPTO', name: 'Cryptography',         checklistPrefixes: [],                   keywords: ['encrypt', 'decrypt', 'hash', 'crypto', 'tls', 'ssl', 'bcrypt'] },
  { id: 'COV-ACCESS', name: 'Access Control',       checklistPrefixes: ['SEC-004'],          keywords: ['access', 'control', 'privilege', 'admin', 'sudo', 'root'] },
  { id: 'COV-AUDIT',  name: 'Audit Logging',        checklistPrefixes: [],                   keywords: ['audit', 'log', 'trail', 'forensic', 'evidence'] },
];

// ─── Default Checklist ────────────────────────────────────────────────────────

/**
 * Default code review checklist.
 * Each item has: id, category, severity, description, hint.
 * Callers can extend this via options.extraChecklist.
 */
const DEFAULT_CHECKLIST = [
  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'SEC-001', category: 'Security', severity: 'high',
    description: 'No SQL / NoSQL injection vulnerabilities',
    hint: 'Check for raw string concatenation in queries. Parameterised queries must be used.',
  },
  {
    id: 'SEC-002', category: 'Security', severity: 'high',
    description: 'No hardcoded secrets, tokens, or passwords',
    hint: 'Scan for string literals that look like API keys, passwords, or tokens.',
  },
  {
    id: 'SEC-003', category: 'Security', severity: 'high',
    description: 'All user inputs are validated and sanitised before use',
    hint: 'Every external input (HTTP params, file content, env vars) must be validated.',
  },
  {
    id: 'SEC-004', category: 'Security', severity: 'medium',
    description: 'Authentication and authorisation checks are present where required',
    hint: 'Protected routes/functions must verify identity and permissions.',
  },

  // ── Error Handling ────────────────────────────────────────────────────────
  {
    id: 'ERR-001', category: 'Error Handling', severity: 'high',
    description: 'All async operations have error handling (try/catch or .catch())',
    hint: 'Unhandled promise rejections crash Node.js. Every await must be guarded.',
  },
  {
    id: 'ERR-002', category: 'Error Handling', severity: 'medium',
    description: 'No silent error swallowing (empty catch blocks)',
    hint: 'catch(e) {} with no body hides bugs. At minimum log the error.',
  },
  {
    id: 'ERR-003', category: 'Error Handling', severity: 'medium',
    description: 'Error messages are informative and do not leak internal details',
    hint: 'Stack traces and DB errors must not be sent to clients.',
  },

  // ── Performance ───────────────────────────────────────────────────────────
  {
    id: 'PERF-001', category: 'Performance', severity: 'medium',
    description: 'No N+1 query patterns (queries inside loops)',
    hint: 'Database calls inside for/while loops cause N+1. Use batch queries.',
  },
  {
    id: 'PERF-002', category: 'Performance', severity: 'medium',
    description: 'No obvious memory leaks (event listeners removed, resources closed)',
    hint: 'Event listeners added in loops or without cleanup cause memory leaks.',
  },
  {
    id: 'PERF-003', category: 'Performance', severity: 'low',
    description: 'No synchronous blocking calls in async code paths',
    hint: 'fs.readFileSync, JSON.parse on large payloads block the event loop.',
  },

  // ── Code Style ────────────────────────────────────────────────────────────
  {
    id: 'STYLE-001', category: 'Code Style', severity: 'low',
    description: 'No dead code (commented-out blocks, unreachable branches)',
    hint: 'Dead code increases maintenance burden and confuses readers.',
  },
  {
    id: 'STYLE-002', category: 'Code Style', severity: 'low',
    description: 'No magic numbers or unexplained string literals',
    hint: 'Constants like 86400, "admin" should be named constants with comments.',
  },
  {
    id: 'STYLE-003', category: 'Code Style', severity: 'low',
    description: 'Function and variable names are descriptive and consistent',
    hint: 'Single-letter variables (except loop counters) and abbreviations reduce readability.',
  },

  // ── Requirements ──────────────────────────────────────────────────────────
  {
    id: 'REQ-001', category: 'Requirements', severity: 'high',
    description: 'All acceptance criteria from requirements.md are reflected in the diff',
    hint: 'Cross-check each acceptance criterion against the changed files.',
  },
  {
    id: 'REQ-002', category: 'Requirements', severity: 'medium',
    description: 'No features implemented that are NOT in requirements.md (scope creep)',
    hint: 'Extra features add untested surface area and delay delivery.',
  },

  // ── Syntax & Parseability ────────────────────────────────────────────────
  {
    id: 'SYNTAX-001', category: 'Syntax', severity: 'critical',
    description: 'All modified files are syntactically valid and parseable',
    hint: 'Check for unclosed brackets, broken comment blocks (e.g. JSDoc missing /** opener), unterminated strings, and mismatched template literals. A single broken comment can cascade into SyntaxError for the entire module.',
  },
  {
    id: 'SYNTAX-002', category: 'Syntax', severity: 'high',
    description: 'No broken JSDoc / multi-line comment blocks (missing /** or */)',
    hint: 'Look for multi-line comments that are missing the opening /** or closing */. These cause the JS parser to treat subsequent code as part of the comment, leading to cryptic SyntaxErrors far from the actual defect.',
  },

  // ── Edge Cases ────────────────────────────────────────────────────────────
  {
    id: 'EDGE-001', category: 'Edge Cases', severity: 'medium',
    description: 'Null / undefined inputs are handled gracefully',
    hint: 'Functions receiving external data must guard against null/undefined.',
  },
  {
    id: 'EDGE-002', category: 'Edge Cases', severity: 'medium',
    description: 'Empty collections and zero-length strings are handled',
    hint: 'arr[0] on an empty array returns undefined. Always check length.',
  },
  {
    id: 'EDGE-003', category: 'Edge Cases', severity: 'low',
    description: 'Numeric boundary values are handled (0, negative, MAX_SAFE_INTEGER)',
    hint: 'Off-by-one errors and integer overflow are common in boundary conditions.',
  },

  // ── Interface Contract ────────────────────────────────────────────────────
  {
    id: 'INTF-001', category: 'Interface Contract', severity: 'high',
    description: 'Function return objects contain all fields expected by callers',
    hint: 'Trace every property access on the return value in consuming modules. If a caller reads result.foo, the producing function must include foo in its return object.',
  },
  {
    id: 'INTF-002', category: 'Interface Contract', severity: 'medium',
    description: 'Enum/constant values used in comparisons match their definitions',
    hint: 'When code checks value === "foo", verify that the producer actually emits "foo" (not "Foo" or "FOO"). Cross-reference the constant definition file.',
  },

  // ── Export Completeness ───────────────────────────────────────────────────
  {
    id: 'EXPORT-001', category: 'Export Completeness', severity: 'medium',
    description: 'module.exports includes all symbols that are require()d by other modules',
    hint: 'Search for require("./this-file") across the codebase. Every destructured symbol in those require() calls must be present in module.exports.',
  },
  {
    id: 'EXPORT-002', category: 'Export Completeness', severity: 'low',
    description: 'Re-export barrel files (index.js) include newly added symbols from source modules',
    hint: 'When a new constant, class, or function is added to a module that is re-exported through index.js, the index.js import/export must be updated to include it.',
  },

  // ── Constant Consistency ──────────────────────────────────────────────────
  {
    id: 'CONST-001', category: 'Constant Consistency', severity: 'medium',
    description: 'No hardcoded string literals that duplicate an existing constant value',
    hint: 'If a file imports a Status/Type/Severity enum, all comparisons should use the constant (e.g. Status.RESOLVED), not a raw string ("resolved").',
  },
];

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  REVIEW_DIMENSIONS,
  ITEM_TO_DIMENSION,
  SECURITY_COVERAGE_DIMENSIONS,
  DEFAULT_CHECKLIST,
};
