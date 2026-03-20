/**
 * Phase 2.5 Tests: Module-Aware Planning + Worker-Module Alignment + Module-Granular Experience
 *
 * Covers:
 *   A. PLANNER_SCHEMA v1.1 moduleGrouping field + storePlannerContext extraction
 *   B. developer-context-builder Module Scope injection
 *   C. ExperienceStore moduleId support + search filtering
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-p25-'));
}

// ═══════════════════════════════════════════════════════════════════════════════
// A. PLANNER_SCHEMA v1.1 + moduleGrouping
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. Planner moduleGrouping ────────────────────────────────');

test('PLANNER_SCHEMA v1.1 has moduleGrouping field', () => {
  const { PLANNER_SCHEMA } = require('../core/agent-output-schema');
  assertEqual(PLANNER_SCHEMA.version, '1.1', 'PLANNER_SCHEMA version');
  assert.ok(PLANNER_SCHEMA.fields.moduleGrouping, 'moduleGrouping field must exist');
  assertEqual(PLANNER_SCHEMA.fields.moduleGrouping.required, false, 'moduleGrouping is optional');
});

test('validateJsonBlock passes with moduleGrouping', () => {
  const { validateJsonBlock } = require('../core/agent-output-schema');
  const block = {
    role: 'planner',
    version: '1.1',
    tasks: ['T-1', 'T-2'],
    phases: ['Phase 1'],
    moduleGrouping: {
      groups: [
        { moduleId: 'mod-auth', moduleName: 'Auth', taskIds: ['T-1'] },
        { moduleId: 'mod-db', moduleName: 'Database', taskIds: ['T-2'] },
      ],
      crossModuleTasks: [],
    },
  };
  const result = validateJsonBlock(block, 'planner');
  assert.ok(result.valid, `Validation should pass: ${result.reason}`);
});

test('extractSummary synthesises from planner output with moduleGrouping', () => {
  const { extractSummary } = require('../core/agent-output-schema');
  const block = {
    role: 'planner',
    tasks: ['T-1', 'T-2', 'T-3'],
    phases: ['Phase 1', 'Phase 2'],
    moduleGrouping: {
      groups: [
        { moduleId: 'mod-a', moduleName: 'A', taskIds: ['T-1', 'T-2'] },
        { moduleId: 'mod-b', moduleName: 'B', taskIds: ['T-3'] },
      ],
    },
  };
  const summary = extractSummary(block, 'PLAN');
  assert.ok(summary.includes('3 task(s)'), `Summary should include task count: ${summary}`);
  assert.ok(summary.includes('2 phase(s)'), `Summary should include phase count: ${summary}`);
  assert.ok(summary.includes('2 module group(s)'), `Summary should include module groups: ${summary}`);
});

test('buildJsonBlockInstruction includes moduleGrouping for planner', () => {
  const { buildJsonBlockInstruction } = require('../core/agent-output-schema');
  const instruction = buildJsonBlockInstruction('planner');
  assert.ok(instruction.includes('moduleGrouping'), 'Instruction should mention moduleGrouping');
});

test('storePlannerContext extracts moduleGrouping from JSON block', () => {
  const tmpDir = makeTempDir();
  const planContent = [
    '```json',
    JSON.stringify({
      role: 'planner',
      version: '1.1',
      tasks: ['T-1', 'T-2', 'T-3'],
      phases: ['Phase 1'],
      moduleGrouping: {
        groups: [
          { moduleId: 'mod-auth', moduleName: 'Auth Module', taskIds: ['T-1', 'T-2'] },
          { moduleId: 'mod-ui', moduleName: 'UI Module', taskIds: ['T-3'] },
        ],
        crossModuleTasks: [],
      },
    }),
    '```',
    '',
    '# Execution Plan',
    '#### Task T-1: Setup auth',
    '#### Task T-2: Auth middleware',
    '#### Task T-3: Login page',
  ].join('\n');
  const planPath = path.join(tmpDir, 'execution-plan.md');
  fs.writeFileSync(planPath, planContent);

  const { StageContextStore } = require('../core/stage-context-store');
  const store = new StageContextStore({ outputDir: tmpDir, verbose: true });
  const { storePlannerContext } = require('../core/orchestrator-stage-helpers');

  const mockOrch = { stageCtx: store };
  const result = storePlannerContext(mockOrch, planPath);

  assertEqual(result.taskCount, 3, 'taskCount');
  assert.ok(result.moduleGrouping, 'moduleGrouping should be extracted');
  assertEqual(result.moduleGrouping.groups.length, 2, 'moduleGrouping groups count');
  assertEqual(result.moduleGrouping.groups[0].moduleId, 'mod-auth', 'First group moduleId');
  assertEqual(result.moduleGrouping.groups[0].taskIds.length, 2, 'First group taskIds count');
  assertEqual(result.moduleGrouping.crossModuleTasks.length, 0, 'No cross-module tasks');

  // Verify stored in stageCtx
  const planCtx = store.get('PLAN');
  assert.ok(planCtx.meta.moduleGrouping, 'moduleGrouping should be in stageCtx.meta');
  assertEqual(planCtx.meta.moduleGrouping.groups.length, 2, 'stageCtx moduleGrouping groups');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('storePlannerContext handles missing moduleGrouping gracefully', () => {
  const tmpDir = makeTempDir();
  const planContent = [
    '```json',
    JSON.stringify({
      role: 'planner',
      version: '1.0',
      tasks: ['T-1'],
      phases: ['Phase 1'],
    }),
    '```',
    '',
    '# Execution Plan',
    '#### Task T-1: Do something',
  ].join('\n');
  const planPath = path.join(tmpDir, 'execution-plan.md');
  fs.writeFileSync(planPath, planContent);

  const { StageContextStore } = require('../core/stage-context-store');
  const store = new StageContextStore({ outputDir: tmpDir, verbose: true });
  const { storePlannerContext } = require('../core/orchestrator-stage-helpers');

  const mockOrch = { stageCtx: store };
  const result = storePlannerContext(mockOrch, planPath);

  assertEqual(result.taskCount, 1, 'taskCount');
  assertEqual(result.moduleGrouping, null, 'moduleGrouping should be null when absent');

  const planCtx = store.get('PLAN');
  assertEqual(planCtx.meta.moduleGrouping, null, 'stageCtx moduleGrouping should be null');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A.5 PlannerAgent prompt + parseResponse
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A.5 PlannerAgent prompt & validation ─────────────────────');

test('PlannerAgent buildPrompt includes Module-Task Grouping section', () => {
  const { PlannerAgent } = require('../agents/planner-agent');
  const mockLlm = async () => '';
  const agent = new PlannerAgent(mockLlm, null);
  const prompt = agent.buildPrompt('# Architecture\nSome content', '## Functional Module Map\n- mod-a: ...');
  assert.ok(prompt.includes('Module-Task Grouping'), 'Prompt should include Module-Task Grouping section');
  assert.ok(prompt.includes('moduleGrouping'), 'Prompt should reference moduleGrouping field');
});

test('PlannerAgent buildPrompt detects Module Map absence', () => {
  const { PlannerAgent } = require('../agents/planner-agent');
  const mockLlm = async () => '';
  const agent = new PlannerAgent(mockLlm, null);
  const prompt = agent.buildPrompt('# Architecture\nSome content', null);
  assert.ok(prompt.includes('No Functional Module Map available'), 'Prompt should note Module Map absence');
});

test('PlannerAgent parseResponse validates moduleGrouping', () => {
  const { PlannerAgent } = require('../agents/planner-agent');
  const mockLlm = async () => '';
  const agent = new PlannerAgent(mockLlm, null);

  const response = [
    '```json',
    JSON.stringify({
      role: 'planner',
      tasks: ['T-1', 'T-2'],
      phases: ['Phase 1'],
      moduleGrouping: {
        groups: [
          { moduleId: 'mod-a', moduleName: 'A', taskIds: ['T-1'] },
        ],
        crossModuleTasks: ['T-2'],
      },
    }),
    '```',
    '',
    '# Plan Overview',
    '# Implementation Phases',
    '# Task Breakdown',
    '#### Task T-1: Do A',
    '#### Task T-2: Do B',
    '# Dependency Graph',
  ].join('\n');

  // Should not throw
  const parsed = agent.parseResponse(response);
  assert.ok(parsed.includes('Plan Overview'), 'Parsed response should contain output');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Developer Module Scope Injection
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── B. Developer Module Scope ────────────────────────────────');

test('developer FIXED_PREFIX includes Module-Scope Awareness', () => {
  const { AGENT_FIXED_PREFIXES } = require('../core/prompt-builder');
  const devPrefix = AGENT_FIXED_PREFIXES.developer;
  assert.ok(devPrefix.includes('Module-Scope Awareness'), 'Developer prefix should include Module-Scope Awareness');
  assert.ok(devPrefix.includes('module boundaries'), 'Developer prefix should mention module boundaries');
});

test('planner FIXED_PREFIX includes Module-Aware Planning', () => {
  const { AGENT_FIXED_PREFIXES } = require('../core/prompt-builder');
  const plannerPrefix = AGENT_FIXED_PREFIXES.planner;
  assert.ok(plannerPrefix.includes('Module-Aware Planning'), 'Planner prefix should include Module-Aware Planning');
  assert.ok(plannerPrefix.includes('moduleGrouping'), 'Planner prefix should mention moduleGrouping');
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. Experience moduleId Support
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── C. Experience moduleId ───────────────────────────────────');

test('ExperienceStore.record() stores moduleId', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const store = new ExperienceStore(path.join(tmpDir, 'exp.json'));

  const exp = store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'Auth module pattern',
    content: 'Use JWT for authentication',
    moduleId: 'mod-auth',
    tags: ['auth', 'jwt'],
  });

  assertEqual(exp.moduleId, 'mod-auth', 'moduleId should be stored');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ExperienceStore.record() stores null moduleId by default', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const store = new ExperienceStore(path.join(tmpDir, 'exp.json'));

  const exp = store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'Generic pattern',
    content: 'Some generic content',
  });

  assertEqual(exp.moduleId, null, 'moduleId should default to null');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ExperienceStore.search() filters by moduleId', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const store = new ExperienceStore(path.join(tmpDir, 'exp.json'));

  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'Auth exp 1',
    content: 'Auth content 1',
    moduleId: 'mod-auth',
    tags: ['auth'],
  });
  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'DB exp 1',
    content: 'DB content 1',
    moduleId: 'mod-db',
    tags: ['db'],
  });
  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'Generic exp',
    content: 'Generic content',
    tags: ['generic'],
  });

  // Filter by moduleId
  const authResults = store.search({ moduleId: 'mod-auth', limit: 10 });
  assertEqual(authResults.length, 1, 'Should find 1 auth experience');
  assertEqual(authResults[0].title, 'Auth exp 1', 'Should find auth exp');

  const dbResults = store.search({ moduleId: 'mod-db', limit: 10 });
  assertEqual(dbResults.length, 1, 'Should find 1 db experience');

  // No moduleId filter returns all
  const allResults = store.search({ limit: 10 });
  assertEqual(allResults.length, 3, 'Should find all 3 experiences without moduleId filter');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ExperienceStore.batchRecord() stores moduleId', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const store = new ExperienceStore(path.join(tmpDir, 'exp.json'));

  store.batchRecord([
    {
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.STABLE_PATTERN,
      title: 'Batch exp 1',
      content: 'Content 1',
      moduleId: 'mod-auth',
    },
    {
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: 'Batch exp 2',
      content: 'Content 2',
      moduleId: 'mod-db',
    },
  ]);

  const allExps = store.getAll();
  assertEqual(allExps.length, 2, 'Should have 2 batch recorded experiences');
  assertEqual(allExps[0].moduleId, 'mod-auth', 'First batch exp moduleId');
  assertEqual(allExps[1].moduleId, 'mod-db', 'Second batch exp moduleId');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ExperienceStore.search() combines moduleId with keyword', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const store = new ExperienceStore(path.join(tmpDir, 'exp.json'));

  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'JWT token validation',
    content: 'Always validate JWT token expiry',
    moduleId: 'mod-auth',
  });
  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'DB connection pooling',
    content: 'Always use connection pooling for database',
    moduleId: 'mod-db',
  });
  store.record({
    type: ExperienceType.POSITIVE,
    category: ExperienceCategory.STABLE_PATTERN,
    title: 'JWT key rotation',
    content: 'Rotate JWT signing keys regularly',
    moduleId: 'mod-auth',
  });

  // Combine moduleId + keyword
  const results = store.search({ moduleId: 'mod-auth', keyword: 'JWT', limit: 10 });
  assertEqual(results.length, 2, 'Should find 2 JWT auth experiences');
  assert.ok(results.every(r => r.moduleId === 'mod-auth'), 'All results should be mod-auth');

  // Keyword without moduleId
  const allJwt = store.search({ keyword: 'JWT', limit: 10 });
  assertEqual(allJwt.length, 2, 'Should find 2 JWT experiences across all modules');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-concern: backward compatibility
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── Backward Compatibility ──────────────────────────────────');

test('Old planner output without moduleGrouping still works', () => {
  const { validateJsonBlock } = require('../core/agent-output-schema');
  const block = {
    role: 'planner',
    version: '1.0',
    tasks: ['T-1'],
    phases: ['Phase 1'],
    // No moduleGrouping field
  };
  const result = validateJsonBlock(block, 'planner');
  assert.ok(result.valid, 'Old planner output should still validate');
});

test('ExperienceStore loads old experiences without moduleId', () => {
  const { ExperienceStore, ExperienceType, ExperienceCategory } = require('../core/experience-store');
  const tmpDir = makeTempDir();
  const expPath = path.join(tmpDir, 'exp.json');

  // Write old format experiences
  fs.writeFileSync(expPath, JSON.stringify([
    {
      id: 'EXP-OLD-1',
      type: ExperienceType.POSITIVE,
      category: ExperienceCategory.STABLE_PATTERN,
      title: 'Old exp',
      content: 'Old content',
      taskId: null,
      skill: null,
      tags: [],
      codeExample: null,
      sourceFile: null,
      namespace: null,
      // No moduleId field
      hitCount: 0,
      evolutionCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: null,
    },
  ]));

  const store = new ExperienceStore(expPath);
  const all = store.getAll();
  assertEqual(all.length, 1, 'Should load old experience');
  assertEqual(all[0].moduleId, undefined, 'Old exp moduleId is undefined (not null)');

  // search with moduleId filter should not include old exps
  const filtered = store.search({ moduleId: 'mod-auth', limit: 10 });
  assertEqual(filtered.length, 0, 'Old exps without moduleId should not match moduleId filter');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`  Phase 2.5 Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
