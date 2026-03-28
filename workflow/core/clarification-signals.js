/**
 * Clarification Signal Patterns
 *
 * Extracted from clarification-engine.js for maintainability (ADR-41).
 * Contains signal detection patterns and regex-based detection logic.
 *
 * Signal Types:
 *  - ambiguity: Vague, unmeasurable terms
 *  - assumption: Unverified premises
 *  - risk: Unmitigated risks
 *  - contradiction: Logically conflicting statements
 *  - alternative: Multiple options without decision
 *
 * @module workflow/core/clarification-signals
 */

'use strict';

// ─── Signal Patterns ─────────────────────────────────────────────────────────

/**
 * Signal detection patterns for quality analysis.
 * Each pattern detects a specific type of issue in artifacts.
 */
const SIGNAL_PATTERNS = [
  {
    type: 'ambiguity',
    label: '🔍 Ambiguous Requirement',
    layer: 'What',
    severity: 'medium',
    patterns: [/\b(some|certain|a few|several|maybe|possibly|一些|某些|可能|也许|大概)\b/i],
    instruction: (match) => `The term "${match}" is ambiguous. Replace it with a concrete, measurable specification.`,
  },
  {
    type: 'assumption',
    label: '⚠️  Suspicious Assumption',
    layer: 'Why',
    severity: 'high',
    patterns: [/\b(assume|assuming|default|by default|假设|默认|缺省)\b/i],
    instruction: (match) => `The assumption "${match}" is unverified. Either justify it with evidence or remove it and state the explicit requirement.`,
  },
  {
    type: 'alternative',
    label: '🔀 Unresolved Alternative',
    layer: 'How',
    severity: 'medium',
    patterns: [/\b(or|alternatively|option [A-Z]|plan [A-Z]|方案[A-Z一二三]|或者|另一种)\b/i],
    instruction: (match) => `Multiple options are mentioned ("${match}") but no decision is made. Pick one option and justify the choice.`,
  },
  {
    type: 'risk',
    label: '🚨 Unmitigated Risk',
    layer: 'What-if',
    severity: 'high',
    // Two-step detection to avoid variable-length lookbehind (not supported in Node.js < 16):
    // Step 1: match the risk keyword with a simple forward-only lookahead (no lookbehind).
    // Step 2: the custom `filter` function checks the surrounding context to exclude
    //         already-mitigated risks (e.g. "mitigates the risk", "no risk", "risk is low").
    // This approach is compatible with ALL Node.js versions (no lookbehind at all).
    patterns: [/\b(might fail|could fail|risk|concern|potential issue|风险|隐患|警告)\b(?!\s+(?:is\s+)?(?:low|minimal|acceptable|mitigated|addressed|resolved|handled|managed))/i],
    // Filter: returns false (skip signal) if ALL occurrences of the match are preceded
    // by a mitigation phrase. If ANY occurrence is NOT mitigated, the signal is kept.
    // Scan ALL occurrences; return true if any is unmitigated. see CHANGELOG: P2-5/risk-filter
    filter: (match, fullText) => {
      const lowerText = fullText.toLowerCase();
      const lowerMatch = match.toLowerCase();
      const mitigationPrefixes = ['mitigates ', 'mitigated ', 'mitigating ', 'no ', 'without ', 'addresses ', 'addressed ', 'reduces ', 'reduced '];
      let searchFrom = 0;
      let foundUnmitigated = false;
      while (true) {
        const idx = lowerText.indexOf(lowerMatch, searchFrom);
        if (idx < 0) break;
        const prefix = lowerText.slice(Math.max(0, idx - 40), idx);
        const isMitigated = mitigationPrefixes.some(p => prefix.endsWith(p) || prefix.includes(p + 'the '));
        if (!isMitigated) {
          foundUnmitigated = true;
          break;
        }
        searchFrom = idx + 1;
      }
      return foundUnmitigated;
    },
    instruction: (match) => `The risk "${match}" is mentioned without a mitigation plan. Add a concrete mitigation strategy.`,
  },
  {
    type: 'contradiction',
    label: '⚡ Contradictory Statement',
    layer: 'What',
    severity: 'high',
    patterns: [/\b(but also|yet|however|on the other hand|既要.*又要|同时.*但是|一方面.*另一方面)\b/i],
    instruction: (match) => `There is a contradiction: "${match}". Resolve it by stating which requirement takes priority.`,
  },
];

// ─── Signal Detection (Regex mode) ──────────────────────────────────────────

/**
 * Scans proposal text and returns detected signals using regex patterns.
 * Fast, no LLM needed. Used as fallback when semantic mode is unavailable.
 *
 * @param {string} text
 * @returns {{ type, label, layer, severity, instruction }[]}
 */
function detectSignals(text) {
  const found = [];
  const seen = new Set();

  for (const detector of SIGNAL_PATTERNS) {
    for (const pattern of detector.patterns) {
      const match = text.match(pattern);
      if (match && !seen.has(detector.type)) {
        // Optional filter callback: allows detectors to exclude false positives
        // using context-aware logic (e.g. checking prefix text for mitigation phrases)
        // without relying on variable-length lookbehind assertions.
        if (typeof detector.filter === 'function' && !detector.filter(match[0], text)) {
          continue; // filtered out – skip this signal
        }
        seen.add(detector.type);
        found.push({
          type: detector.type,
          label: detector.label,
          layer: detector.layer,
          severity: detector.severity,
          instruction: detector.instruction(match[0]),
        });
      }
    }
  }

  // Sort by severity: high → medium → low
  const severityOrder = { high: 0, medium: 1, low: 2 };
  found.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  return found;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  SIGNAL_PATTERNS,
  detectSignals,
};
