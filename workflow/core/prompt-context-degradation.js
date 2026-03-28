/**
 * Prompt Context Degradation – Progressive context trimming for hallucination prevention
 *
 * Extracted from prompt-builder.js (ADR-33 Phase 4) to isolate the
 * context degradation logic from the main prompt assembly pipeline.
 *
 * This module provides:
 *   - _separateCriticalSections()   – Identify critical vs normal sections
 *   - _scoreSectionByImportance()   – Score sections by importance (0-100)
 *   - applyContextDegradation()     – Progressive section dropping
 *
 * @module prompt-context-degradation
 */

'use strict';

const { LLM } = require('../core/constants');
const { estimateTokens } = require('../tools/thin-tools');

// ─── Critical Section Detection ─────────────────────────────────────────────

/**
 * Critical markers (case-insensitive regex patterns) for sections that
 * should never be dropped during degradation.
 */
const CRITICAL_MARKERS = [
  // Architecture Decision Records
  /##?\s*Architecture\s+Decision\s+Record/i,
  /###?\s*ADR-\d+/i,
  /###?\s*Decision\s*:/i,
  // Error/Warning indicators
  /##?\s*[^\n]*⚠️|🔴|❌|⚠|CRITICAL|ERROR|WARNING|FAIL/i,
  /\b(CRITICAL|ERROR|WARNING|FAIL|BREAKING)\b.*:/i,
  // Known issues from Self-Reflection
  /##?\s*Known\s+Issues\s*\(Self-Reflection\)/i,
  /###?\s*Known\s+Issues/i,
  // Current task dependencies
  /##?\s*Current\s+Task/i,
  /##?\s*Requirements?/i,
  // Quality gates and risks
  /##?\s*Quality\s+Gate/i,
  /##?\s*Risk/i,
];

/**
 * Identifies critical sections that should never be dropped during degradation.
 *
 * @param {string[]} sections - Array of context sections
 * @returns {{critical: string[], normal: string[]}} Separated sections
 */
function separateCriticalSections(sections) {
  const critical = [];
  const normal = [];

  for (const section of sections) {
    const isCritical = CRITICAL_MARKERS.some(marker => marker.test(section));
    if (isCritical) {
      critical.push(section);
    } else {
      normal.push(section);
    }
  }

  return { critical, normal };
}

// ─── Section Importance Scoring ─────────────────────────────────────────────

/**
 * Role-specific keywords for importance scoring.
 */
const ROLE_KEYWORDS = {
  'analyst': ['requirement', 'scope', 'constraint', 'domain'],
  'architect': ['architecture', 'module', 'interface', 'pattern', 'dependency'],
  'planner': ['plan', 'task', 'step', 'execution', 'workflow'],
  'developer': ['function', 'class', 'implementation', 'code', 'method'],
  'tester': ['test', 'assert', 'mock', 'coverage', 'verify'],
  'coding-agent': ['function', 'class', 'implementation', 'code'],
};

/**
 * Scores a context section by importance (0-100).
 * Uses heuristic rules based on content type and role relevance.
 *
 * @param {string} section - The context section content
 * @param {string|null} role - The current agent role (for role-aware scoring)
 * @returns {number} Importance score (0-100)
 */
