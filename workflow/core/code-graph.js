/**
 * Code Graph – Facade Module (ADR-33 P0 Decomposition, ADR-37 Lazy Loading)
 *
 * This file aggregates all CodeGraph mixins into a unified class.
 * All implementation code has been extracted to dedicated modules:
 *   - code-graph-builder.js    – Graph construction logic (build, _patchBuild, etc.)
 *   - code-graph-query.js      – Query logic (search, querySymbol, etc.)
 *   - code-graph-analysis.js   – Hotspot analysis (hotspot, module summary)
 *   - code-graph-enrichment.js – Symbol enrichment (LSP, importance weights)
 *   - code-graph-cache.js      – Cache I/O (save, load, format upgrade)
 *   - code-graph-parsers.js    – Language-specific parsers
 *   - code-graph-types.js      – SymbolKind enum and type definitions
 *
 * P0-Enhancement: Lazy Loading Support
 *   - IDE environment: CodeGraph operates in fallback-only mode, no build on init
 *   - Non-IDE environment: lazy-loaded on first query, not on constructor
 *
 * Original size: 90.12 KB (2037 lines)
 * Refactored size: ~3 KB (this file + class shell)
 *
 * @module code-graph
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Symbol Types (single source of truth) ────────────────────────────────────
const { SymbolKind } = require('./code-graph-types');

// ─── Process-level singleton cache ─────────────────────────────────────────────
const _processCache = new Map();

// ─── CodeGraph Class Shell ─────────────────────────────────────────────────────
// Only the constructor and core data structures remain here.
// All methods are provided via mixins from dedicated modules.

class CodeGraph {
  /**
   * Check if a symbol name is "noisy" — too short or too generic to be
   * meaningful in hotspot / importance analysis.
   *
   * @param {string} name - Symbol name to check
   * @returns {boolean} true if the name should be excluded from analysis
   */
  static isNoisyName(name) {
    const baseName = name.includes(':') ? name.split(':').pop() : name;
    if (baseName.length <= 3) return true;
    // Common generic names that produce false-positive cross-file call edges
    const NOISY = new Set([
      'main', 'init', 'setup', 'start', 'stop', 'run', 'exec',
      'test', 'describe', 'before', 'after',
      'toString', 'valueOf', 'constructor', 'dispose',
      'then', 'catch', 'next', 'done', 'callback',
      'data', 'result', 'value', 'item', 'self', 'this',
      'print', 'log', 'debug', 'info', 'warn', 'error',
      'true', 'false', 'null', 'undefined', 'None', 'True', 'False',
    ]);
    return NOISY.has(baseName);
  }

  /**
   * @param {object} options
   * @param {string}   options.projectRoot  - Root directory to scan
   * @param {string}   options.outputDir    - Where to write output files
   * @param {string[]} [options.extensions] - File extensions to scan
   * @param {string[]} [options.ignoreDirs] - Directories to skip
   * @param {string[]} [options.scopeDirs]  - Only scan these sub-directories
   * @param {object}   [options.techProfile] - Tech profile from ProjectProfiler
   */
  constructor({
    projectRoot,
    outputDir,
    extensions = ['.js', '.ts', '.cs', '.lua', '.go', '.py', '.dart'],
    ignoreDirs = ['node_modules', '.git', 'build', 'dist', 'output', 'Library', 'Temp', 'obj', 'Packages', '.dart_tool', '.codebuddy', '.cursor', '.claude', '.aider', '.workflow'],
    llmCall        = null,
    scopeDirs      = [],
    techProfile    = null,
    writeLegacyGraph = false,
    // Deprecated options (kept for backward-compat, silently ignored)
    maxFiles: _deprecated_maxFiles,
    useGitignore: _deprecated_useGitignore,
    skipNonCodeDirs: _deprecated_skipNonCodeDirs,
  } = {}) {
    this._root       = projectRoot;
    this._outputDir  = outputDir;
    this._extensions = new Set(extensions);
    this._ignoreDirs = new Set(ignoreDirs);
    this._llmCall    = llmCall;
    this._scopeDirs  = Array.isArray(scopeDirs) ? scopeDirs : [];
    this._techProfile = techProfile;
    this._writeLegacyGraph = !!writeLegacyGraph;

    // IDE-First Architecture (ADR-37) detection
    try {
      const { ideHasSemanticSearch } = require('./ide-detection');
      this._ideSearchAvailable = ideHasSemanticSearch();
      if (this._ideSearchAvailable) {
        console.log(`[CodeGraph] 🏠 IDE semantic search available — CodeGraph operates in fallback mode`);
      }
    } catch (_) {
      this._ideSearchAvailable = false;
    }

    this._warnFileThreshold = 50000;

    // Core data structures
    /** @type {Map<string, SymbolEntry>} symbolId → entry */
    this._symbols = new Map();
    /** @type {Map<string, string[]>} symbolId → list of called symbolIds */
    this._callEdges = new Map();
    /** @type {Map<string, string[]>} filePath → list of imported filePaths */
    this._importEdges = new Map();
    /** @type {Map<string, number>} relPath → mtimeMs */
    this._fileMtimes = new Map();
    this._calledByIndex = null;
    this._importanceWeights = null;
    this._tokenIndex = null;
    this._lspAdapter = null;
    this._lspCache = new Map();
    this._needsFormatUpgrade = false;
    this._upgradePromise = null;

    // P0-Enhancement: Lazy loading state
    this._lazyLoaded = false;
    this._loadingPromise = null;

    // Skip build in IDE environment or if lazy loading is enabled
    if (this._ideSearchAvailable) {
      console.log(`[CodeGraph] ✅ IDE search available - skipping graph initialization (lazy mode)`);
      this._lazyLoaded = true; // Mark as loaded - we don't need to load
    }
  }

  /**
   * Ensures the CodeGraph is loaded before use.
   * P0-Enhancement: Lazy loading support - only builds graph on first access.
   *
   * @param {boolean} [force=false] - Force rebuild even if already loaded
   * @returns {Promise<void>}
   */
  async ensureLoaded(force = false) {
    // If IDE search is available, we don't need to build
    if (this._ideSearchAvailable && !force) {
      return;
    }

    // Already loaded and not forcing rebuild
    if (this._lazyLoaded && !force) {
      return;
    }

    // Loading in progress, wait for it
    if (this._loadingPromise) {
      return this._loadingPromise;
    }

    // Start loading
    this._loadingPromise = this._doLoad();
    try {
      await this._loadingPromise;
      this._lazyLoaded = true;
    } finally {
      this._loadingPromise = null;
    }
  }

  /**
   * @private
   */
  async _doLoad() {
    console.log(`[CodeGraph] 🔄 Lazy loading graph...`);
    const startTime = Date.now();

    try {
      // Try to load from cache first
      const cacheLoaded = await this._tryLoadFromCache();

      if (!cacheLoaded) {
        // Build from scratch
        await this.build();
      }

      const duration = Date.now() - startTime;
      console.log(`[CodeGraph] ✅ Lazy load complete in ${duration}ms (${this._symbols.size} symbols)`);
    } catch (error) {
      console.warn(`[CodeGraph] ⚠️ Lazy load failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Attempts to load graph from cache.
   * @private
   */
  async _tryLoadFromCache() {
    try {
      if (!this._outputDir) return false;

      const cachePath = path.join(this._outputDir, 'code-graph.json');
      if (!fs.existsSync(cachePath)) return false;

      const cached = await this.load();
      return cached && this._symbols.size > 0;
    } catch (_e) {
      return false;
    }
  }}

// ─── Apply Builder Mixin ───────────────────────────────────────────────────────
const { CodeGraphBuilderMixin, NON_CODE_DIRS, WORKER_FILE_THRESHOLD } = require('./code-graph-builder');
Object.assign(CodeGraph.prototype, CodeGraphBuilderMixin);

// ─── Apply Query Mixin ─────────────────────────────────────────────────────────
const { CodeGraphQueryMixin } = require('./code-graph-query');
Object.assign(CodeGraph.prototype, CodeGraphQueryMixin);

// ─── Apply Parser Mixin ─────────────────────────────────────────────────────────
const { CodeGraphParsersMixin, stripCommentsAndStrings } = require('./code-graph-parsers');
Object.assign(CodeGraph.prototype, CodeGraphParsersMixin);

// ─── Apply Analysis Mixin ──────────────────────────────────────────────────────
const { CodeGraphAnalysisMixin } = require('./code-graph-analysis');
Object.assign(CodeGraph.prototype, CodeGraphAnalysisMixin);

// ─── Apply Enrichment Mixin ────────────────────────────────────────────────────
const { CodeGraphEnrichmentMixin } = require('./code-graph-enrichment');
Object.assign(CodeGraph.prototype, CodeGraphEnrichmentMixin);

// ─── Apply Cache Mixin ─────────────────────────────────────────────────────────
const { CodeGraphCacheMixin, setProcessCache } = require('./code-graph-cache');
setProcessCache(_processCache);
Object.assign(CodeGraph.prototype, CodeGraphCacheMixin);

// ─── Static Factory Methods ─────────────────────────────────────────────────────

/**
 * Creates a lazy-loading CodeGraph instance.
 * The graph is not built until first query.
 *
 * @param {object} options - Same as constructor options
 * @returns {CodeGraph} Lazy-loading CodeGraph instance
 */
CodeGraph.createLazy = function(options) {
  const graph = new CodeGraph(options);
  // Do NOT call ensureLoaded() - lazy loading starts here
  return graph;
};

/**
 * Creates and immediately builds a CodeGraph (traditional eager loading).
 * Use this when you know you'll need the graph immediately.
 *
 * @param {object} options - Same as constructor options
 * @returns {Promise<CodeGraph>} Built CodeGraph instance
 */
CodeGraph.createAndBuild = async function(options) {
  const graph = new CodeGraph(options);
  if (!graph._ideSearchAvailable) {
    await graph.ensureLoaded();
  }
  return graph;
};

/**
 * Checks if lazy loading is enabled for this CodeGraph.
 * @returns {boolean}
 */
CodeGraph.prototype.isLazyLoaded = function() {
  return this._lazyLoaded;
};

/**
 * Pre-builds the graph in background without blocking.
 * Useful for warming up cache while other operations run.
 *
 * @returns {Promise<void>}
 */
CodeGraph.prototype.warmup = async function() {
  if (this._ideSearchAvailable) return;
  if (this._lazyLoaded) return;
  if (this._loadingPromise) return;

  // Start background load without awaiting
  this.ensureLoaded().catch(err => {
    console.warn(`[CodeGraph] ⚠️ Warmup failed (non-fatal): ${err.message}`);
  });
};

module.exports = { CodeGraph, SymbolKind };
