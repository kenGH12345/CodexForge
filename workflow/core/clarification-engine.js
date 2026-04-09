/**
 * Clarification Engine – Agent Self-Correction for review/approval stages
 *
 * Implements a 3-layer self-correction strategy:
 *  1. Signal Detection  – Detect ambiguity, assumptions, risks, contradictions
 *  2. Self-Correction   – Feed signals back to the Agent as a refinement prompt
 *  3. Smart Evaluation  – Loop until no signals remain or maxRounds reached
 *
 * Signal Detection has two modes:
 *  - Regex mode (default, no LLM needed): fast keyword-based detection
 *  - Semantic mode (requires llmCall): LLM understands context, distinguishes
 *    "real risks" from "mitigated risks", detects logic errors beyond keywords
 *
 * Human review is only triggered when high-severity signals persist after all rounds.
 *
 * Used in: architecture approval, code review, technical proposal review
 */

'use strict';

// ─── Signal Detectors (extracted to clarification-signals.js) ───────────────

const { SIGNAL_PATTERNS, detectSignals } = require('./clarification-signals');

// ─── Semantic Prompts (extracted to clarification-prompts.js) ───────────────

const {
  buildSemanticDetectionPrompt,
  buildSemanticVerificationPrompt,
  buildSemanticCorrelationPrompt,
  parseSemanticSignals,
  buildRefinementPrompt,
} = require('./clarification-prompts');

// ─── Self-Correction Engine ───────────────────────────────────────────────────

class SelfCorrectionEngine {
  /**
   * @param {Function} llmCall        - async (prompt: string) => string (main model)
   * @param {object}   [options]
   * @param {number}   [options.maxRounds=3]     - Max self-correction rounds
   * @param {boolean}  [options.verbose=true]    - Print progress to console
   * @param {boolean}  [options.semanticMode=true] - Use LLM semantic detection instead of regex
   *                                               Semantic mode: distinguishes real vs mitigated risks,
   *                                               detects logic errors, understands context.
   *                                               Falls back to regex if LLM call fails.
   * @param {Function} [options.cheapLlmCall]    - Cheap LLM call function (GPT-4o-mini / Gemini Flash tier)
   *                                               When provided, semantic detection uses cheapLlmCall
   *                                               instead of the main llmCall (~50x cost reduction).
   *                                               Refinement prompts still use the main llmCall.
   * @param {object}   [options.investigationTools] - Optional tools for deep investigation
   * @param {Function} [options.investigationTools.search]          - async (query: string) => string
   * @param {Function} [options.investigationTools.readSource]      - async (filePath: string) => string
   * @param {Function} [options.investigationTools.queryExperience] - async (query: string) => string
   */
  constructor(llmCall, { maxRounds = 3, verbose = true, semanticMode = true, cheapLlmCall = null, investigationTools = null } = {}) {
    if (typeof llmCall !== 'function') {
      throw new Error('[SelfCorrectionEngine] llmCall must be a function');
    }
    this.llmCall = llmCall;
    // Semantic detection uses cheapLlmCall when available (cost-aware: ~$0.002/call vs ~$0.10/call)
    // Refinement prompts still use the main llmCall for higher quality corrections.
    this._semanticLlmCall = (typeof cheapLlmCall === 'function') ? cheapLlmCall : llmCall;
    this.maxRounds = maxRounds;
    this.verbose = verbose;
    this.semanticMode = semanticMode;
    this.investigationTools = investigationTools || null;
  }

