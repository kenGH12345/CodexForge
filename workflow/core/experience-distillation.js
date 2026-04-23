/**
 * Experience Distillation Mixin – P2-C
 *
 * Implements experience consolidation and merging:
 *   - Identifies similar experiences by title similarity + tag overlap + category match
 *   - Merges groups of similar experiences into single high-confidence entries
 *   - Preserves the most valuable content while eliminating redundancy
 *   - Tracks distillation metadata for auditing
 *
 * Inspired by:
 *   - OpenHands' SWE-Playground "continual learning" consolidation
 *   - LangGraph's "Version your state" approach to memory management
 *   - Biological memory consolidation (short-term → long-term with compression)
 *
 * Usage:
 *   Called automatically on store load when experience count exceeds threshold,
 *   or manually via `store.distill()`.
 */

'use strict';

// ─── LSH (Locality Sensitive Hashing) for Fast Similarity Search ───────────

/**
 * LSH Index for fast approximate similarity search.
 * Uses MinHash signatures with banding technique to find candidate pairs.
 * Reduces O(n²) pairwise comparison to O(n) signature computation + O(candidates) verification.
 *
 * @see https://en.wikipedia.org/wiki/Locality-sensitive_hashing
 */
class MinHashLSH {
  /**
   * @param {object} options
   * @param {number} [options.numHashes=16] - Number of hash functions (signature length)
   * @param {number} [options.numBands=4] - Number of bands for LSH bucketing
   * @param {number} [options.numHashesPerBand] - Hashes per band (auto-computed if not specified)
   */
  constructor(options = {}) {
    this.numHashes = options.numHashes || 16;
    this.numBands = options.numBands || 4;
    this.numHashesPerBand = options.numHashesPerBand || Math.floor(this.numHashes / this.numBands);

    // Hash seeds for different hash functions
    this._seeds = Array.from({ length: this.numHashes }, (_, i) => i + 1);

    // Hash tables: bandIndex → hashValue → Set of item IDs
    this._tables = new Array(this.numBands).fill(null).map(() => new Map());

    // Store signatures for lookup
    this._signatures = new Map();

    // Stats
    this._insertCount = 0;
    this._queryCount = 0;
  }

  /**
   * Inserts an item into the LSH index.
   *
   * @param {string} id - Item identifier
   * @param {number[]} signature - MinHash signature array
   */
  insert(id, signature) {
    if (signature.length !== this.numHashes) {
      throw new Error(`Signature length ${signature.length} does not match expected ${this.numHashes}`);
    }

    this._signatures.set(id, signature);
    this._insertCount++;

    // Hash signature to bands and store in corresponding tables
    for (let bandIdx = 0; bandIdx < this.numBands; bandIdx++) {
      const start = bandIdx * this.numHashesPerBand;
      const end = Math.min(start + this.numHashesPerBand, this.numHashes);
      const bandSignature = signature.slice(start, end);
      const bandHash = this._hashBand(bandSignature);

      if (!this._tables[bandIdx].has(bandHash)) {
        this._tables[bandIdx].set(bandHash, new Set());
      }
      this._tables[bandIdx].get(bandHash).add(id);
    }
  }

  /**
   * Queries for similar items given a signature.
   * Returns candidate IDs that share at least one band hash.
   *
   * @param {number[]} signature - MinHash signature
   * @param {Set<string>} [exclude] - IDs to exclude from results
   * @returns {Set<string>} Candidate similar item IDs
   */
  query(signature, exclude = new Set()) {
    if (signature.length !== this.numHashes) {
      throw new Error(`Signature length ${signature.length} does not match expected ${this.numHashes}`);
    }

    this._queryCount++;
    const candidates = new Set();

    for (let bandIdx = 0; bandIdx < this.numBands; bandIdx++) {
      const start = bandIdx * this.numHashesPerBand;
      const end = Math.min(start + this.numHashesPerBand, this.numHashes);
      const bandSignature = signature.slice(start, end);
      const bandHash = this._hashBand(bandSignature);

      const bucket = this._tables[bandIdx].get(bandHash);
      if (bucket) {
        for (const id of bucket) {
          if (!exclude.has(id)) {
            candidates.add(id);
          }
        }
      }
    }

    return candidates;
  }

  /**
   * Gets the stored signature for an ID.
   *
   * @param {string} id
   * @returns {number[]|undefined}
   */
  getSignature(id) {
    return this._signatures.get(id);
  }

