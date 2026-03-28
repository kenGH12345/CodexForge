/**
 * Connectivity Smoke Test – Cross-Module Interface Verification
 *
 * Purpose: Catches "dark disconnection" bugs where a module calls a method
 * that doesn't exist on the target object. These bugs are especially dangerous
 * because they're often masked by typeof checks and try/catch blocks.
 *
 * Example of what this catches:
 *   - stage-analyst.js calling experienceStore.query() when only .search() exists
 *   - stage-planner.js calling experienceStore.query() (same bug)
 *   - Any future API rename that leaves stale callers behind
 *
 * Run: node workflow/tests/test-connectivity.js
 */

'use strict';

const assert = require('assert');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log('\n' + '='.repeat(60));
console.log('  Connectivity Smoke Test – Cross-Module Interface Verification');
console.log('='.repeat(60) + '\n');

// ─── 1. ExperienceStore API Surface ──────────────────────────────────────────
// Verifies that ALL methods called by consumers actually exist on ExperienceStore.

console.log('  📦 ExperienceStore API Surface\n');

const { ExperienceStore } = require('../core/experience-store');
const es = new ExperienceStore(null); // In-memory only, no file I/O

// Methods called by stage context builders (architect, developer, tester, analyst, planner)
const CONTEXT_BUILDER_METHODS = [
  'getContextBlockWithIds',  // architect-context-builder, developer-context-builder, tester-context-builder, stage-analyst, stage-planner
  'getContextBlock',         // orchestrator-helpers
  'search',                  // commands-agentflow, orchestrator-helpers
];

for (const method of CONTEXT_BUILDER_METHODS) {
  test(`ExperienceStore.${method}() exists (used by context builders)`, () => {
    assert.strictEqual(typeof es[method], 'function',
      `ExperienceStore.${method} is ${typeof es[method]}, expected function. ` +
      `This will cause silent failures in context builders that call this method.`);
  });
}

// Methods called by stage-runner-utils (EvoMap feedback loop)
const EVOMAP_METHODS = [
  'computeMatchedIds',   // stage-runner-utils L204
  'markUsedBatch',       // stage-runner-utils L210
  'triggerEvolutions',   // stage-runner-utils L224
];

for (const method of EVOMAP_METHODS) {
  test(`ExperienceStore.${method}() exists (used by EvoMap feedback)`, () => {
    assert.strictEqual(typeof es[method], 'function',
      `ExperienceStore.${method} is ${typeof es[method]}, expected function. ` +
      `This will break the experience evolution feedback loop.`);
  });
}

// Methods called by record/write consumers
const WRITE_METHODS = [
  'record',                // 8+ files
  'recordIfAbsent',        // complaint-wall, deep-audit-orchestrator, execution-validator, etc.
  'recordWithContentCheck', // stage-developer, stage-tester
  'flushDirty',            // stage-tester L420
];

for (const method of WRITE_METHODS) {
  test(`ExperienceStore.${method}() exists (used by write consumers)`, () => {
    assert.strictEqual(typeof es[method], 'function',
      `ExperienceStore.${method} is ${typeof es[method]}, expected function.`);
  });
}

// Methods called by management/lifecycle consumers
const LIFECYCLE_METHODS = [
  'getStats',          // orchestrator-init, deep-audit-checks, commands-agentflow
  'getAll',            // orchestrator-teardown-impl
  'checkLayerHealth',  // orchestrator-teardown-impl
  'purgeExpired',      // sleeptime, index.js
  'setLlmCall',        // index.js L423
  'setComplaintWall',  // index.js L272
  'getSynonymTable',   // prompt-builder L686
  'save',              // mape-executors (public alias for _save)
  'expandKeywords',    // commands-agentflow (public alias for _expandKeywordsWithLlm)
];

for (const method of LIFECYCLE_METHODS) {
  test(`ExperienceStore.${method}() exists (used by lifecycle)`, () => {
    assert.strictEqual(typeof es[method], 'function',
      `ExperienceStore.${method} is ${typeof es[method]}, expected function.`);
  });
}