  /**
   * Runs the self-correction loop on an artifact.
   *
   * @param {string} content      - Initial artifact content
   * @param {string} stageLabel   - Human-readable stage name (e.g. "Architecture")
   * @returns {Promise<SelfCorrectionResult>}
   */
  async correct(content, stageLabel = 'Review') {
    let current = content;
    const history = [];
    let round = 0;
    // N56 fix: track whether the loop exited due to an LLM failure.
    // If true, skip the final signal detection pass – the content was NOT modified
    // by the failed round, so re-detecting signals on the original content would
    // incorrectly escalate a transient LLM error into "needs human review".
    let llmFailed = false;
    // P1-NEW-1 fix: oscillation detection – track signal label sets across rounds.
    // If two consecutive rounds produce the same (or highly overlapping) signal set,
    // the correction loop is oscillating: fixing one issue re-introduces another.
    // In that case we terminate early and mark needsHumanReview rather than burning
    // all maxRounds on a loop that will never converge.
    let prevSignalKey = null;
    let oscillationDetected = false;

    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🤖 SELF-CORRECTION  –  ${stageLabel.padEnd(33)}║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    while (round < this.maxRounds) {
      round++;

      // Detect signals: semantic mode (LLM) preferred, regex as fallback
      const signals = await this._detectSignals(current, stageLabel);

      if (signals.length === 0) {
        // R1-6 audit: when round=1, round-1=0 which is confusing in logs.
        // Use "after N scan(s)" phrasing which is always clear.
        const scanLabel = round === 1 ? 'Initial scan' : `After ${round - 1} correction(s)`;
        this._log(`\n[SelfCorrection] ✅ ${scanLabel}: No issues detected. Artifact is clean.\n`);
        return { content: current, rounds: round - 1, signals: [], history, needsHumanReview: false };
      }

      // P2-C fix: use signal.type (enum value) as the oscillation fingerprint instead
      // of signal.label (LLM-generated natural language). The same underlying issue can
      // be described with different labels across rounds (e.g. "Unmitigated network
      // timeout risk" vs "Network timeout risk without mitigation" vs "Missing retry
      // strategy for network failures"), causing the string-equality check to miss
      // oscillation. signal.type is a stable enum ('risk', 'assumption', 'ambiguity',
      // etc.) that is invariant to LLM phrasing variation.
      //
      // Fingerprint format: sorted type list joined by '|'
      // e.g. "assumption|risk|risk" (duplicates kept to detect count changes)
      const currentSignalKey = signals.map(s => s.type).sort().join('|');
      if (prevSignalKey !== null && currentSignalKey === prevSignalKey) {
        this._log(`\n[SelfCorrection] 🔁 Round ${round}: Signal type-set identical to previous round – oscillation detected. Terminating early.`);
        oscillationDetected = true;
        break;
      }
      // Partial-overlap check: if ≥80% of signal types are shared, treat as oscillation.
      // Uses type counts (not just unique types) so "2×risk + 1×assumption" vs
      // "2×risk + 1×ambiguity" correctly scores as 2/3 = 67% overlap (not 100%).
      if (prevSignalKey !== null) {
        const prevTypes = prevSignalKey.split('|');
        const curTypes  = signals.map(s => s.type);
        // Count how many (type, position) pairs match after sorting both lists
        const prevSorted = [...prevTypes].sort();
        const curSorted  = [...curTypes].sort();
        let matchCount = 0;
        let pi = 0, ci = 0;
        while (pi < prevSorted.length && ci < curSorted.length) {
          if (prevSorted[pi] === curSorted[ci]) { matchCount++; pi++; ci++; }
          else if (prevSorted[pi] < curSorted[ci]) { pi++; }
          else { ci++; }
        }
        const overlapRatio = matchCount / Math.max(prevSorted.length, curSorted.length);
        if (overlapRatio >= 0.8) {
          this._log(`\n[SelfCorrection] 🔁 Round ${round}: ${Math.round(overlapRatio * 100)}% signal-type overlap with previous round – oscillation detected. Terminating early.`);
          oscillationDetected = true;
          break;
        }
      }
      prevSignalKey = currentSignalKey;

      this._log(`\n[SelfCorrection] 🔍 Round ${round}/${this.maxRounds}: ${signals.length} issue(s) detected:`);
      signals.forEach(s => this._log(`  • [${s.severity}] ${s.label}${s.evidence ? ` – "${s.evidence.slice(0, 60)}"` : ''}`))
      this._log(`[SelfCorrection] 🔄 Sending refinement prompt to Agent...`);

      const refinementPrompt = buildRefinementPrompt(current, signals, stageLabel);

      try {
        const refined = await this.llmCall(refinementPrompt);
        history.push({ round, signals, before: current, after: refined });
        current = refined;
        this._log(`[SelfCorrection] ✏️  Round ${round} complete. Artifact updated.`);
      } catch (err) {
        this._log(`[SelfCorrection] ❌ Round ${round} failed: ${err.message}. Keeping previous version.`);
      // Decrement round to reflect successful rounds only. see CHANGELOG: N38
      round--;
      // see CHANGELOG: N56
      llmFailed = true;
        break;
      }
    }

    // P1-NEW-1: if oscillation was detected, skip the normal final-check path and
    // return immediately with needsHumanReview=true so the caller can escalate.
    if (oscillationDetected) {
      this._log(`\n[SelfCorrection] ⚠️  Oscillation detected after ${round} round(s). Marking for human review.`);
      const lastSignals = await this._detectSignals(current, stageLabel).catch(() => []);
      return {
        content: current,
        rounds: round,
        signals: lastSignals,
        history,
        needsHumanReview: true,
        oscillation: true,
      };
    }

    // Skip final signal detection when LLM failed – avoids false escalation. see CHANGELOG: N56
    if (llmFailed) {
      this._log(`\n[SelfCorrection] ⚠️  Exiting due to LLM failure after ${round} successful round(s). Skipping final signal check.`);
      return {
        content: current,
        rounds: round,
        signals: [],
        history,
        needsHumanReview: false,
        llmError: true,
      };
    }

    // ── P1 Round Objective Progression (Audit Method Borrowing) ──────────────
    // Three-objective final evaluation, inspired by the white-box audit methodology:
    //
    //   Round N+1 (Verification – depth):  Adversarial second-reviewer persona.
    //     Catches issues the self-correction loop glossed over.
    //
    //   Round N+2 (Correlation – cross-signal):  Causal chain analysis.
    //     Combines individual signals into compound systemic risks.
    //     Only runs when there are enough prior signals to correlate.
    //
    // The verification round always runs. The correlation round runs when:
    //   1. semanticMode is enabled (requires LLM)
    //   2. There are ≥2 signals across all history rounds to correlate
    //   3. maxRounds > 1 (trivial tasks with maxRounds=1 skip correlation)

    // Collect all signals from history for correlation context
    const allPriorSignals = history.reduce((acc, h) => {
      if (Array.isArray(h.signals)) acc.push(...h.signals);
      return acc;
    }, []);

    // Objective 2: Verification (adversarial depth scan)
    this._log(`\n[SelfCorrection] 🎯 Round objective: VERIFICATION (adversarial depth scan)`);
    let remainingSignals = await this._detectSignals(current, stageLabel, { verificationMode: true });
    let highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');

    // Objective 3: Correlation (cross-signal causal chain analysis)
    // Only run when there are enough prior signals to form meaningful correlations
    const shouldRunCorrelation = this.semanticMode
      && this.maxRounds > 1
      && (allPriorSignals.length + remainingSignals.length) >= 2;

    if (shouldRunCorrelation) {
      this._log(`[SelfCorrection] 🎯 Round objective: CORRELATION (cross-signal causal chain analysis)`);
      const correlationSignals = await this._detectSignals(
        current, stageLabel,
        { correlationMode: true, priorSignals: [...allPriorSignals, ...remainingSignals] }
      );

      if (correlationSignals.length > 0) {
        this._log(`[SelfCorrection] 🔗 Correlation analysis found ${correlationSignals.length} compound risk(s):`);
        correlationSignals.forEach(s => {
          const chain = s.chain ? ` (chain: ${s.chain.join(' → ')})` : '';
          this._log(`  • [${s.severity}] ${s.label}${chain}`);
        });
        // Merge correlation signals into remaining signals
        // Correlation signals are always at least medium severity
        remainingSignals = [...remainingSignals, ...correlationSignals];
        highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');
      } else {
        this._log(`[SelfCorrection] 🔗 Correlation analysis: no compound risks found.`);
      }
    }

    // If high-severity issues remain, attempt deep investigation before giving up
    if (highSeverityRemaining.length > 0 && this.investigationTools) {
      this._log(`\n[SelfCorrection] 🔬 High-severity issues remain. Starting deep investigation...`);
      const investigationResult = await this._deepInvestigate(current, highSeverityRemaining, stageLabel);

      if (investigationResult.enrichedContent) {
        // One more correction round with investigation findings injected
        this._log(`[SelfCorrection] 🔄 Applying investigation findings in final correction round...`);
        try {
          const finalPrompt = buildRefinementPrompt(investigationResult.enrichedContent, highSeverityRemaining, stageLabel);
          const finalRefined = await this.llmCall(finalPrompt);
          history.push({ round: round + 1, signals: highSeverityRemaining, before: current, after: finalRefined, source: 'deep-investigation' });
          current = finalRefined;
          this._log(`[SelfCorrection] ✏️  Post-investigation correction complete.`);
        } catch (err) {
          this._log(`[SelfCorrection] ❌ Post-investigation correction failed: ${err.message}`);
        }
      }

      // Re-evaluate after investigation-driven correction
      // Use enrichedContent as fallback when post-investigation correction failed. see CHANGELOG: P1-4/contentForFinalDetection, N24
      const contentForFinalDetection = current !== content ? current : (investigationResult.enrichedContent || current);
      try {
        remainingSignals = await this._detectSignals(contentForFinalDetection, stageLabel);
      } catch (err) {
        this._log(`[SelfCorrection] ⚠️  Final signal detection failed (${err.message}). Falling back to regex.`);
        remainingSignals = detectSignals(contentForFinalDetection);
      }
      highSeverityRemaining = remainingSignals.filter(s => s.severity === 'high');

      if (highSeverityRemaining.length === 0) {
        this._log(`[SelfCorrection] ✅ Deep investigation resolved all high-severity issues.`);
      } else {
        this._log(`[SelfCorrection] ⚠️  ${highSeverityRemaining.length} high-severity issue(s) still remain after deep investigation.`);
      }
    } else if (highSeverityRemaining.length > 0) {
      this._log(`\n[SelfCorrection] ⚠️  ${highSeverityRemaining.length} high-severity issue(s) remain. No investigation tools configured.`);
    }

    const needsHumanReview = highSeverityRemaining.length > 0;

    if (!needsHumanReview && remainingSignals.length === 0) {
      this._log(`\n[SelfCorrection] ✅ All issues resolved after ${round} round(s).`);
    } else if (!needsHumanReview) {
      this._log(`\n[SelfCorrection] ℹ️  ${remainingSignals.length} minor issue(s) remain. Proceeding automatically.`);
    }

    return {
      content: current,
      rounds: round,
      signals: remainingSignals,
      history,
      needsHumanReview,
    };
  }