  /**
   * Gets statistics about the LSH index.
   *
   * @returns {{insertCount: number, queryCount: number, tableSizes: number[], collisionRate: number}}
   */
  getStats() {
    const tableSizes = this._tables.map(t => t.size);
    const totalBuckets = tableSizes.reduce((a, b) => a + b, 0);
    const nonEmptyBuckets = this._tables.reduce((sum, table) => {
      for (const bucket of table.values()) {
        if (bucket.size > 1) sum++;
      }
      return sum;
    }, 0);

    return {
      insertCount: this._insertCount,
      queryCount: this._queryCount,
      tableSizes,
      totalBuckets,
      collisionRate: totalBuckets > 0 ? nonEmptyBuckets / totalBuckets : 0,
    };
  }

  /**
   * Hashes a band signature to a bucket key.
   *
   * @param {number[]} bandSignature
   * @returns {string}
   * @private
   */
  _hashBand(bandSignature) {
    // Simple hash: combine numbers with separator
    return bandSignature.join(':');
  }
}

/**
 * Computes MinHash signature for text using LSH-compatible hashing.
 *
 * @param {string} text - Input text
 * @param {number} [numHashes=16] - Number of hash functions
 * @returns {number[]} MinHash signature
 */
function computeMinHashSignature(text, numHashes = 16) {
  if (!text || !text.trim()) {
    return new Array(numHashes).fill(0);
  }

  // Extract k-shingles (character-level 3-grams)
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const shingles = new Set();
  for (let i = 0; i <= normalized.length - 3; i++) {
    shingles.add(normalized.slice(i, i + 3));
  }

  if (shingles.size === 0) {
    return new Array(numHashes).fill(0);
  }

  // Compute MinHash signature
  const signature = [];
  for (let hashFuncIdx = 0; hashFuncIdx < numHashes; hashFuncIdx++) {
    const seed = hashFuncIdx + 1;
    let minHash = Infinity;

    for (const shingle of shingles) {
      // Simple hash: sum of char codes with seed
      let hash = seed;
      for (let i = 0; i < shingle.length; i++) {
        hash = ((hash * 31) + shingle.charCodeAt(i)) & 0x7FFFFFFF;
      }
      minHash = Math.min(minHash, hash);
    }

    signature.push(minHash);
  }

  return signature;
}

// ─── Similarity Computation ─────────────────────────────────────────────────

/**
 * Computes a normalised similarity score between two experience records.
 * Uses a weighted combination of:
 *   - Title similarity (bigram Jaccard, weight: 0.4)
 *   - Tag overlap (Jaccard, weight: 0.3)
 *   - Category match (exact, weight: 0.2)
 *   - Type match (positive/negative, weight: 0.1)
 *
 * @param {object} a - Experience record
 * @param {object} b - Experience record
 * @returns {number} Similarity score in [0, 1]
 */
function computeSimilarity(a, b) {
  const titleSim  = _bigramJaccard(a.title || '', b.title || '');
  const tagSim    = _setJaccard(new Set(a.tags || []), new Set(b.tags || []));
  const catMatch  = (a.category === b.category) ? 1.0 : 0.0;
  const typeMatch = (a.type === b.type) ? 1.0 : 0.0;

  return 0.4 * titleSim + 0.3 * tagSim + 0.2 * catMatch + 0.1 * typeMatch;

}

/**
 * Async version of computeSimilarity that adds an embedding semantic boost.
 * When an EmbeddingService is available and the bigram-based similarity is
 * below threshold but above a minimum floor, the embedding cosine similarity
 * is used as a supplementary signal.
 *
 * This catches cases like:
 *   "Use async/await for database calls" vs "Leverage async patterns for DB operations"
 *   → bigram Jaccard ≈ 0.15 (miss!) → embedding cosine ≈ 0.87 (catch!)
 *
 * @param {object} a - Experience record
 * @param {object} b - Experience record
 * @param {import('./embedding-service').EmbeddingService|null} embeddingService
 * @returns {Promise<number>} Similarity score in [0, 1]
 */
async function computeSimilarityAsync(a, b, embeddingService) {
  const baseSim = computeSimilarity(a, b);

  // Only attempt embedding boost when:
  // 1. EmbeddingService is available and ready
  // 2. Base similarity is in the "uncertain zone" (0.2 - 0.65)
  //    Below 0.2 = clearly different, above 0.65 = already caught by bigram
  if (!embeddingService || !embeddingService.isReady()) return baseSim;
  if (baseSim >= 0.65 || baseSim < 0.2) return baseSim;

  try {
    const titleA = (a.title || '').trim().toLowerCase();
    const titleB = (b.title || '').trim().toLowerCase();
    if (!titleA || !titleB) return baseSim;

    const [vecA, vecB] = await Promise.all([
      embeddingService.embed(titleA),
      embeddingService.embed(titleB),
    ]);

    if (!vecA || !vecB) return baseSim;

    const embeddingSim = embeddingService.cosineSimilarity(vecA, vecB);

    // If embedding says they're very similar (>0.75), boost the score
    // Weighted blend: 60% base + 40% embedding
    if (embeddingSim >= 0.75) {
      const boosted = 0.6 * baseSim + 0.4 * embeddingSim;
      return boosted;
    }
  } catch (_) {
    // Non-fatal: fall back to base similarity
  }

  return baseSim;
}

