'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { StateMachine } = require('../core/state-machine');
const { FileStateStore } = require('../core/runtime/file-state-store');
const { WorkflowState } = require('../core/types');
const { SESSION_STATUS, STAGE_STATUS } = require('../core/runtime/types');

let tmpDir;
let manifestPath;
let runtimeDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-facade-'));
  manifestPath = path.join(tmpDir, 'output', 'manifest.json');
  runtimeDir = path.join(tmpDir, 'output', 'runtime');
  fs.mkdirSync(path.join(tmpDir, 'output'), { recursive: true });
}

function cleanup() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

let passCount = 0;
let failCount = 0;

function assert(condition, msg) {
  if (condition) {
    passCount++;
    console.log(`  ✅ ${msg}`);
  } else {
    failCount++;
    console.error(`  ❌ ${msg}`);
  }
}

async function testDefaultMode() {
  console.log('\n▶ Default Mode (useRuntimeState defaults to true)');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
  });
  const state = await sm.init();
  assert(state === WorkflowState.INIT, 'init returns INIT');
  assert(fs.existsSync(manifestPath), 'manifest.json created');
  assert(sm._useRuntimeState === true, 'useRuntimeState defaults to true');
  assert(sm._stateManager instanceof FileStateStore, 'StateManager is FileStateStore');
  assert(sm._sessionId !== null, 'sessionId assigned');

  const next = await sm.transition(null, 'test');
  assert(next === WorkflowState.ANALYSE, 'transition to ANALYSE works');
  assert(sm.getState() === WorkflowState.ANALYSE, 'getState returns ANALYSE');

  const session = sm._stateManager.loadSession(sm._sessionId);
  assert(session !== null, 'session loadable after transition');
  assert(session.currentStage === WorkflowState.ANALYSE, 'session synced to ANALYSE');

  cleanup();
}

async function testExplicitLegacyMode() {
  console.log('\n▶ Explicit Legacy Mode (useRuntimeState=false)');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: false,
  });
  const state = await sm.init();
  assert(state === WorkflowState.INIT, 'init returns INIT');
  assert(fs.existsSync(manifestPath), 'manifest.json created');
  assert(!sm._stateManager, 'no StateManager in legacy mode');
  assert(sm._useRuntimeState === false, 'useRuntimeState is false');

  const next = await sm.transition(null, 'test');
  assert(next === WorkflowState.ANALYSE, 'transition to ANALYSE works');
  assert(sm.getState() === WorkflowState.ANALYSE, 'getState returns ANALYSE');

  cleanup();
}

async function testRuntimeStateMode() {
  console.log('\n▶ Runtime State Mode (useRuntimeState=true)');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: true,
  });
  const state = await sm.init();
  assert(state === WorkflowState.INIT, 'init returns INIT');
  assert(sm._useRuntimeState === true, 'useRuntimeState is true');
  assert(sm._stateManager instanceof FileStateStore, 'StateManager is FileStateStore');
  assert(sm._sessionId !== null, 'sessionId assigned');

  const sessionPath = path.join(runtimeDir, 'session-state.json');
  assert(fs.existsSync(sessionPath), 'session-state.json created');

  const session = sm._stateManager.loadSession(sm._sessionId);
  assert(session !== null, 'session loadable');
  assert(session.currentStage === WorkflowState.INIT, 'session currentStage is INIT');
  cleanup();
}

async function testTransitionSyncsToStateManager() {
  console.log('\n▶ Transition Syncs to StateManager');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: true,
  });
  await sm.init();

  const next = await sm.transition(null, 'analyse stage');
  assert(next === WorkflowState.ANALYSE, 'transition to ANALYSE');

  const session = sm._stateManager.loadSession(sm._sessionId);
  assert(session.currentStage === WorkflowState.ANALYSE, 'session currentStage synced to ANALYSE');
  assert(session.stages.INIT, 'INIT stage recorded in session');
  assert(session.stages.ANALYSE, 'ANALYSE stage recorded in session');
  assert(session.stages.ANALYSE.status === STAGE_STATUS.RUNNING, 'ANALYSE stage is RUNNING');

  assert(fs.existsSync(manifestPath), 'manifest.json still written (dual-write)');
  cleanup();
}

