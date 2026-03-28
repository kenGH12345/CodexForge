/**
 * EmbeddingService – Lightweight local embedding for semantic matching
 *
 * Provides cosine-similarity-based semantic search using a local ONNX model
 * via @huggingface/transformers.js. Zero LLM token cost, ~50ms per inference.
 *
 * Design decisions:
 *   - Supplementary layer: keyword matching remains the primary (fast) path;
 *     embedding is used only when keyword results are insufficient.
 *   - Lazy initialisation: model is loaded on first use (or via explicit init()).
 *   - In-memory cache: embeddings are cached per text to avoid redundant inference.
 *   - Graceful degradation: if the model fails to load (e.g. missing dependency),
 *     all methods return empty results instead of throwing.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (quantized, ~6MB ONNX)
 *   - 384-dimensional embeddings
 *   - Normalised output → dot product = cosine similarity
 *   - First load: ~2s (model download + ONNX init)
 *   - Subsequent inference: ~50ms per sentence
 *
 * @module workflow/core/embedding-service
 */

'use strict';

// ─── EmbeddingService ─────────────────────────────────────────────────────────

class EmbeddingService {
  /**
   * @param {object} [options]
   * @param {string} [options.modelId]    - HuggingFace model ID (default: Xenova/all-MiniLM-L6-v2)
   * @param {string} [options.cacheDir]   - Directory to cache the downloaded model
   * @param {number} [options.maxCacheSize] - Max number of cached embeddings (default: 500)
   * @param {boolean} [options.quantized] - Use quantized model for smaller size (default: true)
   */
  constructor(options = {}) {
    this._modelId = options.modelId || 'Xenova/all-MiniLM-L6-v2';
    this._cacheDir = options.cacheDir || null;
    this._maxCacheSize = options.maxCacheSize || 500;
    this._quantized = options.quantized !== false;

    /** @type {Map<string, Float32Array>} text → embedding vector cache */
    this._cache = new Map();
    /** @type {boolean} Whether the model has been successfully loaded */
    this._ready = false;
    /** @type {boolean} Whether init has been attempted (prevents repeated failures) */
    this._initAttempted = false;
    /** @type {Function|null} The pipeline extractor function */
    this._extractor = null;
    /** @type {string|null} Error message if init failed */
    this._initError = null;
  }

  // ─── Initialisation ─────────────────────────────────────────────────────────

  /**
   * Loads the embedding model. Safe to call multiple times (idempotent).
   * If the model fails to load, sets _ready=false and logs a warning.
   *
   * @returns {Promise<boolean>} true if model loaded successfully
   */
  async init() {
    if (this._ready) return true;
    if (this._initAttempted) return false; // Don't retry after failure
    this._initAttempted = true;

    try {
      // Dynamic import: @huggingface/transformers is an ESM-only package.
      // We use dynamic import() to load it from a CommonJS context.
      // If the package is not installed, this will throw and we degrade gracefully.
      let pipeline;
      try {
        const mod = await import('@huggingface/transformers');
        pipeline = mod.pipeline || mod.default?.pipeline;
      } catch (importErr) {
        // Fallback: try the older @xenova/transformers package name
        try {
          const mod = await import('@xenova/transformers');
          pipeline = mod.pipeline || mod.default?.pipeline;
        } catch (_) {
          throw new Error(
            `Neither @huggingface/transformers nor @xenova/transformers is installed. ` +
            `Run: npm install @huggingface/transformers`
          );
        }
      }

      if (!pipeline) {
        throw new Error('Could not find pipeline function in transformers module');
      }

      const pipelineOpts = { quantized: this._quantized };
      if (this._cacheDir) {
        pipelineOpts.cache_dir = this._cacheDir;
      }

      this._extractor = await pipeline('feature-extraction', this._modelId, pipelineOpts);
      this._ready = true;
      console.log(`[EmbeddingService] ✅ Model loaded (${this._modelId}, quantized=${this._quantized})`);
      return true;
    } catch (err) {
      this._initError = err.message;
      console.warn(`[EmbeddingService] ⚠️  Model load failed (non-fatal): ${err.message}`);
      console.warn(`[EmbeddingService]    Semantic matching disabled. Keyword matching will be used as fallback.`);
      return false;
    }
  }

