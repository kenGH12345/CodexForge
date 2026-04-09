/**
 * Context Budget Manager
 *
 * Extracted from orchestrator-stage-helpers.js to decompose the 1,800+ line
 * monolith into testable, focused modules (each < 400 lines).
 *
 * This module owns:
 *   - Token budget constants and priority-based truncation algorithm
 *   - Web search cache, helpers, and formatters
 *   - External experience fallback (cold-start enhancement)
 *   - All MCP adapter helper functions (package registry, security CVE,
 *     CI status, license compliance, doc gen, LLM cost router, Figma design,
 *     test infra, code quality)
 *
 * All functions receive `orch` (the Orchestrator instance) as first arg
 * to access services, projectRoot, etc. without `this`-binding gymnastics.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { BlockCompressor } = require('./block-compressor');
const { SemanticCompressor } = require('./semantic-compressor');

// Singleton compressor instances (stateless, safe to share)
const _compressor = new BlockCompressor();
const _semanticCompressor = new SemanticCompressor({ targetRatio: 0.7 });

/**
 * Injects a cheap LLM call into the module-level SemanticCompressor singleton.
 * Called by the Orchestrator during initialisation to enable LLM-based
 * summarisation in the token budget pipeline.
 *
 * @param {Function} llmCall - Async function: (prompt: string) => string
 */
function setSemanticCompressorCheapLlm(llmCall) {
  _semanticCompressor.setCheapLlmCall(llmCall);
}

// ─── Token Budget Guard ──────────────────────────────────────────────────────

/**
 * Per-stage context window budget (in characters).
 *
 * Rationale: Most LLMs accept 128k–200k tokens. 1 token ≈ 4 chars (English) or
 * ≈ 2 chars (Chinese). We reserve ~30% for the model's own generation, leaving
 * ~90k tokens ≈ 360k chars for input. But upstream context (system prompt +
 * agent instructions + code files) already occupies ~40-60% of the budget.
 * So the *injected enrichment blocks* (web search, security, packages, quality,
 * experience) should stay within ~60k chars per stage.
 *
 * Each block has a priority. When the total exceeds the budget, lower-priority
 * blocks are truncated first (down to their minimum useful size), then dropped
 * entirely if still over.
 */
/**
 * A-2 Architecture Fix: Unified Budget Constants
 *
 * The system has three budget layers with DIFFERENT units:
 *   L1 – ContextLoader (context-loader.js): MAX_INJECT_TOKENS = 2800 tokens
 *   L2 – Stage Budget  (this file):         STAGE_TOKEN_BUDGET_CHARS = 60000 chars ≈ 15000 tokens
 *   L3 – Prompt Guard   (prompt-builder.js): HALLUCINATION_RISK_THRESHOLD = 16000 tokens
 *
 * L2 uses chars intentionally (avoids per-block estimateTokens() overhead). But
 * all three layers now expose their budget in BOTH units for cross-layer diagnostics.
 *
 * Data flow: Content passes through L1 → L2 → L3 sequentially. Each layer
 * operates independently, but total truncation should be monitored via
 * getBudgetSummary() to detect double-truncation anomalies.
 */
const CHARS_PER_TOKEN = 4; // Must stay in sync with constants.js LLM.CHARS_PER_TOKEN
const STAGE_TOKEN_BUDGET_CHARS = 60000; // ~15k tokens – safe margin for enrichment blocks
const STAGE_TOKEN_BUDGET_TOKENS = Math.floor(STAGE_TOKEN_BUDGET_CHARS / CHARS_PER_TOKEN); // 15000 tokens

/**
 * Per-stage budget multipliers.
 *
 * Rationale: Not all stages consume the same amount of enrichment context.
 *   - ANALYSE: Minimal adapter data needed (mostly requirement text + experience).
 *   - ARCHITECT: Moderate — needs code graph, security, quality, but not full budget.
 *   - PLAN: Minimal — mostly consumes upstream context from ANALYSE + ARCHITECT.
 *   - DEVELOPER: Maximum — needs code graph, packages, CI, quality, experience, etc.
 *   - TESTER: Moderate-high — needs test infra, CI status, execution results.
 *
 * By giving lighter stages a smaller budget, we:
 *   1. Reduce unnecessary truncation warnings (budget rarely exceeded → cleaner logs)
 *   2. Tighten the signal-to-noise ratio (less room = less low-value content injected)
 *   3. Save ~15-20% total token consumption across a full workflow run
 *
 * The multiplier is applied to STAGE_TOKEN_BUDGET_CHARS in _applyTokenBudget().
 * Stages not listed here default to 1.0 (full budget).
 */
const STAGE_BUDGET_MULTIPLIERS = {
  ANALYSE:   0.6,   // 36K chars — requirement analysis needs minimal enrichment
  ARCHITECT: 0.85,  // 51K chars — architecture needs code graph + security + quality
  PLAN:      0.5,   // 30K chars — planning mostly uses upstream context, little enrichment
  DEVELOPER: 1.0,   // 60K chars — full budget, heaviest enrichment consumer
  TESTER:    0.85,  // 51K chars — test needs CI + test infra + execution results
  ENTROPY:   0.3,   // 18K chars — entropy scan is lightweight
  CI:        0.4,   // 24K chars — CI stage is lightweight
};