/**
 * Computes MinHash similarity between two signatures.
 *
 * @param {number[]} sig1
 * @param {number[]} sig2
 * @returns {number} Approximate Jaccard similarity
 */
function computeSignatureSimilarity(sig1, sig2) {
  if (!sig1 || !sig2 || sig1.length !== sig2.length) return 0;

  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) matches++;
  }
  return matches / sig1.length;
}

/**
 * Bigram Jaccard similarity for two strings.
 * @param {string} s1
 * @param {string} s2
 * @returns {number} in [0, 1]
 */
function _bigramJaccard(s1, s2) {
  const bg1 = _bigrams(s1.toLowerCase());
  const bg2 = _bigrams(s2.toLowerCase());
  if (bg1.size === 0 && bg2.size === 0) return 1.0;
  if (bg1.size === 0 || bg2.size === 0) return 0.0;

  let intersection = 0;
  for (const bg of bg1) {
    if (bg2.has(bg)) intersection++;
  }
  return intersection / (bg1.size + bg2.size - intersection);
}

/**
 * Extracts character bigrams from a string.
 * @param {string} s
 * @returns {Set<string>}
 */
function _bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/**
 * Jaccard similarity for two sets.
 * @param {Set} a
 * @param {Set} b
 * @returns {number} in [0, 1]
 */
function _setJaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ─── Conflict Detection ─────────────────────────────────────────────────────

/**
 * Contradiction signal keywords. When the newer experience's content contains
 * one of these relative to the older experience, it indicates a conflict.
 * We compare whether old and new content give opposite advice.
 */
const CONTRADICTION_SIGNALS = [
  // Direct negation pairs
  ['should', 'should not'],
  ['must', 'must not'],
  ['always', 'never'],
  ['recommended', 'deprecated'],
  ['use', 'avoid'],
  ['enable', 'disable'],
  ['correct', 'incorrect'],
  ['safe', 'unsafe'],
  ['required', 'optional'],
  ['do', "don't"],
  ['do', 'do not'],
];

/**
 * Detects if two experiences in the same category have contradictory content.
 * Uses lightweight heuristic (no LLM calls):
 *   1. Both must be in the same category
 *   2. Both must have high title similarity (>= 0.5 bigram Jaccard)
 *   3. Content contains opposing signals (e.g. "use X" vs "avoid X")
 *
 * @param {object} older - Older experience record
 * @param {object} newer - Newer experience record
 * @returns {{ isConflict: boolean, reason: string }}
 */
function detectConflict(older, newer) {
  // Must be same category to be a meaningful conflict
  if (older.category !== newer.category) {
    return { isConflict: false, reason: '' };
  }

  // Title similarity check — only flag conflicts for closely related experiences
  const titleSim = _bigramJaccard(older.title || '', newer.title || '');
  if (titleSim < 0.5) {
    return { isConflict: false, reason: '' };
  }

  const olderContent = (older.content || '').toLowerCase();
  const newerContent = (newer.content || '').toLowerCase();

  // Check for contradiction signals
  for (const [positive, negative] of CONTRADICTION_SIGNALS) {
    // Case 1: old says "positive", new says "negative"
    if (olderContent.includes(positive) && newerContent.includes(negative)) {
      return {
        isConflict: true,
        reason: `Opposing advice detected: older uses "${positive}", newer uses "${negative}"`,
      };
    }
    // Case 2: old says "negative", new says "positive"
    if (olderContent.includes(negative) && newerContent.includes(positive)) {
      return {
        isConflict: true,
        reason: `Opposing advice detected: older uses "${negative}", newer uses "${positive}"`,
      };
    }
  }

  // Check for type mismatch: one positive, one negative on the same topic
  if (older.type !== newer.type && titleSim >= 0.6) {
    return {
      isConflict: true,
      reason: `Type conflict: older is ${older.type}, newer is ${newer.type} (title similarity: ${(titleSim * 100).toFixed(0)}%)`,
    };
  }

  return { isConflict: false, reason: '' };
}

// ─── Distillation Mixin ─────────────────────────────────────────────────────