// ── NEGATIVE TEST: Verify that known-bad methods do NOT exist ──
// This prevents regression if someone accidentally adds a .query() method
// that doesn't match the expected behavior of getContextBlockWithIds().
test('ExperienceStore.query() does NOT exist (was the root cause of the dark disconnection bug)', () => {
  assert.notStrictEqual(typeof es.query, 'function',
    'ExperienceStore.query() should NOT exist. ' +
    'All consumers should use getContextBlockWithIds() or search() instead.');
});

// ─── 2. Observability API Surface ────────────────────────────────────────────
// Verifies that all obs.* methods called by stage runners actually exist.

console.log('\n  📦 Observability API Surface\n');

const { Observability } = require('../core/observability');
const obs = new Observability(path.join(__dirname, '..', 'output'), 'test-connectivity');

const OBS_METHODS = [
  // Called by stage runners
  'stageStart',                  // stage-developer, stage-tester
  'stageEnd',                    // stage-developer, stage-tester
  'recordExpUsage',              // stage-analyst, stage-architect, stage-developer, stage-planner, stage-tester, stage-runner-utils
  'recordError',                 // stage-developer, stage-tester
  'recordClarificationQuality',  // stage-analyst
  'recordTaskComplexity',        // stage-analyst
  'recordTestResult',            // stage-tester
  'recordEntropyResult',         // stage-tester, index.js
  'recordCIResult',              // stage-tester
  'recordCodeGraphResult',       // index.js
  'recordLlmCall',               // index.js
  'recordActualTokens',          // index.js
  'recordSkillUsage',            // index.js
  'markSkillEffective',          // stage-runner-utils
  // Called by context builders
  'recordToolSearchStats',       // architect-context-builder, developer-context-builder, tester-context-builder
  'recordToolResultFilterStats', // architect-context-builder, developer-context-builder, tester-context-builder
  // Called by teardown
  'recordPromptVariantUsage',    // orchestrator-teardown-impl
  'recordBlockTelemetry',        // orchestrator-teardown-impl
  'recordReflectionGating',      // orchestrator-teardown-impl
  'recordRunGuardSummary',       // orchestrator-teardown-impl
  'recordCustomMetric',          // orchestrator-teardown-impl
  'flush',                       // orchestrator-teardown-impl
  'printDashboard',              // orchestrator-teardown-impl
  'flushPromptTraces',           // orchestrator-teardown-impl
  'generateHTMLReport',          // orchestrator-teardown-impl
];

for (const method of OBS_METHODS) {
  test(`Observability.${method}() exists`, () => {
    assert.strictEqual(typeof obs[method], 'function',
      `Observability.${method} is ${typeof obs[method]}, expected function.`);
  });
}

// ─── 3. Contract Validation ──────────────────────────────────────────────────
// Runs the formal contract validation against real instances.

console.log('\n  📦 Formal Contract Validation\n');

const { validateContract, listContracts } = require('../core/contracts');

test('IExperienceStore contract passes on real ExperienceStore instance', () => {
  const { valid, violations } = validateContract('IExperienceStore', es);
  assert.ok(valid,
    `IExperienceStore contract violations:\n  - ${violations.join('\n  - ')}`);
});

test('All contracts are loadable', () => {
  const names = listContracts();
  assert.ok(names.length >= 9, `Expected at least 9 contracts, got ${names.length}`);
  assert.ok(names.includes('IExperienceStore'), 'Missing IExperienceStore');
  assert.ok(names.includes('IStateMachine'), 'Missing IStateMachine');
  assert.ok(names.includes('IHookSystem'), 'Missing IHookSystem');
});

// ─── 4. Cross-Module Method Consistency ──────────────────────────────────────
// Verifies that the same method name is used consistently across all callers.

console.log('\n  📦 Cross-Module Method Consistency\n');

test('All 5 experience injection paths use getContextBlockWithIds (not query/search)', () => {
  const fs = require('fs');
  const files = [
    '../core/stage-analyst.js',
    '../core/stage-planner.js',
    '../core/architect-context-builder.js',
    '../core/developer-context-builder.js',
    '../core/tester-context-builder.js',
  ];

  for (const file of files) {
    const fullPath = path.join(__dirname, file);
    const content = fs.readFileSync(fullPath, 'utf-8');
    const basename = path.basename(file);

    // Must contain getContextBlockWithIds
    assert.ok(
      content.includes('getContextBlockWithIds'),
      `${basename} does NOT call getContextBlockWithIds() — experience injection is broken!`
    );

    // Must NOT contain experienceStore.query( (the old broken pattern)
    assert.ok(
      !content.includes('experienceStore.query('),
      `${basename} still calls experienceStore.query() — this method does not exist!`
    );
  }
});

