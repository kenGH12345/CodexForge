/**
 * Experience Health Mixin
 *
 * Extracted from experience-store.js for maintainability (ADR-41).
 * Contains health check methods for layer, scope, and source type distribution.
 *
 * @module workflow/core/experience-health-mixin
 */

'use strict';

const { KnowledgeLayer, getLayerForCategory, ExperienceScope } = require('./experience-types');
const { SourceType, DEFAULT_SOURCE_TYPE } = require('./experience-types');

// ─── Layer Health Methods ────────────────────────────────────────────────────

/**
 * Get experiences filtered by knowledge layer.
 *
 * @this {ExperienceStore}
 * @param {string} layer - KnowledgeLayer value
 * @returns {Experience[]}
 */
function getByLayer(layer) {
  return this.experiences.filter(exp => {
    const expLayer = getLayerForCategory(exp.category);
    return expLayer === layer;
  });
}

/**
 * Get statistics grouped by knowledge layer.
 * Useful for understanding the composition of the experience store.
 *
 * @this {ExperienceStore}
 * @returns {{ byLayer: object, practiceRatio: number }}
 */
function getLayerStats() {
  const byLayer = {
    [KnowledgeLayer.PLATFORM]: 0,
    [KnowledgeLayer.DOMAIN]: 0,
    [KnowledgeLayer.PRACTICE]: 0,
  };

  for (const exp of this.experiences) {
    const layer = getLayerForCategory(exp.category);
    byLayer[layer] = (byLayer[layer] || 0) + 1;
  }

  const total = this.experiences.length;
  const practiceRatio = total > 0 ? byLayer[KnowledgeLayer.PRACTICE] / total : 0;

  return { byLayer, practiceRatio, total };
}

/**
 * Check if the experience store has too many non-PRACTICE layer experiences.
 * ADR-43: Quality gate to prevent experience store pollution.
 *
 * @this {ExperienceStore}
 * @param {number} [threshold=0.5] - Minimum PRACTICE ratio threshold
 * @returns {{ healthy: boolean, practiceRatio: number, recommendation: string }}
 */
function checkLayerHealth(threshold = 0.5) {
  const { byLayer, practiceRatio, total } = this.getLayerStats();

  if (total < 10) {
    return {
      healthy: true,
      practiceRatio,
      recommendation: 'Not enough experiences to assess layer health',
    };
  }

  const healthy = practiceRatio >= threshold;
  let recommendation = '';

  if (!healthy) {
    const nonPractice = byLayer[KnowledgeLayer.PLATFORM] + byLayer[KnowledgeLayer.DOMAIN];
    recommendation = `PRACTICE layer ratio (${(practiceRatio * 100).toFixed(1)}%) below threshold (${(threshold * 100)}%). ` +
      `Consider purging ${nonPractice} PLATFORM/DOMAIN experiences or capturing more PRACTICE experiences.`;
  } else {
    recommendation = `Layer health is good: ${(practiceRatio * 100).toFixed(1)}% PRACTICE experiences`;
  }

  return { healthy, practiceRatio, recommendation, byLayer };
}

// ─── Scope Health Methods ────────────────────────────────────────────────────

/**
 * Get experiences filtered by scope.
 *
 * @this {ExperienceStore}
 * @param {string} scope - ExperienceScope value
 * @returns {Experience[]}
 */
function getByScope(scope) {
  return this._byScope.get(scope) || [];
}

/**
 * Get statistics grouped by scope.
 * Useful for understanding the composition of the experience store.
 *
 * @this {ExperienceStore}
 * @returns {{ byScope: object, projectRatio: number, total: number }}
 */
function getScopeStats() {
  const byScope = {
    [ExperienceScope.WORKFLOW]: (this._byScope.get(ExperienceScope.WORKFLOW) || []).length,
    [ExperienceScope.PROJECT]: (this._byScope.get(ExperienceScope.PROJECT) || []).length,
  };

  const total = byScope[ExperienceScope.WORKFLOW] + byScope[ExperienceScope.PROJECT];
  const projectRatio = total > 0 ? byScope[ExperienceScope.PROJECT] / total : 0;

  return { byScope, projectRatio, total };
}

/**
 * Check if the experience store has a healthy scope distribution.
 * PROJECT scope experiences should dominate (project-specific knowledge).
 *
 * @this {ExperienceStore}
 * @param {number} [threshold=0.6] - Minimum PROJECT ratio threshold
 * @returns {{ healthy: boolean, projectRatio: number, recommendation: string }}
 */