const ExperienceDistillationMixin = {

  /**
   * Identifies groups of similar experiences and merges each group into
   * a single consolidated experience record.
   *
   * Algorithm:
   *   1. Group experiences by category (cheap pre-filter)
   *   2. Within each category, compute pairwise similarity
   *   3. Build clusters using greedy single-linkage at threshold
   *   4. For each cluster of size >= 2, merge into one record
   *      - If cheapLlmCall is available: LLM semantic merge (3x quality)
   *      - Otherwise: heuristic concatenation (existing behavior)
   *
   * @param {object} [options]
   * @param {number} [options.similarityThreshold=0.65] - Min similarity to consider merging
   * @param {number} [options.minClusterSize=2]  - Min experiences in a cluster to trigger merge
   * @param {boolean} [options.dryRun=false]     - If true, return plan without modifying store
   * @returns {Promise<{ merged: number, removed: number, clusters: Array<{representative: string, members: string[]}> }>}
   */
  async distill({ similarityThreshold = 0.65, minClusterSize = 2, dryRun = false } = {}) {
    const start = Date.now();
    const experiences = this.experiences;
    if (experiences.length < minClusterSize) {
      return { merged: 0, removed: 0, clusters: [] };
    }

    // Step 1: Group by category for cheaper pairwise comparison
    const byCategory = new Map();
    for (const exp of experiences) {
      const cat = exp.category || 'unknown';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(exp);
    }

    // Step 2+3: Find clusters within each category using LSH for fast candidate generation
    // P4b fix: Use LSH (Locality Sensitive Hashing) with MinHash to reduce O(N²) to O(N)
    const allClusters = [];
    for (const [, catExps] of byCategory) {
      if (catExps.length < minClusterSize) continue;

      const n = catExps.length;

      // P4b: Use LSH for fast similarity candidate generation
      const lsh = new MinHashLSH({ numHashes: 16, numBands: 4 });
      const signatures = new Map();
      const tagSetCache = new Array(n);

      // Compute signatures and insert into LSH
      for (let i = 0; i < n; i++) {
        const text = `${catExps[i].title} ${catExps[i].content || ''}`.slice(0, 500);
        const sig = computeMinHashSignature(text, 16);
        signatures.set(i, sig);
        lsh.insert(String(i), sig);
        tagSetCache[i] = new Set(catExps[i].tags || []);
      }

      // Build adjacency based on LSH candidates
      const visited = new Set();
      const adjList = new Map();

      // For each experience, query LSH to find candidates
      for (let i = 0; i < n; i++) {
        const sigI = signatures.get(i);
        const candidates = lsh.query(sigI);

        for (const jStr of candidates) {
          const j = Number(jStr);
          if (j <= i) continue; // Avoid duplicate pairs

          // Quick pre-filter: type and category must match
          if (catExps[i].type !== catExps[j].type) continue;
          if (catExps[i].category !== catExps[j].category) continue;

          // Compute full similarity using cached bigrams and tag sets
          const titleSim = _bigramJaccard(
            catExps[i].title || '',
            catExps[j].title || ''
          );
          const tagSim = _setJaccard(tagSetCache[i], tagSetCache[j]);
          const catMatch = 1.0; // Same category (filtered above)
          const typeMatch = 1.0; // Same type (filtered above);
          const sim = 0.4 * titleSim + 0.3 * tagSim + 0.2 * catMatch + 0.1 * typeMatch;

          if (sim >= similarityThreshold) {
            if (!adjList.has(i)) adjList.set(i, new Set());
            if (!adjList.has(j)) adjList.set(j, new Set());
            adjList.get(i).add(j);
            adjList.get(j).add(i);
          } else if (sim >= 0.2 && this._embeddingService && this._embeddingService.isReady()) {
            // Embedding boost: when bigram similarity is in the uncertain zone,
            // check embedding cosine similarity for semantic duplicates.
            // This catches synonym-heavy duplicates that bigram Jaccard misses.
            try {
              const titleI = (catExps[i].title || '').trim().toLowerCase();
              const titleJ = (catExps[j].title || '').trim().toLowerCase();
              const vecI = this._embeddingService._cache.get(titleI);
              const vecJ = this._embeddingService._cache.get(titleJ);
              if (vecI && vecJ) {
                const embSim = this._embeddingService.cosineSimilarity(vecI, vecJ);
                const boostedSim = 0.6 * sim + 0.4 * embSim;
                if (boostedSim >= similarityThreshold) {
                  if (!adjList.has(i)) adjList.set(i, new Set());
                  if (!adjList.has(j)) adjList.set(j, new Set());
                  adjList.get(i).add(j);
                  adjList.get(j).add(i);
                }
              }
            } catch (_) { /* non-fatal: embedding boost is supplementary */ }
          }
        }
      }

      // Greedy single-linkage clustering from adjacency list
      for (let i = 0; i < n; i++) {
        if (visited.has(i)) continue;
        const neighbors = adjList.get(i);
        if (!neighbors || neighbors.size === 0) continue;

        const cluster = [i];
        visited.add(i);
        for (const j of neighbors) {
          if (!visited.has(j)) {
            cluster.push(j);
            visited.add(j);
          }
        }

        if (cluster.length >= minClusterSize) {
          allClusters.push(cluster.map(idx => catExps[idx]));
        }
      }
    }

    // Log LSH stats for debugging
    if (dryRun) {
      console.log(`[ExperienceDistillation] LSH processed ${experiences.length} experiences into ${allClusters.length} clusters`);
    }

    if (allClusters.length === 0) {
      return { merged: 0, removed: 0, clusters: [] };
    }

    // Step 4: Conflict detection + Merge each cluster
    const clusterDetails = [];
    const idsToRemove = new Set();
    const conflicts = [];

    for (const cluster of allClusters) {
      // ── Conflict Detection (within cluster) ─────────────────────────
      // Before merging, check if any pair within the cluster has contradictory
      // content. When a conflict is detected, the experience with higher
      // SOURCE TYPE WEIGHT wins (ARTICLE > CONVERSATION > DISTILLED).
      // If same weight, the NEWER experience wins (recency bias).
      const { getSourceTypeWeight, DEFAULT_SOURCE_TYPE } = require('./experience-types');
      const sortedByDate = [...cluster].sort(
        (a, b) => new Date(a.updatedAt || a.createdAt).getTime() - new Date(b.updatedAt || b.createdAt).getTime()
      );

      // Compare each pair within the cluster for conflicts
      for (let ci = 0; ci < sortedByDate.length; ci++) {
        for (let cj = ci + 1; cj < sortedByDate.length; cj++) {
          const older = sortedByDate[ci];
          const newer = sortedByDate[cj];
          const { isConflict, reason } = detectConflict(older, newer);
          if (isConflict) {
            // Determine winner based on source type weight
            const olderWeight = getSourceTypeWeight(older.sourceType || DEFAULT_SOURCE_TYPE);
            const newerWeight = getSourceTypeWeight(newer.sourceType || DEFAULT_SOURCE_TYPE);
            
            let winner, loser, resolution;
            if (newerWeight > olderWeight) {
              // Newer has higher authority weight → newer wins
              winner = newer;
              loser = older;
              resolution = 'keep-newer-higher-weight';
            } else if (olderWeight > newerWeight) {
              // Older has higher authority weight → older wins (override recency)
              winner = older;
              loser = newer;
              resolution = 'keep-older-higher-weight';
            } else {
              // Same weight → recency bias (newer wins)
              winner = newer;
              loser = older;
              resolution = 'keep-newer-same-weight';
            }

            conflicts.push({
              olderId: older.id,
              olderTitle: older.title,
              olderSourceType: older.sourceType || DEFAULT_SOURCE_TYPE,
              newerId: newer.id,
              newerTitle: newer.title,
              newerSourceType: newer.sourceType || DEFAULT_SOURCE_TYPE,
              reason,
              resolution,
              winnerId: winner.id,
            });
            // Mark the loser for removal
            idsToRemove.add(loser.id);
            if (!dryRun) {
              // Annotate the winner with conflict resolution metadata
              if (!winner.conflictResolutions) winner.conflictResolutions = [];
              winner.conflictResolutions.push({
                timestamp: new Date().toISOString(),
                supersededId: loser.id,
                supersededTitle: loser.title,
                supersededSourceType: loser.sourceType || DEFAULT_SOURCE_TYPE,
                reason,
                resolution,
              });
              winner.updatedAt = new Date().toISOString();
              console.log(`[ExperienceStore] ⚡ Conflict detected [${older.category}]: "${loser.title}" (${loser.sourceType || 'conversation'}) → superseded by "${winner.title}" (${winner.sourceType || 'conversation'}) (${reason})`);
            }
          }
        }
      }

      // Pick representative: highest hitCount, then newest
      const sorted = [...cluster].sort((a, b) => {
        if ((b.hitCount || 0) !== (a.hitCount || 0)) return (b.hitCount || 0) - (a.hitCount || 0);
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
      });
      const representative = sorted[0];
      const others = sorted.slice(1);

      if (!dryRun) {
        // Merge content from others into representative
        // When cheapLlmCall is available, use LLM semantic merge for higher quality.
        // LLM merge produces a coherent, deduplicated synthesis instead of naive concatenation.
        // Falls back to heuristic concatenation if LLM call fails or is unavailable.
        let mergedContent = null;
        const cheapLlm = typeof this._cheapLlmCall === 'function' ? this._cheapLlmCall : null;

        if (cheapLlm && others.length > 0) {
          try {
            mergedContent = await _llmSemanticMerge(cheapLlm, representative, others);
          } catch (err) {
            console.warn(`[ExperienceDistillation] ⚠️  LLM semantic merge failed (falling back to heuristic): ${err.message}`);
            mergedContent = null;
          }
        }

        if (!mergedContent) {
          // Heuristic fallback: simple concatenation (existing behavior)
          const heuristicContent = others.map(o =>
            `[Distilled from "${o.title}" (${o.id}, ${o.sourceType || 'conversation'})] ${o.content}`
          ).join('\n\n');
          if (heuristicContent) {
            mergedContent = `--- Distilled Knowledge ---\n${heuristicContent}`;
          }
        }

        if (mergedContent) {
          representative.content = `${representative.content}\n\n${mergedContent}`;
        }

        // Mark as DISTILLED source type
        const { SourceType } = require('./experience-types');
        representative.sourceType = SourceType.DISTILLED;

        // Accumulate hitCount from all members
        representative.hitCount = (representative.hitCount || 0) +
          others.reduce((sum, o) => sum + (o.hitCount || 0), 0);

        // Merge tags (union, deduplicated)
        const allTags = new Set(representative.tags || []);
        for (const o of others) {
          for (const t of (o.tags || [])) allTags.add(t);
        }
        representative.tags = [...allTags];

        // Track distillation metadata
        if (!representative.distillation) representative.distillation = [];
        representative.distillation.push({
          timestamp: new Date().toISOString(),
          mergedIds: others.map(o => o.id),
          mergedTitles: others.map(o => o.title),
          mergedSourceTypes: others.map(o => o.sourceType || 'conversation'),
        });

        representative.updatedAt = new Date().toISOString();
        representative.evolutionCount = (representative.evolutionCount || 0) + 1;
      }

      clusterDetails.push({
        representative: representative.title,
        representativeId: representative.id,
        members: cluster.map(c => c.title),
      });

      // Mark non-representative members for removal
      for (const o of others) {
        idsToRemove.add(o.id);
      }
    }

    let removed = 0;
    if (!dryRun && idsToRemove.size > 0) {
      const before = this.experiences.length;
      this.experiences = this.experiences.filter(e => !idsToRemove.has(e.id));
      this._titleIndex = new Set(this.experiences.map(e => e.title));
      removed = before - this.experiences.length;
      this._save();
    }

    const elapsed = Date.now() - start;
    const result = {
      merged: allClusters.length,
      removed: dryRun ? idsToRemove.size : removed,
      clusters: clusterDetails,
      conflicts,
    };

    const conflictMsg = conflicts.length > 0 ? `, ${conflicts.length} conflict(s) resolved (keep-newer)` : '';
    console.log(`[ExperienceStore] 🧪 Distillation ${dryRun ? '(dry-run)' : 'complete'}: ` +
      `${result.merged} cluster(s) merged, ${result.removed} redundant record(s) removed${conflictMsg} ` +
      `(${elapsed}ms)`);

    return result;
  },

  /**
   * INDUCE Stage: Pattern recognition and clustering for reflection signals.
   * Called by ReflectionCycle to identify patterns across signals of the same dimension.
   *
   * Algorithm:
   *   1. MinHash LSH for fast similarity candidate generation
   *   2. Jaccard similarity for pairwise candidate validation
   *   3. Greedy single-linkage clustering
   *   4. Optional LLM semantic clustering if cheapLlmCall available and signals >= threshold
   *
   * @param {object[]} entries - Reflection signals to cluster
   * @param {string} dimension - Signal dimension (performance, quality, blindspot, cognitive, user)
   * @param {object} [options]
   * @param {number} [options.similarityThreshold=0.65] - Min similarity for clustering
   * @param {number} [options.minClusterSize=2] - Min signals in a cluster
   * @param {number} [options.llmTriggerThreshold=3] - Min signals to trigger LLM clustering
   * @returns {Promise<{patterns: Array<{id, dimension, summary, signals, confidence}>, conflicts: Array, coverage: string}>}
   */
  async inducePatterns(entries, dimension, { similarityThreshold = 0.65, minClusterSize = 2, llmTriggerThreshold = 3 } = {}) {
    if (!entries || entries.length < minClusterSize) {
      return { patterns: [], conflicts: [], coverage: 'partial' };
    }

    const patterns = [];
    const conflicts = [];

    // Step 1: MinHash LSH for fast candidate generation
    const lsh = new MinHashLSH({ numHashes: 16, numBands: 4 });
    const signatures = new Map();

    for (let i = 0; i < entries.length; i++) {
      const text = `${entries[i].title || ''} ${entries[i].content || ''}`.slice(0, 500);
      const sig = computeMinHashSignature(text, 16);
      signatures.set(i, sig);
      lsh.insert(String(i), sig);
    }

    // Step 2: Build clusters using adjacency list
    const visited = new Set();
    const adjList = new Map();

    for (let i = 0; i < entries.length; i++) {
      const sigI = signatures.get(i);
      const candidates = lsh.query(sigI);

      for (const jStr of candidates) {
        const j = Number(jStr);
        if (j <= i) continue;

        // Compute full Jaccard similarity
        const titleSim = _bigramJaccard(
          entries[i].title || '',
          entries[j].title || ''
        );

        if (titleSim >= similarityThreshold) {
          if (!adjList.has(i)) adjList.set(i, new Set());
          if (!adjList.has(j)) adjList.set(j, new Set());
          adjList.get(i).add(j);
          adjList.get(j).add(i);
        }
      }
    }

    // Step 3: Greedy clustering
    for (let i = 0; i < entries.length; i++) {
      if (visited.has(i)) continue;

      const neighbors = adjList.get(i);
      if (!neighbors || neighbors.size === 0) continue;

      const cluster = [i];
      visited.add(i);

      const queue = Array.from(neighbors);
      for (const j of queue) {
        if (visited.has(j)) continue;
        cluster.push(j);
        visited.add(j);

        const jNeighbors = adjList.get(j);
        if (jNeighbors) {
          for (const k of jNeighbors) {
            if (!visited.has(k)) queue.push(k);
          }
        }
      }

      if (cluster.length >= minClusterSize) {
        let summary;

        // Step 4: Optional LLM semantic summarization
        if (entries.length >= llmTriggerThreshold && this.cheapLlmCall) {
          try {
            summary = await this._llmPatternSummarize(
              cluster.map(idx => entries[idx]),
              dimension
            );
          } catch {
            summary = this._ruleBasedSummary(cluster.map(idx => entries[idx]));
          }
        } else {
          summary = this._ruleBasedSummary(cluster.map(idx => entries[idx]));
        }

        patterns.push({
          id: `pattern-${dimension}-${i}-${Date.now()}`,
          dimension,
          summary,
          signals: cluster.map(idx => entries[idx].id || `sig-${idx}`),
          confidence: cluster.length / entries.length,
          signalCount: cluster.length
        });
      }
    }

    // Detect conflicts: check for contradictory advice within the same dimension
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const conflict = this._detectSignalConflict(entries[i], entries[j]);
        if (conflict.isConflict) {
          conflicts.push({
            type: 'contradiction',
            between: [entries[i].id || i, entries[j].id || j],
            reason: conflict.reason
          });
        }
      }
    }

    return {
      patterns,
      conflicts,
      coverage: patterns.length > 0 ? 'full' : 'partial'
    };
  },

  /**
   * Helper: LLM-based pattern summarization
   * @private
   */
  async _llmPatternSummarize(signals, dimension) {
    if (!this.cheapLlmCall || signals.length < 2) {
      return this._ruleBasedSummary(signals);
    }

    const signalTexts = signals.map((s, i) =>
      `${i + 1}. ${s.title || s.content || JSON.stringify(s)}`.slice(0, 200)
    ).join('\n');

    const prompt = `Summarize the following ${signals.length} similar ${dimension} signals into a single pattern description. Be concise (under 100 chars).

Signals:
${signalTexts}

Pattern summary:`;

    const result = await this.cheapLlmCall(prompt);
    return (result || '').trim().slice(0, 100) || this._ruleBasedSummary(signals);
  },

  /**
   * Helper: Rule-based pattern summarization
   * @private
   */
  _ruleBasedSummary(signals) {
    if (signals.length === 0) return '';
    if (signals.length === 1) {
      return (signals[0].title || signals[0].content || 'single signal').slice(0, 100);
    }

    // Find common prefix across titles
    const titles = signals.map(s => s.title || s.content || '').filter(Boolean);
    if (titles.length === 0) return `Cluster of ${signals.length} signals`;

    let prefix = titles[0];
    for (let i = 1; i < titles.length; i++) {
      while (!titles[i].startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
        if (prefix === '') break;
      }
      if (prefix === '') break;
    }

    if (prefix.length >= 10) return prefix.slice(0, 100);

    // Fallback: keyword extraction from common words
    const wordFreq = new Map();
    for (const title of titles) {
      const words = title.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
      }
    }

    const commonWords = Array.from(wordFreq.entries())
      .filter(([, count]) => count >= signals.length * 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    if (commonWords.length > 0) {
      return `${commonWords.join(' ')} (${signals.length} signals)`.slice(0, 100);
    }

    return `Cluster of ${signals.length} similar signals`;
  },

  /**
   * Helper: Detect conflicts between two signals
   * @private
   */
  _detectSignalConflict(s1, s2) {
    const CONTRADICTION_PAIRS = [
      ['always', 'never'],
      ['must', 'must not'],
      ['should', 'should not'],
      ['enable', 'disable'],
      ['increase', 'decrease'],
      ['add', 'remove'],
      ['more', 'less']
    ];

    const c1 = (s1.content || s1.title || '').toLowerCase();
    const c2 = (s2.content || s2.title || '').toLowerCase();

    for (const [pos, neg] of CONTRADICTION_PAIRS) {
      if ((c1.includes(pos) && c2.includes(neg)) ||
          (c1.includes(neg) && c2.includes(pos))) {
        return {
          isConflict: true,
          reason: `Contradictory advice: "${pos}" vs "${neg}"`
        };
      }
    }

    return { isConflict: false, reason: '' };
  },

  /**
   * Automatically runs distillation if experience count exceeds capacity * threshold.
   * Called on load when the store has accumulated many entries.
   *
   * @param {object} [options]
   * @param {number} [options.triggerRatio=0.8] - Distill when count >= capacity * ratio
   */
  async autoDistill({ triggerRatio = 0.8 } = {}) {
    try {
      const { EXPERIENCE } = require('./constants');
      const capacity = EXPERIENCE.MAX_CAPACITY;
      if (this.experiences.length >= capacity * triggerRatio) {
        console.log(`[ExperienceStore] 🧪 Auto-distillation triggered: ${this.experiences.length} >= ${Math.floor(capacity * triggerRatio)} (${Math.round(triggerRatio * 100)}% of ${capacity})`);
        return await this.distill();
      }
    } catch (_) { /* constants not available */ }
    return { merged: 0, removed: 0, clusters: [] };
  },
};

