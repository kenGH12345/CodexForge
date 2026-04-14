/**
 * Enrichment Budget Guard
 *
 * Manages cumulative character budget for ANALYSE stage enrichment blocks.
 * Prevents context overflow by prioritising and compressing enrichment content
 * before it reaches the LLM.
 *
 * Architecture:
 *   - Phase 1 (Pre-compress): SemanticCompressor compresses large blocks
 *     BEFORE appending, reducing input-side token waste
 *   - Phase 2 (Budget enforce): Priority-based truncation when total chars
 *     exceed ENRICHMENT_BUDGET_CHARS
 *   - Phase 3 (Output): structured-output skill (SKILL_ROLE_FILTER) handles
 *     output-side compression — this guard does NOT duplicate that
 *
 * Token compression integration:
 *   - Reuses SemanticCompressor singleton from token-budget.js
 *   - Compresses blocks > ENRICHMENT_COMPRESS_THRESHOLD chars before append
 *   - Records compression stats in getStats() for observability
 *
 * @see ADR-46 (structured-output skill)
 * @see ADR-49 (anchor-driven code reading)
 */

'use strict';

const { SemanticCompressor } = require('./semantic-compressor');

// ─── Constants ────────────────────────────────────────────────────────────────

const ENRICHMENT_BUDGET_CHARS = 14000;

const ENRICHMENT_PRIORITIES = {
  EXPERIENCE:     80,
  ANCHOR_FILES:   75,
  CODE_GRAPH_SEED: 60,
  WEB_SEARCH:     50,
  SESSION_MEMORY: 40,
};

const MIN_BLOCK_SIZE = 200;

const ENRICHMENT_COMPRESS_THRESHOLD = 3000;

// Lazy SemanticCompressor instance (shared across calls)
let _compressorInstance = null;

function _getCompressor() {
  if (!_compressorInstance) {
    _compressorInstance = new SemanticCompressor({ targetRatio: 0.7 });
  }
  return _compressorInstance;
}

/**
 * Injects a cheap LLM call into the module-level SemanticCompressor instance.
 * Called by the Orchestrator during initialisation.
 *
 * @param {Function} llmCall - Async function: (prompt: string) => string
 */
function setEnrichmentCompressorCheapLlm(llmCall) {
  _getCompressor().setCheapLlmCall(llmCall);
}

// ─── EnrichmentBudgetGuard ────────────────────────────────────────────────────

class EnrichmentBudgetGuard {
  /**
   * @param {Object} [options]
   * @param {number} [options.totalBudgetChars=ENRICHMENT_BUDGET_CHARS]
   * @param {number} [options.minBlockSize=MIN_BLOCK_SIZE]
   * @param {number} [options.compressThreshold=ENRICHMENT_COMPRESS_THRESHOLD]
   * @param {boolean} [options.enableCompression=true]
   * @param {string} [options.baseContent=''] - Initial content (e.g. scope prefix)
   */
  constructor(options = {}) {
    this.totalBudgetChars = options.totalBudgetChars ?? ENRICHMENT_BUDGET_CHARS;
    this.minBlockSize = options.minBlockSize ?? MIN_BLOCK_SIZE;
    this.compressThreshold = options.compressThreshold ?? ENRICHMENT_COMPRESS_THRESHOLD;
    this.enableCompression = options.enableCompression !== false;
    this.baseContent = options.baseContent || '';
    this._blocks = [];
    this._compressionStats = [];
  }

  /**
   * Append an enrichment block with priority and optional pre-compression.
   *
   * @param {string} label - Block identifier (e.g. 'WEB_SEARCH', 'EXPERIENCE')
   * @param {string} content - Block content
   * @param {number} priority - Priority (higher = more important, truncated last)
   * @param {Object} [options]
   * @param {boolean} [options.skipCompression=false] - Force skip pre-compression
   * @returns {Promise<{appended: boolean, compressed: boolean, originalChars: number, finalChars: number}>}
   */
  async append(label, content, priority, options = {}) {
    if (!content || content.trim().length === 0) {
      return { appended: false, compressed: false, originalChars: 0, finalChars: 0 };
    }

    const originalChars = content.length;
    let finalContent = content;
    let compressed = false;

    // Phase 1: Pre-compress large blocks using SemanticCompressor
    if (
      this.enableCompression
      && !options.skipCompression
      && content.length > this.compressThreshold
    ) {
      try {
        const compressor = _getCompressor();
        const result = await compressor.compress(content, {
          contentType: 'text',
          targetRatio: 0.7,
        });
        if (result.saved > 100 && result.ratio < 0.85) {
          finalContent = result.content;
          compressed = true;
          this._compressionStats.push({
            label,
            originalChars,
            compressedChars: finalContent.length,
            saved: result.saved,
            ratio: result.ratio,
            strategy: result.strategy,
          });
          console.error(
            `[EnrichmentGuard] 🗜️  Pre-compressed "${label}": ${originalChars} → ${finalContent.length} chars (ratio=${result.ratio.toFixed(2)}, strategy=${result.strategy})`
          );
        }
      } catch (err) {
        console.warn(`[EnrichmentGuard] ⚠️  Pre-compression failed for "${label}" (non-fatal): ${err.message}`);
      }
    }

    this._blocks.push({
      label,
      content: finalContent,
      priority,
      originalChars,
      compressed,
      _order: this._blocks.length,
    });

    return {
      appended: true,
      compressed,
      originalChars,
      finalChars: finalContent.length,
    };
  }

