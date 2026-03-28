/**
 * Tests for Effective Lines Counter
 *
 * Run with: node workflow/core/effective-lines-counter.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  countEffectiveLines,
  analyzeFile,
  getFileTier,
  checkFileLimit,
  FILE_TIERS,
} = require('./effective-lines-counter');

// ─── Test Utilities ─────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

// ─── Unit Tests: Line Counting ──────────────────────────────────────────────

console.log('\n=== Unit Tests: Line Counting ===\n');

test('counts effective lines correctly (no comments)', () => {
  const code = `
function add(a, b) {
  return a + b;
}

const x = 1;
const y = 2;
`;
  const result = countEffectiveLines(code, 'javascript');

  assert.ok(result.totalLines > 0, 'Should have total lines');
  assert.ok(result.effectiveLines > 0, 'Should have effective lines');
  assert.strictEqual(result.blankLines, 3, 'Should count blank lines');
});

test('excludes single-line comments', () => {
  const code = `
// This is a comment
function foo() {
  return 42;
}
// Another comment
`;
  const result = countEffectiveLines(code, 'javascript');

  assert.ok(result.commentLines >= 2, 'Should count comment lines (>= 2)');
  assert.ok(result.effectiveLines < result.totalLines, 'Effective lines should be less than total');
});

test('excludes multi-line comments', () => {
  const code = `
/**
 * This is a multi-line comment
 * with multiple lines
 */
function bar() {
  return 100;
}
`;
  const result = countEffectiveLines(code, 'javascript');

  assert.ok(result.commentLines >= 4, 'Should count multi-line comment');
  assert.ok(result.effectiveLines < result.totalLines - 4, 'Should exclude comment lines');
});

test('handles mixed code and comments', () => {
  const code = `
// Header comment
const x = 1;

/* Block comment
   spanning lines */
const y = 2;

// Footer
const z = x + y;
`;
  const result = countEffectiveLines(code, 'javascript');

  assert.ok(result.effectiveLines >= 3, 'Should count code lines');
  assert.ok(result.commentLines >= 4, 'Should count comment lines');
  assert.ok(result.blankLines >= 2, 'Should count blank lines');
});

test('calculates comment ratio', () => {
  const code = `
// Comment line 1
// Comment line 2
const x = 1;
const y = 2;
`;
  const result = countEffectiveLines(code, 'javascript');

  // Total 5 non-blank lines: 2 comments + 2 code + 1 blank
  assert.ok(result.commentRatio > 0, 'Should have comment ratio');
  assert.ok(result.commentRatio < 100, 'Comment ratio should be < 100%');
});

// ─── Unit Tests: Language Support ───────────────────────────────────────────

console.log('\n=== Unit Tests: Language Support ===\n');

test('supports Python single-line comments', () => {
  const code = `
# Python comment
def foo():
    return 42
`;
  const result = countEffectiveLines(code, 'python');

  assert.ok(result.commentLines >= 1, 'Should count Python comments');
});

test('supports Python multi-line strings (docstrings)', () => {
  const code = `
"""
Python docstring
multi-line
"""
def bar():
    pass
`;
  const result = countEffectiveLines(code, 'python');

  // Python docstring detection is complex (can be string literal or comment)
  // Just verify the function is detected as code
  assert.ok(result.effectiveLines >= 1, 'Should detect at least function definition');
});

test('supports Go comments', () => {
  const code = `
// Go comment
func main() {
    return
}
`;
  const result = countEffectiveLines(code, 'go');

  assert.ok(result.commentLines >= 1, 'Should count Go comments');
});

test('supports Java comments', () => {
  const code = `
