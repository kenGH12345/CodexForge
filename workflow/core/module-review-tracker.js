/**
 * Module Review Tracker – Track module review status across sessions
 *
 * Problem: When performing deep audits across many modules, we lose track of:
 *   - Which modules have been reviewed
 *   - What issues were found in each module
 *   - Which issues are still pending
 *   - What was the last review timestamp
 *
 * Solution: A lightweight tracking system that persists review state to JSON.
 *
 * Usage:
 *   const tracker = new ModuleReviewTracker();
 *   tracker.recordReview('core/code-graph.js', { issues: [...], summary: '...' });
 *   const status = tracker.getReviewStatus('core/code-graph.js');
 *   const pending = tracker.getPendingIssues();
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, getDefaultOutputDir } = require('./constants');

// ─── Review Status ──────────────────────────────────────────────────────────

const ReviewStatus = {
  NOT_REVIEWED: 'not-reviewed',     // Not yet reviewed
  IN_PROGRESS: 'in-progress',       // Review started but not completed
  REVIEWED: 'reviewed',             // Review completed, no critical issues
  NEEDS_ACTION: 'needs-action',     // Review completed, has pending issues
  RESOLVED: 'resolved',             // All issues resolved
};

// ─── Issue Priority ──────────────────────────────────────────────────────────

const IssuePriority = {
  CRITICAL: 'critical',  // Must fix immediately
  HIGH: 'high',          // Should fix soon
  MEDIUM: 'medium',      // Fix when possible
  LOW: 'low',            // Nice to have
  INFO: 'info',          // Informational only
};

// ─── Module Review Tracker ───────────────────────────────────────────────────

class ModuleReviewTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.storePath] - Path to persist review data
   * @param {boolean} [options.verbose] - Enable verbose logging
   */
  constructor(options = {}) {
    this.storePath = options.storePath || path.join(getDefaultOutputDir(), 'module-reviews.json');
    this.verbose = options.verbose || false;
    
    /** @type {Map<string, ModuleReview>} */
    this.reviews = new Map();
    
    /** @type {Map<string, Issue[]>} Issue ID -> Issue */
    this.issues = new Map();
    
    this._load();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Records a review for a module.
   *
   * @param {string} modulePath - Module file path (relative or absolute)
   * @param {object} review
   * @param {string} [review.reviewer] - Reviewer name (e.g., 'deep-audit', 'user')
   * @param {string} [review.summary] - Review summary
   * @param {Issue[]} [review.issues] - Issues found during review
   * @param {object} [review.metrics] - Module metrics (lines, complexity, etc.)
   * @returns {ModuleReview}
   */
  recordReview(modulePath, review) {
    const normalizedPath = this._normalizePath(modulePath);
    const now = new Date().toISOString();
    
    const issues = (review.issues || []).map(issue => ({
      id: issue.id || this._generateIssueId(),
      severity: issue.severity || 'medium',
      category: issue.category || 'unknown',
      title: issue.title || 'Untitled issue',
      description: issue.description || '',
      suggestion: issue.suggestion || '',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }));
    
    // Add issues to global index
    for (const issue of issues) {
      this.issues.set(issue.id, { ...issue, modulePath: normalizedPath });
    }
    
    const moduleReview = {
      modulePath: normalizedPath,
      status: this._determineStatus(issues),
      reviewer: review.reviewer || 'unknown',
      summary: review.summary || '',
      issues: issues.map(i => i.id),
      metrics: review.metrics || {},
      reviewedAt: now,
      updatedAt: now,
      reviewCount: (this.reviews.get(normalizedPath)?.reviewCount || 0) + 1,
    };
    
    this.reviews.set(normalizedPath, moduleReview);
    this._save();
    
    if (this.verbose) {
      console.log(`[ModuleReviewTracker] 📝 Recorded review for ${normalizedPath} (${issues.length} issues)`);
    }
    
    return moduleReview;
  }

  /**
   * Gets the review status for a module.
   *
   * @param {string} modulePath
   * @returns {ModuleReview|null}
   */
  getReviewStatus(modulePath) {
    return this.reviews.get(this._normalizePath(modulePath)) || null;
  }

  /**
   * Gets all pending issues across all modules.
   *
   * @param {object} [options]
   * @param {string[]} [options.severities] - Filter by severities
   * @param {string[]} [options.categories] - Filter by categories
   * @returns {Issue[]}
   */
  getPendingIssues(options = {}) {
    const { severities, categories } = options;
    
    let pending = Array.from(this.issues.values()).filter(i => i.status === 'open');
    
    if (severities && severities.length > 0) {
      pending = pending.filter(i => severities.includes(i.severity));
    }
    
    if (categories && categories.length > 0) {
      pending = pending.filter(i => categories.includes(i.category));
    }
    
    return pending.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (priorityOrder[a.severity] || 5) - (priorityOrder[b.severity] || 5);
    });
  }

  /**
   * Marks an issue as resolved.
   *
   * @param {string} issueId
   * @param {string} [resolution] - Resolution note
   * @returns {boolean}
   */
  resolveIssue(issueId, resolution = '') {
    const issue = this.issues.get(issueId);
    if (!issue) return false;
    
    issue.status = 'resolved';
    issue.resolution = resolution;
    issue.resolvedAt = new Date().toISOString();
    issue.updatedAt = issue.resolvedAt;
    
    // Update module status if all issues are resolved
    const moduleReview = this.reviews.get(issue.modulePath);
    if (moduleReview) {
      const moduleIssues = moduleReview.issues.map(id => this.issues.get(id));
      const allResolved = moduleIssues.every(i => i.status === 'resolved');
      if (allResolved) {
        moduleReview.status = ReviewStatus.RESOLVED;
        moduleReview.updatedAt = new Date().toISOString();
      }
    }
    
    this._save();
    
    if (this.verbose) {
      console.log(`[ModuleReviewTracker] ✅ Resolved issue ${issueId}: ${issue.title}`);
    }
    
    return true;
  }

  /**
   * Gets a summary of all reviews.
   *
   * @returns {object}
   */
  getSummary() {
    const modules = Array.from(this.reviews.values());
    const issues = Array.from(this.issues.values());
    
    return {
      totalModules: modules.length,
      byStatus: {
        notReviewed: modules.filter(m => m.status === ReviewStatus.NOT_REVIEWED).length,
        inProgress: modules.filter(m => m.status === ReviewStatus.IN_PROGRESS).length,
        reviewed: modules.filter(m => m.status === ReviewStatus.REVIEWED).length,
        needsAction: modules.filter(m => m.status === ReviewStatus.NEEDS_ACTION).length,
        resolved: modules.filter(m => m.status === ReviewStatus.RESOLVED).length,
      },
      totalIssues: issues.length,
      openIssues: issues.filter(i => i.status === 'open').length,
      resolvedIssues: issues.filter(i => i.status === 'resolved').length,
      bySeverity: {
        critical: issues.filter(i => i.severity === 'critical' && i.status === 'open').length,
        high: issues.filter(i => i.severity === 'high' && i.status === 'open').length,
        medium: issues.filter(i => i.severity === 'medium' && i.status === 'open').length,
        low: issues.filter(i => i.severity === 'low' && i.status === 'open').length,
        info: issues.filter(i => i.severity === 'info' && i.status === 'open').length,
      },
      lastReview: modules.length > 0 
        ? modules.sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt))[0].reviewedAt
        : null,
    };
  }

  /**
   * Gets modules that need review (not reviewed or needs action).
   *
   * @returns {ModuleReview[]}
   */
  getModulesNeedingReview() {
    return Array.from(this.reviews.values())
      .filter(m => m.status === ReviewStatus.NOT_REVIEWED || m.status === ReviewStatus.NEEDS_ACTION)
      .sort((a, b) => {
        // Prioritize needs-action over not-reviewed
        if (a.status === ReviewStatus.NEEDS_ACTION && b.status !== ReviewStatus.NEEDS_ACTION) return -1;
        if (a.status !== ReviewStatus.NEEDS_ACTION && b.status === ReviewStatus.NEEDS_ACTION) return 1;
        return 0;
      });
  }

  /**
   * Exports review data for reporting.
   *
   * @returns {object}
   */
  export() {
    return {
      generatedAt: new Date().toISOString(),
      summary: this.getSummary(),
      reviews: Array.from(this.reviews.values()),
      issues: Array.from(this.issues.values()),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  _normalizePath(modulePath) {
    return modulePath.replace(/\\/g, '/').replace(/^.*\/workflow\//, '');
  }

  _generateIssueId() {
    return `ISSUE-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
  }

  _determineStatus(issues) {
    if (issues.length === 0) return ReviewStatus.REVIEWED;
    
    const hasCritical = issues.some(i => i.severity === 'critical');
    const hasHigh = issues.some(i => i.severity === 'high');
    
    if (hasCritical || hasHigh) return ReviewStatus.NEEDS_ACTION;
    return ReviewStatus.REVIEWED;
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        
        if (data.reviews) {
          for (const review of data.reviews) {
            this.reviews.set(review.modulePath, review);
          }
        }
        
        if (data.issues) {
          for (const issue of data.issues) {
            this.issues.set(issue.id, issue);
          }
        }
        
        if (this.verbose) {
          console.log(`[ModuleReviewTracker] 📂 Loaded ${this.reviews.size} reviews, ${this.issues.size} issues`);
        }
      }
    } catch (err) {
      if (this.verbose) {
        console.warn(`[ModuleReviewTracker] ⚠️  Failed to load: ${err.message}`);
      }
    }
  }

  _save() {
    try {
      const data = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        reviews: Array.from(this.reviews.values()),
        issues: Array.from(this.issues.values()),
      };
      
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[ModuleReviewTracker] ❌ Failed to save: ${err.message}`);
    }
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ModuleReview
 * @property {string} modulePath - Normalized module path
 * @property {string} status - ReviewStatus
 * @property {string} reviewer - Reviewer name
 * @property {string} summary - Review summary
 * @property {string[]} issues - Issue IDs
 * @property {object} metrics - Module metrics
 * @property {string} reviewedAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {number} reviewCount - Number of reviews
 */

/**
 * @typedef {object} Issue
 * @property {string} id - Unique issue ID
 * @property {string} severity - Issue severity
 * @property {string} category - Issue category
 * @property {string} title - Issue title
 * @property {string} description - Issue description
 * @property {string} suggestion - Suggested fix
 * @property {string} status - 'open' or 'resolved'
 * @property {string} modulePath - Module path
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp
 * @property {string} [resolvedAt] - ISO timestamp
 * @property {string} [resolution] - Resolution note
 */

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  ModuleReviewTracker,
  ReviewStatus,
  IssuePriority,
};
