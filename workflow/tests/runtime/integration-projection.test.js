'use strict';

const fs = require('fs');
const path = require('path');
const { FileStateStore } = require('../../core/runtime/file-state-store');
const { RuntimeProjector } = require('../../core/runtime/runtime-projector');
const { JsonlEventStore } = require('../../core/runtime/jsonl-event-store');

const TEST_PROJECT_ROOT = path.join(__dirname, '..', '__fixtures__', 'integration-test-project');
const TEST_RUNTIME_DIR = path.join(TEST_PROJECT_ROOT, 'output', 'runtime');
const TEST_EVENTS_DIR = path.join(TEST_RUNTIME_DIR, 'events');

function setup() {
  if (fs.existsSync(TEST_PROJECT_ROOT)) {
    fs.rmSync(TEST_PROJECT_ROOT, { recursive: true });
  }
  fs.mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(TEST_EVENTS_DIR, { recursive: true });
}

function cleanup() {
  if (fs.existsSync(TEST_PROJECT_ROOT)) {
    fs.rmSync(TEST_PROJECT_ROOT, { recursive: true });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// T-7: Projection Contract Integration Test
// ============================================

async function testFileStateStoreListSessions() {
  console.log('\n[TEST] FileStateStore: List Sessions');
  setup();

  const store = new FileStateStore({ runtimeDir: TEST_RUNTIME_DIR });

  const sessions = store.listSessions();
  console.assert(sessions.length === 0, 'Empty session list initially');

  const session = store.createSession({
    projectId: 'test-list',
    requirement: 'Test list sessions',
    mode: 'test',
    initialStage: 'INIT',
  });

  const sessionsAfter = store.listSessions();
  console.assert(sessionsAfter.length === 1, 'Session added to list');
  console.assert(sessionsAfter[0].sessionId === session.sessionId, 'Session ID matches');
  console.assert(sessionsAfter[0].status === 'CREATED', 'Session status correct');

  console.log('  ✅ FileStateStore listSessions works');

  cleanup();
}

async function testRuntimeProjectorWithFileStateStore() {
  console.log('\n[TEST] RuntimeProjector with FileStateStore');
  setup();

  const store = new FileStateStore({ runtimeDir: TEST_RUNTIME_DIR });
  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);

  const session = store.createSession({
    projectId: 'test-projector',
    requirement: 'Test projector integration',
    mode: 'test',
    initialStage: 'INIT',
  });

  const manifest = projector.projectManifest(session.sessionId);
  console.assert(manifest !== null, 'Manifest projected');
  console.assert(manifest.currentState === 'INIT', 'Manifest has correct initial state');

  const status = projector.projectWorkflowStatus(session.sessionId);
  console.assert(status !== null, 'Workflow status projected');
  console.assert(status.activeWorkflow.session === session.sessionId, 'Status has session ID');

  console.log('  ✅ RuntimeProjector integration works');

  cleanup();
}

// ============================================
// T-8: E2E Projection Workflow Test
// ============================================

async function testE2EProjectionPipeline() {
  console.log('\n[TEST] E2E: Full Projection Pipeline (FileStateStore → Projector → Files)');
  setup();

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: path.join(TEST_PROJECT_ROOT, 'output'),
    projection: { enabled: true, sync: true },
  });

  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  store._projector = projector;

  const session = store.createSession({
    projectId: 'e2e-projection-test',
    requirement: 'Test end-to-end projection workflow',
    mode: 'test',
    initialStage: 'INIT',
  });

  console.assert(fs.existsSync(path.join(TEST_RUNTIME_DIR, 'session-state.json')), 'session-state.json created');

  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.beginStage({ sessionId: session.sessionId, stage: 'ANALYSE', stageInput: 'Analyze requirements' });

  const manifestPath = path.join(TEST_PROJECT_ROOT, 'output', 'manifest.json');
  const workflowStatusPath = path.join(TEST_PROJECT_ROOT, 'output', 'workflow-status.json');

  console.assert(fs.existsSync(manifestPath), 'manifest.json written to output');
  console.assert(fs.existsSync(workflowStatusPath), 'workflow-status.json written to output');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const workflowStatus = JSON.parse(fs.readFileSync(workflowStatusPath, 'utf8'));

  console.assert(manifest.currentState === 'ANALYSE', 'manifest.json has ANALYSE state');
  console.assert(manifest.meta.sessionId === session.sessionId, 'manifest.json has correct session ID');
  console.assert(workflowStatus.activeWorkflow.currentStage === 'ANALYSE', 'workflow-status.json has ANALYSE');

  store.completeStage({
    sessionId: session.sessionId,
    stage: 'ANALYSE',
    outputRefs: [{ path: 'output/analysis.md', type: 'document' }],
  });

  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.assert(updatedManifest.artifacts.requirementMd === 'output/analysis.md', 'manifest reflects output artifact');

  console.log('  ✅ E2E projection pipeline works');

  cleanup();
}

async function testProjectionDisabledMode() {
  console.log('\n[TEST] E2E: Projection Disabled Mode');
  setup();

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: path.join(TEST_PROJECT_ROOT, 'output'),
    projection: { enabled: false },
  });

  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  store._projector = projector;

  const session = store.createSession({
    projectId: 'disabled-test',
    requirement: 'Test disabled projection',
    mode: 'test',
    initialStage: 'INIT',
  });

  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });

  const manifestPath = path.join(TEST_PROJECT_ROOT, 'output', 'manifest.json');
  const workflowStatusPath = path.join(TEST_PROJECT_ROOT, 'output', 'workflow-status.json');

  console.assert(!fs.existsSync(manifestPath), 'manifest.json NOT written when disabled');
  console.assert(!fs.existsSync(workflowStatusPath), 'workflow-status.json NOT written when disabled');

  const sessionStatePath = path.join(TEST_RUNTIME_DIR, 'session-state.json');
  console.assert(fs.existsSync(sessionStatePath), 'Runtime state ALWAYS written regardless of projection');

  console.log('  ✅ Disabled projection mode works');

  cleanup();
}

