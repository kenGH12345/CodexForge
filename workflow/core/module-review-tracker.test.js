/**
 * Test: Module Review Tracker
 *
 * Validates that the module review tracker correctly records and tracks
 * module review status across sessions.
 *
 * Run with: node workflow/core/module-review-tracker.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { ModuleReviewTracker, ReviewStatus, IssuePriority } = require('./module-review-tracker');

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

// ─── Setup ───────────────────────────────────────────────────────────────────

const testStorePath = path.join(__dirname, '..', 'output', 'test-module-reviews.json');

// Clean up before tests
if (fs.existsSync(testStorePath)) {
  fs.unlinkSync(testStorePath);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n=== Module Review Tracker Tests ===\n');

test('creates tracker with default options', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  assert.ok(tracker, 'Tracker should be created');
  assert.ok(tracker.reviews, 'Should have reviews map');
  assert.ok(tracker.issues, 'Should have issues map');
});

test('records a review for a module', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  const review = tracker.recordReview('core/code-graph.js', {
    reviewer: 'deep-audit',
    summary: 'Found 3 issues in code-graph.js',
    issues: [
      { severity: 'high', category: 'config-consistency', title: 'File too large', description: '1440 lines' },
      { severity: 'medium', category: 'logic-consistency', title: 'Circular dependency', description: 'code-graph.js↔file-scanner.js' },
    ],
  });
  
  assert.ok(review, 'Should return review');
  assert.strictEqual(review.modulePath, 'core/code-graph.js', 'Should normalize path');
  assert.strictEqual(review.reviewer, 'deep-audit', 'Should record reviewer');
  assert.strictEqual(review.issues.length, 2, 'Should record 2 issues');
  assert.strictEqual(review.status, ReviewStatus.NEEDS_ACTION, 'Should mark as needs-action due to high severity');
});

test('gets review status for a module', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  tracker.recordReview('core/orchestrator-task.js', {
    reviewer: 'deep-audit',
    summary: 'Found 1 issue',
    issues: [
      { severity: 'medium', category: 'config-consistency', title: 'File exceeds limit', description: '849 lines' },
    ],
  });
  
  const status = tracker.getReviewStatus('core/orchestrator-task.js');
  assert.ok(status, 'Should return status');
  assert.strictEqual(status.reviewer, 'deep-audit', 'Should match reviewer');
  assert.strictEqual(status.issues.length, 1, 'Should have 1 issue');
});

test('gets pending issues across all modules', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  // Clear previous data for this test
  tracker.recordReview('core/test-pending-1.js', {
    reviewer: 'test',
    issues: [
      { severity: 'critical', category: 'test', title: 'Critical issue', description: 'Test' },
      { severity: 'high', category: 'test', title: 'High issue', description: 'Test' },
    ],
  });
  
  tracker.recordReview('core/test-pending-2.js', {
    reviewer: 'test',
    issues: [
      { severity: 'medium', category: 'test', title: 'Medium issue', description: 'Test' },
    ],
  });
  
  // Filter to only get issues from this test
  const pending = tracker.getPendingIssues({ categories: ['test'] });
  assert.ok(pending.length >= 3, 'Should have at least 3 pending issues');
  
  // Should be sorted by severity
  const severities = pending.map(i => i.severity);
  assert.ok(severities.includes('critical'), 'Should include critical');
  assert.ok(severities.includes('high'), 'Should include high');
  assert.ok(severities.includes('medium'), 'Should include medium');
});

test('filters pending issues by severity', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  tracker.recordReview('core/test-filter.js', {
    reviewer: 'test',
    issues: [
      { severity: 'high', category: 'test', title: 'High 1', description: 'Test' },
      { severity: 'medium', category: 'test', title: 'Medium 1', description: 'Test' },
      { severity: 'low', category: 'test', title: 'Low 1', description: 'Test' },
    ],
  });
  
  const highOnly = tracker.getPendingIssues({ severities: ['high'] });
  assert.ok(highOnly.every(i => i.severity === 'high'), 'Should only return high severity');
});

test('resolves an issue', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  const review = tracker.recordReview('core/test-resolve.js', {
    reviewer: 'test',
    issues: [
      { severity: 'high', category: 'test', title: 'Issue to resolve', description: 'Test' },
    ],
  });
  
  const issueId = review.issues[0];
  const resolved = tracker.resolveIssue(issueId, 'Fixed by refactoring');
  
  assert.ok(resolved, 'Should resolve successfully');
  
  const issue = tracker.issues.get(issueId);
  assert.strictEqual(issue.status, 'resolved', 'Issue should be resolved');
  assert.strictEqual(issue.resolution, 'Fixed by refactoring', 'Should record resolution');
});

test('gets summary of all reviews', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  const summary = tracker.getSummary();
  
  assert.ok(summary.totalModules > 0, 'Should have some modules');
  assert.ok(summary.totalIssues > 0, 'Should have some issues');
  assert.ok(summary.byStatus, 'Should have status breakdown');
  assert.ok(summary.bySeverity, 'Should have severity breakdown');
  
  console.log(`   📊 Summary: ${summary.totalModules} modules, ${summary.totalIssues} issues`);
  console.log(`      Open: ${summary.openIssues}, Resolved: ${summary.resolvedIssues}`);
});

test('persists reviews to disk', () => {
  const tracker1 = new ModuleReviewTracker({ storePath: testStorePath });
  
  tracker1.recordReview('core/test-persist.js', {
    reviewer: 'test',
    summary: 'Test persistence',
    issues: [
      { severity: 'medium', category: 'test', title: 'Persist test', description: 'Test' },
    ],
  });
  
  // Create new tracker to load from disk
  const tracker2 = new ModuleReviewTracker({ storePath: testStorePath });
  
  const status = tracker2.getReviewStatus('core/test-persist.js');
  assert.ok(status, 'Should load review from disk');
  assert.strictEqual(status.summary, 'Test persistence', 'Should match summary');
});

test('exports review data', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  const exported = tracker.export();
  
  assert.ok(exported.generatedAt, 'Should have timestamp');
  assert.ok(exported.summary, 'Should have summary');
  assert.ok(exported.reviews, 'Should have reviews');
  assert.ok(exported.issues, 'Should have issues');
  
  console.log(`   📦 Exported: ${exported.reviews.length} reviews, ${exported.issues.length} issues`);
});

test('normalizes file paths', () => {
  const tracker = new ModuleReviewTracker({ storePath: testStorePath });
  
  // Test different path formats
  const paths = [
    'core/code-graph.js',
    'c:\\workspace\\WorkFlowAgent\\workflow\\core\\code-graph.js',
    '/workspace/WorkFlowAgent/workflow/core/code-graph.js',
  ];
  
  for (const p of paths) {
    const review = tracker.recordReview(p, {
      reviewer: 'test',
      summary: 'Path normalization test',
      issues: [],
    });
    
    // All should normalize to the same path
    assert.strictEqual(review.modulePath, 'core/code-graph.js', `Should normalize ${p}`);
  }
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

// Clean up test file
if (fs.existsSync(testStorePath)) {
  fs.unlinkSync(testStorePath);
}

// ─── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n========================================');
  console.log(`Total: ${testCount} tests`);
  console.log(`Passed: ${passCount} tests`);
  console.log(`Failed: ${testCount - passCount} tests`);
  console.log('========================================\n');

  if (passCount === testCount) {
    console.log('✅ All tests passed!\n');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed.\n');
    process.exit(1);
  }
}, 500);
