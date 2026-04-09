/**
 * Code Graph Builder – Graph Construction Logic Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from code-graph.js.
 * Contains the graph construction methods mixed into CodeGraph.prototype:
 *   - build()              – main build entry point
 *   - _patchBuild()        – in-place patch for known changed files
 *   - _runWorkerPool()     – parallel processing via worker threads
 *   - _detectChangedFilesByMtime() – quick scan mode file detection
 *   - _collectFiles()      – recursive file collection
 *   - _extractSymbols()    – symbol extraction (class/function/etc)
 *   - _extractImports()    – import/require edge extraction
 *   - _extractCallEdges()  – call graph edge extraction
 *   - _loadGitignoreDirs() – .gitignore pattern loading
 *
 * This mixin is applied to CodeGraph.prototype via Object.assign.
 *
 * @module code-graph-builder
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { Worker } = require('worker_threads');

// ─── P0 AST Integration: Structural Fingerprint Engine ────────────────────────
let FingerprintEngine = null;
try {
  ({ FingerprintEngine } = require('./ast-parsers/fingerprint-engine'));
} catch (err) {
  console.log('[CodeGraph] FingerprintEngine not available, using mtime-based detection');
}

// ─── Worker Threads Configuration ─────────────────────────────────────────────
const WORKER_FILE_THRESHOLD = 500;
const WORKER_SCRIPT = path.join(__dirname, 'code-graph-worker.js');

// ─── Non-Code Directories (always skipped) ────────────────────────────────────
const NON_CODE_DIRS = new Set([
  'images', 'img', 'icons', 'fonts', 'media', 'videos', 'audio', 'textures', 'sprites',
  'docs', 'doc', 'documentation', 'wiki', 'static', 'public',
  'data', 'fixtures', 'samples', 'testdata', 'test-data', 'mock', 'mocks', '__mocks__',
  'generated', 'gen', 'auto-generated', 'third_party', 'thirdparty', '3rdparty', 'external',
  'logs', 'log', 'tmp', 'temp', 'cache', '.cache',
  '.idea', '.vscode', '.vs', '.settings',
  'locales', 'locale', 'i18n', 'l10n', 'translations',
]);

// ─── Symbol Types ─────────────────────────────────────────────────────────────
const { SymbolKind } = require('./code-graph-types');

// ─── CodeGraph Builder Mixin ──────────────────────────────────────────────────

const CodeGraphBuilderMixin = {

  /**
   * Scan the project and build the code graph.
   *
   * @param {object} [options]
   * @param {boolean} [options.incremental=true] - Reuse cached data, only re-process changed files.
   * @param {boolean} [options.force=false] - Force full rebuild.
   * @param {string[]} [options.patchFiles] - Only re-process these specific files in-place.
   * @param {boolean} [options.writeOutput=true] - Write code-graph.json/md to disk.
   * @param {boolean} [options.quickScan=false] - Fast mtime-only scan to detect changed files.
   * @returns {{ symbolCount: number, fileCount: number, edgeCount: number, graphPath: string, incremental: boolean, changedFiles: number, patchMode: boolean }}
   */
  async build({ incremental = true, force = false, patchFiles = null, writeOutput = true, quickScan = false } = {}) {
    // ── Patch Mode: in-place update for known changed files ──────────────
    if (Array.isArray(patchFiles) && patchFiles.length > 0 && this._symbols.size > 0) {
      return this._patchBuild(patchFiles, writeOutput);
    }

    // ── Quick Scan Mode: auto-detect changed files via mtime ──────────────
    if (quickScan && this._symbols.size > 0 && !force) {
      const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
      const detected = this._detectChangedFilesByMtime(cachePath);
      if (detected !== null) {
        if (detected.length === 0) {
          console.log(`[CodeGraph] ⚡ Quick scan: no files changed since last build – skipping`);
          return {
            symbolCount: this._symbols.size,
            fileCount: 0,
            edgeCount: [...this._callEdges.values()].reduce((n, v) => n + v.length, 0),
            graphPath: null,
            incremental: true,
            changedFiles: 0,
            patchMode: true,
          };
        }
        return this._patchBuild(detected, writeOutput);
      }
      console.log(`[CodeGraph] ⚠️  Quick scan: no valid cache found, falling back to normal build`);
    }

    console.log('');
    console.log(`[CodeGraph] 🔍 Building code graph for: ${this._root}`);
    this._symbols.clear();
    this._callEdges.clear();
    this._importEdges.clear();
    this._fileMtimes.clear();
    this._calledByIndex = null;
    this._importanceWeights = null;
    this._tokenIndex = null;
    this._sortedTokenKeys = null;

    const cachePath = path.join(this._outputDir, '.code-graph-cache.json');
    let isIncremental = false;
    let changedFiles = [];

    // ── P0: Initialize FingerprintEngine for structural change detection ────
    if (!this._fingerprintEngine && FingerprintEngine) {
      this._fingerprintEngine = new FingerprintEngine({
        projectRoot: this._root,
        cacheDir: this._outputDir,
        useTreeSitter: true,
      });
      console.log('[CodeGraph] 🔍 Structural fingerprinting enabled');
    }

    // Try incremental build
    if (incremental && !force) {
      const loaded = this._loadCache(cachePath);
      if (loaded) {
        changedFiles = this._detectChangedFiles(cachePath);
        
        // P0: Apply structural fingerprint classification
        if (this._fingerprintEngine && changedFiles.length > 0) {
          const filePaths = changedFiles.map(f => path.join(this._root, f));
          const classified = this._fingerprintEngine.detectChanges(filePaths);
          const recommendation = this._fingerprintEngine.getRebuildRecommendation(classified);
          
          console.log(`[CodeGraph] 📊 Change classification: ${classified.format.length} format, ${classified.signature.length} signature, ${classified.api_breaking.length} API-breaking`);
          
          // If only formatting changes, skip rebuild entirely
          if (recommendation.action === 'skip') {
            console.log(`[CodeGraph] ✅ Format-only changes detected – skipping rebuild`);
              this._buildTokenIndex();
            const graphPath = writeOutput ? await this._writeOutput() : null;
            return {
              symbolCount: this._symbols.size,
              fileCount: 0,
              edgeCount: [...this._callEdges.values()].reduce((n, v) => n + v.length, 0),
              graphPath,
              incremental: true,
              changedFiles: 0,
              patchMode: false,
            };
          }

          // Use refined file list
          changedFiles = recommendation.affectedFiles;
        }

        if (changedFiles.length === 0) {
          console.log(`[CodeGraph] ✅ No structural changes detected – using cached graph (${this._symbols.size} symbols)`);
          this._buildTokenIndex();
          const graphPath = writeOutput ? await this._writeOutput() : null;
          return {
            symbolCount: this._symbols.size,
            fileCount: 0,
            edgeCount: [...this._callEdges.values()].reduce((n, v) => n + v.length, 0),
            graphPath,
            incremental: true,
            changedFiles: 0,
            patchMode: false,
          };
        }
        isIncremental = true;
        console.log(`[CodeGraph] 🔄 Incremental build: ${changedFiles.length} changed file(s)`);
      }
    }

    // Collect files
    const files = await this._collectFiles(isIncremental ? changedFiles : null);

    if (files.length > this._warnFileThreshold) {
      console.warn(`[CodeGraph] ⚠️  Large codebase detected: ${files.length} files. Build may take a while.`);
    }

    // Build graph
    const tokenCache = new Map(); // for Pass 2

    // Use worker threads for large projects
    if (files.length >= WORKER_FILE_THRESHOLD && fs.existsSync(WORKER_SCRIPT)) {
      console.log(`[CodeGraph] 🧵 Using worker threads for ${files.length} files...`);
      await this._runWorkerPool(files, tokenCache, writeOutput);
    } else {
      // Main thread processing
      const BATCH_SIZE = 64;

      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const contents = await Promise.all(
          batch.map(filePath =>
            fs.promises.readFile(filePath, 'utf-8').catch(() => null)
          )
        );
        for (let j = 0; j < batch.length; j++) {
          const content = contents[j];
          if (content === null) continue;
          const filePath = batch[j];
          const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
          const ext = path.extname(filePath);
          this._extractSymbols(content, relPath, ext);
          const strippedContent = this._stripCommentsAndStrings(content, ext);
          this._extractImports(strippedContent, relPath, ext);
          tokenCache.set(relPath, new Set(strippedContent.match(/\b\w+\b/g) || []));
try {
        this._fileMtimes.set(relPath, fs.statSync(filePath).mtimeMs);
      } catch (e) {
        // Silently ignore — file may have been deleted since the scan started
      }
        }
      }
    }

    // Pass 2: Build call edges
    for (const filePath of files) {
      const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
      const ext = path.extname(filePath);
      const tokens = tokenCache.get(relPath);
      if (tokens) this._extractCallEdges(null, relPath, ext, tokens);
    }
    tokenCache.clear();

    const edgeCount = [...this._callEdges.values()].reduce((n, v) => n + v.length, 0);
    const modeLabel = isIncremental ? `incremental – ${changedFiles.length} changed` : 'full rebuild';
    console.log(`[CodeGraph] ✅ Built (${modeLabel}): ${this._symbols.size} symbols, ${edgeCount} call edges, ${this._importEdges.size} modules`);

    if (this._techProfile) {
      console.log(`[CodeGraph] 🔗 P2-1 Fusion: tech profile "${this._techProfile.name || this._techProfile.id}" active`);
    }

    this._buildTokenIndex();
    this._sortedTokenKeys = null;
    this._saveCache(cachePath, files);

    const graphPath = writeOutput ? await this._writeOutput() : null;
    if (!writeOutput) {
      console.log(`[CodeGraph] ⏭️  Skipping disk write (writeOutput=false, will be written later)`);
    }
    return {
      symbolCount: this._symbols.size,
      fileCount: files.length,
      edgeCount,
      graphPath,
      incremental: isIncremental,
      changedFiles: isIncremental ? changedFiles.length : files.length,
      patchMode: false,
    };
  },

  /**
   * Patch-mode build: update only the specified files in-place.
   * @param {string[]} patchFiles - Relative paths of changed files
   * @param {boolean} writeOutput
   * @returns {object}
   */
  async _patchBuild(patchFiles, writeOutput) {
    console.log(`[CodeGraph] 🩹 Patch mode: updating ${patchFiles.length} file(s) in-place`);

    // Remove old symbols/edges for these files
    for (const relPath of patchFiles) {
      // Remove symbols from this file
      for (const [id, sym] of this._symbols) {
        if (sym.file === relPath) {
          this._symbols.delete(id);
        }
      }
      // Remove call edges from this file
      this._callEdges.delete(relPath);
      // Remove import edges from this file
      this._importEdges.delete(relPath);
    }

    // Re-process changed files
    for (const relPath of patchFiles) {
      const filePath = path.join(this._root, relPath);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (_) {
        continue; // File may have been deleted
      }

      const ext = path.extname(filePath);
      this._extractSymbols(content, relPath, ext);
      const strippedContent = this._stripCommentsAndStrings(content, ext);
      this._extractImports(strippedContent, relPath, ext);
      this._extractCallEdges(null, relPath, ext, new Set(strippedContent.match(/\b\w+\b/g) || []));
try {
        this._fileMtimes.set(relPath, fs.statSync(filePath).mtimeMs);
      } catch (e) {
        // Silently ignore — file may have been deleted since the scan started
      }
    }

    // Rebuild token index
    this._buildTokenIndex();
    this._sortedTokenKeys = null;
    this._calledByIndex = null;
    this._importanceWeights = null;

    const edgeCount = [...this._callEdges.values()].reduce((n, v) => n + v.length, 0);
    console.log(`[CodeGraph] ✅ Patch complete: ${this._symbols.size} symbols, ${edgeCount} call edges`);

    if (writeOutput) {
      await this._writeOutput();
    }

    return {
      symbolCount: this._symbols.size,
      fileCount: patchFiles.length,
      edgeCount,
      graphPath: writeOutput ? path.join(this._outputDir, 'code-graph.json') : null,
      incremental: true,
      changedFiles: patchFiles.length,
      patchMode: true,
    };
  },

  /**
   * Detect changed files by comparing mtimes with cached values.
   * @param {string} cachePath
   * @returns {string[]|null} - Array of relative paths, or null if cache invalid
   */
  _detectChangedFilesByMtime(cachePath) {
    if (!fs.existsSync(cachePath)) return null;

    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (!cached.fileMtimes) return null;

      const changed = [];
      for (const [relPath, cachedMtime] of Object.entries(cached.fileMtimes)) {
        const filePath = path.join(this._root, relPath);
        try {
          const currentMtime = fs.statSync(filePath).mtimeMs;
          if (Math.abs(currentMtime - cachedMtime) > 1000) {
            changed.push(relPath);
          }
        } catch (_) {
          // File may have been deleted
          changed.push(relPath);
        }
      }

      // Also check for new files (not in cache)
      // For quick scan, we skip this to avoid full directory scan

      return changed;
    } catch (_) {
      return null;
    }
  },

  /**
   * Run worker thread pool for parallel processing.
   * @param {string[]} files
   * @param {Map} tokenCache
   * @param {boolean} writeOutput
   */
  async _runWorkerPool(files, tokenCache, writeOutput) {
    const numWorkers = Math.min(os.cpus().length, 4);
    const chunkSize = Math.ceil(files.length / numWorkers);
    const workers = [];

    for (let i = 0; i < numWorkers; i++) {
      const chunk = files.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) continue;

      const worker = new Worker(WORKER_SCRIPT, {
        workerData: {
          filePaths: chunk,
          projectRoot: this._root,
          extensions: [...this._extensions],
        },
      });

      workers.push(
        new Promise((resolve) => {
          worker.on('message', (fileResults) => {
            // fileResults is an array: [{ relPath, ext, symbols[], imports[], wordTokens[], lineCount }, ...]
            for (const fileResult of fileResults) {
              if (!fileResult || fileResult.error) continue;
              const { relPath, symbols, imports, wordTokens } = fileResult;

              // Merge symbols into main _symbols Map
              for (const sym of (symbols || [])) {
                const id = `${relPath}::${sym.name}`;
                this._symbols.set(id, {
                  id,
                  name: sym.name,
                  kind: sym.kind,
                  file: relPath,
                  line: sym.line,
                  signature: sym.signature || '',
                  summary: sym.summary || '',
                });
              }

              // Merge import edges
              if (imports && imports.length > 0) {
                this._importEdges.set(relPath, imports);
              }

              // Populate tokenCache for Pass 2 call-edge extraction
              if (wordTokens && wordTokens.length > 0) {
                tokenCache.set(relPath, new Set(wordTokens));
              }

              // Record mtime for incremental cache
              try {
                const absPath = path.join(this._root, relPath);
                this._fileMtimes.set(relPath, fs.statSync(absPath).mtimeMs);
              } catch (_) {
                // File may have been deleted
              }
            }
            resolve();
          });
          worker.on('error', (err) => {
            console.warn(`[CodeGraph] Worker error: ${err.message}`);
            resolve();
          });
          worker.on('exit', (code) => {
            if (code !== 0) {
              console.warn(`[CodeGraph] Worker exited with code ${code}`);
            }
            resolve();
          });
        })
      );
    }

    await Promise.all(workers);
  },

  /**
   * Collect files to process.
   * @param {string[]|null} changedFiles - If incremental, only these files
   * @returns {string[]}
   */
  async _collectFiles(changedFiles) {
    if (changedFiles && changedFiles.length > 0) {
      return changedFiles
        .map(f => path.isAbsolute(f) ? f : path.join(this._root, f))
        .filter(f => fs.existsSync(f));
    }

    const files = [];
    const queue = [this._root];

    while (queue.length > 0) {
      const dir = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const entry of entries) {
        const name = entry.name;
        if (this._ignoreDirs.has(name)) continue;
        if (NON_CODE_DIRS.has(name)) continue;

        const fullPath = path.join(dir, name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(name);
          if (this._extensions.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    }

    // Apply scope filter if configured
    if (this._scopeDirs.length > 0) {
      const scopePaths = this._scopeDirs.map(d => path.resolve(this._root, d));
      return files.filter(f => scopePaths.some(sp => f.startsWith(sp)));
    }

    return files;
  },

  /**
   * Extract symbols from file content.
   * P0: AST-first extraction with regex fallback for dual accuracy.
   * @param {string} content
   * @param {string} relPath
   * @param {string} ext
   * @param {boolean} [useAST=true] - Whether to try AST extraction first
   */
  _extractSymbols(content, relPath, ext, useAST = true) {
    // ── P0: Try AST extraction first ───────────────────────────────────────
    if (useAST && this._fingerprintEngine) {
      try {
        const fp = this._fingerprintEngine.generateFingerprint(content, ext, relPath);
        
        if (fp.symbols && fp.symbols.length > 0) {
          console.log(`[CodeGraph] 🌲 AST extraction: ${relPath} (+${fp.symbols.length} symbols)`);
          
          for (const sym of fp.symbols) {
            const id = `${relPath}::${sym.name}`;
            this._symbols.set(id, {
              id,
              name: sym.name,
              kind: sym.kind,
              file: relPath,
              line: sym.line,
              signature: sym.signature || content.split('\n')[sym.line - 1]?.trim() || '',
              summary: sym.summary || '',
              decorators: sym.decorators || [],
              isAsync: sym.isAsync || false,
            });
          }
          
          // Update fingerprint cache
          this._fingerprintEngine.updateFingerprints([relPath]);
          return;
        }
      } catch (err) {
        console.warn(`[CodeGraph] AST extraction failed for ${relPath}, falling back to regex`);
      }
    }
    
    // ── Fallback: Regex-based extraction ───────────────────────────────────
    const patterns = this._getSymbolPatterns(ext);
    if (!patterns) return;

    const lines = content.split('\n');

    for (const pattern of patterns) {
      let match;
      const regex = new RegExp(pattern.regex, 'gm');
      while ((match = regex.exec(content)) !== null) {
        const name = match.groups?.name || match[1];
        if (!name) continue;

        const lineNum = content.substring(0, match.index).split('\n').length;
        const line = lines[lineNum - 1] || '';

        const id = `${relPath}::${name}`;
        this._symbols.set(id, {
          id,
          name,
          kind: pattern.kind,
          file: relPath,
          line: lineNum,
          signature: line.trim(),
          summary: this._extractSummary(lines, lineNum),
        });
      }
    }
  },

  /**
   * Extract import/require edges.
   * @param {string} content
   * @param {string} relPath
   * @param {string} ext
   */
  _extractImports(content, relPath, ext) {
    const imports = [];
    const patterns = {
      '.js': [/\b(?:import|require)\s*\(?['"]([^'"]+)['"]/g],
      '.ts': [/\b(?:import|require)\s*\(?['"]([^'"]+)['"]/g],
      '.py': [/\b(?:import|from)\s+(\S+)/g],
      '.go': [/\bimport\s+(?:\([^)]+\)|['"]([^'"]+)['"])/g],
      '.cs': [/\busing\s+([^;]+);/g],
      '.lua': [/\b(?:require|import)\s*['"]([^'"]+)['"]/g],
      '.dart': [/\bimport\s+['"]([^'"]+)['"]/g],
    };

    const regexList = patterns[ext] || [];
    for (const regex of regexList) {
      let match;
      const re = new RegExp(regex.source, 'g');
      while ((match = re.exec(content)) !== null) {
        const imported = match[1];
        if (imported && !imported.startsWith('.')) {
          imports.push(imported);
        }
      }
    }

    if (imports.length > 0) {
      this._importEdges.set(relPath, imports);
    }
  },

  /**
   * Extract call graph edges.
   * @param {string|null} content
   * @param {string} relPath
   * @param {string} ext
   * @param {Set<string>} tokens
   */
  _extractCallEdges(content, relPath, ext, tokens) {
    const calls = [];

    // Find all known symbol names in the file
    for (const [id, sym] of this._symbols) {
      if (sym.file === relPath) continue; // Skip own symbols
      const baseName = sym.name.includes(':') ? sym.name.split(':').pop() : sym.name;
      if (tokens.has(baseName) || tokens.has(sym.name)) {
        calls.push(id);
      }
    }

    if (calls.length > 0) {
      this._callEdges.set(relPath, calls);
    }
  },

  /**
   * Get symbol extraction patterns for a file extension.
   * @param {string} ext
   * @returns {object[]|null}
   */
  _getSymbolPatterns(ext) {
    const allPatterns = {
      '.js': [
        { regex: /\bclass\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
        { regex: /\bfunction\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'function' },
        { regex: /(?:const|let|var)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/g, kind: 'function' },
      ],
      '.ts': [
        { regex: /\bclass\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
        { regex: /\binterface\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'interface' },
        { regex: /\bfunction\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'function' },
        { regex: /(?:const|let|var)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>)/g, kind: 'function' },
      ],
      '.py': [
        { regex: /\bclass\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
        { regex: /\bdef\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'function' },
      ],
      '.go': [
        { regex: /\btype\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+struct\b/g, kind: 'class' },
        { regex: /\bfunc\s+(?:\([^)]+\)\s*)?(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'function' },
      ],
      '.cs': [
        { regex: /\bclass\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
        { regex: /\binterface\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'interface' },
        { regex: /\b(?:public|private|protected|internal|static)\s+(?:async\s+)?(?:[\w<>]+)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/g, kind: 'function' },
      ],
      '.lua': [
        { regex: /\bfunction\s+(?<name>[A-Za-z_][A-Za-z0-9_:.]*)/g, kind: 'function' },
        { regex: /(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/g, kind: 'class' },
      ],
      '.dart': [
        { regex: /\bclass\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/g, kind: 'class' },
        { regex: /\b(?:void|[A-Za-z_][A-Za-z0-9_<>]*)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/g, kind: 'function' },
      ],
    };
    return allPatterns[ext] || null;
  },

  /**
   * Extract summary (first comment block) for a symbol.
   * @param {string[]} lines
   * @param {number} lineNum
   * @returns {string}
   */
  _extractSummary(lines, lineNum) {
    // Look for comment above the symbol
    const commentLines = [];
    for (let i = lineNum - 2; i >= 0 && i >= lineNum - 10; i--) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*') || line.startsWith('#')) {
        commentLines.unshift(line.replace(/^[/*#\s]+/, ''));
      } else if (line === '' && commentLines.length === 0) {
        continue;
      } else {
        break;
      }
    }
    return commentLines.slice(0, 3).join(' ').slice(0, 200);
  },

  /**
   * Strip comments and strings from code for more accurate extraction.
   * @param {string} content
   * @param {string} ext
   * @returns {string}
   */
  _stripCommentsAndStrings(content, ext) {
    // Simple implementation - remove string literals and comments
    return content
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
      .replace(/`[^`]*`/g, '``')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  },

  /**
   * Load .gitignore patterns.
   * @param {string} projectRoot
   * @returns {string[]}
   */
  _loadGitignoreDirs(projectRoot) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return [];

    const patterns = [];
    try {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.endsWith('/')) {
          patterns.push(trimmed.slice(0, -1));
        } else if (!trimmed.includes('*') && !trimmed.includes('.')) {
          patterns.push(trimmed);
        }
      }
    } catch (_) {
      // Ignore errors
    }
    return patterns;
  },
};

module.exports = { CodeGraphBuilderMixin, NON_CODE_DIRS, WORKER_FILE_THRESHOLD };
