/**
 * LSP Router – Centralized LSP Capability Routing
 *
 * ADR-37 Implementation: Unified routing layer for all LSP-related operations.
 * Centralizes the "IDE vs Self-Built" decision logic per ADR-37:
 *   - IDE environment → Prefer IDE native LSP APIs
 *   - Standalone mode → Use LSPAdapter (self-spawned language servers)
 *
 * Responsibilities:
 *   1. Route Definition requests (Go to Definition)
 *   2. Route Reference requests (Find References)
 *   3. Route Call Hierarchy requests (Incoming/Outgoing Calls)
 *   4. Route Hover/Type Info requests
 *   5. Centralize fallback logic (IDE → LSPAdapter → CodeGraph regex)
 *
 * Architecture:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                    LSPRouter                                 │
 *   │  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐   │
 *   │  │  IDE Routes  │  │ LSPAdapter   │  │  CodeGraph      │   │
 *   │  │ (IDE LSP)    │  │ (Self-spawned)│  │ (Regex Fallback)│   │
 *   │  └──────────────┘  └──────────────┘  └─────────────────┘   │
 *   │                                                            │
 *   │  Route Decision:                                           │
 *   │    1. IDE available + capability supported → IDE           │
 *   │    2. IDE available but capability blocked → LSPAdapter    │
 *   │    3. Standalone → LSPAdapter                              │
 *   │    4. LSPAdapter failed → CodeGraph regex fallback         │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * @module lsp-router
 * @see ADR-37: IDE-First Principle
 */

'use strict';

const { detectIDEEnvironment } = require('./ide-detection');
const { querySymbolWithIDE } = require('./ide-symbol-adapter');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Timeout for LSP operations (ms) */
const DEFAULT_TIMEOUT = 10000;

/** Max retries for transient failures */
const MAX_RETRIES = 2;

// ─── LSP Router State ───────────────────────────────────────────────────────

class LSPRouter {
  constructor(options = {}) {
    this.options = {
      timeout: options.timeout || DEFAULT_TIMEOUT,
      maxRetries: options.maxRetries || MAX_RETRIES,
      preferIDE: options.preferIDE !== false, // Default: true (ADR-37)
      ...options,
    };

    this._ideDetection = null;
    this._lspAdapter = null;
    this._codeGraph = null;

    // Cache IDE detection result
    this._refreshIDEDetection();
  }

  /**
   * Set the LSPAdapter instance (for self-spawned LSP mode).
   * @param {LSPAdapter} adapter
   */
  setLSPAdapter(adapter) {
    this._lspAdapter = adapter;
  }

  /**
   * Set the CodeGraph instance (for regex fallback).
   * @param {CodeGraph} codeGraph
   */
  setCodeGraph(codeGraph) {
    this._codeGraph = codeGraph;
  }

  /**
   * Refresh IDE environment detection.
   * Call this when IDE context might have changed.
   */
  _refreshIDEDetection() {
    this._ideDetection = detectIDEEnvironment();
  }

  // ─── Core Routing Methods ─────────────────────────────────────────────────

  /**
   * Route a "Go to Definition" request.
   * Priority: IDE LSP → LSPAdapter → CodeGraph regex
   *
   * @param {string} symbolName - Symbol to find definition for
   * @param {string} [filePath] - Optional file path hint
   * @param {number} [line] - Optional line number (1-based)
   * @param {number} [column] - Optional column number
   * @returns {Promise<{success: boolean, locations: Array, source: string, error?: string}>}
   */
  async gotoDefinition(symbolName, filePath = null, line = null, column = null) {
    const routeDecision = this._decideRoute('definition');

    switch (routeDecision) {
      case 'ide':
        return this._gotoDefinitionViaIDE(symbolName, filePath);
      case 'lsp':
        return this._gotoDefinitionViaLSP(symbolName, filePath, line, column);
      case 'regex':
      default:
        return this._gotoDefinitionViaRegex(symbolName);
    }
  }

