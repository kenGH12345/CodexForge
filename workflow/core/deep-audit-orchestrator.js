/**
 * Deep Audit Orchestrator (ADR-31)
 *
 * Unified deep-inspection layer that orchestrates ALL existing audit components
 * into a single, comprehensive module-level health assessment.
 *
 * Existing audit components run independently as "islands":
 *   - SelfReflectionEngine  – runtime metrics audit (9 checks)
 *   - EntropyGC             – static scan (6 checks)
 *   - CodeGraph             – dependency / coupling analysis
 *   - QualityGate           – per-stage pass/fail decisions
 *   - ArchitectureReviewAgent – architecture compliance
 *
 * This orchestrator adds:
 *   1. Cross-module logic consistency checks
 *   2. Configuration consistency checks (hardcoded values across files)
 *   3. Module-level functional completeness (skill fill-rate, experience coverage)
 *   4. Dependency coupling analysis (CodeGraph → module health)
 *   5. Unified report generation with prioritised findings
 *   6. Auto-injection of findings into ExperienceStore
 *
 * Trigger:
 *   - `/deep-audit` command (manual, on-demand)
 *   - `_finalizeWorkflow()` integration (automatic, fire-and-forget)
 *
 * Output:
 *   - output/deep-audit-report.json  (machine-readable)
 *   - output/deep-audit-report.md    (human-readable)
 *   - Findings → ExperienceStore (auto-recorded)
 *
 * Design: zero new dependencies. Calls into existing modules' public APIs.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Expert Panel (extracted to deep-audit-experts.js) ─────────────────────

const {
  EXPERT_PANEL,
  getExpertsForCategory,
  getPrimaryReviewer,
  buildExpertReviewPrompt,
  enrichFindingsWithExperts,
} = require('./deep-audit-experts');

// ─── Report Generation (extracted to deep-audit-report.js) ────────────────

const {
  generateMarkdownReport,
  getCategoryEmoji,
  writeReports,
  computeStats,
} = require('./deep-audit-report');

// ─── Dimension Checks (extracted to deep-audit-checks.js) ───────────────────

const { createDimensionChecks } = require('./deep-audit-checks');

// ─── Effective Lines Counter Integration ───────────────────────────────────

/**
 * Smart code line counter that distinguishes code from comments/blank lines.
 * This replaces simple line counting with "effective lines" measurement.
 *
 * Benefits:
 *   - Reduces false alarms on well-documented files (30-50% comment ratio is healthy)
 *   - Enforces limits on actual code complexity, not documentation richness
 *   - Tiered limits based on file role (entry-point, core-critical, agent, etc.)
 */
let effectiveLinesCounter;
try {
  effectiveLinesCounter = require('./effective-lines-counter');
} catch (err) {
  // Fallback if module not available (should not happen in production)
  if (process.env.DEBUG) console.warn(`[DeepAudit] effective-lines-counter not available: ${err.message}`);
  effectiveLinesCounter = null;
}

// ─── Module Review Tracker Integration ─────────────────────────────────────

/**
 * Tracks module review status across sessions to prevent "review amnesia".
 * Records which modules have been reviewed, what issues were found, and
 * which issues are still pending.
 */
let moduleReviewTracker;
try {
  moduleReviewTracker = require('./module-review-tracker');
} catch (err) {
  if (process.env.DEBUG) console.warn(`[DeepAudit] module-review-tracker not available: ${err.message}`);
  moduleReviewTracker = null;
}

// ─── Finding Severity ───────────────────────────────────────────────────────

const AuditSeverity = {
  CRITICAL: 'critical',
  HIGH:     'high',
  MEDIUM:   'medium',
  LOW:      'low',
  INFO:     'info',
};

// ─── Finding Categories ─────────────────────────────────────────────────────

const AuditCategory = {
  LOGIC:       'logic-consistency',
  CONFIG:      'config-consistency',
  FUNCTION:    'functional-completeness',
  COUPLING:    'module-coupling',
  ARCHITECTURE:'architecture-compliance',
  PERFORMANCE: 'performance-efficiency',
  KNOWLEDGE:   'knowledge-quality',
};

// ─── Expert Review Panel (P1 fix: fixed panel for self-evolution audits) ────

/**
 * Fixed expert panel for self-evolution deep audits.
 * Each expert is assigned specific audit dimensions that match their expertise.
 * This panel is automatically included in every deep audit run.
 *
 * When the audit generates its LLM-powered review prompts, each expert's
 * identity and perspective are injected into the system prompt to produce
 * domain-specific, high-quality feedback.
 */
// ─── Deep Audit Orchestrator ────────────────────────────────────────────────