  /**
   * Returns true if the model is loaded and ready for inference.
   * @returns {boolean}
   */
  isReady() {
    return this._ready;
  }

  /**
   * Returns the init error message, if any.
   * @returns {string|null}
   */
  getInitError() {
    return this._initError;
  }

  // ─── Embedding ──────────────────────────────────────────────────────────────

  /**
   * Computes the embedding vector for a text string.
   * Returns cached result if available.
   *
   * @param {string} text - Input text to embed
   * @returns {Promise<Float32Array|null>} 384-dimensional normalised vector, or null if not ready
   */
  async embed(text) {
    if (!this._ready || !text) return null;

    // Check cache
    const cacheKey = text.trim().toLowerCase();
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    try {
      const output = await this._extractor(text, { pooling: 'mean', normalize: true });
      // output.data is a Float32Array of shape [384]
      const vector = output.data instanceof Float32Array
        ? output.data
        : new Float32Array(output.data);

      // Evict oldest entry if cache is full
      if (this._cache.size >= this._maxCacheSize) {
        const firstKey = this._cache.keys().next().value;
        this._cache.delete(firstKey);
      }

      this._cache.set(cacheKey, vector);
      return vector;
    } catch (err) {
      console.warn(`[EmbeddingService] ⚠️  Embedding failed for "${text.slice(0, 50)}...": ${err.message}`);
      return null;
    }
  }

  // ─── Similarity ─────────────────────────────────────────────────────────────

  /**
   * Computes cosine similarity between two embedding vectors.
   * Since vectors are L2-normalised, dot product = cosine similarity.
   *
   * @param {Float32Array} a - First vector
   * @param {Float32Array} b - Second vector
   * @returns {number} Cosine similarity in [-1, 1] (typically [0, 1] for text)
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /**
   * Finds the most similar candidates to a query text.
   *
   * @param {string} query - Query text
   * @param {{ name: string, text: string }[]} candidates - Array of named candidates
   * @param {number} [topK=3] - Number of top results to return
   * @param {number} [minScore=0.3] - Minimum similarity score to include
   * @returns {Promise<{ name: string, score: number }[]>} Sorted by score descending
   */
  async findMostSimilar(query, candidates, topK = 3, minScore = 0.3) {
    if (!this._ready || !query || !candidates || candidates.length === 0) {
      return [];
    }

    const queryVec = await this.embed(query);
    if (!queryVec) return [];

    const scored = [];
    for (const { name, text } of candidates) {
      const candidateVec = await this.embed(text);
      if (!candidateVec) continue;
      const score = this.cosineSimilarity(queryVec, candidateVec);
      if (score >= minScore) {
        scored.push({ name, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // ─── Batch Operations ───────────────────────────────────────────────────────

  /**
   * Pre-computes and caches embeddings for a batch of texts.
   * Useful for preheating the cache at startup.
   *
   * @param {{ name: string, text: string }[]} items - Items to pre-embed
   * @returns {Promise<number>} Number of items successfully embedded
   */
  async preheat(items) {
    if (!this._ready || !items) return 0;

    let count = 0;
    for (const { text } of items) {
      const result = await this.embed(text);
      if (result) count++;
    }

    console.log(`[EmbeddingService] 🔥 Pre-heated ${count}/${items.length} embeddings (cache size: ${this._cache.size})`);
    return count;
  }

  // ─── Cache Management ───────────────────────────────────────────────────────

  /**
   * Returns cache statistics.
   * @returns {{ size: number, maxSize: number, ready: boolean, model: string }}
   */
  getCacheStats() {
    return {
      size: this._cache.size,
      maxSize: this._maxCacheSize,
      ready: this._ready,
      model: this._modelId,
      initError: this._initError,
    };
  }

  /**
   * Clears the embedding cache.
   */
  clearCache() {
    this._cache.clear();
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = { EmbeddingService };
