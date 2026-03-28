/**
 * Experience Query Similarity – Content similarity, deduplication, and clustering
 *
 * Extracted from experience-query.js (ADR-33 Phase 4) to isolate the
 * similarity computation and deduplication engine from the core query mixin.
 *
 * This module provides:
 *   - computeNGramFingerprint()       – N-gram fingerprinting
 *   - computeMinHash()                – MinHash signature computation
 *   - computeMinHashSimilarity()      – MinHash-based Jaccard approximation
 *   - computeJaccardSimilarity()      – Direct Jaccard similarity
 *   - computeExperienceSimilarity()   – Weighted experience similarity
 *   - ExperienceDeduplicator          – Clustering and duplicate detection
 *
 * @module experience-query-similarity
 */

'use strict';

// ─── Content Similarity Clustering ─────────────────────────────────────────

/**
 * Computes n-gram fingerprint for text similarity comparison.
 *
 * @param {string} text - Input text
 * @param {number} [n=3] - N-gram size
 * @returns {Set<string>} Set of n-grams
 */
function computeNGramFingerprint(text, n = 3) {
  if (!text || !text.trim()) return new Set();

  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const ngrams = new Set();

  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(normalized);

  if (hasCJK) {
    for (let i = 0; i <= normalized.length - n; i++) {
      ngrams.add(normalized.slice(i, i + n));
    }
  } else {
    const words = normalized.split(' ').filter(Boolean);
    const effectiveN = Math.min(n, Math.max(1, words.length));

    for (let i = 0; i <= words.length - effectiveN; i++) {
      ngrams.add(words.slice(i, i + effectiveN).join('_'));
    }

    for (const word of words) {
      if (word.length >= 3) {
        ngrams.add(word);
      }
    }
  }

  return ngrams;
}

/**
 * Computes MinHash signature for a set.
 *
 * @param {Set<string>} set - Input set
 * @param {number} [numHashes=16] - Number of hash functions
 * @returns {number[]} MinHash signature
 */
function computeMinHash(set, numHashes = 16) {
  const signature = [];
  const items = Array.from(set);

  for (let i = 0; i < numHashes; i++) {
    let minHash = Infinity;
    const seed = i + 1;

    for (const item of items) {
      let hash = 0;
      for (let j = 0; j < item.length; j++) {
        hash = ((hash * 31) + item.charCodeAt(j) + seed) & 0x7FFFFFFF;
      }
      minHash = Math.min(minHash, hash);
    }

    signature.push(minHash === Infinity ? 0 : minHash);
  }

  return signature;
}

/**
 * Computes Jaccard similarity between two MinHash signatures.
 *
 * @param {number[]} sig1 - First signature
 * @param {number[]} sig2 - Second signature
 * @returns {number} Similarity score [0, 1]
 */
function computeMinHashSimilarity(sig1, sig2) {
  if (!sig1 || !sig2 || sig1.length !== sig2.length) return 0;

  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) matches++;
  }

  return matches / sig1.length;
}

/**
 * Computes direct Jaccard similarity between two sets.
 *
 * @param {Set<string>} set1 - First set
 * @param {Set<string>} set2 - Second set
 * @returns {number} Jaccard similarity [0, 1]
 */
function computeJaccardSimilarity(set1, set2) {
  if (!set1.size || !set2.size) return 0;

  let intersection = 0;
  for (const item of set1) {
    if (set2.has(item)) intersection++;
  }

  return intersection / (set1.size + set2.size - intersection);
}

/**
 * Computes weighted similarity between two experiences.
 *
 * @param {object} exp1 - First experience
 * @param {object} exp2 - Second experience
 * @param {object} [options] - Comparison options
 * @returns {number} Weighted similarity score [0, 1]
 */
