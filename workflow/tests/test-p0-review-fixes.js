/**
 * P0 Review Fix Tests: getModuleSummaryMarkdown + checkModuleBoundaryViolation
 *
 * Covers:
 *   A. CodeGraph.getModuleSummaryMarkdown() — directory aggregation, cross-dir deps, empty graph
 *   B. QualityGate.checkModuleBoundaryViolation() — clean pass, violations, edge cases, glob patterns
 */

'use strict';

const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. CodeGraph.getModuleSummaryMarkdown()
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. CodeGraph.getModuleSummaryMarkdown ─────────────────────');

test('returns empty string when graph has no symbols', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: '.', outputDir: '.', llmCall: null });
  // _symbols is empty by default, and _loadFromDisk will fail silently
  cg._symbols = new Map();
  const result = cg.getModuleSummaryMarkdown();
  assertEqual(result, '', 'Empty graph should return empty string');
});

test('returns empty string when all symbols are in a single directory', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: '.', outputDir: '.', llmCall: null });
  cg._symbols = new Map();
  cg._importEdges = new Map();
  // Add symbols in the same directory
  cg._symbols.set('sym-1', { file: 'src/foo.js', kind: 'function', name: 'foo', summary: '' });
  cg._symbols.set('sym-2', { file: 'src/bar.js', kind: 'class', name: 'Bar', summary: '' });
  const result = cg.getModuleSummaryMarkdown();
  // Only 1 directory (src) → should return empty
  assertEqual(result, '', 'Single-directory graph should return empty string');
});

test('generates markdown table with multiple directories', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: '.', outputDir: '.', llmCall: null });
  cg._symbols = new Map();
  cg._importEdges = new Map();

  // Add symbols in different directories
  cg._symbols.set('sym-1', { file: 'src/auth/login.js', kind: 'function', name: 'loginUser', summary: 'Handles user login flow' });
  cg._symbols.set('sym-2', { file: 'src/auth/logout.js', kind: 'function', name: 'logoutUser', summary: 'Handles user logout' });
  cg._symbols.set('sym-3', { file: 'src/auth/token.js', kind: 'class', name: 'TokenManager', summary: 'Manages JWT tokens for authentication' });
  cg._symbols.set('sym-4', { file: 'src/db/connection.js', kind: 'class', name: 'DBConnection', summary: 'Database connection pool manager' });
  cg._symbols.set('sym-5', { file: 'src/db/query.js', kind: 'function', name: 'executeQuery', summary: 'Executes parameterized SQL queries' });

  const result = cg.getModuleSummaryMarkdown();

  // Should contain markdown table
  assert.ok(result.includes('## 📦 Codebase Module Structure'), 'Should have header');
  assert.ok(result.includes('| Directory |'), 'Should have table header');
  assert.ok(result.includes('src/auth') || result.includes('src\\auth'), 'Should include auth directory');
  assert.ok(result.includes('src/db') || result.includes('src\\db'), 'Should include db directory');
});

test('respects maxDirs option', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: '.', outputDir: '.', llmCall: null });
  cg._symbols = new Map();
  cg._importEdges = new Map();

  // Create symbols in 5 directories
  for (let i = 0; i < 5; i++) {
    cg._symbols.set(`sym-${i}`, { file: `src/mod${i}/index.js`, kind: 'function', name: `func${i}`, summary: `Module ${i} function` });
  }

  const result = cg.getModuleSummaryMarkdown({ maxDirs: 3 });
  // Count table data rows (lines starting with |, excluding header and separator)
  const tableRows = result.split('\n').filter(l => l.startsWith('| `'));
  assert.ok(tableRows.length <= 3, `Should have at most 3 directory rows, got ${tableRows.length}`);
});

test('includes cross-directory dependencies when import edges exist', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: '.', outputDir: '.', llmCall: null });
  cg._symbols = new Map();
  cg._importEdges = new Map();

  cg._symbols.set('sym-1', { file: 'src/auth/login.js', kind: 'function', name: 'loginUser', summary: 'Login handler' });
  cg._symbols.set('sym-2', { file: 'src/db/users.js', kind: 'class', name: 'UserStore', summary: 'User database store' });

  // auth/login.js imports from db/users.js
  cg._importEdges.set('src/auth/login.js', ['src/db/users.js']);

  const result = cg.getModuleSummaryMarkdown();
  assert.ok(result.includes('Cross-Directory Dependencies'), 'Should include cross-directory deps section');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. QualityGate.checkModuleBoundaryViolation()
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── B. QualityGate.checkModuleBoundaryViolation ──────────────');

