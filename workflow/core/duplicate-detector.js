/**
 * Duplicate Code Detector – P3 Optimization
 *
 * Automated detection of code duplicates to reduce technical debt.
 * Uses token-based similarity with locality-sensitive hashing (LSH)
 * for efficient duplicate detection without AST parsing complexity.
 *
 * Design Principles (ADR-37):
 *   - Zero LLM calls (pure algorithmic detection)
 *   - Fast local analysis (<1s for 1000 LOC)
 *   - Multiple granularity: functions, blocks, lines
 *   - Actionable reporting with exact locations
 *
 * Algorithm (inspired by jscpd):
 *   1. Tokenization: normalize code (remove comments, standardize whitespace)
 *   2. Fingerprinting: generate k-gram hashes (k=10-30 tokens)
 *   3. LSH indexing: hash similar blocks to same buckets
 *   4. Candidate filtering: minimum token threshold (default 30)
 *   5. Verification: exact match confirmation with location extraction
 *
 * @module duplicate-detector
 * @version P3-1
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  minTokens: 30,           // Minimum token count to report
  minLines: 5,             // Minimum line count
  kGramSize: 15,           // k-gram window size (tokens)
  lshBands: 4,             // LSH band count
  lshRows: 5,              // LSH rows per band
  similarityThreshold: 0.85, // Jaccard similarity threshold
  extensions: ['.js', '.ts', '.cs', '.go', '.py', '.lua', '.dart'],
  ignorePatterns: [
    'node_modules',
    '.git',
    'dist',
    'build',
    'test',
    'spec',
    '*.min.js',
    '*.generated.*',
  ],
  maxFileSize: 500 * 1024, // 500KB max per file
  maxDuplicates: 100,      // Max to report (avoid noise)
};

// ─── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Tokenizes source code into normalized tokens.
 * @param {string} code - Source code
 * @returns {string[]} Tokens
 */
