/**
 * Unified Test Runner for WorkFlowAgent
 *
 * Run all tests: node workflow/tests/run-all-tests.js
 * Run with filter: node workflow/tests/run-all-tests.js --filter=integration
 * Run specific file: node workflow/tests/run-all-tests.js --file=effective-lines
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Test suites configuration
const TEST_SUITES = {
  unit: {
    name: 'Unit Tests',
    files: [
      'workflow/core/effective-lines-counter.test.js',
      'workflow/core/incremental-review.test.js',
      'workflow/core/module-review-tracker.test.js',
      'workflow/core/scheduler.test.js',
      'workflow/core/write-around-review.test.js',
      'workflow/core/code-graph-lite.test.js',
      'workflow/core/code-review-agent.test.js',
      'workflow/core/state-machine-lite.test.js',
      'workflow/core/stage-runners.test.js',
      'workflow/core/experience-router-lite.test.js',
      'workflow/core/skill-enrichment.test.js',
      'workflow/core/orchestrator-suite.test.js',
    ],
  },
  integration: {
    name: 'Integration Tests',
    files: [
      'workflow/core/integration-effective-lines.test.js',
      'workflow/core/integration-pipeline-flow.test.js',
      'workflow/core/integration-agent-fusion.test.js',
      'workflow/core/integration-framework-fusion.test.js',
    ],
  },
};

// Parse CLI arguments
const args = process.argv.slice(2);
const filter = args.find(a => a.startsWith('--filter='))?.split('=')[1];
const specificFile = args.find(a => a.startsWith('--file='))?.split('=')[1];
const verbose = args.includes('--verbose');
const failFast = args.includes('--fail-fast');

// Color codes for terminal output
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function color(name, text) {
  if (process.env.NO_COLOR) return text;
  return `${COLORS[name]}${text}${COLORS.reset}`;
}

console.log('\n' + color('bright', '╔════════════════════════════════════════════════════════════╗'));
console.log(color('bright', '║     WorkFlowAgent Unified Test Runner                     ║'));
console.log(color('bright', '╚════════════════════════════════════════════════════════════╝'));
console.log();

// Build test list based on filters
let testsToRun = [];

if (specificFile) {
  // Find file by partial name match
  for (const [type, suite] of Object.entries(TEST_SUITES)) {
    const matched = suite.files.filter(f => f.includes(specificFile));
    testsToRun.push(...matched.map(f => ({ file: f, type })));
  }
} else if (filter) {
  // Filter by suite type
  if (TEST_SUITES[filter]) {
    testsToRun = TEST_SUITES[filter].files.map(f => ({ file: f, type: filter }));
  } else {
    console.error(color('red', `Error: Unknown filter "${filter}". Available: unit, integration`));
    process.exit(1);
  }
} else {
  // Run all tests
  for (const [type, suite] of Object.entries(TEST_SUITES)) {
    testsToRun.push(...suite.files.map(f => ({ file: f, type })));
  }
}

if (testsToRun.length === 0) {
  console.error(color('red', 'Error: No tests found matching criteria'));
  process.exit(1);
}

console.log(color('cyan', `Running ${testsToRun.length} test ${testsToRun.length === 1 ? 'file' : 'files'}...\n`));

// Results tracking
const results = {
  passed: [],
  failed: [],
  skipped: [],
  total: testsToRun.length,
};

const startTime = Date.now();

// Run each test file
for (const { file, type } of testsToRun) {
  const filePath = path.resolve(file);

  // Skip if file doesn't exist
  if (!fs.existsSync(filePath)) {
    console.log(color('yellow', `⚠ Skipped: ${path.basename(file)} (file not found)`));
    results.skipped.push({ file, reason: 'File not found' });
    continue;
  }

  const suiteName = TEST_SUITES[type].name;
  const shortName = path.basename(file, '.test.js');

  process.stdout.write(color('dim', `[${suiteName}] `) + `${shortName.padEnd(40)} `);

  try {
    const output = execSync(`node --test "${filePath}"`, {
      encoding: 'utf-8',
      stdio: verbose ? 'inherit' : 'pipe',
      cwd: path.resolve(__dirname, '..', '..'),
      timeout: 60000, // 60 second timeout per test file
    });

    console.log(color('green', '✓ PASS'));
    results.passed.push({ file, type });

  } catch (error) {
    // node --test returns exit code 1 when tests fail, but we need to parse the output
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    const fullOutput = stdout + stderr;

    // Check if this is a "test failure" (expected) vs "command failure" (syntax error etc)
    const isTestFailure = fullOutput.includes('not ok') || fullOutput.includes('# fail');

    if (!isTestFailure && !fullOutput.includes('passed')) {
      // Likely a syntax error or command error
      console.log(color('red', '✗ ERROR'));
      console.log(color('dim', `   ${error.message.substring(0, 100)}`));
      results.failed.push({
        file,
        type,
        error: 'Command error',
        stderr: stderr.substring(0, 200),
      });
      if (failFast) break;
      continue;
    }

    // Parse test results from error.output (node --test sends results to stdout even on failure)
    console.log(color('red', '✗ FAIL'));

    // Parse test count from output (patterns like "# pass 8" or "# fail 2")
    const passMatch = fullOutput.match(/# pass(?:ed)?\s*(\d+)/i);
    const failMatch = fullOutput.match(/# fail(?:ed)?\s*(\d+)/i);
    const passCount = passMatch ? parseInt(passMatch[1]) : 0;
    const failCount = failMatch ? parseInt(failMatch[1]) : 0;

    // Parse individual failures
    const failLines = fullOutput.match(/not ok \d+ - (.+?)(?:\r?\n|$)/g) || [];
    const failures = failLines.map(l => l.replace(/not ok \d+ - /, '').trim());

    results.failed.push({
      file,
      type,
      passCount,
      failCount,
      failures: failures.slice(0, 10), // Limit to first 10
      stderr: verbose ? undefined : stderr.substring(0, 300),
    });

    if (verbose && stderr) {
      console.log(color('dim', stderr));
    }

    if (failFast) {
      console.log('\n' + color('yellow', '--fail-fast: Stopping after first failure'));
      break;
    }
  }
}

const duration = ((Date.now() - startTime) / 1000).toFixed(2);

// Print summary
console.log('\n' + '─'.repeat(60));
console.log(color('bright', 'Test Summary'));
console.log('─'.repeat(60));

const passedCount = results.passed.length;
const failedCount = results.failed.length;
const skippedCount = results.skipped.length;

console.log(`  Total files:  ${results.total}`);
console.log(`  Passed:       ${color('green', passedCount.toString())}`);
console.log(`  Failed:       ${color('red', failedCount.toString())}`);
console.log(`  Skipped:      ${color('yellow', skippedCount.toString())}`);
console.log(`  Duration:     ${duration}s`);

// Detailed failure report
if (results.failed.length > 0) {
  console.log('\n' + color('bright', 'Failed Tests:'));
  console.log('─'.repeat(60));

  for (const fail of results.failed) {
    console.log(`\n ${color('red', '✗')} ${color('bright', path.basename(fail.file))}`);

    if (fail.passCount !== undefined && fail.failCount !== undefined) {
      console.log(`   Subtests: ${color('green', fail.passCount + ' pass')}, ${color('red', fail.failCount + ' fail')}`);
    }

    if (fail.failures.length > 0) {
      console.log(`   Failures:`);
      for (const f of fail.failures.slice(0, 5)) { // Show first 5
        console.log(`     • ${f}`);
      }
      if (fail.failures.length > 5) {
        console.log(`     ... and ${fail.failures.length - 5} more`);
      }
    }

    if (fail.stderr && !verbose) {
      console.log(color('dim', `   ${fail.stderr.substring(0, 200)}...`));
    }
  }
}

console.log('\n' + '═'.repeat(60));

// Exit with appropriate code
if (failedCount > 0) {
  console.log(color('red', 'Test run completed with failures'));
  process.exit(1);
} else if (passedCount === 0) {
  console.log(color('yellow', 'No tests were run'));
  process.exit(2);
} else {
  console.log(color('green', 'All tests passed!'));
  process.exit(0);
}
