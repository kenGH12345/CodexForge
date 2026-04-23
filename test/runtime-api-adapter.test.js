'use strict';

/**
 * Unit Tests for RuntimeApiAdapter (T-6)
 *
 * Verifies:
 *   - Adapter initialization and lazy loading
 *   - Manifest projection generation
 *   - Workflow-status projection generation
 *   - Contract validation integration
 *   - Bridge command handling
 *   - Error handling for missing sessions
 */

const path = require('path');
const fs = require('fs');
const { RuntimeApiAdapter } = require('../workflow/tools/runtime-api-adapter');

// ─── Test Utilities ─────────────────────────────────────────────────────────

const TEST_DIR = path.join(__dirname, 'temp-runtime-test');
const TEST_RUNTIME_DIR = path.join(TEST_DIR, 'runtime');
const TEST_OUTPUT_DIR = path.join(TEST_DIR, 'output');

function createMockSession(sessionId, status = 'active') {
  const session = {
    sessionId,
    status,
    projectId: 'test-project',
    currentState: 'stage1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    history: [{ state: 'stage1', enteredAt: new Date().toISOString() }],
    artifacts: {},
    risks: [],
    meta: { sessionId },
    activeWorkflow: {
      session: sessionId,
      startedAt: new Date().toISOString(),
      currentStage: 'stage1',
      completedStages: [],
    },
    recovery: {
      resumeState: null,
      blockedReason: null,
      pendingCompensationCount: 0,
    },
  };

  const sessionPath = path.join(TEST_RUNTIME_DIR, 'session-state.json');
  const eventsDir = path.join(TEST_RUNTIME_DIR, 'events');
  const sessionDir = path.join(eventsDir, sessionId);

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');

  const index = { sessions: { [sessionId]: { status, updatedAt: session.updatedAt } } };
  fs.writeFileSync(path.join(TEST_RUNTIME_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');

  fs.writeFileSync(
    path.join(sessionDir, 'events.jsonl'),
    JSON.stringify({ kind: 'SESSION_STARTED', sessionId, timestamp: session.createdAt }) + '\n'
  );

  return session;
}

function cleanupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
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

async function runTests() {
  console.log('\n═══ RuntimeApiAdapter Tests (T-6) ═══\n');

  // Setup
  cleanupTestDir();
  fs.mkdirSync(TEST_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

  // ─── Initialization Tests ────────────────────────────────────────────

  console.log('── Initialization ──');

  const adapter = new RuntimeApiAdapter({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });

  assert(!adapter.isInitialized(), 'Should not be initialized before init()');

  adapter.init();
  assert(adapter.isInitialized(), 'Should be initialized after init()');

  // Double init should be safe
  adapter.init();
  assert(adapter.isInitialized(), 'Should remain initialized after double init');

  // ─── Session Listing ─────────────────────────────────────────────────

  console.log('── Session Listing ──');

  // Empty runtime
  let sessions = adapter.listSessions();
  assert(Array.isArray(sessions), 'listSessions should return array');
  assert(sessions.length === 0, 'Should return empty array for no sessions');

  // Create mock session
  const testSessionId = 'test-session-001';
  createMockSession(testSessionId, 'active');

  // Need fresh adapter to pick up new session
  const adapter2 = new RuntimeApiAdapter({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  adapter2.init();

  sessions = adapter2.listSessions();
  assert(sessions.length === 1, 'Should return 1 session');
  assert(sessions[0].sessionId === testSessionId, 'Should have correct sessionId');
  assert(sessions[0].status === 'active', 'Should have correct status');

  // ─── Manifest Generation ────────────────────────────────────────────

  console.log('── Manifest Generation ──');

  const manifestResult = adapter2.generateManifest(testSessionId, { validate: true });
  assert(manifestResult.manifest !== null, 'Should generate manifest');
  assert(manifestResult.manifest.sessionId === testSessionId, 'Manifest should have correct sessionId');
  assert(manifestResult.manifest.meta?.sessionId === testSessionId, 'Manifest meta should have sessionId');
  assert(manifestResult.validation !== undefined, 'Should include validation when validate=true');
  assert(manifestResult.validation.valid === true, 'Manifest should pass validation');

  // Non-existent session
  const badManifest = adapter2.generateManifest('non-existent', { validate: true });
  assert(badManifest.manifest === null, 'Should return null for non-existent session');
  assert(badManifest.error !== undefined, 'Should include error for non-existent session');

  // ─── Workflow Status Generation ─────────────────────────────────────

  console.log('── Workflow Status Generation ──');

  const statusResult = adapter2.generateWorkflowStatus(testSessionId, { validate: true });
  assert(statusResult.workflowStatus !== null, 'Should generate workflowStatus');
  assert(statusResult.workflowStatus.activeWorkflow?.session === testSessionId, 'Should have correct session in activeWorkflow');
  assert(statusResult.validation !== undefined, 'Should include validation when validate=true');
  assert(statusResult.validation.valid === true, 'WorkflowStatus should pass validation');

  // Non-existent session
  const badStatus = adapter2.generateWorkflowStatus('non-existent', { validate: true });
  assert(badStatus.workflowStatus === null, 'Should return null for non-existent session');
  assert(badStatus.error !== undefined, 'Should include error for non-existent session');

  // ─── Both Projections ────────────────────────────────────────────────

  console.log('── Both Projections ──');

  const bothResult = adapter2.generateBoth(testSessionId, { validate: true, writeLegacy: false });
  assert(bothResult.manifest !== undefined, 'Should include manifest');
  assert(bothResult.workflowStatus !== undefined, 'Should include workflowStatus');
  assert(bothResult.manifestValidation !== undefined, 'Should include manifestValidation');
  assert(bothResult.workflowStatusValidation !== undefined, 'Should include workflowStatusValidation');
  assert(bothResult.written === undefined, 'Should not write legacy files when writeLegacy=false');
  assert(bothResult.errors.length === 0, 'Should have no errors');

  // ─── Bridge Command Handling ────────────────────────────────────────

  console.log('── Bridge Command Handling ──');

  const cmdResult = adapter2.handleProjectionCommand({
    sessionId: testSessionId,
    format: 'both',
    validate: true,
    writeLegacy: false,
  });

  assert(cmdResult.success === true, 'Command should succeed');
  assert(cmdResult.sessionId === testSessionId, 'Should return sessionId');
  assert(cmdResult.manifest !== undefined, 'Should include manifest in result');
  assert(cmdResult.workflowStatus !== undefined, 'Should include workflowStatus in result');

  // Auto-detect latest session
  const autoResult = adapter2.handleProjectionCommand({
    format: 'manifest',
  });
  assert(autoResult.success === true, 'Auto-detect should succeed');
  assert(autoResult.sessionId === testSessionId, 'Should auto-detect latest session');

  // Format variations
  const manifestCmd = adapter2.handleProjectionCommand({
    sessionId: testSessionId,
    format: 'manifest',
  });
  assert(manifestCmd.success === true, 'Manifest-only format should work');
  assert(manifestCmd.manifest !== undefined, 'Should include manifest');

  const statusCmd = adapter2.handleProjectionCommand({
    sessionId: testSessionId,
    format: 'status',
  });
  assert(statusCmd.success === true, 'Status-only format should work');
  assert(statusCmd.workflowStatus !== undefined, 'Should include workflowStatus');

  const traceCmd = adapter2.handleProjectionCommand({
    sessionId: testSessionId,
    format: 'trace',
  });
  assert(traceCmd.success === true, 'Trace format should work');
  assert(Array.isArray(traceCmd.trace), 'Trace should be array');

  // ─── Legacy File Writing ─────────────────────────────────────────────

  console.log('── Legacy File Writing ──');

  // Clean output dir first
  const legacyManifestPath = path.join(TEST_OUTPUT_DIR, 'manifest.json');
  const legacyStatusPath = path.join(TEST_OUTPUT_DIR, 'workflow-status.json');

  if (fs.existsSync(legacyManifestPath)) fs.unlinkSync(legacyManifestPath);
  if (fs.existsSync(legacyStatusPath)) fs.unlinkSync(legacyStatusPath);

  const writeResult = adapter2.handleProjectionCommand({
    sessionId: testSessionId,
    format: 'both',
    writeLegacy: true,
  });

  assert(writeResult.success === true, 'Write command should succeed');
  assert(writeResult.written !== undefined, 'Should return written paths');
  assert(fs.existsSync(legacyManifestPath), 'manifest.json should be written');
  assert(fs.existsSync(legacyStatusPath), 'workflow-status.json should be written');

  // Verify content
  const writtenManifest = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf-8'));
  assert(writtenManifest.sessionId === testSessionId, 'Written manifest should have correct sessionId');

  const writtenStatus = JSON.parse(fs.readFileSync(legacyStatusPath, 'utf-8'));
  assert(writtenStatus.activeWorkflow?.session === testSessionId, 'Written status should have correct session');

  // ─── Configuration ───────────────────────────────────────────────────

  console.log('── Configuration ──');

  const config = adapter2.getProjectionConfig();
  assert(typeof config.enabled === 'boolean', 'Config should have enabled');
  assert(typeof config.sync === 'boolean', 'Config should have sync');
  assert(typeof config.validate === 'boolean', 'Config should have validate');

  adapter2.setProjectionConfig({ validate: false });
  const newConfig = adapter2.getProjectionConfig();
  assert(newConfig.validate === false, 'setProjectionConfig should update validate');

  // ─── No Sessions Error ───────────────────────────────────────────────

  console.log('── No Sessions Error ──');

  // Clear test data
  if (fs.existsSync(path.join(TEST_RUNTIME_DIR, 'session-state.json'))) {
    fs.unlinkSync(path.join(TEST_RUNTIME_DIR, 'session-state.json'));
  }
  if (fs.existsSync(path.join(TEST_RUNTIME_DIR, 'index.json'))) {
    fs.unlinkSync(path.join(TEST_RUNTIME_DIR, 'index.json'));
  }

  const adapter3 = new RuntimeApiAdapter({
    projectRoot: TEST_DIR,
    runtimeDir: TEST_RUNTIME_DIR,
    outputDir: TEST_OUTPUT_DIR,
  });
  adapter3.init();

  const noSessionResult = adapter3.handleProjectionCommand({});
  assert(noSessionResult.success === false, 'Should fail when no sessions exist');
  assert(noSessionResult.error !== undefined, 'Should include error message');

  // Cleanup
  cleanupTestDir();

  // ─── Summary ─────────────────────────────────────────────────────────

  console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══\n`);

  return failed === 0;
}

// Run if executed directly
if (require.main === module) {
  runTests().then(ok => process.exit(ok ? 0 : 1));
}

module.exports = { runTests };
