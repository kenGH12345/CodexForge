/**
 * RetryDivergenceGuard – Prevents duplicate output during rollback retries
 *
 * When a stage fails quality review and triggers a rollback retry, the LLM
 * tends to produce similar or identical output because the prompt context
 * is largely unchanged. This module provides 3 complementary strategies
 * to maximise output diversity on retries:
 *
 *   Strategy 1: Negative Prompt (zero extra LLM cost)
 *     Extracts key decisions from the previous output and injects them as
 *     explicit "DO NOT REPEAT" constraints into the retry prompt.
 *
 *   Strategy 2: Creativity Directive (zero extra LLM cost)
 *     Injects escalating creativity instructions that increase with retry
 *     count, encouraging the LLM to explore alternative approaches.
 *     (Replaces temperature adjustment since we don't control LLM params.)
 *
 *   Strategy 3: Output Fingerprint (uses EmbeddingService, zero LLM cost)
 *     Compares the semantic similarity between previous and current output
 *     using local embedding cosine similarity. Flags when similarity > 0.85.
 *
 * Design:
 *   - Pure utility module: no state, no side effects beyond logging
 *   - All methods are static or take explicit parameters
 *   - Graceful degradation: each strategy works independently
 *   - EmbeddingService is optional (Strategy 3 degrades to no-op)
 *
 * @module workflow/core/retry-divergence-guard
 */

'use strict';

const { prepareGatewayPrompt } = require('./llm-injection-gateway');

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Similarity threshold above which outputs are considered "too similar".
 * 0.85 = very high semantic overlap; typical rewording scores 0.6-0.75.
 */
const SIMILARITY_THRESHOLD = 0.85;

/**
 * Warning threshold — outputs above this are flagged but not blocked.
 */
const SIMILARITY_WARNING_THRESHOLD = 0.75;

/**
 * Maximum length of previous output digest to include in negative prompt.
 * Keeps token cost bounded.
 */
const MAX_DIGEST_LENGTH = 600;

/**
 * Maximum number of key decisions to extract from previous output.
 */
const MAX_KEY_DECISIONS = 5;

/**
 * Module-level cheapLlmCall reference. Injected at runtime by the Orchestrator
 * via setCheapLlmCall(). When available, extractKeyDecisions uses LLM for
 * semantic decision extraction instead of regex heuristics.
 * @type {Function|null}
 */
let _cheapLlmCall = null;

/**
 * Injects a cheap LLM call function for enhanced decision extraction.
 * Called by the Orchestrator during initialisation.
 *
 * @param {Function} llmCall - Async function: (prompt: string) => string
 */
function setCheapLlmCall(llmCall) {
  if (typeof llmCall === 'function') {
    _cheapLlmCall = llmCall;
    console.log(`[RetryDivergenceGuard] 🤖 Cheap LLM enabled for decision extraction.`);
  }
}

// ─── Strategy 1: Negative Prompt Generation ──────────────────────────────────

/**
 * Extracts key decisions/choices from a previous stage output using regex
 * heuristics. This is the fallback when LLM is not available.
 *
 * @param {string} previousOutput - The full text of the previous attempt's output
 * @returns {string[]} Array of key decision strings (max MAX_KEY_DECISIONS)
 */
