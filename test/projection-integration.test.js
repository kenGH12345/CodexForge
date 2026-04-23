'use strict';

/**
 * Integration Tests for Projection System (T-9)
 *
 * End-to-end workflow verification:
 *   - StateManager → EventStore → Projector pipeline
 *   - FileStateStore auto-triggers projections
 *   - Legacy manifest.json + workflow-status.json output
 *   - Bridge projection command integration
 *   - Contract validation on real data
 *   - IDE hooks file watching
 */

const path = require('path');
const fs = require('fs');
const { FileStateStore } = require('../workflow/core/runtime/file-state-store');
const { RuntimeProjector } = require('../workflow/core/runtime/runtime-projector');
const { JsonlEventStore } = require('../workflow/core/runtime/jsonl-event-store');
const { RuntimeEventStore } = require('../workflow/core/runtime/runtime-event-store');
const { ProjectionContractValidator } = require('../workflow/core/runtime/projection-contract-validator');
const { IdeProjectionHooks } = require('../workflow/tools/ide-projection-hooks');

// ─── Test Utilities ─────────────────────────────────────────────────────────

const TEST_DIR = path.join(__dirname, 'temp-integration-test');
const TEST_RUNTIME_DIR = path.join(TEST_DIR, 'runtime');
const TEST_OUTPUT_DIR = path.join(TEST_DIR, 'output');

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setupDirs() {
  fs.mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });
}

