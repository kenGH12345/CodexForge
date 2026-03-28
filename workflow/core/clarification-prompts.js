/**
 * Clarification Prompts for Semantic Signal Detection
 *
 * Extracted from clarification-engine.js for maintainability (ADR-41).
 * Contains LLM prompt builders for semantic signal detection, verification,
 * correlation analysis, and refinement.
 *
 * @module workflow/core/clarification-prompts
 */

'use strict';

// ─── Semantic Detection Prompt ───────────────────────────────────────────────

/**
 * Builds the semantic signal detection prompt.
 * Asks LLM to analyse the document holistically and return structured signals.
 *
 * Key improvements over regex mode:
 *  1. Distinguishes "real risks" (no mitigation) from "mentioned risks" (already mitigated)
 *  2. Detects logic errors and contradictions that don't contain trigger keywords
 *  3. Understands context: "default" in a config example ≠ unverified assumption
 *
 * @param {string} text        - Document text to analyse
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @returns {string} prompt
 */
function buildSemanticDetectionPrompt(text, stageLabel) {
  // Cap document at 6000 chars to stay within LLM context window. see CHANGELOG: P1-4/buildSemanticDetectionPrompt
  const MAX_DOC_CHARS = 6000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const head = text.slice(0, half);
    const tail = text.slice(-half);
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${head}\n\n... [${omitted} chars omitted for token budget] ...\n\n${tail}`;
    // Only log in non-test environments to avoid noise in unit tests
    if (typeof console !== 'undefined' && process.env.NODE_ENV !== 'test') {
      console.log(`[SelfCorrectionEngine] 📏 Document truncated for semantic detection: ${text.length} → ${docText.length} chars (${omitted} omitted).`);
    }
  }

  return [
    `You are **W. Edwards Deming** – the father of quality management, creator of the PDCA (Plan-Do-Check-Act) cycle, and the statistician who transformed post-war Japanese manufacturing into a quality powerhouse.
You believe that quality must be built in, not inspected in. You are performing a semantic signal analysis on a ${stageLabel} document to identify the quality defects that will cause rework downstream.`,
    ``,
    `## Your Task`,
    ``,
    `Analyse the document below and identify REAL issues. Apply the following rules strictly:`,
    ``,
    `### Signal Types to Detect`,
    ``,
    `1. **ambiguity** (medium) – Vague, unmeasurable, or undefined terms that leave room for misinterpretation.`,
    `   - REAL: "some users", "fast enough", "large scale" with no concrete definition`,
    `   - NOT REAL: technical terms used correctly in context (e.g. "default timeout = 30s" is NOT ambiguous)`,
    ``,
    `2. **assumption** (high) – Unverified premises that the design depends on but are not justified.`,
    `   - REAL: "We assume the database can handle 10k QPS" with no evidence or load test`,
    `   - NOT REAL: "By default, retry count is 3" – this is a configuration decision, not an assumption`,
    ``,
    `3. **risk** (high) – Unmitigated risks. A risk is REAL only if NO mitigation strategy is described.`,
    `   - REAL: "Network latency may cause timeouts" with no retry/fallback described`,
    `   - NOT REAL: "Network latency risk – mitigated by exponential backoff retry" – already handled`,
    ``,
    `4. **contradiction** (high) – Logically conflicting statements, even without explicit contradiction words.`,
    `   - REAL: Section A says "stateless service", Section B says "session stored in memory"`,
    `   - REAL: "High availability" requirement but "single instance deployment" in architecture`,
    `   - NOT REAL: Discussing trade-offs explicitly ("We chose X over Y because...")`,
    ``,
    `5. **alternative** (medium) – Multiple options presented without a final decision.`,
    `   - REAL: "We can use Redis or Memcached" with no decision made`,
    `   - NOT REAL: "We evaluated Redis and Memcached, and chose Redis because of persistence support"`,
    ``,
    `6. **logic_error** (high) – Logical flaws in the design that are NOT covered by the above types.`,
    `   - REAL: A flow diagram shows step B depends on step C, but step C comes after step B`,
    `   - REAL: "Cache invalidation on write" but the write path described doesn't include cache invalidation`,
    `   - REAL: A security requirement exists but the described auth flow has a bypass path`,
    ``,
    `## Critical Rules`,
    ``,
    `- Only report REAL issues. False positives are worse than false negatives.`,
    `- If a risk/assumption is explicitly acknowledged AND has a concrete mitigation/justification, it is NOT a signal.`,
    `- If you are unsure whether something is a real issue, do NOT report it.`,
    `- Maximum 5 signals total. Prioritise high-severity issues.`,
    ``,
    `## Document to Analyse`,
    ``,
    docText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "type": one of: ambiguity | assumption | risk | contradiction | alternative | logic_error`,
    `- "severity": "high" | "medium" | "low"`,
    `- "label": short descriptive label (e.g. "Unmitigated network timeout risk")`,
    `- "layer": "What" | "Why" | "How" | "What-if"`,
    `- "evidence": one sentence quoting or referencing the specific text that triggered this signal`,
    `- "instruction": one concrete instruction for the author to fix this issue`,
    ``,
    `If NO real issues are found, return an empty array: []`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

// ─── Semantic Verification Prompt ─────────────────────────────────────────────

/**
 * Builds an adversarial verification prompt for the final signal check.
 *
 * Independence principle (P1-A fix):
 *   The standard detection prompt asks the LLM to "find issues". After self-correction,
 *   the same LLM tends to confirm its own fixes ("I fixed it, so it must be fine").
 *   This verification prompt uses a DIFFERENT persona – a sceptical second reviewer
 *   who is specifically looking for issues that a previous reviewer might have missed
 *   or glossed over. This breaks the self-validation loop.
 *
 * @param {string} text        - Document text to verify
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @returns {string} prompt
 */
function buildSemanticVerificationPrompt(text, stageLabel) {
  const MAX_DOC_CHARS = 6000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${text.slice(0, half)}\n\n... [${omitted} chars omitted for token budget] ...\n\n${text.slice(-half)}`;
  }

  return [
    `You are **Nassim Nicholas Taleb** – author of *The Black Swan* and *Antifragile*, and the world's foremost expert on hidden risks, tail events, and the fragility of systems that look robust on the surface.
You are performing a final adversarial quality gate check on a ${stageLabel} document. Your job is to find the risks that the previous reviewer normalised away.`,
    ``,
    `## Context`,
    ``,
    `This document has already been reviewed and self-corrected by another reviewer.`,
    `Your job is to act as an independent adversarial checker: assume the previous reviewer`,
    `may have been too lenient or may have missed subtle issues.`,
    ``,
    `## Your Task`,
    ``,
    `Look specifically for issues that are easy to overlook after self-correction:`,
    ``,
    `1. **Residual ambiguity** – Terms that are still vague after correction (e.g. "reasonable", "appropriate", "sufficient")`,
    `2. **Unverified assumptions** – Premises stated as facts without evidence or justification`,
    `3. **Unmitigated risks** – Risks mentioned but with no concrete mitigation plan (not just "we will handle it")`,
    `4. **Logical contradictions** – Two statements that cannot both be true, even if they use different words`,
    `5. **Undecided alternatives** – Multiple options still present with no final decision`,
    `6. **Logic errors** – Flows or dependencies that are internally inconsistent`,
    ``,
    `## Critical Rules`,
    ``,
    `- Be MORE strict than the original reviewer. If something is borderline, report it.`,
    `- A risk with only a vague mitigation ("we will monitor it") is still an unmitigated risk.`,
    `- An assumption with only a weak justification ("it is generally accepted that...") is still unverified.`,
    `- Maximum 5 signals. Focus on the most impactful issues.`,
    `- If the document is genuinely clean, return an empty array.`,
    ``,
    `## Document to Verify`,
    ``,
    docText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element must have:`,
    `- "type": one of: ambiguity | assumption | risk | contradiction | alternative | logic_error`,
    `- "severity": "high" | "medium" | "low"`,
    `- "label": short descriptive label`,
    `- "layer": "What" | "Why" | "How" | "What-if"`,
    `- "evidence": one sentence quoting the specific text that triggered this signal`,
    `- "instruction": one concrete instruction to fix this issue`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

// ─── Semantic Correlation Prompt ──────────────────────────────────────────────

/**
 * Builds a correlation analysis prompt for the final round of self-correction.
 *
 * Correlation mode (P1 Audit Method Borrowing – Round Objective Progression):
 *   After detection (breadth) and verification (depth), this third objective
 *   performs cross-signal correlation analysis. It looks for CAUSAL CHAINS:
 *   signals that individually seem low/medium severity but combine into a
 *   high-severity systemic issue.
 *
 *   Inspired by the white-box audit methodology's "Phase 3: Correlation Analysis"
 *   which combines independent findings into attack chains.
 *
 * @param {string} text        - Document text to correlate
 * @param {string} stageLabel  - e.g. 'Architecture', 'Test Report'
 * @param {object[]} priorSignals - Signals from previous rounds (for context)
 * @returns {string} prompt
 */
function buildSemanticCorrelationPrompt(text, stageLabel, priorSignals = []) {
  const MAX_DOC_CHARS = 5000;
  let docText = text;
  if (text.length > MAX_DOC_CHARS) {
    const half = MAX_DOC_CHARS / 2;
    const omitted = text.length - MAX_DOC_CHARS;
    docText = `${text.slice(0, half)}\n\n... [${omitted} chars omitted for token budget] ...\n\n${text.slice(-half)}`;
  }

  const priorBlock = priorSignals.length > 0
    ? [
        `## Prior Signals (from earlier rounds)`,
        ``,
        `The following individual issues were detected in previous rounds:`,
        ...priorSignals.slice(0, 8).map((s, i) => `${i + 1}. [${s.severity}] ${s.type}: ${s.label}`),
        ``,
        `Your task is to find CONNECTIONS between these signals that create compound risks.`,
        ``,
      ].join('\n')
    : '';

  return [
    `You are **James Reason** – author of *Swiss Cheese Model* and the world's foremost`,
    `expert on systemic failure analysis. You understand that catastrophic failures`,
    `rarely come from a single cause – they emerge when multiple small gaps align.`,
    ``,
    `You are performing a **correlation analysis** on a ${stageLabel} document.`,
    `Your job is NOT to find new individual issues (previous rounds already did that).`,
    `Your job IS to find **causal chains** – combinations of signals that together`,
    `create a systemic risk greater than the sum of individual parts.`,
    ``,
    priorBlock,
    `## Correlation Patterns to Look For`,
    ``,
    `1. **Risk Amplification** – Issue A in one area makes Issue B in another area much worse`,
    `   (e.g. "missing input validation" + "direct SQL query" = SQL injection)`,
    `2. **Hidden Dependency** – Two seemingly independent components share a fragile assumption`,
    `   (e.g. both assume a config value exists, but neither validates it)`,
    `3. **Error Cascade** – A failure in component A propagates to B, C, D with no circuit breaker`,
    `   (e.g. no error handling + no retry + no fallback = total system failure)`,
    `4. **Contradictory Constraints** – Two requirements/design decisions conflict under edge cases`,
    `   (e.g. "must be stateless" + "must maintain session" = architectural tension)`,
    `5. **Single Point of Failure** – Multiple critical paths converge on one unprotected resource`,
    ``,
    `## Document to Analyse`,
    ``,
    docText,
    ``,
    `## Output Format`,
    ``,
    `Return a JSON array. Each element represents a CORRELATED risk chain:`,
    `- "type": "correlation"`,
    `- "severity": "high" | "medium" (correlations are always medium+ by definition)`,
    `- "label": short descriptive label for the compound risk`,
    `- "layer": "What-if" (correlations are always hypothetical compound scenarios)`,
    `- "evidence": one sentence describing which signals/components interact`,
    `- "instruction": one concrete instruction to break the causal chain`,
    `- "chain": array of 2-3 contributing factor descriptions (strings)`,
    ``,
    `## Critical Rules`,
    ``,
    `- Only report COMPOUND risks, not individual issues already found.`,
    `- Each correlation must involve at least 2 distinct components or concerns.`,
    `- Maximum 3 correlations. Focus on the highest-impact chains.`,
    `- If no meaningful correlations exist, return an empty array: []`,
    ``,
    `Return ONLY the JSON array. No markdown fences, no extra text.`,
  ].join('\n');
}