function checkScopeHealth(threshold = 0.6) {
  const { byScope, projectRatio, total } = this.getScopeStats();

  if (total < 5) {
    return {
      healthy: true,
      projectRatio,
      recommendation: 'Not enough experiences to assess scope health',
    };
  }

  const healthy = projectRatio >= threshold;
  let recommendation = '';

  if (!healthy) {
    recommendation = `PROJECT scope ratio (${(projectRatio * 100).toFixed(1)}%) below threshold (${(threshold * 100)}%). ` +
      `Consider if WORKFLOW experiences should be moved to PROJECT scope.`;
  } else {
    recommendation = `Scope health is good: ${(projectRatio * 100).toFixed(1)}% PROJECT scope experiences`;
  }

  return { healthy, projectRatio, recommendation, byScope };
}

/**
 * Get storage paths for diagnostic display.
 *
 * @this {ExperienceStore}
 * @returns {{ workflow: string, project: string|null, legacy: string }}
 */
function getStoragePaths() {
  return {
    workflow: this._workflowStorePath,
    project: this._projectStorePath,
    legacy: this.storePath,
  };
}

// ─── Source Type Health Methods ──────────────────────────────────────────────

/**
 * Get experiences filtered by source type.
 * Enables source-aware experience retrieval.
 *
 * @this {ExperienceStore}
 * @param {string} sourceType - SourceType value (ARTICLE, CONVERSATION, DISTILLED)
 * @returns {Experience[]}
 */
function getBySourceType(sourceType) {
  return this.experiences.filter(exp => (exp.sourceType || DEFAULT_SOURCE_TYPE) === sourceType);
}

/**
 * Get statistics grouped by source type.
 * Useful for understanding the composition of the experience store.
 *
 * @this {ExperienceStore}
 * @returns {{ bySourceType: object, articleRatio: number, total: number }}
 */
function getSourceTypeStats() {
  const bySourceType = {
    [SourceType.ARTICLE]: 0,
    [SourceType.CONVERSATION]: 0,
    [SourceType.DISTILLED]: 0,
  };

  for (const exp of this.experiences) {
    const st = exp.sourceType || DEFAULT_SOURCE_TYPE;
    bySourceType[st] = (bySourceType[st] || 0) + 1;
  }

  const total = this.experiences.length;
  const articleRatio = total > 0 ? bySourceType[SourceType.ARTICLE] / total : 0;

  return { bySourceType, articleRatio, total };
}

/**
 * Check if the experience store has a healthy source type distribution.
 * ARTICLE experiences should have significant presence for authoritative knowledge.
 *
 * @this {ExperienceStore}
 * @param {number} [threshold=0.1] - Minimum ARTICLE ratio threshold
 * @returns {{ healthy: boolean, articleRatio: number, recommendation: string }}
 */
function checkSourceTypeHealth(threshold = 0.1) {
  const { bySourceType, articleRatio, total } = this.getSourceTypeStats();

  if (total < 10) {
    return {
      healthy: true,
      articleRatio,
      recommendation: 'Not enough experiences to assess source type health',
    };
  }

  const healthy = articleRatio >= threshold;
  let recommendation = '';

  if (!healthy) {
    recommendation = `ARTICLE ratio (${(articleRatio * 100).toFixed(1)}%) below threshold (${(threshold * 100)}%). ` +
      `Consider importing more authoritative knowledge from articles or documentation.`;
  } else {
    recommendation = `Source type health is good: ${(articleRatio * 100).toFixed(1)}% ARTICLE experiences`;
  }

  return { healthy, articleRatio, recommendation, bySourceType };
}

// ─── Mixin Export ────────────────────────────────────────────────────────────

const ExperienceHealthMixin = {
  getByLayer,
  getLayerStats,
  checkLayerHealth,
  getByScope,
  getScopeStats,
  checkScopeHealth,
  getStoragePaths,
  getBySourceType,
  getSourceTypeStats,
  checkSourceTypeHealth,
};

module.exports = {
  ExperienceHealthMixin,
  getByLayer,
  getLayerStats,
  checkLayerHealth,
  getByScope,
  getScopeStats,
  checkScopeHealth,
  getStoragePaths,
  getBySourceType,
  getSourceTypeStats,
  checkSourceTypeHealth,
};