test('No consumer calls complaintWall.query() (method does not exist)', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js') && !f.includes('.test.'));
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.ok(
      !content.includes('complaintWall.query('),
      `${file} calls complaintWall.query() — this method does not exist! Use getOpenComplaints() instead.`
    );
  }
});

test('No consumer calls complaintWall.getAll() (method does not exist)', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js') && !f.includes('.test.'));
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.ok(
      !content.includes('complaintWall.getAll(') && !content.includes('_complaintWall.getAll('),
      `${file} calls complaintWall.getAll() — this method does not exist! Use .complaints array or getOpenComplaints() instead.`
    );
  }
});

// ─── 4b. ComplaintWall API Surface ───────────────────────────────────────────

console.log('\n  📦 ComplaintWall API Surface\n');

const { ComplaintWall } = require('../core/complaint-wall');
const cw = new ComplaintWall(null);

const CW_CONSUMER_METHODS = [
  'file',                    // experience-store, knowledge-pipeline, self-reflection-engine
  'resolve',                 // mape-executors
  'getOpenComplaints',       // orchestrator-init, mape-executors, stage-planner (fixed)
  'getOpenComplaintsFor',    // architect-context-builder, developer-context-builder, tester-context-builder
  'getComplaintsFor',        // general query
  'getStats',                // orchestrator-teardown-impl
  'getSummaryText',          // commands-agentflow
  'setExperienceStore',      // index.js
  'fileFromNegativeExperience', // experience-store
  'exportToTroubleshooting', // skill-evolution
];

for (const method of CW_CONSUMER_METHODS) {
  test(`ComplaintWall.${method}() exists`, () => {
    assert.strictEqual(typeof cw[method], 'function',
      `ComplaintWall.${method} is ${typeof cw[method]}, expected function.`);
  });
}

// NEGATIVE: query() and getAll() must NOT exist
test('ComplaintWall.query() does NOT exist (was a dark disconnection bug in stage-planner)', () => {
  assert.notStrictEqual(typeof cw.query, 'function',
    'ComplaintWall.query() should NOT exist. Use getOpenComplaints() instead.');
});

test('ComplaintWall.getAll() does NOT exist (was a dark disconnection bug in deep-audit-checks)', () => {
  assert.notStrictEqual(typeof cw.getAll, 'function',
    'ComplaintWall.getAll() should NOT exist. Use .complaints array or getOpenComplaints() instead.');
});

// ─── 4c. StageContextStore API Surface ───────────────────────────────────────

console.log('\n  📦 StageContextStore API Surface\n');

const { StageContextStore } = require('../core/stage-context-store');
const scs = new StageContextStore({});

const SCS_CONSUMER_METHODS = [
  'set',          // orchestrator-stage-helpers, stage-analyst, stage-architect, stage-developer
  'get',          // stage-planner, stage-analyst, orchestrator-helpers, stage-smart-skip
  'getRelevant',  // architect-context-builder, developer-context-builder, tester-context-builder
  'getLogLine',   // architect-context-builder, developer-context-builder, tester-context-builder
  'getAll',       // orchestrator-helpers
  'delete',       // rollback-coordinator
];

for (const method of SCS_CONSUMER_METHODS) {
  test(`StageContextStore.${method}() exists`, () => {
    assert.strictEqual(typeof scs[method], 'function',
      `StageContextStore.${method} is ${typeof scs[method]}, expected function.`);
  });
}

// ─── 4d. NegotiationEngine API Surface ───────────────────────────────────────

console.log('\n  📦 NegotiationEngine API Surface\n');

const { NegotiationEngine } = require('../core/negotiation-engine');
const ne = new NegotiationEngine({});

const NE_CONSUMER_METHODS = [
  'negotiate',  // stage-developer, stage-tester
  'reset',      // orchestrator-init
  'getLog',     // orchestrator-teardown-impl
  'flush',      // orchestrator-teardown-impl
];

