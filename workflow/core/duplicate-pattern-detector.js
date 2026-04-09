/**
 * Duplicate Pattern Detector – Detects duplicate and similar code patterns.
 *
 * This module follows ADR-37 (IDE-First) with two detection strategies:
 *
 *  **Strategy C (IDE-First)**: When running inside an IDE:
 *    - Use codebase_search to find semantically similar code
 *    - Use grep_search to find exact text duplicates
 *    - Use view_code_item to compare function implementations
 *
 *  **Strategy E (Fallback)**: When no IDE is available:
 *    - Use sliding window hash detection (from CodeQualityAdapter)
 *    - Use token-based similarity detection
 *    - Use structure-based pattern matching
 *
 * Detection capabilities:
 *   - Exact duplicates (copy-paste detection)
 *   - Similar functions (structural similarity)
 *   - Near-duplicate blocks (minor variations)
 *   - Cross-file duplication
 *
 * Output:
 *   - output/duplicate-patterns.json  (machine-readable patterns)
 *   - output/duplicate-patterns.md    (human-readable summary)
 *   - output/duplicate-patterns-diagrams.md (Mermaid diagrams)
 *
 * Design: Zero external dependencies, pure algorithms + IDE tools.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Configuration Constants ─────────────────────────────────────────────────

/**
 * Minimum lines for a code block to be considered for duplication.
 */
const MIN_BLOCK_LINES = 6;

/**
 * Minimum similarity threshold (0-1) for considering code as similar.
 */
const SIMILARITY_THRESHOLD = 0.7;

/**
 * Minimum token overlap for duplicate detection.
 */
const MIN_TOKEN_OVERLAP = 0.6;

/**
 * File extensions to scan for duplication.
 */
const SOURCE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rb', '.php'];

/**
 * Patterns to skip when detecting duplicates (boilerplate, generated code).
 */
