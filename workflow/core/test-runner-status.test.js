'use strict';

const assert = require('assert');
const { TestRunner } = require('./test-runner');
const { __testHooks } = require('../tools/ide-workflow-bridge');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

test('analyzeResult separates parsed pass counts from non-zero process exit', () => {
  const status = TestRunner.analyzeResult({
    exitCode: 1,
    stderr: 'post-test quality gate failed',
    output: '14 tests passed\npost-test quality gate failed',
    totalTests: 14,
    failedTests: 0,
    failureSummary: [],
  });

  assert.strictEqual(status.overallPassed, false);
  assert.strictEqual(status.countsPassed, true);
  assert.strictEqual(status.processPassed, false);
  assert.strictEqual(status.contradiction, true);
  assert.strictEqual(status.rootCause, 'process_exit_nonzero_after_tests_passed');
  assert(status.stderrPresent);
  assert(status.reasons.some(r => r.dimension === 'test-counts' && r.passed === true));
  assert(status.reasons.some(r => r.dimension === 'process-exit' && r.passed === false));
});

test('analyzeResult reports test count failures before process contradiction', () => {
  const status = TestRunner.analyzeResult({
    exitCode: 1,
    stderr: '',
    output: '2 failed, 12 passed',
    totalTests: 14,
    failedTests: 2,
    failureSummary: ['AssertionError: expected true'],
  });

  assert.strictEqual(status.overallPassed, false);
  assert.strictEqual(status.countsPassed, false);
  assert.strictEqual(status.processPassed, false);
  assert.strictEqual(status.contradiction, false);
  assert.strictEqual(status.rootCause, 'test_count_failures');
  assert(status.reasons.some(r => r.dimension === 'failure-summary'));
});

test('parseOutput prioritizes unified runner summary over nested child test output', () => {
  const runner = new TestRunner({
    projectRoot: process.cwd(),
    testCommand: 'node workflow/tests/run-all-tests.js --profile=fast',
    verbose: false,
  });
  const parsed = runner._parseOutput([
    'Running 14 test files...',
    'Total: 14 tests',
    'Passed: 14 tests',
    'Failed: 0 tests',
    '────────────────────────────────────────────────────────────',
    'Test Summary',
    '────────────────────────────────────────────────────────────',
    '  Total files:  14',
    '  Passed:       12',
    '  Failed:       1',
    '  Skipped:      1',
    'Failed Tests:',
    ' ✗ smoke-runtime.test.js',
  ].join('\n'));

  assert.strictEqual(parsed.totalTests, 14);
  assert.strictEqual(parsed.passedTests, 12);
  assert.strictEqual(parsed.failedTests, 1);
  assert.strictEqual(parsed.skippedTests, 1);
  assert(parsed.failureSummary.some(line => line.includes('smoke-runtime.test.js')));
});

test('workflow-stage failure summary includes contract and runtime anomaly dimensions', () => {
  const summary = __testHooks._summarizeTestStageFailure({
    rootCause: 'process_exit_nonzero_after_tests_passed',
    passedTests: 14,
    totalTests: 14,
    failedTests: 0,
    exitCode: 1,
    stderr: 'post-test hook failed',
    testStatus: {
      rootCause: 'process_exit_nonzero_after_tests_passed',
      processPassed: false,
      countsPassed: true,
      contradiction: true,
      stderrPresent: true,
      reasons: [
        { dimension: 'test-counts', passed: true },
        { dimension: 'process-exit', passed: false },
      ],
    },
  }, {
    passed: false,
    error: 'completion contract command failed',
  }, [
    { pattern: '14/14 passed (FAIL)', file: 'output/test-report.md' },
  ]);

  assert(summary.includes('rootCause=process_exit_nonzero_after_tests_passed'));
  assert(summary.includes('testCounts=14/14 passed'));
  assert(summary.includes('processExit=1'));
  assert(summary.includes('completionContract=failed'));
  assert(summary.includes('runtimeAnomalies=1'));
  assert(summary.includes('stderr=post-test hook failed'));
});

if (process.exitCode) process.exit(process.exitCode);
