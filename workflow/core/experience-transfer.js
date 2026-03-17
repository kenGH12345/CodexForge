/**
 * Experience Transfer – Cross-project export/import of experiences
 *
 * Extracted from ExperienceStore to isolate the serialization,
 * conflict resolution, and portability logic.
 *
 * This module provides:
 *   - ExperienceTransferMixin – exportPortable(), importFrom(), extractUniversalExperiences()
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceType, UNIVERSAL_CATEGORIES } = require('./experience-types');

// ─── ExperienceTransfer Mixin ───────────────────────────────────────────────
// Mixed into ExperienceStore.prototype. References this.experiences, this._titleIndex, etc.

const ExperienceTransferMixin = {

  /**
   * Exports experiences that are portable across projects.
   *
   * @param {object} [options]
   * @param {boolean}  [options.universalOnly=false]
   * @param {string[]} [options.categories]
   * @param {number}   [options.minHitCount=0]
   * @param {string}   [options.projectId]
   * @param {boolean}  [options.stripProjectSpecifics=true]
   * @returns {{ version: number, exportedAt: string, sourceProject: string|null, count: number, experiences: object[] }}
   */
  exportPortable({
    universalOnly = false,
    categories = null,
    minHitCount = 0,
    projectId = null,
    stripProjectSpecifics = true,
  } = {}) {
    let candidates = this.experiences.filter(e => {
      if (e.expiresAt && new Date(e.expiresAt).getTime() < Date.now()) return false;
      if (e.hitCount < minHitCount) return false;
      if (categories && categories.length > 0 && !categories.includes(e.category)) return false;
      return true;
    });

    if (universalOnly) {
      candidates = candidates.filter(e => UNIVERSAL_CATEGORIES.has(e.category));
    }

    const exported = candidates.map(e => {
      const entry = { ...e };
      if (stripProjectSpecifics) {
        delete entry.sourceFile;
        delete entry.namespace;
        delete entry.taskId;
      }
      entry.hitCount = 0;
      entry.retrievalCount = 0;
      entry.evolutionCount = 0;
      entry._importedFrom = projectId || 'unknown';
      entry._importedAt = null;
      return entry;
    });

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceProject: projectId || null,
      count: exported.length,
      experiences: exported,
    };
  },

  /**
   * Imports experiences from an exported file or another project.
   *
   * @param {string|object} source
   * @param {object} [options]
   * @param {string}  [options.conflictStrategy='skip']
   * @param {boolean} [options.resetTTL=true]
   * @param {string[]} [options.filterCategories]
   * @param {number}  [options.ttlDays]
   * @returns {{ imported: number, skipped: number, merged: number, errors: string[] }}
   */
  importFrom(source, {
    conflictStrategy = 'skip',
    resetTTL = true,
    filterCategories = null,
    ttlDays = null,
  } = {}) {
    let exportData;
    if (typeof source === 'string') {
      try {
        const raw = fs.readFileSync(source, 'utf-8');
        exportData = JSON.parse(raw);
      } catch (err) {
        return { imported: 0, skipped: 0, merged: 0, errors: [`Failed to read import file: ${err.message}`] };
      }
    } else {
      exportData = source;
    }

    if (!exportData || !Array.isArray(exportData.experiences)) {
      return { imported: 0, skipped: 0, merged: 0, errors: ['Invalid export format: missing experiences array'] };
    }

    let imported = 0;
    let skipped = 0;
    let merged = 0;
    const errors = [];

    for (const exp of exportData.experiences) {
      try {
        if (filterCategories && filterCategories.length > 0 && !filterCategories.includes(exp.category)) {
          skipped++;
          continue;
        }

        const existing = this.findByTitle(exp.title);

        if (existing) {
          if (conflictStrategy === 'skip') {
            skipped++;
            continue;
          } else if (conflictStrategy === 'merge') {
            const importNote = `[Imported from ${exp._importedFrom || 'external'} on ${new Date().toISOString().slice(0, 10)}]\n${exp.content}`;
            this.appendByTitle(exp.title, importNote);
            if (exp.tags && exp.tags.length > 0) {
              const tagSet = new Set([...(existing.tags || []), ...exp.tags]);
              existing.tags = [...tagSet];
            }
            merged++;
            continue;
          } else if (conflictStrategy === 'overwrite') {
            const idx = this.experiences.indexOf(existing);
            if (idx !== -1) {
              this.experiences.splice(idx, 1);
              this._titleIndex.delete(existing.title);
            }
          }
        }

        const newId = `EXP-${Date.now()}-IMP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
        const effectiveTtl = ttlDays !== undefined && ttlDays !== null
          ? ttlDays
          : (resetTTL ? (exp.type === ExperienceType.NEGATIVE ? 90 : 365) : null);
        const expiresAt = effectiveTtl != null
          ? new Date(Date.now() + effectiveTtl * 86400_000).toISOString()
          : exp.expiresAt || null;

        const importedExp = {
          ...exp,
          id: newId,
          hitCount: 0,
          retrievalCount: 0,
          evolutionCount: 0,
          createdAt: exp.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          expiresAt,
          _importedFrom: exp._importedFrom || exportData.sourceProject || 'external',
          _importedAt: new Date().toISOString(),
        };

        this.experiences.push(importedExp);
        this._titleIndex.add(importedExp.title);
        imported++;
      } catch (err) {
        errors.push(`Failed to import "${exp.title}": ${err.message}`);
      }
    }

    if (imported > 0 || merged > 0) { this._save(); }

    console.log(`[ExperienceStore] 📦 Import complete: ${imported} imported, ${skipped} skipped, ${merged} merged, ${errors.length} error(s). Source: ${exportData.sourceProject || 'external'}`);
    return { imported, skipped, merged, errors };
  },

  /**
   * Extracts universal (project-agnostic) experiences to a file.
   *
   * @param {string} outputPath
   * @param {object} [options]
   * @param {number}  [options.minHitCount=1]
   * @param {string}  [options.projectId]
   * @returns {{ exported: number, path: string }}
   */
  extractUniversalExperiences(outputPath, { minHitCount = 1, projectId = null } = {}) {
    const exportData = this.exportPortable({
      universalOnly: true,
      minHitCount,
      projectId,
      stripProjectSpecifics: true,
    });

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmpPath = outputPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(exportData, null, 2), 'utf-8');
    fs.renameSync(tmpPath, outputPath);

    console.log(`[ExperienceStore] 🌐 Extracted ${exportData.count} universal experience(s) → ${outputPath}`);
    return { exported: exportData.count, path: outputPath };
  },
};

module.exports = { ExperienceTransferMixin };
