/**
 * Experience Evolution – Hit tracking, adaptive thresholds, and evolution triggers
 *
 * Extracted from ExperienceStore to enable independent evolution of the
 * skill-promotion algorithm without touching storage or search logic.
 *
 * This module provides:
 *   - ExperienceEvolutionMixin – markUsed(), markRetrieved(), markUsedBatch(),
 *     triggerEvolutions(), flushDirty()
 *   - _computeEvolutionThreshold() – adaptive threshold based on category + tags
 */

'use strict';

const { ExperienceType, GENERIC_CATEGORIES, FRAMEWORK_CATEGORIES } = require('./experience-types');

// ─── Adaptive Evolution Threshold ────────────────────────────────────────────

/**
 * Computes the adaptive evolution threshold for a given experience entry.
 *
 * Base thresholds by category specificity:
 *   GENERIC    → 3 (fast: broadly applicable, quick to confirm)
 *   FRAMEWORK  → 7 (slow: need diverse domain evidence before promoting)
 *   OTHER      → 5 (moderate: default for unclassified categories)
 *
 * Tag-count modulator: +1 per 3 tags, capped at +3.
 *
 * @param {object} exp - Experience entry with category and tags fields
 * @returns {number} The evolution threshold
 */
function _computeEvolutionThreshold(exp) {
  let base;
  if (GENERIC_CATEGORIES.has(exp.category)) {
    base = 3;
  } else if (FRAMEWORK_CATEGORIES.has(exp.category)) {
    base = 7;
  } else {
    base = 5;
  }
  const tagBonus = Math.min(Math.floor((exp.tags?.length || 0) / 3), 3);
  return base + tagBonus;
}

// ─── ExperienceEvolution Mixin ──────────────────────────────────────────────
// Mixed into ExperienceStore.prototype. References this.experiences, this._dirty, this._save().

const ExperienceEvolutionMixin = {

  /**
   * Increments the retrieval counter for an experience (zombie detection).
   */
  markRetrieved(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return;
    if (!exp.retrievalCount) exp.retrievalCount = 0;
    exp.retrievalCount += 1;
    this._dirty = true;
  },

  /**
   * Marks an experience as "used" (increments hitCount).
   *
   * @param {string} expId
   * @returns {boolean} true if this experience should trigger skill evolution
   */
  markUsed(expId) {
    const exp = this.experiences.find(e => e.id === expId);
    if (!exp) return false;
    exp.hitCount += 1;
    exp.updatedAt = new Date().toISOString();

    const threshold = _computeEvolutionThreshold(exp);
    const shouldEvolve = exp.type === ExperienceType.POSITIVE && exp.hitCount === threshold;

    if (shouldEvolve) {
      this._save();
    } else {
      this._dirty = true;
    }

    return shouldEvolve;
  },

  /**
   * Marks multiple experiences as "effectively used" in a batch.
   *
   * @param {string[]} ids
   * @returns {string[]} IDs that should trigger skill evolution
   */
  markUsedBatch(ids) {
    if (!ids || ids.length === 0) return [];
    const evolutionTriggers = [];
    for (const id of ids) {
      const shouldEvolve = this.markUsed(id);
      if (shouldEvolve) evolutionTriggers.push(id);
    }
    return evolutionTriggers;
  },

  /**
   * Flushes any pending dirty state to disk.
   *
   * @returns {Promise<void>}
   */
  flushDirty() {
    this.flushSynonymTable();
    if (this._dirty) {
      this._dirty = false;
      return this._save();
    }
    return Promise.resolve();
  },

  /**
   * Centralised skill evolution trigger.
   *
   * @param {string[]} triggerExpIds
   * @param {object} skillEvolution - SkillEvolutionEngine instance
   * @param {object} hooks - HookSystem instance
   * @param {string} stageName
   * @returns {Promise<number>} Number of evolutions triggered
   */
  async triggerEvolutions(triggerExpIds, skillEvolution, hooks, stageName) {
    if (!triggerExpIds || triggerExpIds.length === 0) return 0;
    let evolved = 0;
    for (const expId of triggerExpIds) {
      const triggerExp = this.experiences.find(e => e.id === expId);
      if (triggerExp && triggerExp.skill) {
        skillEvolution.evolve(triggerExp.skill, {
          section: 'Best Practices',
          title: triggerExp.title,
          content: triggerExp.content,
          sourceExpId: expId,
          reason: `High-frequency pattern (hitCount=${triggerExp.hitCount}) – validated by ${stageName} stage success`,
        });
        if (hooks) {
          await hooks.emit('skill_evolved', { skillName: triggerExp.skill, expId }).catch(() => {});
        }
        evolved++;
      }
    }
    return evolved;
  },
};

module.exports = {
  ExperienceEvolutionMixin,
  _computeEvolutionThreshold,
};
