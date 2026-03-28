/**
 * Model Fallback Manager – P3 Optimization
 *
 * Automatic model downgrade on errors to improve reliability.
 * Tracks model health status and provides fallback chain for retries.
 *
 * P3 Enhancement: Error-triggered model fallback complements RunGuard's
 * budget-triggered tier downgrade for comprehensive model management.
 *
 * Design:
 *   - Health tracking: success rate per model over sliding window
 *   - Fallback chain: strong → default → fast → emergency
 *   - Automatic recovery: health check resets after cooldown
 *   - Zero LLM overhead: pure algorithmic decision
 *
 * @module model-fallback-manager
 * @version P3-1
 */

'use strict';

// ─── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  // Health tracking window
  healthWindowSize: 10,         // Number of calls to track per model
  degradedThreshold: 0.3,       // Success rate below this = degraded
  unhealthyThreshold: 0.1,      // Success rate below this = unhealthy

  // Recovery settings
  cooldownPeriodMs: 60000,      // 1 minute before retrying degraded model
  recoveryCheckIntervalMs: 30000, // 30 seconds health check interval

  // Fallback chain (if current tier fails, try next)
  fallbackChain: {
    strong: 'default',
    default: 'fast',
    fast: 'emergency',
    emergency: null,            // Final fallback (no more options)
  },

  // Errors that trigger immediate fallback (not retry)
  immediateFallbackErrors: [
    'rate_limit_exceeded',
    'context_length_exceeded',
    'model_not_found',
    'invalid_api_key',
  ],

  // Errors that allow retry with backoff before fallback
  retryableBeforeFallback: [
    'overloaded',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
  ],
};

// ─── Model Health State ────────────────────────────────────────────────────────

class ModelHealth {
  constructor(config = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };

    // modelId -> { calls: [], lastFailure: number, status: string }
    this._healthRecords = new Map();

