/**
 * Evolution Recommender Tests
 *
 * Tests for ADRGenerator, ArchitectureChangeQueue, RefactoringAdvisor,
 * and EvolutionRecommender integration.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  EvolutionRecommender,
  ADRGenerator,
  ArchitectureChangeQueue,
  RefactoringAdvisor,
  REFACTORING_TEMPLATES,
} = require('./evolution-recommender');

// ─── Test Utilities ─────────────────────────────────────────────────────────

function createMockTriggeredPattern(overrides = {}) {
  return {
    patternId: overrides.patternId || 'HARDCODED_CONFIG_ENTRY',
    patternName: overrides.patternName || 'Hardcoded Configuration Entry',
    occurrenceCount: overrides.occurrenceCount || 3,
    threshold: overrides.threshold || 3,
    severity: overrides.severity || 'medium',
    recommendation: overrides.recommendation || 'Implement Provider Pattern',
    confidence: overrides.confidence || 0.9,
    evidence: overrides.evidence || [],
    ...overrides,
  };
}

function createMockTrend(overrides = {}) {
  return {
    velocity: overrides.velocity || 0.5,
    growthRate: overrides.growthRate || 10,
    trend: overrides.trend || 'stable',
    occurrences: overrides.occurrences || [],
    ...overrides,
  };
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-recommender-test-'));
}

// ─── ADR Generator Tests ────────────────────────────────────────────────────

console.log('\n=== ADR Generator Tests ===\n');

// Test 1: ADR generation for HARDCODED_CONFIG_ENTRY
(function testADRGeneration() {
  const generator = new ADRGenerator({ outputDir: createTempDir() });

  const triggered = createMockTriggeredPattern({
    patternId: 'HARDCODED_CONFIG_ENTRY',
    occurrenceCount: 3,
  });

  const adr = generator.generate(triggered);

  assert.ok(adr.id, 'ADR should have ID');
  assert.ok(adr.id.startsWith('ADR-'), 'ID should start with ADR-');
  assert.strictEqual(adr.status, 'Proposed', 'Status should be Proposed');
  assert.ok(adr.title.includes('Provider Pattern'), 'Title should mention pattern');
  assert.ok(adr.context, 'Should have context section');
  assert.ok(adr.decision, 'Should have decision section');
  assert.ok(adr.consequences, 'Should have consequences section');
  assert.strictEqual(adr.metadata.patternId, 'HARDCODED_CONFIG_ENTRY');

  console.log('✅ Test 1 passed: ADR generation for triggered pattern');
  console.log(`   Generated: ${adr.id} - ${adr.title}`);
})();

// Test 2: ADR markdown rendering
(function testADRRMarkdownRendering() {
  const generator = new ADRGenerator({ outputDir: createTempDir() });

  const triggered = createMockTriggeredPattern({ patternId: 'HARDCODED_CONFIG_ENTRY' });
  const adr = generator.generate(triggered);

  const markdown = generator.renderMarkdown(adr);

  assert.ok(markdown.includes(`# ${adr.id}`), 'Should contain ADR heading');
  assert.ok(markdown.includes('**Status**: Proposed'), 'Should contain status');
  assert.ok(markdown.includes('Context'), 'Should contain context section');
  assert.ok(markdown.includes('Decision'), 'Should contain decision section');
  assert.ok(markdown.includes('Consequences'), 'Should contain consequences section');

  console.log('✅ Test 2 passed: ADR markdown rendering');
})();

// Test 3: ADR file saving
(function testADRFileSaving() {
  const tempDir = createTempDir();
  const generator = new ADRGenerator({ outputDir: tempDir });

  const triggered = createMockTriggeredPattern({ patternId: 'HARDCODED_CONFIG_ENTRY' });
  const adr = generator.generate(triggered);

  const filepath = generator.saveToFile(adr);

  assert.ok(fs.existsSync(filepath), 'File should exist');
  const content = fs.readFileSync(filepath, 'utf-8');
  assert.ok(content.length > 0, 'Content should not be empty');
  assert.ok(content.includes(adr.id), 'Content should contain ADR ID');

  console.log('✅ Test 3 passed: ADR file saving');
  console.log(`   Saved to: ${filepath}`);

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
})();

// Test 4: ADR with trend analysis
(function testADRWithTrend() {
  const generator = new ADRGenerator({ outputDir: createTempDir() });

  const triggered = createMockTriggeredPattern({
    patternId: 'HARDCODED_CONFIG_ENTRY',
    occurrenceCount: 5,
  });

  const trend = createMockTrend({ velocity: 2.5, growthRate: 150, trend: 'accelerating' });
  const adr = generator.generate(triggered, trend);

  assert.ok(adr.context.includes('Trend Analysis'), 'Context should have trend analysis');
  assert.ok(adr.context.includes('2.5'), 'Should include velocity');
  assert.ok(adr.context.includes('accelerating'), 'Should include trend direction');

  console.log('✅ Test 4 passed: ADR with trend analysis');
})();

// ─── Architecture Change Queue Tests ────────────────────────────────────────

console.log('\n=== Architecture Change Queue Tests ===\n');

// Test 5: Add proposal to queue
(function testQueueAdd() {
  const queue = new ArchitectureChangeQueue({ storePath: null });

  const mockADR = {
    id: 'ADR-001',
    title: 'Test ADR',
    generatedAt: new Date().toISOString(),
    metadata: {
      patternId: 'TEST_PATTERN',
      patternName: 'Test Pattern',
      severity: 'high',
    },
  };

  const proposal = queue.add(mockADR);

  assert.ok(proposal.id, 'Proposal should have ID');
  assert.strictEqual(proposal.adrId, 'ADR-001');
  assert.strictEqual(proposal.patternId, 'TEST_PATTERN');
  assert.strictEqual(proposal.priority, 'P1', 'High severity should be P1');
  assert.strictEqual(proposal.status, 'queued');

  console.log('✅ Test 5 passed: Add proposal to queue');
})();

// Test 6: Queue status updates
(function testQueueStatusUpdate() {
  const queue = new ArchitectureChangeQueue({ storePath: null });

  const mockADR = {
    id: 'ADR-002',
    title: 'Test ADR 2',
    generatedAt: new Date().toISOString(),
    metadata: {
      patternId: 'TEST_PATTERN_2',
      patternName: 'Test Pattern 2',
      severity: 'medium',
    },
  };

  const proposal = queue.add(mockADR);

  // Update status
  const updated = queue.updateStatus(proposal.id, 'in-progress', { assignedTo: 'developer' });

  assert.strictEqual(updated.status, 'in-progress');
  assert.strictEqual(updated.assignedTo, 'developer');
  assert.ok(updated.updatedAt >= updated.createdAt, 'Updated time should be newer or equal');

  // Update to implemented
  const implemented = queue.updateStatus(proposal.id, 'implemented');
  assert.strictEqual(implemented.status, 'implemented');
  assert.ok(implemented.implementedAt, 'Should have implementation timestamp');

  console.log('✅ Test 6 passed: Queue status updates');
})();

// Test 7: Queue statistics
(function testQueueStats() {
  const queue = new ArchitectureChangeQueue({ storePath: null });

  // Add multiple proposals with different severities
  const severities = ['critical', 'high', 'medium', 'low'];
  severities.forEach((sev, idx) => {
    queue.add({
      id: `ADR-${idx + 10}`,
      title: `Test ${idx}`,
      generatedAt: new Date().toISOString(),
      metadata: {
        patternId: `PATTERN_${idx}`,
        patternName: `Pattern ${idx}`,
        severity: sev,
      },
    });
  });

  const stats = queue.getStats();

  assert.strictEqual(stats.total, 4);
  assert.strictEqual(stats.byStatus.queued, 4);
  assert.strictEqual(stats.byPriority.P0, 1, 'Critical should be P0');
  assert.strictEqual(stats.byPriority.P1, 1, 'High should be P1');
  assert.strictEqual(stats.byPriority.P2, 1, 'Medium should be P2');
  assert.strictEqual(stats.byPriority.P3, 1, 'Low should be P3');

  console.log('✅ Test 7 passed: Queue statistics');
})();

// ─── Refactoring Advisor Tests ──────────────────────────────────────────────

console.log('\n=== Refactoring Advisor Tests ===\n');

// Test 8: Get refactoring guide
(function testGetRefactoringGuide() {
  const advisor = new RefactoringAdvisor();

  const guide = advisor.getRefactoringGuide('HARDCODED_CONFIG_ENTRY');

  assert.ok(guide, 'Should return guide for known pattern');
  assert.strictEqual(guide.patternId, 'HARDCODED_CONFIG_ENTRY');
  assert.ok(guide.name, 'Should have name');
  assert.ok(guide.description, 'Should have description');
  assert.ok(guide.beforeExample, 'Should have before example');
  assert.ok(guide.afterExample, 'Should have after example');
  assert.ok(guide.implementationPlan, 'Should have implementation plan');
  assert.ok(guide.filesToModify, 'Should have files list');
  assert.ok(guide.effort, 'Should have effort estimate');
  assert.ok(guide.benefits, 'Should have benefits');

  console.log('✅ Test 8 passed: Get refactoring guide');
  console.log(`   Pattern: ${guide.name}`);
  console.log(`   Estimated effort: ${guide.effort.estimatedHours} hours`);
})();

// Test 9: Template availability check
(function testHasTemplate() {
  const advisor = new RefactoringAdvisor();

  assert.strictEqual(advisor.hasTemplate('HARDCODED_CONFIG_ENTRY'), true);
  assert.strictEqual(advisor.hasTemplate('SIMILAR_CONDITIONALS'), true);
  assert.strictEqual(advisor.hasTemplate('UNKNOWN_PATTERN'), false);

  console.log('✅ Test 9 passed: Template availability check');
})();

// Test 10: Generate checklist
(function testGenerateChecklist() {
  const advisor = new RefactoringAdvisor();

  const checklist = advisor.generateChecklist('HARDCODED_CONFIG_ENTRY');

  assert.ok(checklist.length > 0, 'Should have checklist items');
  assert.ok(checklist[0].includes('[ ]'), 'Should have checkbox format');
  assert.ok(checklist.some(item => item.includes('Step 1')), 'Should have step numbers');

  console.log('✅ Test 10 passed: Generate checklist');
  checklist.slice(0, 2).forEach(item => console.log(`   ${item}`));
})();

// ─── Evolution Recommender Integration Tests ────────────────────────────────

console.log('\n=== Evolution Recommender Integration Tests ===\n');

// Test 11: Full process triggered pattern
(function testFullProcess() {
  const recommender = new EvolutionRecommender({
    adr: { outputDir: createTempDir() },
    queue: { storePath: null },
  });

  const triggered = createMockTriggeredPattern({ patternId: 'HARDCODED_CONFIG_ENTRY' });
  const trend = createMockTrend({ velocity: 1.5 });

  const result = recommender.processTriggeredPattern(triggered, trend);

  assert.ok(result.adr, 'Should have ADR');
  assert.ok(result.proposal, 'Should have proposal');
  assert.ok(result.refactoringGuide, 'Should have refactoring guide');
  assert.ok(result.summary, 'Should have summary');
  assert.strictEqual(result.summary.hasDetailedPlan, true);
  assert.strictEqual(result.summary.actionRequired, false, 'Medium severity should not be P0/P1');
  assert.strictEqual(result.summary.estimatedEffort, 4, 'Should match template effort');

  console.log('✅ Test 11 passed: Full process triggered pattern');
})();

// Test 12: Get pending proposals
(function testGetPendingProposals() {
  const recommender = new EvolutionRecommender({
    adr: { outputDir: createTempDir() },
    queue: { storePath: null },
  });

  // Process two patterns
  recommender.processTriggeredPattern(createMockTriggeredPattern({ patternId: 'HARDCODED_CONFIG_ENTRY' }));
  recommender.processTriggeredPattern(createMockTriggeredPattern({
    patternId: 'DUPLICATE_ERROR_HANDLING',
    patternName: 'Duplicate Error Handling',
  }));

  const pending = recommender.getPendingProposals();

  assert.strictEqual(pending.length, 2, 'Should have 2 pending proposals');
  assert.ok(pending.every(p => !['implemented', 'rejected'].includes(p.status)), 'All should be pending');

  console.log('✅ Test 12 passed: Get pending proposals');
})();

// Test 13: Queue stats integration
(function testQueueStatsIntegration() {
  const recommender = new EvolutionRecommender({
    adr: { outputDir: createTempDir() },
    queue: { storePath: null },
  });

  // Add patterns of different severity (use different pattern IDs to avoid deduplication)
  recommender.processTriggeredPattern(createMockTriggeredPattern({
    patternId: 'CRITICAL_PATTERN',
    severity: 'critical'
  }));
  recommender.processTriggeredPattern(createMockTriggeredPattern({
    patternId: 'HIGH_PATTERN',
    severity: 'high'
  }));
  recommender.processTriggeredPattern(createMockTriggeredPattern({
    patternId: 'MEDIUM_PATTERN',
    severity: 'medium'
  }));

  const stats = recommender.getQueueStats();

  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.byPriority.P0, 1);
  assert.strictEqual(stats.byPriority.P1, 1);
  assert.strictEqual(stats.byPriority.P2, 1);

  console.log('✅ Test 13 passed: Queue stats integration');
  console.log(`   Total: ${stats.total}, P0: ${stats.byPriority.P0}, P1: ${stats.byPriority.P1}, P2: ${stats.byPriority.P2}`);
})();

// ─── Constants Validation ───────────────────────────────────────────────────

console.log('\n=== Constants Validation ===\n');

// Test 14: Refactoring templates structure
(function testRefactoringTemplates() {
  assert.ok(REFACTORING_TEMPLATES.HARDCODED_CONFIG_ENTRY, 'Should have HARDCODED_CONFIG_ENTRY template');
  assert.ok(REFACTORING_TEMPLATES.SIMILAR_CONDITIONALS, 'Should have SIMILAR_CONDITIONALS template');
  assert.ok(REFACTORING_TEMPLATES.DUPLICATE_ERROR_HANDLING, 'Should have DUPLICATE_ERROR_HANDLING template');

  const template = REFACTORING_TEMPLATES.HARDCODED_CONFIG_ENTRY;
  assert.ok(template.patternId, 'Template should have patternId');
  assert.ok(template.refactoringName, 'Template should have refactoringName');
  assert.ok(template.description, 'Template should have description');
  assert.ok(template.architecturalPattern, 'Template should have architecturalPattern');
  assert.ok(Array.isArray(template.implementationPlan), 'Template should have implementationPlan array');
  assert.ok(template.effort, 'Template should have effort');
  assert.ok(template.effort.estimatedHours, 'Effort should have estimatedHours');

  console.log('✅ Test 14 passed: Refactoring templates structure validation');
})();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== All Tests Passed ===\n');
console.log('✅ ADRGenerator: 4/4 tests passed');
console.log('✅ ArchitectureChangeQueue: 3/3 tests passed');
console.log('✅ RefactoringAdvisor: 3/3 tests passed');
console.log('✅ EvolutionRecommender: 3/3 tests passed');
console.log('✅ Constants Validation: 1/1 tests passed');
console.log('✅ Total: 14/14 tests passed\n');
