'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  assessArchitectureGovernance,
  runArchitectureScenarioHarness,
  evaluateArchitectureFitnessGates,
} = require('../core/execution-validator-integration');

const { getRollbackScenarioSummary } = require('../core/rollback-coordinator');
const { getRuntimeProjectionScenarioSummary } = require('../core/runtime/file-state-store');
const { ARCHITECTURE_SCORECARD_DIMENSIONS } = require('../core/review-checklists');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

section('Fact Source Helpers');

test('getRollbackScenarioSummary returns stage subtasks, targets, and cache keys', () => {
  const summary = getRollbackScenarioSummary();
  assert.ok(summary.stageSubtasks, 'should have stageSubtasks');
  assert.ok(summary.rollbackTargets, 'should have rollbackTargets');
  assert.ok(summary.cacheKeys, 'should have cacheKeys');
  assert.ok(typeof summary.stageSubtasks === 'object', 'stageSubtasks should be an object');
  assert.ok(typeof summary.rollbackTargets === 'object', 'rollbackTargets should be an object');
});

test('getRuntimeProjectionScenarioSummary returns path structure and recovery fields', () => {
  const summary = getRuntimeProjectionScenarioSummary();
  assert.ok(summary.outputDir, 'should have outputDir');
  assert.ok(summary.runtimeDir, 'should have runtimeDir');
  assert.ok(summary.statePath, 'should have statePath');
  assert.ok(summary.recoveryFields, 'should have recoveryFields');
  assert.ok(Array.isArray(summary.recoveryFields), 'recoveryFields should be array');
  assert.ok(summary.recoveryFields.length > 0, 'recoveryFields should not be empty');
});

test('ARCHITECTURE_SCORECARD_DIMENSIONS is a non-empty array with category/itemIds/severity counts', () => {
  assert.ok(Array.isArray(ARCHITECTURE_SCORECARD_DIMENSIONS), 'should be array');
  assert.ok(ARCHITECTURE_SCORECARD_DIMENSIONS.length > 0, 'should not be empty');
  const first = ARCHITECTURE_SCORECARD_DIMENSIONS[0];
  assert.ok(first.category, 'dimension should have category');
  assert.ok(Array.isArray(first.itemIds), 'dimension should have itemIds array');
  assert.ok(typeof first.highSeverityCount === 'number', 'dimension should have highSeverityCount');
});

section('Scenario Harness');

test('runArchitectureScenarioHarness returns scenario array and summary', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: ['test warning'] },
    contracts: { migrationSafety: { present: false }, failureModel: { present: false } },
  });
  assert.ok(result.version, 'should have version');
  assert.ok(Array.isArray(result.scenarios), 'should have scenarios array');
  assert.ok(result.summary, 'should have summary');
  assert.strictEqual(result.scenarios.length, 4, 'should have exactly 4 scenarios');
});

test('scenario harness includes projection-contract-drift scenario', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: { migrationSafety: { present: false } },
  });
  const drift = result.scenarios.find(s => s.id === 'projection-contract-drift');
  assert.ok(drift, 'should have projection-contract-drift scenario');
  assert.strictEqual(drift.category, 'projection');
});

test('scenario harness includes rollback-boundary scenario', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: { migrationSafety: { present: false } },
  });
  const rollback = result.scenarios.find(s => s.id === 'rollback-boundary');
  assert.ok(rollback, 'should have rollback-boundary scenario');
  assert.strictEqual(rollback.category, 'rollback');
});

test('scenario harness includes recovery-path scenario', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: {},
  });
  const recovery = result.scenarios.find(s => s.id === 'recovery-path');
  assert.ok(recovery, 'should have recovery-path scenario');
  assert.strictEqual(recovery.category, 'recovery');
});

test('scenario harness marks recovery-path as degraded when no projection evidence', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: {},
  });
  const recovery = result.scenarios.find(s => s.id === 'recovery-path');
  assert.strictEqual(recovery.degraded, true, 'should be degraded without projection evidence');
});

test('bridge-contract-divergence always passes', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: {},
  });
  const divergence = result.scenarios.find(s => s.id === 'bridge-contract-divergence');
  assert.strictEqual(divergence.passed, true, 'bridge contract divergence should always pass');
});

test('summary meetsMinimumCoverage reflects scenario category breadth, not artifact content', () => {
  const result = runArchitectureScenarioHarness({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
    availability: { hasProjectionEvidence: false, hasArchitecture: false, hasProjectProfile: false, warnings: [] },
    contracts: {},
  });
  assert.strictEqual(result.summary.meetsMinimumCoverage, true, '4 scenarios cover 4 categories, meeting minimum breadth');
});

