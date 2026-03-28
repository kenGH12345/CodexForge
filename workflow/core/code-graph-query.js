/**
 * Code Graph Query – Query Logic Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from code-graph.js.
 * Contains the query methods mixed into CodeGraph.prototype:
 *   - search()              – symbol search by name/keyword
 *   - querySymbol()         – exact/partial name lookup
 *   - querySymbolsAsMarkdown() – Markdown formatted output
 *   - getFileSymbols()      – get symbols in a file
 *   - getCallGraph()        – caller/callee relationships
 *   - _buildQueryResult()   – construct query result object
 *   - _findByName()         – exact name lookup
 *   - _tokenizeText()       – text tokenization for search
 *   - _editDistancePrefix() – fuzzy matching
 *   - _buildTokenIndex()    – inverted index for semantic search
 *   - _enrichSymbol()       – add metadata to symbol
 *
 * This mixin is applied to CodeGraph.prototype via Object.assign.
 *
 * @module code-graph-query
 */

'use strict';

// ─── IDE Symbol Adapter (ADR-37: IDE-First Principle) ─────────────────────────
const { querySymbolWithIDE } = require('./ide-symbol-adapter');

// ─── Stop Words for Search ───────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the', 'to', 'an', 'is', 'in', 'it', 'of', 'on', 'at', 'by', 'or', 'as',
  'be', 'if', 'no', 'do', 'so', 'up', 'for', 'and', 'but', 'not', 'can',
  'has', 'had', 'was', 'are', 'its', 'our', 'use', 'how', 'new', 'all',
  'will', 'from', 'with', 'that', 'this', 'they', 'been', 'have', 'when',
  'what', 'some', 'then', 'than', 'into', 'them', 'also', 'make', 'should',
  'would', 'could', 'where', 'which', 'there', 'their', 'about', 'after',
  'before', 'using', 'support', 'refactor', 'implement', 'change', 'update',
]);

// ─── CodeGraph Query Mixin ───────────────────────────────────────────────────

