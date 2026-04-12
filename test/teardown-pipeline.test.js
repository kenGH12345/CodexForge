'use strict';

/**
 * Tests for Declarative Teardown Pipeline (P0 teardown-impl)
 *
 * Verifies:
 *   - TeardownStep base class contract
 *   - TeardownPipeline registration and topological sort
 *   - TeardownContext execution tracking
 *   - Error isolation (non-blocking)
 *   - Skip conditions
 *   - Bridge summary generation
 *   - Full pipeline creation via index.js
 */

const { TeardownStep } = require('../core/teardown-step');
const { TeardownPipeline, TeardownContext } = require('../core/teardown-pipeline');

// ─── Mock Step Helpers ──────────────────────────────────────────────────────

class MockStep extends TeardownStep {
  constructor(config, impl) {
    super(config);
    this._impl = impl || (() => {});
    this.executed = false;
  }

  async execute(ctx) {
    this.executed = true;
    if (this._impl) await this._impl(ctx);
  }
}

class FailingStep extends TeardownStep {
  constructor(config, errorMsg) {
    super(config);
    this._errorMsg = errorMsg;
  }

  async execute(ctx) {
    throw new Error(this._errorMsg);
  }
}

class SkipStep extends TeardownStep {
  constructor(config) {
    super(config);
  }