// ─── Test Runner ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n═══ Projection Integration Tests (T-9) ═══\n');

  // Setup
  cleanup();
  setupDirs();

  // ─── Pipeline: StateManager → EventStore → Projector ────────────────

  console.log('── Full Pipeline: StateManager → EventStore → Projector ──');

  // Create integrated system
  const stateManager = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false }, // Disable automatic projection for manual control
  });

  const eventsDir = path.join(TEST_RUNTIME_DIR, 'events');
  const backingStore = new JsonlEventStore({ eventsDir });
  const eventStore = new RuntimeEventStore({ backingStore });

  const projector = new RuntimeProjector(stateManager, eventStore);
  stateManager._projector = projector; // Inject for projection

  const validator = new ProjectionContractValidator();

  // Create and save session
  const sessionId = 'integration-test-001';
  const session = stateManager.createSession(sessionId, 'Test Project');
  stateManager.saveSession(session);

  assert(session.sessionId === sessionId, 'Session should be created with correct ID');
  assert(session.status === 'active', 'Session should be active');

  // Generate projections via RuntimeProjector
  const manifest = projector.projectManifest(sessionId);
  const workflowStatus = projector.projectWorkflowStatus(sessionId);

  assert(manifest !== null, 'Manifest should be generated');
  assert(manifest.sessionId === sessionId, 'Manifest should have correct sessionId');
  assert(workflowStatus !== null, 'WorkflowStatus should be generated');
  assert(workflowStatus.activeWorkflow?.session === sessionId, 'WorkflowStatus should have correct session');

  // Validate projections
  const manifestValidation = validator.validateManifest(manifest);
  const statusValidation = validator.validateWorkflowStatus(workflowStatus);

  assert(manifestValidation.valid === true, 'Manifest should pass validation');
  assert(statusValidation.valid === true, 'WorkflowStatus should pass validation');

  // ─── FileStateStore Auto-Trigger ─────────────────────────────────────

  console.log('── FileStateStore Auto-Trigger ──');

  // Create state manager WITH projection enabled
  const autoStateManager = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: true, sync: true }, // Enable synchronous projection
  });
  autoStateManager._projector = projector;

  cleanup();
  setupDirs();

  const autoSessionId = 'auto-trigger-test-001';
  const autoSession = autoStateManager.createSession(autoSessionId, 'Auto Test');
  autoStateManager.saveSession(autoSession);

  // Load the session (this should trigger projection)
  const loadedSession = autoStateManager.loadSession(autoSessionId);
  assert(loadedSession !== null, 'Session should be loaded');

  // Wait a moment for sync projection
  await delay(100);

  // Check if legacy files were written
  const manifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const statusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');

  // Note: Auto-trigger happens on _saveUpdated, not loadSession
  // So files may not exist yet - let's do an update that triggers save
  autoStateManager.updateStatus(autoSessionId, 'running');

  await delay(100);

  // After updateStatus, files should be written
  const manifestExists = fs.existsSync(manifestPath);
  const statusExists = fs.existsSync(statusPath);

  assert(manifestExists, 'manifest.json should be written after status update');
  assert(statusExists, 'workflow-status.json should be written after status update');

  if (manifestExists && statusExists) {
    const writtenManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const writtenStatus = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));

    assert(writtenManifest.currentState === 'running', 'Written manifest should reflect updated status');
    assert(writtenStatus.activeWorkflow?.session === autoSessionId, 'Written status should have correct session');
  }

  // ─── Legacy Output Format Verification ──────────────────────────────

  console.log('── Legacy Output Format Verification ──');

  cleanup();
  setupDirs();

  // Create fresh state manager with projection enabled
  const legacyStateManager = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: true, sync: true },
  });
  legacyStateManager._projector = projector;

  const legacySessionId = 'legacy-test-001';
  const legacySession = legacyStateManager.createSession(legacySessionId, 'Legacy Test');
  legacyStateManager.saveSession(legacySession);
  legacyStateManager.updateStatus(legacySessionId, 'completed');

  await delay(100);

  const legacyManifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const legacyStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');

  assert(fs.existsSync(legacyManifestPath), 'manifest.json should exist');
  assert(fs.existsSync(legacyStatusPath), 'workflow-status.json should exist');

  const legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf-8'));
  const legacyStatus = JSON.parse(fs.readFileSync(legacyStatusPath, 'utf-8'));

  // Verify manifest structure matches expected legacy format
  assert(typeof legacyManifest.version === 'number', 'Manifest should have version');
  assert(typeof legacyManifest.projectId === 'string', 'Manifest should have projectId');
  assert(typeof legacyManifest.currentState === 'string', 'Manifest should have currentState');
  assert(typeof legacyManifest.createdAt === 'string', 'Manifest should have createdAt');
  assert(typeof legacyManifest.updatedAt === 'string', 'Manifest should have updatedAt');
  assert(Array.isArray(legacyManifest.history), 'Manifest should have history array');
  assert(typeof legacyManifest.meta === 'object', 'Manifest should have meta object');
  assert(legacyManifest.meta.sessionId === legacySessionId, 'Manifest meta should have correct sessionId');

  // Verify workflow-status structure
  assert(typeof legacyStatus.activeWorkflow === 'object', 'WorkflowStatus should have activeWorkflow');
  assert(legacyStatus.activeWorkflow.session === legacySessionId, 'activeWorkflow should have correct session');
  assert(typeof legacyStatus.activeWorkflow.startedAt === 'string', 'activeWorkflow should have startedAt');
  assert(Array.isArray(legacyStatus.activeWorkflow.completedStages), 'completedStages should be array');

  // ─── Bridge Integration ──────────────────────────────────────────────

  console.log('── Bridge Integration ──');

  cleanup();
  setupDirs();

  // Simulate Bridge command execution via RuntimeApiAdapter
  const { RuntimeApiAdapter } = require('../workflow/tools/runtime-api-adapter');

  const bridgeAdapter = new RuntimeApiAdapter({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { validate: true },
  });
  bridgeAdapter.init();

  const bridgeSessionId = 'bridge-test-001';

  // Create session through FileStateStore (simulating actual workflow)
  const bridgeStore = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false }, // Bridge controls projection
  });
  const bridgeEventsDir = path.join(TEST_RUNTIME_DIR, 'events');
  const bridgeBacking = new JsonlEventStore({ eventsDir: bridgeEventsDir });
  const bridgeEventStore = new RuntimeEventStore({ backingStore: bridgeBacking });
  const bridgeProjector = new RuntimeProjector(bridgeStore, bridgeEventStore);
  bridgeStore._projector = bridgeProjector;

  const bridgeSession = bridgeStore.createSession(bridgeSessionId, 'Bridge Test');
  bridgeStore.saveSession(bridgeSession);

  // Bridge command: generate projections
  const bridgeResult = bridgeAdapter.handleProjectionCommand({
    sessionId: bridgeSessionId,
    format: 'both',
    validate: true,
    writeLegacy: true,
  });

  assert(bridgeResult.success === true, 'Bridge command should succeed');
  assert(bridgeResult.sessionId === bridgeSessionId, 'Should return correct sessionId');
  assert(bridgeResult.manifest !== undefined, 'Should include manifest');
  assert(bridgeResult.workflowStatus !== undefined, 'Should include workflowStatus');
  assert(bridgeResult.manifestValidation !== undefined, 'Should include manifest validation');
  assert(bridgeResult.workflowStatusValidation !== undefined, 'Should include status validation');
  assert(bridgeResult.written !== undefined, 'Should report written files');

  // Verify legacy files were written
  const bridgeManifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const bridgeStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');
  assert(fs.existsSync(bridgeManifestPath), 'Bridge should write manifest.json');
  assert(fs.existsSync(bridgeStatusPath), 'Bridge should write workflow-status.json');

  // ─── IDE Hooks Integration ──────────────────────────────────────────

  console.log('── IDE Hooks Integration ──');

  cleanup();
  setupDirs();

  const ideStore = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false }, // Hooks control projection
  });
  const ideEventsDir = path.join(TEST_RUNTIME_DIR, 'events');
  const ideBacking = new JsonlEventStore({ eventsDir: ideEventsDir });
  const ideEventStore = new RuntimeEventStore({ backingStore: ideBacking });
  const ideProjector = new RuntimeProjector(ideStore, ideEventStore);
  ideStore._projector = ideProjector;

  const ideSessionId = 'ide-test-001';
  const ideSession = ideStore.createSession(ideSessionId, 'IDE Test');
  ideStore.saveSession(ideSession);

  // Initialize IDE hooks
  const hooks = new IdeProjectionHooks({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projectionConfig: { lazy: true, validate: true }, // Lazy mode for IDE
  });
  hooks.init({ startWatching: false }); // Don't start file watcher in tests

  // Verify hooks status
  const status = hooks.getStatus();
  assert(status.active === false, 'Hooks should not be watching (test mode)');
  assert(status.lazy === true, 'Hooks should be in lazy mode');
  assert(status.pending === false, 'Should have no pending projections initially');

  // Trigger lazy projection
  const lazyResult = hooks.triggerProjection();
  assert(lazyResult.status === 'deferred', 'Lazy mode should defer projections');

  // Force immediate projection
  const flushResult = hooks.flushPending();
  assert(flushResult.status === 'completed', 'Flush should complete projections');
  assert(flushResult.sessionsProcessed >= 1, 'Should process at least one session');

  // Verify files written
  const ideManifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const ideStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');
  assert(fs.existsSync(ideManifestPath), 'IDE hooks should write manifest.json');
  assert(fs.existsSync(ideStatusPath), 'IDE hooks should write workflow-status.json');

  // Clean up hooks
  hooks.destroy();

  // ─── Error Handling & Edge Cases ────────────────────────────────────

  console.log('── Error Handling & Edge Cases ──');

  cleanup();
  setupDirs();

  const errorAdapter = new RuntimeApiAdapter({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  errorAdapter.init();

  // Non-existent session should return error gracefully
  const noSessionResult = errorAdapter.handleProjectionCommand({
    sessionId: 'non-existent',
    format: 'both',
  });
  assert(noSessionResult.success === false, 'Should fail for non-existent session');
  assert(noSessionResult.error !== undefined, 'Should include error message');

  // No sessions at all
  const emptyResult = errorAdapter.handleProjectionCommand({});
  assert(emptyResult.success === false, 'Should fail when no sessions exist');
  assert(emptyResult.error !== undefined, 'Should explain no sessions found');

  // Invalid format should fall back to 'both'
  const errorStore = new FileStateStore({
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
    projection: { enabled: false },
  });
  const errorEventsDir = path.join(TEST_RUNTIME_DIR, 'events');
  const errorBacking = new JsonlEventStore({ eventsDir: errorEventsDir });
  const errorEventStore = new RuntimeEventStore({ backingStore: errorBacking });
  const errorProjector = new RuntimeProjector(errorStore, errorEventStore);
  errorStore._projector = errorProjector;

  const errorSessionId = 'edge-test-001';
  const errorSession = errorStore.createSession(errorSessionId, 'Edge Test');
  errorStore.saveSession(errorSession);

  const invalidFormatResult = errorAdapter.handleProjectionCommand({
    sessionId: errorSessionId,
    format: 'invalid-format',
  });
  assert(invalidFormatResult.success === true, 'Invalid format should fall back gracefully');

  // ─── Cleanup ─────────────────────────────────────────────────────────

  cleanup();

  // ─── Summary ─────────────────────────────────────────────────────────

  console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══\n`);

  return failed === 0;
}

// Run if executed directly
if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