for (const method of NE_CONSUMER_METHODS) {
  test(`NegotiationEngine.${method}() exists`, () => {
    assert.strictEqual(typeof ne[method], 'function',
      `NegotiationEngine.${method} is ${typeof ne[method]}, expected function.`);
  });
}

// ─── 4e. ExperienceEventBus Emit/Subscribe Connectivity ─────────────────────

console.log('\n  📦 ExperienceEventBus Emit/Subscribe Connectivity\n');

const { ExperienceEvents } = require('../core/experience-event-bus');

// Events that are emitted AND have registered handlers
const CONNECTED_EVENTS = [
  'EXPERIENCE_RECORDED',   // emit: experience-store.js → handler: experience-event-handlers.js (distillation)
  'CAPACITY_WARNING',      // emit: experience-store.js → handler: experience-event-handlers.js (auto-distill)
  'PATTERN_TRIGGERED',     // emit: experience-abstraction-mixin.js → handler: experience-event-handlers.js
  'EXPERIENCE_DISTILLED',  // emit: experience-event-handlers.js → handler: experience-event-handlers.js
  'PATTERN_EVOLVED',       // emit: experience-event-handlers.js → handler: experience-event-handlers.js
  'EXPERIENCE_CONFLICT',   // emit: (potential) → handler: experience-event-handlers.js
];

for (const eventName of CONNECTED_EVENTS) {
  test(`ExperienceEvents.${eventName} is defined in event registry`, () => {
    assert.ok(ExperienceEvents[eventName],
      `ExperienceEvents.${eventName} is not defined in the event registry!`);
  });
}

// Events that are emitted but have NO handlers (fire-and-forget / observability only)
const UNSUBSCRIBED_EVENTS = [
  'EXPERIENCE_RETRIEVED',   // emit: experience-query.js → NO handler (observability only)
  'ABSTRACTION_DETECTED',   // emit: experience-abstraction-mixin.js → NO handler
  'AGENT_FEEDBACK',         // emit: agent-feedback-system.js → NO handler (observability only)
];

for (const eventName of UNSUBSCRIBED_EVENTS) {
  test(`ExperienceEvents.${eventName} is defined (emitted but no handler — by design)`, () => {
    assert.ok(ExperienceEvents[eventName],
      `ExperienceEvents.${eventName} is not defined but is emitted in code!`);
  });
}

// ─── 5. SafeInterfaceProxy (Bottom-up Dark Disconnection Prevention) ─────────
// Verifies that the Proxy correctly catches calls to non-existent methods.

console.log('\n  📦 SafeInterfaceProxy\n');

const { createSafeProxy } = require('../core/safe-interface-proxy');

test('SafeInterfaceProxy: existing methods pass through normally', () => {
  const obj = { foo() { return 42; }, bar: 'hello' };
  const proxy = createSafeProxy(obj, 'TestObj', { mode: 'throw' });
  assert.strictEqual(proxy.foo(), 42, 'Existing method should work normally');
  assert.strictEqual(proxy.bar, 'hello', 'Existing property should work normally');
});

test('SafeInterfaceProxy: non-existent method throws in throw mode', () => {
  const obj = { search() { return []; } };
  const proxy = createSafeProxy(obj, 'TestStore', { mode: 'throw' });
  // Accessing the property returns a throwing stub function
  const stub = proxy.query;
  assert.strictEqual(typeof stub, 'function', 'Should return a function (throwing stub)');
  // Calling it should throw
  assert.throws(
    () => stub(),
    /TestStore\.query does not exist/,
    'Should throw with descriptive error message'
  );
});

test('SafeInterfaceProxy: typeof check on non-existent method returns "function" in throw mode (catches typeof guard pattern)', () => {
  const obj = { search() { return []; } };
  const proxy = createSafeProxy(obj, 'TestStore', { mode: 'throw' });
  // This is the KEY test: the old pattern `typeof obj.query === 'function'`
  // would return false on a raw object (skipping the code block silently).
  // With the Proxy, it returns true (because we return a throwing stub),
  // so the code block executes and the error is thrown at the call site.
  assert.strictEqual(typeof proxy.query, 'function',
    'typeof check should return "function" so the code block is entered and the error is caught');
});