function extractKeyDecisionsHeuristic(previousOutput) {
  if (!previousOutput || typeof previousOutput !== 'string') return [];

  const decisions = [];
  const lines = previousOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Match heading lines (## Decision: ..., ## Approach: ...)
    if (/^#{1,3}\s+(decision|approach|strategy|pattern|choice|design|architecture)/i.test(trimmed)) {
      decisions.push(trimmed.replace(/^#+\s*/, ''));
    }

    // Match bullet points with decision language
    if (/^[-*]\s+(use|choose|adopt|implement|select|prefer|recommend|apply)\s+/i.test(trimmed)) {
      decisions.push(trimmed.replace(/^[-*]\s+/, ''));
    }

    // Match "We will..." / "The system will..." patterns
    if (/^(we will|the system will|this approach|the design|the architecture)\s+/i.test(trimmed)) {
      decisions.push(trimmed.slice(0, 150));
    }

    if (decisions.length >= MAX_KEY_DECISIONS) break;
  }

  // If no structured decisions found, extract first few non-empty lines as summary
  if (decisions.length === 0) {
    const nonEmpty = lines
      .map(l => l.trim())
      .filter(l => l.length > 20 && !l.startsWith('#') && !l.startsWith('```'));
    for (let i = 0; i < Math.min(3, nonEmpty.length); i++) {
      decisions.push(nonEmpty[i].slice(0, 150));
    }
  }

  return decisions;
}

/**
 * Extracts key decisions/choices from a previous stage output.
 * When cheapLlmCall is available, uses LLM for semantic extraction
 * (supports both English and Chinese, understands implicit decisions).
 * Falls back to regex heuristics when LLM is unavailable or fails.
 *
 * @param {string} previousOutput - The full text of the previous attempt's output
 * @returns {Promise<string[]>} Array of key decision strings (max MAX_KEY_DECISIONS)
 */
async function extractKeyDecisions(previousOutput) {
  if (!previousOutput || typeof previousOutput !== 'string') return [];

  // Try LLM extraction first (if available)
  if (_cheapLlmCall) {
    try {
      const truncated = previousOutput.slice(0, 3000); // Bound input tokens
      const prompt = [
        'Extract the top 5 key architectural/design decisions from the following output.',
        'Focus on: technology choices, patterns selected, algorithms chosen, trade-offs made.',
        'Return ONLY a JSON array of short decision strings (max 150 chars each).',
        'If the text is in Chinese, extract decisions in Chinese.',
        'Example: ["Use React with TypeScript for frontend", "Adopt microservice architecture"]',
        '',
        '--- OUTPUT ---',
        truncated,
        '--- END ---',
      ].join('\n');

      const response = await _cheapLlmCall(prepareGatewayPrompt({ _outputDir: null }, {
        callSite: 'workflow/core/retry-divergence-guard.js:extractKeyDecisions',
        role: 'retry-divergence-guard',
        stage: 'RETRY',
        runtimePrompt: prompt,
        metadata: { category: 'llm-lite-call' },
      }));
      if (response) {
        // Parse JSON array from response (tolerant of markdown fences)
        const cleaned = String(response).replace(/```json\s*/g, '').replace(/```/g, '').trim();
        const match = cleaned.match(/\[\s*[\s\S]*?\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const decisions = parsed
              .filter(d => typeof d === 'string' && d.length > 5)
              .slice(0, MAX_KEY_DECISIONS)
              .map(d => d.slice(0, 150));
            if (decisions.length > 0) {
              console.log(`[RetryDivergenceGuard] 🤖 LLM extracted ${decisions.length} key decisions.`);
              return decisions;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[RetryDivergenceGuard] ⚠️ LLM decision extraction failed (falling back to heuristic): ${err.message}`);
    }
  }

  // Fallback: regex heuristic extraction
  return extractKeyDecisionsHeuristic(previousOutput);
}

/**
 * Generates a Negative Prompt block that instructs the LLM to avoid
 * repeating the same decisions as the previous attempt.
 *
 * @param {object} options
 * @param {string} options.previousOutput - Full text of previous attempt's output
 * @param {string} options.failureReason  - Why the previous attempt failed
 * @param {number} options.retryCount     - Current retry number (1-based)
 * @param {string} [options.stageName]    - Name of the stage being retried
 * @returns {string} Formatted negative prompt block to prepend to the retry prompt
 */
async function buildNegativePrompt({ previousOutput, failureReason, retryCount, stageName = 'STAGE' }) {
  const keyDecisions = await extractKeyDecisions(previousOutput);

  // Build the output digest (truncated to stay within token budget)
  const digest = previousOutput
    ? previousOutput.slice(0, MAX_DIGEST_LENGTH).trim()
    : '(previous output not available)';

  const sections = [
    `[${stageName} RETRY ${retryCount} – DIVERGENCE REQUIRED]`,
    ``,
    `## ❌ Previous Attempt Failed`,
    `${failureReason}`,
    ``,
  ];

  if (keyDecisions.length > 0) {
    sections.push(
      `## 🚫 DO NOT REPEAT These Decisions`,
      `The previous attempt made these specific choices that led to failure:`,
      ...keyDecisions.map((d, i) => `  ${i + 1}. ${d}`),
      ``,
      `You MUST take a DIFFERENT approach from each of the above.`,
      ``
    );
  }

  sections.push(
    `## 📋 Previous Output Digest (for reference only — do NOT copy)`,
    `\`\`\``,
    digest,
    `\`\`\``,
    ``
  );

  return sections.join('\n');
}

// ─── Strategy 2: Creativity Directive ────────────────────────────────────────

/**
 * Escalating creativity directives indexed by retry count.
 * Each level adds stronger language encouraging the LLM to diverge.
 *
 * This replaces direct temperature adjustment (which we can't control
 * since _rawLlmCall doesn't accept options). Instead, we use prompt
 * engineering to achieve similar diversity effects.
 */
const CREATIVITY_DIRECTIVES = [
  // Retry 1: Gentle nudge
  [
    `## 🔄 Retry Directive`,
    `This is retry #1. The previous approach failed.`,
    `Please consider alternative solutions and different design patterns.`,
    `Think about what assumptions the previous attempt made that might be wrong.`,
  ].join('\n'),

  // Retry 2: Stronger push
  [
    `## 🔄 Retry Directive (Attempt #2)`,
    `Two previous approaches have failed. You MUST fundamentally rethink the solution.`,
    `Requirements:`,
    `- Use a COMPLETELY DIFFERENT architectural pattern or algorithm`,
    `- Challenge the core assumptions of previous attempts`,
    `- Consider unconventional but valid approaches`,
    `- If previous attempts used X, explicitly try NOT-X`,
  ].join('\n'),

  // Retry 3+: Maximum divergence
  [
    `## 🔄 Retry Directive (Attempt #3+)`,
    `Multiple previous approaches have ALL failed. Radical rethinking required.`,
    `MANDATORY requirements:`,
    `- Start from FIRST PRINCIPLES — ignore all previous solution patterns`,
    `- Consider the SIMPLEST possible solution that satisfies requirements`,
    `- If previous attempts were complex, try a minimal approach`,
    `- If previous attempts were minimal, try a more structured approach`,
    `- Explicitly state how your approach DIFFERS from previous attempts`,
    `- Consider whether the requirements themselves need reinterpretation`,
  ].join('\n'),
];

/**
 * Returns the appropriate creativity directive for the given retry count.
 *
 * @param {number} retryCount - Current retry number (1-based)
 * @returns {string} Creativity directive text
 */
function getCreativityDirective(retryCount) {
  const idx = Math.min(retryCount - 1, CREATIVITY_DIRECTIVES.length - 1);
  return CREATIVITY_DIRECTIVES[Math.max(0, idx)];
}

// ─── Strategy 3: Output Fingerprint Comparison ───────────────────────────────

/**
 * Compares the semantic similarity between previous and current output
 * using the EmbeddingService. Returns a similarity report.
 *
 * @param {object} options
 * @param {import('./embedding-service').EmbeddingService} options.embeddingService - EmbeddingService instance
 * @param {string} options.previousOutput - Previous attempt's output text
 * @param {string} options.currentOutput  - Current attempt's output text
 * @param {number} [options.maxCompareLength=500] - Max text length to compare
 * @returns {Promise<{ similarity: number, isDuplicate: boolean, isWarning: boolean, message: string }>}
 */
async function compareOutputFingerprint({
  embeddingService,
  previousOutput,
  currentOutput,
  maxCompareLength = 500,
}) {
  const defaultResult = {
    similarity: 0,
    isDuplicate: false,
    isWarning: false,
    message: 'Fingerprint comparison skipped (EmbeddingService not available)',
  };

  if (!embeddingService || !embeddingService.isReady()) return defaultResult;
  if (!previousOutput || !currentOutput) return defaultResult;

  try {
    const prevText = previousOutput.slice(0, maxCompareLength);
    const currText = currentOutput.slice(0, maxCompareLength);

    const [prevVec, currVec] = await Promise.all([
      embeddingService.embed(prevText),
      embeddingService.embed(currText),
    ]);

    if (!prevVec || !currVec) {
      return { ...defaultResult, message: 'Embedding computation failed for one or both outputs' };
    }

    const similarity = embeddingService.cosineSimilarity(prevVec, currVec);
    const isDuplicate = similarity >= SIMILARITY_THRESHOLD;
    const isWarning = similarity >= SIMILARITY_WARNING_THRESHOLD && !isDuplicate;

    let message;
    if (isDuplicate) {
      message = `⚠️ DUPLICATE DETECTED: Output similarity ${(similarity * 100).toFixed(1)}% (threshold: ${SIMILARITY_THRESHOLD * 100}%). Retry produced nearly identical content.`;
    } else if (isWarning) {
      message = `⚡ HIGH SIMILARITY: Output similarity ${(similarity * 100).toFixed(1)}% (warning threshold: ${SIMILARITY_WARNING_THRESHOLD * 100}%). Content may be insufficiently differentiated.`;
    } else {
      message = `✅ Output divergence OK: similarity ${(similarity * 100).toFixed(1)}% (below ${SIMILARITY_WARNING_THRESHOLD * 100}% threshold).`;
    }

    console.log(`[RetryDivergenceGuard] 🔍 ${message}`);

    return { similarity, isDuplicate, isWarning, message };
  } catch (err) {
    console.warn(`[RetryDivergenceGuard] ⚠️ Fingerprint comparison failed: ${err.message}`);
    return { ...defaultResult, message: `Comparison error: ${err.message}` };
  }
}

// ─── Combined: Build Full Retry Context ──────────────────────────────────────

/**
 * Builds the complete retry context block combining all three strategies.
 * This is the main entry point for stage runners to use.
 *
 * @param {object} options
 * @param {string} options.previousOutput  - Full text of previous attempt's output
 * @param {string} options.failureReason   - Why the previous attempt failed
 * @param {number} options.retryCount      - Current retry number (1-based)
 * @param {string} [options.stageName]     - Name of the stage being retried
 * @returns {string} Complete retry context to prepend to the retry prompt
 */
async function buildRetryContext({ previousOutput, failureReason, retryCount, stageName = 'STAGE' }) {
  const parts = [];

  // Strategy 1: Negative Prompt
  parts.push(await buildNegativePrompt({ previousOutput, failureReason, retryCount, stageName }));

  // Strategy 2: Creativity Directive
  parts.push(getCreativityDirective(retryCount));

  return parts.join('\n\n');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // LLM injection
  setCheapLlmCall,
  // Strategy 1
  extractKeyDecisions,
  extractKeyDecisionsHeuristic,
  buildNegativePrompt,
  // Strategy 2
  getCreativityDirective,
  CREATIVITY_DIRECTIVES,
  // Strategy 3
  compareOutputFingerprint,
  SIMILARITY_THRESHOLD,
  SIMILARITY_WARNING_THRESHOLD,
  // Combined
  buildRetryContext,
};
