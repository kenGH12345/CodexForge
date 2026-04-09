/**
 * SkillRanker – BM25 + Embedding hybrid skill ranking engine
 *
 * Replaces the pure keyword-count matching in ContextLoader with a proper
 * information retrieval approach inspired by OpenSpace's SkillRegistry.
 *
 * Architecture:
 *   Layer 1: BM25 (synchronous, <1ms, zero dependencies)
 *     - Builds an inverted index from skill metadata (name, description, keywords, content)
 *     - Scores each skill against the query using BM25 (Okapi BM25)
 *     - Pre-filters candidates for Layer 2
 *
 *   Layer 2: Embedding reranking (async, ~50ms, uses EmbeddingService)
 *     - Only activated when EmbeddingService is ready
 *     - Reranks BM25 top-K candidates using cosine similarity
 *     - Final score = α * BM25_norm + (1-α) * embedding_score
 *
 * Design decisions:
 *   - BM25 is implemented inline (~60 lines) to avoid npm dependency
 *   - IDF is computed lazily and cached per corpus rebuild
 *   - Tokenisation uses simple whitespace + punctuation split (sufficient for skill names/keywords)
 *   - The ranker is stateless per query; corpus is rebuilt when skills change
 *   - Graceful degradation: if EmbeddingService is unavailable, BM25-only results are returned
 *
 * BM25 parameters:
 *   k1 = 1.5 (term frequency saturation — higher = more weight on repeated terms)
 *   b  = 0.75 (document length normalisation — 0 = no normalisation, 1 = full)
 *
 * @module workflow/core/skill-ranker
 */

'use strict';

// ─── BM25 Constants ───────────────────────────────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

// ─── Tokeniser ────────────────────────────────────────────────────────────────