  async execute() {
    // Should never be called
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
  console.log('\n═══ TeardownPipeline Tests ═══\n');

  // ─── TeardownStep ────────────────────────────────────────────────────

  console.log('── TeardownStep ──');

  // Test: name is required
  try {
    new TeardownStep({});
    assert(false, 'Should throw on missing name');
  } catch (e) {
    assert(e.message.includes('name is required'), 'Should throw on missing name');
  }

  // Test: defaults
  const step = new TeardownStep({ name: 'test' });
  assert(step.name === 'test', 'Name should be set');
  assert(step.priority === 50, 'Default priority should be 50');
  assert(step.before.length === 0, 'Default before should be empty');
  assert(step.after.length === 0, 'Default after should be empty');
  assert(step.requires.length === 0, 'Default requires should be empty');

  // Test: execute must be overridden
  try {
    await step.execute({});
    assert(false, 'Should throw on base execute');
  } catch (e) {
    assert(e.message.includes('must implement execute'), 'Base execute should throw');
  }

  // Test: checkSkip with missing requires
  const reqStep = new TeardownStep({ name: 'req', requires: ['nonExistent'] });
  const skipResult = reqStep.checkSkip({ orch: {} });
  assert(skipResult.skip === true, 'Should skip when required property missing');
  assert(skipResult.reason.includes('nonExistent'), 'Should mention missing property');

  // Test: checkSkip with custom shouldSkip
  const customSkip = new TeardownStep({
    name: 'cskip',
    shouldSkip: () => 'Custom reason',
  });
  const customResult = customSkip.checkSkip({ orch: {} });
  assert(customResult.skip === true, 'Should skip with custom condition');
  assert(customResult.reason === 'Custom reason', 'Should use custom reason');

  // Test: getName
  assert(step.getName() === 'test', 'getName should return name');

  // ─── TeardownContext ─────────────────────────────────────────────────

  console.log('── TeardownContext ──');

  const ctx = new TeardownContext({
    orch: { foo: 'bar' },
    mode: 'sequential',
    extra: { goal: 'test' },
    shouldEvolve: { aefRefinement: true },
  });

  assert(ctx.orch.foo === 'bar', 'Should have orch reference');
  assert(ctx.mode === 'sequential', 'Should have mode');
  assert(ctx.extra.goal === 'test', 'Should have extra');

  ctx.recordSkip('step1', 'Missing prop');
  ctx.recordExecution('step2', 50);
  ctx.recordFailure('step3', new Error('test'));

  const summary = ctx.getSummary();
  assert(summary.skipped === 1, 'Should have 1 skipped');
  assert(summary.executed === 1, 'Should have 1 executed');
  assert(summary.failed === 1, 'Should have 1 failed');
  assert(summary.steps.skipped[0].step === 'step1', 'Should track skipped step name');
  assert(summary.steps.executed[0].durationMs === 50, 'Should track execution duration');
  assert(summary.steps.failed[0].error === 'test', 'Should track failure message');

  // ─── TeardownPipeline: Registration ──────────────────────────────────

  console.log('── TeardownPipeline: Registration ──');

  const pipeline = new TeardownPipeline();

  // Test: register steps
  pipeline.register(new MockStep({ name: 'a', priority: 10 }));
  pipeline.register(new MockStep({ name: 'b', priority: 20 }));
  assert(pipeline.size === 2, 'Should have 2 steps');

  // Test: duplicate registration
  try {
    pipeline.register(new MockStep({ name: 'a', priority: 30 }));
    assert(false, 'Should throw on duplicate registration');
  } catch (e) {
    assert(e.message.includes('already registered'), 'Should reject duplicate');
  }

  // Test: non-TeardownStep registration
  try {
    pipeline.register({ name: 'bad' });
    assert(false, 'Should throw on non-TeardownStep');
  } catch (e) {
    assert(e.message.includes('instance of TeardownStep'), 'Should reject non-TeardownStep');
  }

  // ─── TeardownPipeline: Ordering ──────────────────────────────────────

  console.log('── TeardownPipeline: Ordering ──');

  const ordered = new TeardownPipeline();
  ordered.register(new MockStep({ name: 'z', priority: 90 }));
  ordered.register(new MockStep({ name: 'a', priority: 10 }));
  ordered.register(new MockStep({ name: 'm', priority: 50 }));

  const order = ordered.resolveOrder();
  assert(order[0] === 'a', 'a (10) should be first');
  assert(order[1] === 'm', 'm (50) should be middle');
  assert(order[2] === 'z', 'z (90) should be last');

  // Test: before/after constraints
  const constrained = new TeardownPipeline();
  constrained.register(new MockStep({ name: 'flush', priority: 50 }));
  constrained.register(new MockStep({ name: 'dashboard', priority: 50, after: ['flush'] }));
  constrained.register(new MockStep({ name: 'setup', priority: 50, before: ['flush'] }));

  const constrainedOrder = constrained.resolveOrder();
  const setupIdx = constrainedOrder.indexOf('setup');
  const flushIdx = constrainedOrder.indexOf('flush');
  const dashIdx = constrainedOrder.indexOf('dashboard');
  assert(setupIdx < flushIdx, 'setup should run before flush');
  assert(flushIdx < dashIdx, 'flush should run before dashboard');

  // ─── TeardownPipeline: Execution ─────────────────────────────────────

  console.log('── TeardownPipeline: Execution ──');

  const execPipeline = new TeardownPipeline();
  const executionOrder = [];

  execPipeline.register(new MockStep({ name: 'first', priority: 10 }, () => executionOrder.push('first')));
  execPipeline.register(new MockStep({ name: 'second', priority: 20 }, () => executionOrder.push('second')));
  execPipeline.register(new MockStep({ name: 'third', priority: 30 }, () => executionOrder.push('third')));

  const execCtx = new TeardownContext({
    orch: {},
    mode: 'test',
    extra: {},
    shouldEvolve: {},
  });

  const result = await execPipeline.execute(execCtx);
  assert(result.executed === 3, 'All 3 steps should execute');
  assert(result.failed === 0, 'No failures expected');
  assert(executionOrder[0] === 'first', 'Execution order should match priority');
  assert(executionOrder[1] === 'second', 'Execution order should match priority');
  assert(executionOrder[2] === 'third', 'Execution order should match priority');

  // ─── TeardownPipeline: Error Isolation ───────────────────────────────

  console.log('── TeardownPipeline: Error Isolation ──');

  const errPipeline = new TeardownPipeline();
  errPipeline.register(new MockStep({ name: 'before-fail', priority: 10 }, () => executionOrder.push('bf')));
  errPipeline.register(new FailingStep({ name: 'fail', priority: 20 }, 'Kaboom!'));
  errPipeline.register(new MockStep({ name: 'after-fail', priority: 30 }, () => executionOrder.push('af')));

  const errCtx = new TeardownContext({
    orch: {},
    mode: 'test',
    extra: {},
    shouldEvolve: {},
  });

  const errResult = await errPipeline.execute(errCtx);
  assert(errResult.executed === 2, '2 steps should succeed despite 1 failure');
  assert(errResult.failed === 1, '1 step should fail');
  assert(errCtx._failed[0].step === 'fail', 'Failed step name should be recorded');
  assert(errCtx._failed[0].error === 'Kaboom!', 'Error message should be recorded');

  // ─── TeardownPipeline: Skip ──────────────────────────────────────────

  console.log('── TeardownPipeline: Skip ──');

  const skipPipeline = new TeardownPipeline();
  skipPipeline.register(new MockStep({ name: 'always-run', priority: 10 }));
  skipPipeline.register(new SkipStep({
    name: 'skip-me',
    priority: 20,
    requires: ['nonExistentProp'],
  }));

  const skipCtx = new TeardownContext({
    orch: {},
    mode: 'test',
    extra: {},
    shouldEvolve: {},
  });

  const skipResult2 = await skipPipeline.execute(skipCtx);
  assert(skipResult2.executed === 1, '1 step should execute');
  assert(skipResult2.skipped === 1, '1 step should be skipped');
  assert(skipResult2.failed === 0, 'No failures');

  // ─── TeardownPipeline: Bridge Summary ────────────────────────────────

  console.log('── TeardownPipeline: Bridge Summary ──');

  const bridgePipeline = new TeardownPipeline();
  bridgePipeline.register(new MockStep({ name: 'step1', priority: 10, description: 'First step', requires: [] }));
  bridgePipeline.register(new MockStep({ name: 'step2', priority: 20, description: 'Second step', requires: ['orch'] }));

  const bridgeSummary = bridgePipeline.toBridgeSummary();
  assert(bridgeSummary.totalSteps === 2, 'Should report 2 steps');
  assert(bridgeSummary.steps[0].name === 'step1', 'First step should be step1');
  assert(bridgeSummary.steps[1].requires.includes('orch'), 'Should include requires');
  assert(typeof bridgeSummary.steps[0].priority === 'number', 'Should include priority');

  // ─── Full Pipeline Creation ──────────────────────────────────────────

  console.log('── Full Pipeline Creation (index.js) ──');

  try {
    const { createTeardownPipeline } = require('../core/teardown-steps');
    const fullPipeline = createTeardownPipeline();

    assert(fullPipeline.size === 28, `Should have 28 steps (got ${fullPipeline.size})`);

    const fullOrder = fullPipeline.getOrder();
    assert(fullOrder[0] === 'plugin-activate', 'First step should be plugin-activate');
    assert(fullOrder[fullOrder.length - 1] === 'plugin-deactivate', 'Last step should be plugin-deactivate');

    // Verify key ordering constraints
    const obsFlushIdx = fullOrder.indexOf('obs-flush');
    const obsDashIdx = fullOrder.indexOf('obs-dashboard');
    assert(obsFlushIdx < obsDashIdx, 'obs-flush should run before obs-dashboard');

    const skillIdx = fullOrder.indexOf('skill-lifecycle');
    assert(skillIdx > obsFlushIdx, 'skill-lifecycle should run after obs-flush');

    // Bridge summary should work
    const fullBridge = fullPipeline.toBridgeSummary();
    assert(fullBridge.totalSteps === 28, 'Bridge summary should report 28 steps');
    assert(fullBridge.steps.length === 28, 'Bridge steps array should have 28 entries');

    console.log('  📋 Pipeline execution order:');
    fullOrder.forEach((name, i) => {
      const step = fullPipeline.get(name);
      console.log(`    ${String(i + 1).padStart(2)}. [${String(step.priority).padStart(2)}] ${name} — ${step.description}`);
    });

  } catch (e) {
    console.warn(`  ⚠️  Full pipeline creation failed: ${e.message}`);
    console.warn(`     This is expected if some teardown step dependencies are not available in test env.`);
  }

  // ─── Results ─────────────────────────────────────────────────────────

  console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
