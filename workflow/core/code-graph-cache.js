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
   */
  _loadFromDisk() {
    const jsonPath = path.join(this._outputDir, 'code-graph.json');
    if (!fs.existsSync(jsonPath)) return;
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

      if (this._symbols.size < 50000) {
        fs.writeFileSync(jsonPath, JSON.stringify(graphData), 'utf-8');
      } else {
        this._writeJsonStreaming(jsonPath, graphData);
      }

      _processCache.delete(jsonPath);

      const mdPath = path.join(this._outputDir, 'code-graph.md');
      const mdContent = await this.toMarkdown();
      fs.writeFileSync(mdPath, mdContent, 'utf-8');

      translateMdFile(mdPath, this._llmCall).catch(() => {});

      const astPct = graphData.parserStats.astCoveragePercent;
      const astIcon = astPct >= 50 ? '🌲' : astPct >= 20 ? '🌱' : '⚠️';
      console.log(`[CodeGraph] 📄 Written: ${jsonPath} (v2, ${filePaths.length} paths, ${this._symbols.size} symbols)`);
      console.log(`[CodeGraph] ${astIcon} AST coverage: ${graphData.parserStats.astParsed}/${this._symbols.size} symbols (${astPct}%) via tree-sitter`);
      return jsonPath;
    } catch (err) {
      if (err.message && err.message.includes('Invalid string length') && graphData) {
        try {
          console.log(`[CodeGraph] ⚠️  JSON too large for single stringify (${this._symbols.size} symbols), falling back to streaming write...`);
          const jsonPath = path.join(this._outputDir, 'code-graph.json');
          this._writeJsonStreaming(jsonPath, graphData);
          _processCache.delete(jsonPath);
          const mdPath = path.join(this._outputDir, 'code-graph.md');
          const mdContent = await this.toMarkdown();
          fs.writeFileSync(mdPath, mdContent, 'utf-8');
          translateMdFile(mdPath, this._llmCall).catch(() => {});
          console.log(`[CodeGraph] 📄 Written (streamed): ${jsonPath}`);
          return jsonPath;
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
