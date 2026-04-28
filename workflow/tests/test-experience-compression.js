/**
 * P1-3 Experience Context Block Compression Tests
 *
 * Covers the `_compressExperienceBlock` helper paths via the public
 * `setExperienceCompressorCheapLlm` setter:
 *   C1 — short raw → no compression
 *   C2 — long raw + LLM success → compressed with strategy marker
 *   C3 — long raw + LLM failure → heuristic fallback still returns compressed block
 *   C4 — EXPERIENCE_COMPRESS_ENABLED=false kill-switch → original truncation
 *   C5 — compressor returns ratio≥0.85 → fall back to slice truncation
 *
 * All tests are stub-based (no real LLM call). Zero network, <1s total.
 */

'use strict';

const path = require('path');
const Module = require('module');

function makeStoreStub(experiences) {
  const { ExperienceQueryMixin } = require('../core/experience-query');
  const idIndex = new Map(experiences.map(e => [e.id, e]));
  const store = {
    experiences,
    _idIndex: idIndex,
    _synonymTable: {},
    _llmCall: null,
    markRetrieved() {},
  };
  // Attach mixin methods (same as ExperienceStore.prototype)
  for (const [name, fn] of Object.entries(ExperienceQueryMixin)) {
    if (typeof fn === 'function') store[name] = fn.bind(store);
  }
  // Override LLM keyword expansion to no-op (avoid async LLM calls in tests)
  store._expandKeywordsWithLlm = async (kws) => kws;
  return store;
}

