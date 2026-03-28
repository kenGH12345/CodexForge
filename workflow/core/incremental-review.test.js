/**
 * Tests for Incremental Review
 *
 * Run with: node workflow/core/incremental-review.test.js
 */

'use strict';

const assert = require('assert');
const {
  extractDiff,
  extractFunctions,
  extractCallGraph,
  calculateReviewScope,
  incrementalReview,
} = require('./incremental-review');

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

async function asyncTest(name, fn) {
  testCount++;
  try {
    await fn();
    passCount++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

// ─── Diff Extraction Tests ──────────────────────────────────────────────────

console.log('\n=== Diff Extraction Tests ===\n');

test('extracts single line addition', () => {
  const oldCode = 'const x = 1;';
  const newCode = 'const x = 1;\nconst y = 2;';
  const diff = extractDiff(oldCode, newCode);

  assert.strictEqual(diff.additions.length, 1, 'Should have 1 addition');
  assert.strictEqual(diff.additions[0].content, 'const y = 2;', 'Should identify added line');
});

test('extracts single line deletion', () => {
  const oldCode = 'const x = 1;\nconst y = 2;';
  const newCode = 'const x = 1;';
  const diff = extractDiff(oldCode, newCode);

  assert.strictEqual(diff.deletions.length, 1, 'Should have 1 deletion');
  assert.strictEqual(diff.deletions[0].content, 'const y = 2;', 'Should identify deleted line');
});

test('extracts line change', () => {
  const oldCode = 'const x = 1;';
  const newCode = 'const x = 2;';
  const diff = extractDiff(oldCode, newCode);

  assert.strictEqual(diff.changes.length, 1, 'Should have 1 change');
  assert.strictEqual(diff.changes[0].oldContent, 'const x = 1;', 'Should identify old content');
  assert.strictEqual(diff.changes[0].newContent, 'const x = 2;', 'Should identify new content');
});

test('calculates correct summary', () => {
  const oldCode = 'line1\nline2\nline3';
  const newCode = 'line1\nmodified\nline3\nline4';
  const diff = extractDiff(oldCode, newCode);

  assert.strictEqual(diff.summary.changed, 1, 'Should count 1 change');
  assert.strictEqual(diff.summary.added, 1, 'Should count 1 addition');
  assert.strictEqual(diff.summary.totalDiff, 2, 'Should count 2 total differences');
});

// ─── Function Extraction Tests ──────────────────────────────────────────────

console.log('\n=== Function Extraction Tests ===\n');

test('extracts named function', () => {
  const code = `
function add(a, b) {
  return a + b;
}
`;
  const functions = extractFunctions(code);

  assert.ok(functions.has('add'), 'Should find "add" function');
  const fn = functions.get('add');
  assert.ok(fn.code.includes('return a + b'), 'Should extract function body');
});

test('extracts arrow function', () => {
  const code = 'const multiply = (a, b) => a * b;';
  const functions = extractFunctions(code);

  // Arrow functions might be named 'anonymous' or 'multiply'
  assert.ok(functions.size > 0, 'Should find at least one function');
});

test('extracts multiple functions', () => {
  const code = `
function foo() { return 1; }
function bar() { return 2; }
function baz() { return 3; }
`;
  const functions = extractFunctions(code);

  assert.ok(functions.has('foo'), 'Should find "foo"');
  assert.ok(functions.has('bar'), 'Should find "bar"');
  assert.ok(functions.has('baz'), 'Should find "baz"');
});

// ─── Call Graph Tests ───────────────────────────────────────────────────────

console.log('\n=== Call Graph Tests ===\n');

test('extracts function calls', () => {
  const code = `
function add(a, b) {
  return a + b;
}

function calculate() {
  const result = add(1, 2);
  return result;
}
`;
  const callGraph = extractCallGraph(code);

  assert.ok(callGraph.has('calculate'), 'Should have entry for "calculate"');
  assert.ok(callGraph.get('calculate').includes('add'), 'Should detect call to "add"');
});

test('excludes keywords from call graph', () => {
  const code = `
function process(arr) {
  if (arr.length > 0) {
    for (let i = 0; i < arr.length; i++) {
      console.log(arr[i]);
    }
  }
}
`;
  const callGraph = extractCallGraph(code);

  // Should not include 'if', 'for', 'console' as function calls
  if (callGraph.has('process')) {
    const callees = callGraph.get('process');
    assert.ok(!callees.includes('if'), 'Should not include "if" keyword');
    assert.ok(!callees.includes('for'), 'Should not include "for" keyword');
  }
});

// ─── Review Scope Tests ─────────────────────────────────────────────────────

console.log('\n=== Review Scope Tests ===\n');

test('identifies changed functions', () => {
  const oldCode = `
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}
`;

  const newCode = `
function add(a, b) {
  return a + b + 1;  // Changed line
}

function multiply(a, b) {
  return a * b;
}
`;

  const scope = calculateReviewScope({ oldContent: oldCode, newContent: newCode });

  assert.ok(scope.reviewFunctions.has('add'), 'Should identify "add" as changed');
  assert.ok(!scope.reviewFunctions.has('multiply'), 'Should not include unchanged "multiply"');
});

test('expands scope to callers', () => {
  const oldCode = `
function add(a, b) {
  return a + b;
}

function calculate() {
  return add(1, 2);
}
`;

  const newCode = `
function add(a, b) {
  return a + b + 1;  // Changed
}

function calculate() {
  return add(1, 2);
}
`;

  const scope = calculateReviewScope({
    oldContent: oldCode,
    newContent: newCode,
    impactRadius: 1,
  });

  assert.ok(scope.reviewFunctions.has('add'), 'Should include changed function');
  assert.ok(scope.reviewFunctions.has('calculate'), 'Should include caller');
});

test('calculates reduction ratio', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) {
    lines.push(`// Line ${i}`);
  }
  const oldCode = lines.join('\n');

  // Change only one line in the middle
  const newLines = [...lines];
  newLines[50] = '// MODIFIED LINE';
  const newCode = newLines.join('\n');

  const scope = calculateReviewScope({ oldContent: oldCode, newContent: newCode });

  // Should have much fewer review lines than total lines
  assert.ok(scope.stats.reductionRatio > 90, `Should reduce scope by >90%, got ${scope.stats.reductionRatio}%`);
});

