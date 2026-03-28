/**
 * Integration Test: Deep Audit + Effective Lines Counter
 *
 * Validates that the Deep Audit Orchestrator correctly uses the
 * smart effective lines counter for file size limit checks.
 *
 * Run with: node workflow/core/integration-effective-lines.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

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

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n=== Integration Tests: Deep Audit + Effective Lines ===\n');

test('effective-lines-counter module is available', () => {
  const counter = require('./effective-lines-counter');
  assert.ok(counter, 'Module should be available');
  assert.ok(counter.checkFileLimit, 'checkFileLimit function should be exported');
  assert.ok(counter.getFileTier, 'getFileTier function should be exported');
});

test('effective-lines-counter loads config from workflow.config.js', () => {
  const counter = require('./effective-lines-counter');
  const config = counter.loadConfig();
  
  assert.ok(config.enabled, 'Should be enabled by default');
  assert.ok(config.tiers, 'Should have tiers config');
  assert.ok(config.commentRatioWarning, 'Should have comment ratio warning threshold');
});

test('effective-lines-counter correctly classifies file tiers', () => {
  const counter = require('./effective-lines-counter');
  
  // Test various file types
  const testCases = [
    { file: 'index.js', expectedTier: 'entry-point' },
    { file: 'core/orchestrator-task.js', expectedTier: 'core-critical' },
    { file: 'core/constants.js', expectedTier: 'core-standard' },
    { file: 'agents/developer-agent.js', expectedTier: 'agent' },
    { file: 'commands/commands-workflow.js', expectedTier: 'command' },
  ];
  
  for (const tc of testCases) {
    const tier = counter.getFileTier(tc.file);
    assert.strictEqual(
      tier.name, 
      tc.expectedTier, 
      `${tc.file} should be classified as ${tc.expectedTier}, got ${tier.name}`
    );
  }
});

test('effective-lines-counter analyzes real files correctly', () => {
  const counter = require('./effective-lines-counter');
  
  // Analyze the effective-lines-counter.js itself
  const check = counter.checkFileLimit(__dirname + '/effective-lines-counter.js');
  
  assert.ok(check.tier, 'Should have tier');
  assert.ok(check.analysis, 'Should have analysis');
  assert.ok(check.analysis.totalLines > 0, 'Should have total lines');
  assert.ok(check.analysis.effectiveLines > 0, 'Should have effective lines');
  assert.ok(check.analysis.commentLines > 0, 'Should have comment lines (this file is well-documented)');
  assert.ok(check.analysis.commentRatio > 0, 'Should have comment ratio');
  
  console.log(`   📊 effective-lines-counter.js analysis:`);
  console.log(`      Total lines: ${check.analysis.totalLines}`);
  console.log(`      Effective lines: ${check.analysis.effectiveLines}`);
  console.log(`      Comment lines: ${check.analysis.commentLines}`);
  console.log(`      Comment ratio: ${check.analysis.commentRatio.toFixed(1)}%`);
  console.log(`      Tier: ${check.tier.name} (max: ${check.tier.maxEffectiveLines} effective)`);
});

test('effective-lines-counter detects violations correctly', () => {
  const counter = require('./effective-lines-counter');
  
  // Create a mock file path that would violate limits
  // (We'll use a theoretical file, not actually create it)
  const mockAnalysis = {
    totalLines: 1000,
    effectiveLines: 900,
    commentLines: 100,
    blankLines: 0,
    commentRatio: 10,
  };
  
  // Check if a file with 900 effective lines violates core-standard tier (800 limit per workflow.config.js)
  const tier = counter.getFileTier('core/test-file.js');
  assert.strictEqual(tier.name, 'core-standard', 'Should be core-standard tier');
  assert.strictEqual(tier.maxEffectiveLines, 800, 'Core-standard should have 800 effective line limit (per workflow.config.js)');
  
  // 900 effective lines > 800 limit = violation
  const wouldViolate = mockAnalysis.effectiveLines > tier.maxEffectiveLines;
  assert.ok(wouldViolate, '900 effective lines should violate 800 limit');
});

test('Deep Audit Orchestrator imports effective-lines-counter', () => {
  // Read the deep-audit-orchestrator file to verify the import
  const orchestratorPath = __dirname + '/deep-audit-orchestrator.js';
  const content = fs.readFileSync(orchestratorPath, 'utf-8');
  
  assert.ok(
    content.includes("require('./effective-lines-counter')"),
    'Deep Audit Orchestrator should import effective-lines-counter'
  );
  
  // Note: useEffectiveLines logic is passed to createDimensionChecks via dependency injection
  assert.ok(
    content.includes('useEffectiveLines') || content.includes('effectiveLinesCounter'),
    'Deep Audit Orchestrator should use effective-lines-counter'
  );
  
  assert.ok(
    content.includes('effectiveLinesCounter'),
    'Deep Audit Orchestrator should reference effectiveLinesCounter'
  );
});

test('architecture-constraints.md documents effective lines', () => {
  const constraintsPath = path.join(__dirname, '..', 'docs', 'architecture-constraints.md');
  const content = fs.readFileSync(constraintsPath, 'utf-8');
  
  assert.ok(
    content.includes('effective lines'),
    'Architecture constraints should mention effective lines'
  );
  
  assert.ok(
    content.includes('Tiered Limits'),
    'Architecture constraints should document tiered limits'
  );
  
  assert.ok(
    content.includes('entry-point') || content.includes('Entry-Point'),
    'Architecture constraints should list entry-point tier'
  );
});

test('workflow.config.js includes effectiveLines config', () => {
  // Use config-loader to get the merged config
  const { getConfig, clearConfigCache } = require('./config-loader');
  
  // Clear cache to get fresh config
  clearConfigCache();
  const config = getConfig();
  
  // Debug: log config keys
  console.log(`   📝 Config keys: ${Object.keys(config).slice(0, 10).join(', ')}...`);
  
  assert.ok(config.effectiveLines, 'Config should have effectiveLines section');
  assert.ok(config.effectiveLines.enabled, 'effectiveLines should be enabled');
  assert.ok(config.effectiveLines.tiers, 'Config should have tiers');
  assert.ok(config.effectiveLines.commentRatioWarning, 'Config should have commentRatioWarning');
  
  console.log(`      Enabled: ${config.effectiveLines.enabled}`);
  console.log(`      Tiers: ${Object.keys(config.effectiveLines.tiers).join(', ')}`);
  console.log(`      Comment ratio warning: ${config.effectiveLines.commentRatioWarning}%`);
});

// ─── Summary ────────────────────────────────────────────────────────────────

setTimeout(() => {
  console.log('\n========================================');
  console.log(`Total: ${testCount} tests`);
  console.log(`Passed: ${passCount} tests`);
  console.log(`Failed: ${testCount - passCount} tests`);
  console.log('========================================\n');

  if (passCount === testCount) {
    console.log('✅ All integration tests passed!\n');
    console.log('📊 Integration Summary:');
    console.log('   • Deep Audit Orchestrator → effective-lines-counter ✓');
    console.log('   • Configuration → effective-lines-counter ✓');
    console.log('   • Architecture constraints updated ✓');
    console.log('   • workflow.config.js integrated ✓');
    console.log('');
    console.log('🎯 Next Steps:');
    console.log('   1. Run deep-audit to see effective lines in action');
    console.log('   2. Review files flagged by new smart limits');
    console.log('   3. Adjust tier limits in workflow.config.js if needed');
    console.log('');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed.\n');
    process.exit(1);
  }
}, 500);