/**
 * Priority levels for context blocks (higher = more important, kept longer).
 */
const BLOCK_PRIORITY = {
  // Critical – always kept
  JSON_INSTRUCTION: 100,
  TECH_STACK_PREFIX: 95,
  AGENTS_MD: 90,
  UPSTREAM_CTX: 85,
  EXPERIENCE: 80,
  COMPLAINTS: 75,
  // High – important enrichment
  CODE_GRAPH: 70,
  SECURITY_CVE: 65,
  CI_STATUS: 63,
  CODE_QUALITY: 60,
  LICENSE_COMPLIANCE: 58,
  LLM_COST: 57,
  // Medium – valuable but expendable under pressure
  PACKAGE_REGISTRY: 55,
  API_RESEARCH: 50,
  INDUSTRY_RESEARCH: 50,
  TEST_BEST_PRACTICES: 50,
  REAL_EXECUTION: 70,
  UNDOCUMENTED_EXPORTS: 45,
  TEST_INFRA: 43,
  // Medium-low – UI-specific enrichment
  FIGMA_DESIGN: 52,
  // Low – nice-to-have fallbacks
  EXTERNAL_EXPERIENCE: 30,
};

/**
 * Applies a token budget to an array of labelled context blocks.
 * Blocks are sorted by priority; lower-priority blocks are truncated/dropped
 * first when the total exceeds the budget.
 *
 * @param {Array<{label: string, content: string, priority: number}>} blocks
 * @param {number} [budget=STAGE_TOKEN_BUDGET_CHARS]
 * @returns {{ assembled: string, stats: {total: number, dropped: string[], truncated: string[]} }}
 */
