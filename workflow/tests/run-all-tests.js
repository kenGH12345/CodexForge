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
  smoke: {
    name: 'Runtime Smoke Tests (六维度验证)',
    description: '强制验证: 产物存在性、量化指标、下游消费、函数调用、模块路由、端到端流水线',
    files: [
      'workflow/tests/smoke-runtime.test.js',
    ],
  },
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
      'workflow/core/runtime/__tests__/resume-engine.test.cjs',
    ],
  },
  integration: {
    name: 'Integration Tests',
    files: [
      'workflow/core/integration-effective-lines.test.js',
      'workflow/core/integration-pipeline-flow.test.js',
      'workflow/core/integration-agent-fusion.test.js',
      'workflow/core/integration-framework-fusion.test.js',
      'workflow/tests/dual-mode-e2e.test.js',
      'workflow/tests/test-experience-compression.js',
      'workflow/tests/experience-freshness.test.js',
    ],
  },
};

// Parse CLI arguments
const args = process.argv.slice(2);
const filter = args.find(a => a.startsWith('--filter='))?.split('=')[1];
const specificFile = args.find(a => a.startsWith('--file='))?.split('=')[1];
const filesSelector = args.find(a => a.startsWith('--files='))?.split('=')[1];
const suitesSelector = args.find(a => a.startsWith('--suites='))?.split('=')[1];
const profile = args.find(a => a.startsWith('--profile='))?.split('=')[1];
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

const orderedTypes = ['smoke', 'unit', 'integration'];

function appendSuiteTests(type) {
  if (!TEST_SUITES[type]) return;
  testsToRun.push(...TEST_SUITES[type].files.map(f => ({ file: f, type })));
}

if (filesSelector) {
  const tokens = filesSelector.split(',').map(s => s.trim()).filter(Boolean);
  for (const token of tokens) {
    for (const [type, suite] of Object.entries(TEST_SUITES)) {
      const matched = suite.files.filter(f => f.includes(token));
      testsToRun.push(...matched.map(f => ({ file: f, type })));
    }
  }
} else if (specificFile) {
  // Find file by partial name match
  for (const [type, suite] of Object.entries(TEST_SUITES)) {
    const matched = suite.files.filter(f => f.includes(specificFile));
    testsToRun.push(...matched.map(f => ({ file: f, type })));
  }
} else if (suitesSelector) {
  const suites = suitesSelector.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const suiteType of suites) {
    if (!TEST_SUITES[suiteType]) {
      console.error(color('red', `Error: Unknown suite "${suiteType}". Available: smoke, unit, integration`));
      process.exit(1);
    }
  }
  for (const type of orderedTypes) {
    if (suites.includes(type)) appendSuiteTests(type);
  }
} else if (filter) {
  // Filter by suite type
  if (TEST_SUITES[filter]) {
    testsToRun = TEST_SUITES[filter].files.map(f => ({ file: f, type: filter }));
  } else {
    console.error(color('red', `Error: Unknown filter "${filter}". Available: smoke, unit, integration`));
    process.exit(1);
  }
} else if (profile) {
  const normalizedProfile = String(profile).toLowerCase();
  const profileSuites = {
    fast: ['smoke', 'unit'],
    full: ['smoke', 'unit', 'integration'],
  };

  if (!profileSuites[normalizedProfile]) {
    console.error(color('red', `Error: Unknown profile "${profile}". Available: fast, full`));
    process.exit(1);
  }

  for (const type of profileSuites[normalizedProfile]) {
    appendSuiteTests(type);
  }
} else {
  // Run all tests (smoke first, then unit, then integration)
  for (const type of orderedTypes) {
    appendSuiteTests(type);
  }
}

// Deduplicate files while preserving order
const seen = new Set();
testsToRun = testsToRun.filter(({ file }) => {
  if (seen.has(file)) return false;
  seen.add(file);
  return true;
});

if (testsToRun.length === 0) {
  console.error(color('red', 'Error: No tests found matching criteria'));
  process.exit(1);
}

console.log(color('cyan', `Running ${testsToRun.length} test ${testsToRun.length === 1 ? 'file' : 'files'}...\n`));
if (profile) {
  console.log(color('dim', `Test profile: ${profile.toLowerCase()}`));
}
if (suitesSelector) {
  console.log(color('dim', `Target suites: ${suitesSelector}`));
}
if (filesSelector) {
  console.log(color('dim', `Target files token(s): ${filesSelector}`));
}

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

  // Files using custom test format (not node:test compatible — use plain `node` runner)
  const CUSTOM_FORMAT_FILES = [
    'integration-framework-fusion.test.js',
    'integration-agent-fusion.test.js',
    'resume-engine.test.js',
    'test-experience-compression.js',
    'experience-freshness.test.js',
  ];
  const isCustomFormat = CUSTOM_FORMAT_FILES.some(f => file.endsWith(f));

  try {
    const output = execSync(`node ${isCustomFormat ? '' : '--test'} "${filePath}"`, {
      encoding: 'utf-8',
      stdio: verbose ? 'inherit' : 'pipe',
      cwd: path.resolve(__dirname, '..', '..'),
      timeout: 60000, // 60 second timeout per test file
    });

    if (isCustomFormat) {
      // Parse custom ✅/❌ format
      const passCount = (output.match(/✅/g) || []).length;
      const failCount = (output.match(/❌/g) || []).length;
      if (failCount > 0) {
        console.log(color('red', `✗ FAIL`) + color('dim', ` (${passCount} pass, ${failCount} fail)`));
        results.failed.push({ file, type, passCount, failCount, failures: [] });
      } else {
        console.log(color('green', `✓ PASS`) + color('dim', ` (${passCount} pass)`));
        results.passed.push({ file, type });
      }
    } else {
      console.log(color('green', '✓ PASS'));
      results.passed.push({ file, type });
    }

  } catch (error) {
    // node --test returns exit code 1 when tests fail, but we need to parse the output
    const stderr = error.stderr || '';
    const stdout = error.stdout || '';
    const fullOutput = stdout + stderr;

    // Custom format files: parse ✅/❌ even on non-zero exit code
    if (isCustomFormat) {
      const passCount = (fullOutput.match(/✅/g) || []).length;
      const failCount = (fullOutput.match(/❌/g) || []).length;
      if (failCount > 0) {
        console.log(color('red', `✗ FAIL`) + color('dim', ` (${passCount} pass, ${failCount} fail)`));
        results.failed.push({ file, type, passCount, failCount, failures: [] });
      } else if (passCount > 0) {
        console.log(color('green', `✓ PASS`) + color('dim', ` (${passCount} pass)`));
        results.passed.push({ file, type });
      } else {
        console.log(color('red', '✗ ERROR'));
        results.failed.push({ file, type, error: 'Command error', stderr: stderr.substring(0, 200) });
      }
      if (failFast && results.failed.length > 0) break;
      continue;
    }

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

    if (fail.failures && fail.failures.length > 0) {
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