section('Fitness Gate Evaluation');

test('evaluateArchitectureFitnessGates fails when score is below threshold', () => {
  const governance = {
    scorecard: { totalScore: 40, gapSummary: { highSeverityGapIds: [] } },
    contracts: { overallValid: true },
    scenarioHarness: { summary: { meetsMinimumCoverage: true, degraded: 0 } },
    degradation: { active: false },
  };
  const gates = evaluateArchitectureFitnessGates(governance, { minScore: 70 });
  assert.strictEqual(gates.passed, false, 'should fail with low score');
  const scoreCheck = gates.checks.find(c => c.id === 'architecture-score-threshold');
  assert.ok(scoreCheck, 'should have score threshold check');
  assert.strictEqual(scoreCheck.passed, false);
});

test('evaluateArchitectureFitnessGates fails when contracts are invalid', () => {
  const governance = {
    scorecard: { totalScore: 85, gapSummary: { highSeverityGapIds: [] } },
    contracts: { overallValid: false },
    scenarioHarness: { summary: { meetsMinimumCoverage: true, degraded: 0 } },
    degradation: { active: false },
  };
  const gates = evaluateArchitectureFitnessGates(governance);
  const contractCheck = gates.checks.find(c => c.id === 'architecture-contracts-valid');
  assert.strictEqual(contractCheck.passed, false);
});

test('evaluateArchitectureFitnessGates fails with too many high severity gaps', () => {
  const governance = {
    scorecard: { totalScore: 85, gapSummary: { highSeverityGapIds: ['g1', 'g2'] } },
    contracts: { overallValid: true },
    scenarioHarness: { summary: { meetsMinimumCoverage: true, degraded: 0 } },
    degradation: { active: false },
  };
  const gates = evaluateArchitectureFitnessGates(governance, { maxHighSeverityGaps: 0 });
  const gapCheck = gates.checks.find(c => c.id === 'architecture-high-severity-gaps');
  assert.strictEqual(gapCheck.passed, false);
});

test('evaluateArchitectureFitnessGates passes with all conditions met', () => {
  const governance = {
    scorecard: { totalScore: 85, gapSummary: { highSeverityGapIds: [] } },
    contracts: { overallValid: true },
    scenarioHarness: { summary: { meetsMinimumCoverage: true, degraded: 0 } },
    degradation: { active: false },
  };
  const gates = evaluateArchitectureFitnessGates(governance);
  assert.strictEqual(gates.passed, true, 'should pass with all conditions met');
  assert.strictEqual(gates.failedChecks.length, 0, 'should have no failed checks');
});

test('fitness gates reports degraded when governance is in degradation mode', () => {
  const governance = {
    scorecard: { totalScore: 85, gapSummary: { highSeverityGapIds: [] } },
    contracts: { overallValid: true, degraded: true },
    scenarioHarness: { summary: { meetsMinimumCoverage: true, degraded: 0 } },
    degradation: { active: true },
  };
  const gates = evaluateArchitectureFitnessGates(governance);
  assert.strictEqual(gates.degraded, true, 'should report degraded');
  assert.strictEqual(gates.passed, true, 'can still pass while degraded');
});

section('Full Governance Assessment');

test('assessArchitectureGovernance returns all required top-level keys', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent.md'),
  });
  assert.ok('architecturePath' in result, 'should have architecturePath');
  assert.ok('exists' in result, 'should have exists');
  assert.ok('scorecard' in result, 'should have scorecard');
  assert.ok('contracts' in result, 'should have contracts');
  assert.ok('scenarioHarness' in result, 'should have scenarioHarness');
  assert.ok('fitnessGates' in result, 'should have fitnessGates');
  assert.ok('degradation' in result, 'should have degradation');
});

test('assessArchitectureGovernance with missing artifact sets exists=false', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent-test.md'),
  });
  assert.strictEqual(result.exists, false);
});

test('assessArchitectureGovernance contracts include failureModel and migrationSafety', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent.md'),
  });
  assert.ok(result.contracts.failureModel, 'should have failureModel');
  assert.ok(result.contracts.migrationSafety, 'should have migrationSafety');
  assert.ok('overallValid' in result.contracts, 'should have overallValid');
});

test('assessArchitectureGovernance scenarioHarness has 4 scenarios', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent.md'),
  });
  assert.strictEqual(result.scenarioHarness.scenarios.length, 4);
});

test('assessArchitectureGovernance fitnessGates has checks array', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent.md'),
  });
  assert.ok(Array.isArray(result.fitnessGates.checks), 'should have checks array');
  assert.ok(result.fitnessGates.checks.length >= 4, 'should have at least 4 gate checks');
});

