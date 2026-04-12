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

const fs     = require('fs');
const path   = require('path');
const ObsStrategy = require('./observability-strategy');
const { PromptTraceStore, quickHash } = require('./observability-prompt-tracing');
const { buildHTMLReport } = require('./observability-html-report');
const { printDashboard, printTrendSummary } = require('./observability-dashboard');
const { buildMetrics, buildHistoryLine, writeMetricsFiles } = require('./observability-flush');

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

    /**
     * P1: Route decision + fallback telemetry per LLM call.
     * Captures router decision rationale, tier selection, fallback chain, and trace context.
     * @type {Array<object>}
     */
    this._routeDecisions = [];

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
     * Detailed tracking of which specific experiences were hit and their outcomes.
     * Enables fine-grained attribution analysis.
     * @type {Array<{timestamp: string, expIds: string[], stagePassed: boolean, qualityScore: number}>}
     */
    this._expHitDetails = [];

    /**
     * Skill injection tracking for Skill Lifecycle Management.
     * Populated by recordSkillUsage() calls from prompt-builder.js.
     *
     * injectedSkills: Map of skill names → injection count this session.
     * effectiveSkills: Set of skill names confirmed effective (stage passed
     *   after skill was injected). Populated by markSkillEffective().
     *
     * Cross-session analysis enables:
     *   - Skill-level hit-rate (effective / injected)
     *   - Stale skill detection (injected but never effective)
     *   - Skill retirement recommendations
     *
     * @type {Map<string, number>}
     */
    this._skillInjectedCounts = new Map();
    /** @type {Set<string>} */
    this._skillEffectiveSet = new Set();
    /** @type {Map<string, number>} */
    this._skillGatePassCounts = new Map();
    /** @type {Map<string, number>} */
    this._skillGateFailCounts = new Map();
    /** @type {Map<string, number>} */
    this._skillFalsePositiveSignals = new Map();

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

    /**
     * Adapter Telemetry: per-block lifecycle tracking.
     * Populated by AdapterTelemetry instance shared across context builders.
     * Written to run-metrics.json and metrics-history.jsonl by flush().
     *
     * @type {object|null}
     */
    this._blockTelemetry = null;

    /**
     * P1 Tool Search Optimisation: plugin skip statistics.
     * Tracks how many plugins were skipped by keyword pre-filtering vs executed.
     * Populated by recordToolSearchStats() from context builders.
     *
     * @type {{ totalPlugins: number, skippedByKeyword: number, skippedBySmartContext: number, executed: number, stages: object }|null}
     */
    this._toolSearchStats = null;

    /**
     * P1 Programmatic Tool Calling: ToolResultFilter statistics.
     * Tracks how many characters were saved by pre-filtering adapter results.
     * Populated by recordToolResultFilterStats() from context builders.
     *
     * @type {{ totalSaved: number, filteredBlocks: number, strategies: object }|null}
     */
    this._toolResultFilterStats = null;

    /**
     * Self-Reflection Engine: gating results from the current session.
     * Populated by validateRun() at flush time.
     *
     * @type {{ passed: boolean, failedGates: string[], gateCount: number }|null}
     */
    this._reflectionGating = null;

    /**
     * P0 Prompt Tracing: captures a digest of every LLM prompt sent this session.
     *
     * Each entry stores:
     *   - role: agent role (analyst/architect/developer/tester/__internal)
     *   - ts: timestamp in ms
     *   - promptHash: SHA-256 hex digest of the full prompt text (for dedup & lookup)
     *   - promptHead: first 500 chars of the prompt (for quick inspection)
     *   - promptTail: last 200 chars of the prompt (to see the actual instruction)
     *   - promptLength: total character length of the full prompt
     *   - estimatedTokens: token estimate
     *
     * Rationale (from "24h 打工人" article review): without prompt traces,
     * SelfReflectionEngine cannot diagnose WHY a stage degraded — was it the
     * prompt that changed, or the model output? Prompt A/B comparison also
     * requires input data.
     *
     * Storage: written to output/prompt-traces.jsonl (separate from run-metrics
     * to avoid bloating the main metrics file). One JSON object per line.
     *
     * @type {Array<{role:string, ts:number, promptHash:string, promptHead:string, promptTail:string, promptLength:number, estimatedTokens:number}>}
     */
    this._promptTraces = [];
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
   * Record a single LLM call with estimated token count, optional prompt digest,
   * and optional routing metadata.
   *
   * P0 Enhancement: accepts an optional `promptText` parameter. When provided,
   * a compact digest is stored in `_promptTraces[]` for later analysis by
   * SelfReflectionEngine and cross-session prompt A/B comparison.
   *
   * P1 Enhancement: accepts optional `routeMeta` to track route/fallback decisions
   * in the same timeline as LLM calls.
   *
   * The full prompt is NEVER stored — only a hash + head + tail + length.
   * This keeps storage bounded while enabling meaningful debugging.
   *
   * @param {string} role            - Agent role (analyst / architect / developer / tester)
   * @param {number} estimatedTokens - Token estimate from buildAgentPrompt
   * @param {string} [promptText]    - Optional: full prompt text for digest extraction
   * @param {object} [routeMeta]     - Optional: route/fallback/trace context metadata
   */
  recordLlmCall(role, estimatedTokens = 0, promptText, routeMeta = null) {
    const ts = Date.now();
    this._llmCalls.push({ role, estimatedTokens, actualTokens: null, ts });

    if (routeMeta && typeof routeMeta === 'object') {
      this._routeDecisions.push({
        ts,
        role,
        routeMeta,
      });
      // Bound memory for long sessions
      if (this._routeDecisions.length > 500) {
        this._routeDecisions = this._routeDecisions.slice(-500);
      }
    }

    // P0 Prompt Tracing: store compact digest if prompt text is provided
    if (promptText && typeof promptText === 'string' && promptText.length > 0) {
      const promptHash = quickHash(promptText);
      const promptLength = promptText.length;
      const promptHead = promptText.slice(0, 500);
      const promptTail = promptLength > 700 ? promptText.slice(-200) : '';
      this._promptTraces.push({
        role,
        ts,
        promptHash,
        promptHead,
        promptTail,
        promptLength,
        estimatedTokens,
      });
    }
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

  // ─── P1 Recovery Hook: Stage Retry Tracking ──────────────────────────────

  /**
   * Records a stage retry event for cross-session analysis.
   * Called by _runStage() when a transient error triggers an automatic retry.
   *
   * @param {string} stageLabel - e.g. 'INIT→ANALYSE'
   * @param {number} attempt    - retry attempt number (1-based)
   * @param {string} errorMsg   - the error message that triggered the retry
   */
  recordStageRetry(stageLabel, attempt, errorMsg) {
    if (!this._stageRetries) {
      this._stageRetries = [];
    }
    this._stageRetries.push({
      stage: stageLabel,
      attempt,
      error: (errorMsg || '').slice(0, 200),
      ts: Date.now(),
    });
    console.log(`[Observability] 🔄 Stage retry recorded: ${stageLabel} attempt ${attempt} (${errorMsg.slice(0, 80)})`);
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
   *   2. After markUsedBatch() succeeds: recordExpUsage({ hits, matchedExpIds, stageResult })
   *
   * The accumulated injectedCount and hitCount are written to metrics-history.jsonl
   * by flush(), enabling deriveStrategy() to compute a cross-session hit rate and
   * adjust maxExpInjected accordingly.
   *
   * P2 Enhancement: When matchedExpIds is provided, a detailed attribution record
   * is appended to _expHitDetails for fine-grained analysis of which specific
   * experiences contributed to stage success/failure.
   *
   * @param {object} options
   * @param {number}   [options.injected=0]      - Number of experience IDs injected this call
   * @param {number}   [options.hits=0]           - Number of those IDs confirmed effective
   * @param {string[]} [options.matchedExpIds=[]] - Specific experience IDs that were matched
   * @param {object}   [options.stageResult={}]   - Stage outcome (passed, score, stageLabel)
   */
  recordExpUsage({ injected = 0, hits = 0, matchedExpIds = [], stageResult = {} } = {}) {
    this._expInjectedCount += injected;
    this._expHitCount += hits;

    // P2: Record detailed attribution when specific matched IDs are provided
    if (matchedExpIds.length > 0) {
      this._expHitDetails.push({
        timestamp: new Date().toISOString(),
        expIds: matchedExpIds,
        stagePassed: stageResult.passed ?? true,
        qualityScore: stageResult.score ?? null,
        stageLabel: stageResult.stageLabel ?? null,
      });
    }
  }

  /**
   * Records which skills were injected into an agent prompt this call.
   * Called by prompt-builder.js after ContextLoader.resolve().
   *
   * @param {string[]} skillNames - Names of skills injected (from sources)
   */
  recordSkillUsage(skillNames) {
    if (!skillNames || skillNames.length === 0) return;
    for (const name of skillNames) {
      // Normalise: extract skill filename from source strings like "flutter-dev.md"
      const normalised = name.replace(/\.md$/, '').replace(/\s*\(.*\)$/, '');
      if (!normalised) continue;
      this._skillInjectedCounts.set(
        normalised,
        (this._skillInjectedCounts.get(normalised) || 0) + 1
      );
    }
  }

  /**
   * Marks skills as effective for this session.
   * Called after a stage passes QualityGate when skills were injected.
   *
   * @param {string[]} skillNames - Names of skills confirmed effective
   */
  markSkillEffective(skillNames) {
    if (!skillNames || skillNames.length === 0) return;
    for (const name of skillNames) {
      const normalised = name.replace(/\.md$/, '').replace(/\s*\(.*\)$/, '');
      if (normalised) this._skillEffectiveSet.add(normalised);
    }
  }

  /**
   * P2: Records per-skill quality gate outcomes for effectiveness policy.
   *
   * @param {string[]} skillNames
   * @param {object} [opts]
   * @param {boolean} [opts.passed=true]
   * @param {number} [opts.falsePositiveSignals=0]
   */
  recordSkillGateOutcome(skillNames, opts = {}) {
    if (!skillNames || skillNames.length === 0) return;
    const passed = opts.passed !== false;
    const falsePositiveSignals = Number(opts.falsePositiveSignals || 0);

    for (const name of skillNames) {
      const normalised = (name || '').replace(/\.md$/, '').replace(/\s*\(.*\)$/, '');
      if (!normalised) continue;

      if (passed) {
        this._skillGatePassCounts.set(
          normalised,
          (this._skillGatePassCounts.get(normalised) || 0) + 1
        );
      } else {
        this._skillGateFailCounts.set(
          normalised,
          (this._skillGateFailCounts.get(normalised) || 0) + 1
        );
      }

      if (falsePositiveSignals > 0) {
        this._skillFalsePositiveSignals.set(
          normalised,
          (this._skillFalsePositiveSignals.get(normalised) || 0) + falsePositiveSignals
        );
      }
    }
  }

  /**
   * P2: Returns current per-skill effectiveness snapshot for policy evaluation.
   */
  getSkillEffectivenessSnapshot() {
    return {
      injected: Object.fromEntries(this._skillInjectedCounts),
      effective: [...this._skillEffectiveSet],
      gatePass: Object.fromEntries(this._skillGatePassCounts),
      gateFail: Object.fromEntries(this._skillGateFailCounts),
      falsePositiveSignals: Object.fromEntries(this._skillFalsePositiveSignals),
    };
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
   * Records adapter block telemetry data for this session.
   * Called by the Orchestrator at flush time with the AdapterTelemetry report.
   *
   * @param {object} telemetryReport - From AdapterTelemetry.getReport()
   */
  recordBlockTelemetry(telemetryReport) {
    if (!telemetryReport) return;
    this._blockTelemetry = telemetryReport;
  }

  // ─── P1 Tool Search: Plugin Skip Statistics ─────────────────────────────

  /**
   * Records plugin skip statistics from AdapterPluginRegistry.collectPluginBlocks().
   * Call this from each context builder after collectPluginBlocks() returns.
   *
   * @param {string} stage - Stage name (ARCHITECT, DEVELOPER, TESTER)
   * @param {object} stats
   * @param {number}   stats.totalPlugins       - Total plugins registered for this stage
   * @param {string[]} stats.skippedByKeyword    - Plugin names skipped by keyword filter
   * @param {number}   stats.executedCount       - Plugins that actually executed
   */
  recordToolSearchStats(stage, stats) {
    if (!stats) return;
    if (!this._toolSearchStats) {
      this._toolSearchStats = { totalPlugins: 0, skippedByKeyword: 0, skippedBySmartContext: 0, executed: 0, stages: {} };
    }
    const stageStats = {
      totalPlugins: stats.totalPlugins || 0,
      skippedByKeyword: (stats.skippedByKeyword || []).length,
      skippedNames: stats.skippedByKeyword || [],
      executedCount: stats.executedCount || 0,
    };
    this._toolSearchStats.stages[stage] = stageStats;
    this._toolSearchStats.totalPlugins += stageStats.totalPlugins;
    this._toolSearchStats.skippedByKeyword += stageStats.skippedByKeyword;
    this._toolSearchStats.executed += stageStats.executedCount;
  }

  // ─── P1 Programmatic Tool Calling: ToolResultFilter Statistics ──────────

  /**
   * Records ToolResultFilter statistics from _applyTokenBudget().
   * Call this from context builders after _applyTokenBudget() returns.
   *
   * @param {string} stage - Stage name
   * @param {object} stats
   * @param {number}   stats.preFilterSaved   - Characters saved by ToolResultFilter
   * @param {string[]} stats.filteredLabels    - Labels of blocks that were filtered
   */
  recordToolResultFilterStats(stage, stats) {
    if (!stats) return;
    if (!this._toolResultFilterStats) {
      this._toolResultFilterStats = { totalSaved: 0, filteredBlocks: 0, stages: {} };
    }
    this._toolResultFilterStats.stages[stage] = {
      charsSaved: stats.preFilterSaved || 0,
      filteredLabels: stats.filteredLabels || [],
    };
    this._toolResultFilterStats.totalSaved += (stats.preFilterSaved || 0);
    this._toolResultFilterStats.filteredBlocks += (stats.filteredLabels || []).length;
  }

  // ─── Custom Metrics Recording ───────────────────────────────────────────

  /**
   * Records a custom metric for extensibility.
   * Used by Sleeptime pipeline and other extensions.
   *
   * @param {string} name - Metric name
   * @param {object} value - Metric value
   */
  recordCustomMetric(name, value) {
    if (!this._customMetrics) {
      this._customMetrics = {};
    }
    this._customMetrics[name] = value;
  }

  // ─── RunGuard Summary Recording ─────────────────────────────────────────

  /**
   * Records the RunGuard summary for cross-session cost analysis.
 * Called by orchestrator-lifecycle.js during the teardown pipeline.
   *
   * @param {object} summary - From RunGuard.getSummary()
   */
  recordRunGuardSummary(summary) {
    if (!summary) return;
    this._runGuardSummary = {
      totalCalls: summary.totalCalls || 0,
      totalTokens: summary.totalTokens || 0,
      estimatedCost: summary.estimatedCost || 0,
      tierDowngrades: summary.tierDowngrades || 0,
    };
  }

  // ─── Self-Reflection: Gating Result Recording ──────────────────────────

  /**
   * Records the self-reflection gating result for this session.
   * Called by the Orchestrator after SelfReflectionEngine.validateRun().
   *
   * @param {object} gatingResult - From SelfReflectionEngine.validateRun()
   */
  recordReflectionGating(gatingResult) {
    if (!gatingResult) return;
    this._reflectionGating = {
      passed: gatingResult.passed,
      failedGates: gatingResult.gates?.filter(g => !g.passed).map(g => g.name) || [],
      gateCount: gatingResult.gates?.length || 0,
    };
  }

  /**
   * Record teardown pipeline execution summary (P0 teardown-impl).
   * @param {object} summary - TeardownPipeline execution summary
   */
  recordTeardownPipeline(summary) {
    if (!summary) return;
    this._teardownPipelineSummary = {
      executed: summary.executed || 0,
      skipped: summary.skipped || 0,
      failed: summary.failed || 0,
      steps: summary.steps || {},
    };
  }

  /**
   * P1-4 fix: Proxy to observability-strategy.js (backward compatible).
   * @see observability-strategy.js#estimateTaskComplexity
   */
  static estimateTaskComplexity(requirementText) {
    return ObsStrategy.estimateTaskComplexity(requirementText);
  }

  // ─── Prompt Tracing ─────────────────────────────────────────────────────────

  /**
   * Returns a compact summary of prompt traces for the current session.
   * Useful for SelfReflectionEngine to compare prompts across sessions.
   *
   * @returns {{ totalCalls: number, uniquePrompts: number, byRole: Object<string, number>, avgPromptLength: number }}
   */
  getPromptTraceSummary() {
    const byRole = {};
    const hashes = new Set();
    let totalLength = 0;

    for (const trace of this._promptTraces) {
      byRole[trace.role] = (byRole[trace.role] || 0) + 1;
      hashes.add(trace.promptHash);
      totalLength += trace.promptLength;
    }

    return {
      totalCalls: this._promptTraces.length,
      uniquePrompts: hashes.size,
      byRole,
      avgPromptLength: this._promptTraces.length > 0
        ? Math.round(totalLength / this._promptTraces.length)
        : 0,
    };
  }

  /**
   * Flush prompt trace digests to output/prompt-traces.jsonl.
   *
   * Written as a separate file from run-metrics.json because:
   *   1. Prompt traces can be large (hundreds of entries per session)
   *   2. They're append-only (like metrics-history.jsonl)
   *   3. They serve a different audience: debugging & prompt engineering
   *      vs. performance monitoring
   *
   * Each line is a JSON object: { sessionId, role, ts, promptHash, promptHead,
   * promptTail, promptLength, estimatedTokens }.
   *
   * The file is append-only: each session appends its traces to the same file,
   * enabling cross-session prompt drift analysis.
   *
   * @returns {number} Number of traces written
   */
  flushPromptTraces() {
    if (this._promptTraces.length === 0) return 0;

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      const tracePath = path.join(this._outputDir, 'prompt-traces.jsonl');
      const lines = this._promptTraces.map(trace => JSON.stringify({
        sessionId: this._sessionId,
        ...trace,
      })).join('\n') + '\n';

      // Atomic append: write to tmp first, then append
      const tmpPath = tracePath + '.tmp';
      fs.writeFileSync(tmpPath, lines, 'utf-8');
      fs.appendFileSync(tracePath, lines, 'utf-8');
      try { fs.unlinkSync(tmpPath); } catch (_) { /* cleanup best-effort */ }

      console.log(`[Observability] 📝 Flushed ${this._promptTraces.length} prompt trace(s) to ${tracePath}`);
      return this._promptTraces.length;
    } catch (err) {
      console.warn(`[Observability] ⚠️  Failed to flush prompt traces: ${err.message}`);
      return 0;
    }
  }

  // ─── Report Generation ────────────────────────────────────────────────────

  /**
   * Returns a read-only snapshot of current session metrics WITHOUT writing
   * to disk. Used by SelfReflectionEngine to validate quality gates before
   * the final flush() call.
   *
   * @returns {object} Current metrics snapshot (same shape as flush() output)
   */
  getMetricsSnapshot() {
    const totalMs = Date.now() - this._startedAt;
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
    return {
      sessionId:      this._sessionId,
      projectId:      this._projectId,
      startedAt:      new Date(this._startedAt).toISOString(),
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
      blockTelemetry:  this._blockTelemetry,
      reflectionGating: this._reflectionGating,
      skillEffectiveness: this.getSkillEffectivenessSnapshot(),
      // P0 Prompt Tracing: compact summary of prompt traces for this session
      promptTraceSummary: this.getPromptTraceSummary(),
      routeDecisionSummary: {
        total: this._routeDecisions.length,
        fallbackTriggered: this._routeDecisions.filter(r => !!r.routeMeta?.fallback?.triggered).length,
        byRole: this._routeDecisions.reduce((acc, item) => {
          acc[item.role] = (acc[item.role] || 0) + 1;
          return acc;
        }, {}),
      },
    };
  }

  /**
   * Builds the metrics object and writes it to output/run-metrics.json.
   * Safe to call multiple times (overwrites previous report for this session).
   * @returns {object} The metrics object
   */
flush() {
    const metrics = buildMetrics(this);
    const historyLine = buildHistoryLine(metrics, this);
    writeMetricsFiles(metrics, historyLine, this._outputDir);
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
    printDashboard(m, this._outputDir);
  }


  // ─── HTML Report Generation ────────────────────────────────────────────────

  /**
   * Generates an interactive HTML report of the current session's metrics.
   * The report includes:
   *   - Session overview (duration, status, complexity)
   *   - Stage timeline (Gantt-style visualisation)
   *   - LLM call breakdown by role (bar chart + table)
   *   - Token usage analysis (estimated vs actual)
   *   - Error log with stage attribution
   *   - Test results, entropy scan, CI pipeline, code graph stats
   *   - Cross-session trend history (if available)
   *
   * The HTML is fully self-contained (no external CSS/JS dependencies) and
   * can be opened directly in any browser.
   *
   * @param {object} [options]
   * @param {object} [options.metrics]  - Pre-computed metrics (from flush()). If null, calls flush().
   * @param {string} [options.outputPath] - Override output path (default: output/session-report.html)
   * @returns {string} Absolute path to the generated HTML file
   */
  generateHTMLReport(options = {}) {
    const m = options.metrics || this.flush();
    const outputPath = options.outputPath || path.join(this._outputDir, 'session-report.html');

    // Load cross-session history for trend section
    let history = [];
    try {
      history = Observability.loadHistory(this._outputDir);
    } catch (err) { console.warn(`[Observability] Failed to load history: ${err.message}`); }

    // Use extracted module (ADR-41)
    const html = buildHTMLReport(m, history);

    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      fs.writeFileSync(outputPath, html, 'utf-8');
      console.log(`[Observability] 📊 HTML report generated: ${outputPath}`);
    } catch (err) {
      console.warn(`[Observability] Failed to write HTML report: ${err.message}`);
    }

    return outputPath;
  }

}

module.exports = { Observability };