  /**
   * Route a "Find References" request.
   * Priority: IDE LSP → LSPAdapter → CodeGraph regex
   *
   * @param {string} symbolName - Symbol to find references for
   * @param {string} [filePath] - Optional file path hint
   * @param {number} [line] - Optional line number (1-based)
   * @param {number} [column] - Optional column number
   * @returns {Promise<{success: boolean, references: Array, source: string, error?: string}>}
   */
  async findReferences(symbolName, filePath = null, line = null, column = null) {
    const routeDecision = this._decideRoute('references');

    switch (routeDecision) {
      case 'ide':
        return this._findReferencesViaIDE(symbolName, filePath);
      case 'lsp':
        return this._findReferencesViaLSP(symbolName, filePath, line, column);
      case 'regex':
      default:
        return this._findReferencesViaRegex(symbolName);
    }
  }

  /**
   * Route a "Call Hierarchy" request.
   * Priority: IDE LSP → LSPAdapter → CodeGraph regex (⚠️ 当前实现)
   *
   * @param {string} symbolName - Symbol to get call hierarchy for
   * @param {string} [direction='both'] - 'incoming', 'outgoing', or 'both'
   * @param {string} [filePath] - Optional file path hint
   * @param {number} [line] - Optional line number (1-based)
   * @returns {Promise<{success: boolean, incoming: Array, outgoing: Array, source: string, error?: string}>}
   */
  async getCallHierarchy(symbolName, direction = 'both', filePath = null, line = null) {
    const routeDecision = this._decideRoute('callHierarchy');

    switch (routeDecision) {
      case 'ide':
        return this._callHierarchyViaIDE(symbolName, direction, filePath);
      case 'lsp':
        return this._callHierarchyViaLSP(symbolName, direction, filePath, line);
      case 'regex':
      default:
        return this._callHierarchyViaRegex(symbolName);
    }
  }

  /**
   * Route a "Hover/Type Info" request.
   * Priority: IDE LSP → LSPAdapter → CodeGraph cache
   *
   * @param {string} symbolName - Symbol to get hover info for
   * @param {string} [filePath] - Optional file path hint
   * @param {number} [line] - Optional line number (1-based)
   * @param {number} [column] - Optional column number
   * @returns {Promise<{success: boolean, hover: object, source: string, error?: string}>}
   */
  async getHover(symbolName, filePath = null, line = null, column = null) {
    const routeDecision = this._decideRoute('hover');

    switch (routeDecision) {
      case 'ide':
        return this._hoverViaIDE(symbolName, filePath);
      case 'lsp':
        return this._hoverViaLSP(symbolName, filePath, line, column);
      case 'regex':
      default:
        return this._hoverViaRegex(symbolName);
    }
  }

  // ─── Route Decision Logic ─────────────────────────────────────────────────

  /**
   * Decide which route to use for a given LSP capability.
   * ADR-37 Core Implementation: IDE-First decision logic.
   *
   * @private
   * @param {string} capability - LSP capability name
   * @returns {('ide'|'lsp'|'regex')} Route to use
   */
  _decideRoute(capability) {
    // Refresh detection in case IDE context changed
    this._refreshIDEDetection();

    // Step 1: Check if IDE environment is available
    if (!this._ideDetection.isInsideIDE) {
      console.log(`[LSPRouter] Standalone mode – no IDE detected.`);

      // Check if LSPAdapter is available
      if (this._lspAdapter && this._lspAdapter._connected) {
        console.log(`[LSPRouter] Using LSPAdapter for ${capability}.`);
        return 'lsp';
      }

      console.log(`[LSPRouter] Using regex fallback for ${capability}.`);
      return 'regex';
    }

    // Step 2: IDE available – check if capability is supported
    const ideCapabilityMap = {
      definition: 'goToDefinition',
      references: 'findReferences',
      callHierarchy: 'callHierarchy',
      hover: 'hover',
    };

    const ideCapName = ideCapabilityMap[capability];
    const ideSupports = this._ideDetection.capabilities[ideCapName];

    if (ideSupports === true) {
      console.log(`[LSPRouter] IDE available with ${capability} support – routing to IDE.`);
      return 'ide';
    }

    if (ideSupports === false) {
      console.log(`[LSPRouter] IDE available but ${capability} not supported (e.g., Claude Code) – checking LSPAdapter.`);

      if (this._lspAdapter && this._lspAdapter._connected) {
        console.log(`[LSPRouter] LSPAdapter available for ${capability}.`);
        return 'lsp';
      }

      console.log(`[LSPRouter] Using regex fallback for ${capability}.`);
      return 'regex';
    }

    // Capability unknown – conservative fallback to LSPAdapter
    console.log(`[LSPRouter] IDE capability ${capability} unknown – trying LSPAdapter.`);

    if (this._lspAdapter && this._lspAdapter._connected) {
      return 'lsp';
    }

    return 'regex';
  }