function scoreSectionByImportance(section, role = null) {
  let score = 50; // Base score

  const lowerSection = section.toLowerCase();
  const roleKey = role ? role.toLowerCase() : null;

  // 1. Role relevance boost
  if (roleKey && ROLE_KEYWORDS[roleKey]) {
    const keywords = ROLE_KEYWORDS[roleKey];
    const matches = keywords.filter(kw => lowerSection.includes(kw)).length;
    score += matches * 5;
  }

  // 2. Information density boost (code blocks are valuable)
  const codeBlockCount = (section.match(/```/g) || []).length / 2;
  score += Math.min(codeBlockCount * 10, 30);

  // 3. Structural importance (headers indicate organization)
  const headerCount = (section.match(/^#{1,3}\s+/gm) || []).length;
  score += Math.min(headerCount * 2, 10);

  // 4. Section type bonuses
  if (/\b(skills?|patterns?|best.?practices?)\b/i.test(lowerSection)) score += 15;
  if (/\b(examples?|snippets?)\b/i.test(lowerSection)) score += 10;
  if (/\b(experience|lessons?|pitfalls?)\b/i.test(lowerSection)) score += 12;

  // 5. Recency indicators
  if (/\b(recent|new|updated|changed|modified)\b/i.test(lowerSection)) score += 8;

  // 6. Penalize generic/verbose sections
  const wordCount = section.split(/\s+/).length;
  if (wordCount > 500) score -= 10;
  const density = codeBlockCount / (wordCount / 100 + 1);
  if (density < 0.1 && wordCount > 200) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Context Degradation Engine ─────────────────────────────────────────────

/**
 * Progressively drops low-priority sections when over the hallucination risk threshold.
 *
 * @param {string} fixedPrefix - The fixed prefix (cached part)
 * @param {string} dynamicInput - The dynamic input content
 * @param {string[]} autoSections - Auto-injected sections (skills, ADR, etc.)
 * @param {string[]} contextSections - Explicit context file sections
 * @param {string|null} role - Current agent role
 * @param {Function} buildKVCacheFriendlyPrompt - Prompt builder function
 * @param {Function} analysePromptNoise - Noise analysis function
 * @returns {{ prompt: string, meta: object }}
 */
function applyContextDegradation(fixedPrefix, dynamicInput, autoSections, contextSections, role, buildKVCacheFriendlyPrompt, analysePromptNoise) {
  const inputSection = `### Input\n${dynamicInput}`;

  // Separate critical sections (always preserve)
  const { critical: criticalAuto, normal: normalAuto } = separateCriticalSections(autoSections);
  const { critical: criticalContext, normal: normalContext } = separateCriticalSections(contextSections);

  // Score normal sections by importance
  const scoredNormalAuto = normalAuto.map(section => ({
    section,
    score: scoreSectionByImportance(section, role),
    tokens: estimateTokens(section),
  })).sort((a, b) => b.score - a.score);

  const scoredNormalContext = normalContext.map(section => ({
    section,
    score: scoreSectionByImportance(section, role),
    tokens: estimateTokens(section),
  })).sort((a, b) => b.score - a.score);

  // Phase 1: Try with only critical sections
  let degradedSuffix = [...criticalContext, inputSection].join('\n\n');
  let degradedResult = buildKVCacheFriendlyPrompt(fixedPrefix, degradedSuffix);
  let degradedNoise = analysePromptNoise(degradedResult.prompt);

  if (!degradedNoise.isHighRisk) {
    // Restore sections by importance score
    let restoredBudget = LLM.HALLUCINATION_RISK_THRESHOLD - degradedNoise.estimatedTokens;
    const restoredAuto = [];

    for (const { section, score, tokens } of scoredNormalAuto) {
      if (tokens <= restoredBudget) {
        restoredAuto.push(section);
        restoredBudget -= tokens;
      } else if (score >= 80) {
        console.log(`[PromptBuilder] ⚠️  High-importance section dropped (score ${score}, ${tokens} tokens): ${section.slice(0, 100).replace(/\n/g, ' ')}...`);
      }
    }

    const droppedCount = normalAuto.length - restoredAuto.length;
    if (droppedCount > 0) {
      console.log(`[PromptBuilder] 🔽 Context degradation: dropped ${droppedCount}/${normalAuto.length} low-priority section(s) to stay under hallucination threshold.`);
    }
    degradedSuffix = [...criticalAuto, ...restoredAuto, ...criticalContext, inputSection].join('\n\n');
    return buildKVCacheFriendlyPrompt(fixedPrefix, degradedSuffix);
  }

  // Phase 2: Still over budget — drop normal context sections too
  const keptNormalContext = [];
  let contextBudget = LLM.HALLUCINATION_RISK_THRESHOLD -
    estimateTokens(fixedPrefix) -
    estimateTokens(inputSection) -
    criticalContext.reduce((sum, s) => sum + estimateTokens(s), 0) -
    200;

  for (const { section, score, tokens } of scoredNormalContext) {
    if (tokens <= contextBudget) {
      keptNormalContext.push(section);
      contextBudget -= tokens;
    } else if (score >= 80) {
      console.warn(`[PromptBuilder] 🔴 Critical context section dropped due to budget! Score: ${score}, Tokens: ${tokens}`);
    }
  }

  const droppedContext = normalContext.length - keptNormalContext.length;
  console.log(`[PromptBuilder] 🔽 Context degradation (phase 2): dropped ${droppedContext}/${normalContext.length} normal-priority context file(s). Preserved: ${criticalContext.length} critical section(s).`);
  degradedSuffix = [...criticalAuto, ...criticalContext, ...keptNormalContext, inputSection].join('\n\n');
  return buildKVCacheFriendlyPrompt(fixedPrefix, degradedSuffix);
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  separateCriticalSections,
  scoreSectionByImportance,
  applyContextDegradation,
  CRITICAL_MARKERS,
  ROLE_KEYWORDS,
};