function computeExperienceSimilarity(exp1, exp2, options = {}) {
  const {
    titleWeight = 0.3,
    contentWeight = 0.7,
    useMinHash = false,
    ngramSize = 3,
  } = options;

  // Title similarity
  const title1 = (exp1.title || '').toLowerCase().trim();
  const title2 = (exp2.title || '').toLowerCase().trim();
  let titleSim = 0;

  if (title1 === title2 && title1.length > 0) {
    titleSim = 1.0;
  } else {
    const fp1 = computeNGramFingerprint(title1, ngramSize);
    const fp2 = computeNGramFingerprint(title2, ngramSize);

    if (fp1.size === 0 && fp2.size === 0) {
      titleSim = title1 === title2 ? 1.0 : 0.0;
    } else if (fp1.size === 0 || fp2.size === 0) {
      titleSim = 0.0;
    } else if (useMinHash && fp1.size > 100) {
      const sig1 = computeMinHash(fp1);
      const sig2 = computeMinHash(fp2);
      titleSim = computeMinHashSimilarity(sig1, sig2);
    } else {
      titleSim = computeJaccardSimilarity(fp1, fp2);
    }
  }

  // Content similarity
  const content1 = (exp1.content || '').toLowerCase().trim();
  const content2 = (exp2.content || '').toLowerCase().trim();
  let contentSim = 0;

  if (content1 === content2 && content1.length > 0) {
    contentSim = 1.0;
  } else {
    const fp1 = computeNGramFingerprint(content1, ngramSize);
    const fp2 = computeNGramFingerprint(content2, ngramSize);

    if (fp1.size === 0 && fp2.size === 0) {
      contentSim = content1 === content2 ? 1.0 : 0.0;
    } else if (fp1.size === 0 || fp2.size === 0) {
      contentSim = 0.0;
    } else if (useMinHash && fp1.size > 100) {
      const sig1 = computeMinHash(fp1);
      const sig2 = computeMinHash(fp2);
      contentSim = computeMinHashSimilarity(sig1, sig2);
    } else {
      contentSim = computeJaccardSimilarity(fp1, fp2);
    }
  }

  return titleSim * titleWeight + contentSim * contentWeight;
}

/**
 * Experience deduplication and clustering engine.
 * Groups similar experiences and identifies potential duplicates.
 */
class ExperienceDeduplicator {
  constructor(options = {}) {
    this.options = {
      similarityThreshold: 0.75,
      clusterThreshold: 0.50,
      useMinHash: true,
      ngramSize: 3,
      maxComparisons: 10000,
      ...options,
    };

    this._signatureCache = new Map();
  }

  /**
   * Groups experiences into clusters based on content similarity.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of clusters
   */
  cluster(experiences) {
    if (!experiences || experiences.length === 0) return [];

    const clusters = [];
    const visited = new Set();

    for (const exp of experiences) {
      if (!this._signatureCache.has(exp.id)) {
        this._signatureCache.set(exp.id, this._computeSignature(exp));
      }
    }

    for (let i = 0; i < experiences.length; i++) {
      const exp1 = experiences[i];
      if (visited.has(exp1.id)) continue;

      const cluster = {
        id: `cluster-${i}`,
        representative: exp1,
        members: [exp1],
        avgSimilarity: 1.0,
        type: exp1.type,
        category: exp1.category,
      };

      visited.add(exp1.id);

      for (let j = i + 1; j < experiences.length; j++) {
        const exp2 = experiences[j];
        if (visited.has(exp2.id)) continue;

        if (exp1.type !== exp2.type) continue;
        if (exp1.category !== exp2.category) continue;

        const similarity = this._computeCachedSimilarity(exp1, exp2);

        if (similarity >= this.options.clusterThreshold) {
          cluster.members.push(exp2);
          visited.add(exp2.id);
        }
      }

      if (cluster.members.length > 1) {
        cluster.avgSimilarity = this._computeAvgSimilarity(cluster.members);
      }

      clusters.push(cluster);
    }

    return clusters.sort((a, b) => b.members.length - a.members.length);
  }