  // ─── IDE Route Implementations ────────────────────────────────────────────

  /**
   * Go to Definition via IDE API.
   * Uses IDE's built-in LSP (most accurate).
   */
  async _gotoDefinitionViaIDE(symbolName, filePath) {
    try {
      // Use view_code_item to get symbol location
      const ideResult = await querySymbolWithIDE(symbolName, filePath, {
        timeout: this.options.timeout,
        allowFallback: true,
      });

      if (ideResult.success && ideResult.data.file) {
        // Got location, now this is the definition
        return {
          success: true,
          locations: [{
            file: ideResult.data.file,
            line: ideResult.data.line || 1,
            column: 0,
            symbol: ideResult.data.name,
            kind: ideResult.data.kind,
          }],
          source: 'ide',
        };
      }

      // IDE query failed – cascade to LSPAdapter
      console.log(`[LSPRouter] IDE definition failed for ${symbolName}, trying LSPAdapter...`);
      return this._gotoDefinitionViaLSP(symbolName, filePath);
    } catch (err) {
      console.log(`[LSPRouter] IDE definition error for ${symbolName}: ${err.message}`);
      return this._gotoDefinitionViaLSP(symbolName, filePath);
    }
  }

  /**
   * Find References via IDE API.
   */
  async _findReferencesViaIDE(symbolName, filePath) {
    // Note: Most IDEs don't expose findReferences directly via tool
    // This would require MCP server integration (future enhancement)
    console.log(`[LSPRouter] IDE findReferences for ${symbolName} - using LSPAdapter cascade`);
    return this._findReferencesViaLSP(symbolName, filePath);
  }

  /**
   * Call Hierarchy via IDE API.
   */
  async _callHierarchyViaIDE(symbolName, direction, filePath) {
    // This is the key enhancement for P1
    // Most modern IDEs (Cursor, VS Code, Windsurf) support Call Hierarchy via LSP
    // However, they typically don't expose it via tools directly

    // Strategy: Use view_code_item to get location, then use IDE's internal LSP
    // For now, cascade to LSPAdapter which can use actual LSP callHierarchy
    console.log(`[LSPRouter] IDE callHierarchy for ${symbolName} - using LSPAdapter cascade`);
    return this._callHierarchyViaLSP(symbolName, direction, filePath);
  }

  /**
   * Hover via IDE API.
   */
  async _hoverViaIDE(symbolName, filePath) {
    try {
      const ideResult = await querySymbolWithIDE(symbolName, filePath, {
        timeout: this.options.timeout,
        allowFallback: true,
      });

      if (ideResult.success && ideResult.data) {
        return {
          success: true,
          hover: {
            signature: ideResult.data.signature,
            body: ideResult.data.body,
            kind: ideResult.data.kind,
          },
          source: 'ide',
        };
      }

      return this._hoverViaLSP(symbolName, filePath);
    } catch (err) {
      return this._hoverViaLSP(symbolName, filePath);
    }
  }

  // ─── LSPAdapter Route Implementations ─────────────────────────────────────

  /**
   * Go to Definition via LSPAdapter.
   */
  async _gotoDefinitionViaLSP(symbolName, filePath, line, column) {
    if (!this._lspAdapter || !this._lspAdapter._connected) {
      return this._gotoDefinitionViaRegex(symbolName);
    }

    try {
      // Need location – try to get from CodeGraph first
      const location = await this._resolveSymbolLocation(symbolName, filePath, line, column);
      if (!location) {
        return this._gotoDefinitionViaRegex(symbolName);
      }

      const defs = await this._lspAdapter.gotoDefinition(
        location.file,
        location.line - 1, // LSP uses 0-based
        location.column
      );

      if (defs && defs.length > 0) {
        return {
          success: true,
          locations: defs.map(d => ({
            file: d.filePath,
            line: d.range ? d.range.start.line + 1 : 1,
            column: d.range ? d.range.start.character : 0,
          })),
          source: 'lsp',
        };
      }

      return this._gotoDefinitionViaRegex(symbolName);
    } catch (err) {
      console.log(`[LSPRouter] LSP definition error for ${symbolName}: ${err.message}`);
      return this._gotoDefinitionViaRegex(symbolName);
    }
  }