const CodeGraphQueryMixin = {

  /**
   * Search symbols by name or keyword (case-insensitive substring match).
   * @param {string} query
   * @param {object} [options]
   * @param {string}  [options.kind]    - Filter by SymbolKind
   * @param {string}  [options.file]    - Filter by file path substring
   * @param {number}  [options.limit]   - Max results (default: 20)
   * @returns {SymbolEntry[]}
   */
  search(query, { kind = null, file = null, limit = 20 } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();
    const q = query.toLowerCase();

    // Ensure inverted token index is built
    if (!this._tokenIndex) this._buildTokenIndex();

    const queryTokens = this._tokenizeText(query).filter(t => !STOP_WORDS.has(t));
    const candidateScores = new Map();

    // Phase 1a: Direct substring match candidates (high priority)
    for (const sym of this._symbols.values()) {
      if (kind && sym.kind !== kind) continue;
      if (file && !sym.file.includes(file)) continue;

      const nameLower = sym.name.toLowerCase();
      if (nameLower.includes(q) ||
          sym.summary?.toLowerCase().includes(q) ||
          sym.file.toLowerCase().includes(q)) {
        let score = 100;
        if (nameLower.includes(q)) {
          score = nameLower === q ? 150 : 120;
          if (sym.kind === 'class' || sym.kind === 'interface') score += 10;
        } else if (sym.summary?.toLowerCase().includes(q)) {
          score = 105;
        }
        candidateScores.set(sym.id, score);
      }
    }

    // Phase 1b: Inverted index lookup (Semantic Search)
    if (queryTokens.length > 0) {
      const tokenHits = new Map();

      for (const qt of queryTokens) {
        // Exact token match
        const exactHits = this._tokenIndex.get(qt);
        if (exactHits) {
          for (const symId of exactHits) {
            tokenHits.set(symId, (tokenHits.get(symId) || 0) + 2);
          }
        }

        // Prefix match using sorted token array
        if (qt.length >= 3) {
          if (!this._sortedTokenKeys) {
            this._sortedTokenKeys = [...this._tokenIndex.keys()].sort();
          }
          const sortedKeys = this._sortedTokenKeys;
          let lo = 0, hi = sortedKeys.length - 1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sortedKeys[mid] < qt) lo = mid + 1;
            else hi = mid - 1;
          }
          for (let k = lo; k < sortedKeys.length; k++) {
            const token = sortedKeys[k];
            if (!token.startsWith(qt) && !qt.startsWith(token)) {
              if (token > qt + '\uffff') break;
              continue;
            }
            if (token === qt) continue;
            const symIds = this._tokenIndex.get(token);
            if (symIds) {
              for (const symId of symIds) {
                tokenHits.set(symId, (tokenHits.get(symId) || 0) + 1);
              }
            }
          }
        }
      }

      // TF-IDF-like scoring
      const totalSymbols = this._symbols.size || 1;
      for (const [symId, hitCount] of tokenHits) {
        if (candidateScores.has(symId)) continue;
        const sym = this._symbols.get(symId);
        if (!sym) continue;
        if (kind && sym.kind !== kind) continue;
        if (file && !sym.file.includes(file)) continue;

        const nameTokens = this._tokenizeText(sym.name);
        let nameHits = 0;
        for (const qt of queryTokens) {
          if (nameTokens.some(nt => nt === qt || nt.startsWith(qt) || qt.startsWith(nt))) {
            nameHits++;
          }
        }
        const nameRatio = nameHits / queryTokens.length;
        const nameBoost = nameRatio * 3;

        const maxWeight = queryTokens.length * 2;
        const matchRatio = hitCount / maxWeight;

        let idfSum = 0;
        for (const st of nameTokens) {
          const docFreq = this._tokenIndex.get(st)?.size || 1;
          idfSum += Math.log(totalSymbols / docFreq);
        }
        const idfFactor = Math.min(idfSum / (nameTokens.length || 1), 5);

        const score = matchRatio * (1 + idfFactor * 0.2 + nameBoost);
        const kindBoost = (sym.kind === 'class' || sym.kind === 'interface') ? 1.2 : 1.0;

        if (matchRatio >= 0.25) {
          const finalScore = score * kindBoost * 10;
          const cap = nameHits > 0 ? 115 : 99;
          candidateScores.set(symId, Math.min(finalScore, cap));
        }
      }
    }

    // Phase 2: Fuzzy match fallback
    if (candidateScores.size < limit && q.length >= 3) {
      for (const sym of this._symbols.values()) {
        if (candidateScores.has(sym.id)) continue;
        if (kind && sym.kind !== kind) continue;
        if (file && !sym.file.includes(file)) continue;

        const nameLower = sym.name.toLowerCase();
        const dist = this._editDistancePrefix(q, nameLower);
        if (dist <= 2 && dist < q.length * 0.4) {
          candidateScores.set(sym.id, Math.max(1, 5 - dist));
        }
        if (candidateScores.size >= limit * 3) break;
      }
    }

    // Phase 3: Apply importance weight boost and sort
    const weights = this._computeImportanceWeights();
    const results = [...candidateScores.entries()]
      .map(([id, score]) => {
        const sym = this._symbols.get(id);
        const importanceBoost = 1 + (weights.get(id) || 0) * 0.2;
        return { sym, score: score * importanceBoost };
      })
      .filter(r => r.sym)
      .sort((a, b) => b.score - a.score);

    // Auto-enrich returned symbols
    const final = results.slice(0, limit).map(r => r.sym);
    for (const sym of final) {
      this._enrichSymbol(sym);
    }
    return final;
  },

  /**
   * Query a symbol by exact or partial name.
   * @param {string} symbolName
   * @param {object} [options]
   * @param {boolean} [options.includeCallGraph] - Include caller/callee info
   * @param {boolean} [options.includeFileSymbols] - Include all symbols from same file
   * @returns {object|null}
   */
  /**
   * Query a symbol by exact or partial name.
   * ADR-37 Implementation: IDE-First Principle
   * - Running in IDE → Try view_code_item first, fallback to regex
   * - Standalone mode → Use regex parsing only
   *
   * @param {string} symbolName
   * @param {object} [options]
   * @param {boolean} [options.includeCallGraph] - Include caller/callee info
   * @param {boolean} [options.includeFileSymbols] - Include all symbols from same file
   * @param {boolean} [options.preferIDE] - Force IDE query even in standalone (default: auto-detect)
   * @returns {object|null} Symbol info (sync for regex, async if IDE used)
   */
  querySymbol(symbolName, { includeCallGraph = true, includeFileSymbols = false, preferIDE = null } = {}) {
    if (this._symbols.size === 0) this._loadFromDisk();

    // ADR-37: IDE-First check
    const shouldTryIDE = preferIDE !== null ? preferIDE : this._shouldUseIDE();

    if (shouldTryIDE) {
      // Schedule IDE query and return a thenable for async resolution
      const idePromise = this._querySymbolWithIDEFirst(symbolName, { includeCallGraph, includeFileSymbols });

      // For backward compatibility, return immediate result if available
      const localResult = this._querySymbolLocal(symbolName, includeCallGraph, includeFileSymbols);

      if (localResult) {
        // Enrich local result with IDE data when available
        return {
          ...localResult,
          _ideEnhancement: idePromise,
        };
      }

      // No local result, must wait for IDE
      return idePromise;
    }

    // Standalone mode: use regex only
    return this._querySymbolLocal(symbolName, includeCallGraph, includeFileSymbols);
  },

  /**
   * Check if IDE tools should be used.
   * @private
   * @returns {boolean}
   */
  _shouldUseIDE() {
    if (!this._ideDetection) {
      const { detectIDEEnvironment } = require('./ide-detection');
      this._ideDetection = detectIDEEnvironment();
    }
    return this._ideDetection.isInsideIDE && this._ideDetection.capabilities.viewCodeItem;
  },

  /**
   * Query symbol using IDE's view_code_item (ADR-37).
   * @private
   * @async
   */
  async _querySymbolWithIDEFirst(symbolName, options) {
    const { includeCallGraph, includeFileSymbols } = options;

    try {
      const ideResult = await querySymbolWithIDE(symbolName, null, {
        allowFallback: true,
        timeout: 5000,
      });

      if (ideResult.success && ideResult.data) {
        // Build result from IDE data
        return this._buildIDEResult(ideResult.data, includeCallGraph, includeFileSymbols);
      }

      // IDE failed or returned empty, use local fallback
      console.log(`[CodeGraph] IDE query failed for "${symbolName}", using regex fallback: ${ideResult.error}`);
    } catch (err) {
      console.log(`[CodeGraph] IDE query error for "${symbolName}": ${err.message}`);
    }

    // Fallback to regex
    return this._querySymbolLocal(symbolName, includeCallGraph, includeFileSymbols);
  },

  /**
   * Build symbol result from IDE view_code_item data.
   * @private
   */
  _buildIDEResult(ideData, includeCallGraph, includeFileSymbols) {
    // Convert IDE data to CodeGraph result format
    const symbol = {
      id: ideData.name || 'unknown',
      name: ideData.name || 'unknown',
      kind: ideData.kind || 'unknown',
      file: ideData.file || '',
      line: ideData.line || 1,
      signature: ideData.signature || '',
      summary: '', // IDE doesn't provide doc summary
      body: ideData.body || '',
      source: 'ide', // Mark as IDE-sourced
    };

    return this._buildQueryResult(symbol, includeCallGraph, includeFileSymbols);
  },

  /**
   * Local query using regex-parsed symbols (original implementation).
   * @private
   */
  _querySymbolLocal(symbolName, includeCallGraph, includeFileSymbols) {
    const sym = this._findByName(symbolName);
    if (!sym) {
      const lower = symbolName.toLowerCase();
      for (const s of this._symbols.values()) {
        if (s.name.toLowerCase().includes(lower)) {
          return this._buildQueryResult(s, includeCallGraph, includeFileSymbols);
        }
      }
      return null;
    }
    return this._buildQueryResult(sym, includeCallGraph, includeFileSymbols);
  },

  /**
   * Query symbols and return Markdown formatted output.
   * @param {string} symbolName
   * @param {object} [options]
   * @returns {string|null}
   */
  querySymbolsAsMarkdown(symbolName, options = {}) {
    const result = this.querySymbol(symbolName, options);
    if (!result) return null;

    const lines = [];
    const sym = result.symbol;

    lines.push(`## ${sym.kind}: \`${sym.name}\``);
    lines.push(``);
    lines.push(`- **File**: ${sym.file}:${sym.line}`);
    if (sym.signature) {
      lines.push(`- **Signature**: \`${sym.signature}\``);
    }
    if (sym.summary) {
      lines.push(`- **Summary**: ${sym.summary}`);
    }

    if (result.calls && result.calls.length > 0) {
      lines.push(``);
      lines.push(`### Calls (${result.calls.length})`);
      for (const call of result.calls.slice(0, 10)) {
        lines.push(`- ${call}`);
      }
      if (result.calls.length > 10) {
        lines.push(`- _... and ${result.calls.length - 10} more_`);
      }
    }

    if (result.calledBy && result.calledBy.length > 0) {
      lines.push(``);
      lines.push(`### Called By (${result.calledBy.length})`);
      for (const caller of result.calledBy.slice(0, 10)) {
        lines.push(`- ${caller}`);
      }
      if (result.calledBy.length > 10) {
        lines.push(`- _... and ${result.calledBy.length - 10} more_`);
      }
    }

    if (result.fileSymbols && result.fileSymbols.length > 0) {
      lines.push(``);
      lines.push(`### File Symbols (${result.fileSymbols.length})`);
      for (const fs of result.fileSymbols.slice(0, 10)) {
        lines.push(`- [${fs.kind}] \`${fs.name}\``);
      }
    }

    return lines.join('\n');
  },

  /**
   * Get all symbols defined in a specific file.
   * @param {string} filePath - Relative file path (substring match)
   * @returns {SymbolEntry[]}
   */
  getFileSymbols(filePath) {
    return [...this._symbols.values()].filter(s => s.file.includes(filePath));
  },

  /**
   * Get the call graph for a symbol (who it calls + who calls it).
   *
   * ADR-37 Implementation: Call Hierarchy IDE Routing (P1)
   * - IDE environment with LSP → Use IDE's Call Hierarchy API (compiler-accurate)
   * - Standalone with LSPAdapter → Use self-spawned LSP's Call Hierarchy
   * - No LSP → Use CodeGraph regex fallback (approximate)
   *
   * @param {string} symbolName
   * @param {object} [options]
   * @param {boolean} [options.preferIDE] - Force IDE query (default: auto-detect)
   * @param {string} [options.direction] - 'incoming', 'outgoing', or 'both' (default: 'both')
   * @param {boolean} [options.async] - Return Promise if true (default: false for backward compat)
   * @returns {{ calls: string[], calledBy: string[] } | Promise<{ calls: string[], calledBy: string[] }>}
   */
  getCallGraph(symbolName, options = {}) {
    const { preferIDE = null, direction = 'both', async = false } = options;

    // For backward compatibility: if async explicitly requested or we detect async context
    const shouldUseAsync = async || this._shouldUseAsyncCallGraph();

    if (shouldUseAsync) {
      return this._getCallGraphAsync(symbolName, { preferIDE, direction });
    }

    // Synchronous path (original implementation for immediate needs)
    const sym = this._findByName(symbolName);
    if (!sym) return { calls: [], calledBy: [] };

    const calls = this._callEdges.get(sym.id) || [];
    const calledBy = [];
    for (const [callerId, callees] of this._callEdges) {
      if (callees.includes(sym.id)) calledBy.push(callerId);
    }
    return { calls, calledBy };
  },

  /**
   * Async version of getCallGraph with LSP routing.
   * @private
   */
  async _getCallGraphAsync(symbolName, options) {
    const { preferIDE, direction } = options;

    try {
      // Lazy load LSPRouter
      const { getLSPRouter } = require('./lsp-router');
      const router = getLSPRouter();

      // Set CodeGraph reference if not already set
      if (!router._codeGraph) {
        router.setCodeGraph(this);
      }

      // Route via LSPRouter (will use IDE → LSPAdapter → regex in order)
      const result = await router.getCallHierarchy(symbolName, direction);

      if (result.success) {
        // Convert new format to old format for backward compatibility
        const calls = result.outgoing?.map(c => c.name) || [];
        const calledBy = result.incoming?.map(c => c.name) || [];

        // Log source for transparency
        const sourceLabel = result.source === 'lsp' ? '🔬 LSP' :
                           result.source === 'ide' ? '🏠 IDE' : '📊 Regex';
        const accuracyLabel = result.isAccurate ? '(compiler-accurate)' : '(approximate)';
        console.log(`[CodeGraph] Call Graph for "${symbolName}" via ${sourceLabel} ${accuracyLabel}`);

        return { calls, calledBy, _source: result.source, _isAccurate: result.isAccurate };
      }

      // Router failed – fall back to sync implementation
      console.log(`[CodeGraph] LSPRouter failed for "${symbolName}", using regex fallback`);
    } catch (err) {
      console.log(`[CodeGraph] Async call graph error for "${symbolName}": ${err.message}`);
    }

    // Fallback to sync implementation
    const sym = this._findByName(symbolName);
    if (!sym) return { calls: [], calledBy: [], _source: 'regex', _isAccurate: false };

    const calls = this._callEdges.get(sym.id) || [];
    const calledBy = [];
    for (const [callerId, callees] of this._callEdges) {
      if (callees.includes(sym.id)) calledBy.push(callerId);
    }
    return { calls, calledBy, _source: 'regex', _isAccurate: false };
  },

  /**
   * Check if we should use async call graph (heuristic).
   * @private
   */
  _shouldUseAsyncCallGraph() {
    // Check if we're in an async context or if IDE LSP is available
    const { detectIDEEnvironment } = require('./ide-detection');
    const detection = detectIDEEnvironment();

    // Use async if IDE has callHierarchy capability or if we might use LSPAdapter
    if (detection.isInsideIDE && detection.capabilities.callHierarchy) {
      return true;
    }

    // Don't force async by default for backward compatibility
    return false;
  },

  // ─── Private Helper Methods ────────────────────────────────────────────────

  /**
   * Build query result object.
   * @param {SymbolEntry} sym
   * @param {boolean} includeCallGraph
   * @param {boolean} includeFileSymbols
   * @returns {object}
   */
  _buildQueryResult(sym, includeCallGraph, includeFileSymbols) {
    this._enrichSymbol(sym);

    const result = { symbol: sym, calls: [], calledBy: [] };

    if (includeCallGraph) {
      const callGraph = this.getCallGraph(sym.name);
      result.calls = callGraph.calls;
      result.calledBy = callGraph.calledBy;
    }

    if (includeFileSymbols) {
      result.fileSymbols = this.getFileSymbols(sym.file);
    }

    return result;
  },

  /**
   * Public API: Find symbol by exact name (case-insensitive).
   * Use this instead of calling _findByName() directly from external modules.
   *
   * @param {string} name - Symbol name to look up
   * @returns {SymbolEntry|null}
   */
  findByName(name) {
    return this._findByName(name);
  },

  /**
   * Find symbol by exact name (case-insensitive).
   * @param {string} name
   * @returns {SymbolEntry|null}
   */
  _findByName(name) {
    const lower = name.toLowerCase();
    for (const sym of this._symbols.values()) {
      if (sym.name.toLowerCase() === lower) {
        return sym;
      }
    }
    return null;
  },

  /**
   * Public API: Get a symbol by its unique ID.
   * Use this instead of accessing _symbols.get() directly from external modules.
   *
   * @param {string} symbolId - The unique symbol ID (e.g. 'file.js::functionName')
   * @returns {SymbolEntry|undefined}
   */
  getSymbolById(symbolId) {
    return this._symbols.get(symbolId);
  },

  /**
   * Public API: Get the total number of symbols in the graph.
   * Use this instead of accessing _symbols.size directly from external modules.
   *
   * @returns {number}
   */
  getSymbolCount() {
    return this._symbols.size;
  },

  /**
   * Public API: Get an iterator over all symbol values.
   * Use this instead of accessing _symbols.values() directly from external modules.
   *
   * @returns {IterableIterator<SymbolEntry>}
   */
  getAllSymbolValues() {
    return this._symbols.values();
  },

  /**
   * Tokenize text for search indexing.
   * @param {string} text
   * @returns {string[]}
   */
  _tokenizeText(text) {
    if (!text) return [];
    // CamelCase split + lowercase
    const words = text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]/g, ' ')
      .toLowerCase()
      .match(/\b[a-z][a-z0-9]*\b/g) || [];
    return words;
  },

  /**
   * Compute edit distance prefix match.
   * @param {string} query
   * @param {string} target
   * @returns {number}
   */
  _editDistancePrefix(query, target) {
    const ql = query.length;
    const tl = target.length;
    if (ql === 0) return 0;
    if (tl === 0) return ql;

    // Simple prefix edit distance
    const maxLen = Math.min(ql, tl, 10);
    let dist = 0;
    for (let i = 0; i < maxLen; i++) {
      if (query[i] !== target[i]) dist++;
    }
    return dist;
  },

  /**
   * Build inverted token index for semantic search.
   */
  _buildTokenIndex() {
    this._tokenIndex = new Map();
    this._sortedTokenKeys = null;

    for (const sym of this._symbols.values()) {
      const tokens = this._tokenizeText(sym.name);

      // Add file basename tokens
      const fileBasename = sym.file.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
      const fileTokens = this._tokenizeText(fileBasename);

      const allTokens = [...new Set([...tokens, ...fileTokens])];

      for (const token of allTokens) {
        if (token.length < 2) continue;
        if (!this._tokenIndex.has(token)) {
          this._tokenIndex.set(token, new Set());
        }
        this._tokenIndex.get(token).add(sym.id);
      }
    }
  },

  /**
   * Enrich symbol with additional metadata.
   * @param {SymbolEntry} sym
   */
  _enrichSymbol(sym) {
    // Add computed fields if not present
    if (!sym._enriched) {
      sym._enriched = true;

      // Infer extends/implements from signature
      if (sym.signature) {
        const extendsMatch = sym.signature.match(/\bextends\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (extendsMatch) {
          sym._extends = extendsMatch[1];
        }

        const implementsMatch = sym.signature.match(/\bimplements\s+([A-Za-z_][A-Za-z0-9_]*)/);
        if (implementsMatch) {
          sym._implements = implementsMatch[1];
        }
      }

      // Compute inferred summary if missing
      if (!sym.summary && sym.signature) {
        sym._inferredSummary = sym.signature.slice(0, 100);
      }
    }
  },
};

module.exports = { CodeGraphQueryMixin, STOP_WORDS };