class DeepAuditOrchestrator {
  /**
   * @param {object} opts
   * @param {object}   opts.orchestrator    - Orchestrator instance (provides services + context)
   * @param {string}   [opts.outputDir]     - Directory for audit reports
   * @param {boolean}  [opts.verbose=false] - Enable verbose logging
   */
  constructor({ orchestrator, outputDir, verbose = false } = {}) {
    this._orch = orchestrator;
    this._outputDir = outputDir || (orchestrator && orchestrator._outputDir)
      || path.join(__dirname, '..', 'output');
    this._verbose = verbose;
    this._findings = [];
    
    // Get handoffLog from orchestrator if available
    this._handoffLog = orchestrator && orchestrator.handoffLog ? orchestrator.handoffLog : null;
    
    // Initialize module review tracker for cross-session tracking
    if (moduleReviewTracker) {
      this._reviewTracker = new moduleReviewTracker.ModuleReviewTracker({
        storePath: path.join(this._outputDir, 'module-reviews.json'),
        verbose,
      });
    } else {
      this._reviewTracker = null;
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Run the full deep audit. Orchestrates all audit dimensions in parallel
   * where possible, then generates a unified report.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.dimensions] - Subset of dimensions to run (default: all)
   * @param {boolean}  [opts.autoInjectExperience=true] - Auto-record findings in ExperienceStore
   * @param {boolean}  [opts.incremental=false] - Enable incremental mode (only audit changed files)
   * @returns {Promise<DeepAuditResult>}
   */
  async run(opts = {}) {
    const {
      dimensions = Object.values(AuditCategory),
      autoInjectExperience = true,
      incremental = false,
    } = opts;
    const startTime = Date.now();
    this._findings = [];

    // ── Phase 0: Incremental Mode Check ─────────────────────────────────────
    if (incremental) {
      const changedModules = this._detectChangedModules();
      if (changedModules.skip) {
        console.log(`\n[DeepAudit] ⚡ Incremental mode: No changes detected since last audit`);
        console.log(`[DeepAudit]    Last audit: ${changedModules.lastAuditTime}`);
        console.log(`[DeepAudit]    Skipping deep audit (use /deep-audit without --incremental for full audit)`);
        return {
          findings: [],
          stats: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          reportPath: null,
          elapsedMs: Date.now() - startTime,
          skipped: true,
          skipReason: 'no-changes',
          lastAuditTime: changedModules.lastAuditTime,
        };
      } else if (changedModules.changedFiles.length > 0) {
        console.log(`\n[DeepAudit] ⚡ Incremental mode: ${changedModules.changedFiles.length} file(s) changed`);
        console.log(`[DeepAudit]    Changed: ${changedModules.changedFiles.slice(0, 5).join(', ')}${changedModules.changedFiles.length > 5 ? '...' : ''}`);
      }
    }

console.log(`\n[DeepAudit] 🔍 Starting deep audit across ${dimensions.length} dimension(s)...`);

    // ── Phase 1: Run independent checks in parallel ─────────────────────
    const dimensionChecks = createDimensionChecks({
      addFinding: this._addFinding.bind(this),
      log: this._log.bind(this),
      orch: this,
      outputDir: this._outputDir,
      AuditSeverity,
      AuditCategory,
      effectiveLinesCounter,
      handoffLog: this._handoffLog,
    });

    const checks = [];
    const checkTimeouts = {};
    const CHECK_TIMEOUT_MS = 30000; // 30 second timeout per dimension

    // Helper to wrap check with timeout and progress logging
    const runCheck = async (name, checkFn) => {
      console.log(`[DeepAudit] ⏳ Starting ${name}...`);
      const checkStart = Date.now();
      try {
        const timeoutPromise = new Promise((_, reject) => {
          checkTimeouts[name] = setTimeout(() => {
            reject(new Error(`${name} timed out after ${CHECK_TIMEOUT_MS}ms`));
          }, CHECK_TIMEOUT_MS);
        });
        await Promise.race([checkFn(), timeoutPromise]);
        const elapsed = Date.now() - checkStart;
        console.log(`[DeepAudit] ✅ ${name} complete (${elapsed}ms)`);
      } catch (err) {
        const elapsed = Date.now() - checkStart;
        console.error(`[DeepAudit] ❌ ${name} failed after ${elapsed}ms: ${err.message}`);
        // Don't let one failing check stop the audit
      } finally {
        if (checkTimeouts[name]) {
          clearTimeout(checkTimeouts[name]);
          delete checkTimeouts[name];
        }
      }
    };

    if (dimensions.includes(AuditCategory.LOGIC)) {
      checks.push(runCheck('Logic Consistency', () => dimensionChecks.checkLogicConsistency()));
    }
    if (dimensions.includes(AuditCategory.CONFIG)) {
      checks.push(runCheck('Config Consistency', () => dimensionChecks.checkConfigConsistency()));
    }
    if (dimensions.includes(AuditCategory.FUNCTION)) {
      checks.push(runCheck('Functional Completeness', () => dimensionChecks.checkFunctionalCompleteness()));
    }
    if (dimensions.includes(AuditCategory.COUPLING)) {
      checks.push(runCheck('Module Coupling', () => dimensionChecks.checkModuleCoupling()));
    }
    if (dimensions.includes(AuditCategory.ARCHITECTURE)) {
      checks.push(runCheck('Architecture Compliance', () => dimensionChecks.checkArchitectureCompliance()));
    }
    if (dimensions.includes(AuditCategory.PERFORMANCE)) {
      checks.push(runCheck('Performance Efficiency', () => dimensionChecks.checkPerformanceEfficiency()));
    }
    if (dimensions.includes(AuditCategory.KNOWLEDGE)) {
      checks.push(runCheck('Knowledge Quality', () => dimensionChecks.checkKnowledgeQuality()));
    }

    console.log(`[DeepAudit] 🔄 Running ${checks.length} checks in parallel (timeout: ${CHECK_TIMEOUT_MS}ms each)...`);
    await Promise.allSettled(checks);
    console.log(`[DeepAudit] 📊 All dimension checks completed`);

    // ── Phase 2: Correlate and de-duplicate findings ────────────────────
    this._deduplicateFindings();

    // ── Phase 3: Prioritise ─────────────────────────────────────────────
    this._findings.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (severityOrder[a.severity] ?? 5) - (severityOrder[b.severity] ?? 5);
    });

