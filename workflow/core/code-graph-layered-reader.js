'use strict';

const fs = require('fs');
const path = require('path');

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function _safeMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (_) {
    return null;
  }
}

/**
 * Unified code-graph path resolver.
 * L1 (code-graph-index.json) is the primary source; L3 (code-graph.json) is
 * the legacy fallback. Consumers should call this instead of hard-coding
 * `output/code-graph.json`, so they stay correct when legacy is disabled by
 * default (WF_CODE_GRAPH_LEGACY=0 / writeLegacyGraph=false).
 *
 * @param {string} projectRoot
 * @param {string} [outputDir] - override the default `<projectRoot>/output`
 * @returns {{
 *   indexPath: string,
 *   legacyPath: string,
 *   primaryPath: string|null,
 *   exists: boolean,
 *   mtimeMs: number|null,
 *   newestMtimeMs: number|null,
 * }}
 */
function resolveCodeGraphPath(projectRoot, outputDir) {
  const dir = outputDir || path.join(projectRoot, 'output');
  const indexPath = path.join(dir, 'code-graph-index.json');
  const legacyPath = path.join(dir, 'code-graph.json');

  const indexExists = fs.existsSync(indexPath);
  const legacyExists = fs.existsSync(legacyPath);

  const primaryPath = indexExists ? indexPath : (legacyExists ? legacyPath : null);
  const mtimeMs = primaryPath ? _safeMtime(primaryPath) : null;

  const indexMtime = indexExists ? _safeMtime(indexPath) : null;
  const legacyMtime = legacyExists ? _safeMtime(legacyPath) : null;
  let newestMtimeMs = null;
  if (indexMtime != null && legacyMtime != null) {
    newestMtimeMs = Math.max(indexMtime, legacyMtime);
  } else if (indexMtime != null) {
    newestMtimeMs = indexMtime;
  } else if (legacyMtime != null) {
    newestMtimeMs = legacyMtime;
  }

  return {
    indexPath,
    legacyPath,
    primaryPath,
    exists: indexExists || legacyExists,
    mtimeMs,
    newestMtimeMs,
  };
}

function normalizeIndex(index, projectRoot, loadedShards = []) {
  const rawModules = Array.isArray(index.modules) ? index.modules : [];
  // Sort modules by symbolCount desc so `includeTopShards` picks highest-value shards first.
  // Stable sort preserves original order for equal-count modules.
  const modules = rawModules
    .slice()
    .sort((a, b) => (b && b.symbolCount || 0) - (a && a.symbolCount || 0));
  const topHotspots = index.topHotspots || index.hotspots || [];
  const reusableSymbols = index.reusableSymbols || [];

  // Build shards map: shardName -> shardData for consumers
  const shardsMap = {};
  for (const shard of loadedShards) {
    const name = shard.module || (shard.shard && shard.shard.replace(/\.json$/, '')) || 'unknown';
    shardsMap[name] = shard;
  }

  return {
    version: index.sourceVersion || index.version,
    layered: true,
    source: 'layered',
    sourceDetail: 'index',
    projectRoot: index.projectRoot || projectRoot,
    symbolCount: index.symbolCount || 0,
    parserStats: index.parserStats || {},
    modules,
    moduleIndex: modules.reduce((acc, m) => {
      if (m && m.name) acc[m.name] = m;
      return acc;
    }, {}),
    hotspots: topHotspots,
    topHotspots,
    topCrossModuleEdges: index.topCrossModuleEdges || [],
    categoryStats: index.categoryStats || {},
    entrypoints: index.entrypoints || [],
    reusableSymbols,
    symbolLookupTable: index.symbolLookupTable || {},
    symbolLookupLimit: index.symbolLookupLimit || null,
    symbolLookupTruncated: !!index.symbolLookupTruncated,
    shardDir: index.shardDir || 'code-graph-shards',
    legacyGraph: index.legacyGraph || 'code-graph.json',
    loadedShards,
    shards: shardsMap,
  };
}