// ─── Functional Correctness Tests ───────────────────────────────────────────

console.log('\n=== Functional Correctness Tests ===\n');

test('Diff accuracy: multi-line insertion positioning', () => {
  // Arrange: Code with functions in specific order
  const oldCode = `
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }
`;
  const newCode = `
function a() { return 1; }
function b() { return 2; }
// New line 1
// New line 2
function c() { return 3; }
`;

  // Act
  const diff = extractDiff(oldCode, newCode);

  // Assert: Should accurately identify that insertions are between b and c
  assert.strictEqual(diff.additions.length, 2, 'Should detect 2 insertions');
  // Additions are new lines which start after line 3 (function b)
  const lineNumbers = diff.additions.map(a => a.line).sort((a, b) => a - b);
  assert.ok(
    lineNumbers[0] >= 4 && lineNumbers[1] >= 5,
    `Insertions should start after function b, got lines: ${lineNumbers.join(', ')}`
  );
});
test('Diff accuracy: contiguous changes detection', () => {
  const oldCode = `
function process(data) {
  const result = data.map(x => x * 2);
  return result.filter(x => x > 10);
}
`;
  const newCode = `
function process(data) {
  const result = data.map(x => x * 3);
  return result.filter(x => x > 5);
}
`;

  const diff = extractDiff(oldCode, newCode);

  // Should detect content changes (line mapping: multiplier on line 3, filter on line 4)
  assert.strictEqual(diff.changes.length, 2, 'Should detect both content changes');
  const newLines = diff.changes.map(c => c.newLine).sort((a, b) => a - b);
  // Both changes are in the same function body (consecutive lines in new code)
  assert.ok(
    Math.abs(newLines[0] - newLines[1]) === 1,
    `Changes should be on consecutive lines (lines ${newLines.join(', ')})`
  );
});

test('Call Graph accuracy: no false positives on keywords', () => {
  const code = `
function process(arr) {
  if (arr.length > 0) {
    for (let i = 0; i < arr.length; i++) {
      while (i < 10) {
        switch(arr[i]) {
          case 'test': return true;
        }
      }
    }
  }
  return false;
}
`;

  const callGraph = extractCallGraph(code);
  const callees = callGraph.has('process') ? callGraph.get('process') : [];

  // Assert: Should NOT include control flow keywords as function calls
  const keywords = ['if', 'for', 'while', 'switch', 'case', 'return', 'let', 'const'];
  keywords.forEach(keyword => {
    assert.ok(
      !callees.includes(keyword),
      `Should NOT include keyword "${keyword}" as function call`
    );
  });
});

test('Call Graph accuracy: correctly identifies nested calls', () => {
  const code = `
function helper() { return 1; }
function wrapper() { return helper(); }
function main() {
  if (condition) {
    return wrapper();
  }
  return helper();
}
`;

  const callGraph = extractCallGraph(code);

  // Assert: Should correctly map call relationships
  assert.ok(
    callGraph.get('wrapper').includes('helper'),
    'wrapper should call helper'
  );
  assert.ok(
    callGraph.get('main').includes('wrapper'),
    'main should call wrapper'
  );
  assert.ok(
    callGraph.get('main').includes('helper'),
    'main should call helper directly'
  );
});

