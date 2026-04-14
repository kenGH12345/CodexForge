/**
 * EvolutionLoopIntentMixin – Extends EvolutionLoop with intent tracking and session caching
 * 
 * This mixin adds:
 * 1. Intent tracking (before/after execution comparison)
 * 2. Session-level error caching (LRU eviction)
 * 3. Batch flush to ExperienceStore on session end
 * 
 * @module workflow/core/evolution-loop-intent-mixin
 */

'use strict';

const { IntentTracker } = require('./intent-tracker');
const { SessionErrorCache } = require('./session-error-cache');

/**
 * EvolutionLoopIntentMixin factory
 * @returns {Object} Mixin methods to be applied to EvolutionLoop
 */
function EvolutionLoopIntentMixin() {
  return {
    /**
     * Initialize intent tracking capabilities
     * Call this in EvolutionLoop constructor or before first use
     * @param {Object} options
     * @param {number} [options.maxIntents=50] - Maximum intents to track
     * @param {number} [options.maxErrorPatterns=100] - Maximum error patterns to cache
     * @param {number} [options.minConfidenceForAnalysis=0.7] - Minimum confidence for gap analysis
     */
    _initIntentTracking(options = {}) {
      if (this._intentTracker) {
        this._log('[EvolutionLoopIntentMixin] Intent tracking already initialized');
        return;
      }
      
      this._intentTracker = new IntentTracker({
        maxIntents: options.maxIntents || 50,
        minConfidenceForAnalysis: options.minConfidenceForAnalysis || 0.7,
      });
      
      this._sessionErrorCache = new SessionErrorCache({
        maxPatterns: options.maxErrorPatterns || 100,
      });
      
      this._log('[EvolutionLoopIntentMixin] ✅ Intent tracking initialized');
    },

    /**
     * Process signal with intent tracking
     * Wraps the original processSignal with before/after intent tracking
     * @param {Object} signal - Original signal object
     * @param {Object} intentParams - Intent parameters (optional)
     * @param {string} [intentParams.intent] - What the agent intended
     * @param {string} [intentParams.expectedOutcome] - Expected result
     * @param {number} [intentParams.confidence] - Confidence level
     * @returns {Object} Result from original processSignal plus intent info
     */
    processSignalWithIntent(signal, intentParams = null) {
      // Ensure initialized
      if (!this._intentTracker) {
        this._initIntentTracking();
      }
      
      let intentId = null;
      
      // Track intent if provided
      if (intentParams && intentParams.intent && intentParams.expectedOutcome) {
        intentId = this._intentTracker.trackIntent({
          decisionType: signal.type || 'UNKNOWN',
          intent: intentParams.intent,
          expectedOutcome: intentParams.expectedOutcome,
          confidence: intentParams.confidence || 0.5,
          context: signal.context || {},
        });
        
        this._log(`[EvolutionLoopIntentMixin] 📍 Intent tracked: ${intentId}`);
      }
      
      // Check session cache for duplicate errors
      const errorSignature = this._normalizeErrorPattern(signal);
      if (errorSignature && this._sessionErrorCache.has(errorSignature)) {
        this._log(`[EvolutionLoopIntentMixin] ⏭️ Skipping duplicate error: ${errorSignature.slice(0, 50)}...`);
        
        return {
          logged: false,
          evolutionTriggered: false,
          action: null,
          skipped: true,
          reason: 'duplicate-error-in-session',
          intentId,
        };
      }
      
      // Call original processSignal
      const result = this.processSignal(signal);
      
      // Add to session cache if it's an error signal
      if (errorSignature && signal.severity !== 'LOW') {
        this._sessionErrorCache.add({
          signature: errorSignature,
          errorType: signal.type || 'UNKNOWN',
          message: signal.evidence || '',
          context: signal.context || {},
        });
      }
      
      // Compare outcome with intent
      if (intentId) {
        const actualOutcome = result.evolutionTriggered
          ? `Evolution triggered: ${result.action}`
          : 'Signal logged, no evolution';
        
        const gapReport = this._intentTracker.compareOutcome(
          intentId,
          actualOutcome,
          !result.evolutionTriggered // Success = no evolution needed
        );
        
        if (gapReport && gapReport.gapType !== 'none') {
          this._log(`[EvolutionLoopIntentMixin] ⚠️ Gap detected: ${gapReport.gapType} (severity: ${gapReport.severity.toFixed(2)})`);
        }
      }
      
      return {
        ...result,
        intentId,
        skipped: false,
      };
    },

    /**
     * Flush session cache and intent tracker to ExperienceStore
     * Call this at workflow FINISHED stage
     * @param {Object} store - ExperienceStore instance
     * @returns {Object} Combined flush results
     */
    flushSessionCache(store) {
      if (!this._intentTracker || !this._sessionErrorCache) {
        this._log('[EvolutionLoopIntentMixin] No session data to flush');
        return { intentFlush: { added: 0, skipped: 0 }, errorFlush: [] };
      }
      
      // Flush intent tracker
      const intentFlush = this._intentTracker.flushToExperienceStore(store);
      
      // Flush session error cache
      const errorFlush = this._sessionErrorCache.toBatchRecords();
      if (errorFlush.length > 0) {
        store.batchRecord(errorFlush);
      }
      
      this._log(`[EvolutionLoopIntentMixin] 🔄 Flushed: ${intentFlush.added} intents, ${errorFlush.length} error patterns`);
      
      return {
        intentFlush,
        errorFlush,
      };
    },

    /**
     * Get session statistics
     * @returns {Object} Combined stats from IntentTracker and SessionErrorCache
     */
    getSessionStats() {
      return {
        intentTracker: this._intentTracker?.getStats() || null,
        errorCache: this._sessionErrorCache?.getStats() || null,
      };
    },

    /**
     * Clear session data (for reset or testing)
     */
    clearSessionData() {
      if (this._intentTracker) {
        this._intentTracker.clear();
      }
      if (this._sessionErrorCache) {
        this._sessionErrorCache.clear();
      }
      this._log('[EvolutionLoopIntentMixin] 🧹 Session data cleared');
    },

    /**
     * Generate a stable error pattern signature for deduplication
     * @private
     */
    _normalizeErrorPattern(signal) {
      if (!signal || !signal.type) return null;
      
      // Create signature from type + normalized evidence
      const normalizedEvidence = (signal.evidence || '')
        .replace(/\d+/g, 'N') // Replace numbers
        .replace(/'[^']*'/g, "'...'") // Replace quoted strings
        .replace(/"[^"]*"/g, '"..."')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
      
      return `${signal.type}:${normalizedEvidence}`;
    },
  };
}

/**
 * Apply IntentMixin to an EvolutionLoop instance
 * @param {Object} evolutionLoop - EvolutionLoop instance
 * @param {Object} options - Initialization options
 */
function applyIntentMixin(evolutionLoop, options = {}) {
  const mixin = EvolutionLoopIntentMixin();
  
  // Apply all mixin methods
  for (const [key, value] of Object.entries(mixin)) {
    if (typeof value === 'function') {
      evolutionLoop[key] = value.bind(evolutionLoop);
    }
  }
  
  // Initialize
  evolutionLoop._initIntentTracking(options);
  
  return evolutionLoop;
}

module.exports = {
  EvolutionLoopIntentMixin,
  applyIntentMixin,
};
