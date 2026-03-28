/**
 * Code Graph – Facade Module (ADR-33 P0 Decomposition)
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
    ignoreDirs = ['node_modules', '.git', 'build', 'dist', 'output', 'Library', 'Temp', 'obj', 'Packages', '.dart_tool'],
    llmCall        = null,
    scopeDirs      = [],
    techProfile    = null,
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
  }
}

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

module.exports = { CodeGraph, SymbolKind };
