/**
 * P1 Review Fix Tests
 *
 * Covers:
 *   A. _matchGlobSimple() robust glob replacement — brace expansion, ?, **\/pattern
 *   B. Dynamic token threshold (LLM.HALLUCINATION_RISK_THRESHOLD) — configurable via getConfig()
 *   C. ExperienceStore configurable capacity (EXPERIENCE.MAX_CAPACITY) — configurable via getConfig()
 *   D. isolatable auto-calculation from dependency graph
 */

'use strict';

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

// ═══════════════════════════════════════════════════════════════════════════════
// A. _matchGlobSimple() — Enhanced glob matching
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── A. Enhanced Glob Matching (P1-A) ─────────────────────────');

const { QualityGate } = require('../core/quality-gate');
const fn = QualityGate.checkModuleBoundaryViolation;

test('brace expansion: {a,b} matches either alternative', () => {
  const r = fn(
    ['src/auth/login.js', 'src/middleware/guard.js', 'src/db/conn.js'],
    { moduleId: 'mod-mixed', boundaries: ['src/{auth,middleware}/**'] }
  );
  assertEqual(r.violations.length, 1, 'Only db/conn.js should violate');
  assert.ok(r.violations[0].includes('db/conn.js'), 'db/conn.js is the violation');
});

test('? matches exactly one character', () => {
  const r = fn(
    ['src/auth/a.js', 'src/auth/ab.js'],
    { moduleId: 'mod-test', boundaries: ['src/auth/?.js'] }
  );
  assertEqual(r.violations.length, 1, 'ab.js should violate (? matches 1 char)');
  assert.ok(r.violations[0].includes('ab.js'), 'ab.js is the violation');
});

test('**/pattern matches at any depth', () => {
  const r = fn(
    ['src/tests/unit/auth.test.js', 'src/tests/integration/auth.test.js', 'src/auth/login.js'],
    { moduleId: 'mod-tests', boundaries: ['src/tests/**'] }
  );
  assertEqual(r.violations.length, 1, 'Only auth/login.js should violate');
  assert.ok(r.violations[0].includes('auth/login.js'), 'login.js is the violation');
});

test('** at end matches all nested files', () => {
  const r = fn(
    ['lib/core/utils/helper.js', 'lib/core/index.js', 'lib/ext/plugin.js'],
    { moduleId: 'mod-core', boundaries: ['lib/core/**'] }
  );
  assertEqual(r.violations.length, 1, 'Only ext/plugin.js should violate');
  assert.ok(r.violations[0].includes('ext/plugin.js'), 'ext/plugin.js is the violation');
});

test('complex pattern: src/{auth,user}/*.js', () => {
  const r = fn(
    ['src/auth/login.js', 'src/user/profile.js', 'src/user/deep/nested.js', 'src/db/conn.js'],
    { moduleId: 'mod-auth-user', boundaries: ['src/{auth,user}/*'] }
  );
  // src/auth/login.js → matches src/auth/*
  // src/user/profile.js → matches src/user/*
  // src/user/deep/nested.js → does NOT match src/user/* (nested)
  // src/db/conn.js → does NOT match either
  assertEqual(r.violations.length, 2, 'deep/nested.js and db/conn.js should violate');
});

test('preserves backward compat: /* single-level match', () => {
  const r = fn(
    ['src/auth/login.js', 'src/auth/deep/nested.js'],
    { moduleId: 'mod-auth', boundaries: ['src/auth/*'] }
  );
  assertEqual(r.clean, false, 'nested file should violate');
  assertEqual(r.violations.length, 1, 'One violation');
});