  /**
   * Deep investigation: executes search, source reading, and experience queries
   * to gather additional context for resolving high-severity signals.
   *
   * @param {string}   content           - Current artifact content
   * @param {object[]} highSignals        - High-severity signals to investigate
   * @param {string}   stageLabel
   * @returns {Promise<{ enrichedContent: string|null, findings: string[] }>}
   */
  async _deepInvestigate(content, highSignals, stageLabel) {
    const findings = [];
    const tools = this.investigationTools;
    // P1-1 / P2-5 fix: readSource returns the same content for every signal because
    // it is keyed by stageLabel (not signalType). Calling it once per signal produces
    // N identical "Source Code Context" blocks in findings, wasting tokens and
    // potentially confusing the LLM. Fix: call readSource at most once per
    // _deepInvestigate invocation and share the result across all signals.
    let sourceContextAdded = false;

    for (const signal of highSignals) {
      this._log(`  [Investigate] 🔍 Signal: ${signal.label} (${signal.type})`);

      // 1. Search – look for related patterns, docs, or prior solutions
      if (typeof tools.search === 'function') {
        try {
          // P1-5 fix: build a precise search query from signal.evidence and signal.instruction
          // instead of the generic "${signal.type} ${stageLabel} solution best practice".
          // The generic query returns unrelated best-practice articles that have nothing
          // to do with the specific issue. Using the actual evidence text and instruction
          // produces targeted results that are directly actionable for this signal.
          const evidenceSnippet = (signal.evidence || '').slice(0, 80).trim();
          const instructionSnippet = (signal.instruction || '').slice(0, 80).trim();
          const searchQuery = evidenceSnippet
            ? `${signal.type} fix: ${evidenceSnippet}`
            : instructionSnippet
              ? `${signal.type} ${stageLabel}: ${instructionSnippet}`
              : `${signal.type} ${stageLabel} solution best practice`;
          this._log(`  [Investigate] 🌐 Running search for: "${searchQuery.slice(0, 100)}"`);
          const searchResult = await tools.search(searchQuery);
          if (searchResult) {
            findings.push(`### Search Findings for [${signal.label}]\n${searchResult}`);
            this._log(`  [Investigate] ✅ Search returned results.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Search failed: ${err.message}`);
        }
      } else {
        this._log(`  [Investigate] ⏭️  No search tool configured. Skipping.`);
      }

      // 2. Read source – scan relevant source files for context
      // P1-1 / P2-5 fix: only call readSource once across all signals (see above).
      if (typeof tools.readSource === 'function' && !sourceContextAdded) {
        try {
          this._log(`  [Investigate] 📂 Reading source files (shared across all signals)`);
          const sourceResult = await tools.readSource(signal.type, content);
          if (sourceResult) {
            findings.push(`### Source Code Context\n${sourceResult}`);
            sourceContextAdded = true;
            this._log(`  [Investigate] ✅ Source reading returned context.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Source reading failed: ${err.message}`);
        }
      } else if (typeof tools.readSource === 'function' && sourceContextAdded) {
        this._log(`  [Investigate] ⏭️  Source context already added – skipping duplicate readSource call.`);
      } else {
        this._log(`  [Investigate] ⏭️  No readSource tool configured. Skipping.`);
      }

      // 3. Experience index – query accumulated experience store
      if (typeof tools.queryExperience === 'function') {
        try {
          this._log(`  [Investigate] 🧠 Querying experience index for: ${signal.type}`);
          const expResult = await tools.queryExperience(signal.type);
          if (expResult) {
            findings.push(`### Experience Index for [${signal.label}]\n${expResult}`);
            this._log(`  [Investigate] ✅ Experience index returned ${expResult.length} chars.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Experience query failed: ${err.message}`);
        }
      } else {
        this._log(`  [Investigate] ⏭️  No queryExperience tool configured. Skipping.`);
      }

      // 4. Web search – fallback to internet when local knowledge is insufficient.
      //    Only triggers when: (a) webSearch tool is available AND (b) previous
      //    steps yielded fewer than 2 findings for this signal (i.e. local knowledge gap).
      if (typeof tools.webSearch === 'function' && findings.length < 2) {
        try {
          const evidenceSnippet = (signal.evidence || '').slice(0, 60).trim();
          const webQuery = evidenceSnippet
            ? `${signal.type} solution: ${evidenceSnippet}`
            : `${signal.type} ${stageLabel} best practice fix`;
          this._log(`  [Investigate] 🌐 Web search for: "${webQuery.slice(0, 100)}"`);
          const webResult = await tools.webSearch(webQuery);
          if (webResult) {
            findings.push(`### Web Search Results for [${signal.label}]\n${webResult}`);
            this._log(`  [Investigate] ✅ Web search returned results.`);
          }
        } catch (err) {
          this._log(`  [Investigate] ⚠️  Web search failed: ${err.message}`);
        }
      }
    }

    if (findings.length === 0) {
      this._log(`  [Investigate] ℹ️  No findings gathered from investigation.`);
      return { enrichedContent: null, findings };
    }

    // Inject findings as additional context into the artifact
    const enrichedContent = [
      content,
      ``,
      `---`,
      `## Investigation Findings (Auto-gathered for Self-Correction)`,
      ``,
      findings.join('\n\n'),
    ].join('\n');

    this._log(`  [Investigate] 📋 ${findings.length} finding(s) gathered. Enriching artifact for final correction.`);
    return { enrichedContent, findings };
  }

  /**
   * Detects signals in the given text.
   * Uses semantic (LLM) mode if enabled, falls back to regex on failure.
   *
   * P1 Round Objective Progression: supports three detection modes:
   *   - detection (default):  breadth scan – find all individual issues
   *   - verification:         depth scan – adversarial re-check of prior fixes
   *   - correlation:          cross-signal analysis – find causal chains
   *
   * @param {string}  text
   * @param {string}  stageLabel
   * @param {object}  [opts]
   * @param {boolean} [opts.verificationMode=false] - Adversarial second reviewer
   * @param {boolean} [opts.correlationMode=false]  - Cross-signal causal chain analysis
   * @param {object[]} [opts.priorSignals=[]]        - Signals from earlier rounds (for correlation)
   * @returns {Promise<object[]>} signals
   */
  async _detectSignals(text, stageLabel, { verificationMode = false, correlationMode = false, priorSignals = [] } = {}) {
    if (!this.semanticMode) {
      // Regex mode: fast, no LLM call (correlation not supported in regex mode)
      return detectSignals(text);
    }

    // Semantic mode: LLM understands context
    const modeLabel = correlationMode
      ? 'correlation (cross-signal)'
      : verificationMode ? 'verification (adversarial)' : 'detection';
    this._log(`[SelfCorrection] 🧠 Running semantic signal ${modeLabel} (LLM)...`);
    try {
      const prompt = correlationMode
        ? buildSemanticCorrelationPrompt(text, stageLabel, priorSignals)
        : verificationMode
          ? buildSemanticVerificationPrompt(text, stageLabel)
          : buildSemanticDetectionPrompt(text, stageLabel);
      // Use cheapLlmCall for semantic detection (cost-aware: ~$0.002/call)
      // Refinement prompts in correct() still use the main llmCall.
      const response = await this._semanticLlmCall(prompt);
      const signals = parseSemanticSignals(response);

      if (signals.length > 0) {
        this._log(`[SelfCorrection] 🧠 Semantic ${modeLabel} found ${signals.length} real issue(s).`);
      } else {
        this._log(`[SelfCorrection] 🧠 Semantic ${modeLabel}: no real issues found.`);
      }

      return signals;
    } catch (err) {
      // Fallback to regex on LLM failure (correlation mode falls back to empty)
      this._log(`[SelfCorrection] ⚠️  Semantic ${modeLabel} failed (${err.message}). Falling back to ${correlationMode ? 'empty' : 'regex'}.`);
      return correlationMode ? [] : detectSignals(text);
    }
  }

  _log(msg) {
    if (this.verbose) console.log(msg);
  }
}

/**
 * @typedef {object} SelfCorrectionResult
 * @property {string}   content           - Final (possibly corrected) artifact content
 * @property {number}   rounds            - Number of correction rounds performed
 * @property {object[]} signals           - Remaining signals after all rounds
 * @property {object[]} history           - Per-round correction history
 * @property {boolean}  needsHumanReview  - True only if high-severity issues remain
 */

// ─── Legacy ClarificationEngine (kept for backward compatibility) ─────────────

/**
 * @deprecated Use SelfCorrectionEngine instead.
 * Kept so existing callers don't break during migration.
 */
class ClarificationEngine {
  constructor(options = {}) {
    this._options = options;
    console.warn('[ClarificationEngine] Deprecated: use SelfCorrectionEngine for Agent self-correction mode.');
  }

  async analyse(proposalText, stageLabel = 'Review') {
    const signals = detectSignals(proposalText);
    if (signals.length === 0) return { signals: [], clarifications: [], skipped: true };
    return { signals, clarifications: [], skipped: false, needsHumanReview: signals.some(s => s.severity === 'high') };
  }
}

// ─── Report Formatter ─────────────────────────────────────────────────────────

/**
 * Formats self-correction results as a Markdown block for injection into artifacts.
 * @param {SelfCorrectionResult} result
 * @returns {string}
 */
function formatClarificationReport(result) {
  if (!result || (!result.history && !result.signals)) return '';
  if (result.rounds === 0 && result.signals.length === 0) return '';

  const lines = [
    `## Self-Correction Notes`,
    ``,
    `> Auto-generated by SelfCorrectionEngine. Rounds: ${result.rounds}.`,
    ``,
  ];

  if (result.history && result.history.length > 0) {
    for (const h of result.history) {
      lines.push(`### Round ${h.round} – ${h.signals.length} issue(s) fixed`);
      h.signals.forEach(s => lines.push(`- [${s.severity}] ${s.label}: ${s.instruction}`));
      lines.push('');
    }
  }

  if (result.signals && result.signals.length > 0) {
    lines.push(`### ⚠️ Remaining Issues (${result.signals.length})`);
    result.signals.forEach(s => lines.push(`- [${s.severity}] ${s.label}`));
    lines.push('');
  }

  if (result.needsHumanReview) {
    lines.push(`> **Human review recommended** – high-severity issues could not be auto-resolved.`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  SelfCorrectionEngine,
  ClarificationEngine,
  detectSignals,
  buildSemanticDetectionPrompt,
  buildSemanticVerificationPrompt,
  parseSemanticSignals,
  formatClarificationReport,
};
