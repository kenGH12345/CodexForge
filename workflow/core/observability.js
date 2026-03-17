/**
 * Observability – Runtime metrics collection for the workflow.
 *
 * Tracks per-stage timing, LLM call counts, estimated token usage,
 * error counts, and test results. Writes a structured JSON report to
 * output/run-metrics.json at the end of each session.
 *
 * Cross-session history: appends each session record to
 * output/metrics-history.jsonl (one JSON object per line) for trend analysis.
 * Use Observability.loadHistory() to read and analyse historical data.
 *
 * P1-4 fix: Strategy derivation (deriveStrategy, computeTrends,
 * estimateTaskComplexity, loadHistory) has been extracted to
 * observability-strategy.js to separate collection from analysis.
 * Static methods on this class remain as backward-compatible proxies.
 *
 * Design: zero-dependency, zero-side-effect on existing code.
 * Integration: Orchestrator calls obs.stageStart/stageEnd around each
 * _runStage call, and obs.recordLlmCall inside the wrappedLlm closure.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ObsStrategy = require('./observability-strategy');

class Observability {
  /**
   * @param {string} outputDir  - Directory to write run-metrics.json
   * @param {string} projectId  - Project identifier
   */
  constructor(outputDir, projectId) {
    this._outputDir  = outputDir;
    this._projectId  = projectId;
    this._sessionId  = `${projectId}-${Date.now()}`;
    this._startedAt  = Date.now();

    /** @type {Map<string, {start:number, end?:number, status?:string}>} */
    this._stages = new Map();

    /** @type {{role:string, estimatedTokens:number, ts:number}[]} */
    this._llmCalls = [];

    /** @type {{stage:string, message:string, ts:number}[]} */
    this._errors = [];

    /** @type {{passed:number, failed:number, skipped:number, rounds:number}|null} */
    this._testResult = null;

    /** @type {{violations:number, filesScanned:number, reportPath:string|null}|null} */
    this._entropyResult = null;

    /** @type {{status:string, provider:string, steps:object[], durationMs:number}|null} */
    this._ciResult = null;

    /** @type {{symbolCount:number, fileCount:number, edgeCount:number}|null} */
    this._codeGraphResult = null;

    /**
     * Experience injection & hit tracking for deriveStrategy Rule 4.
     * Populated by recordExpUsage() calls from orchestrator-stages.js.
     *
     * injectedCount: total number of experience IDs injected into agent prompts
     *   this session (sum of ids.length across all getContextBlockWithIds calls).
     * hitCount: total number of those injected experiences that were later
     *   confirmed effective via markUsedBatch() (i.e. the downstream task succeeded).
     *
     * hitRate = hitCount / injectedCount tells deriveStrategy whether the
     * experience store is actually helping or just adding prompt noise.
     */
    this._expInjectedCount = 0;
    this._expHitCount = 0;

    /**
     * Defect G fix: Clarification quality metrics tracking.
     * Populated by recordClarificationQuality() from orchestrator-stages.js.
     *
     * Enables deriveStrategy() Rule 5 to adjust maxClarificationRounds based
     * on whether clarification is actually improving requirement quality.
     *
     * @type {{ textChangePct: number, effectivenessScore: number, highSeverityResolved: number, highSeverityInitial: number, rounds: number }|null}
     */
    this._clarificationQuality = null;

    /**
     * Defect J fix: Task complexity score for the current session.
     * Populated by recordTaskComplexity() from orchestrator-stages.js after
     * the ANALYSE stage produces the enriched requirement.
     *
     * Enables deriveStrategy() Rule 6 to scale maxFixRounds and maxReviewRounds
     * based on the actual difficulty of the current task, rather than relying
     * solely on historical success rates (which are biased towards the historical
     * mix of simple/complex tasks).
     *
     * @type {{ score: number, level: string, factors: object }|null}
     */
    this._taskComplexity = null;

    /**
     * Prompt A/B testing: variant usage stats for the current session.
     * Populated by recordPromptVariantUsage() from orchestrator-stages.js.
     * Written to metrics-history.jsonl by flush() for cross-session analysis.
     *
     * @type {object|null}
     */
    this._promptVariantStats = null;
  }

  // ─── Stage Tracking ───────────────────────────────────────────────────────

  /** Mark the start of a workflow stage. */
  stageStart(stageName) {
    this._stages.set(stageName, { start: Date.now() });
  }

  /** Mark the end of a workflow stage with a status. */
  stageEnd(stageName, status = 'ok') {
    const entry = this._stages.get(stageName) || { start: Date.now() };
    entry.end    = Date.now();
    entry.status = status;
    entry.durationMs = entry.end - entry.start;
    this._stages.set(stageName, entry);
  }

  // ─── LLM Call Tracking ────────────────────────────────────────────────────

  /**
   * Record a single LLM call with estimated token count.
   * @param {string} role            - Agent role (analyst / architect / developer / tester)
   * @param {number} estimatedTokens - Token estimate from buildAgentPrompt
   */
  recordLlmCall(role, estimatedTokens = 0) {
    this._llmCalls.push({ role, estimatedTokens, actualTokens: null, ts: Date.now() });
  }

  /**
   * Update the last LLM call record with actual token usage returned by the LLM API.
   *
   * Problem it solves (P2-A):
   *   estimatedTokens is a rough heuristic from buildAgentPrompt (char count / 4).
   *   The actual token count from the LLM API (usage.total_tokens) is the ground truth.
   *   Without it, we cannot do cost budgeting, identify token black holes, or run
   *   prompt A/B tests with accurate measurements.
   *
   * Usage:
   *   const response = await this._rawLlmCall(prompt);
   *   const actual = response?.usage?.total_tokens ?? null;
   *   this.obs.recordActualTokens(role, actual);
   *
   * @param {string}      role         - Agent role (must match the last recordLlmCall role)
   * @param {number|null} actualTokens - Actual token count from LLM API, or null if unavailable
   */
  recordActualTokens(role, actualTokens) {
    if (actualTokens == null) return;
    // Walk backwards to find the most recent call for this role
    for (let i = this._llmCalls.length - 1; i >= 0; i--) {
      if (this._llmCalls[i].role === role) {
        this._llmCalls[i].actualTokens = actualTokens;
        return;
      }
    }
  }

  // ─── Error Tracking ───────────────────────────────────────────────────────

  /** Record a workflow error. */
  recordError(stage, message) {
    this._errors.push({ stage, message, ts: Date.now() });
  }

  // ─── Test Result ──────────────────────────────────────────────────────────

  /** Record the final test execution result. */
  recordTestResult({ passed = 0, failed = 0, skipped = 0, rounds = 1 } = {}) {
    this._testResult = { passed, failed, skipped, rounds };
  }

  // ─── Entropy Result ───────────────────────────────────────────────────────

  /** Record the entropy GC scan result. */
  recordEntropyResult({ violations = 0, filesScanned = 0, reportPath = null } = {}) {
    this._entropyResult = { violations, filesScanned, reportPath };
  }

  /** Record the CI pipeline result. */
  recordCIResult({ status = 'unknown', provider = 'local', steps = [], durationMs = 0 } = {}) {
    this._ciResult = { status, provider, steps, durationMs };
  }

  /** Record the code graph build result. */
  recordCodeGraphResult({ symbolCount = 0, fileCount = 0, edgeCount = 0 } = {}) {
    this._codeGraphResult = { symbolCount, fileCount, edgeCount };
  }

  /**
   * Records experience injection and hit counts for this session.
   *
   * Call this from orchestrator-stages.js at two points:
   *   1. After getContextBlockWithIds(): recordExpUsage({ injected: ids.length })
   *   2. After markUsedBatch() succeeds: recordExpUsage({ hits: triggerCount })
   *
   * The accumulated injectedCount and hitCount are written to metrics-history.jsonl
   * by flush(), enabling deriveStrategy() to compute a cross-session hit rate and
   * adjust maxExpInjected accordingly.
   *
   * @param {object} options
   * @param {number} [options.injected=0] - Number of experience IDs injected this call
   * @param {number} [options.hits=0]     - Number of those IDs confirmed effective
   */
  recordExpUsage({ injected = 0, hits = 0 } = {}) {
    this._expInjectedCount += injected;
    this._expHitCount += hits;
  }

  /**
   * Defect G fix: Records clarification quality metrics for this session.
   * Called by orchestrator-stages.js after RequirementClarifier.clarify() completes.
   *
   * @param {object} metrics - ClarificationQualityMetrics from RequirementClarifier
   * @param {number} rounds  - Number of clarification rounds performed
   */
  recordClarificationQuality(metrics, rounds = 0) {
    if (!metrics) return;
    this._clarificationQuality = {
      textChangePct:       metrics.textChangePct,
      effectivenessScore:  metrics.effectivenessScore,
      highSeverityResolved: metrics.highSeverityResolved,
      highSeverityInitial: metrics.highSeverityInitial,
      totalSignalsResolved: metrics.totalSignalsResolved,
      totalSignalsInitial: metrics.totalSignalsInitial,
      newSignalsIntroduced: metrics.newSignalsIntroduced,
      rounds,
    };
  }

  // ─── Task Complexity Estimation (Defect J fix) ────────────────────────────

  /**
   * Defect J fix: Records the task complexity assessment for this session.
   * Called by orchestrator-stages.js at the end of ANALYSE stage, after the
   * enriched requirement is available.
   *
   * @param {object} complexity - From Observability.estimateTaskComplexity()
   */
  recordTaskComplexity(complexity) {
    if (!complexity) return;
    this._taskComplexity = complexity;
    console.log(`[Observability] 📊 Task complexity: ${complexity.level} (score=${complexity.score}/100)`);
  }

  /**
   * Records prompt variant usage stats for the current session.
   * Called by the Orchestrator at flush time to snapshot the PromptSlotManager stats.
   *
   * @param {object} stats - From PromptSlotManager.getStats()
   */
  recordPromptVariantUsage(stats) {
    if (!stats || Object.keys(stats).length === 0) return;
    this._promptVariantStats = stats;
  }

  /**
   * P1-4 fix: Proxy to observability-strategy.js (backward compatible).
   * @see observability-strategy.js#estimateTaskComplexity
   */
  static estimateTaskComplexity(requirementText) {
    return ObsStrategy.estimateTaskComplexity(requirementText);
  }

  // ─── Report Generation ────────────────────────────────────────────────────

  /**
   * Builds the metrics object and writes it to output/run-metrics.json.
   * Safe to call multiple times (overwrites previous report for this session).
   * @returns {object} The metrics object
   */
  flush() {
    const totalMs      = Date.now() - this._startedAt;
    const totalTokensEst    = this._llmCalls.reduce((s, c) => s + (c.estimatedTokens || 0), 0);
    const totalTokensActual = this._llmCalls.reduce((s, c) => s + (c.actualTokens || 0), 0);
    const callsByRole  = {};
    const tokensByRole = {};
    for (const c of this._llmCalls) {
      callsByRole[c.role]  = (callsByRole[c.role]  || 0) + 1;
      tokensByRole[c.role] = (tokensByRole[c.role] || 0) + (c.actualTokens || c.estimatedTokens || 0);
    }

    const stagesArr = [];
    for (const [name, entry] of this._stages) {
      stagesArr.push({ name, ...entry });
    }

    const metrics = {
      sessionId:      this._sessionId,
      projectId:      this._projectId,
      startedAt:      new Date(this._startedAt).toISOString(),
      finishedAt:     new Date().toISOString(),
      totalDurationMs: totalMs,
      stages:         stagesArr,
      llm: {
        totalCalls:      this._llmCalls.length,
        totalTokensEst:  totalTokensEst,
        totalTokensActual: totalTokensActual > 0 ? totalTokensActual : null,
        callsByRole,
        tokensByRole,
      },
      errors: {
        count:   this._errors.length,
        details: this._errors,
      },
      testResult:      this._testResult,
      entropyResult:   this._entropyResult,
      ciResult:        this._ciResult,
      codeGraphResult: this._codeGraphResult,
      // Defect G fix: clarification quality metrics for deriveStrategy Rule 5
      clarificationQuality: this._clarificationQuality,
      // Defect J fix: task complexity assessment for deriveStrategy Rule 6
      taskComplexity: this._taskComplexity,
    };

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      // Overwrite latest session snapshot
      const outPath = path.join(this._outputDir, 'run-metrics.json');
      fs.writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf-8');

      // Append to cross-session history (JSONL format)
      // ── Defect #6 fix: atomic append to metrics-history.jsonl ────────────────
      // Previously used appendFileSync() directly. If the process crashed mid-write,
      // a partial JSON line would be written, causing JSON.parse() to throw in
      // loadHistory() and silently returning [] (all history lost).
      // Fix: write the new line to a .tmp file first, then read-append-write the
      // full history file atomically via writeFileSync (overwrite). This ensures
      // the file is always a valid sequence of complete JSON lines.
      const historyPath = path.join(this._outputDir, 'metrics-history.jsonl');
      const historyLine = JSON.stringify({
        sessionId:       metrics.sessionId,
        projectId:       metrics.projectId,
        startedAt:       metrics.startedAt,
        totalDurationMs: metrics.totalDurationMs,
        llmCalls:        metrics.llm.totalCalls,
        tokensEst:       metrics.llm.totalTokensEst,
        tokensActual:    metrics.llm.totalTokensActual,
        errorCount:      metrics.errors.count,
        testPassed:      metrics.testResult?.passed ?? null,
        testFailed:      metrics.testResult?.failed ?? null,
        entropyViolations: metrics.entropyResult?.violations ?? null,
        ciStatus:        metrics.ciResult?.status ?? null,
        codeGraphSymbols: metrics.codeGraphResult?.symbolCount ?? null,
        // Improvement 4: experience hit-rate tracking
        // expInjectedCount: how many experience IDs were injected into agent prompts
        // expHitCount: how many of those were confirmed effective (task succeeded)
        // hitRate = expHitCount / expInjectedCount → used by deriveStrategy Rule 4
        expInjectedCount: this._expInjectedCount,
        expHitCount:      this._expHitCount,
        // Defect G fix: clarification quality metrics for cross-session trend analysis
        // deriveStrategy Rule 5 reads these to adjust maxClarificationRounds
        clarificationEffectiveness: this._clarificationQuality?.effectivenessScore ?? null,
        clarificationRounds: this._clarificationQuality?.rounds ?? null,
        clarificationTextChangePct: this._clarificationQuality?.textChangePct ?? null,
        clarificationNewSignals: this._clarificationQuality?.newSignalsIntroduced ?? null,
        // Defect J fix: task complexity for cross-session complexity-aware strategy
        // deriveStrategy Rule 6 reads this to modulate maxFixRounds/maxReviewRounds
        // based on how complex the current task actually is, rather than relying only
        // on historical success rates (which are biased by the historical task mix).
        taskComplexityScore: this._taskComplexity?.score ?? null,
        taskComplexityLevel: this._taskComplexity?.level ?? null,
        // Prompt A/B testing: variant usage stats for cross-session tracking
        // promptVariantStats captures which variants were used and their outcomes
        // this session. Stored as { [slotKey]: { variantId, trials, passes } }.
        promptVariantStats: this._promptVariantStats ?? null,
      }) + '\n';
      // Read existing history, append new line, write atomically
      const existingHistory = fs.existsSync(historyPath)
        ? fs.readFileSync(historyPath, 'utf-8')
        : '';
      const historyTmpPath = historyPath + '.tmp';
      fs.writeFileSync(historyTmpPath, existingHistory + historyLine, 'utf-8');
      fs.renameSync(historyTmpPath, historyPath);
    } catch (err) {
      console.warn(`[Observability] Failed to write metrics: ${err.message}`);
    }

    return metrics;
  }

  // ─── Cross-Session History Analysis (P1-4: proxied to observability-strategy.js) ──

  /** @see observability-strategy.js#loadHistory */
  static loadHistory(outputDir) {
    return ObsStrategy.loadHistory(outputDir);
  }

  /** @see observability-strategy.js#computeTrends */
  static computeTrends(history) {
    return ObsStrategy.computeTrends(history);
  }

  /**
   * P1-4 fix: Proxy to observability-strategy.js (backward compatible).
   * @see observability-strategy.js#deriveStrategy
   */
  static deriveStrategy(outputDir, defaults = {}) {
    return ObsStrategy.deriveStrategy(outputDir, defaults);
  }

  /**
   * Prints a human-readable dashboard to stdout.
   * Call after flush() to display the session summary.
   */
  printDashboard() {
    const m = this.flush();
    const bar = '─'.repeat(58);
    console.log(`\n${bar}`);
    console.log(`  📊 WORKFLOW OBSERVABILITY DASHBOARD`);
    console.log(`  Session : ${m.sessionId}`);
    console.log(`  Duration: ${(m.totalDurationMs / 1000).toFixed(1)}s`);
    console.log(bar);

    // Stage timings
    console.log(`  Stages:`);
    for (const s of m.stages) {
      const icon   = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️ ';
      const dur    = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
      console.log(`    ${icon} ${s.name.padEnd(14)} ${dur}`);
    }

    // LLM usage
    const tokenDisplay = m.llm.totalTokensActual != null
      ? `${m.llm.totalTokensActual.toLocaleString()} actual (est: ~${m.llm.totalTokensEst.toLocaleString()})`
      : `~${m.llm.totalTokensEst.toLocaleString()} est.`;
    console.log(`  LLM Calls: ${m.llm.totalCalls} total | ${tokenDisplay} tokens`);
    for (const [role, cnt] of Object.entries(m.llm.callsByRole)) {
      const roleTokens = m.llm.tokensByRole?.[role] || 0;
      console.log(`    • ${role}: ${cnt} call(s), ~${roleTokens.toLocaleString()} tokens`);
    }

    // Errors
    if (m.errors.count > 0) {
      console.log(`  ⚠️  Errors: ${m.errors.count}`);
      for (const e of m.errors.details.slice(0, 3)) {
        console.log(`    [${e.stage}] ${e.message.slice(0, 80)}`);
      }
    }

    // Test result
    if (m.testResult) {
      const t = m.testResult;
      const icon = t.failed === 0 ? '✅' : '❌';
      console.log(`  ${icon} Tests: ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
    }

    // Entropy
    if (m.entropyResult) {
      const e = m.entropyResult;
      const icon = e.violations === 0 ? '✅' : '⚠️ ';
      console.log(`  ${icon} Entropy GC: ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
      if (e.reportPath) console.log(`    Report: ${e.reportPath}`);
    }

    // CI result
    if (m.ciResult) {
      const c    = m.ciResult;
      const icon = c.status === 'success' ? '✅' : c.status === 'failed' ? '❌' : '🔄';
      console.log(`  ${icon} CI [${c.provider}]: ${c.status} (${(c.durationMs / 1000).toFixed(1)}s)`);
    }

    // Code graph
    if (m.codeGraphResult) {
      const g = m.codeGraphResult;
      console.log(`  📊 Code Graph: ${g.symbolCount} symbols | ${g.edgeCount} call edges | ${g.fileCount} files`);
    }

    console.log(bar);
    console.log(`  Full metrics: output/run-metrics.json`);
    console.log(`  History:      output/metrics-history.jsonl`);
    console.log(`${bar}\n`);

    // Cross-session trend summary (if history exists)
    this._printTrendSummary();
  }


  _printTrendSummary() {
    try {
      const history = Observability.loadHistory(this._outputDir);
      if (history.length < 2) return; // Need at least 2 sessions for trends

      const trends = Observability.computeTrends(history);
      if (!trends) return;

      const bar = '─'.repeat(58);
      console.log(`  📈 TREND ANALYSIS (last ${trends.sessionCount} sessions)`);
      console.log(bar);

      const trendIcon = (t) => t === 'increasing' ? '📈' : t === 'decreasing' ? '📉' : '➡️ ';
      console.log(`  Avg Duration : ${(trends.avgDurationMs / 1000).toFixed(1)}s  ${trendIcon(trends.durationTrend)} ${trends.durationTrend}`);
      console.log(`  Avg Tokens   : ~${trends.avgTokensEst.toLocaleString()}  ${trendIcon(trends.tokenTrend)} ${trends.tokenTrend}`);
      console.log(`  Avg Errors   : ${trends.avgErrorCount}  ${trendIcon(trends.errorTrend)} ${trends.errorTrend}`);
      if (trends.avgEntropyViolations != null) {
        console.log(`  Avg Entropy  : ${trends.avgEntropyViolations} violations  ${trendIcon(trends.entropyTrend)} ${trends.entropyTrend}`);
      }
      if (trends.ciSuccessRate != null) {
        console.log(`  CI Success   : ${(trends.ciSuccessRate * 100).toFixed(0)}%`);
      }
      console.log(`${bar}\n`);
    } catch (_) {}
  }
}

module.exports = { Observability };
