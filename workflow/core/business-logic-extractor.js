/**
 * Business Logic Extractor
 *
 * Extracts business logic patterns from codebases using IDE-First strategy
 * (leverages CodeGraph when IDE tools are unavailable).
 *
 * Refactored (ADR-41): Split into modular components for maintainability:
 * - extractor-patterns.js: Entry point patterns and classification rules
 * - extractor-renderer.js: Visualization and output formatting
 *
 * @module workflow/core/business-logic-extractor
 */

'use strict';

const path = require('path');

// Import refactored modules
const {
  ENTRY_POINT_PATTERNS,
  NON_ENTRY_PATTERNS,
  LAYER_PATTERNS,
  matchEntryPointPattern,
  determineLayer,
  classifyByCallMetrics,
  calculateImportanceWeight,
  filterNoiseFromChain,
} = require('./extractor-patterns');

const {
  renderMermaidDiagram,
  generateJsonReport,
  generateMarkdownReport,
  writeAnalysisOutput,
  printConsoleSummary,
} = require('./extractor-renderer');

// ─── BusinessLogicExtractor Class ─────────────────────────────────────────────

class BusinessLogicExtractor {
  /**
   * Creates a new BusinessLogicExtractor instance.
   * @param {object} options - Configuration options
   * @param {object} options.codeGraph - CodeGraph instance (fallback)
   * @param {object} options.ideAdapter - IDE adapter instance (primary)
   * @param {object} options.logger - Logger instance
   */
  constructor(options = {}) {
    this.codeGraph = options.codeGraph;
    this.ideAdapter = options.ideAdapter;
    this.logger = options.logger || console;

    // Strategy selection based on ADR-37 (IDE-First)
    this.strategy = this._selectStrategy();
  }

  /**
   * Selects the extraction strategy based on available tools.
   * @private
   */
  _selectStrategy() {
    if (this.ideAdapter?.isAvailable?.()) {
      return 'ide-first';
    }
    if (this.codeGraph) {
      return 'codegraph-fallback';
    }
    return 'file-scan';
  }

  /**
   * Extracts business logic patterns from a project.
   *
   * @param {string} projectRoot - Project root path
   * @param {object} options - Extraction options
   * @returns {Promise<object>} Analysis result
   */
  async extract(projectRoot, options = {}) {
    const startTime = Date.now();
    const root = path.resolve(projectRoot);

    this.logger.info(`Extracting business logic from: ${root}`);
    this.logger.info(`Strategy: ${this.strategy}`);

    let result;

    switch (this.strategy) {
      case 'ide-first':
        result = await this._extractViaIDE(root, options);
        break;
      case 'codegraph-fallback':
        result = await this._extractViaCodeGraph(root, options);
        break;
      default:
        result = await this._extractViaFileScan(root, options);
    }

    // Post-process results
    result.metrics = {
      ...result.metrics,
      extractionMs: Date.now() - startTime,
      strategy: this.strategy,
    };

    return result;
  }

  /**
   * Extracts patterns using IDE adapter (primary strategy).
   * @private
   */
  async _extractViaIDE(root, options) {
    try {
      // Get symbols from IDE
      const symbols = await this.ideAdapter.getSymbols(root, {
        includeDefinitions: true,
        includeReferences: true,
      });

      // Build call graph from IDE data
      const callGraph = await this._buildCallGraphFromIDE(symbols);

      // Identify patterns
      const patterns = this._identifyPatterns(symbols, callGraph);

      // Classify into layers
      const layers = this._classifyLayers(symbols);

      return {
        patterns,
        layers,
        callGraph,
        metrics: {
          filesAnalyzed: new Set(symbols.map(s => s.file)).size,
          symbolsFound: symbols.length,
          callRelations: callGraph.edges.length,
        },
      };
    } catch (error) {
      this.logger.warn('IDE extraction failed, falling back to CodeGraph:', error.message);
      return this._extractViaCodeGraph(root, options);
    }
  }

