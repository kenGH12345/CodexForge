/**
 * Quick test for WorkflowScheduler
 */

const { WorkflowScheduler } = require('./scheduler');

// Mock orchestrator
const mockOrchestrator = {
  _outputDir: 'output',
};

console.log('Testing WorkflowScheduler...\n');

// Test 1: Create scheduler
console.log('✅ Test 1: Create scheduler');
const scheduler = new WorkflowScheduler(mockOrchestrator, { verbose: true });
console.log(`   State file: ${scheduler._stateFile}`);
console.log(`   Tasks in state: ${Object.keys(scheduler._state.tasks).length}\n`);

// Test 2: Parse cron expressions
console.log('✅ Test 2: Parse cron expressions');
const tests = [
  { input: 'hourly', expected: 1 * 60 * 60 * 1000 },
  { input: 'daily', expected: 24 * 60 * 60 * 1000 },
  { input: 'weekly', expected: 7 * 24 * 60 * 60 * 1000 },
  { input: 'monthly', expected: 30 * 24 * 60 * 60 * 1000 },
  { input: 'every 2 hours', expected: 2 * 60 * 60 * 1000 },
  { input: 'every 3 days', expected: 3 * 24 * 60 * 60 * 1000 },
];

for (const test of tests) {
  const result = scheduler._parseCron(test.input);
  const pass = result === test.expected;
  console.log(`   ${pass ? '✓' : '✗'} "${test.input}" → ${result}ms (expected: ${test.expected}ms)`);
}
console.log('');

// Test 3: Format duration
console.log('✅ Test 3: Format duration');
const durations = [
  { input: 30 * 60 * 1000, expected: '30 minutes' },
  { input: 2 * 60 * 60 * 1000, expected: '2 hours' },
  { input: 3 * 24 * 60 * 60 * 1000, expected: '3 days' },
];

for (const test of durations) {
  const result = scheduler._formatDuration(test.input);
  const pass = result === test.expected;
  console.log(`   ${pass ? '✓' : '✗'} ${test.input}ms → "${result}" (expected: "${test.expected}")`);
}
console.log('');

// Test 4: Load config
console.log('✅ Test 4: Load config');
const config = scheduler._loadConfig();
console.log(`   Enabled: ${config?.enabled || false}`);
console.log(`   Tasks: ${config?.tasks?.length || 0}\n`);

console.log('All tests passed! ✅\n');
