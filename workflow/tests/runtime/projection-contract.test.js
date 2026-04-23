'use strict';

const fs = require('fs');
const path = require('path');
const { FileStateStore } = require('../../core/runtime/file-state-store');
const { RuntimeProjector } = require('../../core/runtime/runtime-projector');
const { validateRuntimeProjector, validateAll } = require('../../core/runtime/contract-validator');
const { JsonlEventStore } = require('../../core/runtime/jsonl-event-store');
const { SESSION_STATUS, STAGE_STATUS } = require('../../core/runtime/types');

const TEST_RUNTIME_DIR = path.join(__dirname, '..', '__fixtures__', 'projection-test-runtime');
const TEST_EVENTS_DIR = path.join(TEST_RUNTIME_DIR, 'events');
const TEST_OUTPUT_DIR = path.join(TEST_RUNTIME_DIR, 'output');

function setup() {
  if (fs.existsSync(TEST_RUNTIME_DIR)) {
    fs.rmSync(TEST_RUNTIME_DIR, { recursive: true });
  }
  fs.mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(TEST_EVENTS_DIR, { recursive: true });
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

function cleanup() {
  if (fs.existsSync(TEST_RUNTIME_DIR)) {
    fs.rmSync(TEST_RUNTIME_DIR, { recursive: true });
  }
}

// ============================================
// T-1: Projection Contract Validator Tests
// ============================================

function testValidateRuntimeProjectorInterface() {
  console.log('\n[TEST] validateRuntimeProjector: Interface Contract');
  
  const validProjector = {
    projectManifest: () => {},
    projectWorkflowStatus: () => {},
    projectHealthTrace: () => {},
  };
  
  const result = validateRuntimeProjector(validProjector);
  console.assert(result.pass === true, 'Valid projector should pass');
  console.assert(result.missing.length === 0, `No missing methods: ${result.missing}`);
  console.log('  ✅ Valid projector passes contract validation');
  
  const invalidProjector = {
    projectManifest: () => {},
  };
  
  const invalidResult = validateRuntimeProjector(invalidProjector);
  console.assert(invalidResult.pass === false, 'Invalid projector should fail');
  console.assert(invalidResult.missing.includes('projectWorkflowStatus'), 'Should detect missing projectWorkflowStatus');
  console.assert(invalidResult.missing.includes('projectHealthTrace'), 'Should detect missing projectHealthTrace');
  console.log('  ✅ Invalid projector correctly detected');
}

function testValidateAllContracts() {
  console.log('\n[TEST] validateAll: Combined Contract Validation');
  
  const fullImplementation = {
    createSession: () => {},
    loadSession: () => {},
    saveSession: () => {},
    beginStage: () => {},
    completeStage: () => {},
    failStage: () => {},
    beginTask: () => {},
    completeTask: () => {},
    failTask: () => {},
    saveCheckpoint: () => {},
    getLatestCheckpoint: () => {},
    markRollback: () => {},
    markRetry: () => {},
    projectCompatibility: () => {},
    projectRecoveryMeta: () => {},
    append: () => {},
    query: () => {},
    queryOne: () => {},
    getStats: () => {},
    projectManifest: () => {},
    projectWorkflowStatus: () => {},
    projectHealthTrace: () => {},
  };
  
  const result = validateAll(fullImplementation);
  console.assert(result.pass === true, 'Full implementation should pass all contracts');
  console.assert(result.results.stateManager.pass === true, 'StateManager contract passes');
  console.assert(result.results.eventStore.pass === true, 'EventStore contract passes');
  console.assert(result.results.runtimeProjector.pass === true, 'RuntimeProjector contract passes');
  console.log('  ✅ All contracts validated successfully');
}

// ============================================
// T-2: FileStateStore Projection Config Tests
// ============================================

function testFileStateStoreDefaultProjectionConfig() {
  console.log('\n[TEST] FileStateStore: Default Projection Configuration');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  
  const config = store.getProjectionConfig();
  console.assert(config.enabled === true, 'Projection enabled by default');
  console.assert(config.sync === true, 'Sync projection by default');
  console.log('  ✅ Default projection config correct');
  
  cleanup();
}

function testFileStateStoreCustomProjectionConfig() {
  console.log('\n[TEST] FileStateStore: Custom Projection Configuration');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false, sync: false },
  });
  
  const config = store.getProjectionConfig();
  console.assert(config.enabled === false, 'Projection can be disabled');
  console.assert(config.sync === false, 'Async mode configurable');
  console.log('  ✅ Custom projection config respected');
  
  cleanup();
}

function testFileStateStoreRuntimeProjectionConfigUpdate() {
  console.log('\n[TEST] FileStateStore: Runtime Config Update');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  
  store.setProjectionConfig({ enabled: false });
  let config = store.getProjectionConfig();
  console.assert(config.enabled === false, 'Config updated at runtime');
  console.assert(config.sync === true, 'Unchanged values preserved');
  
  store.setProjectionConfig({ sync: false });
  config = store.getProjectionConfig();
  console.assert(config.sync === false, 'Sync config updated');
  console.log('  ✅ Runtime config updates work');
  
  cleanup();
}

// ============================================
// T-3: Projection Schema & Integration Tests
// ============================================