  /**
   * Extracts patterns using CodeGraph (fallback strategy).
   *
   * P1 Enhancement: Uses LSPRouter for Call Hierarchy when available
   * - IDE environment with Call Hierarchy support → compiler-accurate results
   * - Standalone with LSPAdapter → accurate results if server supports it
   * - No LSP → regex-based approximate results
   *
   * @private
   */
  async _extractViaCodeGraph(root, options) {
    if (!this.codeGraph) {
      return this._extractViaFileScan(root, options);
    }

    try {
      // Load project into CodeGraph
      await this.codeGraph.loadProject(root);

      // Get all functions/methods
      const functions = this.codeGraph.getFunctions();
      const classes = this.codeGraph.getClasses();

      // P1: Build enhanced call graphs using LSPRouter for accuracy
      const { getLSPRouter } = require('./lsp-router');
      const router = getLSPRouter();
      router.setCodeGraph(this.codeGraph);

      // Collect call graphs for hotspot symbols
      const callGraphEdges = [];
      let lspEnhancedCount = 0;
      let regexFallbackCount = 0;

      // Get potential entry points and hotspots
      const allSymbols = [...functions, ...classes];
      const hotspotSymbols = allSymbols
        .filter(s => s.calledBy?.length > 2 || this._getCallCount(s) > 2)
        .slice(0, 50); // Limit to top 50 for performance

      // Build accurate call graphs for hotspots using LSPRouter
      for (const sym of hotspotSymbols) {
        try {
          const cgResult = await this.codeGraph.getCallGraph(sym.name, {
            async: true,
            direction: 'both',
          });

          if (cgResult._source === 'lsp' || cgResult._source === 'ide') {
            lspEnhancedCount++;
          } else {
            regexFallbackCount++;
          }

          // Add edges
          for (const callee of cgResult.calls || []) {
            callGraphEdges.push({ from: sym.id || sym.name, to: callee, type: 'calls' });
          }
          for (const caller of cgResult.calledBy || []) {
            callGraphEdges.push({ from: caller, to: sym.id || sym.name, type: 'calledBy' });
          }
        } catch (cgErr) {
          // Fallback to simple call graph for this symbol
          const simpleCg = this.codeGraph.getCallGraph(sym.name);
          for (const callee of simpleCg.calls || []) {
            callGraphEdges.push({ from: sym.id || sym.name, to: callee, type: 'calls' });
          }
          for (const caller of simpleCg.calledBy || []) {
            callGraphEdges.push({ from: caller, to: sym.id || sym.name, type: 'calledBy' });
          }
          regexFallbackCount++;
        }
      }

      // Build complete call graph for remaining symbols (regex-based)
      const simpleCallGraph = this.codeGraph.getCallGraph();

      // Merge LSP results with simple results
      const callGraph = {
        edges: callGraphEdges,
        nodes: allSymbols.map(s => ({
          id: s.id || s.name,
          name: s.name,
          file: s.file,
          type: s.type,
          calledBy: s.calledBy || [],
          calls: s.calls || [],
        })),
        lspEnhanced: lspEnhancedCount,
        regexFallback: regexFallbackCount,
      };

      // Convert to unified format for pattern identification
      const symbols = allSymbols.map(s => ({
        id: s.id || s.name,
        name: s.name,
        file: s.file,
        type: s.type,
        calledBy: s.calledBy || [],
        calls: s.calls || [],
      }));

      // Identify patterns
      const patterns = this._identifyPatterns(symbols, callGraph);
      const layers = this._classifyLayers(symbols);

      return {
        patterns,
        layers,
        callGraph,
        metrics: {
          filesAnalyzed: new Set(symbols.map(s => s.file)).size,
          symbolsFound: symbols.length,
          callRelations: callGraph.edges.length,
          lspEnhanced: lspEnhancedCount,
          regexFallback: regexFallbackCount,
        },
      };
    } catch (error) {
      this.logger.warn('CodeGraph extraction failed, falling back to file scan:', error.message);
      return this._extractViaFileScan(root, options);
    }
  }

  /**
   * Helper to get total call count for a symbol (calledBy + calls).
   * @private
   */
  _getCallCount(sym) {
    return (sym.calledBy?.length || 0) + (sym.calls?.length || 0);
  }

  /**
   * Extracts patterns using simple file scanning (last resort).
   * @private
   */
  async _extractViaFileScan(root, options) {
    const fs = require('fs');
    const symbols = [];
    const callGraph = { nodes: [], edges: [] };

    // Scan for common patterns in file structure
    const dirs = ['src', 'lib', 'app', 'server', 'api'];
    const foundSymbols = [];

    for (const dir of dirs) {
      const dirPath = path.join(root, dir);
      if (!fs.existsSync(dirPath)) continue;

      // Simple regex-based symbol extraction
      const files = this._scanDirectory(dirPath, options.maxFiles || 100);

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');

          // Extract function definitions
          const funcMatches = content.matchAll(/(?:function\s+([a-zA-Z_][a-zA-Z0-9_]*)|(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:async\s*)?\(|class\s+([a-zA-Z_][a-zA-Z0-9_]*))/g);
          for (const match of funcMatches) {
            const name = match[1] || match[2] || match[3];
            if (name) {
              foundSymbols.push({
                id: `${path.relative(root, file)}:${name}`,
                name,
                file: path.relative(root, file),
                type: match[3] ? 'class' : 'function',
              });
            }
          }
        } catch { /* ignore file read errors */ }
      }
    }

    // Identify patterns from found symbols
    const patterns = this._identifyPatterns(foundSymbols, callGraph);
    const layers = this._classifyLayers(foundSymbols);