  /**
   * Finds duplicate experiences based on high similarity threshold.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of duplicate groups
   */
  findDuplicates(experiences) {
    if (!experiences || experiences.length === 0) return [];

    const duplicates = [];
    const processed = new Set();

    for (let i = 0; i < experiences.length; i++) {
      const exp1 = experiences[i];
      if (processed.has(exp1.id)) continue;

      const group = {
        primary: exp1,
        duplicates: [],
        similarityScores: [],
      };

      for (let j = i + 1; j < experiences.length; j++) {
        const exp2 = experiences[j];
        if (processed.has(exp2.id)) continue;

        const similarity = computeExperienceSimilarity(exp1, exp2, this.options);

        if (similarity >= this.options.similarityThreshold) {
          group.duplicates.push(exp2);
          group.similarityScores.push({ id: exp2.id, score: similarity });
          processed.add(exp2.id);
        }
      }

      if (group.duplicates.length > 0) {
        duplicates.push(group);
        processed.add(exp1.id);
      }
    }

    return duplicates;
  }

  /**
   * Suggests merge candidates for similar experiences.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of merge suggestions
   */
  suggestMerges(experiences) {
    const clusters = this.cluster(experiences);
    const suggestions = [];

    for (const cluster of clusters) {
      if (cluster.members.length < 2) continue;
      if (cluster.avgSimilarity < 0.6) continue;

      const suggestion = {
        clusterId: cluster.id,
        type: cluster.type,
        category: cluster.category,
        memberCount: cluster.members.length,
        avgSimilarity: cluster.avgSimilarity,
        representative: {
          id: cluster.representative.id,
          title: cluster.representative.title,
        },
        mergeCandidates: cluster.members.slice(1).map(m => ({
          id: m.id,
          title: m.title,
          similarity: this._computeCachedSimilarity(cluster.representative, m),
        })),
        rationale: this._generateRationale(cluster),
      };

      suggestions.push(suggestion);
    }

    return suggestions.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
  }

  clearCache() {
    this._signatureCache.clear();
  }

  getCacheStats() {
    return {
      cacheSize: this._signatureCache.size,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  _computeSignature(exp) {
    const text = `${exp.title || ''} ${exp.content || ''}`.toLowerCase();
    const fingerprint = computeNGramFingerprint(text, this.options.ngramSize);

    return {
      fingerprint,
      minHash: this.options.useMinHash ? computeMinHash(fingerprint) : null,
      length: text.length,
    };
  }

  _computeCachedSimilarity(exp1, exp2) {
    const sig1 = this._signatureCache.get(exp1.id);
    const sig2 = this._signatureCache.get(exp2.id);

    if (!sig1 || !sig2) {
      return computeExperienceSimilarity(exp1, exp2, this.options);
    }

    if (this.options.useMinHash && sig1.minHash && sig2.minHash) {
      const titleSim = computeMinHashSimilarity(
        computeMinHash(computeNGramFingerprint((exp1.title || '').toLowerCase())),
        computeMinHash(computeNGramFingerprint((exp2.title || '').toLowerCase()))
      );
      const contentSim = computeMinHashSimilarity(sig1.minHash, sig2.minHash);
      return titleSim * 0.3 + contentSim * 0.7;
    }

    return computeJaccardSimilarity(sig1.fingerprint, sig2.fingerprint);
  }

  _computeAvgSimilarity(members) {
    if (members.length <= 1) return 1.0;

    let totalSim = 0;
    let count = 0;

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        totalSim += this._computeCachedSimilarity(members[i], members[j]);
        count++;
      }
    }

    return count > 0 ? totalSim / count : 1.0;
  }

  _generateRationale(cluster) {
    const parts = [];

    if (cluster.avgSimilarity >= 0.85) {
      parts.push('内容高度相似，可能是重复记录');
    } else if (cluster.avgSimilarity >= 0.7) {
      parts.push('内容相似度较高，建议合并');
    } else {
      parts.push('主题相关，可以考虑合并');
    }

    if (cluster.members.length > 2) {
      parts.push(`该主题下有 ${cluster.members.length} 条相关经验`);
    }

    return parts.join('；');
  }
}

// ─── Module exports ───────────────────────────────────────────────────────

module.exports = {
  ExperienceDeduplicator,
  computeNGramFingerprint,
  computeMinHash,
  computeMinHashSimilarity,
  computeJaccardSimilarity,
  computeExperienceSimilarity,
};
