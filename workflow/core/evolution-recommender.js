/**
 * Evolution Recommender – Third layer of Problem Abstraction Engine
 *
 * ADR-33 Phase 4: This module has been split into sub-modules:
 *   - evolution-refactoring-templates.js – REFACTORING_TEMPLATES constant
 *   - evolution-adr-generator.js         – ADRGenerator class
 *   - evolution-recommender.js (this)    – ArchitectureChangeQueue, RefactoringAdvisor, EvolutionRecommender facade
 *
 * All exports are re-exported from this file for backward compatibility.
 *
 * @module evolution-recommender
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Import from sub-modules ────────────────────────────────────────────────

const { REFACTORING_TEMPLATES } = require('./evolution-refactoring-templates');
const { ADRGenerator } = require('./evolution-adr-generator');

// ─── Architecture Change Queue ──────────────────────────────────────────────

/**
 * Architecture Change Queue – Tracks pending evolution proposals.
 *
 * Manages the lifecycle of detected patterns from trigger to implementation:
 *   - Queued → In Review → Approved → In Progress → Implemented
 *   - Supports priority levels (P0/P1/P2/P3)
 */
class ArchitectureChangeQueue {
  constructor(options = {}) {
    this.storePath = options.storePath || null;
    this.proposals = new Map();
    this.maxQueueSize = options.maxQueueSize || 100;
    this._load();
  }

  add(adr, options = {}) {
    const id = `${adr.id}-${Date.now()}`;

    const proposal = {
      id,
      adrId: adr.id,
      title: adr.title,
      status: options.status || 'queued',
      priority: this._determinePriority(adr),
      patternId: adr.metadata.patternId,
      patternName: adr.metadata.patternName,
      severity: adr.metadata.severity,
      createdAt: adr.generatedAt,
      updatedAt: adr.generatedAt,
      assignedTo: options.assignedTo || null,
      notes: options.notes || '',
      implementedAt: null,
    };

    const existing = this._findByPattern(adr.metadata.patternId);
    if (existing) {
      if (adr.metadata.occurrenceCount > existing.occurrenceCount) {
        existing.updatedAt = new Date().toISOString();
        this._save();
      }
      return existing;
    }

    this.proposals.set(id, proposal);
    this._trimIfNeeded();
    this._save();

    return proposal;
  }

  updateStatus(id, status, updates = {}) {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;

    proposal.status = status;
    proposal.updatedAt = new Date().toISOString();

    if (status === 'implemented') {
      proposal.implementedAt = new Date().toISOString();
    }

    Object.assign(proposal, updates);
    this._save();

    return proposal;
  }

  get(id) {
    return this.proposals.get(id) || null;
  }