test('assessArchitectureGovernance degradation tracks warnings', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    architecturePath: path.resolve(__dirname, '..', '..', 'output', 'nonexistent.md'),
  });
  assert.ok('active' in result.degradation, 'should have active flag');
  assert.ok(Array.isArray(result.degradation.warnings), 'should have warnings array');
});

section('Contract Field-Level Validation');

const SAMPLE_FAILURE_MODEL = `## Failure Model
- Failure Mode: Network partition between services
- Detection Signal: Health check timeout > 30s
- Mitigation: Circuit breaker with exponential backoff
- Recovery: Automatic reconnection with state reconciliation
`;

const SAMPLE_MIGRATION_SAFETY = `## Migration Safety Case
- Backward Compatibility: API versioning with v1/v2 endpoints
- Rollback Strategy: Blue-green deployment with instant switch
- Contract Evidence: Projection contract validated against manifest
- Data Migration Scope: Schema migration with zero-downtime dual-write
`;

const FULL_ARTIFACT = `${SAMPLE_FAILURE_MODEL}\n${SAMPLE_MIGRATION_SAFETY}\n## Scenario Coverage\n- projection drift: covered\n- rollback boundary: covered\n- recovery path: covered\n`;

test('governance with full artifact passes contract validation', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: FULL_ARTIFACT,
  });
  assert.strictEqual(result.contracts.failureModel.present, true, 'failure model should be present');
  assert.strictEqual(result.contracts.failureModel.valid, true, 'failure model should be valid');
  assert.strictEqual(result.contracts.migrationSafety.present, true, 'migration safety should be present');
  assert.strictEqual(result.contracts.overallValid, true, 'overall contracts should be valid');
});

test('governance with full artifact has no missing failure model fields', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: FULL_ARTIFACT,
  });
  assert.strictEqual(result.contracts.failureModel.missingFields.length, 0, 'should have no missing fields');
});

test('governance with incomplete artifact reports missing fields', () => {
  const incompleteArtifact = `## Failure Model\n- Failure Mode: Network partition\n`;
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: incompleteArtifact,
  });
  assert.ok(result.contracts.failureModel.missingFields.length > 0, 'should report missing fields');
  assert.strictEqual(result.contracts.overallValid, false, 'overall should be invalid');
});

test('governance with empty artifact marks both sections as not present', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: '',
  });
  assert.strictEqual(result.contracts.failureModel.present, false);
  assert.strictEqual(result.contracts.migrationSafety.present, false);
  assert.strictEqual(result.contracts.overallValid, false);
});

section('Dual-Mode Sync Verification');

test('governance result shape is consistent between direct call and bridge contract', () => {
  const result = assessArchitectureGovernance({
    projectRoot: path.resolve(__dirname, '..', '..'),
    artifactContent: FULL_ARTIFACT,
  });

  const requiredBridgeFields = [
    'architectureScorecard',
    'architectureContracts',
    'architectureScenarioHarness',
    'architectureFitnessGates',
    'governanceDegradation',
  ];

  const mappedFields = {
    architectureScorecard: result.scorecard,
    architectureContracts: result.contracts,
    architectureScenarioHarness: result.scenarioHarness,
    architectureFitnessGates: result.fitnessGates,
    governanceDegradation: result.degradation,
  };

  for (const field of requiredBridgeFields) {
    assert.ok(mappedFields[field] !== undefined, `bridge field ${field} should have a governance mapping`);
  }
});

test('stage-architect.js imports assessArchitectureGovernance', () => {
  const architectPath = path.resolve(__dirname, '..', 'core', 'stage-architect.js');
  const content = fs.readFileSync(architectPath, 'utf-8');
  assert.ok(content.includes('assessArchitectureGovernance'), 'stage-architect should import governance function');
});

test('ide-workflow-bridge.js uses architectureGovernance single computation', () => {
  const bridgePath = path.resolve(__dirname, '..', 'tools', 'ide-workflow-bridge.js');
  const content = fs.readFileSync(bridgePath, 'utf-8');
  assert.ok(content.includes('architectureGovernance'), 'bridge should compute governance once');
  assert.ok(content.includes('architectureScenarioHarness'), 'bridge should return scenarioHarness');
  assert.ok(content.includes('architectureFitnessGates'), 'bridge should return fitnessGates');
});

console.log(`\n${'═'.repeat(70)}`);
console.log(`Architecture Governance Test Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(70)}`);

if (failed > 0) {
  process.exit(1);
}