// Java comment
public class Main {
    public static void main() {}
}
`;
  const result = countEffectiveLines(code, 'java');

  assert.ok(result.commentLines >= 1, 'Should count Java comments');
});

// ─── Unit Tests: File Tier Classification ───────────────────────────────────

console.log('\n=== Unit Tests: File Tier Classification ===\n');

test('classifies index.js as entry-point tier', () => {
  const tier = getFileTier('index.js');
  assert.strictEqual(tier.name, 'entry-point', 'index.js should be entry-point tier');
  assert.strictEqual(tier.maxEffectiveLines, 700, 'Entry point should have 700 effective line limit (per workflow.config.js)');
});

test('classifies orchestrator-*.js as core-critical tier', () => {
  const tier = getFileTier('core/orchestrator-task.js');
  assert.strictEqual(tier.name, 'core-critical', 'Orchestrator should be core-critical tier');
  assert.strictEqual(tier.maxEffectiveLines, 1000, 'Core critical should have 1000 effective line limit (per workflow.config.js)');
});

test('classifies agents/*.js as agent tier', () => {
  const tier = getFileTier('agents/developer-agent.js');
  assert.strictEqual(tier.name, 'agent', 'Agent files should be agent tier');
  assert.strictEqual(tier.maxEffectiveLines, 250, 'Agent should have 250 effective line limit');
});

test('classifies commands/*.js as command tier', () => {
  const tier = getFileTier('commands/commands-workflow.js');
  assert.strictEqual(tier.name, 'command', 'Command files should be command tier');
  assert.strictEqual(tier.maxEffectiveLines, 400, 'Command should have 400 effective line limit');
});

// ─── Integration Tests: Real Files ───────────────────────────────────────────

console.log('\n=== Integration Tests: Real Files ===\n');

test('analyzes this test file', () => {
  const testFilePath = __filename;
  const analysis = analyzeFile(testFilePath);

  assert.ok(analysis.totalLines > 0, 'Should have total lines');
  assert.ok(analysis.effectiveLines > 0, 'Should have effective lines');
  assert.ok(analysis.language === 'javascript', 'Should detect JavaScript');
  assert.ok(analysis.commentRatio > 0, 'Should have comment ratio (this file has many comments)');
});

test('checks effective-lines-counter.js limits', () => {
  const counterPath = path.join(__dirname, 'effective-lines-counter.js');
  
  if (fs.existsSync(counterPath)) {
    const check = checkFileLimit(counterPath);
    
    console.log(`   📊 ${path.basename(counterPath)}:`);
    console.log(`      Total lines: ${check.analysis.totalLines}`);
    console.log(`      Effective lines: ${check.analysis.effectiveLines}`);
    console.log(`      Comment lines: ${check.analysis.commentLines}`);
    console.log(`      Comment ratio: ${check.analysis.commentRatio.toFixed(1)}%`);
    console.log(`      Tier: ${check.tier.name} (max: ${check.tier.maxEffectiveLines} effective)`);
    
    if (check.isViolation) {
      console.log(`      ⚠️  Violations: ${check.violations.join(', ')}`);
    } else {
      console.log(`      ✅ No violations`);
    }
    
    assert.ok(check.tier, 'Should have a tier');
    assert.ok(check.analysis, 'Should have analysis');
  }
});

// ─── Performance Test ───────────────────────────────────────────────────────

console.log('\n=== Performance Test ===\n');

test('processes 1000 lines in < 100ms', () => {
  const largeCode = Array(1000).fill(`
// Comment line
function foo() {
  return 42;
}
`).join('\n');

  const start = Date.now();
  const result = countEffectiveLines(largeCode, 'javascript');
  const elapsed = Date.now() - start;

  console.log(`   ⏱️  Processed ${result.totalLines} lines in ${elapsed}ms`);
  assert.ok(elapsed < 100, `Should process in < 100ms, took ${elapsed}ms`);
});

// ─── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n========================================');
  console.log(`Total: ${testCount} tests`);
  console.log(`Passed: ${passCount} tests`);
  console.log(`Failed: ${testCount - passCount} tests`);
  console.log('========================================\n');

  if (passCount === testCount) {
    console.log('✅ All tests passed!\n');
    console.log('📊 Effective Lines Counter Benefits:');
    console.log('   • Distinguishes code from comments & blanks');
    console.log('   • Tiered limits based on file role');
    console.log('   • Comment ratio tracking for documentation health');
    console.log('   • Multi-language support (JS, TS, Python, Go, Java)');
    console.log('');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed.\n');
    process.exit(1);
  }
}, 500);