  /**
   * Find References via LSPAdapter.
   */
  async _findReferencesViaLSP(symbolName, filePath, line, column) {
    if (!this._lspAdapter || !this._lspAdapter._connected) {
      return this._findReferencesViaRegex(symbolName);
    }

    try {
      const location = await this._resolveSymbolLocation(symbolName, filePath, line, column);
      if (!location) {
        return this._findReferencesViaRegex(symbolName);
      }

      const refs = await this._lspAdapter.findReferences(
        location.file,
        location.line - 1,
        location.column
      );

      if (refs && refs.length > 0) {
        return {
          success: true,
          references: refs.map(r => ({
            file: r.filePath,
            line: r.range ? r.range.start.line + 1 : 1,
            column: r.range ? r.range.start.character : 0,
          })),
          source: 'lsp',
        };
      }

      return this._findReferencesViaRegex(symbolName);
    } catch (err) {
      console.log(`[LSPRouter] LSP references error for ${symbolName}: ${err.message}`);
      return this._findReferencesViaRegex(symbolName);
    }
  }

  /**
   * Call Hierarchy via LSPAdapter.
   * This is the key P1 implementation enhancement.
   */
  async _callHierarchyViaLSP(symbolName, direction, filePath, line, column) {
    if (!this._lspAdapter || !this._lspAdapter._connected) {
      console.log(`[LSPRouter] LSPAdapter not available for callHierarchy, using regex fallback`);
      return this._callHierarchyViaRegex(symbolName);
    }

    // Check if LSP server supports callHierarchy
    const supportsCallHierarchy = this._lspAdapter.serverCapabilities?.
      callHierarchyProvider === true;

    if (!supportsCallHierarchy) {
      console.log(`[LSPRouter] LSP server doesn't support callHierarchy, using regex fallback`);
      return this._callHierarchyViaRegex(symbolName);
    }

    try {
      const location = await this._resolveSymbolLocation(symbolName, filePath, line, column);
      if (!location) {
        console.log(`[LSPRouter] Could not resolve location for ${symbolName}, using regex fallback`);
        return this._callHierarchyViaRegex(symbolName);
      }

      // Prepare call hierarchy params
      const absPath = location.file; // LSPAdapter _toUri handles path resolution

      // Call LSP callHierarchy/incomingCalls and callHierarchy/outgoingCalls
      const incoming = [];
      const outgoing = [];

      if (direction === 'incoming' || direction === 'both') {
        try {
          const incomingResult = await this._lspAdapter._sendRequest(
            'callHierarchy/incomingCalls',
            {
              item: {
                name: symbolName,
                kind: 12, // Function
                uri: this._lspAdapter._toUri(absPath),
                range: {
                  start: { line: location.line - 1, character: location.column },
                  end: { line: location.line - 1, character: location.column + symbolName.length },
                },
                selectionRange: {
                  start: { line: location.line - 1, character: location.column },
                  end: { line: location.line - 1, character: location.column + symbolName.length },
                },
              },
            }
          );

          if (incomingResult && Array.isArray(incomingResult)) {
            incoming.push(...incomingResult.map(item => ({
              name: item.from?.name || 'unknown',
              file: item.from?.uri ? this._lspAdapter._fromUri(item.from.uri) : absPath,
              line: item.from?.range?.start?.line + 1 || 0,
              kind: item.from?.kind,
            })));
          }
        } catch (incomingErr) {
          console.log(`[LSPRouter] LSP incoming calls error: ${incomingErr.message}`);
        }
      }

      if (direction === 'outgoing' || direction === 'both') {
        try {
          // First prepare call hierarchy item
          const hierarchyItem = await this._lspAdapter._sendRequest(
            'textDocument/prepareCallHierarchy',
            {
              textDocument: { uri: this._lspAdapter._toUri(absPath) },
              position: { line: location.line - 1, character: location.column },
            }
          );

          if (hierarchyItem && Array.isArray(hierarchyItem) && hierarchyItem.length > 0) {
            const outgoingResult = await this._lspAdapter._sendRequest(
              'callHierarchy/outgoingCalls',
              { item: hierarchyItem[0] }
            );

            if (outgoingResult && Array.isArray(outgoingResult)) {
              outgoing.push(...outgoingResult.map(item => ({
                name: item.to?.name || 'unknown',
                file: item.to?.uri ? this._lspAdapter._fromUri(item.to.uri) : absPath,
                line: item.to?.range?.start?.line + 1 || 0,
                kind: item.to?.kind,
              })));
            }
          }
        } catch (outgoingErr) {
          console.log(`[LSPRouter] LSP outgoing calls error: ${outgoingErr.message}`);
        }
      }

      // If we got results, return them; otherwise fallback
      if (incoming.length > 0 || outgoing.length > 0) {
        console.log(`[LSPRouter] LSP callHierarchy success: ${incoming.length} incoming, ${outgoing.length} outgoing`);
        return {
          success: true,
          incoming,
          outgoing,
          source: 'lsp',
          isAccurate: true,
        };
      }

      console.log(`[LSPRouter] LSP callHierarchy returned empty, using regex fallback`);
      return this._callHierarchyViaRegex(symbolName);
    } catch (err) {
      console.log(`[LSPRouter] LSP callHierarchy error for ${symbolName}: ${err.message}`);
      return this._callHierarchyViaRegex(symbolName);
    }
  }