async function testRollbackSyncsToStateManager() {
  console.log('\n▶ Rollback Syncs to StateManager');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: true,
  });
  await sm.init();
  await sm.transition(null, 'to ANALYSE');

  const rolled = await sm.rollback('test rollback');
  assert(rolled === WorkflowState.INIT, 'rollback returns INIT');

  const session = sm._stateManager.loadSession(sm._sessionId);
  assert(session.recovery.recoverable === true, 'recovery.recoverable is true');
  assert(session.recovery.lastRollback !== null, 'lastRollback recorded');
  cleanup();
}

async function testJumpToSyncsToStateManager() {
  console.log('\n▶ JumpTo Syncs to StateManager');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: true,
  });
  await sm.init();

  const jumped = await sm.jumpTo(WorkflowState.CODE, 'skip ahead');
  assert(jumped === WorkflowState.CODE, 'jumpTo returns CODE');

  const session = sm._stateManager.loadSession(sm._sessionId);
  assert(session.currentStage === WorkflowState.CODE, 'session currentStage synced to CODE');
  assert(session.stages.CODE, 'CODE stage recorded');
  assert(session.stages.CODE.status === STAGE_STATUS.RUNNING, 'CODE stage is RUNNING');
  cleanup();
}

async function testPublicAPIUnchanged() {
  console.log('\n▶ Public API Unchanged (AC-1)');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: true,
  });
  await sm.init();

  assert(typeof sm.getState === 'function', 'getState exists');
  assert(typeof sm.isFinished === 'function', 'isFinished exists');
  assert(typeof sm.getNextState === 'function', 'getNextState exists');
  assert(typeof sm.getPreviousState === 'function', 'getPreviousState exists');
  assert(typeof sm.transition === 'function', 'transition exists');
  assert(typeof sm.rollback === 'function', 'rollback exists');
  assert(typeof sm.jumpTo === 'function', 'jumpTo exists');
  assert(typeof sm.runParallel === 'function', 'runParallel exists');
  assert(typeof sm.runParallelStrict === 'function', 'runParallelStrict exists');
  assert(typeof sm.recordRisk === 'function', 'recordRisk exists');
  assert(typeof sm.getRisks === 'function', 'getRisks exists');
  assert(typeof sm.getArtifacts === 'function', 'getArtifacts exists');
  assert(typeof sm.setStateOrder === 'function', 'setStateOrder exists');
  assert(typeof sm.getStateOrder === 'function', 'getStateOrder exists');
  assert(typeof sm.addConditionalTransition === 'function', 'addConditionalTransition exists');
  assert(typeof sm.transitionConditional === 'function', 'transitionConditional exists');
  cleanup();
}

async function testExistingCallersUnaffected() {
  console.log('\n▶ Existing Callers Unaffected (AC-3)');
  setup();
  const sm = new StateMachine('test-project', async () => {}, {
    manifestPath,
    useRuntimeState: false,
  });
  await sm.init();

  assert(sm.getState() === WorkflowState.INIT, 'getState works');
  assert(sm.isFinished() === false, 'isFinished works');
  assert(sm.getNextState() === WorkflowState.ANALYSE, 'getNextState works');
  assert(sm.getPreviousState() === null, 'getPreviousState works at INIT');
  assert(sm.getArtifacts() !== null, 'getArtifacts works');
  assert(Array.isArray(sm.getRisks()), 'getRisks returns array');

  sm.recordRisk('high', 'test risk');
  assert(sm.getRisks().length === 1, 'recordRisk works');

  const next = await sm.transition(null, 'test');
  assert(next === WorkflowState.ANALYSE, 'transition works');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  assert(manifest.currentState === WorkflowState.ANALYSE, 'manifest persisted correctly');
  cleanup();
}

async function run() {
  console.log('🔄 StateMachine Facade Integration Tests (T-09)');
  try {
    await testDefaultMode();
    await testExplicitLegacyMode();
    await testRuntimeStateMode();
    await testTransitionSyncsToStateManager();
    await testRollbackSyncsToStateManager();
    await testJumpToSyncsToStateManager();
    await testPublicAPIUnchanged();
    await testExistingCallersUnaffected();
  } catch (err) {
    console.error(`\n❌ Test error: ${err.message}`);
    console.error(err.stack);
    failCount++;
  }
  console.log(`\n──────────────────────────────────`);
  console.log(`ℹ  pass: ${passCount}`);
  console.log(`ℹ  fail: ${failCount}`);
  console.log(`──────────────────────────────────`);
  process.exit(failCount > 0 ? 1 : 0);
}

run();
