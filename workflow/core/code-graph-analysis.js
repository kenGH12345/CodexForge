/**
 * Code Graph – Analysis Mixin (P1-1)
 *
 * Extracted from code-graph.js to reduce the god file.
 * Contains hotspot analysis, symbol classification, importance weights,
 * category statistics, reusable symbols digest, and markdown output for
 * hotspots and module summaries.
 *
 * These methods are mixed into CodeGraph.prototype via Object.assign,
 * so all `this._symbols`, `this._callEdges`, etc. references resolve correctly.
 *
 * @module code-graph-analysis
 */

'use strict';

const path = require('path');

// ─── Analysis Mixin ───────────────────────────────────────────────────────────

const CodeGraphAnalysisMixin = {

  // ─── Hotspot Analysis ─────────────────────────────────────────────────────

  /**
   * Build a reverse-index: symbolId → calledBy count + caller list.
   * This is the foundation for all hotspot/reuse analysis.
   *
   * P1-2: Results are cached in this._calledByIndex. Invalidated when
   * _buildTokenIndex() is called (which happens after build/patch).
   *
   * @returns {Map<string, { count: number, callers: string[] }>}
   */
  _buildCalledByIndex() {
    // P1-2: Return cached index if available (avoids redundant O(E) traversal)
    if (this._calledByIndex) return this._calledByIndex;

    /** @type {Map<string, { count: number, callers: string[] }>} */
    const calledByIndex = new Map();
    for (const [callerId, callees] of this._callEdges) {
      for (const calleeId of callees) {
        if (!calledByIndex.has(calleeId)) {
          calledByIndex.set(calleeId, { count: 0, callers: [] });
        }
        const entry = calledByIndex.get(calleeId);
        entry.count++;
        entry.callers.push(callerId);
      }
    }
    // Cache for reuse by getHotspots, getCategoryStats, toMarkdown, _computeImportanceWeights
    this._calledByIndex = calledByIndex;
    return calledByIndex;
  },

  // ── P0 Symbol Importance Weights ────────────────────────────────────────

  /**
   * Compute normalised importance weights for all symbols.
   * Weight combines two signals:
   *   1. Cross-file calledBy count (primary, 70%)
   *   2. Imported-by count for the symbol's file (secondary, 30%)
   *
   * Results are cached in this._importanceWeights (Map<symbolId, number>).
   * Invalidated on build() / _patchBuild().
   *
   * @returns {Map<string, number>} symbolId → normalised weight [0, 1]
   */
  _computeImportanceWeights() {
    if (this._importanceWeights) return this._importanceWeights;

    const calledByIndex = this._buildCalledByIndex();

    // Build importedBy index: filePath → number of files that import it
    const importedByCount = new Map();
    for (const [, imports] of this._importEdges) {
      for (const imp of imports) {
        importedByCount.set(imp, (importedByCount.get(imp) || 0) + 1);
      }
    }

    // Compute raw scores (excluding noisy/generic short names that
    // produce artificially inflated cross-file calledBy from regex matching)
    const rawScores = new Map();
    let maxRaw = 0;
    for (const sym of this._symbols.values()) {
      // Skip noisy names – they pollute the weight distribution
      if (this.constructor.isNoisyName(sym.name)) {
        rawScores.set(sym.id, 0);
        continue;
      }
      const cb = (calledByIndex.get(sym.id) || { count: 0 }).count;
      const ib = importedByCount.get(sym.file) || 0;
      // Cross-file calledBy: count callers from different files
      const crossFileCB = (calledByIndex.get(sym.id) || { callers: [] }).callers
        .filter(callerId => callerId.split('::')[0] !== sym.file).length;
      // Weighted combination: cross-file calledBy (70%) + importedBy (30%)
      const raw = crossFileCB * 0.7 + ib * 0.3;
      rawScores.set(sym.id, raw);
      if (raw > maxRaw) maxRaw = raw;
    }

    // Normalise to [0, 1]
    this._importanceWeights = new Map();
    if (maxRaw === 0) {
      for (const id of rawScores.keys()) {
        this._importanceWeights.set(id, 0);
      }
    } else {
      for (const [id, raw] of rawScores) {
        this._importanceWeights.set(id, raw / maxRaw);
      }
    }

    return this._importanceWeights;
  },

  /**
   * Get the importance weight for a symbol (0-1 normalised).
   * @param {string} symbolId
   * @returns {number}
   */
  getImportanceWeight(symbolId) {
    const weights = this._computeImportanceWeights();
    return weights.get(symbolId) || 0;
  },

  /**
   * Classify a symbol into a category based on its call patterns.
   *
   * Categories:
   *  - 'utility'    – High calledBy, low calls-out (pure helper / tool function)
   *  - 'foundation' – High calledBy, moderate calls-out (base class / core service)
   *  - 'hub'        – High both calledBy AND calls-out (central coordinator / manager)
   *  - 'entry'      – Low calledBy, high calls-out (top-level entry point / controller)
   *  - 'leaf'       – Low calledBy, low calls-out (isolated / leaf function)
   *  - 'orphan'     – Zero calledBy AND zero calls-out (potentially dead code)
   *
   * @param {object} sym - Symbol entry
   * @param {number} calledByCount - Number of callers
   * @param {number} callsOutCount - Number of callees
   * @param {object} thresholds
   * @returns {string} Category label
   */
  classifySymbol(sym, calledByCount, callsOutCount, thresholds = {}) {
    const { highCalledBy = 5, highCallsOut = 5 } = thresholds;
    const isHighCalledBy = calledByCount >= highCalledBy;
    const isHighCallsOut = callsOutCount >= highCallsOut;

    if (calledByCount === 0 && callsOutCount === 0) return 'orphan';
    if (isHighCalledBy && !isHighCallsOut) return 'utility';
    if (isHighCalledBy && isHighCallsOut)  return 'hub';
    if (!isHighCalledBy && isHighCallsOut) return 'entry';
    // Moderate calledBy with low calls-out → foundation
    if (calledByCount >= Math.ceil(highCalledBy * 0.6) && !isHighCallsOut) return 'foundation';
    return 'leaf';
  },

  /**
   * Get hotspot analysis: symbols sorted by calledBy count (descending).
   * Filters out noisy/generic names to provide meaningful results.
   *
   * @param {object} [options]
   * @param {number}  [options.topN=20]           - Max results
   * @param {string}  [options.kind]              - Filter by SymbolKind
   * @param {string}  [options.category]          - Filter by category (utility|foundation|hub|entry|orphan)
   * @param {boolean} [options.includeOrphans=false] - Include orphan symbols (0 refs)
   * @param {boolean} [options.includeNoisy=false]   - Include noisy/generic names
   * @returns {Array<{ symbol: object, calledByCount: number, callsOutCount: number, category: string, callers: string[] }>}
   */
  async getHotspots({ topN = 20, kind = null, category = null, includeOrphans = false, includeNoisy = false } = {}) {
    await this.ensureLoaded();
    if (this._symbols.size === 0) return [];

    const calledByIndex = this._buildCalledByIndex();

    // Compute dynamic thresholds based on project-wide distribution
    const allCounts = [];
    for (const sym of this._symbols.values()) {
      const cb = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const co = (this._callEdges.get(sym.id) || []).length;
      if (!this.constructor.isNoisyName(sym.name)) {
        allCounts.push({ calledBy: cb.count, callsOut: co });
      }
    }
    // Use percentile-based thresholds: "high" = top 15%
    const sortedCB = allCounts.map(c => c.calledBy).sort((a, b) => a - b);
    const sortedCO = allCounts.map(c => c.callsOut).sort((a, b) => a - b);
    const p85CB = sortedCB[Math.floor(sortedCB.length * 0.85)] || 5;
    const p85CO = sortedCO[Math.floor(sortedCO.length * 0.85)] || 5;
    const thresholds = {
      highCalledBy: Math.max(3, p85CB),
      highCallsOut: Math.max(3, p85CO),
    };

    const results = [];
    for (const sym of this._symbols.values()) {
      if (kind && sym.kind !== kind) continue;
      if (!includeNoisy && this.constructor.isNoisyName(sym.name)) continue;

      const calledByEntry = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const callsOut = (this._callEdges.get(sym.id) || []).length;
      const cat = this.classifySymbol(sym, calledByEntry.count, callsOut, thresholds);

      if (category && cat !== category) continue;
      if (!includeOrphans && cat === 'orphan') continue;

      results.push({
        symbol: sym,
        calledByCount: calledByEntry.count,
        callsOutCount: callsOut,
        category: cat,
        callers: calledByEntry.callers,
      });
    }

    // Sort by calledBy count descending, then by callsOut descending
    results.sort((a, b) => b.calledByCount - a.calledByCount || b.callsOutCount - a.callsOutCount);
    return results.slice(0, topN);
  },

  /**
   * Get statistics summary of symbol categories.
   * Filters out noisy names for accurate statistics.
   * @returns {{ total: number, utility: number, foundation: number, hub: number, entry: number, leaf: number, orphan: number }}
   */
  async getCategoryStats() {
    await this.ensureLoaded();
    const calledByIndex = this._buildCalledByIndex();

    // Compute dynamic thresholds (same logic as getHotspots)
    const allCounts = [];
    for (const sym of this._symbols.values()) {
      if (this.constructor.isNoisyName(sym.name)) continue;
      const cb = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const co = (this._callEdges.get(sym.id) || []).length;
      allCounts.push({ calledBy: cb.count, callsOut: co });
    }
    const sortedCB = allCounts.map(c => c.calledBy).sort((a, b) => a - b);
    const sortedCO = allCounts.map(c => c.callsOut).sort((a, b) => a - b);
    const thresholds = {
      highCalledBy: Math.max(3, sortedCB[Math.floor(sortedCB.length * 0.85)] || 5),
      highCallsOut: Math.max(3, sortedCO[Math.floor(sortedCO.length * 0.85)] || 5),
    };

    const stats = { total: this._symbols.size, utility: 0, foundation: 0, hub: 0, entry: 0, leaf: 0, orphan: 0 };

    for (const sym of this._symbols.values()) {
      if (this.constructor.isNoisyName(sym.name)) continue;
      const calledByEntry = calledByIndex.get(sym.id) || { count: 0, callers: [] };
      const callsOut = (this._callEdges.get(sym.id) || []).length;
      const cat = this.classifySymbol(sym, calledByEntry.count, callsOut, thresholds);
      stats[cat] = (stats[cat] || 0) + 1;
    }
    return stats;
  },

  /**
   * Generate a compact Markdown digest of reusable symbols (utilities, foundations, hubs)
   * suitable for injection into Developer/Coding Agent prompts.
   *
   * @param {object} [options]
   * @param {number}  [options.maxItems=15] - Max symbols to include
   * @param {number}  [options.minCalledBy=3] - Min calledBy count to be considered reusable
   * @returns {string} Compact Markdown block
   */
  async getReusableSymbolsDigest({ maxItems = 15, minCalledBy = 3 } = {}) {
    await this.ensureLoaded();
    if (this._symbols.size === 0) return '';

    const hotspots = await this.getHotspots({ topN: 50 });
    const reusable = hotspots.filter(h =>
      h.calledByCount >= minCalledBy &&
      ['utility', 'foundation', 'hub'].includes(h.category)
    ).slice(0, maxItems);

    if (reusable.length === 0) return '';

    const categoryEmoji = { utility: '🔧', foundation: '🏗️', hub: '🔀' };
    const categoryLabel = { utility: 'Utility', foundation: 'Foundation', hub: 'Hub' };

    const lines = [
      '## ♻️ Reusable Symbols (prefer reuse over reinvention)',
      '',
      'These high-frequency symbols are widely used across the codebase.',
      '**When implementing new code, ALWAYS check if these existing functions/classes can be reused before writing new ones.**',
      '',
    ];

    for (const h of reusable) {
      const s = h.symbol;
      const emoji = categoryEmoji[h.category] || '📦';
      const label = categoryLabel[h.category] || h.category;
      const sig = s.signature ? `(${s.signature})` : '';
      const summary = s.summary ? ` – ${s.summary.slice(0, 50)}` : '';
      lines.push(`- ${emoji} **${s.name}**${sig} \`[${label}, ${h.calledByCount} refs]\` in \`${s.file}\`:${s.line}${summary}`);
    }

    lines.push('');
    lines.push('> ⚠️ Modifying these symbols has wide impact. Test thoroughly after changes.');
    return lines.join('\n');
  },

  /**
   * Format hotspot analysis results as Markdown (for /graph hotspot command).
   * @param {number} [topN=20]
   * @returns {string}
   */
  async hotspotsAsMarkdown(topN = 20) {
    await this.ensureLoaded();
    if (this._symbols.size === 0) return '_Code graph not available._';

    const hotspots = await this.getHotspots({ topN });
    if (hotspots.length === 0) return '_No hotspot data available. Run `/graph build` first._';

    const stats = await this.getCategoryStats();
    const categoryEmoji = { utility: '🔧', foundation: '🏗️', hub: '🔀', entry: '🚪', leaf: '🍃', orphan: '👻' };
    const categoryLabel = { utility: 'Utility', foundation: 'Foundation', hub: 'Hub', entry: 'Entry', leaf: 'Leaf', orphan: 'Orphan' };

    const lines = [
      `## 🔥 Hotspot Analysis (Top ${topN})`,
      '',
      `**Category distribution** (${stats.total} total symbols):`,
      `| Category | Count | Description |`,
      `|----------|-------|-------------|`,
      `| 🔧 Utility    | ${stats.utility} | High calledBy, low calls-out (helper/tool functions) |`,
      `| 🏗️ Foundation | ${stats.foundation} | Moderate+ calledBy, low calls-out (base class/core service) |`,
      `| 🔀 Hub        | ${stats.hub} | High calledBy AND calls-out (central coordinator/manager) |`,
      `| 🚪 Entry      | ${stats.entry} | Low calledBy, high calls-out (top-level entry/controller) |`,
      `| 🍃 Leaf       | ${stats.leaf} | Low calledBy, low calls-out (isolated/leaf function) |`,
      `| 👻 Orphan     | ${stats.orphan} | Zero refs in AND out (potentially dead code) |`,
      '',
      '### Top Referenced Symbols',
      '',
      '| # | Symbol | Category | ← Refs | → Calls | File |',
      '|---|--------|----------|--------|---------|------|',
    ];

    for (let i = 0; i < hotspots.length; i++) {
      const h = hotspots[i];
      const s = h.symbol;
      const emoji = categoryEmoji[h.category] || '📦';
      const label = categoryLabel[h.category] || h.category;
      lines.push(`| ${i + 1} | **${s.name}** | ${emoji} ${label} | ${h.calledByCount} | ${h.callsOutCount} | \`${s.file}\`:${s.line} |`);
    }

    lines.push('');
    lines.push('### 💡 Insights');
    lines.push('');

    // Auto-generate insights
    const utilities = hotspots.filter(h => h.category === 'utility');
    const hubs = hotspots.filter(h => h.category === 'hub');
    const entries = hotspots.filter(h => h.category === 'entry');

    if (utilities.length > 0) {
      lines.push(`- **🔧 ${utilities.length} utility symbols** are widely reused. Modifying them impacts many callers – always check reverse dependencies.`);
    }
    if (hubs.length > 0) {
      lines.push(`- **🔀 ${hubs.length} hub symbols** are central coordinators with both high fan-in and fan-out. These are architecture bottlenecks – consider if they have too many responsibilities.`);
    }
    if (entries.length > 0) {
      lines.push(`- **🚪 ${entries.length} entry points** call many functions but are rarely called themselves. These are good starting points for understanding business flows.`);
    }
    if (stats.orphan > 0) {
      lines.push(`- **👻 ${stats.orphan} orphan symbols** have zero connections. Review if they are genuinely unused or just not yet connected.`);
    }

    return lines.join('\n');
  },

  // ── toMarkdown: Human-readable code graph summary ─────────────────────────
  /**
   * Generates a compact Markdown summary of the code graph.
   * Used by code-graph-cache.js to write code-graph.md alongside code-graph.json.
   *
   * @param {object} [options]
   * @param {number} [options.maxSymbols=100] - Max symbols to list in the summary
   * @returns {string} Markdown content
   */
  async toMarkdown({ maxSymbols = 100 } = {}) {
    await this.ensureLoaded();

    const lines = [];
    lines.push(`# Code Graph Summary`);
    lines.push(``);
    lines.push(`> Auto-generated by CodeGraph. Do not edit manually.`);
    lines.push(``);

    // Overview stats
    const fileSet = new Set();
    for (const sym of this._symbols.values()) fileSet.add(sym.file);
    let totalCallEdges = 0;
    for (const edges of this._callEdges.values()) totalCallEdges += edges.length;

    lines.push(`## Overview`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Symbols | ${this._symbols.size} |`);
    lines.push(`| Files | ${fileSet.size} |`);
    lines.push(`| Call edges | ${totalCallEdges} |`);
    lines.push(`| Import edges | ${this._importEdges.size} |`);
    lines.push(``);

    // Category stats (lazy loading may not be complete, skip if not ready)
    if (this._lazyLoaded) {
      try {
        const stats = await this.getCategoryStats();
        lines.push(`## Symbol Categories`);
        lines.push(``);
        lines.push(`| Category | Count |`);
        lines.push(`|----------|-------|`);
        for (const [cat, count] of Object.entries(stats)) {
          if (typeof count === 'number') {
            lines.push(`| ${cat} | ${count} |`);
          }
        }
        lines.push(``);
      } catch { /* non-critical */ }

      // Hotspots
      try {
        const md = await this.hotspotsAsMarkdown(20);
        if (md) {
          lines.push(md);
          lines.push(``);
        }
      } catch { /* non-critical */ }
    }

    // Top symbols by file
    lines.push(`## Top Files by Symbol Count`);
    lines.push(``);
    const fileCounts = new Map();
    for (const sym of this._symbols.values()) {
      fileCounts.set(sym.file, (fileCounts.get(sym.file) || 0) + 1);
    }
    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    lines.push(`| File | Symbols |`);
    lines.push(`|------|---------|`);
    for (const [file, count] of topFiles) {
      lines.push(`| ${file} | ${count} |`);
    }
    lines.push(``);

    return lines.join('\n');
  },

};

module.exports = { CodeGraphAnalysisMixin };