  /**
   * Hover via LSPAdapter.
   */
  async _hoverViaLSP(symbolName, filePath, line, column) {
    if (!this._lspAdapter || !this._lspAdapter._connected) {
      return this._hoverViaRegex(symbolName);
    }

    try {
      const location = await this._resolveSymbolLocation(symbolName, filePath, line, column);
      if (!location) {
        return this._hoverViaRegex(symbolName);
      }

      const hover = await this._lspAdapter.getHover(
        location.file,
        location.line - 1,
        location.column
      );

      if (hover && hover.contents) {
        return {
          success: true,
          hover: {
            contents: hover.contents,
            range: hover.range,
          },
          source: 'lsp',
        };
      }

      return this._hoverViaRegex(symbolName);
    } catch (err) {
      console.log(`[LSPRouter] LSP hover error for ${symbolName}: ${err.message}`);
      return this._hoverViaRegex(symbolName);
    }
  }

  // ─── Regex Fallback Implementations ───────────────────────────────────────

  /**
   * Go to Definition via CodeGraph regex (fallback).
   */
  _gotoDefinitionViaRegex(symbolName) {
    if (!this._codeGraph) {
      return {
        success: false,
        locations: [],
        source: 'regex',
        error: 'No CodeGraph available for regex fallback',
      };
    }

    // Use CodeGraph's _findByName
    const sym = this._codeGraph.findByName(symbolName);
    if (sym) {
      return {
        success: true,
        locations: [{
          file: sym.file,
          line: sym.line,
          column: 0,
          symbol: sym.name,
          kind: sym.kind,
        }],
        source: 'regex',
      };
    }

    // Try fuzzy match via public API (replaces direct _symbols.values() access)
    for (const s of this._codeGraph.getAllSymbolValues()) {
      if (s.name.toLowerCase().includes(symbolName.toLowerCase())) {
        return {
          success: true,
          locations: [{
            file: s.file,
            line: s.line,
            column: 0,
            symbol: s.name,
            kind: s.kind,
          }],
          source: 'regex',
          approximate: true,
        };
      }
    }

    return {
      success: false,
      locations: [],
      source: 'regex',
      error: `Symbol ${symbolName} not found in CodeGraph`,
    };
  }

  /**
   * Find References via CodeGraph regex (fallback).
   */
  _findReferencesViaRegex(symbolName) {
    if (!this._codeGraph) {
      return {
        success: false,
        references: [],
        source: 'regex',
        error: 'No CodeGraph available for regex fallback',
      };
    }

    // Find the symbol first
    let targetSym = this._codeGraph.findByName(symbolName);
    if (!targetSym) {
      // Try fuzzy via public API (replaces direct _symbols.values() access)
      for (const s of this._codeGraph.getAllSymbolValues()) {
        if (s.name.toLowerCase().includes(symbolName.toLowerCase())) {
          targetSym = s;
          break;
        }
      }
    }

    if (!targetSym) {
      return {
        success: false,
        references: [],
        source: 'regex',
        error: `Symbol ${symbolName} not found in CodeGraph`,
      };
    }

    // Get call graph to find who calls this symbol
    const callGraph = this._codeGraph.getCallGraph(symbolName);
    // Use public API getSymbolById() instead of direct _symbols.get() access
    const references = [
      ...callGraph.calledBy.map(callerId => {
        const sym = this._codeGraph.getSymbolById(callerId);
        return {
          name: callerId,
          file: sym?.file || 'unknown',
          line: sym?.line || 0,
          type: 'calledBy',
        };
      }),
    ];

    return {
      success: true,
      references,
      source: 'regex',
      approximate: true,
    };
  }