async function _applyTokenBudget(blocks, budget = STAGE_TOKEN_BUDGET_CHARS, opts = {}) {
  const { telemetry = null, stage = 'UNKNOWN', profile = null } = opts;

  // Per-stage budget adjustment: apply stage-specific multiplier when caller
  // uses the default budget (i.e. didn't pass an explicit override).
  // This ensures ANALYSE/PLAN get tighter budgets while DEVELOPER keeps full budget.
  if (budget === STAGE_TOKEN_BUDGET_CHARS && STAGE_BUDGET_MULTIPLIERS[stage]) {
    budget = Math.floor(STAGE_TOKEN_BUDGET_CHARS * STAGE_BUDGET_MULTIPLIERS[stage]);
  }

  // Filter out empty blocks
  const active = blocks.filter(b => b.content && b.content.length > 0);

  // ── Phase 0: Block Compression ─────────────────────────────────────────
  // Compress verbose adapter blocks (Markdown tables → JSON shorthand)
  // BEFORE checking the budget. This maximises information density.
  const { totalSaved: compressionSaved, compressedLabels } = _compressor.compressBlocks(active);

  // ── Phase 0.5: Tool Result Pre-filtering (P1 Programmatic Tool Calling) ──
  // Inspired by Claude's "Programmatic Tool Calling" pattern: large adapter
  // result blocks are pre-filtered BEFORE entering the budget pipeline.
  // This prevents bloated tool results from consuming the entire token budget
  // and forces information extraction at the source.
  //
  // P2 Enhancement: Intent-aware filtering — when a ContextProfile is available,
  // ToolResultFilter uses taskType-specific grep patterns and per-block budget
  // ratios to extract the most relevant content for the current task intent.
  const _toolResultFilter = new ToolResultFilter();
  const { totalSaved: preFilterSaved, filteredLabels: preFilterLabels } = _toolResultFilter.applyToBlocks(active, {
    taskType: profile ? profile.taskType : null,
    profile,
  });

  // ── Phase 0.75: Semantic Compression ──────────────────────────────────────
  // P0 Enhancement: Natural language compression for non-structured blocks.
  // Complements BlockCompressor's 60-65% savings with additional 15-25% on
  // natural language content (experience blocks, research results, etc.)
  let semanticSaved = 0;
  const semanticLabels = [];
  
  // Only apply semantic compression to natural language blocks (not structured data)
  const semanticEligibleLabels = new Set([
    'Experience', 'External Experience', 'Industry Research',
    'API Research', 'Test Best Practices', 'Complaints',
  ]);
  
  for (const block of active) {
    if (semanticEligibleLabels.has(block.label) && block.content.length > 300) {
      const result = await _semanticCompressor.compress(block.content, {
        contentType: 'text',
        targetRatio: 0.7,
      });
      
      if (result.saved > 100 && result.ratio < 0.85) {
        block.content = result.content;
        semanticSaved += result.saved;
        semanticLabels.push(`${block.label}(-${result.saved},${result.strategy})`);
      }
    }
  }
  
  if (semanticLabels.length > 0) {
    console.log(`[TokenBudget] 🧠 Semantic compression: saved ${semanticSaved} chars across [${semanticLabels.join(', ')}]`);
  }

  // Record compression telemetry
  if (telemetry && compressedLabels.length > 0) {
    for (const cl of compressedLabels) {
      const match = cl.match(/^(.+?)\(-\d+\)$/);
      if (match) {
        const label = match[0].replace(/\(-\d+\)$/, '');
        const saved = parseInt(cl.match(/-(\d+)/)[1], 10);
        const block = active.find(b => b.label === label);
        if (block) {
          telemetry.recordCompression(label, stage, block.content.length + saved, block.content.length);
        }
      }
    }
  }

  // Record all injections (non-empty blocks that survived filtering)
  if (telemetry) {
    for (const b of active) {
      telemetry.recordInjection(b.label, stage, b.content.length);
    }
  }

  const totalBefore = active.reduce((sum, b) => sum + b.content.length, 0);

  if (totalBefore <= budget) {
  // Under budget – no truncation needed
    return {
      assembled: active.map(b => b.content).join('\n\n'),
      stats: {
        total: totalBefore,
        estimatedTokens: Math.ceil(totalBefore / CHARS_PER_TOKEN),
        dropped: [],
        truncated: [],
        compressionSaved,
        preFilterSaved,
        preFilterLabels,
        semanticSaved,
        semanticLabels,
      },
    };
  }

  console.warn(`[TokenBudget] ⚠️  Context blocks total ${totalBefore} chars (budget: ${budget}). Applying priority-based truncation.`);

  // Sort by priority descending (highest priority first)
  const sorted = [...active].sort((a, b) => b.priority - a.priority);

  // Minimum useful size per block (headers + first few lines)
  const MIN_BLOCK_SIZE = 200;

  // Phase 1: Try truncating lower-priority blocks to min size
  let currentTotal = totalBefore;
  const truncated = [];
  const dropped = [];

  // Work from lowest priority upward
  for (let i = sorted.length - 1; i >= 0 && currentTotal > budget; i--) {
    const block = sorted[i];
    if (block.content.length <= MIN_BLOCK_SIZE) continue;

    const excess = currentTotal - budget;
    const canTrim = block.content.length - MIN_BLOCK_SIZE;
    const trimAmount = Math.min(excess, canTrim);

    if (trimAmount > 0) {
      // R4-1/R4-2 audit: capture original length BEFORE mutation for accurate logging
      // and correct currentTotal tracking.
      const originalLen = block.content.length;
      const newLen = originalLen - trimAmount;
      // Truncate at a natural boundary (newline)
      const truncateAt = block.content.lastIndexOf('\n', newLen);
      const cutPoint = truncateAt > MIN_BLOCK_SIZE ? truncateAt : newLen;
      const truncSuffix = `\n\n> ⚠️ _[Truncated: ${block.label} reduced from ${originalLen} to ${cutPoint} chars due to token budget]_`;
      block.content = block.content.slice(0, cutPoint) + truncSuffix;
      // R4-2 audit: track actual delta (including truncation suffix) to keep currentTotal accurate.
      // Without this, Phase 2 would use stale block.content.length values.
      const actualDelta = originalLen - block.content.length;
      currentTotal -= actualDelta;
      truncated.push(`${block.label}(-${actualDelta})`);

      // Record truncation telemetry
      if (telemetry) {
        telemetry.recordTruncation(block.label, stage, trimAmount);
      }
    }
  }

  // Phase 2: Drop lowest-priority blocks entirely if still over
  // P0-4 fix: Phase 1 truncation mutated block.content (adding truncation suffix),
  // so block.content.length is already the post-truncation length. We must use
  // the current (post-Phase-1) content length for accurate currentTotal tracking.
  for (let i = sorted.length - 1; i >= 0 && currentTotal > budget; i--) {
    const block = sorted[i];
    const blockLen = block.content.length;
    if (blockLen === 0) continue;
    currentTotal -= blockLen;
    dropped.push(block.label);
    block.content = '';

    // Record drop telemetry
    if (telemetry) {
      telemetry.recordDrop(block.label, stage);
    }
  }

  if (dropped.length > 0) {
    console.warn(`[TokenBudget] 🗑️  Dropped blocks: ${dropped.join(', ')}`);
  }
  if (truncated.length > 0) {
    console.warn(`[TokenBudget] ✂️  Truncated blocks: ${truncated.join(', ')}`);
  }
  console.log(`[TokenBudget] Final context size: ${currentTotal} chars (was ${totalBefore}, saved ${totalBefore - currentTotal}).`);
  if (compressionSaved > 0) {
    console.log(`[TokenBudget] 🗜️  Pre-compression saved additional ${compressionSaved} chars.`);
  }
  if (preFilterSaved > 0) {
    console.log(`[TokenBudget] 🔍 Pre-filtering (Programmatic Tool Calling) saved ${preFilterSaved} chars across [${preFilterLabels.join(', ')}].`);
  }

  // Re-sort back to original insertion order for coherent reading
  // P1-3 fix: plugin blocks may not have _order set (undefined - undefined = NaN).
  // Default to 999 so unordered blocks sort to the end; use index as tiebreaker for stability.
  // R5-4 audit: added trim() guard to prevent whitespace-only blocks from passing filter
  const assembled = sorted
    .filter(b => b.content && b.content.trim().length > 0)
    .sort((a, b) => (a._order ?? 999) - (b._order ?? 999))
    .map(b => b.content)
    .join('\n\n');

  return {
    assembled,
    stats: {
      total: currentTotal,
      estimatedTokens: Math.ceil(currentTotal / CHARS_PER_TOKEN),
      dropped,
      truncated,
      compressionSaved,
      preFilterSaved,
      preFilterLabels,
      semanticSaved,
      semanticLabels,
    },
  };
}


