/**
 * Quality Gate – Automated run validation against quality thresholds
 *
 * Extracted from SelfReflectionEngine (A-1 architecture fix: God Object decomposition).
 * Encapsulates all quality gate evaluation logic: error count, test pass rate,
 * duration, LLM call count, and token waste ratio.
 *
 * EvoSkill Insight: Ground-truth only for diagnosis
 * - Added DIAGNOSTIC_ONLY mode to prevent skill overfitting on new projects
 * - Validation results recorded but NOT propagated to skill evolution initially
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ReflectionType, ReflectionSeverity } = require('./self-reflection-types');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');
const { GateEngine } = require('./gate-engine');

const DEFAULT_QUALITY_GATES = {
  maxErrorCount:       3,
  maxTokenWasteRatio:  0.35,
  minTestPassRate:     0.70,
  maxDurationMs:       600000,
  maxLlmCalls:         15,
  minComplianceScore:  0.80,
  minLintPassRate:     0.80,
  maxCriticalCves:     0,
  minIntegrationTests: 1,
};

// Stage-specific gate configurations (P0-Enhancement: per-stage thresholds)
const STAGE_QUALITY_GATES = {
  ANALYSE:    { maxErrorCount: 1, maxLlmCalls: 5,  maxDurationMs: 300000 },
  ARCHITECT:  { maxErrorCount: 2, maxLlmCalls: 8,  maxDurationMs: 400000 },
  PLAN:       { maxErrorCount: 1, maxLlmCalls: 5,  maxDurationMs: 300000 },
  DEVELOP:    { maxErrorCount: 2, maxLlmCalls: 10, maxDurationMs: 600000 },
  TEST:       { maxErrorCount: 0, maxLlmCalls: 8,  maxDurationMs: 500000 },
  // Legacy full-run gates
  FULL:       DEFAULT_QUALITY_GATES,
};

// ─── Gate Configuration Modes ─────────────────────────────────────────────────
// EvoSkill: Ground-truth only for diagnosis - prevent skill overfitting

const GATE_CONFIG_MODE = {
  DEFAULT: 'default',            // Normal: validation results propagate to skill evolution
  DIAGNOSTIC_ONLY: 'diagnostic', // Diagnostic: record only, don't feedback to skills
};

class QualityGate {
  /**
   * @param {object} options
   * @param {object}   [options.qualityGates] - Override default quality gate thresholds
   * @param {Function} options.recordIssue     - Callback: (opts) => ReflectionEntry
   * @param {Function} [options.cheapLlmCall]  - Cheap LLM call function (GPT-4o-mini / Gemini Flash tier)
   *                                            When provided, failed gates get LLM root-cause analysis
   *                                            appended to their description. Non-blocking, non-fatal.
   * @param {string}   [options.gateMode='default'] - Gate mode: 'default' or 'diagnostic'
   * @param {number}   [options.minDiagnosticSamples=20] - Min samples before auto-switching to default mode
   * @param {Function} [options.onDegradationDetected] - MAPE trigger callback: (degradationInfo) => Promise<void>
   *                                            Called when continuous quality degradation is detected.
   * @param {number}   [options.mapeTriggerThreshold=3] - Consecutive failures before triggering MAPE
   */
  constructor(options = {}) {
    const configGateOptions = QualityGate._loadConfiguredGateOptions(options.projectRoot || process.cwd());
    this._gateOptions = { ...configGateOptions, ...(options.gateOptions || {}) };
    this._gates = { ...DEFAULT_QUALITY_GATES, ...QualityGate._flattenGateThresholds(this._gateOptions), ...options.qualityGates };
    this._recordIssue = options.recordIssue;
    this._cheapLlmCall = typeof options.cheapLlmCall === 'function' ? options.cheapLlmCall : null;

    // Stage decision API: experience recording and rollback limits
    this._experienceStore = options.experienceStore || null;
    this._gates.maxRollbacks = options.maxRollbacks ?? 1;

    // EvoSkill: Diagnostic mode configuration
    this._gateMode = options.gateMode || GATE_CONFIG_MODE.DEFAULT;
    this._minDiagnosticSamples = options.minDiagnosticSamples || 20;
    this._diagnosticHistory = [];
    this._maxDiagnosticHistory = 100;

    // MAPE integration: Self-healing trigger
    this._onDegradationDetected = typeof options.onDegradationDetected === 'function' ? options.onDegradationDetected : null;
    this._mapeTriggerThreshold = options.mapeTriggerThreshold || 3;
    this._consecutiveFailures = 0;
    this._mapeCooldownMs = options.mapeCooldownMs || 300000; // 5 min cooldown
    this._lastMapeTrigger = 0;
  }

  static _loadConfiguredGateOptions(projectRoot) {
    try {
      const p = path.resolve(projectRoot || process.cwd(), 'workflow.config.js');
      if (!fs.existsSync(p)) return {};
      // Safe load: read raw source, extract the phase2.qualityGates object without
      // executing arbitrary code or invalidating module caches with delete require.cache.
      const raw = fs.readFileSync(p, 'utf-8');
      const gatesMatch = raw.match(/phase2\s*:\s*\{[\s\S]*?qualityGates\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
      if (gatesMatch) {
        try {
          // Use Function constructor as a safe evaluator — no filesystem/side-effects.
          const evaluator = new Function(`return (${gatesMatch[1]})`);
          const parsed = evaluator();
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) { /* fall through to require-based fallback */ }
      }
      // Fallback: still use require() for complex configs, but without cache invalidation
      try {
        const config = require(p);
        return (config && config.phase2 && config.phase2.qualityGates) || {};
      } catch (_) { return {}; }
    } catch (_) {
      return {};
    }
  }

  static _flattenGateThresholds(gateOptions = {}) {
    const flat = {};
    if (gateOptions.lintPassRate?.minPassRate !== undefined) flat.minLintPassRate = gateOptions.lintPassRate.minPassRate;
    if (gateOptions.cveAuditGate?.maxCritical !== undefined) flat.maxCriticalCves = gateOptions.cveAuditGate.maxCritical;
    if (gateOptions.integrationCoverage?.minTests !== undefined) flat.minIntegrationTests = gateOptions.integrationCoverage.minTests;

    // O-1: Propagate severity field — maps config severity ('HIGH'|'MED'|'LOW') to advisory flag.
    // 'MED' or 'LOW' → advisory (non-blocking); 'HIGH' or absent → blocking.
    const severityToAdvisory = (name) => {
      const sev = gateOptions[name]?.severity;
      return sev === 'MED' || sev === 'LOW';
    };
    flat._advisoryMap = {}; // lazy-evaluated per gate via this._gates._advisoryMap
    for (const name of ['lintPassRate', 'cveAuditGate', 'noHardcodedSecrets', 'noCircularDep', 'interfaceValid', 'integrationCoverage', 'allAcVerified', 'allReqCovered']) {
      flat._severityMap = flat._severityMap || {};
      flat._severityMap[name] = gateOptions[name]?.severity || 'HIGH';
    }
    return flat;
  }

  _isGateEnabled(name) {
    const opt = this._gateOptions?.[name];
    return !opt || opt.enabled !== false;
  }

  /**
   * Get current gate mode
   */
  getMode() {
    return this._gateMode;
  }

  /**
   * Set gate mode
   * @param {string} mode - 'default' or 'diagnostic'
   */
  setMode(mode) {
    if (!Object.values(GATE_CONFIG_MODE).includes(mode)) {
      throw new Error(`[QualityGate] Invalid gate mode: ${mode}`);
    }
    const oldMode = this._gateMode;
    this._gateMode = mode;
    console.log(`[QualityGate] Mode changed: ${oldMode} -> ${mode}`);
  }

  /**
   * Auto-switch mode based on diagnostic history
   * Returns true if mode was changed
   */
  autoSwitchMode() {
    if (this._gateMode !== GATE_CONFIG_MODE.DIAGNOSTIC_ONLY) {
      return false;
    }

    if (this._diagnosticHistory.length < this._minDiagnosticSamples) {
      return false;
    }

    // Calculate failure rate
    const failures = this._diagnosticHistory.filter(d => !d.passed).length;
    const failureRate = failures / this._diagnosticHistory.length;

    // If failure rate is stable (< 30%), switch to default mode
    if (failureRate < 0.3) {
      this.setMode(GATE_CONFIG_MODE.DEFAULT);
      console.log(`[QualityGate] Auto-switched to default mode after ${this._diagnosticHistory.length} samples (failure rate: ${(failureRate * 100).toFixed(1)}%)`);
      return true;
    }

    return false;
  }

  /**
   * Validates a completed workflow run against quality gates.
   *
   * @param {object} metrics - From Observability.flush()
   * @returns {{ passed: boolean, gates: Array<{ name: string, passed: boolean, actual: any, threshold: any, message: string }>, reflections: object[], mode: string }}
   */
  validate(metrics) {
    return this._validateInternal(metrics, this._gates, 'FULL');
  }

  /**
   * Validates a specific stage against stage-specific quality gates.
   * P0-Enhancement: Stage-embedded validation for early error detection.
   *
   * @param {string} stageName - Stage identifier (ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST)
   * @param {object} metrics - Current stage metrics
   * @param {object} [context] - Additional context for diagnostics
   * @returns {{ passed: boolean, gates: Array, reflections: object[], diagnostics: object, mode: string }}
   */
  validateStage(stageName, metrics, context = {}) {
    const stageGates = STAGE_QUALITY_GATES[stageName] || this._gates;
    const mergedGates = { ...this._gates, ...stageGates };
    return this._validateInternal(metrics, mergedGates, stageName, context);
  }

  /**
   * Internal validation implementation.
   * @private
   */
  _validateInternal(metrics, gateConfig, validationType, stageContext) {
    if (!metrics) return { passed: true, gates: [], reflections: [], diagnostics: null, mode: this._gateMode };

    const gates = [];
    const reflections = [];
    const g = gateConfig;
    const eng = new GateEngine();

    // Gate 1: Error count (→ GateEngine, config threshold override)
    const errorCount = metrics.errors?.count || 0;
    const errCheck = eng.checkErrorCount(errorCount, validationType, g.maxErrorCount);
    gates.push({
      name: 'maxErrorCount',
      passed: errCheck.pass,
      actual: errCheck.actual,
      threshold: errCheck.threshold,
      message: errCheck.reason || `Error count within limit`,
    });

    // Gate 2: Test pass rate (→ GateEngine)
    if (metrics.testResult) {
      const { passed: tp = 0, failed: tf = 0 } = metrics.testResult;
      const total = tp + tf;
      const passRate = total > 0 ? tp / total : 1;
      const tpCheck = eng.checkTestPassRate(passRate, g.minTestPassRate);
      gates.push({
        name: 'minTestPassRate',
        passed: tpCheck.pass,
        actual: `${(passRate * 100).toFixed(0)}%`,
        threshold: `${Math.round(tpCheck.threshold * 100)}%`,
        message: tpCheck.reason || `Test pass rate ${tpCheck.pass ? 'OK' : 'too low'}`,
      });
    }

    // Gate 3: Duration (→ GateEngine, config threshold override)
    const duration = metrics.totalDurationMs || 0;
    const durCheck = eng.checkDuration(duration, validationType, g.maxDurationMs);
    gates.push({
      name: 'maxDurationMs',
      passed: durCheck.pass,
      actual: `${(duration / 1000).toFixed(1)}s`,
      threshold: durCheck.threshold != null ? `${Math.round(durCheck.threshold / 1000)}s` : `${(g.maxDurationMs / 1000).toFixed(1)}s`,
      message: durCheck.reason || `Duration within limit`,
    });

    // Gate 4: LLM call count (→ GateEngine, config threshold override)
    const llmCalls = metrics.llm?.totalCalls || 0;
    const llmCheck = eng.checkLlmCalls(llmCalls, validationType, g.maxLlmCalls);
    gates.push({
      name: 'maxLlmCalls',
      passed: llmCheck.pass,
      actual: llmCheck.actual,
      threshold: llmCheck.threshold,
      message: llmCheck.reason || `LLM call count ${llmCheck.pass ? 'OK' : 'too high'}`,
    });

    // Gate 5: Token waste ratio (→ GateEngine)
    if (metrics.blockTelemetry?.summary) {
      const { totalInjected = 0, totalDropped = 0 } = metrics.blockTelemetry.summary;
      const wasteRatio = totalInjected > 0 ? totalDropped / totalInjected : 0;
      const twCheck = eng.checkTokenWasteRatio(wasteRatio, g.maxTokenWasteRatio);
      gates.push({
        name: 'maxTokenWasteRatio',
        passed: twCheck.pass,
        actual: `${(wasteRatio * 100).toFixed(0)}%`,
        threshold: `${Math.round(twCheck.threshold * 100)}%`,
        message: twCheck.reason || `Token waste ${twCheck.pass ? 'OK' : 'too high'}`,
      });
    }

    // Gate 5.5: Quarantine ratio (Knowledge Safety Guard)
    // Advisory-only: warns if quarantined experiences exceed threshold.
    const quarantineThreshold = gateConfig.quarantineThreshold ?? 0.05;
    if (this._experienceStore && typeof this._experienceStore.getAll === 'function') {
      try {
        const allExps = this._experienceStore.getAll();
        const total = allExps.length;
        const quarantined = allExps.filter(e => e.safetyStatus === 'quarantine').length;
        const ratio = total > 0 ? quarantined / total : 0;
        gates.push({
          name: 'quarantineRatio',
          passed: ratio <= quarantineThreshold,
          advisory: true,
          actual: `${(ratio * 100).toFixed(1)}% (${quarantined}/${total})`,
          threshold: `${(quarantineThreshold * 100).toFixed(0)}%`,
          message: ratio <= quarantineThreshold
            ? `Quarantine ratio OK (${(ratio * 100).toFixed(1)}% ≤ ${(quarantineThreshold * 100).toFixed(0)}%)`
            : `Quarantine ratio elevated (${(ratio * 100).toFixed(1)}% > ${(quarantineThreshold * 100).toFixed(0)}%) — review quarantined experiences`,
        });
      } catch (_) {
        // Non-blocking: skip if experience store unavailable
      }
    }

    // Gate 5.6: Skill compliance score (→ GateEngine.checkComplianceScore)
    const complianceReport = metrics.skillCompliance || QualityGate._loadSkillComplianceReport(metrics.projectRoot);
    if (complianceReport && Number.isFinite(Number(complianceReport.overallScore))) {
      const complianceScore = Number(complianceReport.overallScore);
      const minCompliance = Number.isFinite(Number(g.minComplianceScore)) ? Number(g.minComplianceScore) : 0.8;
      const complianceMode = complianceReport.mode || 'audit';
      const csCheck = eng.checkComplianceScore(complianceScore, minCompliance);
      gates.push({
        name: 'minComplianceScore',
        passed: csCheck.pass,
        advisory: complianceMode !== 'enforce',
        actual: `${(complianceScore * 100).toFixed(1)}%`,
        threshold: `${(minCompliance * 100).toFixed(1)}%`,
        message: csCheck.reason || `Skill compliance ${csCheck.pass ? 'OK' : 'below threshold'} (mode=${complianceMode})`,
      });
    }

    // Gate 6: File size compliance — advisory (legacy/stock files)
    // Uses _checkFileSizeCompliance for directory-specific rules (core=400, agents=300, etc.)
    // GateEngine.checkFileSize uses flat 900 — too loose for project conventions.
    if (metrics.projectRoot) {
      const allViolations = QualityGate._checkFileSizeCompliance(metrics.projectRoot);
      const fileSizePassed = allViolations.length === 0;
      gates.push({
        name: 'fileSizeCompliance',
        passed: fileSizePassed,
        advisory: true,
        actual: fileSizePassed ? '0 violations' : `${allViolations.length} file(s) over limit`,
        threshold: '0 violations',
        message: fileSizePassed
          ? 'All files within architecture line-count limits'
          : `File size violations (advisory): ${allViolations.map(v => `${v.file} (${v.lines}/${v.limit})`).join(', ')}`,
      });

      // Gate 6b: File size compliance — strict (modified files only)
      if (Array.isArray(metrics.modifiedFiles) && metrics.modifiedFiles.length > 0) {
        const modifiedViolations = QualityGate._checkFileSizeCompliance(metrics.projectRoot, metrics.modifiedFiles);
        const modifiedPassed = modifiedViolations.length === 0;
        gates.push({
          name: 'fileSizeCompliance_modified',
          passed: modifiedPassed,
          actual: modifiedPassed ? '0 violations' : `${modifiedViolations.length} modified file(s) over limit`,
          threshold: '0 violations',
          message: modifiedPassed
            ? 'All modified files within architecture line-count limits'
            : `Modified file size violations: ${modifiedViolations.map(v => `${v.file} (${v.lines}/${v.limit})`).join(', ')}`,
        });
      }
    }

    // Gate 7: Task completion — all T-N tasks must be done before TEST
    // Reads output/task-status.json. 'partial' status (subtasks partially done) is non-blocking.
    try {
      const statusPath = path.join(metrics.projectRoot || '.', 'output', 'task-status.json');
      if (fs.existsSync(statusPath)) {
        const tasks = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        if (Array.isArray(tasks) && tasks.length > 0) {
          const failed = tasks.filter(t => t.status === 'failed');
          const partial = tasks.filter(t => t.status === 'partial');
          const done = tasks.filter(t => t.status === 'done');
          const allDone = failed.length === 0;
          const summary = `${done.length}/${tasks.length} done` + (partial.length > 0 ? `, ${partial.length} partial` : '') + (failed.length > 0 ? `, ${failed.length} failed` : '');
          gates.push({
            name: 'allTasksComplete',
            passed: allDone,
            actual: allDone ? summary : `${failed.map(t => t.id).join(', ')} failed (${summary})`,
            threshold: 'no failed tasks (partial OK)',
            message: allDone
              ? `All tasks completed or partially done (${summary})`
              : `${failed.length}/${tasks.length} task(s) FAILED: ${failed.map(t => t.id).join(', ')}`,
          });
        }
      }
    } catch (_) { /* task-status.json missing or corrupt — skip gate */ }

    // Gate 8: Requirements check completion — all HIGH CHKs must pass before TEST succeeds
    // Reads test-report.md to find CHK status table
    try {
      const statusPath = path.join(metrics.projectRoot || '.', 'output', 'test-report.md');
      if (fs.existsSync(statusPath)) {
        const report = fs.readFileSync(statusPath, 'utf-8');
        // Match CHK status rows: | CHK-1.1 | ... | ✅ PASS or ❌ FAIL |
        const highFailMatches = report.match(/\| CHK-[\d.]+ \|.*\| (?:HIGH) \|.*\| ❌ FAIL/gi);
        const highPassMatches = report.match(/\| CHK-[\d.]+ \|.*\| (?:HIGH) \|.*\| ✅ PASS/gi);
        const highTotal = (highPassMatches?.length || 0) + (highFailMatches?.length || 0);
        if (highTotal > 0) {
          const highFailed = highFailMatches?.length || 0;
          const allPassed = highFailed === 0;
          gates.push({
            name: 'allChecksPassed',
            passed: allPassed,
            actual: allPassed ? `${highTotal}/${highTotal} HIGH CHKs passed` : `${highTotal - highFailed}/${highTotal} HIGH CHKs passed (${highFailed} FAILED)`,
            threshold: 'all HIGH CHKs must pass',
            message: allPassed
              ? `All ${highTotal} HIGH-priority check(s) passed`
              : `${highFailed} HIGH-priority check(s) FAILED — TEST cannot complete`,
          });
        }
      }
    } catch (_) { /* test-report.md missing or corrupt — skip gate */ }

    // ═══════════════════════════════════════════════════════════════════════
    //  NEW GATES: 功能完整性 + 代码质量 + 整合度
    // ═══════════════════════════════════════════════════════════════════════

    // Gate 9: allAcVerified — all ACs must be covered by at least one task
    try {
      const statusPath2 = path.join(metrics.projectRoot || '.', 'output', 'task-status.json');
      const planPath2 = path.join(metrics.projectRoot || '.', 'output', 'execution-plan.md');
      if (fs.existsSync(statusPath2) && fs.existsSync(planPath2)) {
        const taskStatus = JSON.parse(fs.readFileSync(statusPath2, 'utf-8'));
        const planContent = fs.readFileSync(planPath2, 'utf-8');
        const jsonMatch = planContent.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch && Array.isArray(taskStatus)) {
          const planJson = JSON.parse(jsonMatch[1]);
          const adrLinkage = planJson.adrTaskLinkage;
          if (this._isGateEnabled('allAcVerified') && adrLinkage && Array.isArray(adrLinkage.links)) {
            const taskStatusMap = {};
            for (const ts of taskStatus) taskStatusMap[ts.id] = ts.status || 'unknown';
            const acceptable = status => status === 'done' || status === 'partial';
            const linkedAcIds = new Set();
            const uncovered = [];
            for (const link of adrLinkage.links) {
              const acIds = Array.isArray(link.acIds) && link.acIds.length > 0
                ? link.acIds
                : (/^AC-\d{3,}$/i.test(String(link.reqId)) ? [link.reqId] : []);
              acIds.forEach(ac => linkedAcIds.add(String(ac).toUpperCase()));
              const allCovered = (link.taskIds || []).every(tid => acceptable(taskStatusMap[tid]));
              if (acIds.length > 0 && !allCovered) uncovered.push({ reqId: link.reqId, taskIds: link.taskIds, acs: acIds.join(',') });
            }
            let totalAcCount = linkedAcIds.size;
            try {
              const tracePath = path.join(metrics.projectRoot || '.', 'output', 'requirement-traceability.json');
              if (fs.existsSync(tracePath)) {
                const trace = JSON.parse(fs.readFileSync(tracePath, 'utf-8'));
                const traceAcs = new Set();
                for (const req of (trace.requirements || [])) {
                  for (const ac of (req.acceptanceCriteria || [])) traceAcs.add(String(ac.id || ac).toUpperCase());
                }
                for (const ac of traceAcs) if (!linkedAcIds.has(ac)) uncovered.push({ reqId: ac, taskIds: [], acs: ac });
                totalAcCount = traceAcs.size || totalAcCount;
              }
            } catch (_) { /* optional traceability check */ }
            const passed = uncovered.length === 0;
            gates.push({
              name: 'allAcVerified',
              passed,
              actual: passed ? `${totalAcCount} ACs covered` : `${uncovered.length}/${Math.max(totalAcCount, linkedAcIds.size)} AC(s) uncovered or incomplete`,
              threshold: 'all ACs must map to done/partial tasks',
              message: passed
                ? `All acceptance criteria are mapped to completed or partial-accepted tasks`
                : `Uncovered/incomplete ACs: ${uncovered.map(u => `${u.reqId}(${u.acs})`).join(', ')}`,
            });
          }
        }
      }
    } catch (_) { /* skip gate if data missing */ }

    // Gate 10: allReqCovered — every REQ in adrTaskLinkage must have completed tasks
    try {
      const statusPath3 = path.join(metrics.projectRoot || '.', 'output', 'task-status.json');
      const planPath3 = path.join(metrics.projectRoot || '.', 'output', 'execution-plan.md');
      if (fs.existsSync(statusPath3) && fs.existsSync(planPath3)) {
        const taskStatus = JSON.parse(fs.readFileSync(statusPath3, 'utf-8'));
        const planContent = fs.readFileSync(planPath3, 'utf-8');
        const jsonMatch = planContent.match(/```json\s*([\s\S]*?)```/);
        if (jsonMatch && Array.isArray(taskStatus)) {
          const planJson = JSON.parse(jsonMatch[1]);
          const adrLinkage = planJson.adrTaskLinkage;
          if (this._isGateEnabled('allReqCovered') && adrLinkage && Array.isArray(adrLinkage.links)) {
            const taskStatusMap = {};
            for (const ts of taskStatus) taskStatusMap[ts.id] = ts.status || 'unknown';
            const acceptable = status => status === 'done' || status === 'partial';
            const allReqIds = new Set(adrLinkage.links.map(l => String(l.reqId).toUpperCase()).filter(id => /^REQ-\d{3,}$/i.test(id)));
            const uncoveredReqs = [];
            for (const reqId of allReqIds) {
              const links = adrLinkage.links.filter(l => String(l.reqId).toUpperCase() === reqId);
              const allCovered = links.every(l => (l.taskIds || []).every(tid => acceptable(taskStatusMap[tid])));
              if (!allCovered) uncoveredReqs.push(reqId);
            }
            const passed = uncoveredReqs.length === 0;
            gates.push({
              name: 'allReqCovered',
              passed,
              actual: passed ? `${allReqIds.size} REQs covered` : `${uncoveredReqs.length}/${allReqIds.size} REQs uncovered`,
              threshold: 'all REQs must map to done/partial tasks',
              message: passed
                ? `All ${allReqIds.size} requirements covered by completed or partial-accepted tasks`
                : `Uncovered requirements: ${uncoveredReqs.join(', ')}`,
            });
          }
        }
      }
    } catch (_) { /* skip gate if data missing */ }

    // Gate 11: lintPassRate (→ GateEngine)
    if (this._isGateEnabled('lintPassRate') && metrics.lint && Number.isFinite(metrics.lint.passRate)) {
      const minLintRate = gateConfig.minLintPassRate ?? 0.80;
      const lintCheck = eng.checkLintPassRate(metrics.lint.passRate, minLintRate);
      gates.push({
        name: 'lintPassRate',
        passed: lintCheck.pass,
        actual: `${(metrics.lint.passRate * 100).toFixed(0)}% (${metrics.lint.passed || 0}/${(metrics.lint.total || 0)})`,
        threshold: `${Math.round(lintCheck.threshold * 100)}%`,
        message: lintCheck.reason || `Lint pass rate ${lintCheck.pass ? 'OK' : 'too low'}`,
      });
    }

    // Gate 12: cveAuditGate (→ GateEngine)
    if (this._isGateEnabled('cveAuditGate') && metrics.cve) {
      const criticalCount = metrics.cve.critical || 0;
      const highCount = metrics.cve.high || 0;
      const maxCritical = Number.isFinite(Number(g.maxCriticalCves)) ? Number(g.maxCriticalCves) : 0;
      const cveCheck = eng.checkCriticalCves(Array.from({length: criticalCount}, (_, i) => ({id: `cve-${i}`})), maxCritical);
      gates.push({
        name: 'cveAuditGate',
        passed: cveCheck.pass,
        actual: `${criticalCount} CRITICAL, ${highCount} HIGH`,
        threshold: `${maxCritical} CRITICAL CVEs`,
        message: cveCheck.reason || `CVE audit ${cveCheck.pass ? 'OK' : 'failed'}`,
      });
    }

    // Gate 13: noHardcodedSecrets — no hardcoded secrets in modified files
    if (this._isGateEnabled('noHardcodedSecrets') && metrics.secrets) {
      const secretCount = metrics.secrets.violations || 0;
      const passed = secretCount === 0;
      gates.push({
        name: 'noHardcodedSecrets',
        passed,
        actual: secretCount > 0 ? `${secretCount} violation(s): ${(metrics.secrets.details || []).slice(0, 3).join(', ')}` : '0 violations',
        threshold: '0 hardcoded secrets',
        message: passed
          ? 'No hardcoded secrets detected'
          : `${secretCount} hardcoded secret(s) detected — remove before proceeding`,
      });
    }

    // Gate 14: noCircularDep — no circular dependencies introduced
    if (this._isGateEnabled('noCircularDep') && metrics.deps) {
      const hasCircular = metrics.deps.hasCircular || false;
      const cycles = metrics.deps.cycles || [];
      const passed = !hasCircular;
      gates.push({
        name: 'noCircularDep',
        passed,
        actual: hasCircular ? `${cycles.length} cycle(s): ${cycles.slice(0, 3).map(c => c.path.join('→')).join('; ')}` : '0 cycles',
        threshold: '0 circular dependencies',
        message: passed
          ? 'No circular dependencies detected in modified files'
          : `${cycles.length} circular dependency cycle(s) detected — refactor to break cycles`,
      });
    }

    // Gate 15: interfaceValid — module interface contract self-consistency
    // advisory-only: interface design is a creative process, gate warns but doesn't block
    if (this._isGateEnabled('interfaceValid') && metrics.interfaces) {
      const violations = metrics.interfaces.violations || 0;
      const passed = violations === 0;
      gates.push({
        name: 'interfaceValid',
        passed,
        advisory: true,
        actual: violations > 0 ? `${violations} violation(s)` : '0 violations',
        threshold: '0 contract violations',
        message: passed
          ? 'Module interface contracts are self-consistent'
          : `${violations} interface contract violation(s) detected — review before proceeding`,
      });
    }

    // Gate 16: integrationCoverage (→ GateEngine)
    if (this._isGateEnabled('integrationCoverage') && metrics.coverage) {
      const integrationTests = metrics.coverage.integration || 0;
      const minTests = gateConfig.minIntegrationTests ?? 1;
      const intCheck = eng.checkIntegrationTests(integrationTests, minTests);
      gates.push({
        name: 'integrationCoverage',
        passed: intCheck.pass,
        actual: `${integrationTests} integration test(s)`,
        threshold: `≥${minTests} integration test(s)`,
        advisory: true,
        message: intCheck.reason || `Integration test coverage ${intCheck.pass ? 'OK' : 'insufficient'}`,
      });
    }

    // Gate 17: Ephemeral file count — advisory warning
    // Detected by EPHEMERAL_FILE_GUARD in stage-executor.js via git ls-files --others
    // Primary source: context.orchestrator._ephemeralFileWarnings (in-process)
    // Fallback: output/ephemeral-warnings.json (cross-process, e.g. bridge calls)
    let ephemeralWarnings = stageContext?.orchestrator?._ephemeralFileWarnings || [];
    if (ephemeralWarnings.length === 0) {
      try {
        const warnPath = path.join(metrics.projectRoot || '.', 'output', 'ephemeral-warnings.json');
        if (fs.existsSync(warnPath)) {
          const persisted = JSON.parse(fs.readFileSync(warnPath, 'utf-8'));
          ephemeralWarnings = persisted.warnings || [];
        }
      } catch (_) { /* non-blocking */ }
    }
    if (ephemeralWarnings.length > 3) {
      gates.push({
        name: 'maxEphemeralFiles',
        passed: false,
        advisory: true,
        actual: `${ephemeralWarnings.length} temp file(s)`,
        threshold: '≤3 temp files',
        message: `${ephemeralWarnings.length} ephemeral file(s) detected across ${new Set(ephemeralWarnings.map(w => w.stage)).size} stage(s). Consider using node -e "..." for one-off checks.`,
      });
    }

    // ─── Consolidated: GateEngine.runAllChecks() summary ────────────────────────
    // Adds a single consolidated result for all numerical checks.
    // This is the unified entry point for GateEngine's batch API.
    const runAllResult = eng.runAllChecks({
      lintPassRate: metrics.lint != null && Number.isFinite(metrics.lint.passRate) ? metrics.lint.passRate : undefined,
      testPassRate: metrics.testResult ? (() => { const t=metrics.testResult; const total=t.passed+t.failed; return total>0 ? t.passed/total : 1; })() : undefined,
      criticalCves: metrics.cve ? Array(metrics.cve.critical || 0).fill({id:'cve'}) : undefined,
      syntaxErrors: metrics.syntax?.errors || undefined,
      modifiedFiles: metrics.modifiedFiles ? metrics.modifiedFiles.map(f => ({path:f, lines:0})) : undefined,
      errorCount: metrics.errors?.count || 0,
      llmCallCount: metrics.llm?.totalCalls || 0,
      durationMs: metrics.totalDurationMs || 0,
      tokenWasteRatio: metrics.blockTelemetry?.summary ? (() => { const s=metrics.blockTelemetry.summary; return s.totalInjected>0 ? s.totalDropped/s.totalInjected : 0; })() : undefined,
      integrationTests: metrics.coverage?.integration || undefined,
    });
    gates.push({
      name: 'numericalGates',
      passed: runAllResult.passed,
      actual: `${runAllResult.checks.filter(c => c.pass).length}/${runAllResult.checks.length} passed`,
      threshold: 'All numerical checks pass',
      message: runAllResult.summary,
    });

    // ─── EvoSkill: Diagnostic Mode Handling ─────────────────────────────────────
    // In diagnostic mode: record metrics but don't propagate to skill evolution

    const failedGates = gates.filter(gt => !gt.passed && !gt.advisory);

    if (this._gateMode === GATE_CONFIG_MODE.DIAGNOSTIC_ONLY) {
      // Record diagnostic entry
      const diagnosticEntry = {
        timestamp: new Date().toISOString(),
        validationType,
        passed: failedGates.length === 0,
        gates: gates.map(g => ({
          name: g.name,
          passed: g.passed,
          actual: g.actual,
          threshold: g.threshold,
        })),
        metrics: this._sanitizeMetrics(metrics),
      };

      this._diagnosticHistory.push(diagnosticEntry);
      if (this._diagnosticHistory.length > this._maxDiagnosticHistory) {
        this._diagnosticHistory.shift(); // FIFO
      }

      // Log but don't create reflections
      if (failedGates.length > 0) {
        console.warn(`[QualityGate:DIAGNOSTIC] Gates failed (NOT propagated to skills): ${failedGates.map(g => g.name).join(', ')}`);
      } else {
        console.log(`[QualityGate:DIAGNOSTIC] All gates passed (${gates.length} checks)`);
      }

      // Check if should auto-switch mode
      this.autoSwitchMode();

      return {
        passed: failedGates.length === 0,
        gates,
        reflections: [], // No reflections in diagnostic mode
        diagnostics: { failedGates, mode: 'diagnostic' },
        mode: this._gateMode,
      };
    }

    // ─── Default Mode: Record reflections for skill evolution ───────────────────

    const diagnostics = { failedGates: [], recommendations: [] };

    for (const fg of failedGates) {
      const diagnostic = this._buildDiagnostic(fg, validationType, stageContext);
      fg.diagnostic = diagnostic;

      reflections.push(this._recordIssue({
        type: ReflectionType.QUALITY_GATE_FAIL,
        severity: fg.name === 'maxErrorCount' || fg.name === 'minTestPassRate'
          ? ReflectionSeverity.HIGH
          : ReflectionSeverity.MEDIUM,
        title: `Quality gate breached: ${fg.name}`,
        description: `${fg.message}\n\n\ud83d\udd27 Diagnostic: ${diagnostic.summary}\n\ud83d\udca1 Recommendation: ${diagnostic.recommendation}`,
        source: validationType === 'FULL' ? 'gating:validateRun' : `gating:validateStage:${validationType}`,
        patternKey: `gate-fail:${fg.name}`,
        metrics: { actual: fg.actual, threshold: fg.threshold, stage: validationType },
        rootCause: diagnostic.rootCause,
        suggestedFix: diagnostic.recommendation,
      }));

      diagnostics.failedGates.push(fg);
      diagnostics.recommendations.push(diagnostic);
    }

    const passed = failedGates.length === 0;
    if (passed) {
      this._consecutiveFailures = 0; // Reset on success
      if (validationType === 'FULL') {
        console.log(`[QualityGate] ✅ All ${gates.length} quality gates passed.`);
      } else {
        console.log(`[QualityGate:${validationType}] ✅ Stage gates passed (${gates.length} checks)`);
      }
    } else {      if (validationType === 'FULL') {
        console.warn(`[QualityGate] \u274c ${failedGates.length} of ${gates.length} quality gates failed: [${failedGates.map(gt => gt.name).join(', ')}]`);
      } else {
        console.warn(`[QualityGate:${validationType}] \u26a0\ufe0f Stage validation failed: ${failedGates.map(gt => `${gt.name}(${gt.actual}/${gt.threshold})`).join(', ')}`);
      }

      // LLM root-cause analysis for failed gates (non-blocking, non-fatal)
      if (this._cheapLlmCall && (validationType === 'FULL' || failedGates.some(fg => fg.name === 'maxErrorCount'))) {
        this._analyzeFailedGates(failedGates, metrics).catch(err => {
          console.warn(`[QualityGate] \u26a0\ufe0f  LLM root-cause analysis failed (non-fatal): ${err.message}`);
        });
      }

      // MAPE: Trigger self-healing on continuous degradation
      this._consecutiveFailures++;
      if (this._shouldTriggerMape(validationType, failedGates)) {
        this._triggerMapeCycle(validationType, failedGates, metrics, reflections).catch(err => {
          console.warn(`[QualityGate] ⚠️  MAPE trigger failed (non-fatal): ${err.message}`);
        });
      }
    }
    return {
      passed,
      gates,
      reflections,
      diagnostics: diagnostics.recommendations.length > 0 ? diagnostics : null,
      mode: this._gateMode,
    };
  }

  /**
   * Determines if MAPE self-healing should be triggered.
   * Triggers when:
   * 1. Consecutive failures >= threshold
   * 2. Cooldown period has passed
   * 3. This is a full validation (not stage-level)
   * 4. Critical gates failed (error count or test pass rate)
   *
   * @private
   */
  _shouldTriggerMape(validationType, failedGates) {
    if (!this._onDegradationDetected) return false;
    if (this._consecutiveFailures < this._mapeTriggerThreshold) return false;
    if (validationType !== 'FULL') return false;

    const now = Date.now();
    if (now - this._lastMapeTrigger < this._mapeCooldownMs) return false;

    // Only trigger on critical failures
    const criticalGates = ['maxErrorCount', 'minTestPassRate', 'maxDurationMs'];
    const hasCriticalFailure = failedGates.some(fg => criticalGates.includes(fg.name));
    return hasCriticalFailure;
  }

  /**
   * Triggers the MAPE self-healing cycle.
   * @private
   */
  async _triggerMapeCycle(validationType, failedGates, metrics, reflections) {
    this._lastMapeTrigger = Date.now();
    console.log(`[QualityGate] \ud83d\udea8 Continuous degradation detected (${this._consecutiveFailures} failures). Triggering MAPE self-healing...`);

    const degradationInfo = {
      timestamp: new Date().toISOString(),
      consecutiveFailures: this._consecutiveFailures,
      failedGates: failedGates.map(fg => ({
        name: fg.name,
        actual: fg.actual,
        threshold: fg.threshold,
        message: fg.message,
        rootCauseAnalysis: fg.rootCauseAnalysis,
      })),
      metrics: this._sanitizeMetrics(metrics),
      reflections: reflections.slice(0, 10), // Cap to prevent bloat
      diagnosticHistory: this._diagnosticHistory.slice(-20),
    };

    try {
      await this._onDegradationDetected(degradationInfo);
      console.log(`[QualityGate] \u2705 MAPE self-healing cycle completed`);
      // Reset counter after successful MAPE cycle
      this._consecutiveFailures = 0;
    } catch (err) {
      console.error(`[QualityGate] \u274c MAPE self-healing failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Sanitize metrics for storage (remove sensitive data)
   * @private
   */
  _sanitizeMetrics(metrics) {
    // Return a safe subset of metrics
    return {
      duration: metrics.totalDurationMs,
      errorCount: metrics.errors?.count,
      llmCalls: metrics.llm?.totalCalls,
      testPassRate: metrics.testResult ?
        (metrics.testResult.passed / (metrics.testResult.passed + metrics.testResult.failed || 1)) : null,
      hasBlockTelemetry: !!metrics.blockTelemetry,
    };
  }

  // ─── EvoSkill: Diagnostic Mode Exports ──────────────────────────────────────

  /**
   * Export diagnostic history for analysis.
   * Used to understand failure patterns before switching to default mode.
   *
   * @returns {{ mode: string, history: Array, stats: object }}
   */
  exportDiagnostics() {
    const history = [...this._diagnosticHistory];
    const failures = history.filter(d => !d.passed).length;

    return {
      mode: this._gateMode,
      historyLength: history.length,
      failureRate: history.length > 0 ? failures / history.length : 0,
      history: history.slice(-20), // Last 20 entries
      stats: {
        totalRuns: history.length,
        passedRuns: history.length - failures,
        failedRuns: failures,
        byGate: this._aggregateGateFailures(history),
      },
    };
  }

  /**
   * Get raw diagnostic history (for advanced analysis)
   * @returns {Array}
   */
  getDiagnosticHistory() {
    return [...this._diagnosticHistory];
  }

  /**
   * Clear diagnostic history
   */
  clearDiagnosticHistory() {
    this._diagnosticHistory = [];
  }

  /**
   * Aggregate gate failure statistics
   * @private
   */
  _aggregateGateFailures(history) {
    const gateFailures = {};
    for (const entry of history) {
      if (!entry.passed && entry.gates) {
        for (const gate of entry.gates) {
          if (!gate.passed) {
            gateFailures[gate.name] = (gateFailures[gate.name] || 0) + 1;
          }
        }
      }
    }
    return gateFailures;
  }

  /**
   * Uses cheap LLM to analyze failed quality gates and generate root-cause diagnosis.
   * Results are appended to the gate objects as `rootCauseAnalysis` property.
   *
   * Cost: ~$0.003/call (GPT-4o-mini / Gemini Flash tier)
   * Non-blocking: runs async, does not delay the workflow.
   *
   * @param {object[]} failedGates - Array of failed gate objects
   * @param {object}   metrics     - Run metrics for context
   * @returns {Promise<void>}
   * @private
   */
  async _analyzeFailedGates(failedGates, metrics) {
    const gatesSummary = failedGates.map(fg =>
      `- ${fg.name}: ${fg.message} (actual: ${fg.actual}, threshold: ${fg.threshold})`
    ).join('\n');

    // Build concise context from metrics
    const contextParts = [
      metrics.totalDurationMs ? `Duration: ${(metrics.totalDurationMs / 1000).toFixed(1)}s` : null,
      metrics.errors?.count ? `Errors: ${metrics.errors.count}` : null,
      metrics.llm?.totalCalls ? `LLM calls: ${metrics.llm.totalCalls}` : null,
      metrics.stageResults ? `Stages: ${Object.entries(metrics.stageResults).map(([k, v]) => `${k}=${v}`).join(', ')}` : null,
    ].filter(Boolean).join(' | ');

    const prompt = `You are a workflow quality engineer. Analyze these failed quality gates and provide a concise root-cause diagnosis with actionable fix suggestions.

Failed Gates:
${gatesSummary}

Run Context: ${contextParts || 'No additional context'}

For each failed gate, provide:
1. Most likely root cause (1 sentence)
2. Immediate fix action (1 sentence)
3. Prevention strategy (1 sentence)

Keep total output under 500 characters. Be specific and actionable.`;

    const analysis = await this._cheapLlmCall(prepareGatewayPrompt(this, {
      callSite: 'workflow/core/quality-gate.js:analyzeFailures',
      role: 'quality-gate',
      stage: stage || 'QUALITY',
      runtimePrompt: prompt,
      metadata: { category: 'llm-lite-call', failedGateCount: failedGates.length },
    }));
    if (analysis && analysis.trim().length > 20) {
      // Attach analysis to each failed gate for downstream consumers
      for (const fg of failedGates) {
        fg.rootCauseAnalysis = analysis.trim();
      }
      console.log(`[QualityGate] 🤖 LLM root-cause analysis complete (${analysis.trim().length} chars).`);
    }
  }

  /**
   * Builds structured diagnostic information for a failed gate.
   * @private
   */
  _buildDiagnostic(failedGate, stage, context) {
    const { name, actual, threshold } = failedGate;
    const diagnostic = {
      gate: name,
      stage: stage,
      summary: '',
      rootCause: '',
      recommendation: '',
      severity: 'medium',
    };

    switch (name) {
      case 'maxErrorCount':
        diagnostic.summary = `Error threshold exceeded (${actual} > ${threshold})`;
        diagnostic.rootCause = stage === 'DEVELOP'
          ? 'Code generation produced compilation/runtime errors or test failures'
          : 'Stage execution encountered unhandled exceptions or validation failures';
        diagnostic.recommendation = stage === 'DEVELOP'
          ? 'Review error logs, fix syntax/runtime errors, ensure test assertions pass'
          : 'Check stage logs for exception stack traces, verify input data validity';
        diagnostic.severity = 'high';
        break;

      case 'minTestPassRate':
        diagnostic.summary = `Test pass rate below threshold (${actual} < ${threshold})`;
        diagnostic.rootCause = 'Generated code does not satisfy test requirements or tests are incorrect';
        diagnostic.recommendation = 'Review failed test cases, debug implementation, ensure requirements alignment';
        diagnostic.severity = 'high';
        break;

      case 'maxDurationMs':
        diagnostic.summary = `Stage timeout (${actual} > ${threshold})`;
        diagnostic.rootCause = stage === 'DEVELOP'
          ? 'Code generation exceeded time budget - possible infinite loop or excessive complexity'
          : 'Stage processing took longer than expected - possible large input or inefficient algorithm';
        diagnostic.recommendation = stage === 'DEVELOP'
          ? 'Break implementation into smaller chunks, optimize hot paths, add early exit conditions'
          : 'Optimize stage algorithm, implement progress checkpoints, consider batch processing';
        break;

      case 'maxLlmCalls':
        diagnostic.summary = `LLM call limit exceeded (${actual} > ${threshold})`;
        diagnostic.rootCause = 'Excessive retries or recursive LLM calls detected - possible retry loop';
        diagnostic.recommendation = 'Review retry logic, implement exponential backoff, set max retry limits, check for circular dependencies in reasoning';
        break;

      case 'maxTokenWasteRatio':
        diagnostic.summary = `Token waste ratio high (${actual} > ${threshold})`;
        diagnostic.rootCause = 'Many context blocks were injected then dropped - context selection may be inefficient';
        diagnostic.recommendation = 'Optimize context selection strategy, reduce context window size, use more targeted block selection';
        break;

      default:
        diagnostic.summary = `Gate ${name} failed (${actual} vs threshold ${threshold})`;
        diagnostic.rootCause = `Metric ${name} did not meet quality criteria`;
        diagnostic.recommendation = 'Review metrics and adjust thresholds or improve implementation';
    }

    // Add stage-specific context if available
    if (context && context.component) {
      diagnostic.recommendation += `\n[Context: Component ${context.component}]`;
    }

    return diagnostic;
  }

  // ─── Skill Compliance Report Loader ───────────────────────────────────

  static _loadSkillComplianceReport(projectRoot) {
    if (!projectRoot) return null;
    try {
      const reportPath = path.join(projectRoot, 'output', 'skill-compliance-report.json');
      if (!fs.existsSync(reportPath)) return null;
      return JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    } catch (_) {
      return null;
    }
  }

  // ─── File Size Compliance Check ───────────────────────────────────────

  /**
   * Scans workflow source files and checks line counts against
   * architecture-constraints.md limits.
   *
   * Rules (from architecture-constraints.md):
   *   - index.js: 600 lines
   *   - core/*.js: 400 lines
   *   - agents/*.js: 300 lines
   *   - commands/command-router.js: 100 lines
   *   - commands/commands-*.js: 500 lines
   *
   * @param {string} projectRoot — Project root directory
   * @param {string[]|null} [filterFiles=null] — When provided, only check these files (paths like 'workflow/core/foo.js')
   * @returns {Array<{ file: string, lines: number, limit: number }>}
   */
  static _checkFileSizeCompliance(projectRoot, filterFiles = null) {
    const workflowDir = path.join(projectRoot, 'workflow');
    if (!fs.existsSync(workflowDir)) return [];

    const FILE_SIZE_RULES = [
      { pattern: /^index\.js$/,               limit: 600 },
      { pattern: /^core\/[^/]+\.js$/,         limit: 400 },
      { pattern: /^agents\/[^/]+\.js$/,       limit: 300 },
      { pattern: /^commands\/command-router\.js$/, limit: 100 },
      { pattern: /^commands\/commands-[^/]+\.js$/, limit: 500 },
      { pattern: /^tools\/[^/]+\.js$/,        limit: 800 },
    ];

    const violations = [];

    // When filterFiles is provided, skip directory scanning and check only specified files
    if (filterFiles && filterFiles.length > 0) {
      const filterSet = new Set(filterFiles.map(f => f.replace(/\\/g, '/')));
      for (const filePath of filterSet) {
        const relPath = filePath.startsWith('workflow/') ? filePath.slice('workflow/'.length) : filePath;
        for (const rule of FILE_SIZE_RULES) {
          if (rule.pattern.test(relPath)) {
            const fullPath = path.join(workflowDir, relPath);
            try {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lineCount = content.split('\n').length;
              if (lineCount > rule.limit) {
                violations.push({ file: `workflow/${relPath}`, lines: lineCount, limit: rule.limit });
              }
            } catch (_) { /* non-fatal: file may not exist or not readable */ }
            break;
          }
        }
      }
      return violations;
    }

    const scanDir = (dir, relBase) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { console.warn('[QualityGate] readdirSync failed for', dir, ':', e.message); return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.join(relBase, entry.name).replace(/\\/g, '/');
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          scanDir(fullPath, relPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          for (const rule of FILE_SIZE_RULES) {
            if (rule.pattern.test(relPath)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const lineCount = content.split('\n').length;
                if (lineCount > rule.limit) {
                  violations.push({ file: `workflow/${relPath}`, lines: lineCount, limit: rule.limit });
                }
              } catch (_) { /* non-fatal */ }
              break; // Only match first rule
            }
          }
        }
      }
    };

    scanDir(workflowDir, '');
    return violations;
  }

  // ─── Stage Decision API (for stage-architect, stage-developer, stage-tester) ───

  /**
   * Evaluates a stage review result and returns a pass/fail decision with rollback advice.
   * This method bridges the gap between validate() API and the stage runners' expectations.
   *
   * @param {object} reviewResult - Result from CodeReviewAgent or ReviewAgentBase
   * @param {string} workflowState - WorkflowState enum (ARCHITECT, CODE, TEST, etc.)
   * @param {number} rollbackCount - Current rollback count for this stage
   * @returns {{ pass: boolean, rollback: boolean, reason: string, riskNotes: string[] }}
   */
  evaluate(reviewResult, workflowState, rollbackCount = 0, metricsOpts = {}) {
    const failures = reviewResult?.failures || [];
    const riskNotes = reviewResult?.riskNotes || [];
    const needsHumanReview = reviewResult?.needsHumanReview || false;
    const maxRollbacks = this._gates.maxRollbacks || 1;

    // Determine pass/fail based on failures and human review flag
    let pass = failures.length === 0 && !needsHumanReview;

    // Determine if rollback is recommended
    const canRollback = rollbackCount < maxRollbacks;
    let shouldRollback = !pass && canRollback && failures.some(f => {
      // Check if any failure is high severity
      const item = reviewResult?.allResults?.find(r => r.id === f.id);
      return item?.severity === 'high' || f.severity === 'high';
    });

    // ── Integration: merge metrics-based gate (chain B) results into review-based decision (chain A) ──
    let metricsFailures = [];
    const { projectRoot, metrics } = metricsOpts;
    if (projectRoot || metrics) {
      try {
        const effectiveMetrics = metrics || {};
        if (projectRoot) effectiveMetrics.projectRoot = projectRoot;
        const metricsResult = this._validateInternal(effectiveMetrics, this._gates, workflowState);
        metricsFailures = metricsResult.gates
          .filter(g => !g.passed && !g.advisory)
          .map(g => ({ id: g.name, severity: 'high', message: g.message }));

        if (metricsFailures.length > 0) {
          pass = false;
          shouldRollback = canRollback; // HIGH metric failures should trigger rollback
          console.warn(`[QualityGate] 🔗 Chain merge: ${metricsFailures.length} metric gate(s) failed — overriding review decision`);
        }
      } catch (mergeErr) {
        const msg = `[QualityGate] metrics merge failed: ${mergeErr.message}`;
        console.warn(msg);
        riskNotes.push(msg);
      }
    }

    const reason = pass
      ? `All ${reviewResult?.totalItems || 0} checklist items passed` + (metricsFailures.length > 0 ? '' : '')
      : `${failures.length} failure(s)${metricsFailures.length > 0 ? ` + ${metricsFailures.length} metric failure(s)` : ''}, ${riskNotes.length} risk note(s)${needsHumanReview ? ', needs human review' : ''}`;

    console.log(`[QualityGate] 📊 evaluate(${workflowState}): pass=${pass}, rollback=${shouldRollback}, failures=${failures.length}, metricsFailures=${metricsFailures.length}, rollbackCount=${rollbackCount}/${maxRollbacks}`);

    return {
      pass,
      rollback: shouldRollback,
      reason,
      riskNotes,
      failures,
      metricsFailures,
      rollbackCount,
    };
  }

  /**
   * Records experience from a stage decision to ExperienceStore.
   * Non-blocking: if experienceStore is not available, silently skips.
   *
   * @param {object} decision - Decision from evaluate()
   * @param {string} workflowState - WorkflowState enum
   * @param {object} reviewResult - Original review result
   * @param {object} options - { skill, category }
   */
  recordExperience(decision, workflowState, reviewResult, options = {}) {
    if (!this._experienceStore) {
      return; // Non-blocking: experience recording is optional
    }

    try {
      const { skill, category } = options;
      const experience = {
        timestamp: new Date().toISOString(),
        stage: workflowState,
        pass: decision?.pass || false,
        rollback: decision?.rollback || false,
        failures: reviewResult?.failures?.length || 0,
        rounds: reviewResult?.rounds || 0,
        skill,
        category,
      };

      // Use ExperienceStore.record() if available
      if (typeof this._experienceStore.record === 'function') {
        this._experienceStore.record(experience);
      }

      console.log(`[QualityGate] 📝 Experience recorded: ${workflowState} -> ${decision?.pass ? 'PASS' : 'FAIL'}`);
    } catch (err) {
      console.warn(`[QualityGate] ⚠️ Failed to record experience: ${err.message}`);
    }
  }
}

module.exports = { QualityGate, DEFAULT_QUALITY_GATES, STAGE_QUALITY_GATES, GATE_CONFIG_MODE };