function tokenize(code) {
  // Step 1: Remove comments
  let cleaned = code
    .replace(/\/\*[\s\S]*?\*\//g, '')     // Block comments
    .replace(/\/\/.*$/gm, '')             // Line comments
    .replace(/#.*$/gm, '');               // Python/Lua comments

  // Step 2: Normalize whitespace
  cleaned = cleaned
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .trim();

  // Step 3: Tokenize (identifiers, literals, operators)
  // Split on non-alphanumeric but keep important syntax
  const tokens = cleaned
    .split(/([a-zA-Z_][a-zA-Z0-9_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'|[{}();,=+\-*/<>!&|]+)/g)
    .map(t => t.trim())
    .filter(t => t.length > 0 && !/^\s+$/.test(t));

  return tokens;
}

/**
 * Maps token index back to line number in original code.
 * @param {string} code - Original code
 * @param {number} tokenIndex - Token position
 * @returns {number} Line number (1-based)
 */
function tokenIndexToLine(code, tokenIndex) {
  const tokens = tokenizeWithPositions(code);
  if (tokenIndex < 0 || tokenIndex >= tokens.length) return -1;
  return tokens[tokenIndex].line;
}

/**
 * Tokenize with position tracking for line mapping.
 * @param {string} code
 * @returns {Array<{token: string, line: number}>}
 */
function tokenizeWithPositions(code) {
  const lines = code.split('\n');
  const tokens = [];
  let lineNum = 1;

  for (const line of lines) {
    // Simple tokenization per line
    const lineTokens = line
      .replace(/\/\/.*$/g, '') // Remove line comments for tokenization
      .split(/([a-zA-Z_][a-zA-Z0-9_]*|\d+(?:\.\d+)?|"[^"]*"|'[^']*'|[{}();,=+\-*/<>!&|]+)/g)
      .map(t => t.trim())
      .filter(t => t.length > 0 && !/^\s+$/.test(t));

    for (const token of lineTokens) {
      tokens.push({ token, line: lineNum });
    }
    lineNum++;
  }

  return tokens;
}

// ─── K-Gram & LSH ──────────────────────────────────────────────────────────────

/**
 * Generate k-gram fingerprints from tokens.
 * @param {string[]} tokens
 * @param {number} k - Gram size
 * @returns {Array<{hash: string, startIdx: number, endIdx: number}>}
 */
function generateKGrams(tokens, k) {
  const grams = [];
  for (let i = 0; i <= tokens.length - k; i++) {
    const gram = tokens.slice(i, i + k);
    const hash = crypto.createHash('md5').update(gram.join(' ')).digest('hex');
    grams.push({ hash, startIdx: i, endIdx: i + k - 1 });
  }
  return grams;
}

/**
 * LSH signature computation using banding technique.
 * @param {string[]} hashes - K-gram hashes
 * @param {number} bands - Number of bands
 * @param {number} rows - Rows per band
 * @returns {string[]} LSH signatures (one per band)
 */
function computeLSHSignatures(hashes, bands, rows) {
  const signatures = [];
  const requiredHashes = bands * rows;

  // Pad if not enough hashes
  if (hashes.length < requiredHashes) {
    const padding = Array(requiredHashes - hashes.length).fill('0');
    hashes = [...hashes, ...padding];
  }

  for (let b = 0; b < bands; b++) {
    const bandHashes = hashes.slice(b * rows, (b + 1) * rows);
    const signature = crypto
      .createHash('md5')
      .update(bandHashes.join(''))
      .digest('hex');
    signatures.push(signature);
  }

  return signatures;
}

// ─── Duplicate Detection ───────────────────────────────────────────────────────

/**
 * Represents a code block with its location.
 * @typedef {Object} CodeBlock
 * @property {string} id - Unique identifier
 * @property {string} filePath - File path
 * @property {number} startLine - Start line (1-based)
 * @property {number} endLine - End line (1-based)
 * @property {string[]} tokens - Token sequence
 * @property {string} content - Original content
 */

/**
 * Represents a detected duplicate.
 * @typedef {Object} Duplicate
 * @property {string} id - Duplicate pair ID
 * @property {CodeBlock} blockA - First occurrence
 * @property {CodeBlock} blockB - Second occurrence
 * @property {number} similarity - Jaccard similarity (0-1)
 * @property {number} tokenCount - Number of tokens duplicated
 * @property {string} snippet - Representative code snippet
 */

/**
 * Main duplicate detection class.
 */
class DuplicateDetector {
  /**
   * @param {object} config - Configuration options
   */
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._fileCache = new Map(); // filePath -> { tokens, lines, content }
    this._lshIndex = new Map();   // LSH signature -> CodeBlock[]
    this._duplicates = [];         // Detected duplicates
  }

  /**
   * Scan a directory for duplicate code.
   *
   * @param {string} projectRoot - Root directory to scan
   * @param {object} options
   * @param {string[]} [options.scopeDirs] - Subdirectories to scan (default: all)
   * @param {Function} [options.progressCallback] - (current, total) => void
   * @returns {Duplicate[]} Detected duplicates
   */
  scanDirectory(projectRoot, options = {}) {
    const { scopeDirs = [], progressCallback = null } = options;
    console.log(`[DuplicateDetector] 🔍 Scanning for duplicates (minTokens=${this._config.minTokens})...`);

    // Collect files
    const files = this._collectFiles(projectRoot, scopeDirs);
    if (files.length === 0) {
      console.log('[DuplicateDetector] ⚠️ No files found to scan');
      return [];
    }

    console.log(`[DuplicateDetector] 📁 Found ${files.length} files to analyze`);

    // Phase 1: Tokenize all files
    for (let i = 0; i < files.length; i++) {
      if (progressCallback) progressCallback(i + 1, files.length * 2);
      this._tokenizeFile(files[i]);
    }

    // Phase 2: Build LSH index
    for (let i = 0; i < files.length; i++) {
      if (progressCallback) progressCallback(files.length + i + 1, files.length * 2);
      this._indexFile(files[i]);
    }

    // Phase 3: Find duplicates from LSH buckets
    this._findDuplicatesFromBuckets();

    // Phase 4: Filter and sort
    this._duplicates = this._filterAndSortDuplicates();

    console.log(`[DuplicateDetector] ✅ Found ${this._duplicates.length} duplicate groups`);
    return this._duplicates;
  }

  /**
   * Collect files to scan.
   * @private
   */
  _collectFiles(projectRoot, scopeDirs) {
    const files = [];
    const dirs = scopeDirs.length > 0 ? scopeDirs : [projectRoot];

    for (const dir of dirs) {
      const fullPath = path.resolve(projectRoot, dir);
      if (!fs.existsSync(fullPath)) continue;

      this._walkDir(fullPath, (filePath) => {
        const ext = path.extname(filePath);
        if (!this._config.extensions.includes(ext)) return;

        // Check ignore patterns
        const relPath = path.relative(projectRoot, filePath);
        if (this._shouldIgnore(relPath)) return;

        // Check file size
        const stats = fs.statSync(filePath);
        if (stats.size > this._config.maxFileSize) {
          console.log(`[DuplicateDetector] ⚠️ Skipping large file: ${relPath}`);
          return;
        }

        files.push(filePath);
      });
    }

    return files;
  }

  /**
   * Walk directory recursively.
   * @private
   */
  _walkDir(dir, callback) {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        if (this._config.ignorePatterns.some(p => item.includes(p))) continue;
        this._walkDir(fullPath, callback);
      } else {
        callback(fullPath);
      }
    }
  }

  /**
   * Check if path should be ignored.
   * @private
   */
  _shouldIgnore(relPath) {
    return this._config.ignorePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(relPath);
      }
      return relPath.includes(pattern);
    });
  }

  /**
   * Tokenize a file and store in cache.
   * @private
   */
  _tokenizeFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const tokens = tokenize(content);
      const lines = content.split('\n');

      this._fileCache.set(filePath, { tokens, lines, content });
    } catch (err) {
      console.warn(`[DuplicateDetector] ⚠️ Failed to read ${filePath}: ${err.message}`);
    }
  }

  /**
   * Index file with LSH.
   * @private
   */
  _indexFile(filePath) {
    const fileData = this._fileCache.get(filePath);
    if (!fileData || fileData.tokens.length < this._config.minTokens) return;

    const { tokens, content } = fileData;

    // Generate sliding window blocks
    const windowSize = this._config.minTokens;
    const stride = Math.max(1, Math.floor(windowSize / 2)); // 50% overlap

    for (let start = 0; start <= tokens.length - windowSize; start += stride) {
      const end = start + windowSize;
      const blockTokens = tokens.slice(start, end);

      // Create block
      const blockId = `${filePath}::${start}`;
      const startLine = tokenIndexToLine(content, start);
      const endLine = tokenIndexToLine(content, end - 1);

      const block = {
        id: blockId,
        filePath,
        startLine: Math.max(1, startLine),
        endLine: Math.max(1, endLine),
        tokens: blockTokens,
        content: this._extractBlockContent(content, startLine, endLine),
      };

      // Generate k-grams and LSH
      const kGrams = generateKGrams(blockTokens, Math.min(this._config.kGramSize, blockTokens.length));
      const signatures = computeLSHSignatures(
        kGrams.map(g => g.hash),
        this._config.lshBands,
        this._config.lshRows
      );

      // Index by each signature (band)
      for (const sig of signatures) {
        if (!this._lshIndex.has(sig)) {
          this._lshIndex.set(sig, []);
        }
        this._lshIndex.get(sig).push(block);
      }
    }
  }

  /**
   * Extract block content from file.
   * @private
   */
  _extractBlockContent(content, startLine, endLine) {
    const lines = content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
  }

  /**
   * Find duplicates from LSH buckets.
   * @private
   */
  _findDuplicatesFromBuckets() {
    const candidatePairs = new Map(); // blockIdA::blockIdB -> { blockA, blockB, signatures }

    // For each bucket with multiple blocks, compare all pairs
    for (const [sig, blocks] of this._lshIndex) {
      if (blocks.length < 2) continue;

      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          const blockA = blocks[i];
          const blockB = blocks[j];

          // Skip if same file (optional: set to true to find intra-file dupes)
          if (blockA.filePath === blockB.filePath) continue;

          const pairId = [blockA.id, blockB.id].sort().join('::');

          if (!candidatePairs.has(pairId)) {
            candidatePairs.set(pairId, { blockA, blockB, signatureCount: 0 });
          }
          candidatePairs.get(pairId).signatureCount++;
        }
      }
    }

    // Verify candidates with Jaccard similarity
    for (const [pairId, candidate] of candidatePairs) {
      const { blockA, blockB, signatureCount } = candidate;

      // LSH hits threshold
      if (signatureCount >= this._config.lshBands / 2) {
        const similarity = this._computeJaccardSimilarity(blockA.tokens, blockB.tokens);

        if (similarity >= this._config.similarityThreshold) {
          this._duplicates.push({
            id: pairId,
            blockA,
            blockB,
            similarity,
            tokenCount: blockA.tokens.length,
            snippet: this._truncateSnippet(blockA.content, 200),
          });
        }
      }
    }
  }

  /**
   * Compute Jaccard similarity between two token arrays.
   * @private
   */
  _computeJaccardSimilarity(tokensA, tokensB) {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  }

  /**
   * Truncate snippet for display.
   * @private
   */
  _truncateSnippet(content, maxLen) {
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + '...';
  }

  /**
   * Filter and sort duplicates.
   * @private
   */
  _filterAndSortDuplicates() {
    // Remove duplicates (same pair may appear multiple times)
    const seen = new Set();
    const unique = [];

    for (const dup of this._duplicates) {
      const pairId = [dup.blockA.id.split('::')[0], dup.blockB.id.split('::')[0]].sort().join('::');

      // Simple dedup: same files, overlapping lines
      const key = `${pairId}:${dup.blockA.startLine}:${dup.blockB.startLine}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(dup);
      }
    }

    // Sort by token count (largest first), then similarity
    unique.sort((a, b) => {
      if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
      return b.similarity - a.similarity;
    });

    return unique.slice(0, this._config.maxDuplicates);
  }

  /**
   * Generate Markdown report.
   * @returns {string} Markdown report
   */
  generateReport() {
    if (this._duplicates.length === 0) {
      return '## Duplicate Code Analysis\n\n✅ No duplicates detected above threshold.\n';
    }

    const lines = [
      '## Duplicate Code Analysis',
      '',
      `> Detected **${this._duplicates.length}** duplicate groups (minTokens=${this._config.minTokens})`,
      '',
      '| # | File A | File B | Lines | Similarity | Tokens |',
      '|---|--------|--------|-------|------------|--------|',
    ];

    for (let i = 0; i < this._duplicates.length; i++) {
      const dup = this._duplicates[i];
      const fileA = path.basename(dup.blockA.filePath);
      const fileB = path.basename(dup.blockB.filePath);
      const linesA = `${dup.blockA.startLine}-${dup.blockA.endLine}`;
      const linesB = `${dup.blockB.startLine}-${dup.blockB.endLine}`;
      const sim = `${(dup.similarity * 100).toFixed(1)}%`;

      lines.push(`| ${i + 1} | \`${fileA}:${linesA}\` | \`${fileB}:${linesB}\` | ${dup.blockA.endLine - dup.blockA.startLine + 1} | ${sim} | ${dup.tokenCount} |`);
    }

    lines.push('');
    lines.push('### Recommendations');
    lines.push('');
    lines.push('- Consider extracting duplicated logic into shared utility functions');
    lines.push('- Review duplication patterns for potential design improvements');
    lines.push('- If duplication is intentional (e.g., templates), add ignore patterns');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Get statistics about detected duplicates.
   * @returns {object}
   */
  getStats() {
    const fileCounts = new Map();
    let totalTokens = 0;

    for (const dup of this._duplicates) {
      fileCounts.set(dup.blockA.filePath, (fileCounts.get(dup.blockA.filePath) || 0) + 1);
      fileCounts.set(dup.blockB.filePath, (fileCounts.get(dup.blockB.filePath) || 0) + 1);
      totalTokens += dup.tokenCount;
    }

    return {
      duplicateCount: this._duplicates.length,
      filesAffected: fileCounts.size,
      totalTokensDuplicated: totalTokens,
      avgSimilarity: this._duplicates.length > 0
        ? this._duplicates.reduce((s, d) => s + d.similarity, 0) / this._duplicates.length
        : 0,
    };
  }
}

// ─── Utility Functions ─────────────────────────────────────────────────────────

/**
 * Quick scan for duplicates (convenience function).
 * @param {string} projectRoot - Project root
 * @param {object} config - Configuration
 * @returns {object} { duplicates, report, stats }
 */
function scanForDuplicates(projectRoot, config = {}) {
  const detector = new DuplicateDetector(config);
  const duplicates = detector.scanDirectory(projectRoot);
  const report = detector.generateReport();
  const stats = detector.getStats();

  return { duplicates, report, stats };
}

// ─── Module Exports ────────────────────────────────────────────────────────────

module.exports = {
  DuplicateDetector,
  scanForDuplicates,
  tokenize,
  generateKGrams,
  computeLSHSignatures,
  DEFAULT_CONFIG,
};