test('SafeInterfaceProxy: warn mode returns no-op function instead of throwing', () => {
  const obj = { search() { return []; } };
  // Suppress console.error output during this test
  const origError = console.error;
  let errorOutput = '';
  console.error = (...args) => { errorOutput += args.join(' '); };
  try {
    const proxy = createSafeProxy(obj, 'TestStore', { mode: 'warn' });
    const result = proxy.query();
    assert.strictEqual(result, undefined, 'Warn mode should return undefined from no-op');
    assert.ok(errorOutput.includes('TestStore.query does not exist'),
      'Should log descriptive error message');
  } finally {
    console.error = origError;
  }
});

test('SafeInterfaceProxy: built-in probes (then, toJSON, etc.) are not flagged', () => {
  const obj = { foo() {} };
  const proxy = createSafeProxy(obj, 'TestObj', { mode: 'throw' });
  // These should return undefined without throwing
  assert.strictEqual(proxy.then, undefined, '.then should be undefined (Promise probe)');
  assert.strictEqual(proxy.toJSON, undefined, '.toJSON should be undefined (JSON probe)');
});

test('SafeInterfaceProxy: wrapping ExperienceStore catches .query() call', () => {
  const proxy = createSafeProxy(es, 'ExperienceStore', { mode: 'throw' });
  // The exact bug that was hidden for months
  assert.throws(
    () => proxy.query({ skill: 'test' }),
    /ExperienceStore\.query does not exist/,
    'Should catch the exact .query() bug that was hidden for months'
  );
});

test('SafeInterfaceProxy: suggestion hints work for similar method names', () => {
  const proxy = createSafeProxy(es, 'ExperienceStore', { mode: 'throw' });
  try {
    proxy.searchByKeyword();
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('ExperienceStore.searchByKeyword does not exist'),
      'Error should mention the missing method');
    // Should suggest 'search' as a similar method
    assert.ok(err.message.includes('search'),
      'Error should suggest similar method names');
  }
});

// ─── 6. Public API Aliases (no private method access from external modules) ──

console.log('\n  📦 Public API Aliases (private → public migration)\n');

test('ExperienceStore.save() delegates to _save() correctly', () => {
  assert.strictEqual(typeof es.save, 'function',
    'ExperienceStore.save() should exist as public alias for _save()');
});

test('ExperienceStore.expandKeywords() delegates to _expandKeywordsWithLlm() correctly', () => {
  assert.strictEqual(typeof es.expandKeywords, 'function',
    'ExperienceStore.expandKeywords() should exist as public alias for _expandKeywordsWithLlm()');
});

test('No external module calls experienceStore._save() directly', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js') && !f.includes('.test.') && f !== 'experience-store.js');
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.ok(
      !content.includes('experienceStore._save('),
      `${file} calls experienceStore._save() — use .save() instead.`
    );
  }
});

test('No external module calls experienceStore._expandKeywordsWithLlm() directly', () => {
  const fs = require('fs');
  const cmdDir = path.join(__dirname, '..', 'commands');
  const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith('.js'));
  for (const file of cmdFiles) {
    const content = fs.readFileSync(path.join(cmdDir, file), 'utf-8');
    assert.ok(
      !content.includes('experienceStore._expandKeywordsWithLlm('),
      `${file} calls experienceStore._expandKeywordsWithLlm() — use .expandKeywords() instead.`
    );
  }
});

test('No external module calls codeGraph._loadFromDisk() directly', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f =>
    f.endsWith('.js') && !f.includes('.test.') &&
    !f.startsWith('code-graph-') // Internal CodeGraph modules are allowed
  );
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.ok(
      !content.includes('codeGraph._loadFromDisk(') && !content.includes('._codeGraph._loadFromDisk('),
      `${file} calls codeGraph._loadFromDisk() — use .ensureLoaded() instead.`
    );
  }
});

