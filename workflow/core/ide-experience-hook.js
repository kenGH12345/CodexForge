/**
 * IDE Experience Hook – Lightweight signal capture for IDE-First mode
 *
 * ADR-43 Extension: Solves the "experience gap" when tasks are routed to IDE directly.
 * When RequestTriage suggests ide_direct (simple tasks), this hook provides a minimal
 * experience capture path that doesn't require the full workflow pipeline.
 *
 * Design Principles:
 *   - Zero Orchestrator dependency: works standalone
 *   - Token-efficient: only uses regex-based detection, no LLM calls
 *   - Fire-and-forget: doesn't block IDE execution
 *   - Opt-in: caller decides whether to invoke the hook
 *
 * Usage:
 *   const { runIdeExperienceHook } = require('./ide-experience-hook');
 *   const result = await runIdeExperienceHook({
 *     requirement: 'Fix typo in README',
 *     score: 5,
 *     experienceStore: orchestrator.experienceStore,
 *   });
 *
 * @module workflow/core/ide-experience-hook
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Signal Patterns (from SessionSignalDetector) ───────────────────────────

const SIGNAL_PATTERNS = [
  {
    type: 'ERROR_KEYWORD',
    patterns: [
      /\b(error|exception|failed|failure|crash|abort|timeout)\b/i,
      /\b(bug|fix|issue|problem|broken)\b/i,
      /(崩溃|报错|异常|失败|错误)/,
      /(无法|不能|不支持)/,
    ],
    weight: 0.7,
  },
  {
    type: 'NEGATION',
    patterns: [
      /\b(doesn'?t work|not supported|can'?t do|unable to|won'?t)\b/i,
      /\b(no solution|no way|impossible)\b/i,
      /(不工作|没用|没办法|无法解决)/,
    ],
    weight: 0.5,
  },
  {
    type: 'WORKAROUND',
    patterns: [
      /\b(workaround|hack|bypass|alternative)\b/i,
      /\b(instead of|had to|ended up)\b/i,
      /(绕过|规避|换了个)/,
    ],
    weight: 0.8,
  },
  {
    type: 'DISCOVERY',
    patterns: [
      /\b(discovered|found that|turns out|realized)\b/i,
      /\b(the trick is|key insight|important)\b/i,
      /(发现|原来|关键是|重要)/,
    ],
    weight: 0.6,
  },
  {
    type: 'GOTCHA',
    patterns: [
      /\b(gotcha|trap|pitfall|caveat|note that)\b/i,
      /(坑|陷阱|注意|小心)/,
    ],
    weight: 0.8,
  },
];

// ─── Simple Signal Detection ──────────────────────────────────────────────

/**
 * Detects signals from requirement text using regex patterns.
 * This is a lightweight version of SessionSignalDetector.detectSignals().
 *
 * @param {string} text - Text to analyze (requirement, description, etc.)
 * @returns {{ signals: object[], score: number }}
 */
function detectSignalsFromText(text) {
  if (!text || typeof text !== 'string') {
    return { signals: [], score: 0 };
  }

  const signals = [];
  const seenTypes = new Set();

  for (const detector of SIGNAL_PATTERNS) {
    if (seenTypes.has(detector.type)) continue;

    for (const pattern of detector.patterns) {
      const match = text.match(pattern);
      if (match) {
        signals.push({
          type: detector.type,
          weight: detector.weight,
          evidence: match[0],
        });
        seenTypes.add(detector.type);
        break;
      }
    }
  }

  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  return { signals, score };
}

// ─── Lightweight Experience Capture ────────────────────────────────────────

/**
 * Captures a simple experience to the ExperienceStore.
 * Used when signals are detected but no LLM is available for extraction.
 *
 * @param {object} experienceStore - ExperienceStore instance
 * @param {object} options
 * @param {string} options.requirement - The original requirement
 * @param {object[]} options.signals - Detected signals
 * @param {number} options.score - Signal score
 */
function captureSimpleExperience(experienceStore, { requirement, signals, score }) {
  if (!experienceStore || typeof experienceStore.record !== 'function') {
    return null;
  }

  // Determine experience type based on signals
  const hasErrorSignal = signals.some(s => s.type === 'ERROR_KEYWORD' || s.type === 'NEGATION');
  const hasWorkaroundSignal = signals.some(s => s.type === 'WORKAROUND');
  const hasDiscoverySignal = signals.some(s => s.type === 'DISCOVERY');

  const type = hasErrorSignal ? 'negative' : 'positive';
  const category = hasWorkaroundSignal ? 'debug_technique'
                 : hasDiscoverySignal ? 'stable_pattern'
                 : 'pitfall';

  const signalSummary = signals.map(s => `${s.type}: ${s.evidence}`).join('; ');

  const title = type === 'negative'
    ? `IDE session: ${requirement.slice(0, 40)}...`
    : `IDE discovery: ${requirement.slice(0, 40)}...`;

  const content = type === 'negative'
    ? `Session routed to IDE (complexity score: ${score.toFixed(1)}). Signals detected: ${signalSummary}. Consider similar tasks for IDE-first approach.`
    : `Session routed to IDE (complexity score: ${score.toFixed(1)}). Discovery: ${signalSummary}.`;

  return experienceStore.record({
    type,
    category,
    title,
    content,
    tags: ['ide-first', 'lightweight-hook', 'signal-captured', ...signals.map(s => s.type.toLowerCase())],
    ttlDays: 60,  // Shorter TTL for auto-captured experiences
  });
}

// ─── Main Export: Run IDE Experience Hook ──────────────────────────────────

/**
 * Runs the lightweight experience hook for IDE-routed sessions.
 * This is the main entry point for ADR-43 extension.
 *
 * @param {object} options
 * @param {string} options.requirement - The original user requirement
 * @param {number} options.score - Triage complexity score
 * @param {string[]} options.matchedTags - Tags matched by triage rules
 * @param {object} [options.experienceStore] - ExperienceStore instance (optional)
 * @param {object} [options.logger] - Logger instance (optional)
 * @returns {Promise<{ captured: boolean, signals: object[], score: number, expId?: string }>}
 */
async function runIdeExperienceHook(options) {
  const { requirement, score, matchedTags, experienceStore, logger } = options;

  const log = (msg) => {
    if (logger) {
      logger.info('IdeExperienceHook', msg);
    }
    console.log(`[IdeExperienceHook] ${msg}`);
  };

  // Step 1: Detect signals from requirement
  const { signals, score: signalScore } = detectSignalsFromText(requirement);

  // Step 2: Determine if capture is warranted
  // Lower threshold than full workflow because IDE sessions are shorter
  const shouldCapture = signalScore >= 0.5 || signals.length >= 1;

  if (!shouldCapture) {
    log(`No significant signals detected (score=${signalScore.toFixed(2)}), skipping capture.`);
    return { captured: false, signals, score: signalScore };
  }

  log(`Detected ${signals.length} signal(s) with score=${signalScore.toFixed(2)}`);

  // Step 3: Capture to ExperienceStore (if available)
  if (experienceStore) {
    try {
      const exp = captureSimpleExperience(experienceStore, { requirement, signals, score: signalScore });
      if (exp) {
        log(`Captured experience: ${exp.id}`);
        return { captured: true, signals, score: signalScore, expId: exp.id };
      }
    } catch (err) {
      console.warn(`[IdeExperienceHook] Experience capture failed (non-fatal): ${err.message}`);
    }
  }

  // Step 4: Return result even if no ExperienceStore
  return { captured: false, signals, score: signalScore };
}

// ─── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  runIdeExperienceHook,
  detectSignalsFromText,
  SIGNAL_PATTERNS,
};