// ─── Parse Semantic Signals ───────────────────────────────────────────────────

/**
 * Parses LLM semantic detection response into signal objects.
 * Falls back to empty array on parse error.
 *
 * @param {string} response
 * @returns {{ type, label, layer, severity, instruction, evidence }[]}
 */
function parseSemanticSignals(response) {
  const stripped = response.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Try to extract JSON array from response
    const match = stripped.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return [];
      }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  // Normalise and validate each signal
  const validTypes = new Set(['ambiguity', 'assumption', 'risk', 'contradiction', 'alternative', 'logic_error']);
  const validSeverities = new Set(['high', 'medium', 'low']);

  return parsed
    .filter(s => s && validTypes.has(s.type) && validSeverities.has(s.severity))
    .map(s => ({
      type: s.type,
      label: s.label || s.type,
      layer: s.layer || 'What',
      severity: s.severity,
      evidence: s.evidence || '',
      instruction: s.instruction || `Fix the ${s.type} issue.`,
    }))
    .sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9);
    });
}

// ─── Refinement Prompt Builder ────────────────────────────────────────────────

/**
 * Builds a refinement prompt that instructs the Agent to fix detected issues.
 * @param {string} originalContent - The artifact content to refine
 * @param {{ type, label, layer, severity, instruction }[]} signals
 * @param {string} stageLabel
 * @returns {string}
 */
function buildRefinementPrompt(originalContent, signals, stageLabel) {
  const issueList = signals
    .map((s, i) => `${i + 1}. [${s.severity.toUpperCase()}] [${s.layer}] ${s.label}\n   → ${s.instruction}`)
    .join('\n\n');

  return [
    `You are **W. Edwards Deming** – father of quality management and the PDCA cycle.
You are performing a self-correction pass on the following ${stageLabel} artifact. Apply the same rigour you would to a quality audit: fix every defect completely, verify the fix does not introduce new defects, and leave the artifact in a better state than you found it.`,
    ``,
    `## Issues Detected`,
    ``,
    issueList,
    ``,
    `## Instructions`,
    ``,
    `Rewrite the artifact below to fix ALL of the issues listed above.`,
    `- Do NOT add new ambiguities or assumptions.`,
    `- Be specific, concrete, and decisive.`,
    `- Return the complete revised artifact (not just the changed parts).`,
    ``,
    `## Original Artifact`,
    ``,
    originalContent,
  ].join('\n');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  buildSemanticDetectionPrompt,
  buildSemanticVerificationPrompt,
  buildSemanticCorrelationPrompt,
  parseSemanticSignals,
  buildRefinementPrompt,
};