// ─── LLM Semantic Merge ─────────────────────────────────────────────────────

/**
 * Uses a cheap LLM to semantically merge multiple experience records into one.
 * Produces a coherent, deduplicated synthesis that preserves the most valuable
 * insights from all members while eliminating redundancy.
 *
 * Cost: ~$0.003/call (GPT-4o-mini / Gemini Flash tier)
 * Quality: ~3x improvement over heuristic concatenation
 *
 * @param {Function} cheapLlmCall - async (prompt: string) => string
 * @param {object}   representative - The primary experience record
 * @param {object[]} others - Other experience records to merge into representative
 * @returns {Promise<string|null>} Merged content string, or null on failure
 * @private
 */
async function _llmSemanticMerge(cheapLlmCall, representative, others) {
  if (others.length === 0) return null;

  // Build a concise prompt with all experience content
  const allExperiences = [representative, ...others];
  const experienceBlocks = allExperiences.map((exp, i) => {
    const label = i === 0 ? '(PRIMARY)' : `(MEMBER ${i})`;
    const meta = [
      exp.sourceType ? `source: ${exp.sourceType}` : null,
      exp.hitCount ? `hitCount: ${exp.hitCount}` : null,
      exp.tags?.length ? `tags: [${exp.tags.join(', ')}]` : null,
    ].filter(Boolean).join(', ');
    // Truncate content to avoid token explosion
    const content = (exp.content || '').slice(0, 600);
    return `### ${label} "${exp.title}" (${meta})\n${content}`;
  }).join('\n\n');

  const prompt = `You are an expert knowledge engineer. Merge the following ${allExperiences.length} related experience records into ONE coherent, deduplicated knowledge entry.

Rules:
- Preserve ALL unique insights, solutions, and lessons learned
- Remove redundant/duplicate information
- Keep the most specific and actionable advice
- If experiences contradict each other, keep the one from the PRIMARY record or the most recent
- Output ONLY the merged content (no headers, no metadata, no explanation)
- Keep output under 800 characters
- Use concise, imperative voice

${experienceBlocks}

--- MERGED CONTENT ---`;

  const result = await cheapLlmCall(prompt);
  if (!result || result.trim().length < 20) return null;

  const merged = result.trim();
  console.log(`[ExperienceDistillation] 🤖 LLM semantic merge: ${allExperiences.length} experiences → ${merged.length} chars`);
  return `--- Distilled Knowledge (LLM-merged) ---\n${merged}`;
}

module.exports = {
  ExperienceDistillationMixin,
  computeSimilarity,
  computeSimilarityAsync,
  detectConflict,
  // P4b: LSH exports for fast similarity search
  MinHashLSH,
  computeMinHashSignature,
  computeSignatureSimilarity,
  // Exposed for testing
  _llmSemanticMerge,
};