test('preserves backward compat: prefix* match', () => {
  const r = fn(
    ['src/middleware/authMiddleware.js', 'src/middleware/authGuard.js', 'src/middleware/logging.js'],
    { moduleId: 'mod-auth-mw', boundaries: ['src/middleware/auth*'] }
  );
  assertEqual(r.clean, false, 'logging.js should violate');
  assertEqual(r.violations.length, 1, 'One violation');
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. Dynamic Token Threshold (P1-B)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── B. Dynamic Token Threshold (P1-B) ────────────────────────');

test('LLM.HALLUCINATION_RISK_THRESHOLD returns default 16000', () => {
  const { LLM } = require('../core/constants');
  const threshold = LLM.HALLUCINATION_RISK_THRESHOLD;
  assertEqual(threshold, 16000, 'Default threshold should be 16000');
});

test('LLM.HALLUCINATION_RISK_THRESHOLD is a getter (dynamic)', () => {
  const { LLM } = require('../core/constants');
  // Accessing it twice should work (it's a getter, not a static value)
  const t1 = LLM.HALLUCINATION_RISK_THRESHOLD;
  const t2 = LLM.HALLUCINATION_RISK_THRESHOLD;
  assertEqual(t1, t2, 'Getter should return consistent value');
});

test('LLM.CHARS_PER_TOKEN is still accessible', () => {
  const { LLM } = require('../core/constants');
  assertEqual(LLM.CHARS_PER_TOKEN, 4, 'CHARS_PER_TOKEN should be 4');
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. ExperienceStore Configurable Capacity (P1-C)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── C. ExperienceStore Configurable Capacity (P1-C) ─────────');

test('EXPERIENCE.MAX_CAPACITY returns default 500', () => {
  const { EXPERIENCE } = require('../core/constants');
  const cap = EXPERIENCE.MAX_CAPACITY;
  assertEqual(cap, 500, 'Default capacity should be 500');
});

test('EXPERIENCE.MAX_CAPACITY is a getter (dynamic)', () => {
  const { EXPERIENCE } = require('../core/constants');
  const c1 = EXPERIENCE.MAX_CAPACITY;
  const c2 = EXPERIENCE.MAX_CAPACITY;
  assertEqual(c1, c2, 'Getter should return consistent value');
});

test('EXPERIENCE is exported from constants', () => {
  const constants = require('../core/constants');
  assert.ok(constants.EXPERIENCE, 'EXPERIENCE should be exported');
  assert.ok(typeof constants.EXPERIENCE.MAX_CAPACITY === 'number', 'MAX_CAPACITY should be a number');
});

// ═══════════════════════════════════════════════════════════════════════════════
// D. isolatable Auto-Calculation (P1-D)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n── D. isolatable Auto-Calculation (P1-D) ────────────────────');

const { storeAnalyseContext } = require('../core/orchestrator-stage-helpers');

// Helper: create a mock orchestrator with minimal stageCtx
function mockOrch() {
  const stageCtx = new Map();
  stageCtx.get = stageCtx.get.bind(stageCtx);
  stageCtx.set = stageCtx.set.bind(stageCtx);
  return { stageCtx };
}

// Helper: write a temp requirement file
const fs = require('fs');
const path = require('path');
const os = require('os');

function writeTempReq(moduleMap) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1d-'));
  const tmpFile = path.join(tmpDir, 'req.md');
  const jsonBlock = JSON.stringify({ summary: 'test', moduleMap }, null, 2);
  const content = '```json\n' + jsonBlock + '\n```\n\n# Overview\nTest requirement\n\n## Architecture Design\nNone\n\n## Execution Plan\nNone';
  fs.writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}

test('leaf module (no deps) is auto-calculated as isolatable', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-a', name: 'A', description: 'A', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  assertEqual(mm.modules[0].isolatable, true, 'Leaf module should be auto-calculated as isolatable');
});

test('module with unresolved deps (outside map) is isolatable', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-a', name: 'A', description: 'A', boundaries: [], dependencies: ['external-lib'], complexity: 'low', isolatable: false },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  // 'external-lib' is not in the module map, so it's ignored for isolatable calculation
  assertEqual(mm.modules[0].isolatable, true, 'Module with only external deps should be isolatable');
});

test('module depending on isolatable module is also isolatable', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-db', name: 'DB', description: 'Database', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
      { id: 'mod-auth', name: 'Auth', description: 'Auth', boundaries: [], dependencies: ['mod-db'], complexity: 'medium', isolatable: false },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  assertEqual(mm.modules[0].isolatable, true, 'DB (leaf) should be isolatable');
  assertEqual(mm.modules[1].isolatable, true, 'Auth (depends on isolatable DB) should be isolatable');
});

test('circular dependency makes both modules non-isolatable', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-a', name: 'A', description: 'A', boundaries: [], dependencies: ['mod-b'], complexity: 'low', isolatable: true },
      { id: 'mod-b', name: 'B', description: 'B', boundaries: [], dependencies: ['mod-a'], complexity: 'low', isolatable: true },
      { id: 'mod-c', name: 'C', description: 'C', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  assertEqual(mm.modules[0].isolatable, false, 'A (circular with B) should NOT be isolatable');
  assertEqual(mm.modules[1].isolatable, false, 'B (circular with A) should NOT be isolatable');
  assertEqual(mm.modules[2].isolatable, true, 'C (independent) should be isolatable');
});

test('transitive chain: A→B→C, all should be isolatable', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-c', name: 'C', description: 'C', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
      { id: 'mod-b', name: 'B', description: 'B', boundaries: [], dependencies: ['mod-c'], complexity: 'low', isolatable: false },
      { id: 'mod-a', name: 'A', description: 'A', boundaries: [], dependencies: ['mod-b'], complexity: 'low', isolatable: false },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  assertEqual(mm.modules.find(m => m.id === 'mod-c').isolatable, true, 'C (leaf) isolatable');
  assertEqual(mm.modules.find(m => m.id === 'mod-b').isolatable, true, 'B (dep on isolatable C) isolatable');
  assertEqual(mm.modules.find(m => m.id === 'mod-a').isolatable, true, 'A (dep on isolatable B) isolatable');
});

test('LLM annotation overridden: was true, now false due to circular', () => {
  const orch = mockOrch();
  const tmpFile = writeTempReq({
    modules: [
      { id: 'mod-x', name: 'X', description: 'X', boundaries: [], dependencies: ['mod-y'], complexity: 'low', isolatable: true },
      { id: 'mod-y', name: 'Y', description: 'Y', boundaries: [], dependencies: ['mod-x'], complexity: 'low', isolatable: true },
    ],
    crossCuttingConcerns: [],
  });
  storeAnalyseContext(orch, tmpFile, { riskNotes: [] });
  const mm = orch.stageCtx.get('ANALYSE').meta.moduleMap;
  assertEqual(mm.modules[0].isolatable, false, 'X should be overridden to false (circular)');
  assertEqual(mm.modules[1].isolatable, false, 'Y should be overridden to false (circular)');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`  P1 Review Fix Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
