/**
 * Code Graph – Cache & Serialization Mixin (P1-1)
 *
 * Extracted from code-graph.js to reduce the god file.
 * Contains all disk I/O methods for the code graph:
 *  - _loadFromDisk / _scheduleFormatUpgrade (JSON → memory)
 *  - _loadCache / _saveCache / _restoreFromCache (incremental cache)
 *  - _patchCacheMtimes (lightweight cache update after patch build)
 *  - _writeJsonStreaming / _writeOutput (memory → JSON + Markdown)
 *
 * These methods are mixed into CodeGraph.prototype via Object.assign,
 * so all `this._symbols`, `this._callEdges`, `this._outputDir`, etc.
 * references resolve correctly.
 *
 * @module code-graph-cache
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { translateMdFile } = require('./i18n-translator');

// ─── Process-level singleton cache (shared with code-graph.js) ────────────────
// This reference is passed in via the mixin setup (see module.exports).
let _processCache;

// ─── Path-Dictionary Compression Helpers (shared by _writeOutput and _saveCache)

function _buildPathIndex(symbols, importEdges) {
  const pathSet = new Set();
  for (const sym of symbols.values()) pathSet.add(sym.file);
  for (const filePath of importEdges.keys()) pathSet.add(filePath);
  const filePaths = [...pathSet];
  const pathToIdx = new Map();
  for (let i = 0; i < filePaths.length; i++) pathToIdx.set(filePaths[i], i);
  return { filePaths, pathToIdx };
}

function _compressSymbolIds(callEdges, pathToIdx) {
  const compressId = (symbolId) => {
    const sepIdx = symbolId.indexOf('::');
    if (sepIdx === -1) return symbolId;
    const idx = pathToIdx.get(symbolId.substring(0, sepIdx));
    return idx !== undefined ? `${idx}::${symbolId.substring(sepIdx + 2)}` : symbolId;
  };
  const compact = {};
  for (const [callerId, callees] of callEdges) {
    compact[compressId(callerId)] = callees.map(compressId);
  }
  return compact;
}

function _decompressSymbolIds(compactCallEdges, filePaths) {
  const expandId = (compactId) => {
    const sepIdx = compactId.indexOf('::');
    if (sepIdx === -1) return compactId;
    const idx = parseInt(compactId.substring(0, sepIdx), 10);
    if (isNaN(idx) || idx < 0 || idx >= filePaths.length) return compactId;
    return `${filePaths[idx]}::${compactId.substring(sepIdx + 2)}`;
  };
  const expanded = new Map();
  for (const [key, val] of Object.entries(compactCallEdges || {})) {
    expanded.set(expandId(key), val.map(expandId));
  }
  return expanded;
}

// Framework/package root dirs skipped when inferring module names — these are
// "shell" directories under which the actual module lives one level deeper.
const FRAMEWORK_ROOTS = new Set([
  // JS / TS ecosystem
  'src', 'lib', 'app', 'workflow', 'packages', 'components', 'core',
  // Unity / game projects
  'Assets', 'Library',
  // Go ecosystem
  'pkg', 'internal', 'cmd',
]);

// Pass-2 split thresholds. Tunable via env.
// MAX_SYMBOLS_PER_SHARD: hard ceiling for a single shard (default 15000 ≈ 4MB).
// MAX_SHARD_SPLIT_DEPTH: never drill deeper than this many path segments.
// MIN_SYMBOLS_FOR_SPLIT: dynamically derived from max as max(200, max*0.1);
//   prevents pathological single-file modules from being over-split.
const DEFAULT_MAX_SYMBOLS_PER_SHARD = 15000;
const MAX_SHARD_SPLIT_DEPTH = 3;

function _getMaxSymbolsPerShard() {
  const env = parseInt(process.env.WF_CODE_GRAPH_MAX_SYMBOLS_PER_SHARD, 10);
  if (!isNaN(env) && env > 0) return env;
  return DEFAULT_MAX_SYMBOLS_PER_SHARD;
}

function _getMinSymbolsForSplit(maxSymbols) {
  // Scale with max — 10% of max, floor 50. This lets aggressive test configs
  // (max=100) still drive splits while keeping default production behaviour
  // safe (max=15000 → min=1500, avoids splitting modest modules).
  return Math.max(50, Math.floor(maxSymbols * 0.1));
}

/**
 * Infer module name from a file path.
 * At depth=1 (default) returns the first non-framework-root segment.
 * At depth>=2 returns the first N such segments joined with "/" — used by
 * Pass-2 oversize-split to produce sub-module names like "Assets/Scripts".
 *
 * Important: the LAST path segment (file basename) is never included in the
 * module name — we only partition by directory layers. For a path like
 * "Assets/Scripts/F0.cs", depth=2 returns "Scripts" (not "Scripts/F0.cs");
 * for "Assets/Scripts/UICtrl/F0.cs", depth=2 returns "Scripts/UICtrl".
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.depth=1] - number of directory levels to capture
 * @returns {string}
 */
function _inferModuleFromFile(filePath, opts = {}) {
  const depth = Math.max(1, opts.depth || 1);
  const parts = String(filePath || '').split(/[\\/]+/).filter(Boolean);
  let idx = 0;
  if (parts.length > 1 && FRAMEWORK_ROOTS.has(parts[0])) idx = 1;
  // Directory segments only — never include the file basename (last part).
  const dirParts = parts.slice(idx, parts.length - 1);
  if (depth === 1) return dirParts[0] || parts[idx] || 'root';
  const segs = dirParts.slice(0, depth);
  if (segs.length === 0) return parts[idx] || 'root';
  return segs.join('/');
}

function _safeShardName(moduleName) {
  return String(moduleName || 'root')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'root';
}