    return {
      patterns,
      layers,
      callGraph,
      metrics: {
        filesAnalyzed: new Set(foundSymbols.map(s => s.file)).size,
        symbolsFound: foundSymbols.length,
        callRelations: 0,
      },
    };
  }

  /**
   * Recursively scans a directory for source files.
   * @private
   */
  _scanDirectory(dirPath, maxFiles = 100) {
    const fs = require('fs');
    const files = [];

    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rs', '.rb', '.php'];

    function walk(dir, depth = 0) {
      if (depth > 5 || files.length >= maxFiles) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= maxFiles) break;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'vendor') {
              walk(fullPath, depth + 1);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch { /* ignore */ }
    }

    walk(dirPath);
    return files;
  }

  /**
   * Builds a call graph from IDE symbol data.
   * @private
   */
  async _buildCallGraphFromIDE(symbols) {
    const nodes = [];
    const edges = [];

    for (const sym of symbols) {
      nodes.push({
        id: sym.id || sym.name,
        name: sym.name,
        file: sym.file,
        type: sym.type,
      });

      if (sym.calls) {
        for (const call of sym.calls) {
          edges.push({
            from: sym.id,
            to: call.id || call,
            weight: 1,
          });
        }
      }
    }

    return { nodes, edges };
  }

  /**
   * Identifies business logic patterns from symbols and call graph.
   * @private
   */
  _identifyPatterns(symbols, callGraph) {
    const entryPoints = [];
    const coreServices = [];
    const businessFlows = [];

    // Build call metrics
    const calledByCount = {};
    const callsOutCount = {};

    for (const edge of (callGraph.edges || [])) {
      calledByCount[edge.to] = (calledByCount[edge.to] || 0) + 1;
      callsOutCount[edge.from] = (callsOutCount[edge.from] || 0) + 1;
    }

    for (const sym of symbols) {
      sym.calledByCount = calledByCount[sym.id] || 0;
      sym.callsOutCount = callsOutCount[sym.id] || 0;

      // Check if entry point
      const { isEntryPoint, category } = matchEntryPointPattern(sym.name);
      if (isEntryPoint) {
        sym.isEntry = true;
        sym.category = category;
        sym.layer = determineLayer(sym.name, sym.file);
        entryPoints.push(sym);
      }

      // Check if core service (high centrality)
      const serviceCategory = classifyByCallMetrics(sym.calledByCount, sym.callsOutCount);
      if (serviceCategory === 'foundation' || serviceCategory === 'hub') {
        sym.serviceCategory = serviceCategory;
        coreServices.push(sym);
      }
    }

    // Build business flows from call chains
    const visited = new Set();
    for (const entry of entryPoints.slice(0, 10)) {
      const chain = this._traceCallChain(entry, callGraph, visited, 5);
      if (chain.length >= 2) {
        businessFlows.push({
          name: entry.name,
          entry: entry.id,
          chain: filterNoiseFromChain(chain),
        });
      }
    }

    return { entryPoints, coreServices, businessFlows };
  }

  /**
   * Traces a call chain from an entry point.
   * @private
   */
  _traceCallChain(symbol, callGraph, visited, maxDepth = 5) {
    const chain = [symbol.name];
    visited.add(symbol.id);

    const edges = (callGraph.edges || []).filter(e => e.from === symbol.id);
    if (edges.length === 0 || maxDepth <= 0) return chain;

    // Follow the most important outgoing call
    const nextSymbol = edges
      .map(e => {
        const node = (callGraph.nodes || []).find(n => n.id === e.to);
        return node ? { ...node, weight: calculateImportanceWeight(node) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.weight - a.weight)[0];

    if (nextSymbol && !visited.has(nextSymbol.id)) {
      chain.push(...this._traceCallChain(nextSymbol, callGraph, visited, maxDepth - 1));
    }

    return chain;
  }

  /**
   * Classifies symbols into architectural layers.
   * @private
   */
  _classifyLayers(symbols) {
    const layers = {
      controller: [],
      service: [],
      repository: [],
      model: [],
      util: [],
      unknown: [],
    };

    for (const sym of symbols) {
      const layer = determineLayer(sym.name, sym.file);
      layers[layer].push(sym);
    }

    return layers;
  }
}

// ─── Convenience Functions ────────────────────────────────────────────────────

/**
 * Quick extraction - returns summary.
 * @param {string} projectRoot - Project root path
 * @param {object} options - Extraction options
 * @returns {Promise<object>} Analysis result
 */
async function quickExtract(projectRoot, options = {}) {
  const extractor = new BusinessLogicExtractor(options);
  return extractor.extract(projectRoot, options);
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Main class
  BusinessLogicExtractor,

  // Convenience function
  quickExtract,

  // Pattern utilities (re-exported)
  ENTRY_POINT_PATTERNS,
  NON_ENTRY_PATTERNS,
  LAYER_PATTERNS,
  matchEntryPointPattern,
  determineLayer,
  classifyByCallMetrics,
  calculateImportanceWeight,
  filterNoiseFromChain,

  // Rendering utilities (re-exported)
  renderMermaidDiagram,
  generateJsonReport,
  generateMarkdownReport,
  writeAnalysisOutput,
  printConsoleSummary,
};
