/**
 * Code Graph Worker Thread – Parallel file processing for large projects.
 *
 * This worker receives a batch of file paths and performs:
 *  1. File reading (fs.readFileSync)
 *  2. Symbol extraction (via shared standalone parsers)
 *  3. Import extraction (via shared standalone parsers)
 *  4. Word token extraction (for call-edge analysis)
 *
 * Results are posted back to the main thread as a serialisable array.
 *
 * Used by CodeGraph.build() when project size exceeds WORKER_THRESHOLD files.
 * For smaller projects, the main thread handles everything directly.
 *
 * P1-3: Parsing logic is now shared with the main thread via standalone
 * functions exported from code-graph-parsers.js. This eliminates ~250 lines
 * of duplicated regex patterns that previously had to be maintained in sync.
 *
 * @production-exempt reserved – Node Worker Thread script. Cannot be directly
 *   required by the require-index (loaded via `new Worker(path.join(__dirname,
 *   'code-graph-worker.js'))` in code-graph-builder.js:38). Cannot carry R2
 *   observability (worker stdout is consumed by the host thread, not routed
 *   to logger). Cannot be integration-tested directly (the host module's tests
 *   cover the worker contract via message-passing).
 *
 * Design: zero external dependencies, pure Node.js.
 */

'use strict';

const { parentPort, workerData, isMainThread } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

// Guard: this file is designed to run inside a Worker thread.
// If loaded from the main thread (e.g. by require()), skip execution.
if (isMainThread || !workerData) {
  module.exports = { _workerModule: true };
  return;
}

// P1-3: Import shared standalone parsing functions from code-graph-parsers.js.
// These are pure functions (no `this` dependency) that produce identical results
// to the Mixin methods used by the main thread, ensuring quality parity.
const { extractSymbolsStandalone, extractImportPathsStandalone, stripCommentsAndStrings } = require('./code-graph-parsers');

// P0: Tree-sitter AST parsing in Worker threads.
// Each Worker initializes its own Parser instances (no sharing across Workers).
let tsAdapter = null;
try {
  tsAdapter = require('./ast-parsers/tree-sitter-adapter');
} catch (_) {
  // tree-sitter not installed or incompatible — silently fall back to regex
}

// ─── Main worker logic ────────────────────────────────────────────────────────

const { filePaths, projectRoot } = workerData;
const results = [];

for (const filePath of filePaths) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const ext     = path.extname(filePath);
    const lines   = content.split('\n');

    let symbols = [];
    let parser = 'regex';

    // P0: Try tree-sitter AST first, fallback to regex
    if (tsAdapter && tsAdapter.parseFile) {
      try {
        const astResult = tsAdapter.parseFile(content, relPath, ext);
        if (astResult.usedAST && astResult.symbols.length > 0) {
          symbols = astResult.symbols.map(s => ({
            name: s.name,
            kind: s.kind,
            line: s.line || 1,
            endLine: s.endLine,
            signature: s.signature || '',
            summary: s.summary || '',
            parser: 'tree-sitter',
          }));
          parser = 'tree-sitter';
        }
      } catch (_) {
        // AST failed — will fall through to regex
      }
    }

    // Fallback to regex extraction if AST didn't produce symbols
    if (symbols.length === 0) {
      symbols = extractSymbolsStandalone(lines, ext, content).map(s => ({
        ...s,
        parser: 'regex',
      }));
    }

    // Derive endLine for all symbols (AST may have it, regex definitely doesn't)
    const allHaveEndLine = symbols.every(s => typeof s.endLine === 'number' && s.endLine >= s.line);
    if (!allHaveEndLine) {
      symbols.sort((a, b) => a.line - b.line);
      const strippedLines = strippedContent.split('\n');
      for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        if (typeof sym.endLine === 'number' && sym.endLine >= sym.line) continue;
        sym.endLine = (i + 1 < symbols.length) ? symbols[i + 1].line - 1 : strippedLines.length;
      }
    }

    // P1: Strip comments/strings before import extraction to avoid false imports
    // from commented-out require/import statements
    const strippedContent = stripCommentsAndStrings(content, ext);
    const imports    = extractImportPathsStandalone(strippedContent, ext);
    const wordTokens = [...new Set(strippedContent.match(/\b\w+\b/g) || [])];

    results.push({
      relPath,
      ext,
      symbols,
      imports,
      wordTokens,
      strippedContent,
      lineCount: lines.length,
      parser,
    });
  } catch (err) {
    // Skip unreadable files – report back with null
    results.push({ relPath: path.relative(projectRoot, filePath).replace(/\\/g, '/'), error: err.message });
  }
}

parentPort.postMessage(results);