    // ── Phase 4: Generate reports ───────────────────────────────────────
    const report = this._generateReport(startTime);
    writeReports({
      outputDir: this._outputDir,
      markdown: report,
      findings: this._findings,
      stats: computeStats(this._findings, AuditSeverity),
    });

    // ── Phase 5: Auto-inject high-value findings into ExperienceStore ───
    if (autoInjectExperience) {
      this._injectIntoExperienceStore();
    }

    // ── Phase 6: Record module reviews for cross-session tracking ───────
    if (this._reviewTracker) {
      this._recordModuleReviews();
    }

    // ── Phase 7: Expert Panel Review ────────────────────────────────────
    // Enrich findings with expert-specific perspectives. Each expert reviews
// findings in their assigned dimensions and adds commentary/priorities.
    this._enrichWithExpertPerspectives();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = computeStats(this._findings, AuditSeverity);
    console.log(`[DeepAudit] ✅ Deep audit complete in ${elapsed}s: ${this._findings.length} finding(s)`);
    console.log(`[DeepAudit]    Critical: ${stats.critical} | High: ${stats.high} | Medium: ${stats.medium} | Low: ${stats.low} | Info: ${stats.info}`);

    return {
      findings: this._findings,
      stats,
      reportPath: path.join(this._outputDir, 'deep-audit-report.md'),
      elapsedMs: Date.now() - startTime,
    };
  }

  // ─── Incremental Mode Support ─────────────────────────────────────────────

  /**
   * Detects which modules have changed since last audit.
   * Uses module-reviews.json to track last audit timestamp.
   *
   * @returns {{ skip: boolean, changedFiles: string[], lastAuditTime: string|null }}
   */
  _detectChangedModules() {
    const coreDir = path.join(__dirname);
    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
    
    // Get last audit time from module-reviews.json
    let lastAuditTime = null;
    const stateFile = path.join(this._outputDir, 'module-reviews.json');
    
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        lastAuditTime = state.updatedAt || null;
      } catch (_) {
        // First run or corrupted state
      }
    }
    
    // No previous audit - must run full audit
    if (!lastAuditTime) {
      return { skip: false, changedFiles: jsFiles, lastAuditTime: null };
    }
    
    const lastAuditTimestamp = new Date(lastAuditTime).getTime();
    const changedFiles = [];
    
    // Check which files have been modified since last audit
    for (const f of jsFiles) {
      const fullPath = path.join(coreDir, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs > lastAuditTimestamp) {
          changedFiles.push(f);
        }
      } catch (_) {
        // Skip unreadable files
      }
    }
    
    // Skip audit if no files changed
    return {
      skip: changedFiles.length === 0,
      changedFiles,
      lastAuditTime,
    };
}

  // ─── Finding Management ───────────────────────────────────────────────

  _addFinding(finding) {
    this._findings.push({
      id: `DA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      ...finding,
      timestamp: new Date().toISOString(),
    });
  }

  _deduplicateFindings() {
    const seen = new Set();
    this._findings = this._findings.filter(f => {
      const key = `${f.category}:${f.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

// ─── Report Generation ────────────────────────────────────────────────

  _generateReport(startTime) {
    const stats = computeStats(this._findings, AuditSeverity);
    return generateMarkdownReport({
      findings: this._findings,
      stats,
      startTime,
      AuditSeverity,
      AuditCategory,
    });
  }

// ─── Experience Store Injection ───────────────────────────────────────

  _injectIntoExperienceStore() {
    if (!this._orch || !this._orch.experienceStore) return;

    const highValue = this._findings.filter(f =>
      f.severity === AuditSeverity.CRITICAL ||
      f.severity === AuditSeverity.HIGH ||
      f.severity === AuditSeverity.MEDIUM
    );

    let injected = 0;
    for (const f of highValue.slice(0, 10)) { // Cap at 10 to avoid flooding
      try {
        this._orch.experienceStore.recordIfAbsent(`[DeepAudit] ${f.title}`, {
          type: 'negative',
          category: 'pitfall',
          title: `[DeepAudit] ${f.title}`,
          content: `[${f.severity}] ${f.description}\nSuggestion: ${f.suggestion || 'N/A'}\n> _Source: deep-audit (${f.category})_`,
          tags: ['deep-audit', f.category, f.severity],
        });
        injected++;
      } catch (err) {
        if (this._verbose) console.warn(`[DeepAudit] Failed to inject finding: ${err.message}`);
      }
    }

    if (injected > 0) {
      console.log(`[DeepAudit] 💉 ${injected} finding(s) injected into ExperienceStore.`);
    }
  }

  // ─── Module Review Tracking ────────────────────────────────────────────

  /**
   * Records module reviews for cross-session tracking.
   * Groups findings by module and records review status.
   */
  _recordModuleReviews() {
    if (!this._reviewTracker) return;
    
    // Group findings by module
    const findingsByModule = new Map();
    for (const finding of this._findings) {
      if (!finding.locations) continue;
      
      for (const loc of finding.locations) {
        const modulePath = loc.file;
        if (!modulePath) continue;
        
        if (!findingsByModule.has(modulePath)) {
          findingsByModule.set(modulePath, []);
        }
        findingsByModule.get(modulePath).push(finding);
      }
    }
    
    // Record review for each module
    let recorded = 0;
    for (const [modulePath, findings] of findingsByModule) {
      try {
        this._reviewTracker.recordReview(modulePath, {
          reviewer: 'deep-audit',
          summary: `Found ${findings.length} issue(s) in ${path.basename(modulePath)}`,
          issues: findings.map(f => ({
            id: f.id,
            severity: f.severity,
            category: f.category,
            title: f.title,
            description: f.description,
            suggestion: f.suggestion,
          })),
        });
        recorded++;
      } catch (err) {
        if (this._verbose) console.warn(`[DeepAudit] Failed to record review: ${err.message}`);
      }
    }
    
    if (recorded > 0 && this._verbose) {
      console.log(`[DeepAudit] 📝 Recorded reviews for ${recorded} module(s) in tracker.`);
    }
    
    // Print summary of pending issues
    const summary = this._reviewTracker.getSummary();
    if (summary.openIssues > 0) {
      console.log(`[DeepAudit] 📊 Total pending issues: ${summary.openIssues} (Critical: ${summary.bySeverity.critical}, High: ${summary.bySeverity.high}, Medium: ${summary.bySeverity.medium})`);
    }
  }

  // ─── Expert Panel Integration ─────────────────────────────────────────

  /**
   * Enriches audit findings with expert panel perspectives.
   * Each finding is annotated with the expert(s) who would review it
   * based on their assigned dimensions, plus their review persona
   * for use in LLM-powered review prompts.
   */
_enrichWithExpertPerspectives() {
    enrichFindingsWithExperts(this._findings);
    if (this._verbose) {
      const assigned = this._findings.filter(f => f.expertReviewers).length;
      console.log(`[DeepAudit] 👥 Expert panel: ${assigned}/${this._findings.length} finding(s) assigned to reviewers`);
    }
  }

/**
   * Returns the fixed expert panel configuration.
   * Useful for generating LLM review prompts with expert personas.
   *
   * @returns {Array<{ name: string, title: string, role: string, expertise: string, dimensions: string[], promptPersona: string }>}
   */
  getExpertPanel() {
    return [...EXPERT_PANEL];
  }

  /**
   * Returns expert-enriched prompt for a specific finding.
   * Used by the /evolve command to generate expert-quality fix suggestions.
   *
   * @param {object} finding - An audit finding object
   * @returns {string} Expert-contextualised review prompt
   */
  buildExpertReviewPrompt(finding) {
    return buildExpertReviewPrompt(finding);
  }

  // ─── Logging ──────────────────────────────────────────────────────────

  _log(category, message) {
    if (this._verbose) {
      console.log(`[DeepAudit:${category}] ${message}`);
    }
  }
}

module.exports = { DeepAuditOrchestrator, AuditSeverity, AuditCategory, EXPERT_PANEL };