  /**
   * Call Hierarchy via CodeGraph regex (fallback).
   * This is the original implementation, now encapsulated here.
   */
  _callHierarchyViaRegex(symbolName) {
    if (!this._codeGraph) {
      return {
        success: false,
        incoming: [],
        outgoing: [],
        source: 'regex',
        error: 'No CodeGraph available for regex fallback',
      };
    }

    // Use CodeGraph's getCallGraph
    const callGraph = this._codeGraph.getCallGraph(symbolName);

    // Convert to new format
    // Use public API getSymbolById() instead of direct _symbols.get() access
    const incoming = (callGraph.calledBy || []).map(callerId => {
      const caller = this._codeGraph.getSymbolById(callerId);
      return {
        name: caller?.name || callerId,
        file: caller?.file || 'unknown',
        line: caller?.line || 0,
        kind: caller?.kind,
      };
    });

    const outgoing = (callGraph.calls || []).map(calleeId => {
      const callee = this._codeGraph.getSymbolById(calleeId);
      return {
        name: callee?.name || calleeId,
        file: callee?.file || 'unknown',
        line: callee?.line || 0,
        kind: callee?.kind,
      };
    });

    return {
      success: true,
      incoming,
      outgoing,
      source: 'regex',
      isAccurate: false,
      note: 'Results are approximate based on regex parsing. For accurate call hierarchy, enable LSP.',
    };
  }

  /**
   * Hover via CodeGraph cache (fallback).
   */
  _hoverViaRegex(symbolName) {
    if (!this._codeGraph) {
      return {
        success: false,
        hover: null,
        source: 'regex',
        error: 'No CodeGraph available for regex fallback',
      };
    }

    const sym = this._codeGraph.findByName(symbolName);
    if (sym) {
      return {
        success: true,
        hover: {
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          summary: sym.summary,
          file: sym.file,
          line: sym.line,
        },
        source: 'regex',
      };
    }

    return {
      success: false,
      hover: null,
      source: 'regex',
      error: `Symbol ${symbolName} not found in CodeGraph`,
    };
  }

  // ─── Utility Methods ──────────────────────────────────────────────────────

  /**
   * Resolve symbol location from various input formats.
   * @private
   */
  async _resolveSymbolLocation(symbolName, filePath, line, column) {
    // If full location provided, use it
    if (filePath && typeof line === 'number') {
      return { file: filePath, line, column: column || 0 };
    }

    // Try to find via CodeGraph
    if (this._codeGraph) {
      const sym = this._codeGraph.findByName(symbolName);
      if (sym) {
        return { file: sym.file, line: sym.line, column: 0 };
      }

      // Try IDE view_code_item
      try {
        const ideResult = await querySymbolWithIDE(symbolName, filePath, {
          timeout: 5000,
          allowFallback: true,
        });

        if (ideResult.success && ideResult.data.file) {
          return { file: ideResult.data.file, line: ideResult.data.line || 1, column: 0 };
        }
      } catch (_) {
        // Ignore IDE errors
      }
    }

    return null;
  }

  /**
   * Get current routing statistics.
   * Useful for debugging and monitoring.
   */
  getStats() {
    return {
      isInsideIDE: this._ideDetection.isInsideIDE,
      ideCapabilities: this._ideDetection.capabilities,
      lspAdapterConnected: this._lspAdapter?._connected || false,
      lspAdapterSkipped: this._lspAdapter?._skippedForIDE || false,
      codeGraphAvailable: !!this._codeGraph,
      options: { ...this.options },
    };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

let _routerInstance = null;

/**
 * Get or create the singleton LSPRouter instance.
 * @param {object} options
 * @returns {LSPRouter}
 */
function getLSPRouter(options = {}) {
  if (!_routerInstance) {
    _routerInstance = new LSPRouter(options);
  }
  return _routerInstance;
}

/**
 * Reset the singleton instance (useful for testing).
 */
function resetLSPRouter() {
  _routerInstance = null;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  LSPRouter,
  getLSPRouter,
  resetLSPRouter,
  DEFAULT_TIMEOUT,
  MAX_RETRIES,
};