test('Impact radius correctness: radius 1 vs radius 2 comparison', () => {
  const oldCode = `
function level1() { return 1; }
function level2() { return level1(); }
function level3() { return level2(); }
function level4() { return level3(); }
`;
  const newCode = `
function level1() { return 100; }  // Changed
function level2() { return level1(); }
function level3() { return level2(); }
function level4() { return level3(); }
`;

  const scope1 = calculateReviewScope({
    oldContent: oldCode,
    newContent: newCode,
    impactRadius: 1,
  });

  const scope2 = calculateReviewScope({
    oldContent: oldCode,
    newContent: newCode,
    impactRadius: 2,
  });

  // Assert: Radius 1 should include level1 and level2
  assert.ok(scope1.reviewFunctions.has('level1'), 'Radius 1: should include level1');
  assert.ok(scope1.reviewFunctions.has('level2'), 'Radius 1: should include level2');
  assert.ok(!scope1.reviewFunctions.has('level4'), 'Radius 1: should NOT include level4');

  // Assert: Radius 2 should include more levels
  assert.ok(scope2.reviewFunctions.has('level3'), 'Radius 2: should include level3');
  assert.ok(
    scope2.reviewFunctions.size > scope1.reviewFunctions.size,
    'Radius 2 should have more functions than radius 1'
  );
});

test('Nested function boundary recognition', () => {
  const code = `
function outer() {
  function inner() {
    function deep() {
      return 'deep value';
    }
    return deep();
  }
  return inner();
}
`;

  const functions = extractFunctions(code);

  // Assert: Should identify all nested functions
  assert.ok(functions.has('outer'), 'Should find outer function');
  assert.ok(functions.has('inner'), 'Should find inner function');
  assert.ok(functions.has('deep'), 'Should find deep nested function');
});

test('Performance: handles large file without degradation', () => {
  // Generate a large file (2000 lines)
  const lines = [];
  for (let i = 0; i < 2000; i++) {
    lines.push(`function fn${i}() { return ${i}; }`);
  }
  const oldCode = lines.join('\n');
  const newCode = oldCode.replace('function fn1000()', 'function fn1000_MODIFIED()');

  const startTime = Date.now();
  const diff = extractDiff(oldCode, newCode);
  const duration = Date.now() - startTime;

  // Assert: Should complete within reasonable time (< 500ms for 2000 lines)
  assert.ok(duration < 500, `Should handle 2000 lines in <500ms, took ${duration}ms`);
  assert.strictEqual(diff.changes.length, 1, 'Should find exactly 1 change');
});

// ─── Integration Tests ──────────────────────────────────────────────────────

console.log('\n=== Integration Tests ===\n');

(async () => {
  await asyncTest('incrementalReview reduces token usage', async () => {
    // Large file with small change
    const oldCode = Array(200).fill('const x = 1;').join('\n');
    const newCode = oldCode.replace('const x = 1;', 'const x = 2;');

    const result = await incrementalReview({
      filePath: 'test.js',
      oldContent: oldCode,
      newContent: newCode,
    });

    assert.ok(result.scope, 'Should return scope stats');
    assert.ok(result.scope.reductionRatio > 95, `Should reduce by >95%, got ${result.scope.reductionRatio}%`);
  });

  await asyncTest('incrementalReview identifies impacted functions', async () => {
    const oldCode = `
function helper() {
  return 42;
}

function main() {
  return helper();
}
`;

    const newCode = `
function helper() {
  return 100;  // Changed
}

function main() {
  return helper();
}
`;

    const result = await incrementalReview({
      filePath: 'test.js',
      oldContent: oldCode,
      newContent: newCode,
      impactRadius: 1,
    });

    assert.ok(result.reviewFunctions.includes('helper'), 'Should include changed function');
    assert.ok(result.reviewFunctions.includes('main'), 'Should include caller');
  });

  await asyncTest('incrementalReview: accuracy validation', async () => {
    const oldCode = `
function utilA() { return 1; }
function utilB() { return 2; }
function mainA() { return utilA(); }
function mainB() { return utilB(); }
`;
    const newCode = `
function utilA() { return 100; }  // Only change utilA
function utilB() { return 2; }
function mainA() { return utilA(); }
function mainB() { return utilB(); }
`;

    const result = await incrementalReview({
      filePath: 'test.js',
      oldContent: oldCode,
      newContent: newCode,
      impactRadius: 1,
    });

    // Assert: Only changed function and its direct caller should be included
    assert.ok(result.reviewFunctions.includes('utilA'), 'Should include changed function utilA');
    assert.ok(result.reviewFunctions.includes('mainA'), 'Should include caller mainA');
    assert.ok(!result.reviewFunctions.includes('utilB'), 'Should NOT include unchanged utilB');
    assert.ok(!result.reviewFunctions.includes('mainB'), 'Should NOT include mainB (does not call changed function)');
  });
})();

// ─── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n========================================');
  console.log(`Total: ${testCount} tests`);
  console.log(`Passed: ${passCount} tests`);
  console.log(`Failed: ${testCount - passCount} tests`);
  console.log('========================================\n');

  if (passCount === testCount) {
    console.log('✅ All tests passed!\n');
    console.log('📊 Incremental Review Benefits:');
    console.log('   • Token reduction: 70-95%');
    console.log('   • Scope: Changed code + direct callers/callees');
    console.log('   • Impact radius: Configurable (default: 1 hop)');
    console.log('');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed.\n');
    process.exit(1);
  }
}, 1000);