/**
 * Pass-2: split modules whose symbolCount exceeds the configured threshold by
 * re-inferring their sub-module name at depth+1, migrating symbols and edges.
 *
 * Operates in place on moduleMap / symbolToModule / moduleIdToShard / crossCounts.
 * Safe no-op when all modules fit under the threshold (small projects).
 *
 * Split invariants:
 *  - Never drops a symbol or edge (symbols preserved, edges re-routed)
 *  - Never exceeds MAX_SHARD_SPLIT_DEPTH depth
 *  - Never splits modules with <MIN_SYMBOLS_FOR_SPLIT symbols
 *  - New shard names synthesized from "parent/child" via _safeShardName
 *  - Shard name collisions resolved by appending "_1", "_2", etc.
 *
 * @param {object} ctx - { moduleMap, symbolToModule, moduleIdToShard, filePaths, crossCounts }
 */
function _splitOversizedModulesInPlace(ctx) {
  const { moduleMap, symbolToModule, moduleIdToShard, filePaths, crossCounts } = ctx;
  const maxSymbols = _getMaxSymbolsPerShard();
  const minSymbolsForSplit = _getMinSymbolsForSplit(maxSymbols);

  // Each module gets a `_depth` (starts 1). Iteratively split modules whose
  // symbolCount > maxSymbols and _depth < MAX_SHARD_SPLIT_DEPTH.
  // Use a worklist so newly-created sub-modules are also re-examined.
  const worklist = [];
  for (const m of moduleMap.values()) {
    if (m._depth == null) m._depth = 1;
    if (m.symbols.length > maxSymbols && m._depth < MAX_SHARD_SPLIT_DEPTH && m.symbols.length >= minSymbolsForSplit) {
      worklist.push(m.module);
    }
  }

  while (worklist.length > 0) {
    const parentName = worklist.shift();
    const parent = moduleMap.get(parentName);
    if (!parent) continue;  // Already split and deleted in a previous iteration
    const newDepth = (parent._depth || 1) + 1;

    // Group parent.symbols by next-level module name
    const subGroups = new Map();  // subModuleName → { symbols, files }
    for (const sym of parent.symbols) {
      const file = filePaths[sym.f] || '';
      const subName = _inferModuleFromFile(file, { depth: newDepth });
      if (!subGroups.has(subName)) {
        subGroups.set(subName, { symbols: [], files: new Set() });
      }
      const g = subGroups.get(subName);
      g.symbols.push(sym);
      g.files.add(file);
    }

    if (process.env.WF_CODE_GRAPH_SPLIT_DEBUG) {
      const dist = [...subGroups.entries()].map(([n, g]) => `${n}=${g.symbols.length}`).join(', ');
      console.log(`[Pass-2] split ${parentName} (depth ${parent._depth} → ${newDepth}) → ${dist}`);
    }

    // If the split produced a single sub-module (all files under same subdir),
    // splitting won't help — stop and keep the parent as is.
    if (subGroups.size <= 1) {
      parent._splitStuck = true;
      continue;
    }

    // Materialise sub-modules. Handle shard-name collisions by suffixing.
    const newSubNames = [];
    for (const [subName, group] of subGroups) {
      let shardBase = _safeShardName(subName);
      let shardName = `${shardBase}.json`;
      let collisionIdx = 1;
      while (moduleIdToShard.has(subName) || _shardNameTaken(moduleMap, shardName, subName)) {
        shardName = `${shardBase}_${collisionIdx}.json`;
        collisionIdx++;
        if (collisionIdx > 100) break;  // Safety valve
      }

      const sub = {
        module: subName,
        shard: shardName,
        files: group.files,
        symbols: group.symbols,
        callEdges: {},
        inboundEdges: [],
        outboundEdges: [],
        _depth: newDepth,
        _parent: parentName,
      };
      moduleMap.set(subName, sub);
      moduleIdToShard.set(subName, shardName);
      newSubNames.push(subName);

      // Update symbolToModule mapping for every symbol that moved
      for (const sym of group.symbols) {
        const compactId = `${sym.f}::${sym.n}`;
        symbolToModule.set(compactId, subName);
      }
    }

    // Re-route parent's intra-module callEdges to new sub-modules (may cross)
    for (const [caller, callees] of Object.entries(parent.callEdges)) {
      const callerSub = symbolToModule.get(caller) || parentName;
      const callerMod = moduleMap.get(callerSub);
      if (!callerMod) continue;
      for (const callee of callees) {
        const calleeSub = symbolToModule.get(callee) || parentName;
        if (callerSub === calleeSub) {
          if (!callerMod.callEdges[caller]) callerMod.callEdges[caller] = [];
          callerMod.callEdges[caller].push(callee);
        } else {
          const calleeMod = moduleMap.get(calleeSub);
          if (!calleeMod) continue;
          callerMod.outboundEdges.push({ from: caller, to: callee, toModule: calleeSub });
          calleeMod.inboundEdges.push({ from: caller, fromModule: callerSub, to: callee });
          const key = `${callerSub}->${calleeSub}`;
          crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
        }
      }
    }

    // Re-route parent's inbound edges — they came from OTHER modules into a symbol
    // that now lives in a specific sub-module. Keep `fromModule` intact.
    for (const edge of parent.inboundEdges) {
      const targetSub = symbolToModule.get(edge.to) || parentName;
      const targetMod = moduleMap.get(targetSub);
      if (!targetMod) continue;
      targetMod.inboundEdges.push(edge);
      // Adjust crossCount: parent used to receive; now sub receives
      const oldKey = `${edge.fromModule}->${parentName}`;
      const newKey = `${edge.fromModule}->${targetSub}`;
      if (crossCounts.has(oldKey)) {
        const n = crossCounts.get(oldKey);
        if (n <= 1) crossCounts.delete(oldKey);
        else crossCounts.set(oldKey, n - 1);
      }
      crossCounts.set(newKey, (crossCounts.get(newKey) || 0) + 1);
    }

    // Re-route parent's outbound edges — originator is now a sub-module.
    for (const edge of parent.outboundEdges) {
      const sourceSub = symbolToModule.get(edge.from) || parentName;
      const sourceMod = moduleMap.get(sourceSub);
      if (!sourceMod) continue;
      sourceMod.outboundEdges.push({ ...edge });
      // Remote side's inbound edges reference `fromModule: parentName`. Fix them.
      const remote = moduleMap.get(edge.toModule);
      if (remote) {
        for (const ib of remote.inboundEdges) {
          if (ib.from === edge.from && ib.fromModule === parentName) {
            ib.fromModule = sourceSub;
          }
        }
      }
      const oldKey = `${parentName}->${edge.toModule}`;
      const newKey = `${sourceSub}->${edge.toModule}`;
      if (crossCounts.has(oldKey)) {
        const n = crossCounts.get(oldKey);
        if (n <= 1) crossCounts.delete(oldKey);
        else crossCounts.set(oldKey, n - 1);
      }
      crossCounts.set(newKey, (crossCounts.get(newKey) || 0) + 1);
    }

    // Remove parent from moduleMap
    moduleMap.delete(parentName);
    moduleIdToShard.delete(parentName);

    // Enqueue new sub-modules if they're still oversized
    for (const name of newSubNames) {
      const sub = moduleMap.get(name);
      if (!sub) continue;
      if (sub.symbols.length > maxSymbols
          && sub._depth < MAX_SHARD_SPLIT_DEPTH
          && sub.symbols.length >= minSymbolsForSplit
          && !sub._splitStuck) {
        worklist.push(name);
      }
    }
  }
}