function testRuntimeProjectorManifestSchema() {
  console.log('\n[TEST] RuntimeProjector: Manifest Projection Schema');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  
  const eventStore = new JsonlEventStore({ dir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  
  const session = store.createSession({
    projectId: 'test-projection',
    requirement: 'Test projection output',
    mode: 'test',
    initialStage: 'INIT',
  });
  
  store.beginStage({ sessionId: session.sessionId, stage: 'ANALYSE', inputRefs: ['input.md'] });
  store.completeStage({ sessionId: session.sessionId, stage: 'ANALYSE', outputRefs: [{ path: 'analysis.md', type: 'document' }] });
  
  const manifest = projector.projectManifest(session.sessionId);
  
  console.assert(manifest !== null, 'Manifest projected successfully');
  console.assert(manifest.version === '1.0.0', 'Manifest has correct version');
  console.assert(manifest.projectId === 'test-projection', 'Project ID correct');
  console.assert(manifest.currentState === 'ANALYSE', 'Current state correct');
  console.assert(Array.isArray(manifest.history), 'History is array');
  console.assert(manifest.artifacts !== undefined, 'Artifacts object exists');
  console.assert(manifest.meta.sessionId === session.sessionId, 'Session ID in meta');
  console.log('  ✅ Manifest schema correct');
  
  cleanup();
}

function testRuntimeProjectorWorkflowStatusSchema() {
  console.log('\n[TEST] RuntimeProjector: WorkflowStatus Projection Schema');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  
  const eventStore = new JsonlEventStore({ dir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  
  const session = store.createSession({
    projectId: 'test-status',
    requirement: 'Test workflow status',
    mode: 'test',
    initialStage: 'INIT',
  });
  
  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.beginStage({ sessionId: session.sessionId, stage: 'ANALYSE' });
  
  const status = projector.projectWorkflowStatus(session.sessionId);
  
  console.assert(status !== null, 'Workflow status projected successfully');
  console.assert(status.activeWorkflow !== undefined, 'Has activeWorkflow');
  console.assert(status.activeWorkflow.session === session.sessionId, 'Session ID correct');
  console.assert(status.activeWorkflow.currentStage === 'ANALYSE', 'Current stage correct');
  console.assert(Array.isArray(status.activeWorkflow.completedStages), 'Completed stages is array');
  console.assert(status.activeWorkflow.completedStages.includes('INIT'), 'INIT stage marked completed');
  console.log('  ✅ WorkflowStatus schema correct');
  
  cleanup();
}

function testEndToEndProjectionOutput() {
  console.log('\n[TEST] End-to-End: Projection writes manifest.json and workflow-status.json');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: true, sync: true },
  });
  
  const eventStore = new JsonlEventStore({ dir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  
  store._projector = projector;
  
  const session = store.createSession({
    projectId: 'test-e2e',
    requirement: 'Test end-to-end projection',
    mode: 'test',
    initialStage: 'INIT',
  });
  
  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.beginStage({ sessionId: session.sessionId, stage: 'ANALYSE' });
  
  const manifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const workflowStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');
  
  console.assert(fs.existsSync(manifestPath), 'manifest.json was written');
  console.assert(fs.existsSync(workflowStatusPath), 'workflow-status.json was written');
  
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const workflowStatus = JSON.parse(fs.readFileSync(workflowStatusPath, 'utf8'));
  
  console.assert(manifest.currentState === 'ANALYSE', 'Manifest has correct current state');
  console.assert(workflowStatus.activeWorkflow.currentStage === 'ANALYSE', 'WorkflowStatus has correct current stage');
  console.log('  ✅ E2E projection output successful');
  
  cleanup();
}

function testProjectionDisabled() {
  console.log('\n[TEST] Projection: Disabled mode does not write output files');
  setup();
  
  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false },
  });
  
  const eventStore = new JsonlEventStore({ dir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  
  store._projector = projector;
  
  const session = store.createSession({
    projectId: 'test-disabled',
    requirement: 'Test disabled projection',
    mode: 'test',
    initialStage: 'INIT',
  });
  
  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });
  
  const manifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const workflowStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');
  
  console.assert(!fs.existsSync(manifestPath), 'manifest.json not written when disabled');
  console.assert(!fs.existsSync(workflowStatusPath), 'workflow-status.json not written when disabled');
  console.log('  ✅ Disabled projection correctly skips output');
  
  cleanup();
}

// ============================================
// Test Runner
// ============================================

async function runAllTests() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║   Projection Contract Test Suite (Phase 1: T-1/T-2/T-3)   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  let passed = 0;
  let failed = 0;
  
  const tests = [
    testValidateRuntimeProjectorInterface,
    testValidateAllContracts,
    testFileStateStoreDefaultProjectionConfig,
    testFileStateStoreCustomProjectionConfig,
    testFileStateStoreRuntimeProjectionConfigUpdate,
    testRuntimeProjectorManifestSchema,
    testRuntimeProjectorWorkflowStatusSchema,
    testEndToEndProjectionOutput,
    testProjectionDisabled,
  ];
  
  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${err.message}`);
      failed++;
    }
  }
  
  console.log('\n┌───────────────────────────────────────────────────────────┐');
  console.log(`│  Results: ${passed} passed, ${failed} failed                        │`);
  console.log('└───────────────────────────────────────────────────────────┘\n');
  
  return { passed, failed };
}

if (require.main === module) {
  runAllTests().then(({ passed, failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

module.exports = { runAllTests };
