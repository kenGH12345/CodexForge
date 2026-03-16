/**
 * FileScanner – Shared source-file collection utility.
 *
 * Motivation (P2-A fix):
 *   Three places in the codebase independently implemented the same
 *   "walk a directory tree, filter by extension, skip ignored dirs" logic:
 *
 *     1. orchestrator-stages.js  _runRealTestLoop  collectFiles()  (inline closure)
 *     2. entropy-gc.js           EntropyGC._collectSourceFiles()   (class method)
 *     3. code-graph.js           CodeGraph._collectFiles()         (class method)
 *
 *   The three implementations had subtle differences:
 *     - depth limit: orchestrator-stages had `depth > 4`; the others had none
 *     - dot-file skipping: entropy-gc and code-graph skipped `.`-prefixed names;
 *       orchestrator-stages did not
 *     - maxFiles cap: code-graph had one; the others did not
 *
 *   These inconsistencies are a maintenance hazard: a bug fix or behaviour change
 *   in one copy is silently missed in the others.
 *
 *   This module provides a single canonical implementation.  entropy-gc.js and
 *   code-graph.js keep their own private methods for now (they are class-internal
 *   and changing them carries risk); orchestrator-stages.js is migrated here.
 *   Future work: migrate the remaining two callers to use this module.
 *
 * Usage:
 *   const { scanSourceFiles } = require('./file-scanner');
 *   const files = scanSourceFiles(projectRoot, {
 *     extensions: ['.js', '.ts'],
 *     ignoreDirs: new Set(['node_modules', '.git']),
 *     maxDepth: 4,
 *     maxFiles: 500,
 *   });
 */

'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Recursively collects source files under `rootDir`.
 *
 * @param {string}   rootDir              - Absolute path to start scanning from
 * @param {object}   [options]
 * @param {string[]} [options.extensions] - File extensions to include (e.g. ['.js', '.ts'])
 *                                          Defaults to a broad set of common source extensions.
 * @param {Set<string>|string[]} [options.ignoreDirs]
 *                                        - Directory names to skip entirely.
 *                                          Defaults to common non-source directories.
 * @param {number}   [options.maxDepth=Infinity]
 *                                        - Maximum recursion depth (0 = rootDir only).
 *                                          Use `Infinity` (default) for unlimited depth.
 * @param {number}   [options.maxFiles=Infinity]
 *                                        - Stop collecting after this many files.
 * @param {boolean}  [options.skipDotFiles=true]
 *                                        - Skip files/dirs whose name starts with '.'.
 * @returns {string[]} Absolute paths of matching files, in walk order.
 */
function scanSourceFiles(rootDir, options = {}) {
  const {
    extensions    = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rb', '.php', '.rs', '.cpp', '.c', '.h'],
    ignoreDirs    = ['node_modules', '.git', 'dist', 'build', 'output', '.next', '.nuxt', 'coverage', '__pycache__', 'vendor'],
    maxDepth      = Infinity,
    maxFiles      = Infinity,
    skipDotFiles  = true,
  } = options;

  // Normalise to Set for O(1) lookup
  const extSet     = new Set(Array.isArray(extensions) ? extensions : [...extensions]);
  const ignoreSet  = new Set(Array.isArray(ignoreDirs) ? ignoreDirs : [...ignoreDirs]);

  const results = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (results.length >= maxFiles) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      // Permission denied or dir disappeared – skip silently
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return;

      // Skip dot-prefixed entries (hidden files/dirs) when requested
      if (skipDotFiles && entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreSet.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
      } else if (extSet.has(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  };

  walk(rootDir, 0);
  return results;
}

module.exports = { scanSourceFiles };
