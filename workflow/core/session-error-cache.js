/**
 * SessionErrorCache – In-memory error pattern cache with LRU eviction
 * 
 * Provides fast error pattern matching within a session to avoid
 * redundant processing and ExperienceStore writes.
 * 
 * Inspired by self-evolving project's short-term memory pattern.
 * 
 * @module workflow/core/session-error-cache
 */

'use strict';

const { ExperienceType, ExperienceCategory } = require('./experience-types');

/**
 * ErrorPattern represents a cached error pattern
 * @typedef {Object} ErrorPattern
 * @property {string} patternId - Unique identifier
 * @property {string} signature - Normalized error signature (for matching)
 * @property {string} errorType - Type of error (e.g., 'TEST_FAILURE', 'LINT_ERROR')
 * @property {string} message - Original error message
 * @property {Object} context - Context when error occurred
 * @property {number} hitCount - How many times this pattern was matched
 * @property {string} lastHitAt - ISO timestamp of last hit
 * @property {string} createdAt - ISO timestamp of creation
 */

/**
 * SessionErrorCache provides session-level error caching with LRU eviction.
 * Reduces redundant error processing and ExperienceStore writes.
 */
class SessionErrorCache {
  /**
   * @param {Object} options
   * @param {number} [options.maxPatterns=100] - Maximum patterns to cache
   * @param {number} [options.maxSizeBytes=1048576] - Maximum memory usage (1MB default)
   */
  constructor(options = {}) {
    this.maxPatterns = options.maxPatterns || 100;
    this.maxSizeBytes = options.maxSizeBytes || 1024 * 1024; // 1MB
    
    /** @type {Map<string, ErrorPattern>} */
    this._patterns = new Map();
    
    /** @type {string[]} */
    this._lruOrder = []; // Most recently used at end
    
    /** @type {number} */
    this._totalHits = 0;
    
    /** @type {number} */
    this._totalMisses = 0;
  }

  /**
   * Check if an error pattern is already cached
   * @param {string} signature - Normalized error signature
   * @returns {boolean} True if pattern exists in cache
   */
  has(signature) {
    const pattern = this._patterns.get(signature);
    if (pattern) {
      // Update LRU order
      this._touch(signature);
      pattern.hitCount++;
      pattern.lastHitAt = new Date().toISOString();
      this._totalHits++;
      return true;
    }
    this._totalMisses++;
    return false;
  }

  /**
   * Add a new error pattern to the cache
   * @param {Object} params
   * @param {string} params.signature - Normalized error signature
   * @param {string} params.errorType - Type of error
   * @param {string} params.message - Error message
   * @param {Object} [params.context] - Additional context
   * @returns {boolean} True if added, false if cache is full
   */
  add(params) {
    const { signature, errorType, message, context = {} } = params;
    
    // Check if already exists
    if (this._patterns.has(signature)) {
      this._touch(signature);
      return true;
    }
    
    // Estimate size
    const estimatedSize = this._estimateSize(params);
    
    // Evict if necessary
    while (
      (this._patterns.size >= this.maxPatterns || this._getCurrentSize() + estimatedSize > this.maxSizeBytes)
      && this._lruOrder.length > 0
    ) {
      this._evictLRU();
    }
    
    // Check if still too large after eviction
    if (estimatedSize > this.maxSizeBytes * 0.5) {
      // Single pattern is too large, reject
      return false;
    }
    
    /** @type {ErrorPattern} */
    const pattern = {
      patternId: `ERR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      signature,
      errorType,
      message,
      context,
      hitCount: 0,
      lastHitAt: null,
      createdAt: new Date().toISOString(),
    };
    
    this._patterns.set(signature, pattern);
    this._lruOrder.push(signature);
    
    return true;
  }

  /**
   * Convert cached patterns to ExperienceStore batch format
   * @returns {Array} Array of experience objects for batchRecord
   */
  toBatchRecords() {
    const records = [];
    
    for (const pattern of this._patterns.values()) {
      // Only export patterns that were hit multiple times (worth persisting)
      if (pattern.hitCount < 2) continue;
      
      records.push({
        type: ExperienceType.NEGATIVE,
        category: ExperienceCategory.PITFALL,
        title: `[Session Pattern] ${pattern.errorType}: repeated ${pattern.hitCount} times`,
        content: this._generateContent(pattern),
        skill: 'error-handling',
        tags: ['session-cache', pattern.errorType, 'repeated-error'],
        ttlDays: 90,
      });
    }
    
    return records;
  }

  /**
   * Clear the cache (for session reset)
   */
  clear() {
    this._patterns.clear();
    this._lruOrder = [];
    this._totalHits = 0;
    this._totalMisses = 0;
  }

  /**
   * Get cache statistics
   * @returns {Object} Stats object
   */
  getStats() {
    const totalRequests = this._totalHits + this._totalMisses;
    const hitRate = totalRequests > 0 ? this._totalHits / totalRequests : 0;
    
    return {
      patternCount: this._patterns.size,
      maxPatterns: this.maxPatterns,
      sizeBytes: this._getCurrentSize(),
      maxSizeBytes: this.maxSizeBytes,
      hitRate,
      totalHits: this._totalHits,
      totalMisses: this._totalMisses,
    };
  }

  /**
   * Update LRU order (move to end = most recently used)
   * @private
   */
  _touch(signature) {
    const index = this._lruOrder.indexOf(signature);
    if (index !== -1) {
      this._lruOrder.splice(index, 1);
      this._lruOrder.push(signature);
    }
  }

  /**
   * Evict least recently used pattern
   * @private
   */
  _evictLRU() {
    if (this._lruOrder.length === 0) return;
    
    const oldestSignature = this._lruOrder.shift();
    if (oldestSignature) {
      this._patterns.delete(oldestSignature);
    }
  }

  /**
   * Estimate size of a pattern in bytes
   * @private
   */
  _estimateSize(params) {
    // Rough estimation: 2 bytes per character (UTF-16)
    const messageSize = (params.message || '').length * 2;
    const contextSize = JSON.stringify(params.context || {}).length * 2;
    return 200 + messageSize + contextSize; // Base overhead + variable parts
  }

  /**
   * Get current cache size in bytes
   * @private
   */
  _getCurrentSize() {
    let total = 0;
    for (const pattern of this._patterns.values()) {
      total += this._estimateSize({
        message: pattern.message,
        context: pattern.context,
      });
    }
    return total;
  }

  /**
   * Generate content for experience
   * @private
   */
  _generateContent(pattern) {
    const lines = [
      `**Error Type**: ${pattern.errorType}`,
      `**Occurrences**: ${pattern.hitCount + 1} times this session`,
      `**First Seen**: ${pattern.createdAt}`,
      `**Last Seen**: ${pattern.lastHitAt || pattern.createdAt}`,
      `**Message**: ${pattern.message}`,
    ];
    
    if (Object.keys(pattern.context).length > 0) {
      lines.push(`**Context**: ${JSON.stringify(pattern.context)}`);
    }
    
    return lines.join('\n');
  }
}

module.exports = { SessionErrorCache };