// ─── P1 Optimisation: Tool Result Filter (Programmatic Tool Calling) ─────────
//
// Inspired by Claude's "Programmatic Tool Calling" pattern: instead of letting
// the LLM see raw, unfiltered tool results (e.g. a 500-line file dumped into
// context), we pre-filter / summarise / compress the results before they enter
// the token budget pipeline.
//
// This acts as a **front-gate** filter — applied BEFORE blocks reach
// _applyTokenBudget(). The budget manager handles priority-based truncation
// for blocks that ARE included; ToolResultFilter prevents bloated content
// from ever reaching that stage.
//
// Key strategies:
//   1. Large text truncation: content > threshold is trimmed with head/tail preview
//   2. Repetitive line dedup: adjacent similar lines are collapsed
//   3. Relevance grep: if a relevance pattern is provided, only matching lines + context are kept
//   4. Structured data extraction: JSON/YAML blocks are summarised to keys/stats
//   5. Intent-aware grep: taskType-specific patterns extract the most relevant lines

/**
 * Intent-aware grep patterns per taskType.
 *
 * When ToolResultFilter processes a block and no explicit grepPattern is provided,
 * it falls back to these taskType-specific patterns. This ensures that even without
 * caller-specified patterns, the filter extracts lines most relevant to the current
 * task intent.
 *
 * Each entry maps a taskType to a RegExp that matches high-signal lines for that intent.
 */
const INTENT_GREP_PATTERNS = {
  bugfix: /\b(error|err|fail|bug|crash|exception|stack\s*trace|undefined|null|NaN|reject|throw|catch|fix|patch|regression|broken|issue)\b/i,
  performance: /\b(perf|latency|throughput|cache|memo|lazy|defer|async|await|bottleneck|slow|fast|O\(|time|memory|heap|gc|profile|benchmark|ms\b|\d+ms)\b/i,
  security: /\b(auth|token|secret|password|encrypt|decrypt|hash|salt|csrf|xss|injection|sanitize|escape|cors|helmet|oauth|jwt|permission|role|acl|vulnerability|cve)\b/i,
  ui: /\b(style|css|layout|flex|grid|margin|padding|color|font|theme|responsive|media\s*query|component|render|jsx|tsx|svg|icon|animation|transition)\b/i,
  refactor: /\b(class|function|module|export|import|interface|type|abstract|extend|implement|extract|inline|rename|move|split|merge|decouple|encapsulate|pattern)\b/i,
  docs: /\b(doc|comment|jsdoc|readme|changelog|api|param|return|example|usage|description|summary|@param|@returns|@example|@deprecated|@see)\b/i,
};

/**
 * ToolResultFilter — pre-filters adapter/tool result blocks to reduce token waste.
 *
 * Usage:
 *   const filter = new ToolResultFilter({ maxBlockChars: 8000 });
 *   const filteredContent = filter.apply(rawContent, { grepPattern: /error|warn/i });
 */
class ToolResultFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBlockChars=8000]     - Max chars per block after filtering
   * @param {number} [opts.headLines=40]            - Lines to keep from the start
   * @param {number} [opts.tailLines=20]            - Lines to keep from the end
   * @param {number} [opts.grepContextLines=3]      - Lines of context around grep matches
   * @param {number} [opts.dedupeThreshold=0.85]    - Similarity threshold for dedup (0-1)
   */
  constructor(opts = {}) {
    this.maxBlockChars = opts.maxBlockChars ?? 8000;
    this.headLines = opts.headLines ?? 40;
    this.tailLines = opts.tailLines ?? 20;
    this.grepContextLines = opts.grepContextLines ?? 3;
    this.dedupeThreshold = opts.dedupeThreshold ?? 0.85;
  }

  /**
   * Applies filtering strategies to a raw content block.
   *
   * @param {string} content - Raw content from adapter/tool
   * @param {object} [opts]
   * @param {RegExp} [opts.grepPattern] - If provided, only lines matching this pattern are kept
   * @param {string} [opts.label]       - Block label for logging
   * @returns {{ content: string, stats: { originalChars: number, filteredChars: number, strategy: string } }}
   */
  apply(content, opts = {}) {
    if (!content || typeof content !== 'string') {
      return { content: '', stats: { originalChars: 0, filteredChars: 0, strategy: 'empty' } };
    }

    const originalChars = content.length;

    // P2: Support per-block budget override from intent-aware applyToBlocks
    const effectiveMax = opts.maxBlockChars || this.maxBlockChars;

    // Fast path: content is within budget — no filtering needed
    if (originalChars <= effectiveMax) {
      return { content, stats: { originalChars, filteredChars: originalChars, strategy: 'passthrough' } };
    }

    const label = opts.label || 'unknown';
    let result = content;
    let strategy = '';

    // Strategy 1: Relevance grep — if a pattern is provided, extract matching lines + context
    if (opts.grepPattern) {
      const grepResult = this._grepFilter(result, opts.grepPattern);
      if (grepResult.matchCount > 0) {
        result = grepResult.content;
        strategy = `grep(${grepResult.matchCount} matches)`;
        if (result.length <= effectiveMax) {
          console.log(`[ToolResultFilter] 🔍 ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
          return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
        }
      }
    }

    // Strategy 2: Dedup adjacent similar lines
    const dedupResult = this._deduplicateLines(result);
    if (dedupResult.removedCount > 0) {
      result = dedupResult.content;
      strategy += (strategy ? ' + ' : '') + `dedup(${dedupResult.removedCount} lines)`;
      if (result.length <= effectiveMax) {
        console.log(`[ToolResultFilter] 🔁 ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
        return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
      }
    }

    // Strategy 3: Head/tail truncation with middle summary
    const truncResult = this._headTailTruncate(result);
    result = truncResult.content;
    strategy += (strategy ? ' + ' : '') + `truncate(head=${this.headLines}+tail=${this.tailLines})`;

    console.log(`[ToolResultFilter] ✂️  ${label}: ${originalChars} → ${result.length} chars (${strategy})`);
    return { content: result, stats: { originalChars, filteredChars: result.length, strategy } };
  }

  /**
   * Batch-apply filtering to an array of labelled blocks.
   * Modifies blocks in-place for efficiency.
   *
   * P2 Enhancement: accepts taskType for intent-aware grep pattern selection.
   * When no explicit grepPattern is provided, the filter automatically selects
   * a taskType-specific pattern from INTENT_GREP_PATTERNS.
   *
   * P2 Enhancement: accepts profile (ContextProfile) for per-block budget ratio.
   * Each block's effective maxBlockChars is scaled by profile.getBudgetRatio(label),
   * giving essential blocks more room and low-priority blocks less.
   *
   * @param {Array<{label: string, content: string, priority: number}>} blocks
   * @param {object} [opts]
   * @param {RegExp} [opts.grepPattern] - Global grep pattern for all blocks (overrides intent pattern)
   * @param {string} [opts.taskType]   - Task type for intent-aware grep pattern selection
   * @param {import('./smart-context-selector').ContextProfile} [opts.profile] - For per-block budget ratio
   * @returns {{ totalSaved: number, filteredLabels: string[] }}
   */
  applyToBlocks(blocks, opts = {}) {
    let totalSaved = 0;
    const filteredLabels = [];

    // P2: Resolve intent-aware grep pattern from taskType
    const intentPattern = opts.taskType ? INTENT_GREP_PATTERNS[opts.taskType] : null;

    for (const block of blocks) {
      // P2: Calculate per-block budget using profile's getBudgetRatio
      const budgetRatio = opts.profile ? opts.profile.getBudgetRatio(block.label) : 1.0;
      const effectiveMaxChars = Math.round(this.maxBlockChars * budgetRatio);

      if (!block.content || block.content.length <= effectiveMaxChars) continue;

      // P2: Use explicit grepPattern > intent pattern > no pattern
      const grepPattern = opts.grepPattern || intentPattern || null;

      const { content, stats } = this.apply(block.content, {
        label: block.label,
        grepPattern,
        maxBlockChars: effectiveMaxChars,
      });

      const saved = stats.originalChars - stats.filteredChars;
      if (saved > 0) {
        block.content = content;
        totalSaved += saved;
        filteredLabels.push(`${block.label}(-${saved})`);
      }
    }

    if (filteredLabels.length > 0) {
      const intentInfo = opts.taskType ? ` [intent:${opts.taskType}]` : '';
      console.log(`[ToolResultFilter] 📊 Batch filter${intentInfo}: saved ${totalSaved} chars across ${filteredLabels.length} block(s): [${filteredLabels.join(', ')}]`);
    }

    return { totalSaved, filteredLabels };
  }

  /**
   * Grep filter: extracts matching lines with surrounding context.
   * @param {string} content
   * @param {RegExp} pattern
   * @returns {{ content: string, matchCount: number }}
   */
  _grepFilter(content, pattern) {
    const lines = content.split('\n');
    const matchIndices = new Set();
    let matchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        matchCount++;
        // Add context lines around the match
        for (let j = Math.max(0, i - this.grepContextLines); j <= Math.min(lines.length - 1, i + this.grepContextLines); j++) {
          matchIndices.add(j);
        }
      }
    }

    if (matchCount === 0) return { content, matchCount: 0 };

    const resultLines = [];
    let lastIdx = -2;
    for (const idx of [...matchIndices].sort((a, b) => a - b)) {
      if (idx > lastIdx + 1) {
        resultLines.push(`  ... (${idx - lastIdx - 1} lines omitted) ...`);
      }
      resultLines.push(lines[idx]);
      lastIdx = idx;
    }

    if (lastIdx < lines.length - 1) {
      resultLines.push(`  ... (${lines.length - 1 - lastIdx} lines omitted) ...`);
    }

    return { content: resultLines.join('\n'), matchCount };
  }

  /**
   * Deduplicates adjacent similar lines (e.g. repeated log entries, table rows).
   * @param {string} content
   * @returns {{ content: string, removedCount: number }}
   */
  _deduplicateLines(content) {
    const lines = content.split('\n');
    if (lines.length < 5) return { content, removedCount: 0 };

    const resultLines = [];
    let removedCount = 0;
    let consecutiveDupes = 0;
    let prevNormalized = '';

    for (let i = 0; i < lines.length; i++) {
      // Normalize: strip leading whitespace, numbers, timestamps for comparison
      const normalized = lines[i].replace(/^\s+/, '').replace(/\d+/g, 'N').replace(/\s+/g, ' ');

      if (normalized === prevNormalized && normalized.length > 10) {
        consecutiveDupes++;
        removedCount++;
      } else {
        if (consecutiveDupes > 0) {
          resultLines.push(`  ... (${consecutiveDupes} similar line(s) collapsed) ...`);
          consecutiveDupes = 0;
        }
        resultLines.push(lines[i]);
      }
      prevNormalized = normalized;
    }

    if (consecutiveDupes > 0) {
      resultLines.push(`  ... (${consecutiveDupes} similar line(s) collapsed) ...`);
    }

    return { content: resultLines.join('\n'), removedCount };
  }

  /**
   * Head/tail truncation: keeps first N lines + last M lines, summarises middle.
   * @param {string} content
   * @returns {{ content: string }}
   */
  _headTailTruncate(content) {
    const lines = content.split('\n');
    if (lines.length <= this.headLines + this.tailLines + 5) {
      // Not enough lines to warrant truncation — just char-truncate
      return { content: content.slice(0, this.maxBlockChars) + '\n... [truncated]' };
    }

    const head = lines.slice(0, this.headLines);
    const tail = lines.slice(-this.tailLines);
    const omitted = lines.length - this.headLines - this.tailLines;

    return {
      content: [
        ...head,
        ``,
        `--- ✂️  ${omitted} lines omitted (${omitted} of ${lines.length} total) ---`,
        ``,
        ...tail,
      ].join('\n'),
    };
  }
}


