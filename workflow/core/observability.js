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
 * Design: zero-dependency, zero-side-effect on existing code.
 * Integration: Orchestrator calls obs.stageStart/stageEnd around each
 * _runStage call, and obs.recordLlmCall inside the wrappedLlm closure.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

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
   * Defect J fix: Estimates task complexity from the enriched requirement text.
   *
   * This is a heuristic estimator, NOT a precise measurement. Its purpose is to
   * distinguish "Hello World" tasks from "implement a full authentication system"
   * tasks so that deriveStrategy() can scale retry budgets appropriately.
   *
   * Complexity factors (each scored 0-20, total 0-100):
   *
   *   1. Text Length (0-20):
   *      Longer requirements generally describe more complex systems.
   *      <200 chars → 2, <500 → 5, <1000 → 10, <3000 → 15, ≥3000 → 20
   *
   *   2. Technical Entity Count (0-20):
   *      Counts mentions of technical concepts (API, database, authentication,
   *      encryption, microservice, etc.). More entities → more integration points.
   *
   *   3. Action Verb Count (0-20):
   *      Counts imperative verbs (implement, create, build, integrate, migrate,
   *      refactor, optimise, etc.). More actions → more work items.
   *
   *   4. Constraint/Quality Indicators (0-20):
   *      Counts non-functional requirements (performance, security, scalability,
   *      reliability, backward compatible, real-time, etc.).
   *
   *   5. Integration Indicators (0-20):
   *      Counts external integration mentions (third-party, webhook, OAuth, REST,
   *      GraphQL, WebSocket, message queue, etc.).
   *
   * Levels:
   *   0-25   → 'simple'    (e.g. "Add a hello world endpoint")
   *   26-50  → 'moderate'  (e.g. "Add user login with JWT")
   *   51-75  → 'complex'   (e.g. "Implement user auth with OAuth, RBAC, 2FA")
   *   76-100 → 'very_complex' (e.g. "Build a distributed event-sourced system")
   *
   * @param {string} requirementText - The enriched requirement from ANALYSE stage
   * @returns {{ score: number, level: string, factors: object }}
   */
  static estimateTaskComplexity(requirementText) {
    if (!requirementText || typeof requirementText !== 'string') {
      return { score: 0, level: 'simple', factors: {} };
    }

    const text = requirementText.toLowerCase();
    const len = text.length;

    // Factor 1: Text length
    let lengthScore;
    if (len < 200)       lengthScore = 2;
    else if (len < 500)  lengthScore = 5;
    else if (len < 1000) lengthScore = 10;
    else if (len < 3000) lengthScore = 15;
    else                 lengthScore = 20;

    // Factor 2: Technical entity count
    const TECH_ENTITIES = [
      'api', 'database', 'authentication', 'authorization', 'encryption',
      'microservice', 'server', 'client', 'frontend', 'backend', 'middleware',
      'cache', 'queue', 'worker', 'scheduler', 'pipeline', 'container',
      'docker', 'kubernetes', 'lambda', 'serverless', 'cdn', 'load.?balancer',
      'proxy', 'gateway', 'cluster', 'shard', 'replica', 'partition',
      'schema', 'migration', 'index', 'transaction', 'deadlock',
      'thread', 'process', 'async', 'concurren', 'parallel',
      'socket', 'stream', 'buffer', 'protocol',
    ];
    let entityCount = 0;
    for (const entity of TECH_ENTITIES) {
      if (new RegExp(`\\b${entity}\\b`, 'i').test(text)) entityCount++;
    }
    const entityScore = Math.min(Math.round(entityCount * 2.5), 20);

    // Factor 3: Action verb count
    const ACTION_VERBS = [
      'implement', 'create', 'build', 'design', 'develop', 'integrate',
      'migrate', 'refactor', 'optimise', 'optimize', 'deploy', 'configure',
      'setup', 'set up', 'install', 'connect', 'extend', 'modify',
      'transform', 'convert', 'generate', 'validate', 'verify', 'test',
      'monitor', 'log', 'trace', 'debug', 'profile', 'benchmark',
      'secure', 'encrypt', 'authenticate', 'authorize', 'rate.?limit',
      'throttle', 'cache', 'index', 'scale', 'partition', 'replicate',
    ];
    let actionCount = 0;
    for (const verb of ACTION_VERBS) {
      if (new RegExp(`\\b${verb}`, 'i').test(text)) actionCount++;
    }
    const actionScore = Math.min(Math.round(actionCount * 2), 20);

    // Factor 4: Constraint / non-functional requirement indicators
    const CONSTRAINTS = [
      'performance', 'latency', 'throughput', 'scalab', 'reliab',
      'availability', 'fault.?toleran', 'backward.?compat', 'forward.?compat',
      'real.?time', 'low.?latency', 'high.?throughput', 'zero.?downtime',
      'idempoten', 'atomic', 'consistent', 'isolation', 'durable',
      'security', 'compliance', 'gdpr', 'hipaa', 'pci', 'soc2',
      'accessibility', 'i18n', 'l10n', 'internationali', 'locali',
      'responsive', 'cross.?platform', 'mobile.?first', 'offline.?first',
    ];
    let constraintCount = 0;
    for (const c of CONSTRAINTS) {
      if (new RegExp(c, 'i').test(text)) constraintCount++;
    }
    const constraintScore = Math.min(Math.round(constraintCount * 3), 20);

    // Factor 5: Integration indicators
    const INTEGRATIONS = [
      'third.?party', 'external', 'webhook', 'oauth', 'saml', 'ldap',
      'rest\\b', 'graphql', 'grpc', 'websocket', 'sse', 'mqtt',
      'message.?queue', 'kafka', 'rabbitmq', 'redis', 'memcached',
      'elasticsearch', 'mongodb', 'postgresql', 'mysql', 'dynamodb',
      's3', 'blob.?storage', 'cdn', 'smtp', 'push.?notification',
      'payment', 'stripe', 'paypal', 'twilio', 'sendgrid',
      'firebase', 'supabase', 'auth0', 'cognito', 'clerk',
    ];
    let integrationCount = 0;
    for (const i of INTEGRATIONS) {
      if (new RegExp(i, 'i').test(text)) integrationCount++;
    }
    const integrationScore = Math.min(Math.round(integrationCount * 3), 20);

    const totalScore = lengthScore + entityScore + actionScore + constraintScore + integrationScore;

    let level;
    if (totalScore <= 25)      level = 'simple';
    else if (totalScore <= 50) level = 'moderate';
    else if (totalScore <= 75) level = 'complex';
    else                       level = 'very_complex';

    return {
      score: totalScore,
      level,
      factors: {
        length:      lengthScore,
        entities:    entityScore,
        actions:     actionScore,
        constraints: constraintScore,
        integrations: integrationScore,
      },
    };
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

  // ─── Cross-Session History Analysis ──────────────────────────────────────

  /**
   * Loads and parses the cross-session history from metrics-history.jsonl.
   * @returns {object[]} Array of session records (newest first)
   */
  static loadHistory(outputDir) {
    const historyPath = path.join(outputDir, 'metrics-history.jsonl');
    if (!fs.existsSync(historyPath)) return [];
    try {
      const lines = fs.readFileSync(historyPath, 'utf-8')
        .split('\n').filter(Boolean);
      return lines.map(l => JSON.parse(l)).reverse(); // newest first
    } catch (_) {
      return [];
    }
  }

  /**
   * Computes trend statistics from cross-session history.
   * @param {object[]} history - From loadHistory()
   * @returns {TrendStats}
   */
  static computeTrends(history) {
    if (history.length === 0) return null;

    const durations  = history.map(h => h.totalDurationMs).filter(v => v != null);
    const tokens     = history.map(h => h.tokensEst).filter(v => v != null);
    const errors     = history.map(h => h.errorCount).filter(v => v != null);
    const entropy    = history.map(h => h.entropyViolations).filter(v => v != null);

    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const trend = (arr) => {
      // P1-4 fix: distinguish "data insufficient" from "truly stable".
      // Previously returned 'stable' for arrays with <2 elements, which caused
      // deriveStrategy() to treat a single-session metric as stable and potentially
      // apply skipEntropyOnClean or reduce maxReviewRounds incorrectly.
      // Now returns 'insufficient_data' so deriveStrategy() can skip adjustments.
      //
      // P2-4 fix: raise the threshold from <2 to <4.
      // With 2 or 3 data points, older=[] (all points go into recent), so the
      // function always returned 'stable' for 2-3 points – indistinguishable from
      // a genuinely stable long-running series. We need at least 4 data points
      // (3 recent + 1 older) to compute a meaningful trend comparison.
      if (arr.length < 4) return 'insufficient_data';
      const recent = arr.slice(0, Math.min(3, arr.length));
      const older  = arr.slice(Math.min(3, arr.length));
      if (older.length === 0) return 'stable';
      const recentAvg = avg(recent);
      const olderAvg  = avg(older);
      if (recentAvg > olderAvg * 1.2) return 'increasing';
      if (recentAvg < olderAvg * 0.8) return 'decreasing';
      return 'stable';
    };

    return {
      sessionCount:    history.length,
      avgDurationMs:   avg(durations),
      avgTokensEst:    avg(tokens),
      avgErrorCount:   avg(errors),
      avgEntropyViolations: avg(entropy),
      durationTrend:   trend(durations),
      tokenTrend:      trend(tokens),
      errorTrend:      trend(errors),
      entropyTrend:    trend(entropy),
      // ── P1-3 fix: guard against division by zero ─────────────────────────────
      // When all sessions have ciStatus=null (no CI configured), the denominator
      // is 0, producing NaN. NaN||null returns null, which is indistinguishable
      // from "CI configured but 0% success rate". Now we explicitly check the
      // denominator and return null only when there is truly no CI data.
      ciSuccessRate: (() => {
        const ciSessions = history.filter(h => h.ciStatus != null);
        if (ciSessions.length === 0) return null; // No CI data at all
        return ciSessions.filter(h => h.ciStatus === 'success').length / ciSessions.length;
      })(),
      lastSession:     history[0]?.startedAt,
    };
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

  /**
   * Derives adaptive strategy parameters from cross-session history.
   * Used by the Orchestrator to dynamically tune retry counts, review rounds, etc.
   *
   * Strategy rules:
   *  - maxFixRounds:    increases if recent test failure rate is high
   *  - maxReviewRounds: increases if recent error count trend is increasing
   *  - skipEntropyOnClean: true if last N sessions had 0 entropy violations
   *
   * @param {string} outputDir - Directory containing metrics-history.jsonl
   * @param {object} [defaults] - Default strategy values to fall back to
   * @returns {{ maxFixRounds: number, maxReviewRounds: number, skipEntropyOnClean: boolean, source: string }}
   */
  static deriveStrategy(outputDir, defaults = {}) {
    const defaultStrategy = {
      maxFixRounds:       defaults.maxFixRounds       ?? 2,
      maxReviewRounds:    defaults.maxReviewRounds    ?? 2,
      skipEntropyOnClean: defaults.skipEntropyOnClean ?? false,
      maxClarificationRounds: defaults.maxClarificationRounds ?? 2,
      source: 'defaults',
    };

    const history = Observability.loadHistory(outputDir);
    // Need at least 3 sessions to derive meaningful strategy
    if (history.length < 3) return defaultStrategy;

    // ── Project isolation: only use history from the SAME project ────────────
    // Previously, all sessions from ALL projects were mixed together.
    // This caused cross-project pollution: project A's 3 consecutive passes
    // would reduce maxFixRounds to 1, leaving project B (a brand-new project
    // with inevitable bugs) with only 1 fix attempt.
    // Fix: filter history to the current projectId (passed via defaults.projectId).
    // Fall back to global history only if no project-specific history exists.
    const projectId = defaults.projectId || null;
    let filteredHistory = history;
    if (projectId) {
      const projectHistory = history.filter(h => h.projectId === projectId);
      if (projectHistory.length >= 3) {
        filteredHistory = projectHistory;
        console.log(`[Observability] 📊 Adaptive strategy: using ${projectHistory.length} session(s) for project "${projectId}" (isolated from global history).`);
      } else {
        console.log(`[Observability] 📊 Adaptive strategy: only ${projectHistory.length} session(s) for project "${projectId}" – using global history (${history.length} sessions) as fallback.`);
      }
    }

    if (filteredHistory.length < 3) return defaultStrategy;

    const recent = filteredHistory.slice(0, Math.min(5, filteredHistory.length));
    const trends = Observability.computeTrends(filteredHistory);

    // ── Rule 1: maxFixRounds ─────────────────────────────────────────────────
    // If recent sessions had test failures (testFailed > 0), increase fix rounds.
    const recentTestFailures = recent.filter(h => (h.testFailed ?? 0) > 0).length;
    const testFailRate = recentTestFailures / recent.length;
    let maxFixRounds = defaultStrategy.maxFixRounds;
    if (testFailRate >= 0.6) {
      maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 2, 5); // cap at 5
    } else if (testFailRate >= 0.4) {
      maxFixRounds = Math.min(defaultStrategy.maxFixRounds + 1, 4);
    } else if (testFailRate === 0 && recent.length >= 3) {
      // Consistently passing – reduce fix rounds to save time
      maxFixRounds = Math.max(defaultStrategy.maxFixRounds - 1, 1);
    }

    // ── Rule 2: maxReviewRounds ────────────────────────────────────────────
    // If error count is trending up, increase review rounds.
    // P2-4 fix: skip adjustment when trend is 'insufficient_data' to avoid
    // making strategy decisions based on a single data point.
    let maxReviewRounds = defaultStrategy.maxReviewRounds;
    if (trends && trends.errorTrend === 'increasing') {
      maxReviewRounds = Math.min(defaultStrategy.maxReviewRounds + 1, 4);
    } else if (trends && trends.errorTrend === 'decreasing' && trends.avgErrorCount === 0) {
      maxReviewRounds = Math.max(defaultStrategy.maxReviewRounds - 1, 1);
    }
    // 'insufficient_data' and 'stable': no adjustment
    // ── Rule 3: skipEntropyOnClean ───────────────────────────────────────────
    // If last 3 sessions all had 0 entropy violations, skip the post-test scan.
    // ── Improvement #2 fix: periodic forced scan ─────────────────────────────
    // Previously: once 3 consecutive clean sessions were seen, entropy was skipped
    // PERMANENTLY. If the 4th session introduced a large file or circular dep,
    // it would never be detected.
    // Fix: skip entropy only if the last 3 sessions are clean AND the total
    // session count is NOT a multiple of 5. Every 5th session forces a full scan
    // regardless of history, providing a periodic safety net.
    const recentEntropyData = recent.slice(0, 3).filter(h => h.entropyViolations != null);
    const allRecentClean = recentEntropyData.length >= 3 &&
      recentEntropyData.every(h => h.entropyViolations === 0);
    // Force a scan every 5 sessions (session count is 1-based: 5, 10, 15, ...)
    const isForcedScanSession = filteredHistory.length % 5 === 0;
    const skipEntropyOnClean = allRecentClean && !isForcedScanSession;
    if (allRecentClean && isForcedScanSession) {
      console.log(`[Observability] 📊 Adaptive strategy: entropy scan FORCED (session ${filteredHistory.length} is a multiple of 5 – periodic safety check).`);
    }

    // ── Rule 4: maxExpInjected – experience hit-rate feedback ────────────────
    // If the experience store is injecting context that doesn't correlate with
    // task success (low hit rate), reduce the injection limit to cut prompt noise.
    // If the hit rate is high, increase the limit to leverage more experience.
    //
    // Hit rate = expHitCount / expInjectedCount across recent sessions.
    // Only computed when we have enough data (sessions with non-zero injection).
    //
    // Thresholds (conservative to avoid over-reacting to small samples):
    //   hitRate < 0.20 → reduce to 3 experiences per agent (was 5)
    //   hitRate < 0.30 → reduce to 4 experiences per agent
    //   hitRate > 0.70 → increase to 7 experiences per agent
    //   hitRate > 0.50 → increase to 6 experiences per agent
    //   otherwise      → keep default (5)
    const DEFAULT_MAX_EXP_INJECTED = defaults.maxExpInjected ?? 5;
    let maxExpInjected = DEFAULT_MAX_EXP_INJECTED;

    const sessionsWithExpData = recent.filter(
      h => h.expInjectedCount != null && h.expInjectedCount > 0
    );
    if (sessionsWithExpData.length >= 3) {
      const totalInjected = sessionsWithExpData.reduce((s, h) => s + h.expInjectedCount, 0);
      const totalHits     = sessionsWithExpData.reduce((s, h) => s + (h.expHitCount ?? 0), 0);
      const hitRate = totalHits / totalInjected;

      if (hitRate < 0.20) {
        maxExpInjected = Math.max(DEFAULT_MAX_EXP_INJECTED - 2, 2); // floor at 2
        console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is LOW – reducing maxExpInjected to ${maxExpInjected} (was ${DEFAULT_MAX_EXP_INJECTED}).`);
      } else if (hitRate < 0.30) {
        maxExpInjected = Math.max(DEFAULT_MAX_EXP_INJECTED - 1, 3);
        console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is below threshold – reducing maxExpInjected to ${maxExpInjected}.`);
      } else if (hitRate > 0.70) {
        maxExpInjected = Math.min(DEFAULT_MAX_EXP_INJECTED + 2, 10); // cap at 10
        console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is HIGH – increasing maxExpInjected to ${maxExpInjected}.`);
      } else if (hitRate > 0.50) {
        maxExpInjected = Math.min(DEFAULT_MAX_EXP_INJECTED + 1, 8);
        console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is good – increasing maxExpInjected to ${maxExpInjected}.`);
      } else {
        console.log(`[Observability] 📊 Adaptive strategy: experience hit rate ${(hitRate * 100).toFixed(0)}% is nominal – keeping maxExpInjected at ${maxExpInjected}.`);
      }
    }

    // ── Rule 5: maxClarificationRounds – clarification quality feedback ──────
    // Defect G fix: If clarification effectiveness is persistently low (user gives
    // non-answers, or the requirement barely changes), reduce clarification rounds
    // to save time. If effectiveness is high and there are remaining signals,
    // increase rounds to resolve more ambiguities.
    //
    // Effectiveness score (0-100) combines:
    //   - text change percentage (did anything change?)
    //   - signal resolution (did we fix problems?)
    //   - new signal regression (did we introduce problems?)
    //
    // Thresholds:
    //   avgEffectiveness < 30 → reduce to 1 round (clarification isn't helping)
    //   avgEffectiveness < 50 → reduce to max(default - 1, 1)
    //   avgEffectiveness > 80 AND unresolved signals → increase to min(default + 1, 4)
    //   otherwise → keep default
    const DEFAULT_MAX_CLARIFICATION_ROUNDS = defaults.maxClarificationRounds ?? 2;
    let maxClarificationRounds = DEFAULT_MAX_CLARIFICATION_ROUNDS;

    const sessionsWithClarData = recent.filter(
      h => h.clarificationEffectiveness != null && h.clarificationRounds != null && h.clarificationRounds > 0
    );
    if (sessionsWithClarData.length >= 2) {
      const avgEffectiveness = sessionsWithClarData.reduce(
        (sum, h) => sum + h.clarificationEffectiveness, 0
      ) / sessionsWithClarData.length;

      // Check if any recent sessions had unresolved high-severity signals after clarification
      const hasUnresolvedHighSeverity = sessionsWithClarData.some(
        h => (h.clarificationNewSignals ?? 0) > 0
      );

      if (avgEffectiveness < 30) {
        maxClarificationRounds = 1;
        console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is VERY LOW – reducing maxClarificationRounds to ${maxClarificationRounds} (was ${DEFAULT_MAX_CLARIFICATION_ROUNDS}).`);
      } else if (avgEffectiveness < 50) {
        maxClarificationRounds = Math.max(DEFAULT_MAX_CLARIFICATION_ROUNDS - 1, 1);
        console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is below threshold – reducing maxClarificationRounds to ${maxClarificationRounds}.`);
      } else if (avgEffectiveness > 80 && hasUnresolvedHighSeverity) {
        maxClarificationRounds = Math.min(DEFAULT_MAX_CLARIFICATION_ROUNDS + 1, 4);
        console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is HIGH with unresolved signals – increasing maxClarificationRounds to ${maxClarificationRounds}.`);
      } else {
        console.log(`[Observability] 📊 Adaptive strategy: clarification effectiveness ${avgEffectiveness.toFixed(0)}% is nominal – keeping maxClarificationRounds at ${maxClarificationRounds}.`);
      }
    }

    const changed = maxFixRounds !== defaultStrategy.maxFixRounds ||
                    maxReviewRounds !== defaultStrategy.maxReviewRounds ||
                    skipEntropyOnClean !== defaultStrategy.skipEntropyOnClean ||
                    maxExpInjected !== DEFAULT_MAX_EXP_INJECTED ||
                    maxClarificationRounds !== DEFAULT_MAX_CLARIFICATION_ROUNDS;

    // ── Rule 6: Task complexity modulation (Defect J fix) ───────────────────
    //
    // Rules 1-5 adjust strategy parameters based on HISTORICAL data.
    // Rule 6 applies a CURRENT-SESSION overlay based on the complexity of the
    // task at hand. This solves the core problem: if historical sessions are
    // mostly simple tasks (testFailRate ≈ 0), Rules 1-5 will reduce maxFixRounds
    // to 1. But the current task might be "implement a full auth system" which
    // needs maxFixRounds=4+. Without this rule, the system systematically
    // under-provisions for complex tasks when history is dominated by simple ones.
    //
    // Strategy:
    //   - 'simple'       → no adjustment (history-based values are fine)
    //   - 'moderate'     → ensure maxFixRounds ≥ 2, maxReviewRounds ≥ 2
    //   - 'complex'      → ensure maxFixRounds ≥ 3, maxReviewRounds ≥ 3
    //   - 'very_complex' → ensure maxFixRounds ≥ 4, maxReviewRounds ≥ 3
    //
    // Important: this uses Math.max (floor guarantee), NOT override.
    // If historical data already pushed maxFixRounds to 5, complexity won't
    // reduce it. Complexity only RAISES the floor.
    //
    // The taskComplexity is passed via defaults.taskComplexity by the Orchestrator.
    // At session start (before ANALYSE runs), taskComplexity is null and Rule 6
    // is skipped. The Orchestrator can re-derive strategy after ANALYSE completes
    // with the actual complexity score.
    const taskComplexity = defaults.taskComplexity || null;
    let complexityApplied = false;

    if (taskComplexity && taskComplexity.level) {
      const level = taskComplexity.level;
      const prevFix = maxFixRounds;
      const prevReview = maxReviewRounds;

      if (level === 'moderate') {
        maxFixRounds = Math.max(maxFixRounds, 2);
        maxReviewRounds = Math.max(maxReviewRounds, 2);
      } else if (level === 'complex') {
        maxFixRounds = Math.max(maxFixRounds, 3);
        maxReviewRounds = Math.max(maxReviewRounds, 3);
      } else if (level === 'very_complex') {
        maxFixRounds = Math.max(maxFixRounds, 4);
        maxReviewRounds = Math.max(maxReviewRounds, 3);
      }
      // 'simple' → no adjustment

      complexityApplied = maxFixRounds !== prevFix || maxReviewRounds !== prevReview;
      if (complexityApplied) {
        console.log(`[Observability] 📊 Adaptive strategy: Rule 6 (task complexity=${level}, score=${taskComplexity.score}) raised floors: maxFixRounds ${prevFix}→${maxFixRounds}, maxReviewRounds ${prevReview}→${maxReviewRounds}`);
      }
    }

    // Also use historical complexity data to detect "complexity drift":
    // If recent sessions had consistently high complexity but low fix rounds
    // (indicating under-provisioning), proactively raise the default.
    const sessionsWithComplexity = recent.filter(h => h.taskComplexityScore != null);
    if (sessionsWithComplexity.length >= 3 && !taskComplexity) {
      const avgComplexity = sessionsWithComplexity.reduce((s, h) => s + h.taskComplexityScore, 0) / sessionsWithComplexity.length;
      const complexSessions = sessionsWithComplexity.filter(h => h.taskComplexityScore > 50);
      const complexFailRate = complexSessions.length > 0
        ? complexSessions.filter(h => (h.testFailed ?? 0) > 0).length / complexSessions.length
        : 0;

      // If complex tasks have a higher failure rate than the overall average,
      // the history-based strategy is under-serving complex tasks.
      if (complexFailRate > testFailRate + 0.2 && complexSessions.length >= 2) {
        const driftFix = Math.max(maxFixRounds, Math.min(defaultStrategy.maxFixRounds + 2, 5));
        if (driftFix > maxFixRounds) {
          console.log(`[Observability] 📊 Adaptive strategy: Rule 6b (complexity drift) – complex tasks fail ${(complexFailRate * 100).toFixed(0)}% vs overall ${(testFailRate * 100).toFixed(0)}% – raising maxFixRounds ${maxFixRounds}→${driftFix}`);
          maxFixRounds = driftFix;
          complexityApplied = true;
        }
      }
    }

    const finalChanged = changed || complexityApplied;

    return {
      maxFixRounds,
      maxReviewRounds,
      skipEntropyOnClean,
      maxExpInjected,
      maxClarificationRounds,
      source: finalChanged ? `history(${filteredHistory.length} sessions${projectId ? `, project:${projectId}` : ''}${complexityApplied ? ', complexity-adjusted' : ''})` : 'defaults',
      _debug: {
        testFailRate: Math.round(testFailRate * 100) + '%',
        errorTrend:   trends?.errorTrend ?? 'unknown',
        entropyClean: skipEntropyOnClean,
        sessionCount: filteredHistory.length,
        projectIsolated: projectId ? filteredHistory.length !== history.length : false,
        expHitRate: (() => {
          const s = recent.filter(h => h.expInjectedCount != null && h.expInjectedCount > 0);
          if (s.length < 3) return 'insufficient_data';
          const inj = s.reduce((a, h) => a + h.expInjectedCount, 0);
          const hit = s.reduce((a, h) => a + (h.expHitCount ?? 0), 0);
          return Math.round((hit / inj) * 100) + '%';
        })(),
        clarificationEffectiveness: (() => {
          if (sessionsWithClarData.length < 2) return 'insufficient_data';
          const avg = sessionsWithClarData.reduce((s, h) => s + h.clarificationEffectiveness, 0) / sessionsWithClarData.length;
          return Math.round(avg) + '%';
        })(),
        taskComplexity: taskComplexity ? `${taskComplexity.level}(${taskComplexity.score})` : 'not_available',
      },
    };
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
