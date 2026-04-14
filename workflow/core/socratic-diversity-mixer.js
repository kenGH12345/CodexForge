'use strict';

/**
 * Socratic Diversity Mixer — Balances relevance and discovery in question selection.
 *
 * Implements a two-layer selection strategy:
 *   - 85-90% relevance questions (high-score, content-anchored)
 *   - 10-15% exploratory questions (challenge unstated assumptions)
 *
 * Uses simple threshold clustering (Jaccard bigram similarity) to ensure
 * thematic diversity within the relevance pool.
 *
 * @module workflow/core/socratic-diversity-mixer
 */

const DEFAULT_EXPLORATION_RATIO = 0.125;
const CLUSTERING_THRESHOLD = 0.65;

class DiversityMixer {
  constructor(options = {}) {
    this.explorationRatio = options.explorationRatio !== undefined
      ? options.explorationRatio
      : DEFAULT_EXPLORATION_RATIO;
    this.clusteringThreshold = options.clusteringThreshold || CLUSTERING_THRESHOLD;
  }

  /**
   * Select questions with balanced relevance/exploration ratio.
   * @param {Array<{question: string, score: number, isExploratory?: boolean}>} candidates
   * @param {number} targetCount
   * @param {object} [taskFingerprint] - Optional task fingerprint for dynamic ratio
   * @returns {string[]} Selected questions
   */
  select(candidates, targetCount, taskFingerprint) {
    if (!candidates || candidates.length === 0) return [];
    const count = Math.max(1, targetCount);

    const ratio = this._determineExplorationRatio(taskFingerprint);
    const explorationQuota = Math.max(0, Math.ceil(count * ratio));
    const relevanceQuota = count - explorationQuota;

    const exploratory = candidates.filter(c => c.isExploratory === true);
    const relevant = candidates.filter(c => c.isExploratory !== true);

    relevant.sort((a, b) => (b.score || 0) - (a.score || 0));
    exploratory.sort((a, b) => (b.score || 0) - (a.score || 0));

    const relevanceSelection = this._selectFromClusters(relevant, relevanceQuota);
    const explorationSelection = this._selectExploratory(exploratory, explorationQuota);

    const combined = this._shuffleWithBalance(relevanceSelection, explorationSelection);
    return combined.map(c => c.question || c);
  }

  /**
   * Determine exploration ratio based on task fingerprint.
   */
  _determineExplorationRatio(taskFingerprint) {
    if (!taskFingerprint) return this.explorationRatio;
    const fp = String(taskFingerprint);
    if (fp === 'security') return 0.20;
    if (fp === 'refactor') return 0.15;
    if (fp === 'bugfix') return 0.10;
    return this.explorationRatio;
  }

  /**
   * Select from relevance candidates using threshold clustering for diversity.
   * Ensures no two selected questions are too similar (> clusteringThreshold).
   */
  _selectFromClusters(candidates, quota) {
    if (quota <= 0 || candidates.length === 0) return [];
    const selected = [];

    for (const candidate of candidates) {
      if (selected.length >= quota) break;
      const q = String(candidate.question || candidate);
      const tooSimilar = selected.some(s => {
        const sq = String(s.question || s);
        return _bigramSimilarity(q, sq) > this.clusteringThreshold;
      });
      if (!tooSimilar) selected.push(candidate);
    }

    if (selected.length < quota) {
      for (const candidate of candidates) {
        if (selected.length >= quota) break;
        if (!selected.includes(candidate)) selected.push(candidate);
      }
    }

    return selected;
  }

  /**
   * Select exploratory questions, preferring diverse strategies.
   */
  _selectExploratory(exploratory, quota) {
    if (quota <= 0 || exploratory.length === 0) return [];
    const byStrategy = {};
    for (const q of exploratory) {
      const strategy = q.strategy || 'unknown';
      if (!byStrategy[strategy]) byStrategy[strategy] = [];
      byStrategy[strategy].push(q);
    }

    const selected = [];
    const strategies = Object.keys(byStrategy);
    let i = 0;
    while (selected.length < quota && i < 20) {
      const strategy = strategies[i % strategies.length];
      const pool = byStrategy[strategy];
      if (pool && pool.length > 0) {
        selected.push(pool.shift());
      }
      i++;
    }

    return selected;
  }

  /**
   * Interleave relevance and exploratory questions for natural flow.
   * Places exploratory questions at ~50% and ~90% positions.
   */
  _shuffleWithBalance(relevance, exploration) {
    const result = [...relevance];
    for (let i = 0; i < exploration.length; i++) {
      const insertAt = Math.min(
        result.length,
        Math.floor(result.length * (0.5 + i * 0.4))
      );
      result.splice(insertAt, 0, exploration[i]);
    }
    return result;
  }
}

/**
 * Compute bigram similarity between two strings (for clustering).
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
function _bigramSimilarity(a, b) {
  const getBigrams = (s) => {
    const tokens = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ' ').split(/\s+/).filter(t => t.length >= 2);
    const bigrams = new Set();
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.add(tokens[i] + '_' + tokens[i + 1]);
    }
    return bigrams;
  };

  const ba = getBigrams(a);
  const bb = getBigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;

  let inter = 0;
  for (const bg of ba) {
    if (bb.has(bg)) inter++;
  }
  const union = ba.size + bb.size - inter;
  return union > 0 ? inter / union : 0;
}

module.exports = { DiversityMixer, _bigramSimilarity };