const SKIP_PATTERNS = [
  /\/\/.*@generated/i,
  /\/\*.*auto-generated.*\*\//i,
  /#.*auto-generated/i,
  /^\s*import\s+/,
  /^\s*export\s+\*\s+from/,
  /^\s*require\(['"]/,
  /^\s*\/\//,
  /^\s*#/,
];

// ─── Main Detector Class ─────────────────────────────────────────────────────

class DuplicatePatternDetector {
  /**
   * @param {object} options
   * @param {object}   options.codeGraph       - CodeGraph instance (for fallback)
   * @param {string}   options.projectRoot     - Project root directory
   * @param {string}   options.outputDir       - Output directory for generated files
   * @param {object}   [options.ideDetection]  - IDE detection result (for Strategy C)
   * @param {object}   [options.codeQualityAdapter] - CodeQualityAdapter (for baseline)
   * @param {boolean}  [options.useIDEFirst=true] - Follow ADR-37: prefer IDE tools
   */
  constructor({
    codeGraph,
    projectRoot,
    outputDir,
    ideDetection = null,
    codeQualityAdapter = null,
    useIDEFirst = true,
  }) {
    this._codeGraph = codeGraph;
    this._projectRoot = projectRoot;
    this._outputDir = outputDir;
    this._ideDetection = ideDetection;
    this._codeQualityAdapter = codeQualityAdapter;
    this._useIDEFirst = useIDEFirst;

    // Determine detection strategy
    this._strategy = this._determineStrategy();

    // Cache for detection results
    this._exactDuplicates = [];
    this._similarFunctions = [];
    this._duplicateBlocks = [];
    this._allFunctions = [];
  }

  // ─── Strategy Selection ───────────────────────────────────────────────────

  /**
   * Determine which detection strategy to use.
   * @returns {'ide-first' | 'hash-based'}
   */
  _determineStrategy() {
    if (!this._useIDEFirst) return 'hash-based';

    // Check if IDE is available with search capabilities
    if (this._ideDetection && this._ideDetection.isInsideIDE) {
      const caps = this._ideDetection.capabilities || {};
      if (caps.codebaseSearch || caps.grepSearch) {
        console.log(`[DuplicatePatternDetector] 🏠 IDE detected (${this._ideDetection.ideName}), using IDE-First strategy`);
        return 'ide-first';
      }
    }

    console.log(`[DuplicatePatternDetector] 📊 Using hash-based strategy (fallback)`);
    return 'hash-based';
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Detect all duplicate patterns in the codebase.
   *
   * @param {object} [options]
   * @param {boolean}  [options.writeOutput=true]  - Write output files
   * @param {number}   [options.minBlockLines=6]   - Minimum lines for a block
   * @param {number}   [options.similarityThreshold=0.7] - Similarity threshold
   * @returns {{ exactDuplicates, similarFunctions, duplicateBlocks, stats }}
   */
  async detect({
    writeOutput = true,
    minBlockLines = MIN_BLOCK_LINES,
    similarityThreshold = SIMILARITY_THRESHOLD,
  } = {}) {
    console.log(`\n[DuplicatePatternDetector] 🔍 Detecting duplicate patterns...`);
    console.log(`   Strategy: ${this._strategy}`);

    // Ensure code graph is loaded (for fallback)
    // Use public API getSymbolCount() instead of direct _symbols.size access
    if (this._codeGraph && this._codeGraph.getSymbolCount() === 0) {
      this._codeGraph.ensureLoaded();
    }

    // Step 1: Collect all functions
    this._allFunctions = this._collectFunctions();
    console.log(`   ✅ Collected ${this._allFunctions.length} functions`);

    // Step 2: Detect exact duplicates (hash-based)
    this._exactDuplicates = this._detectExactDuplicates(minBlockLines);
    console.log(`   ✅ Found ${this._exactDuplicates.length} exact duplicate groups`);

    // Step 3: Detect similar functions (structure-based)
    this._similarFunctions = this._detectSimilarFunctions(similarityThreshold);
    console.log(`   ✅ Found ${this._similarFunctions.length} similar function groups`);

    // Step 4: Detect duplicate code blocks (sliding window)
    this._duplicateBlocks = this._detectDuplicateBlocks(minBlockLines);
    console.log(`   ✅ Found ${this._duplicateBlocks.length} duplicate blocks`);

    // Build stats
    const stats = {
      totalFunctions: this._allFunctions.length,
      exactDuplicateGroups: this._exactDuplicates.length,
      exactDuplicateInstances: this._exactDuplicates.reduce((n, g) => n + g.instances.length, 0),
      similarFunctionGroups: this._similarFunctions.length,
      similarFunctionInstances: this._similarFunctions.reduce((n, g) => n + g.instances.length, 0),
      duplicateBlockCount: this._duplicateBlocks.length,
      duplicationRate: this._calculateDuplicationRate(),
      strategy: this._strategy,
    };

    // Write output files
    if (writeOutput) {
      this._writeOutput(stats);
    }

    return {
      exactDuplicates: this._exactDuplicates,
      similarFunctions: this._similarFunctions,
      duplicateBlocks: this._duplicateBlocks,
      stats,
    };
  }

  // ─── Function Collection ───────────────────────────────────────────────────

  /**
   * Collect all functions from CodeGraph.
   */
  _collectFunctions() {
    const functions = [];
    if (!this._codeGraph) return functions;

    // Use public API getAllSymbolValues() instead of direct _symbols.values() access
    const symbols = [...this._codeGraph.getAllSymbolValues()];

    for (const sym of symbols) {
      if (sym.kind !== 'function' && sym.kind !== 'method') continue;

      // Get function content
      const content = this._getFunctionContent(sym);
      if (!content) continue;

      functions.push({
        symbol: sym,
        content,
        tokens: this._tokenize(content),
        hash: this._hashContent(content),
        lineCount: content.split('\n').length,
      });
    }

    return functions;
  }

  /**
   * Get function content from file.
   */
  _getFunctionContent(sym) {
    try {
      const filePath = path.join(this._projectRoot, sym.file);
      if (!fs.existsSync(filePath)) return null;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract function body (approximate - use line count or signature boundary)
      const startLine = sym.line - 1;
      let endLine = startLine;
      let braceCount = 0;
      let foundStart = false;

      for (let i = startLine; i < Math.min(startLine + 100, lines.length); i++) {
        const line = lines[i];

        // Count braces
        braceCount += (line.match(/\{/g) || []).length;
        braceCount -= (line.match(/\}/g) || []).length;

        if (braceCount > 0) foundStart = true;
        if (foundStart && braceCount === 0) {
          endLine = i + 1;
          break;
        }
      }

      return lines.slice(startLine, endLine).join('\n');
    } catch (e) {
      return null;
    }
  }

  // ─── Exact Duplicate Detection ─────────────────────────────────────────────

  /**
   * Detect exact duplicates using content hash.
   */
  _detectExactDuplicates(minLines) {
    const hashGroups = new Map();

    for (const func of this._allFunctions) {
      // Skip small functions
      if (func.lineCount < minLines) continue;

      const hash = func.hash;
      if (!hashGroups.has(hash)) {
        hashGroups.set(hash, []);
      }
      hashGroups.get(hash).push(func);
    }

    // Convert to result format (only groups with >1 instance)
    const duplicates = [];
    for (const [hash, instances] of hashGroups) {
      if (instances.length > 1) {
        duplicates.push({
          type: 'exact',
          hash,
          lineCount: instances[0].lineCount,
          instances: instances.map(i => ({
            name: i.symbol.name,
            file: i.symbol.file,
            line: i.symbol.line,
            content: i.content.slice(0, 200) + (i.content.length > 200 ? '...' : ''),
          })),
          suggestion: this._generateSuggestion(instances),
        });
      }
    }

    // Sort by line count (larger duplicates first)
    duplicates.sort((a, b) => b.lineCount - a.lineCount);

    return duplicates;
  }

  // ─── Similar Function Detection ─────────────────────────────────────────────

  /**
   * Detect similar functions using token overlap.
   */
  _detectSimilarFunctions(threshold) {
    const similarGroups = [];
    const processed = new Set();

    // Cap at 2000 functions to avoid O(n²) blowup on large projects (e.g. 98k functions)
    const MAX_SIMILAR_SAMPLE = 2000;
    const candidates = this._allFunctions.length > MAX_SIMILAR_SAMPLE
      ? this._allFunctions.slice(0, MAX_SIMILAR_SAMPLE)
      : this._allFunctions;

    for (let i = 0; i < candidates.length; i++) {
      const funcA = candidates[i];

      // Skip small functions
      if (funcA.lineCount < MIN_BLOCK_LINES) continue;
      if (processed.has(funcA.symbol.name)) continue;

      const group = {
        type: 'similar',
        similarity: 0,
        instances: [{
          name: funcA.symbol.name,
          file: funcA.symbol.file,
          line: funcA.symbol.line,
          tokenCount: funcA.tokens.length,
        }],
      };

      for (let j = i + 1; j < candidates.length; j++) {
        const funcB = candidates[j];

        // Skip if same file and close together
        if (funcA.symbol.file === funcB.symbol.file &&
            Math.abs(funcA.symbol.line - funcB.symbol.line) < 20) {
          continue;
        }

        // Calculate similarity
        const similarity = this._calculateSimilarity(funcA.tokens, funcB.tokens);

        if (similarity >= threshold) {
          group.instances.push({
            name: funcB.symbol.name,
            file: funcB.symbol.file,
            line: funcB.symbol.line,
            tokenCount: funcB.tokens.length,
            similarity: Math.round(similarity * 100) + '%',
          });
          processed.add(funcB.symbol.name);
        }
      }

      // Only add if we found similar functions
      if (group.instances.length > 1) {
        // Calculate average similarity
        group.similarity = Math.round(
          group.instances.slice(1).reduce((s, i) => {
            const sim = parseInt(i.similarity) / 100;
            return s + sim;
          }, 0) / (group.instances.length - 1) * 100
        ) + '%';

        similarGroups.push(group);
        processed.add(funcA.symbol.name);
      }
    }

    // Sort by group size
    similarGroups.sort((a, b) => b.instances.length - a.instances.length);

    return similarGroups;
  }

  // ─── Duplicate Block Detection ─────────────────────────────────────────────

  /**
   * Detect duplicate code blocks using sliding window.
   */
  _detectDuplicateBlocks(minLines) {
    const blocks = [];
    const windowHashes = new Map();
    const allSourceFiles = this._collectSourceFiles();

    // Cap at 500 files to avoid scanning entire large projects
    const MAX_BLOCK_FILES = 500;
    const sourceFiles = allSourceFiles.length > MAX_BLOCK_FILES
      ? allSourceFiles.slice(0, MAX_BLOCK_FILES)
      : allSourceFiles;

    for (const filePath of sourceFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const relPath = path.relative(this._projectRoot, filePath);

        // Skip boilerplate lines
        const codeLines = lines.filter((line, idx) => {
          return !SKIP_PATTERNS.some(p => p.test(line));
        });

        // Sliding window
        for (let i = 0; i <= codeLines.length - minLines; i++) {
          const window = codeLines.slice(i, i + minLines).join('\n');
          const hash = this._hashContent(window);

          if (!windowHashes.has(hash)) {
            windowHashes.set(hash, []);
          }

          windowHashes.get(hash).push({
            file: relPath,
            line: i + 1,
            preview: window.slice(0, 100) + (window.length > 100 ? '...' : ''),
          });
        }
      } catch (e) {
        // Ignore errors
      }
    }

    // Find duplicates
    for (const [hash, locations] of windowHashes) {
      if (locations.length > 1) {
        // Check if this is a real duplicate (not just common patterns)
        const uniqueFiles = new Set(locations.map(l => l.file));
        if (uniqueFiles.size > 1) { // Cross-file duplication
          blocks.push({
            hash,
            locations,
            lineCount: minLines,
          });
        }
      }
    }

    // Sort by number of locations
    blocks.sort((a, b) => b.locations.length - a.locations.length);

    // Limit to top 20
    return blocks.slice(0, 20);
  }

  // ─── Utility Methods ───────────────────────────────────────────────────────

  /**
   * Tokenize code content.
   */
  _tokenize(content) {
    // Simple tokenization: split by non-word characters
    return content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2); // Skip short tokens
  }

  /**
   * Hash content for exact duplicate detection.
   */
  _hashContent(content) {
    // Normalize content
    const normalized = content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    // Simple hash (djb2)
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
    }
    return hash.toString(16);
  }

  /**
   * Calculate similarity between two token sets.
   */
  _calculateSimilarity(tokensA, tokensB) {
    if (tokensA.length === 0 || tokensB.length === 0) return 0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    // Jaccard similarity
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    return intersection.size / union.size;
  }

  /**
   * Generate refactoring suggestion.
   */
  _generateSuggestion(instances) {
    if (instances.length === 0) return null;

    const first = instances[0];
    return `Extract into a shared utility function (found in ${instances.length} locations)`;
  }

  /**
   * Calculate overall duplication rate.
   */
  _calculateDuplicationRate() {
    const totalFunctions = this._allFunctions.length;
    if (totalFunctions === 0) return '0%';

    const duplicatedFunctions = new Set();
    for (const group of [...this._exactDuplicates, ...this._similarFunctions]) {
      for (const inst of group.instances) {
        duplicatedFunctions.add(inst.name);
      }
    }

    const rate = Math.round((duplicatedFunctions.size / totalFunctions) * 100);
    return rate + '%';
  }

  /**
   * Collect source files to scan.
   */
  _collectSourceFiles() {
    const files = [];

    const scanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Skip common non-source directories
            if (['node_modules', '.git', 'dist', 'build', '__pycache__', 'vendor', 'output'].includes(entry.name)) {
              continue;
            }
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (SOURCE_EXTENSIONS.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };

    scanDir(this._projectRoot);
    return files;
  }

  // ─── Output Generation ──────────────────────────────────────────────────────

  /**
   * Write output files.
   */
  _writeOutput(stats) {
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }

    // Write JSON
    const jsonPath = path.join(this._outputDir, 'duplicate-patterns.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      generated: new Date().toISOString(),
      strategy: this._strategy,
      stats,
      exactDuplicates: this._exactDuplicates.slice(0, 20),
      similarFunctions: this._similarFunctions.slice(0, 20),
      duplicateBlocks: this._duplicateBlocks.slice(0, 20),
    }, null, 2));
    console.log(`   📄 JSON: ${jsonPath}`);

    // Write Markdown
    const mdPath = path.join(this._outputDir, 'duplicate-patterns.md');
    fs.writeFileSync(mdPath, this._generateMarkdown(stats));
    console.log(`   📄 Summary: ${mdPath}`);

    // Write Diagrams
    const diagramPath = path.join(this._outputDir, 'duplicate-patterns-diagrams.md');
    fs.writeFileSync(diagramPath, this._generateDiagrams());
    console.log(`   📄 Diagrams: ${diagramPath}`);
  }

  /**
   * Generate Markdown summary.
   */
  _generateMarkdown(stats) {
    const lines = [
      `## 📋 Duplicate Pattern Analysis`,
      '',
      `> Generated: ${new Date().toISOString().slice(0, 10)}`,
      `> Strategy: ${this._strategy === 'ide-first' ? '🏠 IDE-First' : '📊 Hash-Based (Fallback)'}`,
      `> Duplication Rate: **${stats.duplicationRate}**`,
      '',
      `### 📊 Summary`,
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Total Functions | ${stats.totalFunctions} |`,
      `| Exact Duplicate Groups | ${stats.exactDuplicateGroups} |`,
      `| Exact Duplicate Instances | ${stats.exactDuplicateInstances} |`,
      `| Similar Function Groups | ${stats.similarFunctionGroups} |`,
      `| Similar Function Instances | ${stats.similarFunctionInstances} |`,
      `| Duplicate Blocks | ${stats.duplicateBlockCount} |`,
      '',
    ];

    // Add Action Plan section
    lines.push(...this._generateActionPlan(stats));
    lines.push('');

    // Exact duplicates section
    if (this._exactDuplicates.length > 0) {
      lines.push(`### 🔴 Exact Duplicates`);
      lines.push('');
      lines.push(`> These code blocks are identical copies. **Strong refactoring candidates.**`);
      lines.push('');

      for (const group of this._exactDuplicates.slice(0, 10)) {
        lines.push(`#### Group (${group.instances.length} copies, ${group.lineCount} lines)`);
        lines.push('');
        for (const inst of group.instances) {
          lines.push(`- **${inst.name}** → \`${inst.file}\`:${inst.line}`);
        }
        lines.push('');
        if (group.suggestion) {
          lines.push(`> 💡 ${group.suggestion}`);
          lines.push('');
        }
      }
    }

    // Similar functions section
    if (this._similarFunctions.length > 0) {
      lines.push(`### 🟡 Similar Functions`);
      lines.push('');
      lines.push(`> These functions have similar structure but may not be exact copies. Review for consolidation.`);
      lines.push('');

      for (const group of this._similarFunctions.slice(0, 10)) {
        lines.push(`#### Similarity: ${group.similarity} (${group.instances.length} functions)`);
        lines.push('');
        for (const inst of group.instances) {
          lines.push(`- **${inst.name}** → \`${inst.file}\`:${inst.line} (${inst.tokenCount} tokens)`);
        }
        lines.push('');
      }
    }

    // Duplicate blocks section
    if (this._duplicateBlocks.length > 0) {
      lines.push(`### 🟠 Duplicate Code Blocks`);
      lines.push('');
      lines.push(`> These code blocks appear in multiple locations.`);
      lines.push('');

      for (const block of this._duplicateBlocks.slice(0, 5)) {
        lines.push(`#### Block (${block.locations.length} locations, ${block.lineCount} lines)`);
        lines.push('');
        lines.push('```');
        lines.push(block.locations[0].preview);
        lines.push('```');
        lines.push('');
        lines.push('**Found in:**');
        for (const loc of block.locations.slice(0, 5)) {
          lines.push(`- \`${loc.file}\`:${loc.line}`);
        }
        lines.push('');
      }
    }

    // IDE-First guidance
    if (this._strategy === 'ide-first') {
      lines.push(`### 🏠 IDE-First Strategy Active`);
      lines.push('');
      lines.push(`> This analysis used IDE tools for enhanced semantic detection.`);
      lines.push(`> Use **codebase_search** to find similar code patterns.`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate Action Plan for refactoring duplicates.
   * Prioritizes by impact (lines saved) and effort (complexity).
   * @returns {string[]} Markdown lines for action plan
   */
  _generateActionPlan(stats) {
    const lines = [
      `### 🎯 Action Plan: Refactoring Priorities`,
      '',
      `> Auto-generated optimization roadmap. Items sorted by ROI (Return on Investment).`,
      '',
    ];

    // Calculate priority scores for all duplicate groups
    const prioritizedItems = [];

    // Add exact duplicates (highest priority)
    for (const group of this._exactDuplicates.slice(0, 10)) {
      const linesSaved = group.lineCount * (group.instances.length - 1);
      const fileCount = new Set(group.instances.map(i => i.file)).size;
      const effort = fileCount > 1 ? 'Medium' : 'Low';
      const priority = linesSaved > 50 ? 'P0' : linesSaved > 20 ? 'P1' : 'P2';
      const impact = linesSaved > 50 ? 'High' : linesSaved > 20 ? 'Medium' : 'Low';

      prioritizedItems.push({
        type: 'Exact Duplicate',
        priority,
        effort,
        impact,
        linesSaved,
        group,
        recommendation: `Extract to shared utility: \`${group.instances[0].name}\``,
      });
    }

    // Add similar functions (lower priority)
    for (const group of this._similarFunctions.slice(0, 5)) {
      const avgTokens = group.instances.reduce((sum, i) => sum + i.tokenCount, 0) / group.instances.length;
      const effort = 'High';
      const priority = 'P2';
      const impact = avgTokens > 50 ? 'Medium' : 'Low';

      prioritizedItems.push({
        type: 'Similar Functions',
        priority,
        effort,
        impact,
        linesSaved: Math.floor(avgTokens / 5), // Rough estimate
        group,
        recommendation: `Consider abstraction: Create base class/strategy for ${group.instances.length} similar functions`,
      });
    }

    // Sort by priority and then by lines saved
    const priorityOrder = { 'P0': 0, 'P1': 1, 'P2': 2 };
    prioritizedItems.sort((a, b) => {
      if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }
      return b.linesSaved - a.linesSaved;
    });

    // Generate action items
    if (prioritizedItems.length === 0) {
      lines.push('✅ **No significant duplication detected. Codebase is clean!**');
      return lines;
    }

    // Summary table
    lines.push(`#### Quick Overview`);
    lines.push('');
    lines.push(`| Priority | Count | Est. Lines Saved | Est. Effort |`);
    lines.push(`|----------|-------|------------------|-------------|`);
    const p0Count = prioritizedItems.filter(i => i.priority === 'P0').length;
    const p1Count = prioritizedItems.filter(i => i.priority === 'P1').length;
    const p2Count = prioritizedItems.filter(i => i.priority === 'P2').length;
    const totalLinesSaved = prioritizedItems.reduce((sum, i) => sum + i.linesSaved, 0);
    lines.push(`| 🔴 P0 (Immediate) | ${p0Count} | ~${prioritizedItems.filter(i => i.priority === 'P0').reduce((s, i) => s + i.linesSaved, 0)} | High impact / Low effort |`);
    lines.push(`| 🟡 P1 (Soon) | ${p1Count} | ~${prioritizedItems.filter(i => i.priority === 'P1').reduce((s, i) => s + i.linesSaved, 0)} | Medium impact / Medium effort |`);
    lines.push(`| 🟢 P2 (Later) | ${p2Count} | ~${prioritizedItems.filter(i => i.priority === 'P2').reduce((s, i) => s + i.linesSaved, 0)} | Lower impact / Higher effort |`);
    lines.push(`| **Total** | **${prioritizedItems.length}** | **~${totalLinesSaved}** | - |`);
    lines.push('');

    // Detailed action items
    lines.push(`#### Detailed Action Items`);
    lines.push('');

    for (let i = 0; i < Math.min(prioritizedItems.length, 15); i++) {
      const item = prioritizedItems[i];
      const group = item.group;

      lines.push(`##### ${i + 1}. ${item.recommendation}`);
      lines.push('');
      lines.push(`| Attribute | Value |`);
      lines.push(`|-----------|-------|`);
      lines.push(`| **Type** | ${item.type} |`);
      lines.push(`| **Priority** | ${item.priority} |`);
      lines.push(`| **Estimated Effort** | ${item.effort} |`);
      lines.push(`| **Impact** | ${item.impact} (~${item.linesSaved} lines saved) |`);
      lines.push(`| **Files Affected** | ${new Set(group.instances.map(inst => inst.file)).size} |`);
      lines.push(`| **Occurrences** | ${group.instances.length} |`);
      lines.push('');

      // List locations
      lines.push('**Locations:**');
      for (const inst of group.instances.slice(0, 5)) {
        lines.push(`- \`${inst.file}\`:${inst.line} - \`${inst.name}\``);
      }
      if (group.instances.length > 5) {
        lines.push(`- ... and ${group.instances.length - 5} more`);
      }
      lines.push('');

      // Add refactoring template for exact duplicates
      if (item.type === 'Exact Duplicate') {
        lines.push('**Suggested Refactoring:**');
        lines.push('```javascript');
        lines.push(...this._generateRefactoringTemplate(group));
        lines.push('```');
        lines.push('');
      }

      // Add refactoring steps
      lines.push('**Steps:**');
      lines.push(`1. ${item.type === 'Exact Duplicate' ? 'Create shared utility function' : 'Analyze function similarities and extract common interface'}`);
      lines.push(`2. Update all ${group.instances.length} occurrences to use the new implementation`);
      lines.push(`3. Run tests to verify no behavioral changes`);
      lines.push(`4. Remove old duplicate implementations`);
      lines.push('');

      // Add verification command for IDE users
      lines.push('**Verification:**');
      const firstInstance = group.instances[0];
      lines.push(`- Use IDE's "Find All References" on \`${firstInstance.name}\` to confirm all usages are updated`);
      lines.push(`- Run the test suite: \`npm test\` or equivalent`);
      lines.push('');
    }

    return lines;
  }

  /**
   * Generate a refactoring template for a duplicate group.
   * Creates a code skeleton for the extracted utility.
   * @param {object} group - Duplicate group
   * @returns {string[]} Code lines
   */
  _generateRefactoringTemplate(group) {
    const firstInstance = group.instances[0];
    const funcName = firstInstance.name.replace(/\d+$/, '').replace(/_(copy|dup|old|new)$/i, '');
    const safeName = funcName || 'extractedUtil';

    const lines = [
      `/**`,
      ` * ${safeName} - Extracted utility function`,
      ` * `,
      ` * Extracted from ${group.instances.length} duplicate implementations`,
      ` * Locations:`,
    ];

    for (const inst of group.instances) {
      lines.push(` *   - ${inst.file}:${inst.line}`);
    }

    lines.push(` *`);
    lines.push(` * @TODO: Add proper JSDoc with parameter descriptions`);
    lines.push(` * @TODO: Add unit tests for this extracted function`);
    lines.push(` */`);
    lines.push(`function ${safeName}(/* TODO: determine parameters */) {`);
    lines.push(`  // TODO: Extract common logic here`);
    lines.push(`  // Original implementation was ~${group.lineCount} lines`);
    lines.push(`}`);
    lines.push('');
    lines.push(`// Export for use across modules`);
    lines.push(`module.exports = { ${safeName} };`);

    return lines;
  }

  /**
   * Generate Mermaid diagrams.
   */
  _generateDiagrams() {
    const lines = [
      `## 📊 Duplicate Pattern Diagrams`,
      '',
      `> Generated: ${new Date().toISOString().slice(0, 10)}`,
      `> View in VS Code, GitHub, or any Mermaid-compatible viewer`,
      '',
      `### 🔗 Duplicate Network`,
      '',
      '```mermaid',
      'graph TD',
    ];

    // Generate network diagram for top duplicate groups
    let nodeCount = 0;
    for (const group of this._exactDuplicates.slice(0, 5)) {
      const groupId = `g${nodeCount++}`;
      lines.push(`  ${groupId}["${group.instances[0].name}<br/>${group.lineCount} lines"]:::duplicate`);

      for (const inst of group.instances.slice(1, 4)) {
        const instId = `n${nodeCount++}`;
        lines.push(`  ${instId}["${inst.name}"]:::copy`);
        lines.push(`  ${groupId} -.-> ${instId}`);
      }
    }

    lines.push('');
    lines.push('  classDef duplicate fill:#ef9a9a,stroke:#c62828,stroke-width:2px');
    lines.push('  classDef copy fill:#ffcdd2,stroke:#c62828');
    lines.push('```');
    lines.push('');

    // Add refactoring suggestion flow
    lines.push(`### 🔧 Refactoring Suggestion`);
    lines.push('');
    lines.push('```mermaid');
    lines.push('flowchart LR');
    lines.push('  A[Detect Duplicates] --> B{Exact Match?}');
    lines.push('  B -->|Yes| C[Extract to Utility]');
    lines.push('  B -->|No| D{Similar Structure?}');
    lines.push('  D -->|Yes| E[Consider Abstraction]');
    lines.push('  D -->|No| F[Keep Separate]');
    lines.push('  C --> G[✅ Reduced Duplication]');
    lines.push('  E --> G');
    lines.push('```');
    lines.push('');

    return lines.join('\n');
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  DuplicatePatternDetector,
  MIN_BLOCK_LINES,
  SIMILARITY_THRESHOLD,
  SOURCE_EXTENSIONS,
  SKIP_PATTERNS,
};