/**
 * Returns a human-readable summary of all three budget layers.
 * Call this after prompt assembly to detect double-truncation anomalies.
 *
 * A-2 Architecture Fix: provides the unified budget view that was previously
 * impossible because the three layers used different units and had no
 * cross-layer awareness.
 *
 * @param {object} l2Stats - stats object from _applyTokenBudget()
 * @param {object} [l3Analysis] - noiseAnalysis from prompt-builder.js
 * @returns {string} Human-readable budget summary
 */
function getBudgetSummary(l2Stats, l3Analysis = null, stage = null) {
  const multiplier = (stage && STAGE_BUDGET_MULTIPLIERS[stage]) || 1.0;
  const effectiveBudgetChars = Math.floor(STAGE_TOKEN_BUDGET_CHARS * multiplier);
  const effectiveBudgetTokens = Math.floor(effectiveBudgetChars / CHARS_PER_TOKEN);
  const multiplierInfo = multiplier < 1.0 ? ` (×${multiplier} for ${stage})` : '';
  const lines = [
    `── Token Budget Summary (unified view) ──`,
    `  L2 Stage Budget  : ${l2Stats.total} chars ≈ ${l2Stats.estimatedTokens} tokens (limit: ${effectiveBudgetChars} chars ≈ ${effectiveBudgetTokens} tokens${multiplierInfo})`,
  ];
  if (l2Stats.dropped.length > 0) {
    lines.push(`  L2 dropped       : [${l2Stats.dropped.join(', ')}]`);
  }
  if (l2Stats.truncated.length > 0) {
    lines.push(`  L2 truncated     : [${l2Stats.truncated.join(', ')}]`);
  }
  if (l3Analysis) {
    lines.push(`  L3 Prompt Guard  : ${l3Analysis.estimatedTokens} tokens (threshold: ${l3Analysis.isHighRisk ? '⚠️ EXCEEDED' : 'OK'})`);
    if (l3Analysis.isHighRisk) {
      lines.push(`  L3 risk level    : ${l3Analysis.riskLevel}`);
    }
  }
  // Detect double-truncation warning
  if (l2Stats.dropped.length > 0 && l3Analysis && l3Analysis.isHighRisk) {
    lines.push(`  ⚠️  DOUBLE TRUNCATION: L2 dropped blocks AND L3 still exceeds threshold.`);
    lines.push(`     Consider increasing STAGE_TOKEN_BUDGET_CHARS or reducing upstream context.`);
  }
  return lines.join('\n');
}

// ─── P0-A: Priority-Based Conversation Truncation (OpenSpace-Inspired) ───────
//
// Ported from OpenSpace's conversation_formatter.py — the core token efficiency
// innovation that achieves 30-46% token savings.
//
// Instead of simple tail-truncation, conversations are segmented by priority:
//   Priority 0 — CRITICAL: User instruction (never truncated)
//   Priority 1 — CRITICAL: Final assistant response (never truncated)
//   Priority 2 — HIGH:     Tool calls + tool errors (paired)
//   Priority 3 — HIGH:     Non-final assistant reasoning; tool results with summary
//   Priority 4 — MEDIUM:   Tool success results (try to preserve)
//   Priority 5 — LOW:      System guidance messages
//   SKIP:                   Skill injection text, verbose system prompts
//
// Integration: Called by context builders when assembling conversation history
// for analysis prompts (e.g., post-REVIEW evolution analysis, experience distillation).