function moduleNamesFromOptions(index, opts) {
  // Work against sorted modules (same order normalizeIndex returns) so top-N is meaningful.
  const rawModules = Array.isArray(index.modules) ? index.modules : [];
  const modules = rawModules
    .slice()
    .sort((a, b) => (b && b.symbolCount || 0) - (a && a.symbolCount || 0));
  if (Array.isArray(opts.includeShards) && opts.includeShards.length > 0) {
    const wanted = new Set(opts.includeShards);
    return modules.filter(m => wanted.has(m.name) || wanted.has(m.shard));
  }
  if (opts.includeAllShards) {
    return modules;
  }
  if (opts.includeTopShards) {
    const maxShards = opts.maxShards || 5;
    const maxSymbols = opts.maxSymbols || 0;   // 0 = unbounded
    const selected = [];
    let accSymbols = 0;
    for (const m of modules) {
      if (selected.length >= maxShards) break;
      selected.push(m);
      accSymbols += (m && m.symbolCount) || 0;
      // Stop AFTER the shard that tipped over the symbol budget so caller still gets
      // a full shard — avoids the "just short" off-by-one that happens when we stop before.
      if (maxSymbols > 0 && accSymbols >= maxSymbols) break;
    }
    return selected;
  }
  return [];
}

/**
 * Reconstruct global-f-index → filePath mapping for a loaded shard.
 *
 * Invariant (produced by code-graph-cache.js _writeOutput):
 *   shard.files is emitted in sorted order, and aligns with sorted unique
 *   sym.f values observed in shard.symbols. This holds because the builder
 *   assigns global f indices sequentially per module.
 *
 * Use this utility whenever a consumer needs to know the real file path
 * behind a shard symbol's compact `f` index. Do NOT do `shard.files[sym.f]` —
 * that's a subtle bug: `sym.f` is a GLOBAL path-index, not shard-local.
 *
 * @param {object} shard - Loaded shard object (from layered reader)
 * @returns {Map<number, string>} f-index → filePath; empty Map for empty shard
 */
function _buildShardFileIndex(shard) {
  const result = new Map();
  if (!shard || !Array.isArray(shard.symbols) || !Array.isArray(shard.files)) {
    return result;
  }
  const files = shard.files;
  const uniqueF = [...new Set(shard.symbols.map(s => s && s.f).filter(f => typeof f === 'number'))]
    .sort((a, b) => a - b);
  for (let i = 0; i < uniqueF.length && i < files.length; i++) {
    result.set(uniqueF[i], files[i]);
  }
  return result;
}

function loadLayeredCodeGraph(projectRoot, opts = {}) {
  const outputDir = opts.outputDir || path.join(projectRoot, 'output');
  const indexPath = path.join(outputDir, 'code-graph-index.json');
  const legacyPath = path.join(outputDir, 'code-graph.json');
  const index = readJsonIfExists(indexPath);

  if (index) {
    const shardDir = path.join(outputDir, index.shardDir || 'code-graph-shards');
    const loadedShards = [];
    for (const mod of moduleNamesFromOptions(index, opts)) {
      if (!mod || !mod.shard) continue;
      const shard = readJsonIfExists(path.join(shardDir, mod.shard));
      if (shard) loadedShards.push(shard);
    }
    return normalizeIndex(index, projectRoot, loadedShards);
  }

  const legacy = readJsonIfExists(legacyPath);
  if (legacy) {
    legacy.layered = false;
    legacy.source = 'legacy';
    return legacy;
  }

  return {
    layered: false,
    source: 'missing',
    modules: [],
    moduleIndex: {},
    hotspots: [],
    topHotspots: [],
    reusableSymbols: [],
    categoryStats: {},
    symbolCount: 0,
    loadedShards: [],
    shards: [],
  };
}

module.exports = {
  loadLayeredCodeGraph,
  readJsonIfExists,
  resolveCodeGraphPath,
  _buildShardFileIndex,
};