/**
 * Detect whether another module in the moduleMap (not `selfName`) already uses
 * `shardName`. Used to resolve shard name collisions during Pass-2 split.
 */
function _shardNameTaken(moduleMap, shardName, selfName) {
  for (const [name, mod] of moduleMap) {
    if (name === selfName) continue;
    if (mod.shard === shardName) return true;
  }
  return false;
}


function _compactIdFileIndex(compactId) {
  const sepIdx = String(compactId).indexOf('::');
  if (sepIdx === -1) return null;
  const idx = parseInt(String(compactId).substring(0, sepIdx), 10);
  return Number.isFinite(idx) ? idx : null;
}

// ─── Cache & Serialization Mixin ──────────────────────────────────────────────

const CodeGraphCacheMixin = {

  /**
   * Public API: Ensure the code graph is loaded into memory.
   * If already loaded (symbols.size > 0), this is a no-op.
   * Use this instead of calling _loadFromDisk() directly from external modules.
   */
  ensureLoaded() {
    if (this._symbols.size === 0) {
      this._loadFromDisk();
    }
  },

  /**
   * Loads the code graph index from the persisted JSON file (disk → memory).
   * Called automatically when querySymbol() is invoked on an empty in-memory index.
   *
   * Priority:
   *  1. Legacy L3 (code-graph.json) — fastest path, full fidelity, kept for compat
   *  2. Layered L1+L2 (code-graph-index.json + shards) — used when L3 is disabled
   *  3. Neither — leave _symbols empty (query returns [] gracefully)
   */
  _loadFromDisk() {
    const jsonPath = path.join(this._outputDir, 'code-graph.json');
    if (!fs.existsSync(jsonPath)) {
      // L3 not available → try layered fallback (L1+L2).
      // This is the default path after the legacy full-graph disable (WF-migration).
      this._loadFromLayered();
      return;
    }
    try {
      let stat;
      try { stat = fs.statSync(jsonPath); } catch (e) { console.warn('[CodeGraphCache] statSync failed for', jsonPath, ':', e.message); return; }
      const cached = _processCache.get(jsonPath);
      if (cached && cached.mtime === stat.mtimeMs) {
        this._symbols.clear();
        this._callEdges.clear();
        this._importEdges.clear();
        for (const [k, v] of cached.symbols)    this._symbols.set(k, v);
        for (const [k, v] of cached.callEdges)  this._callEdges.set(k, v);
        for (const [k, v] of cached.importEdges) this._importEdges.set(k, v);
        console.log(`[CodeGraph] ⚡ Loaded from process cache: ${this._symbols.size} symbols (skipped disk I/O)`);
        return;
      }

      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      this._symbols.clear();
      this._callEdges.clear();
      this._importEdges.clear();

      if (data.version === 2 && Array.isArray(data.filePaths)) {
        const filePaths = data.filePaths;

        for (const cs of (data.symbols || [])) {
          const file = filePaths[cs.f] || `unknown_${cs.f}`;
          const id   = `${file}::${cs.n}`;
          this._symbols.set(id, {
            id,
            kind:      cs.k,
            name:      cs.n,
            file,
            line:      cs.l,
            signature: cs.s || '',
            summary:   cs.m || '',
            _weight:   cs.w || 0,
          });
        }

        const expandId = (compactId) => {
          const sepIdx = compactId.indexOf('::');
          if (sepIdx === -1) return compactId;
          const idxStr = compactId.substring(0, sepIdx);
          const idx = parseInt(idxStr, 10);
          if (isNaN(idx) || idx < 0 || idx >= filePaths.length) return compactId;
          return `${filePaths[idx]}::${compactId.substring(sepIdx + 2)}`;
        };

        for (const [compactKey, compactCallees] of Object.entries(data.callEdges || {})) {
          const fullKey = expandId(compactKey);
          this._callEdges.set(fullKey, compactCallees.map(expandId));
        }

        for (const [compactKey, imports] of Object.entries(data.importEdges || {})) {
          const idx = parseInt(compactKey, 10);
          const fullKey = (!isNaN(idx) && idx >= 0 && idx < filePaths.length)
            ? filePaths[idx]
            : compactKey;
          this._importEdges.set(fullKey, imports);
        }
      } else {
        for (const sym of (data.symbols || [])) {
          this._symbols.set(sym.id, sym);
        }
        for (const [k, v] of Object.entries(data.callEdges || {})) {
          this._callEdges.set(k, v);
        }
        for (const [k, v] of Object.entries(data.importEdges || {})) {
          this._importEdges.set(k, v);
        }
      }

      _processCache.set(jsonPath, {
        mtime:      stat.mtimeMs,
        symbols:    new Map(this._symbols),
        callEdges:  new Map(this._callEdges),
        importEdges: new Map(this._importEdges),
      });

      const isV1 = data.version !== 2;
      const formatLabel = isV1 ? 'v1 legacy' : 'v2 path-dictionary';
      console.log(`[CodeGraph] 📂 Loaded from disk: ${this._symbols.size} symbols (${formatLabel}, cached for reuse)`);

      this._buildTokenIndex();

      if (isV1 && this._symbols.size > 0) {
        this._needsFormatUpgrade = true;
        this._scheduleFormatUpgrade(jsonPath);
      }
    } catch (err) {
      console.warn(`[CodeGraph] Failed to load from disk: ${err.message}`);
    }
  },

  /**
   * Load symbols/callEdges/importEdges from layered artifacts (L1 index + L2 shards).
   * Used when L3 (code-graph.json) is disabled — the default post-migration state.
   *
   * Shard file format (see code-graph-cache.js:_writeOutput):
   *   {
   *     module: string,
   *     files: string[],                    // sorted; index position matches f-index offset
   *     symbols: [{ f, k, n, l, s?, m?, e? }...],  // f is GLOBAL filePaths index
   *     callEdges: { "f::n": ["f::n", ...] },
   *     inboundEdges / outboundEdges: [...]
   *   }
   *
   * Reconstruction strategy: for each shard, use `files` sorted order +
   * sorted unique `sym.f` values to build a local f→file map, then convert
   * compact symbols to full `<file>::<name>` ids matching v2 format.
   *
   * @returns {boolean} true iff symbols were loaded (symbolCount > 0)
   */
  _loadFromLayered() {
    try {
      if (!this._outputDir) return false;

      const indexPath = path.join(this._outputDir, 'code-graph-index.json');
      if (!fs.existsSync(indexPath)) return false;

      const { loadLayeredCodeGraph } = require('./code-graph-layered-reader');
      const layered = loadLayeredCodeGraph(this._root, {
        outputDir: this._outputDir,
        includeAllShards: true,
      });

      if (!layered || layered.source !== 'layered' || !layered.loadedShards.length) {
        return false;
      }

      this._symbols.clear();
      this._callEdges.clear();
      this._importEdges.clear();

      // Per-shard compact-id → full-id map (used to expand callEdges keys/values)
      const compactToFullId = new Map();

      for (const shard of layered.loadedShards) {
        const files = Array.isArray(shard.files) ? shard.files : [];
        const symbols = Array.isArray(shard.symbols) ? shard.symbols : [];
        if (symbols.length === 0) continue;

        // Build f-index → file-path map using sorted unique f indices aligned with sorted files.
        // This works because builder emits `files` sorted and assigns f indices sequentially per module.
        const uniqueF = [...new Set(symbols.map(s => s.f))].sort((a, b) => a - b);
        const fToFile = new Map();
        for (let i = 0; i < uniqueF.length && i < files.length; i++) {
          fToFile.set(uniqueF[i], files[i]);
        }

        for (const cs of symbols) {
          const file = fToFile.get(cs.f);
          if (!file) continue;
          const id = `${file}::${cs.n}`;
          compactToFullId.set(`${cs.f}::${cs.n}`, id);
          this._symbols.set(id, {
            id,
            kind:      cs.k,
            name:      cs.n,
            file,
            line:      cs.l,
            signature: cs.s || '',
            summary:   cs.m || '',
            endLine:   cs.e,
            _weight:   cs.w || 0,
          });
        }
      }

      // Second pass: expand callEdges once all symbols (and thus compactToFullId) are known.
      // Callees may live in a different shard, so we need the complete map first.
      for (const shard of layered.loadedShards) {
        const callEdges = (shard && typeof shard.callEdges === 'object') ? shard.callEdges : {};
        for (const [compactCaller, compactCallees] of Object.entries(callEdges)) {
          const fullCaller = compactToFullId.get(compactCaller);
          if (!fullCaller || !Array.isArray(compactCallees)) continue;
          const fullCallees = compactCallees
            .map(c => compactToFullId.get(c))
            .filter(Boolean);
          if (fullCallees.length === 0) continue;
          const existing = this._callEdges.get(fullCaller);
          if (existing) {
            this._callEdges.set(fullCaller, existing.concat(fullCallees));
          } else {
            this._callEdges.set(fullCaller, fullCallees);
          }
        }
      }

      if (this._symbols.size === 0) return false;

      console.log(`[CodeGraph] 🧩 Loaded from layered: ${this._symbols.size} symbols, ${this._callEdges.size} call-edge groups from ${layered.loadedShards.length} shard(s)`);

      // Build token index so search/querySymbol work.
      if (typeof this._buildTokenIndex === 'function') {
        this._buildTokenIndex();
      }

      return true;
    } catch (err) {
      console.warn(`[CodeGraph] Failed to load from layered artifacts: ${err.message}`);
      return false;
    }
  },

  /**
   * Schedule a non-blocking async re-write of code-graph.json in v2 format.
   */
  _scheduleFormatUpgrade(jsonPath) {
    if (this._upgradePromise) return;

    console.log(`[CodeGraph] 🔄 Auto-upgrade: scheduling v1 → v2 format re-write for ${path.basename(jsonPath)}`);

    this._upgradePromise = new Promise(async (resolve) => {
      const run = async () => {
        try {
          const result = await this._writeOutput();
          this._needsFormatUpgrade = false;
          this._upgradePromise = null;
          if (result) {
            console.log(`[CodeGraph] ✅ Auto-upgrade: v1 → v2 re-write complete`);
          }
        } catch (err) {
          console.warn(`[CodeGraph] ⚠️  Auto-upgrade failed (non-fatal): ${err.message}`);
          this._upgradePromise = null;
        }
        resolve();
      };
      if (typeof setImmediate === 'function') {
        setImmediate(run);
      } else {
        setTimeout(run, 0);
      }
    });
  },

  // ─── Incremental Cache ────────────────────────────────────────────────────

  _loadCache(cachePath) {
    try {
      if (!fs.existsSync(cachePath)) return null;

      // Fast path: read lightweight mtimes-only sidecar file (avoids parsing 1GB+ cache)
      const mtimesPath = cachePath.replace(/\.json$/, '-mtimes.json');
      if (fs.existsSync(mtimesPath)) {
        const raw = JSON.parse(fs.readFileSync(mtimesPath, 'utf-8'));
        if ((raw.version !== 1 && raw.version !== 2) || raw.projectRoot !== this._root) {
          console.log(`[CodeGraph] ♻️  Cache invalidated (version or root mismatch)`);
          return null;
        }
        console.log(`[CodeGraph] 📦 Cache loaded (fast): ${Object.keys(raw.fileMtimes || {}).length} files cached`);
        return raw;
      }

      // Fallback: read full cache (legacy or first run)
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if ((raw.version !== 1 && raw.version !== 2) || raw.projectRoot !== this._root) {
        console.log(`[CodeGraph] ♻️  Cache invalidated (version or root mismatch)`);
        return null;
      }

      // Decompress v2 path-dict format back to full objects for _restoreFromCache
      if (raw.version === 2 && raw.filePaths) {
        const expandSym = (entry) => ({
          id:        `${raw.filePaths[entry.f]}::${entry.n}`,
          name:      entry.n,
          kind:      entry.k,
          file:      raw.filePaths[entry.f],
          line:      entry.l,
          signature: entry.s || '',
          summary:   entry.m || '',
          endLine:   entry.e,
        });
        const decompressed = {
          version:     raw.version,
          projectRoot: raw.projectRoot,
          fileMtimes:  raw.fileMtimes || {},
          symbols:     (raw.symbols || []).map(expandSym),
          callEdges:   _decompressSymbolIds(raw.callEdges, raw.filePaths),
          importEdges: (() => {
            const expanded = new Map();
            for (const [key, val] of Object.entries(raw.importEdges || {})) {
              const idx = parseInt(key, 10);
              const fPath = !isNaN(idx) && idx >= 0 && idx < raw.filePaths.length
                ? raw.filePaths[idx] : key;
              expanded.set(fPath, val);
            }
            return expanded;
          })(),
        };
        console.log(`[CodeGraph] 📦 Cache loaded (v2 decompressed): ${Object.keys(decompressed.fileMtimes).length} files`);
        return decompressed;
      }

      console.log(`[CodeGraph] 📦 Cache loaded (v1): ${Object.keys(raw.fileMtimes || {}).length} files cached`);
      return raw;
    } catch (err) {
      console.warn(`[CodeGraph] ⚠️  Cache load failed: ${err.message}`);
      return null;
    }
  },

  _saveCache(cachePath, files) {
    // P1-3 fix: Declare cacheData outside try so the catch fallback can access it.
    let cacheData;
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      const fileMtimes = {};
      for (const filePath of files) {
        const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
        const cached = this._fileMtimes.get(relPath);
        if (cached != null) {
          fileMtimes[relPath] = cached;
        } else {
          try {
            fileMtimes[relPath] = fs.statSync(filePath).mtimeMs;
          } catch (_) { /* skip */ }
        }
      }

      // Path-dictionary compression for cache (v2 format)
      const { filePaths, pathToIdx } = _buildPathIndex(this._symbols, this._importEdges);

      const compactSymbols = [];
      for (const sym of this._symbols.values()) {
        const entry = {
          f: pathToIdx.get(sym.file),
          k: sym.kind,
          n: sym.name,
          l: sym.line,
        };
        if (sym.signature) entry.s = sym.signature;
        if (sym.summary)   entry.m = sym.summary;
        if (sym.endLine)   entry.e = sym.endLine;
        compactSymbols.push(entry);
      }

      const compactCallEdges = _compressSymbolIds(this._callEdges, pathToIdx);

      const compactImportEdges = {};
      for (const [fPath, imports] of this._importEdges) {
        const idx = pathToIdx.get(fPath);
        const key = idx !== undefined ? String(idx) : fPath;
        compactImportEdges[key] = imports;
      }

      cacheData = {
        version:       2,
        codegraphVersion: '2.2',
        projectRoot:   this._root,
        savedAt:       new Date().toISOString(),
        fileMtimes,
        filePaths,
        symbols:       compactSymbols,
        callEdges:     compactCallEdges,
        importEdges:   compactImportEdges,
      };

      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf-8');
      console.log(`[CodeGraph] 💾 Cache saved: ${Object.keys(fileMtimes).length} files`);

      // Save lightweight mtimes-only sidecar for fast incremental detection
      const mtimesPath = cachePath.replace(/\.json$/, '-mtimes.json');
      fs.writeFileSync(mtimesPath, JSON.stringify({
        version: 1,
        projectRoot: this._root,
        savedAt: cacheData.savedAt,
        fileMtimes,
      }), 'utf-8');
      
      // P0: Save structural fingerprints for refined change detection
      if (this._fingerprintEngine) {
        this._fingerprintEngine.saveCache();
      }
    } catch (err) {
      if (err.message && err.message.includes('Invalid string length') && cacheData) {
        try {
          console.log(`[CodeGraph] ⚠️  Cache too large for single stringify, using streaming write...`);
          this._writeJsonStreaming(cachePath, cacheData);
          console.log(`[CodeGraph] 💾 Cache saved (streamed)`);
          // Also save mtimes sidecar for fast incremental detection
          const mtimesPath = cachePath.replace(/\.json$/, '-mtimes.json');
          fs.writeFileSync(mtimesPath, JSON.stringify({
            version: 1,
            projectRoot: this._root,
            savedAt: cacheData.savedAt,
            fileMtimes: cacheData.fileMtimes,
          }), 'utf-8');
          return;
        } catch (streamErr) {
          console.warn(`[CodeGraph] ⚠️  Cache streaming write also failed: ${streamErr.message}`);
        }
      }
      console.warn(`[CodeGraph] ⚠️  Cache save failed: ${err.message}`);
    }
  },
  _restoreFromCache(cache, removedFiles, changedFilesFull) {
    const excludeSet = new Set([
      ...removedFiles,
      ...changedFilesFull.map(f => path.relative(this._root, f).replace(/\\/g, '/')),
    ]);

    for (const sym of (cache.symbols || [])) {
      if (!excludeSet.has(sym.file)) {
        this._symbols.set(sym.id, sym);
      }
    }

    const entriesFrom = (objOrMap) =>
      objOrMap instanceof Map ? objOrMap.entries() : Object.entries(objOrMap || {});

    for (const [symId, callees] of entriesFrom(cache.callEdges)) {
      const file = symId.split('::')[0];
      if (!excludeSet.has(file)) {
        this._callEdges.set(symId, callees);
      }
    }

    for (const [relPath, imports] of entriesFrom(cache.importEdges)) {
      if (!excludeSet.has(relPath)) {
        this._importEdges.set(relPath, imports);
      }
    }

    console.log(`[CodeGraph] ♻️  Restored from cache: ${this._symbols.size} symbols, ${this._callEdges.size} call edges`);
  },

  _patchCacheMtimes(patchedRelPaths) {
    const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
    try {
      if (!fs.existsSync(cachePath)) return;
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (raw.version !== 1 || !raw.fileMtimes) return;

      let updated = 0;
      for (const relPath of patchedRelPaths) {
        const absPath = path.join(this._root, relPath);
        try {
          const stat = fs.statSync(absPath);
          raw.fileMtimes[relPath] = stat.mtimeMs;
          updated++;
        } catch (_) {
          delete raw.fileMtimes[relPath];
          updated++;
        }
      }

      if (updated > 0) {
        raw.savedAt = new Date().toISOString();
        fs.writeFileSync(cachePath, JSON.stringify(raw), 'utf-8');
      }
    } catch (err) {
      console.warn(`[CodeGraph] ⚠️  Cache mtime patch failed (non-fatal): ${err.message}`);
    }
  },

  // ─── Output Writers ───────────────────────────────────────────────────────

  _writeLayeredOutput({ graphData, filePaths, compactSymbols, compactCallEdges, compactHotspots, stats }) {
    const shardsDir = path.join(this._outputDir, 'code-graph-shards');
    fs.mkdirSync(shardsDir, { recursive: true });

    const moduleMap = new Map();
    const symbolToModule = new Map();
    const moduleIdToShard = new Map();
    const ensureModule = (name) => {
      const moduleName = name || 'root';
      if (!moduleMap.has(moduleName)) {
        const shard = `${_safeShardName(moduleName)}.json`;
        moduleMap.set(moduleName, {
          module: moduleName,
          shard,
          files: new Set(),
          symbols: [],
          callEdges: {},
          inboundEdges: [],
          outboundEdges: [],
        });
        moduleIdToShard.set(moduleName, shard);
      }
      return moduleMap.get(moduleName);
    };

    for (const sym of compactSymbols) {
      const file = filePaths[sym.f] || '';
      const moduleName = _inferModuleFromFile(file);
      const compactId = `${sym.f}::${sym.n}`;
      const mod = ensureModule(moduleName);
      mod.files.add(file);
      mod.symbols.push(sym);
      symbolToModule.set(compactId, moduleName);
    }

    const crossCounts = new Map();
    for (const [caller, callees] of Object.entries(compactCallEdges || {})) {
      const callerModule = symbolToModule.get(caller) || _inferModuleFromFile(filePaths[_compactIdFileIndex(caller)]);
      const callerMod = ensureModule(callerModule);
      for (const callee of callees || []) {
        const calleeModule = symbolToModule.get(callee) || _inferModuleFromFile(filePaths[_compactIdFileIndex(callee)]);
        if (callerModule === calleeModule) {
          if (!callerMod.callEdges[caller]) callerMod.callEdges[caller] = [];
          callerMod.callEdges[caller].push(callee);
        } else {
          const calleeMod = ensureModule(calleeModule);
          callerMod.outboundEdges.push({ from: caller, to: callee, toModule: calleeModule });
          calleeMod.inboundEdges.push({ from: caller, fromModule: callerModule, to: callee });
          const key = `${callerModule}->${calleeModule}`;
          crossCounts.set(key, (crossCounts.get(key) || 0) + 1);
        }
      }
    }

    // ── Pass-2: Auto-drill-down for oversized modules ─────────────────────
    // When a module packs >MAX_SYMBOLS_PER_SHARD symbols, split it along the
    // next path segment (depth+1). Only applies to depth<=MAX_SHARD_SPLIT_DEPTH
    // and modules with symbolCount >= MIN_SYMBOLS_FOR_SPLIT (guards small projects).
    _splitOversizedModulesInPlace({
      moduleMap,
      symbolToModule,
      moduleIdToShard,
      filePaths,
      crossCounts,
    });


    const symbolLookupTable = Object.create(null);
    const MAX_L1_SYMBOL_LOOKUP = 500;
    const addLookup = (name, moduleName) => {
      if (!name || Object.keys(symbolLookupTable).length >= MAX_L1_SYMBOL_LOOKUP) return;
      const shard = moduleIdToShard.get(moduleName);
      if (!Array.isArray(symbolLookupTable[name])) symbolLookupTable[name] = [];
      if (!symbolLookupTable[name].includes(shard)) symbolLookupTable[name].push(shard);
    };
    for (const h of compactHotspots || []) {
      const moduleName = _inferModuleFromFile(filePaths[h.f]);
      addLookup(h.n, moduleName);
    }
    for (const [compactId, moduleName] of symbolToModule) {
      const name = compactId.substring(compactId.indexOf('::') + 2);
      addLookup(name, moduleName);
      if (Object.keys(symbolLookupTable).length >= MAX_L1_SYMBOL_LOOKUP) break;
    }

    const modules = [...moduleMap.values()]
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .map(m => ({
        name: m.module,
        shard: m.shard,
        fileCount: m.files.size,
        symbolCount: m.symbols.length,
        callEdgeCount: Object.values(m.callEdges).reduce((n, v) => n + v.length, 0),
        inboundEdgeCount: m.inboundEdges.length,
        outboundEdgeCount: m.outboundEdges.length,
      }));

    const topCrossModuleEdges = [...crossCounts.entries()]
      .map(([key, count]) => {
        const [fromModule, toModule] = key.split('->');
        return { fromModule, toModule, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);

    const reusableSymbols = (compactHotspots || [])
      .filter(h => ['utility', 'foundation', 'hub'].includes(h.c))
      .slice(0, 50);
    const entrypoints = (compactHotspots || []).filter(h => h.c === 'entry').slice(0, 50);

    const index = {
      version: 1,
      sourceVersion: graphData.version,
      generatedAt: graphData.generatedAt,
      projectRoot: graphData.projectRoot,
      symbolCount: graphData.symbolCount,
      parserStats: graphData.parserStats,
      modules,
      topHotspots: (compactHotspots || []).slice(0, 50),
      topCrossModuleEdges,
      categoryStats: stats,
      entrypoints,
      reusableSymbols,
      symbolLookupTable,
      symbolLookupLimit: MAX_L1_SYMBOL_LOOKUP,
      symbolLookupTruncated: symbolToModule.size > MAX_L1_SYMBOL_LOOKUP,
      shardDir: 'code-graph-shards',
      legacyGraph: 'code-graph.json',
    };

    for (const mod of moduleMap.values()) {
      const shardData = {
        version: 1,
        generatedAt: graphData.generatedAt,
        projectRoot: graphData.projectRoot,
        module: mod.module,
        files: [...mod.files].sort(),
        symbols: mod.symbols,
        callEdges: mod.callEdges,
        inboundEdges: mod.inboundEdges,
        outboundEdges: mod.outboundEdges,
      };
      fs.writeFileSync(path.join(shardsDir, mod.shard), JSON.stringify(shardData), 'utf-8');
    }

    const indexPath = path.join(this._outputDir, 'code-graph-index.json');
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf-8');
    return { indexPath, shardCount: modules.length, modules };
  },

  _writeJsonStreaming(filePath, data) {
    const fd = fs.openSync(filePath, 'w');
    try {
      fs.writeSync(fd, '{');
      const keys = Object.keys(data);
      for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[ki];
        const val = data[key];
        fs.writeSync(fd, `${ki > 0 ? ',' : ''}${JSON.stringify(key)}:`);

        if (Array.isArray(val)) {
          fs.writeSync(fd, '[');
          for (let i = 0; i < val.length; i++) {
            if (i > 0) fs.writeSync(fd, ',');
            fs.writeSync(fd, JSON.stringify(val[i]));
          }
          fs.writeSync(fd, ']');
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          const entries = Object.entries(val);
          if (entries.length > 1000) {
            fs.writeSync(fd, '{');
            for (let i = 0; i < entries.length; i++) {
              if (i > 0) fs.writeSync(fd, ',');
              fs.writeSync(fd, `${JSON.stringify(entries[i][0])}:${JSON.stringify(entries[i][1])}`);
            }
            fs.writeSync(fd, '}');
          } else {
            fs.writeSync(fd, JSON.stringify(val));
          }
        } else {
          fs.writeSync(fd, JSON.stringify(val));
        }
      }
      fs.writeSync(fd, '}');
    } finally {
      fs.closeSync(fd);
    }
  },

  _shouldWriteLegacyGraph() {
    const env = String(process.env.WF_CODE_GRAPH_LEGACY || '').toLowerCase();
    return env === '1' || env === 'true' || this._writeLegacyGraph === true;
  },

  async _writeOutput() {
    // P0-1 fix: Declare graphData outside try so the catch fallback can access it.
    // Previously, graphData was a const inside try, causing ReferenceError in the
    // "Invalid string length" catch path — silently losing the entire code graph output.
    let graphData;
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      const jsonPath = path.join(this._outputDir, 'code-graph.json');
      const hotspots = await this.getHotspots({ topN: 30 });
      const stats = await this.getCategoryStats();

      // ── Path Dictionary Compression (v2 format) ──
      const { filePaths, pathToIdx } = _buildPathIndex(this._symbols, this._importEdges);

      // AST coverage counters for CLI visibility
      let astSymbolCount = 0;
      const compactSymbols = [];
      for (const sym of this._symbols.values()) {
        const entry = {
          f: pathToIdx.get(sym.file),
          k: sym.kind,
          n: sym.name,
          l: sym.line,
        };
        if (sym.parser === 'tree-sitter') {
          entry.p = 1; // tree-sitter AST parsed
          astSymbolCount++;
        } else if (sym.parser) {
          entry.p = 2; // regex fallback
        }
        const sig = sym._enriched ? (sym._originalSignature || '') : (sym.signature || '');
        if (sig) entry.s = sig;
        if (sym.summary)   entry.m = sym.summary;
        const w = this._computeImportanceWeights().get(sym.id) || 0;
        if (w > 0.01) entry.w = Math.round(w * 1000) / 1000;
        compactSymbols.push(entry);
      }

      const compactCallEdges = _compressSymbolIds(this._callEdges, pathToIdx);

      const compactImportEdges = {};
      for (const [fPath, imports] of this._importEdges) {
        const idx = pathToIdx.get(fPath);
        const key = idx !== undefined ? String(idx) : fPath;
        compactImportEdges[key] = imports;
      }

      const compactHotspots = hotspots.map(h => ({
        f:  pathToIdx.get(h.symbol.file),
        n:  h.symbol.name,
        k:  h.symbol.kind,
        l:  h.symbol.line,
        cb: h.calledByCount,
        co: h.callsOutCount,
        c:  h.category,
      }));

      graphData = {
        version:       2,
        generatedAt:   new Date().toISOString(),
        projectRoot:   this._root,
        symbolCount:   this._symbols.size,
        parserStats:   {
          astParsed: astSymbolCount,
          regexParsed: this._symbols.size - astSymbolCount,
          astCoveragePercent: this._symbols.size > 0
            ? Math.round((astSymbolCount / this._symbols.size) * 1000) / 10
            : 0,
        },
        filePaths,
        symbols:       compactSymbols,
        callEdges:     compactCallEdges,
        importEdges:   compactImportEdges,
        hotspots:      compactHotspots,
        categoryStats: stats,
      };

      const layered = this._writeLayeredOutput({
        graphData,
        filePaths,
        compactSymbols,
        compactCallEdges,
        compactHotspots,
        stats,
      });

      const writeLegacyGraph = this._shouldWriteLegacyGraph();
      if (writeLegacyGraph) {
        if (this._symbols.size < 50000) {
          fs.writeFileSync(jsonPath, JSON.stringify(graphData), 'utf-8');
        } else {
          this._writeJsonStreaming(jsonPath, graphData);
        }
        _processCache.delete(jsonPath);
        console.log(`[CodeGraph] 📄 Legacy full graph: ${jsonPath}`);
      } else {
        console.log(`[CodeGraph] ⏭️ Legacy full graph disabled by default`);
      }

      const mdPath = path.join(this._outputDir, 'code-graph.md');
      const mdContent = await this.toMarkdown();
      fs.writeFileSync(mdPath, mdContent, 'utf-8');

      translateMdFile(mdPath, this._llmCall).catch(() => {});

      const astPct = graphData.parserStats.astCoveragePercent;
      const astIcon = astPct >= 50 ? '🌲' : astPct >= 20 ? '🌱' : '⚠️';
      console.log(`[CodeGraph] 🧭 Layered index: ${layered.indexPath} (${layered.shardCount} shard(s))`);
      if (this._shouldWriteLegacyGraph()) console.log(`[CodeGraph] 📄 Written: ${jsonPath} (legacy v2, ${filePaths.length} paths, ${this._symbols.size} symbols)`);
      console.log(`[CodeGraph] ${astIcon} AST coverage: ${graphData.parserStats.astParsed}/${this._symbols.size} symbols (${astPct}%) via tree-sitter`);
      return this._shouldWriteLegacyGraph() ? jsonPath : layered.indexPath;
    } catch (err) {
      if (err.message && err.message.includes('Invalid string length') && graphData) {
        try {
          const jsonPath = path.join(this._outputDir, 'code-graph.json');
          if (this._shouldWriteLegacyGraph()) {
            console.log(`[CodeGraph] ⚠️  JSON too large for single stringify (${this._symbols.size} symbols), falling back to streaming legacy write...`);
            this._writeJsonStreaming(jsonPath, graphData);
            _processCache.delete(jsonPath);
          } else {
            console.log(`[CodeGraph] ⏭️ Legacy full graph too large and disabled; skipping ${jsonPath}`);
          }
          const mdPath = path.join(this._outputDir, 'code-graph.md');
          const mdContent = await this.toMarkdown();
          fs.writeFileSync(mdPath, mdContent, 'utf-8');
          translateMdFile(mdPath, this._llmCall).catch(() => {});
          if (this._shouldWriteLegacyGraph()) {
            console.log(`[CodeGraph] 📄 Written (streamed legacy): ${jsonPath}`);
            return jsonPath;
          }
          return null;
        } catch (streamErr) {
          console.warn(`[CodeGraph] ❌ Streaming write also failed: ${streamErr.message}`);
          return null;
        }
      }
      console.warn(`[CodeGraph] Failed to write output: ${err.message}`);
      return null;
    }
  },

};

/**
 * Initialize the cache mixin with the process-level cache reference.
 * Called from code-graph.js during mixin setup.
 * @param {Map} cache - The process-level singleton cache Map
 */
function setProcessCache(cache) {
  _processCache = cache;
}

module.exports = { CodeGraphCacheMixin, setProcessCache };