const CONVERSATION_PRIORITY = {
  USER_INSTRUCTION: 0,
  FINAL_RESPONSE: 1,
  TOOL_CALLS_ERRORS: 2,
  ASSISTANT_REASONING: 3,
  TOOL_SUCCESS: 4,
  SYSTEM_GUIDANCE: 5,
};

// Per-segment truncation limits (chars)
const CONV_TRUNCATION = {
  TOOL_ERROR_MAX: 1000,
  TOOL_SUCCESS_MAX: 800,
  TOOL_ARGS_MAX: 500,
  TOOL_SUMMARY_MAX: 1500,
};

/**
 * Formats conversation history with priority-based truncation.
 *
 * Inspired by OpenSpace's conversation_formatter.format_conversations().
 * Achieves 30-46% token savings vs naive truncation by preserving high-value
 * segments (user instructions, errors, final response) while aggressively
 * truncating low-value segments (system guidance, verbose tool results).
 *
 * @param {Array<{role: string, content: string, toolCalls?: Array, isError?: boolean, hasSummary?: boolean}>} messages
 *   Conversation messages in chronological order.
 * @param {number} budget - Character budget for the formatted output.
 * @returns {{ formatted: string, stats: { total: number, essential: number, skipped: number } }}
 */
function formatConversationWithBudget(messages, budget) {
  if (!messages || messages.length === 0) {
    return { formatted: '', stats: { total: 0, essential: 0, skipped: 0 } };
  }

  // Phase 1: Collect segments with priority assignment
  const segments = [];
  const totalMessages = messages.length;

  // Find the last assistant message index for priority 1 assignment
  let lastAssistantIdx = -1;
  for (let i = totalMessages - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  for (let i = 0; i < totalMessages; i++) {
    const msg = messages[i];
    const role = msg.role || '';
    const content = msg.content || '';
    if (!content && !msg.toolCalls) continue;

    if (role === 'user') {
      // User messages: first user message is CRITICAL (instruction), rest are HIGH
      segments.push({
        priority: i === 0 ? CONVERSATION_PRIORITY.USER_INSTRUCTION : CONVERSATION_PRIORITY.ASSISTANT_REASONING,
        text: `[USER] ${content}`,
        truncatableTo: null,
      });
    } else if (role === 'assistant') {
      const isLast = i === lastAssistantIdx;
      if (content) {
        segments.push({
          priority: isLast ? CONVERSATION_PRIORITY.FINAL_RESPONSE : CONVERSATION_PRIORITY.ASSISTANT_REASONING,
          text: `[ASSISTANT] ${content}`,
          truncatableTo: isLast ? null : 200,
        });
      }
      // Tool calls
      if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          const fnName = tc.name || tc.function?.name || '?';
          let fnArgs = tc.arguments || tc.function?.arguments || '';
          if (typeof fnArgs === 'string' && fnArgs.length > CONV_TRUNCATION.TOOL_ARGS_MAX) {
            fnArgs = fnArgs.slice(0, CONV_TRUNCATION.TOOL_ARGS_MAX) + '...';
          }
          segments.push({
            priority: CONVERSATION_PRIORITY.TOOL_CALLS_ERRORS,
            text: `[TOOL_CALL] ${fnName}(${fnArgs})`,
            truncatableTo: null,
          });
        }
      }
    } else if (role === 'tool') {
      const isError = msg.isError || _isToolError(content);
      if (isError) {
        const truncated = content.length > CONV_TRUNCATION.TOOL_ERROR_MAX
          ? content.slice(0, CONV_TRUNCATION.TOOL_ERROR_MAX) + `... [truncated, ${content.length} chars total]`
          : content;
        segments.push({
          priority: CONVERSATION_PRIORITY.TOOL_CALLS_ERRORS,
          text: `[TOOL_ERROR] ${truncated}`,
          truncatableTo: null,
        });
      } else if (msg.hasSummary || _hasEmbeddedSummary(content)) {
        const summary = _extractEmbeddedSummary(content) || content.slice(0, CONV_TRUNCATION.TOOL_SUMMARY_MAX);
        segments.push({
          priority: CONVERSATION_PRIORITY.ASSISTANT_REASONING,
          text: `[TOOL_RESULT (summary)] ${summary}`,
          truncatableTo: 500,
        });
      } else {
        const truncated = content.length > CONV_TRUNCATION.TOOL_SUCCESS_MAX
          ? content.slice(0, CONV_TRUNCATION.TOOL_SUCCESS_MAX) + `... [truncated, ${content.length} chars total]`
          : content;
        segments.push({
          priority: CONVERSATION_PRIORITY.TOOL_SUCCESS,
          text: `[TOOL_RESULT] ${truncated}`,
          truncatableTo: 300,
        });
      }
    } else if (role === 'system') {
      // Skip skill injection and verbose system prompts
      if (content.length > 500 || content.includes('## Rules') || content.includes('## Best Practices')) {
        continue; // SKIP — skill injection text
      }
      segments.push({
        priority: CONVERSATION_PRIORITY.SYSTEM_GUIDANCE,
        text: `[SYSTEM] ${content}`,
        truncatableTo: 150,
      });
    }
  }

  // Phase 2: Assemble with budget management
  const essential = segments.filter(s => s.priority <= 3);
  const essentialChars = essential.reduce((sum, s) => sum + s.text.length + 2, 0);

  if (essentialChars > budget) {
    // Essential content alone exceeds budget — emergency mode
    return _assembleEssentialOnly(segments, budget);
  }

  // Build output in chronological order
  const outputParts = [];
  let usedChars = 0;
  let skippedCount = 0;

  for (const seg of segments) {
    if (seg.priority <= 3) {
      outputParts.push(seg.text);
      usedChars += seg.text.length + 2;
    } else if (usedChars + seg.text.length + 2 <= budget) {
      outputParts.push(seg.text);
      usedChars += seg.text.length + 2;
    } else {
      // Over budget — try truncation
      if (seg.truncatableTo && seg.text.length > seg.truncatableTo) {
        const truncated = seg.text.slice(0, seg.truncatableTo) + '... [budget-truncated]';
        if (usedChars + truncated.length + 2 <= budget) {
          outputParts.push(truncated);
          usedChars += truncated.length + 2;
          continue;
        }
      }
      skippedCount++;
    }
  }

  if (skippedCount > 0) {
    outputParts.push(`\n[... ${skippedCount} lower-priority segment(s) omitted due to budget ...]`);
  }

  return {
    formatted: outputParts.join('\n\n'),
    stats: {
      total: segments.reduce((sum, s) => sum + s.text.length, 0),
      essential: essentialChars,
      skipped: skippedCount,
    },
  };
}