  getAll(filters = {}) {
    let results = Array.from(this.proposals.values());

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        results = results.filter(p => filters.status.includes(p.status));
      } else {
        results = results.filter(p => p.status === filters.status);
      }
    }

    if (filters.priority) {
      if (Array.isArray(filters.priority)) {
        results = results.filter(p => filters.priority.includes(p.priority));
      } else {
        results = results.filter(p => p.priority === filters.priority);
      }
    }

    if (filters.patternId) {
      results = results.filter(p => p.patternId === filters.patternId);
    }

    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    results.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return results;
  }

  getStats() {
    const proposals = Array.from(this.proposals.values());

    return {
      total: proposals.length,
      byStatus: {
        queued: proposals.filter(p => p.status === 'queued').length,
        inReview: proposals.filter(p => p.status === 'in-review').length,
        approved: proposals.filter(p => p.status === 'approved').length,
        inProgress: proposals.filter(p => p.status === 'in-progress').length,
        implemented: proposals.filter(p => p.status === 'implemented').length,
        rejected: proposals.filter(p => p.status === 'rejected').length,
      },
      byPriority: {
        P0: proposals.filter(p => p.priority === 'P0').length,
        P1: proposals.filter(p => p.priority === 'P1').length,
        P2: proposals.filter(p => p.priority === 'P2').length,
        P3: proposals.filter(p => p.priority === 'P3').length,
      },
    };
  }

  getPendingCount() {
    return Array.from(this.proposals.values()).filter(
      p => !['implemented', 'rejected'].includes(p.status)
    ).length;
  }

  /** @private */
  _determinePriority(adr) {
    const severityPriority = {
      critical: 'P0',
      high: 'P1',
      medium: 'P2',
      low: 'P3',
    };
    return severityPriority[adr.metadata.severity] || 'P2';
  }

  /** @private */
  _findByPattern(patternId) {
    for (const proposal of this.proposals.values()) {
      if (proposal.patternId === patternId && proposal.status !== 'implemented') {
        return proposal;
      }
    }
    return null;
  }

  /** @private */
  _trimIfNeeded() {
    if (this.proposals.size <= this.maxQueueSize) return;

    const entries = Array.from(this.proposals.entries());
    const removable = entries.filter(([, p]) => ['implemented', 'rejected'].includes(p.status));

    removable
      .sort(([, a], [, b]) => new Date(a.updatedAt) - new Date(b.updatedAt))
      .slice(0, removable.length - this.maxQueueSize + entries.length)
      .forEach(([id]) => this.proposals.delete(id));
  }

  /** @private */
  _load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (data.proposals) {
        this.proposals = new Map(Object.entries(data.proposals));
      }
    } catch (err) {
      console.warn(`[ArchitectureChangeQueue] Could not load: ${err.message}`);
    }
  }

  /** @private */
  _save() {
    if (!this.storePath) return;

    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        proposals: Object.fromEntries(this.proposals),
        updatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[ArchitectureChangeQueue] Could not save: ${err.message}`);
    }
  }
}

// ─── Refactoring Advisor ────────────────────────────────────────────────────

/**
 * Refactoring Advisor – Provides concrete code transformation guidance.
 */
class RefactoringAdvisor {
  constructor() {
    this.templates = REFACTORING_TEMPLATES;
  }

  getRefactoringGuide(patternId) {
    const template = this.templates[patternId];
    if (!template) return null;

    return {
      patternId: template.patternId,
      name: template.refactoringName,
      description: template.description,
      architecturalPattern: template.architecturalPattern,
      beforeExample: template.beforeExample,
      afterExample: template.afterExample,
      implementationPlan: template.implementationPlan,
      filesToModify: template.filesToModify,
      effort: template.effort,
      benefits: template.benefits,
    };
  }

  hasTemplate(patternId) {
    return patternId in this.templates;
  }

  getAllTemplates() {
    return Object.values(this.templates).map(t => this.getRefactoringGuide(t.patternId));
  }

  generateChecklist(patternId) {
    const guide = this.getRefactoringGuide(patternId);
    if (!guide) return [];

    const checklist = [];

    guide.implementationPlan.forEach(step => {
      checklist.push(`[ ] Step ${step.step}: ${step.title}`);
      if (step.exampleFile) {
        checklist.push(`    File: ${step.exampleFile}`);
      }
    });

    return checklist;
  }
}

// ─── Evolution Recommender Facade ───────────────────────────────────────────

/**
 * Evolution Recommender – Main facade for evolution recommendations.
 */
class EvolutionRecommender {
  constructor(options = {}) {
    this.adrGenerator = new ADRGenerator(options.adr);
    this.changeQueue = new ArchitectureChangeQueue(options.queue);
    this.refactoringAdvisor = new RefactoringAdvisor();
    this.onProposalCreated = options.onProposalCreated || null;
  }

  processTriggeredPattern(triggeredPattern, trend = null) {
    const adr = this.adrGenerator.generate(triggeredPattern, trend);
    const proposal = this.changeQueue.add(adr, {
      notes: `Occurrence #: ${triggeredPattern.occurrenceCount}`,
    });
    const refactoringGuide = this.refactoringAdvisor.getRefactoringGuide(triggeredPattern.patternId);

    if (this.onProposalCreated) {
      this.onProposalCreated({ adr, proposal, refactoringGuide });
    }

    return {
      adr,
      proposal,
      refactoringGuide,
      summary: {
        actionRequired: proposal.priority === 'P0' || proposal.priority === 'P1',
        estimatedEffort: refactoringGuide?.effort?.estimatedHours || 'unknown',
        hasDetailedPlan: !!refactoringGuide,
      },
    };
  }

  getPendingProposals() {
    return this.changeQueue.getAll({
      status: ['queued', 'in-review', 'approved', 'in-progress'],
    });
  }

  getRefactoringGuide(patternId) {
    return this.refactoringAdvisor.getRefactoringGuide(patternId);
  }

  saveADRToFile(adrId) {
    const adr = this.adrGenerator.getGeneratedADRs().find(a => a.id === adrId);
    if (!adr) return null;
    return this.adrGenerator.saveToFile(adr);
  }

  getQueueStats() {
    return this.changeQueue.getStats();
  }
}

// ─── Exports (backward compatible) ─────────────────────────────────────────

module.exports = {
  // Core classes
  EvolutionRecommender,
  ADRGenerator,
  ArchitectureChangeQueue,
  RefactoringAdvisor,

  // Constants
  REFACTORING_TEMPLATES,

  // Factory
  createRecommender: (options) => new EvolutionRecommender(options),
};