/**
 * Tokenises text into lowercase word tokens.
 * Strips punctuation, splits on whitespace, filters short tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

// ─── SkillRanker ──────────────────────────────────────────────────────────────

class SkillRanker {
  /**
   * @param {object} [options]
   * @param {import('./embedding-service').EmbeddingService|null} [options.embeddingService]
   * @param {number} [options.alpha=0.6] - Weight for BM25 in hybrid score (0-1). Higher = more BM25 influence.
   * @param {number} [options.minScore=0.1] - Minimum BM25 score to be considered a candidate
   * @param {number} [options.topK=5] - Number of BM25 candidates to pass to embedding reranking
   */
  constructor(options = {}) {
    /** @type {import('./embedding-service').EmbeddingService|null} */
    this._embeddingService = options.embeddingService || null;
    this._alpha = options.alpha ?? 0.6;
    this._minScore = options.minScore ?? 0.1;
    this._topK = options.topK ?? 5;

    // ── BM25 Corpus ───────────────────────────────────────────────────────
    /** @type {Map<string, { tokens: string[], length: number, text: string }>} skillName → document */
    this._corpus = new Map();
    /** @type {Map<string, number>} term → document frequency (number of docs containing term) */
    this._df = new Map();
    /** @type {number} Average document length across corpus */
    this._avgdl = 0;
    /** @type {number} Total number of documents */
    this._N = 0;
    /** @type {boolean} Whether the corpus needs rebuilding */
    this._dirty = true;
  }

  // ─── Corpus Management ──────────────────────────────────────────────────────

  /**
   * Rebuilds the BM25 corpus from skill metadata.
   * Call this when skills are added, removed, or modified.
   *
   * Each skill's "document" is built from:
   *   - Skill name (hyphen-separated → space-separated)
   *   - Description (from registry)
   *   - Keywords (from BUILTIN_SKILL_KEYWORDS or triggers)
   *   - First paragraph of skill file content (if available)
   *
   * @param {{ name: string, description?: string, keywords?: string[], contentSnippet?: string }[]} skills
   */
  buildCorpus(skills) {
    this._corpus.clear();
    this._df.clear();

    for (const skill of skills) {
      // Build document text from all available metadata
      const parts = [
        skill.name.replace(/-/g, ' '),
        skill.description || '',
        (skill.keywords || []).join(' '),
        skill.contentSnippet || '',
      ];
      const text = parts.join(' ');
      const tokens = tokenize(text);

      this._corpus.set(skill.name, {
        tokens,
        length: tokens.length,
        text,
      });

      // Update document frequency
      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this._df.set(term, (this._df.get(term) || 0) + 1);
      }
    }

    this._N = this._corpus.size;
    this._avgdl = this._N > 0
      ? Array.from(this._corpus.values()).reduce((sum, d) => sum + d.length, 0) / this._N
      : 0;
    this._dirty = false;
  }

  /**
   * Marks the corpus as dirty (needs rebuild before next query).
   */
  invalidate() {
    this._dirty = true;
  }

  /**
   * Returns true if the corpus has been built and is not dirty.
   * @returns {boolean}
   */
  isReady() {
    return !this._dirty && this._N > 0;
  }

  // ─── BM25 Scoring ──────────────────────────────────────────────────────────

  /**
   * Computes the IDF (Inverse Document Frequency) for a term.
   * Uses the standard BM25 IDF formula: log((N - df + 0.5) / (df + 0.5) + 1)
   *
   * @param {string} term
   * @returns {number}
   */
  _idf(term) {
    const df = this._df.get(term) || 0;
    return Math.log((this._N - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * Computes the BM25 score for a single document against a query.
   *
   * @param {string[]} queryTokens - Tokenised query
   * @param {{ tokens: string[], length: number }} doc - Document from corpus
   * @returns {number} BM25 score (higher = more relevant)
   */
  _scoreBM25(queryTokens, doc) {
    // Build term frequency map for this document
    const tf = new Map();
    for (const token of doc.tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }

    let score = 0;
    for (const qt of queryTokens) {
      const termFreq = tf.get(qt) || 0;
      if (termFreq === 0) continue;

      const idf = this._idf(qt);
      const numerator = termFreq * (BM25_K1 + 1);
      const denominator = termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / this._avgdl));
      score += idf * (numerator / denominator);
    }

    return score;
  }

  /**
   * Ranks all skills in the corpus against a query using BM25.
   * Returns skills sorted by score descending, filtered by minScore.
   *
   * @param {string} query - Raw query text
   * @returns {{ name: string, score: number }[]}
   */
  rankBM25(query) {
    if (this._dirty || this._N === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const results = [];
    for (const [name, doc] of this._corpus) {
      const score = this._scoreBM25(queryTokens, doc);
      if (score >= this._minScore) {
        results.push({ name, score });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // ─── Hybrid Ranking (BM25 + Embedding) ─────────────────────────────────────

  /**
   * Ranks skills using BM25 + Embedding hybrid scoring.
   *
   * Flow:
   *   1. BM25 scores all skills → top-K candidates
   *   2. If EmbeddingService is ready, rerank top-K using cosine similarity
   *   3. Final score = α * BM25_norm + (1-α) * embedding_score
   *   4. If EmbeddingService is not ready, return BM25-only results
   *
   * @param {string} query - Raw query text
   * @param {object} [options]
   * @param {number}   [options.maxResults=3] - Maximum number of results to return
   * @param {Set<string>} [options.excludeSkills] - Skills to exclude from results
   * @returns {Promise<{ name: string, score: number, bm25Score: number, embeddingScore: number }[]>}
   */
  async rank(query, options = {}) {
    const maxResults = options.maxResults ?? 3;
    const excludeSkills = options.excludeSkills || new Set();

    // Step 1: BM25 ranking
    const bm25Results = this.rankBM25(query)
      .filter(r => !excludeSkills.has(r.name));

    if (bm25Results.length === 0) return [];

    // Normalise BM25 scores to [0, 1]
    const maxBM25 = bm25Results[0].score;
    const bm25Normalised = bm25Results.map(r => ({
      ...r,
      bm25Norm: maxBM25 > 0 ? r.score / maxBM25 : 0,
    }));

    // Step 2: Embedding reranking (if available)
    const topCandidates = bm25Normalised.slice(0, this._topK);

    if (this._embeddingService && this._embeddingService.isReady()) {
      try {
        // Build candidate texts for embedding comparison
        const candidates = topCandidates.map(c => ({
          name: c.name,
          text: this._corpus.get(c.name)?.text || c.name,
        }));

        const embeddingResults = await this._embeddingService.findMostSimilar(
          query,
          candidates,
          this._topK,
          0.0, // No minimum — we'll use the hybrid score for filtering
        );

        // Build embedding score map
        const embeddingMap = new Map(embeddingResults.map(r => [r.name, r.score]));

        // Step 3: Compute hybrid scores
        const hybrid = topCandidates.map(c => {
          const embScore = embeddingMap.get(c.name) || 0;
          const hybridScore = this._alpha * c.bm25Norm + (1 - this._alpha) * embScore;
          return {
            name: c.name,
            score: hybridScore,
            bm25Score: c.score,
            embeddingScore: embScore,
          };
        });

        // Sort by hybrid score and return top results
        const sorted = hybrid.sort((a, b) => b.score - a.score).slice(0, maxResults);

        if (sorted.length > 0) {
          console.log(
            `[SkillRanker] 🎯 Hybrid ranking (BM25+Embedding): ` +
            sorted.map(r => `${r.name}(${r.score.toFixed(2)})`).join(', ')
          );
        }

        return sorted;
      } catch (err) {
        console.warn(`[SkillRanker] ⚠️ Embedding reranking failed (falling back to BM25): ${err.message}`);
        // Fall through to BM25-only results
      }
    }

    // BM25-only results (no embedding available)
    const bm25Only = topCandidates.slice(0, maxResults).map(c => ({
      name: c.name,
      score: c.bm25Norm,
      bm25Score: c.score,
      embeddingScore: 0,
    }));

    if (bm25Only.length > 0) {
      console.log(
        `[SkillRanker] 📊 BM25-only ranking: ` +
        bm25Only.map(r => `${r.name}(${r.bm25Score.toFixed(2)})`).join(', ')
      );
    }

    return bm25Only;
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  /**
   * Returns corpus statistics for observability.
   * @returns {{ corpusSize: number, avgDocLength: number, vocabularySize: number, dirty: boolean }}
   */
  getStats() {
    return {
      corpusSize: this._N,
      avgDocLength: Math.round(this._avgdl * 10) / 10,
      vocabularySize: this._df.size,
      dirty: this._dirty,
      embeddingReady: this._embeddingService ? this._embeddingService.isReady() : false,
      alpha: this._alpha,
    };
  }

  /**
   * Updates the embedding service reference (e.g. after lazy init).
   * @param {import('./embedding-service').EmbeddingService|null} embeddingService
   */
  setEmbeddingService(embeddingService) {
    this._embeddingService = embeddingService;
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = { SkillRanker, tokenize };