/**
 * Emergency mode: even essential content exceeds budget.
 * Keep priority 0-1 in full, budget-allocate priority 2, summarize priority 3.
 */
function _assembleEssentialOnly(segments, budget) {
  const outputParts = [];
  let usedChars = 0;

  // Pass 1: priority 0 and 1 (user instruction + final response)
  for (const seg of segments) {
    if (seg.priority <= 1) {
      outputParts.push(seg.text);
      usedChars += seg.text.length + 2;
    }
  }

  const remaining = budget - usedChars;

  // Pass 2: priority 2 (tool calls + errors) — budget-allocated
  const toolSegs = segments.filter(s => s.priority === 2);
  if (toolSegs.length > 0) {
    const perSegBudget = Math.max(400, Math.floor(remaining / (toolSegs.length + 1)));
    for (const seg of toolSegs) {
      let text = seg.text;
      if (text.length > perSegBudget) {
        text = text.slice(0, perSegBudget) + '... [budget-truncated]';
      }
      if (usedChars + text.length + 2 <= budget) {
        outputParts.push(text);
        usedChars += text.length + 2;
      }
    }
  }

  // Pass 3: priority 3 (non-final assistant reasoning) — one-line summaries
  const assistantSegs = segments.filter(s => s.priority === 3);
  if (assistantSegs.length > 0 && usedChars < budget) {
    outputParts.push('\n--- Older iteration summaries ---');
    for (const seg of assistantSegs) {
      const firstLine = seg.text.split('\n', 1)[0].slice(0, 200);
      if (usedChars + firstLine.length + 2 > budget) {
        outputParts.push('[... remaining iterations omitted ...]');
        break;
      }
      outputParts.push(firstLine);
      usedChars += firstLine.length + 2;
    }
  }

  return {
    formatted: outputParts.join('\n\n'),
    stats: {
      total: segments.reduce((sum, s) => sum + s.text.length, 0),
      essential: usedChars,
      skipped: segments.filter(s => s.priority > 3).length,
    },
  };
}

/** Detect if a tool result represents an error. */
function _isToolError(content) {
  if (!content) return false;
  const head = content.slice(0, 200).toLowerCase();
  return (
    content.startsWith('[ERROR]') ||
    content.startsWith('ERROR') ||
    head.slice(0, 50).includes('error') ||
    head.includes('task failed') ||
    head.includes('connection refused') ||
    head.includes('timed out') ||
    head.includes('traceback')
  );
}

/** Check if tool result contains an embedded execution summary. */
function _hasEmbeddedSummary(content) {
  return /Execution Summary \(\d+ steps?\):/.test(content);
}

/** Extract embedded summary from tool result content. */
function _extractEmbeddedSummary(content) {
  const match = content.match(/Execution Summary \(\d+ steps?\):[\s\S]*?(?:={10,}|$)/);
  if (match) {
    let summary = match[0].trim();
    const summaryLine = content.match(/\nSummary:\s*(.+)/);
    if (summaryLine) {
      summary += `\nConclusion: ${summaryLine[1].trim()}`;
    }
    return summary.slice(0, CONV_TRUNCATION.TOOL_SUMMARY_MAX);
  }
  return null;
}

module.exports = {
  STAGE_TOKEN_BUDGET_CHARS,
  STAGE_TOKEN_BUDGET_TOKENS,
  STAGE_BUDGET_MULTIPLIERS,
  BLOCK_PRIORITY,
  _applyTokenBudget,
  ToolResultFilter,
  getBudgetSummary,
  INTENT_GREP_PATTERNS,
  setSemanticCompressorCheapLlm,
  // P0-A: OpenSpace-inspired conversation truncation
  CONVERSATION_PRIORITY,
  CONV_TRUNCATION,
  formatConversationWithBudget,
};