  /**
   * Assemble all blocks into a single string, enforcing budget constraints.
   * Blocks exceeding budget are truncated (low priority first) or dropped.
   *
   * @returns {string} Assembled content within budget
   */
  getAssembled() {
    const baseChars = this.baseContent.length;
    let remaining = this.totalBudgetChars - baseChars;

    if (remaining <= 0) {
      console.warn(`[EnrichmentGuard] ⚠️  Base content (${baseChars} chars) already exceeds budget (${this.totalBudgetChars}). Returning base only.`);
      return this.baseContent;
    }

    // Sort by priority descending (highest first)
    const sorted = [...this._blocks].sort((a, b) => b.priority - a.priority);

    // Calculate total
    const totalBlockChars = sorted.reduce((sum, b) => sum + b.content.length, 0);

    if (baseChars + totalBlockChars <= this.totalBudgetChars) {
      // Under budget — no truncation needed
      const ordered = [...this._blocks].sort((a, b) => a._order - b._order);
      return this.baseContent + ordered.map(b => b.content).join('\n\n');
    }

    // Over budget — apply priority-based truncation
    const truncated = [];
    const dropped = [];
    let currentTotal = totalBlockChars;

    // Phase 1: Truncate low-priority blocks to minBlockSize (ascending = lowest first)
    const ascending = [...sorted].sort((a, b) => a.priority - b.priority);
    for (const block of ascending) {
      if (currentTotal + baseChars <= this.totalBudgetChars) break;
      if (block.content.length <= this.minBlockSize) continue;

      const excess = (currentTotal + baseChars) - this.totalBudgetChars;
      const canTrim = block.content.length - this.minBlockSize;
      const trimAmount = Math.min(excess, canTrim);

      if (trimAmount > 0) {
        const originalLen = block.content.length;
        const newLen = originalLen - trimAmount;
        const truncateAt = block.content.lastIndexOf('\n', newLen);
        const cutPoint = truncateAt > this.minBlockSize ? truncateAt : newLen;
        const truncSuffix = `\n\n> ⚠️ _[Truncated: ${block.label} reduced from ${originalLen} to ${cutPoint} chars due to enrichment budget]_`;
        block.content = block.content.slice(0, cutPoint) + truncSuffix;
        const actualDelta = originalLen - block.content.length;
        currentTotal -= actualDelta;
        truncated.push(`${block.label}(-${actualDelta})`);
      }
    }

    // Phase 2: Drop lowest-priority blocks entirely if still over
    for (const block of ascending) {
      if (currentTotal + baseChars <= this.totalBudgetChars) break;
      const blockLen = block.content.length;
      if (blockLen === 0) continue;
      currentTotal -= blockLen;
      dropped.push(block.label);
      block.content = '';
    }

    if (dropped.length > 0) {
      console.warn(`[EnrichmentGuard] 🗑️  Dropped enrichment blocks: ${dropped.join(', ')}`);
    }
    if (truncated.length > 0) {
      console.warn(`[EnrichmentGuard] ✂️  Truncated enrichment blocks: ${truncated.join(', ')}`);
    }

    // Re-assemble in original insertion order
    const ordered = [...this._blocks].sort((a, b) => a._order - b._order);
    const result = this.baseContent + ordered
      .filter(b => b.content && b.content.trim().length > 0)
      .map(b => b.content)
      .join('\n\n');

    console.error(`[EnrichmentGuard] 📊 Final enrichment: ${result.length} chars (budget: ${this.totalBudgetChars}, base: ${baseChars}, blocks: ${this._blocks.length}, dropped: ${dropped.length}, truncated: ${truncated.length})`);

    return result;
  }

  /**
   * Get budget utilisation statistics.
   *
   * @returns {Object} Stats object
   */
  getStats() {
    const baseChars = this.baseContent.length;
    const blockChars = this._blocks.reduce((sum, b) => sum + b.content.length, 0);
    const totalChars = baseChars + blockChars;
    const originalTotalChars = baseChars + this._blocks.reduce((sum, b) => sum + b.originalChars, 0);

    return {
      totalBudgetChars: this.totalBudgetChars,
      baseChars,
      blockChars,
      totalChars,
      originalTotalChars,
      usedChars: totalChars,
      remainingChars: Math.max(0, this.totalBudgetChars - totalChars),
      blocksCount: this._blocks.length,
      droppedBlocks: this._blocks.filter(b => b.content.trim().length === 0).length,
      compressedBlocks: this._blocks.filter(b => b.compressed).length,
      compressionStats: this._compressionStats,
      utilizationRate: totalChars / this.totalBudgetChars,
    };
  }
}

module.exports = {
  EnrichmentBudgetGuard,
  ENRICHMENT_BUDGET_CHARS,
  ENRICHMENT_PRIORITIES,
  MIN_BLOCK_SIZE,
  ENRICHMENT_COMPRESS_THRESHOLD,
  setEnrichmentCompressorCheapLlm,
};
