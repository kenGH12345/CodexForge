/**
 * IDE Symbol Adapter – Bridge between CodeGraph and IDE's view_code_item
 *
 * ADR-37 实施：运行时优先使用 IDE 原生工具 (view_code_item)，
 * 失败时回退到 CodeGraph 的 regex 解析。
 *
 * @module ide-symbol-adapter
 * @see ADR-37: IDE-First Principle
 */

'use strict';

const { ideHasGoToDefinition, detectIDEEnvironment } = require('./ide-detection');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Timeout for IDE tool calls (ms) */
const VIEW_CODE_ITEM_TIMEOUT = 5000;

/** Max retries for transient failures */
const MAX_RETRIES = 2;

// ─── Mock view_code_item for testing (will be replaced by actual tool call) ───
let viewCodeItemTool = null;

/**
 * Set the view_code_item tool function.
 * This is called by the orchestrator when initializing.
 * @param {Function} toolFn - Function matching view_code_item signature
 */
function setViewCodeItemTool(toolFn) {
  viewCodeItemTool = toolFn;
}

// ─── Main Adapter Function ──────────────────────────────────────────────────

/**
 * Query symbol information using IDE's view_code_item tool.
 * ADR-37 compliance: IDE-first, self-built fallback.
 *
 * @param {string} symbolName - The symbol to query (e.g., "parseCodeFileForDependencies")
 * @param {string} [filePath] - Optional file path hint to narrow search
 * @param {object} [options]
 * @param {number} [options.timeout] - Custom timeout in ms
 * @param {boolean} [options.allowFallback] - Allow regex fallback on failure (default: true)
 * @returns {Promise<{ success: boolean, data?: object, error?: string, source: 'ide'|'regex' }>}
 */
async function querySymbolWithIDE(symbolName, filePath = null, options = {}) {
  const { timeout = VIEW_CODE_ITEM_TIMEOUT, allowFallback = true } = options;

  // Check if we're in IDE environment
  const ideDetection = detectIDEEnvironment();
  if (!ideDetection.isInsideIDE || !ideDetection.capabilities.viewCodeItem) {
    return {
      success: false,
      error: 'Not running in IDE or view_code_item unavailable',
      source: 'ide',
      fallback: allowFallback,
    };
  }

  // No tool function injected yet
  if (!viewCodeItemTool) {
    return {
      success: false,
      error: 'view_code_item tool not initialized',
      source: 'ide',
      fallback: allowFallback,
    };
  }

  // Attempt IDE tool call with retry logic
  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await Promise.race([
        viewCodeItemTool({
          symbolName,
          filePath,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), timeout)
        ),
      ]);

      if (result && result.content) {
        return {
          success: true,
          data: parseIDEResult(result.content),
          source: 'ide',
          raw: result,
        };
      }
    } catch (err) {
      lastError = err;
      // Exponential backoff
      if (attempt < MAX_RETRIES - 1) {
        await sleep(100 * Math.pow(2, attempt));
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || 'IDE tool call failed',
    source: 'ide',
    fallback: allowFallback,
  };
}

// ─── Result Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse IDE view_code_item result into CodeGraph-compatible format.
 * @param {string} content - Raw result from view_code_item
 * @returns {object} Normalized symbol info
 */
function parseIDEResult(content) {
  // view_code_item returns source code of the symbol
  // We'll extract basic metadata
  const lines = content.split('\n');
  const firstLine = lines[0] || '';

  // Try to extract symbol kind and name from first line
  const patterns = [
    // JavaScript/TypeScript: class, function, const, etc.
    { regex: /^(?:export\s+)?(?:class|interface)\s+(\w+)/, kind: 'class' },
    { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function' },
    { regex: /^(?:export\s+)?(?:const|let|var)\s+(\w+)/, kind: 'variable' },
    // C#
    { regex: /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|interface|struct|enum)\s+(\w+)/, kind: 'class' },
    { regex: /^(?:public|private|protected|internal)\s+(?:static\s+)?(?:override\s+)?(?:virtual\s+)?(?:async\s+)?[\w<>\[\]]+\s+(\w+)\s*\(/, kind: 'method' },
    // Python
    { regex: /^class\s+(\w+)/, kind: 'class' },
    { regex: /^(?:async\s+)?def\s+(\w+)/, kind: 'function' },
    // Go
    { regex: /^type\s+(\w+)\s+(?:struct|interface)/, kind: 'class' },
    { regex: /^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, kind: 'function' },
  ];

  for (const { regex, kind } of patterns) {
    const match = firstLine.match(regex);
    if (match) {
      return {
        name: match[1],
        kind,
        signature: extractSignature(lines),
        body: content,
        lineCount: lines.length,
        hasJSDoc: content.includes('/**') || content.includes('/*') || lines.some(l => l.trim().startsWith('//')),
      };
    }
  }

  // Fallback: return as unknown
  return {
    name: null,
    kind: 'unknown',
    signature: '',
    body: content,
    lineCount: lines.length,
    hasJSDoc: false,
  };
}

/**
 * Extract function signature from code lines.
 * @param {string[]} lines - Code lines
 * @returns {string} Simplified signature
 */
function extractSignature(lines) {
  const firstLine = lines[0] || '';
  // Look for function/method signature pattern
  const sigMatch = firstLine.match(/[\w$]+\s*\([^)]*\)/);
  if (sigMatch) {
    return sigMatch[0].slice(0, 80);
  }
  return firstLine.slice(0, 80);
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Module Exports ─────────────────────────────────────────────────────────────

module.exports = {
  querySymbolWithIDE,
  setViewCodeItemTool,
  parseIDEResult,
  VIEW_CODE_ITEM_TIMEOUT,
  MAX_RETRIES,
};