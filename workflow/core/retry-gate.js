/**
 * Retry Gate — Artifact improvement verification for retry decisions
 *
 * Provides deterministic hash computation and similarity-based improvement
 * verification. Used by both IDE Agent mode and Node Orchestrator mode
 * to decide whether a retry produced meaningful improvement.
 *
 * @module retry-gate
 */

'use strict';

const crypto = require('crypto');

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

function computeArtifactHash(content) {
  if (content == null) return '';
  const normalized = String(content).trim().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function computeSimilarity(before, after) {
  if (before == null && after == null) return 1.0;
  if (before == null || after == null) return 0.0;

  const a = String(before).trim();
  const b = String(after).trim();
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Jaccard similarity on bigrams
  const bigramsA = new Set();
  const bigramsB = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));

  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  const union = bigramsA.size + bigramsB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

function verifyRetryImprovement(before, after, threshold) {
  const t = typeof threshold === 'number' ? threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const similarity = computeSimilarity(before, after);
  return {
    passed: similarity < t,
    similarity,
    threshold: t,
    reason: similarity >= t
      ? `Artifact too similar (${(similarity * 100).toFixed(1)}% >= ${(t * 100).toFixed(1)}%) — retry did not produce meaningful change`
      : `Artifact sufficiently different (${(similarity * 100).toFixed(1)}% < ${(t * 100).toFixed(1)}%) — retry produced improvement`,
  };
}

module.exports = { computeArtifactHash, computeSimilarity, verifyRetryImprovement, DEFAULT_SIMILARITY_THRESHOLD };
