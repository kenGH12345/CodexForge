'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLayeredCodeGraph, resolveCodeGraphPath, _buildShardFileIndex } = require('./code-graph-layered-reader');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layered-reader-'));
  fs.mkdirSync(path.join(root, 'output', 'code-graph-shards'), { recursive: true });
  return root;
}

console.log('\n=== CodeGraph Layered Reader Tests ===\n');

test('loads L1 index without legacy graph', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph-index.json'), JSON.stringify({
      version: 1,
      sourceVersion: 2,
      projectRoot: root,
      symbolCount: 3,
      modules: [{ name: 'core', shard: 'core.json', fileCount: 1, symbolCount: 2 }],
      topHotspots: [{ n: 'CoreService', cb: 2, co: 1, c: 'hub' }],
      reusableSymbols: [{ n: 'helper', cb: 3, c: 'utility' }],
      categoryStats: { total: 3 },
      shardDir: 'code-graph-shards',
      legacyGraph: 'code-graph.json',
    }), 'utf8');
    const graph = loadLayeredCodeGraph(root);
    assert.strictEqual(graph.layered, true);
    assert.strictEqual(graph.source, 'layered');
    assert.strictEqual(graph.sourceDetail, 'index');
    assert.strictEqual(graph.symbolCount, 3);
    assert.strictEqual(graph.modules[0].name, 'core');
    assert.strictEqual(graph.reusableSymbols[0].n, 'helper');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loads requested shard', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph-index.json'), JSON.stringify({
      version: 1,
      modules: [{ name: 'core', shard: 'core.json', fileCount: 1, symbolCount: 1 }],
      shardDir: 'code-graph-shards',
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'output', 'code-graph-shards', 'core.json'), JSON.stringify({
      version: 1,
      module: 'core',
      files: ['src/core/a.js'],
      symbols: [{ n: 'CoreService' }],
      callEdges: {},
      inboundEdges: [],
      outboundEdges: [],
    }), 'utf8');
    const graph = loadLayeredCodeGraph(root, { includeShards: ['core'] });
    assert.strictEqual(graph.loadedShards.length, 1);
    assert.strictEqual(graph.loadedShards[0].module, 'core');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('falls back to legacy code-graph.json', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph.json'), JSON.stringify({
      version: 2,
      symbolCount: 1,
      filePaths: ['src/a.js'],
      symbols: [{ f: 0, n: 'legacy', k: 'function', l: 1 }],
      hotspots: [],
    }), 'utf8');
    const graph = loadLayeredCodeGraph(root);
    assert.strictEqual(graph.layered, false);
    assert.strictEqual(graph.source, 'legacy');
    assert.strictEqual(graph.symbolCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── resolveCodeGraphPath: 4 scenarios ────────────────────────────────────

test('resolveCodeGraphPath: index-only → primaryPath is index', () => {
  const root = makeRoot();
  try {
    const idx = path.join(root, 'output', 'code-graph-index.json');
    fs.writeFileSync(idx, JSON.stringify({ version: 1 }), 'utf8');
    const resolved = resolveCodeGraphPath(root);
    assert.strictEqual(resolved.exists, true);
    assert.strictEqual(resolved.primaryPath, idx);
    assert.ok(resolved.mtimeMs != null, 'mtimeMs should be set');
    assert.ok(resolved.newestMtimeMs != null, 'newestMtimeMs should be set');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodeGraphPath: legacy-only → primaryPath is legacy', () => {
  const root = makeRoot();
  try {
    const legacy = path.join(root, 'output', 'code-graph.json');
    fs.writeFileSync(legacy, JSON.stringify({ version: 2, symbols: [] }), 'utf8');
    const resolved = resolveCodeGraphPath(root);
    assert.strictEqual(resolved.exists, true);
    assert.strictEqual(resolved.primaryPath, legacy);
    assert.strictEqual(resolved.mtimeMs, resolved.newestMtimeMs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodeGraphPath: both present → primary=index, newestMtimeMs=max', () => {
  const root = makeRoot();
  try {
    const idx = path.join(root, 'output', 'code-graph-index.json');
    const legacy = path.join(root, 'output', 'code-graph.json');
    fs.writeFileSync(legacy, JSON.stringify({ version: 2, symbols: [] }), 'utf8');
    // Ensure index has later mtime than legacy
    const past = new Date(Date.now() - 10000);
    fs.utimesSync(legacy, past, past);
    fs.writeFileSync(idx, JSON.stringify({ version: 1 }), 'utf8');
    const resolved = resolveCodeGraphPath(root);
    assert.strictEqual(resolved.primaryPath, idx);
    const idxMtime = fs.statSync(idx).mtimeMs;
    const legMtime = fs.statSync(legacy).mtimeMs;
    assert.strictEqual(resolved.newestMtimeMs, Math.max(idxMtime, legMtime));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodeGraphPath: neither present → exists=false, primaryPath=null', () => {
  const root = makeRoot();
  try {
    const resolved = resolveCodeGraphPath(root);
    assert.strictEqual(resolved.exists, false);
    assert.strictEqual(resolved.primaryPath, null);
    assert.strictEqual(resolved.mtimeMs, null);
    assert.strictEqual(resolved.newestMtimeMs, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodeGraphPath: is exported on module', () => {
  const mod = require('./code-graph-layered-reader');
  assert.strictEqual(typeof mod.resolveCodeGraphPath, 'function');
});

// ── _loadFromLayered: end-to-end via CodeGraph.ensureLoaded ──────────────

test('_loadFromLayered: L1+shards with no L3 → querySymbol returns non-empty', () => {
  const root = makeRoot();
  try {
    const outDir = path.join(root, 'output');
    // Write index without legacy
    fs.writeFileSync(path.join(outDir, 'code-graph-index.json'), JSON.stringify({
      version: 1,
      sourceVersion: 2,
      projectRoot: root,
      symbolCount: 2,
      modules: [{ name: 'core', shard: 'core.json', fileCount: 1, symbolCount: 2 }],
      shardDir: 'code-graph-shards',
      legacyGraph: 'code-graph.json',
    }), 'utf8');
    // Shard with compact symbols (sym.f is global index; 100 here)
    fs.writeFileSync(path.join(outDir, 'code-graph-shards', 'core.json'), JSON.stringify({
      version: 1,
      module: 'core',
      files: ['src/core/a.js'],
      symbols: [
        { f: 100, k: 'function', n: 'doWork', l: 10, s: '' },
        { f: 100, k: 'function', n: 'helper', l: 25, s: '' },
      ],
      callEdges: { '100::doWork': ['100::helper'] },
      inboundEdges: [],
      outboundEdges: [],
    }), 'utf8');

    // Use CodeGraph with outputDir pointed at our temp root, DO NOT build
    const { CodeGraph } = require('./code-graph');
    const cg = new CodeGraph({ projectRoot: root, outputDir: outDir });
    cg.ensureLoaded();

    assert.ok(cg._symbols.size >= 2, `expected ≥2 symbols, got ${cg._symbols.size}`);
    const doWork = cg._symbols.get('src/core/a.js::doWork');
    assert.ok(doWork, 'doWork symbol should be loaded');
    assert.strictEqual(doWork.name, 'doWork');
    assert.strictEqual(doWork.file, 'src/core/a.js');
    // Call edge should be expanded to full ids
    const callees = cg._callEdges.get('src/core/a.js::doWork');
    assert.ok(Array.isArray(callees) && callees.includes('src/core/a.js::helper'),
      `expected helper in callees, got ${JSON.stringify(callees)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_loadFromLayered: no L1 and no L3 → _symbols stays empty, no throw', () => {
  const root = makeRoot();
  try {
    const { CodeGraph } = require('./code-graph');
    const cg = new CodeGraph({ projectRoot: root, outputDir: path.join(root, 'output') });
    cg.ensureLoaded();  // must not throw
    assert.strictEqual(cg._symbols.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('_loadFromLayered: L3 present → legacy path still used (no layered override)', () => {
  const root = makeRoot();
  try {
    const outDir = path.join(root, 'output');
    // Write both L1 and L3; L3 should win in _loadFromDisk
    fs.writeFileSync(path.join(outDir, 'code-graph.json'), JSON.stringify({
      version: 2,
      symbolCount: 1,
      filePaths: ['src/legacy.js'],
      symbols: [{ f: 0, k: 'function', n: 'legacyOnly', l: 1 }],
      callEdges: {},
      importEdges: {},
    }), 'utf8');
    fs.writeFileSync(path.join(outDir, 'code-graph-index.json'), JSON.stringify({
      version: 1,
      modules: [],
      shardDir: 'code-graph-shards',
    }), 'utf8');
    const { CodeGraph } = require('./code-graph');
    const cg = new CodeGraph({ projectRoot: root, outputDir: outDir });
    cg.ensureLoaded();
    // L3 path produced id with file index 0 → 'src/legacy.js'
    assert.ok(cg._symbols.get('src/legacy.js::legacyOnly'),
      `expected legacy symbol loaded from L3, got keys=${[...cg._symbols.keys()].slice(0,5).join(',')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── _buildShardFileIndex: standalone utility tests ───────────────────────

test('_buildShardFileIndex: typical shard with sorted files ↔ sorted f', () => {
  const shard = {
    module: 'commands',
    files: ['a/x.js', 'a/y.js', 'a/z.js'],
    symbols: [
      { f: 149, n: 'foo', k: 'function', l: 1 },
      { f: 149, n: 'bar', k: 'function', l: 10 },
      { f: 150, n: 'baz', k: 'function', l: 1 },
      { f: 151, n: 'qux', k: 'function', l: 1 },
    ],
  };
  const map = _buildShardFileIndex(shard);
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get(149), 'a/x.js');
  assert.strictEqual(map.get(150), 'a/y.js');
  assert.strictEqual(map.get(151), 'a/z.js');
});

test('_buildShardFileIndex: empty shard → empty map', () => {
  assert.strictEqual(_buildShardFileIndex({ files: [], symbols: [] }).size, 0);
  assert.strictEqual(_buildShardFileIndex(null).size, 0);
  assert.strictEqual(_buildShardFileIndex({}).size, 0);
});

test('_buildShardFileIndex: fewer files than unique f values → truncate', () => {
  const shard = {
    files: ['only.js'],
    symbols: [{ f: 10, n: 'a' }, { f: 20, n: 'b' }],
  };
  const map = _buildShardFileIndex(shard);
  assert.strictEqual(map.size, 1);
  assert.strictEqual(map.get(10), 'only.js');
  assert.strictEqual(map.has(20), false);
});

// ── modules[] sorted by symbolCount desc + maxSymbols budget ─────────────

test('modules returned by loadLayeredCodeGraph sorted by symbolCount desc', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph-index.json'), JSON.stringify({
      version: 1,
      modules: [
        { name: 'small', shard: 'small.json', symbolCount: 100 },
        { name: 'large', shard: 'large.json', symbolCount: 5000 },
        { name: 'medium', shard: 'medium.json', symbolCount: 1000 },
      ],
      shardDir: 'code-graph-shards',
    }), 'utf8');
    const graph = loadLayeredCodeGraph(root);
    assert.strictEqual(graph.modules[0].name, 'large');
    assert.strictEqual(graph.modules[1].name, 'medium');
    assert.strictEqual(graph.modules[2].name, 'small');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maxSymbols budget stops shard loading once accumulated >= threshold', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph-index.json'), JSON.stringify({
      version: 1,
      modules: [
        { name: 'a', shard: 'a.json', symbolCount: 6000 },
        { name: 'b', shard: 'b.json', symbolCount: 5000 },
        { name: 'c', shard: 'c.json', symbolCount: 4000 },
        { name: 'd', shard: 'd.json', symbolCount: 3000 },
      ],
      shardDir: 'code-graph-shards',
    }), 'utf8');
    for (const name of ['a', 'b', 'c', 'd']) {
      fs.writeFileSync(
        path.join(root, 'output', 'code-graph-shards', `${name}.json`),
        JSON.stringify({ module: name, files: [], symbols: [] }),
        'utf8',
      );
    }
    // maxSymbols=10000 → should stop AFTER loading 'a' (6000) + 'b' (5000 ≥ 10000 cap hit).
    const graph = loadLayeredCodeGraph(root, {
      includeTopShards: true, maxShards: 10, maxSymbols: 10000,
    });
    assert.strictEqual(graph.loadedShards.length, 2,
      `expected 2 shards (a+b tip over budget), got ${graph.loadedShards.length}`);
    const names = graph.loadedShards.map(s => s.module).sort();
    assert.deepStrictEqual(names, ['a', 'b']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maxShards alone still works (no maxSymbols)', () => {
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'output', 'code-graph-index.json'), JSON.stringify({
      version: 1,
      modules: [
        { name: 'a', shard: 'a.json', symbolCount: 100 },
        { name: 'b', shard: 'b.json', symbolCount: 100 },
        { name: 'c', shard: 'c.json', symbolCount: 100 },
      ],
      shardDir: 'code-graph-shards',
    }), 'utf8');
    for (const name of ['a', 'b', 'c']) {
      fs.writeFileSync(
        path.join(root, 'output', 'code-graph-shards', `${name}.json`),
        JSON.stringify({ module: name, files: [], symbols: [] }),
        'utf8',
      );
    }
    const graph = loadLayeredCodeGraph(root, {
      includeTopShards: true, maxShards: 2,
    });
    assert.strictEqual(graph.loadedShards.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log('\n==================================================');
console.log(`Results: ${passed}/${passed + failed} passed`);
console.log('==================================================\n');
if (failed > 0) process.exit(1);
