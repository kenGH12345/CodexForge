/**
 * Workflow Introspection System Tests
 *
 * Tests for the workflow introspection system including:
 *   - WorkflowIntrospectionCollector
 *   - ConsistencyValidator
 *   - IntrospectionReportGenerator
 *   - IntrospectionManager
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Test Harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Values not equal'}: expected ${expected}, got ${actual}`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\n🔍 Workflow Introspection System Tests\n');

// Test 1: Module imports
console.log('\n📦 Module Import Tests');

test('workflow-introspection-collector module exports correctly', () => {
  const collector = require('./workflow-introspection-collector');
  assert(collector.WorkflowIntrospectionCollector, 'Should export WorkflowIntrospectionCollector class');
  assert(collector.introspectionCollector, 'Should export introspectionCollector singleton');
  assert(collector.ModuleType, 'Should export ModuleType enum');
  assert(collector.ActionCategory, 'Should export ActionCategory enum');
});

test('consistency-validator module exports correctly', () => {
  const validator = require('./consistency-validator');
  assert(validator.ConsistencyValidator, 'Should export ConsistencyValidator class');
  assert(validator.ValidationSeverity, 'Should export ValidationSeverity enum');
});

test('introspection-report-generator module exports correctly', () => {
  const generator = require('./introspection-report-generator');
  assert(generator.IntrospectionReportGenerator, 'Should export IntrospectionReportGenerator class');
});

test('introspection-manager module exports correctly', () => {
  const manager = require('./introspection-manager');
  assert(manager.IntrospectionManager, 'Should export IntrospectionManager class');
  assert(manager.introspectionManager, 'Should export introspectionManager singleton');
});

// Test 2: Collector functionality
console.log('\n📝 Collector Tests');

const { WorkflowIntrospectionCollector, ModuleType, ActionCategory } = require('./workflow-introspection-collector');

test('Collector initializes correctly', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test-session', outputDir: './test-output' });
  assertEqual(collector._sessionId, 'test-session', 'Session ID should be set');
  assertEqual(collector._outputDir, './test-output', 'Output dir should be set');
  assertEqual(collector._entries.length, 0, 'Entries should be empty');
});

test('Collector records events correctly', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test-session', outputDir: './test-output' });
  
  const entryId = collector.record(ModuleType.SKILL, ActionCategory.REGISTERED, {
    skillName: 'test_skill',
    version: '1.0.0',
  });
  
  assert(entryId, 'Should return entry ID');
  assertEqual(collector._entries.length, 1, 'Should have 1 entry');
  assertEqual(collector._entries[0].module, ModuleType.SKILL, 'Module should be Skill');
  assertEqual(collector._entries[0].action, ActionCategory.REGISTERED, 'Action should be registered');
});

test('Collector provides module-specific record methods', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test-session', outputDir: './test-output' });
  
  collector.recordSkill(ActionCategory.REGISTERED, { skillName: 's1' });
  collector.recordPrompt(ActionCategory.INJECTED, { skillName: 's1' });
  collector.recordExperience('registered', { experienceId: 'e1' });
  collector.recordFramework('analyzed', { indexedFiles: ['f1.js'] });
  collector.recordArchitecture('reviewed', { findingId: 'a1' });
  collector.recordScan('scanned', { findingId: 'f1' });
  
  assertEqual(collector._entries.length, 6, 'Should have 6 entries');
  const byModule = collector.getStats().byModule;
  assert(byModule[ModuleType.SKILL], 'Should have Skill module records');
  assert(byModule[ModuleType.PROMPT], 'Should have Prompt module records');
});

test('Collector stats calculation works correctly', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  collector.recordSkill('registered', { skillName: 's1' });
  collector.recordSkill('evolved', { skillName: 's1' });
  collector.recordPrompt('injected', { skillName: 's1' });
  
  const stats = collector.getStats();
  assertEqual(stats.totalEntries, 3, 'Should count 3 entries');
  assertEqual(stats.byModule[ModuleType.SKILL], 2, 'Should have 2 Skill entries');
  assertEqual(stats.byModule[ModuleType.PROMPT], 1, 'Should have 1 Prompt entry');
});

test('Collector setStage tracks current workflow stage', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  collector.setStage('ANALYSE');
  collector.recordSkill('registered', { skillName: 's1' });
  
  assertEqual(collector._entries[0].stage, 'ANALYSE', 'Entry should be tagged with current stage');
  
  collector.setStage('CODE');
  collector.recordSkill('evolved', { skillName: 's1' });
  
  assertEqual(collector._entries[1].stage, 'CODE', 'Second entry should have CODE stage');
});

// Test 3: Validator functionality
console.log('\n🔍 Validator Tests');

const { ConsistencyValidator, ValidationSeverity } = require('./consistency-validator');

test('Validator detects unregistered skill injection', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  // Inject skill without registering it first
  collector.recordPrompt('injected', { skillName: 'unregistered_skill' });
  
  const validator = new ConsistencyValidator(collector);
  const report = validator.validateAll();
  
  assert(report.issues.length > 0, 'Should detect issues');
  const skillPromptIssues = report.issues.filter(i => i.category === 'Skill-Prompt Consistency');
  assert(skillPromptIssues.length > 0, 'Should have Skill-Prompt consistency issues');
});

test('Validator passes when skill is properly registered and injected', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  // Register then inject
  collector.recordSkill('registered', { skillName: 'my_skill', version: '1.0.0' });
  collector.recordPrompt('injected', { skillName: 'my_skill', version: '1.0.0' });
  
  const validator = new ConsistencyValidator(collector);
  const report = validator.validateCategory('skill-prompt');
  
  const errors = report.issues.filter(i => i.severity === ValidationSeverity.ERROR);
  assertEqual(errors.length, 0, 'Should have no errors for proper skill flow');
});

test('Validator detects version mismatch', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  collector.recordSkill('registered', { skillName: 'skill_v', version: '1.0.0' });
  collector.recordPrompt('injected', { skillName: 'skill_v', version: '2.0.0' });
  
  const validator = new ConsistencyValidator(collector);
  const report = validator.validateAll();
  
  const warnings = report.issues.filter(i => i.severity === ValidationSeverity.WARNING);
  assert(warnings.length > 0, 'Should warn about version mismatch');
});

test('Validator generates report with correct structure', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  collector.recordSkill('registered', { skillName: 's1' });
  
  const validator = new ConsistencyValidator(collector);
  const report = validator.validateAll();
  
  assert(report.timestamp, 'Should have timestamp');
  assert(report.summary, 'Should have summary');
  assert(typeof report.summary.totalIssues === 'number', 'Summary should have totalIssues');
  assert(report.issues, 'Should have issues array');
  assert(report.byCategory, 'Should have byCategory grouping');
  assert(report.byModule, 'Should have byModule grouping');
});

// Test 4: Manager functionality
console.log('\n🎛️ Manager Tests');

const { IntrospectionManager } = require('./introspection-manager');

test('Manager initializes correctly', () => {
  const manager = new IntrospectionManager();
  manager.initialize({ sessionId: 'test', outputDir: './test-output' });
  
  assert(manager.isInitialized(), 'Manager should be initialized');
  assert(manager.collector, 'Manager should have collector');
});

test('Manager disabled mode works correctly', () => {
  const manager = new IntrospectionManager();
  manager.initialize({ sessionId: 'test', outputDir: './test-output', enabled: false });
  
  assert(!manager.isInitialized(), 'Manager should NOT be initialized when disabled');
  
  const stats = manager.getStats();
  assertEqual(stats.totalEntries, 0, 'Should return empty stats when disabled');
});

test('Manager health check works correctly', () => {
  const manager = new IntrospectionManager();
  manager.initialize({ sessionId: 'test', outputDir: './test-output' });
  
  // Initially no issues
  const health = manager.healthCheck();
  assert(health.healthy, 'Should be healthy with no issues');
  
  // Add inconsistent data
  manager.collector.recordPrompt('injected', { skillName: 'unregistered' });
  
  const healthAfter = manager.healthCheck();
  assert(!healthAfter.healthy, 'Should be unhealthy after adding inconsistent data');
});

// Test 5: Module data flow
console.log('\n🔄 Data Flow Tests');

test('Collector tracks data flow between modules', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  const traceId = 'trace-001';
  
  // Skill produces data
  collector.recordSkill('produced', { entityId: 'skill-data' }, { traceId });
  
  // Prompt consumes it
  collector.recordPrompt('consumed', { entityId: 'skill-data' }, { traceId });
  
  const flows = collector.findDataFlow(ModuleType.SKILL, ModuleType.PROMPT);
  assertEqual(flows.length, 1, 'Should find 1 data flow');
  assertEqual(flows[0].traceId, traceId, 'Flow should have correct trace ID');
});

test('Collector finds orphaned entities', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test' });
  
  // Produce an entity
  collector.recordSkill('produced', { entityId: 'orphaned-data' });
  
  // But nothing consumes it
  const orphaned = collector.findOrphanedEntities(ModuleType.SKILL, ModuleType.PROMPT, 'entityId');
  assert(orphaned.includes('orphaned-data'), 'Should find orphaned entity');
});

// Test 6: Report Generator (basic)
console.log('\n📊 Report Generator Tests');

const { IntrospectionReportGenerator } = require('./introspection-report-generator');

test('Report generator produces valid JSON report', () => {
  const collector = new WorkflowIntrospectionCollector();
  collector.initialize({ sessionId: 'test', outputDir: './test-output' });
  
  collector.recordSkill('registered', { skillName: 'test-skill' });
  
  const validator = new ConsistencyValidator(collector);
  const generator = new IntrospectionReportGenerator(collector, validator);
  
  // Ensure output dir exists
  if (!fs.existsSync('./test-output')) {
    fs.mkdirSync('./test-output', { recursive: true });
  }
  
  const jsonPath = generator.generateJSON('./test-output');
  assert(fs.existsSync(jsonPath), 'JSON report file should exist');
  
  const content = fs.readFileSync(jsonPath, 'utf-8');
  const report = JSON.parse(content);
  assert(report.metadata, 'Report should have metadata');
  assert(report.introspection, 'Report should have introspection data');
  
  // Cleanup
  fs.unlinkSync(jsonPath);
});

// ─── Cleanup & Summary ─────────────────────────────────────────────────────────

console.log('\n────────────────────────────────────────');
console.log(`\n📈 Test Results: ${passed} passed, ${failed} failed`);

// Cleanup test output directory
if (fs.existsSync('./test-output')) {
  fs.rmSync('./test-output', { recursive: true, force: true });
}

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\n✨ All tests passed!\n');
  process.exit(0);
}