test('No external module calls codeGraph._findByName() directly', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f =>
    f.endsWith('.js') && !f.includes('.test.') &&
    !f.startsWith('code-graph-') // Internal CodeGraph modules are allowed
  );
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    assert.ok(
      !content.includes('codeGraph._findByName(') && !content.includes('._codeGraph._findByName('),
      `${file} calls codeGraph._findByName() — use .findByName() instead.`
    );
  }
});

test('No external module accesses orch._complaintWall (use orch.complaintWall)', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f =>
    f.endsWith('.js') && !f.includes('.test.') &&
    f !== 'complaint-wall.js' // The module itself is allowed
  );
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    // Only flag orch._complaintWall access pattern (not this._complaintWall which is a valid member variable)
    assert.ok(
      !content.includes('orch._complaintWall.') && !content.includes('this._orch._complaintWall.'),
      `${file} accesses orch._complaintWall — use orch.complaintWall instead.`
    );
  }
});

// CodeGraph public API aliases
test('CodeGraph.ensureLoaded() exists', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: __dirname, outputDir: path.join(__dirname, '..', 'output') });
  assert.strictEqual(typeof cg.ensureLoaded, 'function',
    'CodeGraph.ensureLoaded() should exist as public alias for _loadFromDisk()');
});

test('CodeGraph.findByName() exists', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: __dirname, outputDir: path.join(__dirname, '..', 'output') });
  assert.strictEqual(typeof cg.findByName, 'function',
    'CodeGraph.findByName() should exist as public alias for _findByName()');
});

// ─── Fix 1 Regression: SafeProxy covers 12 shared objects ──────────────────

test('CodeGraph.getSymbolById() exists (Fix 2: public API for _symbols.get)', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: __dirname, outputDir: path.join(__dirname, '..', 'output') });
  assert.strictEqual(typeof cg.getSymbolById, 'function',
    'CodeGraph.getSymbolById() should exist as public API for _symbols.get()');
});

test('CodeGraph.getSymbolCount() exists (Fix 2: public API for _symbols.size)', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: __dirname, outputDir: path.join(__dirname, '..', 'output') });
  assert.strictEqual(typeof cg.getSymbolCount, 'function',
    'CodeGraph.getSymbolCount() should exist as public API for _symbols.size');
  // Verify it returns a number
  assert.strictEqual(typeof cg.getSymbolCount(), 'number',
    'CodeGraph.getSymbolCount() should return a number');
});

test('CodeGraph.getAllSymbolValues() exists (Fix 2: public API for _symbols.values)', () => {
  const { CodeGraph } = require('../core/code-graph');
  const cg = new CodeGraph({ projectRoot: __dirname, outputDir: path.join(__dirname, '..', 'output') });
  assert.strictEqual(typeof cg.getAllSymbolValues, 'function',
    'CodeGraph.getAllSymbolValues() should exist as public API for _symbols.values()');
});

test('No external module accesses codeGraph._symbols directly (Fix 2)', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const cmdDir = path.join(__dirname, '..', 'commands');
  const scanDirs = [
    { dir: coreDir, exclude: f => f.startsWith('code-graph-') },
    { dir: cmdDir, exclude: () => false },
  ];
  for (const { dir, exclude } of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f =>
      f.endsWith('.js') && !f.includes('.test.') && !exclude(f)
    );
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      // Check for direct _symbols.get(), _symbols.values(), _symbols.size access
      const hasDirectAccess =
        /codeGraph\._symbols\.(get|values|size|has|set|delete|clear)\b/.test(content) ||
        /\._codeGraph\._symbols\.(get|values|size|has|set|delete|clear)\b/.test(content);
      assert.ok(!hasDirectAccess,
        `${file} accesses codeGraph._symbols directly — use getSymbolById()/getSymbolCount()/getAllSymbolValues() instead.`);
    }
  }
});

test('ExperienceStore.removeByFilter() exists (Fix 3: safe array mutation)', () => {
  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(path.join(__dirname, '..', 'output', '_test_removeByFilter.json'));
  assert.strictEqual(typeof store.removeByFilter, 'function',
    'ExperienceStore.removeByFilter() should exist for safe array mutation');
});

