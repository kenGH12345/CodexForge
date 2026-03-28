/**
 * Problem Abstraction Engine Tests
 *
 * Tests for PatternDetector, TrendAnalyzer, and ProblemAbstractionEngine.
 */

'use strict';

const assert = require('assert');
const {
  ProblemAbstractionEngine,
  PatternDetector,
  TrendAnalyzer,
  FIX_PATTERNS,
} = require('./problem-abstraction-engine');

// ─── Test Utilities ─────────────────────────────────────────────────────────

function createMockExperience(overrides = {}) {
  return {
    id: `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type: 'negative',
    category: 'pitfall',
    title: overrides.title || 'Test Experience',
    content: overrides.content || 'Test content',
    codeExample: overrides.codeExample || null,
    createdAt: overrides.createdAt || new Date().toISOString(),
    ...overrides,
  };
}

// ─── PatternDetector Tests ──────────────────────────────────────────────────

console.log('\n=== PatternDetector Tests ===\n');

// Test 1: Detect HARDCODED_CONFIG_ENTRY pattern
(function testHardcodedConfigDetection() {
  const detector = new PatternDetector();

  const exp1 = createMockExperience({
    title: 'Added new IDE signature for Roo Code',
    content: 'Added support for Roo Code to the IDE_SIGNATURES list. This is getting hard to maintain.',
  });

  const matches = detector.detectInExperience(exp1);

  assert.strictEqual(matches.length, 1, 'Should detect one pattern');
  assert.strictEqual(matches[0].patternId, 'HARDCODED_CONFIG_ENTRY', 'Should detect HARDCODED_CONFIG_ENTRY');
  assert.strictEqual(matches[0].confidence, 0.9, 'Should have high confidence');

  console.log('✅ Test 1 passed: HARDCODED_CONFIG_ENTRY detection');
})();

// Test 2: Detect multiple patterns in one experience
(function testMultiplePatternDetection() {
  const detector = new PatternDetector();

  const exp = createMockExperience({
    title: 'Fix hardcoded values and duplicate conditionals',
    content: 'Fixed hardcoded config list and also fixed duplicate if-else logic in the authentication module.',
  });

  const matches = detector.detectInExperience(exp);

  assert.ok(matches.length >= 1, 'Should detect at least one pattern');

  console.log('✅ Test 2 passed: Multiple pattern detection');
})();

// Test 3: Batch detection and threshold triggering
(function testBatchDetection() {
  const detector = new PatternDetector();

  const experiences = [];

  // Create 3 experiences with HARDCODED_CONFIG_ENTRY pattern
  for (let i = 0; i < 3; i++) {
    experiences.push(createMockExperience({
      title: `Added IDE signature ${i + 1}`,
      content: 'Added another IDE to the hardcoded IDE_SIGNATURES list.',
      createdAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
    }));
  }

  const result = detector.detectBatch(experiences);

  assert.ok(result.triggeredPatterns.length > 0, 'Should have triggered patterns');
  const hardcodedPattern = result.triggeredPatterns.find(p => p.patternId === 'HARDCODED_CONFIG_ENTRY');
  assert.ok(hardcodedPattern, 'HARDCODED_CONFIG_ENTRY should be triggered');
  assert.strictEqual(hardcodedPattern.occurrenceCount, 3, 'Should have 3 occurrences');

  console.log('✅ Test 3 passed: Batch detection and threshold triggering');
})();

// Test 4: Register custom pattern
(function testCustomPattern() {
  const detector = new PatternDetector();

  detector.registerPattern('MY_CUSTOM_PATTERN', {
    name: 'Custom Pattern',
    description: 'Test custom pattern',
    symptoms: [/custom.*test.*pattern/i],
    severity: 'low',
    triggerThreshold: 2,
    evolutionRecommendation: 'Refactor custom code',
    detectionConfidence: 0.85,
  });

  const exp = createMockExperience({
    title: 'Custom test pattern found',
    content: 'This is a custom test pattern that should be detected.',
  });

  const matches = detector.detectInExperience(exp);

  assert.ok(matches.some(m => m.patternId === 'MY_CUSTOM_PATTERN'), 'Should detect custom pattern');

  console.log('✅ Test 4 passed: Custom pattern registration');
})();

// ─── TrendAnalyzer Tests ────────────────────────────────────────────────────

console.log('\n=== TrendAnalyzer Tests ===\n');

// Test 5: Record and retrieve pattern trend
(function testTrendRecording() {
  const analyzer = new TrendAnalyzer({ storePath: null }); // No persistence for test

  const now = new Date();
  const exp = createMockExperience({ title: 'Test' });

  // Record 5 occurrences
  for (let i = 0; i < 5; i++) {
    analyzer.recordOccurrence('TEST_PATTERN', exp, new Date(now - i * 24 * 60 * 60 * 1000));
  }

  const trend = analyzer.getPatternTrend('TEST_PATTERN');

  assert.strictEqual(trend.totalOccurrences, 5, 'Should have 5 occurrences');
  assert.ok(trend.velocity >= 0, 'Should have velocity');
  assert.ok(['stable', 'growing', 'accelerating', 'declining'].includes(trend.trend), 'Should have valid trend');

  console.log('✅ Test 5 passed: Trend recording and retrieval');
})();

// Test 6: Health report generation
(function testHealthReport() {
  const analyzer = new TrendAnalyzer({ storePath: null });
  const exp = createMockExperience({ title: 'Test', category: 'pitfall' });

  // Record multiple patterns
  for (let i = 0; i < 5; i++) {
    analyzer.recordOccurrence(`PATTERN_${i}`, exp, new Date());
    // Multiple occurrences for some patterns
    if (i < 2) {
      analyzer.recordOccurrence(`PATTERN_${i}`, exp, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
    }
  }

  const report = analyzer.getHealthReport();

  assert.ok(report.timestamp, 'Should have timestamp');
  assert.ok(['healthy', 'at-risk', 'critical'].includes(report.health), 'Should have valid health status');
  assert.ok(report.metrics, 'Should have metrics');
  assert.ok(Array.isArray(report.recommendations), 'Should have recommendations array');

  console.log('✅ Test 6 passed: Health report generation');
  console.log(`    Health: ${report.health}`);
  console.log(`    Entropy: ${report.metrics.currentEntropy}`);
})();

// ─── ProblemAbstractionEngine Tests ─────────────────────────────────────────

console.log('\n=== ProblemAbstractionEngine Tests ===\n');

// Test 7: Full analysis workflow
(function testFullAnalysis() {
  const engine = new ProblemAbstractionEngine();

  const experiences = [];

  // Simulate 3 hardcoded config fixes
  for (let i = 0; i < 3; i++) {
    experiences.push(createMockExperience({
      title: `Added IDE signature for IDE ${i + 1}`,
      content: 'Added new IDE to the hardcoded IDE_SIGNATURES configuration list. This pattern keeps repeating.',
      category: 'config_system',
      createdAt: new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000).toISOString(),
    }));
  }

  const result = engine.analyze(experiences);

  assert.ok(result.timestamp, 'Should have timestamp');
  assert.ok(result.detection, 'Should have detection results');
  assert.ok(result.health, 'Should have health report');
  assert.ok(result.recommendations, 'Should have recommendations');
  assert.ok(result.summary, 'Should have summary');

  // Check that HARDCODED_CONFIG_ENTRY was triggered
  const hardcodedTriggered = result.detection.triggeredPatterns.some(
    p => p.patternId === 'HARDCODED_CONFIG_ENTRY'
  );
  assert.ok(hardcodedTriggered, 'HARDCODED_CONFIG_ENTRY should be triggered');

  console.log('✅ Test 7 passed: Full analysis workflow');
  console.log(`    Patterns triggered: ${result.summary.patternsTriggered}`);
  console.log(`    Health: ${result.health.health}`);
})();

// Test 8: Quick check for single experience
(function testQuickCheck() {
  const engine = new ProblemAbstractionEngine();

  // First, seed with 2 occurrences
  for (let i = 0; i < 2; i++) {
    engine.analyzer.recordOccurrence(
      'HARDCODED_CONFIG_ENTRY',
      createMockExperience({ category: 'config_system' }),
      new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000)
    );
  }

  // Now check the third one (should trigger)
  const exp = createMockExperience({
    title: 'Added another IDE signature',
    content: 'Added to hardcoded IDE_SIGNATURES list',
    category: 'config_system',
  });

  const result = engine.quickCheck(exp);

  assert.ok(result.triggeredPatterns.length > 0, 'Should have triggered patterns');
  assert.ok(result.requiresAttention, 'Should require attention');

  console.log('✅ Test 8 passed: Quick check for single experience');
})();

// ─── Integration Test ───────────────────────────────────────────────────────

console.log('\n=== Integration Test ===\n');

// Test 9: Integration with fix patterns constant
(function testFixPatterns() {
  assert.ok(FIX_PATTERNS.HARDCODED_CONFIG_ENTRY, 'Should have HARDCODED_CONFIG_ENTRY pattern');
  assert.ok(FIX_PATTERNS.SIMILAR_CONDITIONALS, 'Should have SIMILAR_CONDITIONALS pattern');
  assert.ok(FIX_PATTERNS.STRING_COMPARISON_CASCADE, 'Should have STRING_COMPARISON_CASCADE pattern');

  // Verify pattern structure
  const pattern = FIX_PATTERNS.HARDCODED_CONFIG_ENTRY;
  assert.ok(pattern.id, 'Pattern should have id');
  assert.ok(pattern.name, 'Pattern should have name');
  assert.ok(pattern.symptoms, 'Pattern should have symptoms');
  assert.ok(pattern.triggerThreshold, 'Pattern should have triggerThreshold');
  assert.ok(pattern.evolutionRecommendation, 'Pattern should have evolutionRecommendation');

  console.log('✅ Test 9 passed: Fix patterns structure validation');
})();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== All Tests Passed ===\n');
console.log('✅ PatternDetector: 4/4 tests passed');
console.log('✅ TrendAnalyzer: 2/2 tests passed');
console.log('✅ ProblemAbstractionEngine: 3/3 tests passed');
console.log('✅ Total: 9/9 tests passed\n');