    // Start recovery checker
    this._startRecoveryChecker();
  }

  /**
   * Record a successful model call.
   * @param {string} modelId - Model identifier (e.g., 'gpt-4', 'claude-3-opus')
   */
  recordSuccess(modelId) {
    this._ensureRecord(modelId);
    const record = this._healthRecords.get(modelId);

    record.calls.push({ success: true, timestamp: Date.now() });
    this._trimWindow(record);

    // Update status based on new health rate
    this._updateStatus(modelId);
  }

  /**
   * Record a failed model call.
   * @param {string} modelId - Model identifier
   * @param {Error} error - The error that occurred
   * @returns {string} Failure category ('immediate' | 'retryable' | 'unknown')
   */
  recordFailure(modelId, error) {
    this._ensureRecord(modelId);
    const record = this._healthRecords.get(modelId);

    record.calls.push({ success: false, timestamp: Date.now(), error: error.message });
    record.lastFailure = Date.now();
    this._trimWindow(record);

    // Categorize error
    const category = this._categorizeError(error);

    // Update status
    this._updateStatus(modelId);

    return category;
  }

  /**
   * Get current health status for a model.
   * @param {string} modelId
   * @returns {object} { status: 'healthy'|'degraded'|'unhealthy', successRate: number, callsAnalyzed: number }
   */
  getHealth(modelId) {
    if (!this._healthRecords.has(modelId)) {
      return { status: 'healthy', successRate: 1.0, callsAnalyzed: 0 };
    }

    const record = this._healthRecords.get(modelId);
    const successRate = this._calculateSuccessRate(record);
    const callsAnalyzed = record.calls.length;

    return {
      status: record.status,
      successRate,
      callsAnalyzed,
      lastFailure: record.lastFailure,
    };
  }

  /**
   * Check if model is available for use.
   * @param {string} modelId
   * @returns {boolean}
   */
  isAvailable(modelId) {
    const health = this.getHealth(modelId);

    // Degraded models can still be used (with caution)
    // Unhealthy models are temporarily blocked
    if (health.status === 'unhealthy') {
      // Check if cooldown period has passed
      const record = this._healthRecords.get(modelId);
      if (record && record.lastFailure) {
        const elapsed = Date.now() - record.lastFailure;
        if (elapsed < this._config.cooldownPeriodMs) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Get next fallback tier for a given tier.
   * @param {string} currentTier - Current tier (strong/default/fast/emergency)
   * @returns {string|null} Next fallback tier or null if at end
   */
  getFallbackTier(currentTier) {
    return this._config.fallbackChain[currentTier] || null;
  }

  /**
   * Determine if error should trigger immediate fallback.
   * @param {Error} error
   * @returns {boolean}
   */
  shouldFallbackImmediately(error) {
    if (!error) return false;

    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();

    return this._config.immediateFallbackErrors.some(e =>
      message.includes(e.toLowerCase()) || code === e.toLowerCase()
    );
  }

  /**
   * Determine if error is retryable before fallback.
   * @param {Error} error
   * @returns {boolean}
   */
  isRetryableBeforeFallback(error) {
    if (!error) return false;

    const message = (error.message || '').toLowerCase();
    const code = (error.code || '').toLowerCase();

    return this._config.retryableBeforeFallback.some(e =>
      message.includes(e.toLowerCase()) || code === e.toLowerCase()
    );
  }

  /**
   * Get fallback decision with full context.
   * @param {string} modelId
   * @param {string} currentTier
   * @param {Error} error
   * @returns {object} Decision with action and next tier
   */
  getFallbackDecision(modelId, currentTier, error) {
    const health = this.getHealth(modelId);
    const errorCategory = this._categorizeError(error);

    // Decision logic
    if (errorCategory === 'immediate') {
      const fallbackTier = this.getFallbackTier(currentTier);
      return {
        action: 'fallback',
        reason: `immediate_fallback_error: ${error.message}`,
        currentTier,
        nextTier: fallbackTier,
        retryAllowed: false,
        health,
      };
    }

    if (health.status === 'unhealthy') {
      const fallbackTier = this.getFallbackTier(currentTier);
      return {
        action: 'fallback',
        reason: 'model_unhealthy',
        currentTier,
        nextTier: fallbackTier,
        retryAllowed: false,
        health,
      };
    }

    if (errorCategory === 'retryable') {
      return {
        action: 'retry',
        reason: 'retryable_error',
        currentTier,
        nextTier: currentTier,
        retryAllowed: true,
        maxRetries: 2,
        health,
      };
    }

    // Unknown error - allow one retry then fallback
    return {
      action: 'retry_then_fallback',
      reason: 'unknown_error',
      currentTier,
      nextTier: currentTier,
      fallbackTier: this.getFallbackTier(currentTier),
      retryAllowed: true,
      maxRetries: 1,
      health,
    };
  }

  /**
   * Reset health for a model (after manual intervention).
   * @param {string} modelId
   */
  resetHealth(modelId) {
    this._healthRecords.delete(modelId);
  }

  /**
   * Get health report for all tracked models.
   * @returns {object}
   */
  getHealthReport() {
    const report = {
      timestamp: new Date().toISOString(),
      models: {},
      summary: { healthy: 0, degraded: 0, unhealthy: 0, total: 0 },
    };

    for (const [modelId, record] of this._healthRecords) {
      const health = this.getHealth(modelId);
      report.models[modelId] = health;
      report.summary[health.status]++;
      report.summary.total++;
    }

    return report;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  _ensureRecord(modelId) {
    if (!this._healthRecords.has(modelId)) {
      this._healthRecords.set(modelId, {
        calls: [],
        lastFailure: null,
        status: 'healthy',
      });
    }
  }

  _trimWindow(record) {
    if (record.calls.length > this._config.healthWindowSize) {
      record.calls = record.calls.slice(-this._config.healthWindowSize);
    }
  }

  _calculateSuccessRate(record) {
    if (record.calls.length === 0) return 1.0;

    const successes = record.calls.filter(c => c.success).length;
    return successes / record.calls.length;
  }

  _updateStatus(modelId) {
    const record = this._healthRecords.get(modelId);
    const successRate = this._calculateSuccessRate(record);

    if (successRate < this._config.unhealthyThreshold) {
      record.status = 'unhealthy';
    } else if (successRate < this._config.degradedThreshold) {
      record.status = 'degraded';
    } else {
      record.status = 'healthy';
    }
  }

  _categorizeError(error) {
    if (this.shouldFallbackImmediately(error)) return 'immediate';
    if (this.isRetryableBeforeFallback(error)) return 'retryable';
    return 'unknown';
  }

  _startRecoveryChecker() {
    setInterval(() => {
      for (const [modelId, record] of this._healthRecords) {
        if (record.status === 'unhealthy' && record.lastFailure) {
          const elapsed = Date.now() - record.lastFailure;
          if (elapsed >= this._config.cooldownPeriodMs) {
            // Auto-recover to degraded (allow trial use)
            record.status = 'degraded';
            console.log(`[ModelHealth] 🔄 ${modelId} auto-recovered to degraded status after cooldown`);
          }
        }
      }
    }, this._config.recoveryCheckIntervalMs);
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

let _globalHealth = null;

function getGlobalHealth(config) {
  if (!_globalHealth) {
    _globalHealth = new ModelHealth(config);
  }
  return _globalHealth;
}

// ─── Integration Helper ───────────────────────────────────────────────────────

/**
 * Wraps an LLM call with fallback logic.
 * Usage:
 *   const result = await callWithFallback(
 *     () => llmRouter.call(role, prompt),
 *     { role, tier, modelId }
 *   );
 *
 * @param {Function} llmCall - Async function that performs LLM call
 * @param {object} context - Call context { role, tier, modelId }
 * @returns {Promise<object>} Result with metadata
 */
async function callWithFallback(llmCall, context) {
  const { role, tier, modelId } = context;
  const health = getGlobalHealth();

  // Check if model is available
  if (!health.isAvailable(modelId)) {
    const fallbackTier = health.getFallbackTier(tier);
    if (fallbackTier) {
      console.log(`[ModelFallback] ⚠️ ${modelId} unavailable, auto-fallback to ${fallbackTier}`);

      return {
        success: false,
        fallbackTriggered: true,
        originalTier: tier,
        fallbackTier,
        reason: 'model_unavailable',
        // Caller should retry with fallbackTier
      };
    }
  }

  try {
    const result = await llmCall();
    health.recordSuccess(modelId);

    return {
      success: true,
      result,
      usedTier: tier,
      modelId,
    };
  } catch (error) {
    const category = health.recordFailure(modelId, error);
    const decision = health.getFallbackDecision(modelId, tier, error);

    console.log(`[ModelFallback] ⚠️ ${modelId} failed (${category}): ${error.message}`);
    console.log(`[ModelFallback] 📊 Decision: ${decision.action} → ${decision.nextTier || 'none'}`);

    return {
      success: false,
      error,
      fallbackTriggered: decision.action === 'fallback',
      retryAllowed: decision.retryAllowed,
      maxRetries: decision.maxRetries,
      originalTier: tier,
      fallbackTier: decision.nextTier,
      decision,
    };
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  ModelHealth,
  getGlobalHealth,
  callWithFallback,
  DEFAULT_CONFIG,
};