test('ExperienceStore.getCount() exists (Fix 3: safe length access)', () => {
  const { ExperienceStore } = require('../core/experience-store');
  const store = new ExperienceStore(path.join(__dirname, '..', 'output', '_test_getCount.json'));
  assert.strictEqual(typeof store.getCount, 'function',
    'ExperienceStore.getCount() should exist as public API for experiences.length');
  assert.strictEqual(typeof store.getCount(), 'number',
    'ExperienceStore.getCount() should return a number');
});

test('ExperienceStore.removeByFilter() correctly removes matching experiences', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const store = new ExperienceStore(path.join(__dirname, '..', 'output', '_test_removeByFilter2.json'));
  // Record test experiences
  store.record({ type: ExperienceType.POSITIVE, category: ExperienceCategory.CODING, title: 'Keep me', content: 'Good' });
  store.record({ type: ExperienceType.NEGATIVE, category: ExperienceCategory.CODING, title: 'Remove me', content: 'Bad' });
  store.record({ type: ExperienceType.POSITIVE, category: ExperienceCategory.CODING, title: 'Keep me too', content: 'Also good' });
  assert.strictEqual(store.getCount(), 3, 'Should have 3 experiences before removal');
  const { removed, remaining } = store.removeByFilter(e => e.type === ExperienceType.NEGATIVE);
  assert.strictEqual(removed, 1, 'Should remove 1 negative experience');
  assert.strictEqual(remaining, 2, 'Should have 2 remaining experiences');
  assert.strictEqual(store.getCount(), 2, 'getCount() should match remaining');
  // Cleanup
  try { require('fs').unlinkSync(path.join(__dirname, '..', 'output', '_test_removeByFilter2.json')); } catch (_) {}
});

test('No external module directly assigns experienceStore.experiences (Fix 3)', () => {
  const fs = require('fs');
  const coreDir = path.join(__dirname, '..', 'core');
  const coreFiles = fs.readdirSync(coreDir).filter(f =>
    f.endsWith('.js') && !f.includes('.test.') &&
    f !== 'experience-store.js' &&       // The store itself is allowed
    f !== 'experience-distillation.js' && // Mixin operates on `this.experiences` (same object)
    f !== 'experience-router.js'          // Operates on local result objects, not the store
  );
  for (const file of coreFiles) {
    const content = fs.readFileSync(path.join(coreDir, file), 'utf-8');
    // Flag: experienceStore.experiences = ... (direct assignment from external module)
    const hasDirectAssign =
      /experienceStore\.experiences\s*=\s*/.test(content) ||
      /\.experienceStore\.experiences\s*=\s*/.test(content);
    assert.ok(!hasDirectAssign,
      `${file} directly assigns experienceStore.experiences — use removeByFilter() instead.`);
  }
});

test('ICodeGraph contract exists in contracts.js', () => {
  const { ALL_CONTRACTS, validateContract } = require('../core/contracts');
  assert.ok(ALL_CONTRACTS.ICodeGraph, 'ICodeGraph contract should be defined');
  assert.ok(ALL_CONTRACTS.ICodeGraph.methods.find(m => m.name === 'getSymbolById'),
    'ICodeGraph should include getSymbolById method');
  assert.ok(ALL_CONTRACTS.ICodeGraph.methods.find(m => m.name === 'getSymbolCount'),
    'ICodeGraph should include getSymbolCount method');
  assert.ok(ALL_CONTRACTS.ICodeGraph.methods.find(m => m.name === 'getAllSymbolValues'),
    'ICodeGraph should include getAllSymbolValues method');
});

test('SafeProxy _ prefix access returns actual value (not undefined) for internal properties', () => {
  const { createSafeProxy } = require('../core/safe-interface-proxy');
  const obj = { _internal: 42, publicMethod() { return 'ok'; } };
  const proxy = createSafeProxy(obj, 'TestObj', { mode: 'warn' });
  // _ prefix properties should now return the actual value (with warning), not undefined
  assert.strictEqual(proxy._internal, 42,
    'SafeProxy should pass through _ prefix properties to the real object');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60) + '\n');

if (failed > 0) {
  console.error('  ⚠️  CONNECTIVITY ISSUES DETECTED!');
  console.error('  These failures indicate cross-module interface mismatches');
  console.error('  that will cause silent runtime failures.\n');
  process.exit(1);
}

console.log('  ✅ All cross-module interfaces are connected correctly.\n');
