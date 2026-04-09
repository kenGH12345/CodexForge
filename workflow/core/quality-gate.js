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

const DEFAULT_QUALITY_GATES = {
  maxErrorCount:       3,
  maxTokenWasteRatio:  0.35,
  minTestPassRate:     0.70,
  maxDurationMs:       600000,
  maxLlmCalls:         15,
  maxPluginSkipRatio:  0.80,
  minPluginSkipRatio:  0.10,
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
    this._gates = { ...DEFAULT_QUALITY_GATES, ...options.qualityGates };
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

    // Gate 1: Error count
    const errorCount = metrics.errors?.count || 0;
    gates.push({
      name: 'maxErrorCount',
      passed: errorCount <= g.maxErrorCount,
      actual: errorCount,
      threshold: g.maxErrorCount,
      message: errorCount <= g.maxErrorCount
        ? `Errors within limit (${errorCount} \u2264 ${g.maxErrorCount})`
        : `Error count exceeded (${errorCount} > ${g.maxErrorCount})`,
    });

    // Gate 2: Test pass rate
    if (metrics.testResult) {
      const { passed: tp = 0, failed: tf = 0 } = metrics.testResult;
      const total = tp + tf;
      const passRate = total > 0 ? tp / total : 1;
      gates.push({
        name: 'minTestPassRate',
        passed: passRate >= g.minTestPassRate,
        actual: `${(passRate * 100).toFixed(0)}%`,
        threshold: `${(g.minTestPassRate * 100).toFixed(0)}%`,
        message: passRate >= g.minTestPassRate
          ? `Test pass rate OK (${(passRate * 100).toFixed(0)}% \u2265 ${(g.minTestPassRate * 100).toFixed(0)}%)`
          : `Test pass rate too low (${(passRate * 100).toFixed(0)}% < ${(g.minTestPassRate * 100).toFixed(0)}%)`,
      });
    }

    // Gate 3: Duration
    const duration = metrics.totalDurationMs || 0;
    gates.push({
      name: 'maxDurationMs',
      passed: duration <= g.maxDurationMs,
      actual: `${(duration / 1000).toFixed(1)}s`,
      threshold: `${(g.maxDurationMs / 1000).toFixed(1)}s`,
      message: duration <= g.maxDurationMs
        ? `Duration within limit (${(duration / 1000).toFixed(1)}s \u2264 ${(g.maxDurationMs / 1000).toFixed(1)}s)`
        : `Duration exceeded (${(duration / 1000).toFixed(1)}s > ${(g.maxDurationMs / 1000).toFixed(1)}s)`,
    });

    // Gate 4: LLM call count (detect retry storms)
    const llmCalls = metrics.llm?.totalCalls || 0;
    gates.push({
      name: 'maxLlmCalls',
      passed: llmCalls <= g.maxLlmCalls,
      actual: llmCalls,
      threshold: g.maxLlmCalls,
      message: llmCalls <= g.maxLlmCalls
        ? `LLM calls within limit (${llmCalls} \u2264 ${g.maxLlmCalls})`
        : `LLM call count high \u2014 possible retry storm (${llmCalls} > ${g.maxLlmCalls})`,
    });

    // Gate 5: Token waste ratio (if blockTelemetry available)
    if (metrics.blockTelemetry?.summary) {
      const { totalInjected = 0, totalDropped = 0 } = metrics.blockTelemetry.summary;
      const wasteRatio = totalInjected > 0 ? totalDropped / totalInjected : 0;
      gates.push({
        name: 'maxTokenWasteRatio',
        passed: wasteRatio <= g.maxTokenWasteRatio,
        actual: `${(wasteRatio * 100).toFixed(0)}%`,
        threshold: `${(g.maxTokenWasteRatio * 100).toFixed(0)}%`,
        message: wasteRatio <= g.maxTokenWasteRatio
          ? `Token waste acceptable (${(wasteRatio * 100).toFixed(0)}% \u2264 ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`
          : `Token waste too high (${(wasteRatio * 100).toFixed(0)}% > ${(g.maxTokenWasteRatio * 100).toFixed(0)}%)`,
      });
    }

    // Gate 6: File size compliance (architecture-constraints.md)
    if (metrics.projectRoot) {
      const violations = QualityGate._checkFileSizeCompliance(metrics.projectRoot);
      const fileSizePassed = violations.length === 0;
      gates.push({
        name: 'fileSizeCompliance',
        passed: fileSizePassed,
        actual: fileSizePassed ? '0 violations' : `${violations.length} file(s) over limit`,
        threshold: '0 violations',
        message: fileSizePassed
          ? 'All files within architecture line-count limits'
          : `File size violations: ${violations.map(v => `${v.file} (${v.lines}/${v.limit})`).join(', ')}`,
      });
    }

    // ─── EvoSkill: Diagnostic Mode Handling ─────────────────────────────────────
    // In diagnostic mode: record metrics but don't propagate to skill evolution

    const failedGates = gates.filter(gt => !gt.passed);

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

    const analysis = await this._cheapLlmCall(prompt);
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
   * @returns {Array<{ file: string, lines: number, limit: number }>}
   */
  static _checkFileSizeCompliance(projectRoot) {
    const workflowDir = path.join(projectRoot, 'workflow');
    if (!fs.existsSync(workflowDir)) return [];

    const FILE_SIZE_RULES = [
      { pattern: /^index\.js$/,               limit: 600 },
      { pattern: /^core\/[^/]+\.js$/,         limit: 400 },
      { pattern: /^agents\/[^/]+\.js$/,       limit: 300 },
      { pattern: /^commands\/command-router\.js$/, limit: 100 },
      { pattern: /^commands\/commands-[^/]+\.js$/, limit: 500 },
    ];

    const violations = [];

    const scanDir = (dir, relBase) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
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
  evaluate(reviewResult, workflowState, rollbackCount = 0) {
    const failures = reviewResult?.failures || [];
    const riskNotes = reviewResult?.riskNotes || [];
    const needsHumanReview = reviewResult?.needsHumanReview || false;
    const maxRollbacks = this._gates.maxRollbacks || 1;

    // Determine pass/fail based on failures and human review flag
    const pass = failures.length === 0 && !needsHumanReview;

    // Determine if rollback is recommended
    const canRollback = rollbackCount < maxRollbacks;
    const shouldRollback = !pass && canRollback && failures.some(f => {
      // Check if any failure is high severity
      const item = reviewResult?.allResults?.find(r => r.id === f.id);
      return item?.severity === 'high' || f.severity === 'high';
    });

    const reason = pass
      ? `All ${reviewResult?.totalItems || 0} checklist items passed`
      : `${failures.length} failure(s), ${riskNotes.length} risk note(s)${needsHumanReview ? ', needs human review' : ''}`;

    console.log(`[QualityGate] 📊 evaluate(${workflowState}): pass=${pass}, rollback=${shouldRollback}, failures=${failures.length}, rollbackCount=${rollbackCount}/${maxRollbacks}`);

    return {
      pass,
      rollback: shouldRollback,
      reason,
      riskNotes,
      failures,
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