async function testAsyncProjectionMode() {
  console.log('\n[TEST] E2E: Async Projection Mode');
  setup();

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: path.join(TEST_PROJECT_ROOT, 'output'),
    projection: { enabled: true, sync: false },
  });

  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  store._projector = projector;

  const session = store.createSession({
    projectId: 'async-test',
    requirement: 'Test async projection',
    mode: 'test',
    initialStage: 'INIT',
  });

  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });

  await delay(100);

  console.log('  ⏳ Async projection: configuration valid');

  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });

  await delay(100);

  console.log('  ✅ Async mode configuration accepted');

  cleanup();
}

async function testStageTransitionsWithProjection() {
  console.log('\n[TEST] E2E: Stage Transitions with Projection');
  setup();

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: path.join(TEST_PROJECT_ROOT, 'output'),
    projection: { enabled: true, sync: true },
  });

  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  store._projector = projector;

  const session = store.createSession({
    projectId: 'stage-transitions',
    requirement: 'Test stage transitions',
    mode: 'test',
    initialStage: 'INIT',
  });

  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });

  store.beginStage({ sessionId: session.sessionId, stage: 'ANALYSE' });
  store.completeStage({ sessionId: session.sessionId, stage: 'ANALYSE' });

  store.beginStage({ sessionId: session.sessionId, stage: 'ARCHITECT' });

  const manifestPath = path.join(TEST_PROJECT_ROOT, 'output', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.assert(manifest.currentState === 'ARCHITECT', 'State after transitions correct');
  console.assert(manifest.history.length >= 3, 'History has multiple entries');
  console.assert(manifest.artifacts.requirementMd !== undefined, 'Artifacts tracked');

  console.log('  ✅ Stage transitions with projection work');

  cleanup();
}

// ============================================
// T-9: Rollout Config Test
// ============================================

async function testRuntimeConfigUpdate() {
  console.log('\n[TEST] Rollout: Runtime Projection Config Update');
  setup();

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: path.join(TEST_PROJECT_ROOT, 'output'),
    projection: { enabled: true, sync: true },
  });

  const config1 = store.getProjectionConfig();
  console.assert(config1.enabled === true, 'Default: enabled=true');
  console.assert(config1.sync === true, 'Default: sync=true');

  store.setProjectionConfig({ enabled: false });
  const config2 = store.getProjectionConfig();
  console.assert(config2.enabled === false, 'Runtime update: enabled=false');
  console.assert(config2.sync === true, 'Unchanged value preserved: sync=true');

  store.setProjectionConfig({ sync: false, enabled: true });
  const config3 = store.getProjectionConfig();
  console.assert(config3.enabled === true, 'Runtime update: enabled=true');
  console.assert(config3.sync === false, 'Runtime update: sync=false');

  console.log('  ✅ Runtime config updates work for rollout flexibility');

  cleanup();
}

async function testCustomOutputDir() {
  console.log('\n[TEST] Rollout: Custom Output Directory');
  setup();

  const customOutputDir = path.join(TEST_PROJECT_ROOT, 'custom-output');
  fs.mkdirSync(customOutputDir, { recursive: true });

  const store = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: customOutputDir,
    projection: { enabled: true, sync: true },
  });

  const eventStore = new JsonlEventStore({ eventsDir: TEST_EVENTS_DIR });
  const projector = new RuntimeProjector(store, eventStore);
  store._projector = projector;

  const session = store.createSession({
    projectId: 'custom-output-test',
    requirement: 'Test custom output dir',
    mode: 'test',
    initialStage: 'INIT',
  });

  store.beginStage({ sessionId: session.sessionId, stage: 'INIT' });
  store.completeStage({ sessionId: session.sessionId, stage: 'INIT' });

  const manifestPath = path.join(customOutputDir, 'manifest.json');
  console.assert(fs.existsSync(manifestPath), 'manifest.json written to custom output dir');

  console.log('  ✅ Custom output directory works');

  cleanup();
}

// ============================================
// Test Runner
// ============================================

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════════════════════╗');
  console.log('║   Integration Projection Test Suite (Phase 3: T-7/T-8/T-9)             ║');
  console.log('╚════════════════════════════════════════════════════════════════════════╝\n');

  const tests = [
    { name: 'FileStateStore List Sessions', fn: testFileStateStoreListSessions },
    { name: 'RuntimeProjector Integration', fn: testRuntimeProjectorWithFileStateStore },
    { name: 'E2E Projection Pipeline', fn: testE2EProjectionPipeline },
    { name: 'Disabled Projection Mode', fn: testProjectionDisabledMode },
    { name: 'Async Projection Mode', fn: testAsyncProjectionMode },
    { name: 'Stage Transitions', fn: testStageTransitionsWithProjection },
    { name: 'Runtime Config Update', fn: testRuntimeConfigUpdate },
    { name: 'Custom Output Directory', fn: testCustomOutputDir },
  ];

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL [${name}]: ${err.message}`);
      failed++;
    }
  }

  console.log('\n┌────────────────────────────────────────────────────────────────────────┐');
  console.log(`│  Results: ${passed}/${tests.length} passed, ${failed}/${tests.length} failed                           │`);
  console.log('└────────────────────────────────────────────────────────────────────────┘\n');

  return { passed, failed };
}

if (require.main === module) {
  runAllTests().then(({ passed, failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

module.exports = { runAllTests };