function makeExp(id, title, content, type = 'positive') {
  return {
    id, title, content, type,
    category: 'stable_pattern',
    skill: 'code-development',
    tags: [],
    hitCount: 1,
    retrievalCount: 0,
    sourceType: 'manual',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function longContent(chars) {
  const sentence = 'This is a detailed experience record describing a proven pattern discovered during workflow execution. ';
  return sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
}

async function runTests() {
  const { ExperienceQueryMixin, setExperienceCompressorCheapLlm } =
    require('../core/experience-query');

  let passed = 0, failed = 0;
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      results.push(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      results.push(`  ❌ ${name}\n     ${err.message}`);
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  // ── C1: short content — no compression trigger ──────────────────────────
  await test('C1: short content returns raw without compression marker', async () => {
    delete process.env.EXPERIENCE_COMPRESS_ENABLED;
    setExperienceCompressorCheapLlm(null);
    const store = makeStoreStub([makeExp('e1', 'Short Pattern', 'brief content')]);
    const { block } = await ExperienceQueryMixin.getContextBlockWithIds.call(
      store, 'code-development', 'test task', 5
    );
    assert(block.length < 6000, `expected <6000, got ${block.length}`);
    assert(!block.includes('[compressed via'), 'short content must not carry compression marker');
    assert(!block.includes('truncated to stay within token budget'), 'short content must not carry truncation marker');
  });

  // ── C2: long content + LLM success ──────────────────────────────────────
  await test('C2: long content with successful LLM → compressed marker present', async () => {
    delete process.env.EXPERIENCE_COMPRESS_ENABLED;
    setExperienceCompressorCheapLlm(async () => 'LLM summary: proven pattern about workflow compression.');
    const exps = [
      makeExp('e1', 'Long Pattern 1', longContent(3500)),
      makeExp('e2', 'Long Pattern 2', longContent(3500)),
    ];
    const store = makeStoreStub(exps);
    const { block } = await ExperienceQueryMixin.getContextBlockWithIds.call(
      store, 'code-development', null, 5
    );
    assert(block.includes('[compressed via'), `expected compression marker, got: ${block.slice(0, 200)}`);
    assert(block.length < 7000, `expected compressed block <7000, got ${block.length}`);
  });

  // ── C3: long content + LLM failure → heuristic fallback ────────────────
  await test('C3: LLM throws → heuristic fallback still produces compressed/truncated block', async () => {
    delete process.env.EXPERIENCE_COMPRESS_ENABLED;
    setExperienceCompressorCheapLlm(async () => { throw new Error('LLM unavailable'); });
    const exps = [
      makeExp('e1', 'Long Pattern 1', longContent(3500)),
      makeExp('e2', 'Long Pattern 2', longContent(3500)),
    ];
    const store = makeStoreStub(exps);
    const { block } = await ExperienceQueryMixin.getContextBlockWithIds.call(
      store, 'code-development', null, 5
    );
    const hasMarker = block.includes('[compressed via') || block.includes('truncated to stay within token budget');
    assert(hasMarker, 'must produce either compressed or truncated marker on LLM failure');
    assert(block.length < 8000, `fallback block should be bounded, got ${block.length}`);
  });

  // ── C4: kill-switch ─────────────────────────────────────────────────────
  await test('C4: EXPERIENCE_COMPRESS_ENABLED=false → original slice truncation', async () => {
    process.env.EXPERIENCE_COMPRESS_ENABLED = 'false';
    setExperienceCompressorCheapLlm(async () => 'should not be called');
    const exps = [
      makeExp('e1', 'Long Pattern 1', longContent(3500)),
      makeExp('e2', 'Long Pattern 2', longContent(3500)),
    ];
    const store = makeStoreStub(exps);
    const { block } = await ExperienceQueryMixin.getContextBlockWithIds.call(
      store, 'code-development', null, 5
    );
    assert(block.includes('truncated to stay within token budget'), 'kill-switch must go through slice path');
    assert(!block.includes('[compressed via'), 'kill-switch must NOT carry compression marker');
    delete process.env.EXPERIENCE_COMPRESS_ENABLED;
  });

  // ── C5: compressor returns poor ratio → fall back to slice truncation ──
  await test('C5: compressor returns ratio≥0.85 → slice truncation fallback', async () => {
    delete process.env.EXPERIENCE_COMPRESS_ENABLED;
    const originalResolve = Module._resolveFilename;
    const scPath = path.resolve(__dirname, '..', 'core', 'semantic-compressor.js');
    const stubExports = {
      SemanticCompressor: class {
        constructor() {}
        setCheapLlmCall() {}
        async compress(content) {
          return { content, saved: 0, strategy: 'none', ratio: 1.0 };
        }
      },
    };
    require.cache[scPath] = { id: scPath, filename: scPath, loaded: true, exports: stubExports };

    delete require.cache[require.resolve('../core/experience-query')];
    const expQueryMod = require('../core/experience-query');
    const { ExperienceQueryMixin: M2, setExperienceCompressorCheapLlm: setter2 } = expQueryMod;
    setter2(null);
    const exps = [
      makeExp('e1', 'Long Pattern 1', longContent(3500)),
      makeExp('e2', 'Long Pattern 2', longContent(3500)),
    ];
    // Build store directly against M2 (do NOT use makeStoreStub — it caches old mixin)
    const idIndex = new Map(exps.map(e => [e.id, e]));
    const store = {
      experiences: exps,
      _idIndex: idIndex,
      _synonymTable: {},
      _llmCall: null,
      markRetrieved() {},
    };
    for (const [name, fn] of Object.entries(M2)) {
      if (typeof fn === 'function') store[name] = fn.bind(store);
    }
    store._expandKeywordsWithLlm = async (kws) => kws;

    const { block } = await M2.getContextBlockWithIds.call(
      store, 'code-development', null, 5
    );
    assert(block.includes('truncated to stay within token budget'), 'poor-ratio must fall back to slice');
    assert(!block.includes('[compressed via'), 'poor-ratio must NOT carry compression marker');

    delete require.cache[scPath];
    delete require.cache[require.resolve('../core/experience-query')];
    Module._resolveFilename = originalResolve;
  });

  console.log('\n📊 P1-3 Experience Compression Tests');
  console.log(results.join('\n'));
  console.log(`\n${passed} passed / ${failed} failed / 5 total\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});