const { QualityGate } = require('../core/quality-gate');

test('returns clean when all files within boundaries (/** pattern)', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/auth/login.js', 'src/auth/middleware/jwt.js', 'src/auth/utils/hash.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/**'] }
  );
  assertEqual(result.clean, true, 'All files within src/auth/** should be clean');
  assertEqual(result.violations.length, 0, 'No violations expected');
});

test('detects violations for files outside boundaries', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/auth/login.js', 'src/db/connection.js', 'src/auth/logout.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/**'] }
  );
  assertEqual(result.clean, false, 'Should detect violation');
  assertEqual(result.violations.length, 1, 'One file outside boundary');
  assert.ok(result.violations[0].includes('src/db/connection.js'), 'Violating file should be db/connection.js');
});

test('supports /* pattern (single-level match)', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/auth/login.js', 'src/auth/nested/deep.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/*'] }
  );
  assertEqual(result.clean, false, 'Nested file should violate /* pattern');
  assertEqual(result.violations.length, 1, 'One violation');
  assert.ok(result.violations[0].includes('nested/deep.js'), 'Deep file is the violation');
});

test('supports prefix* pattern (e.g. src/middleware/auth*)', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/middleware/authMiddleware.js', 'src/middleware/authGuard.js', 'src/middleware/logging.js'],
    { moduleId: 'mod-auth-mw', boundaries: ['src/middleware/auth*'] }
  );
  assertEqual(result.clean, false, 'logging.js should violate');
  assertEqual(result.violations.length, 1, 'One violation');
  assert.ok(result.violations[0].includes('logging.js'), 'logging.js is the violation');
});

test('supports multiple boundary patterns (OR semantics)', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/auth/login.js', 'src/middleware/authGuard.js', 'src/db/users.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/**', 'src/middleware/auth*'] }
  );
  // auth/login.js → matches src/auth/**
  // middleware/authGuard.js → matches src/middleware/auth*
  // db/users.js → matches neither
  assertEqual(result.clean, false, 'db file should violate');
  assertEqual(result.violations.length, 1, 'One violation');
  assert.ok(result.violations[0].includes('db/users.js'), 'db/users.js is the violation');
});

test('handles backslash normalization in file paths', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src\\auth\\login.js', 'src\\auth\\logout.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/**'] }
  );
  assertEqual(result.clean, true, 'Backslash paths should be normalized and match');
  assertEqual(result.violations.length, 0, 'No violations after normalization');
});

test('returns clean with no-op message for empty inputs', () => {
  // Empty files
  const r1 = QualityGate.checkModuleBoundaryViolation([], { moduleId: 'x', boundaries: ['src/**'] });
  assertEqual(r1.clean, true, 'Empty files list should be clean');

  // Null moduleScope
  const r2 = QualityGate.checkModuleBoundaryViolation(['a.js'], null);
  assertEqual(r2.clean, true, 'Null moduleScope should be clean');

  // Empty boundaries
  const r3 = QualityGate.checkModuleBoundaryViolation(['a.js'], { moduleId: 'x', boundaries: [] });
  assertEqual(r3.clean, true, 'Empty boundaries should be clean');
});

test('summary includes module ID and violating file names', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/auth/login.js', 'src/other/hack.js', 'src/other/inject.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/**'] }
  );
  assert.ok(result.summary.includes('mod-auth'), 'Summary should mention module ID');
  assert.ok(result.summary.includes('2/3'), 'Summary should show violation count ratio');
});

test('exact match works (no wildcard)', () => {
  const result = QualityGate.checkModuleBoundaryViolation(
    ['src/config.js', 'src/other.js'],
    { moduleId: 'mod-config', boundaries: ['src/config.js'] }
  );
  assertEqual(result.clean, false, 'Only exact match should pass');
  assertEqual(result.violations.length, 1, 'other.js is outside');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`  P0 Review Fix Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
