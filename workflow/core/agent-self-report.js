/**
 * Agent Self-Report – Prompt-Level Observability for IDE Agent Mode
 *
 * When WorkFlowAgent runs inside an IDE (Cursor, CodeBuddy, Claude Code),
 * the Agent's tool calls are opaque — we cannot intercept them.
 * This module implements "Prompt-Level Self-Report": we inject a prompt
 * instruction asking the Agent to emit a structured JSON block at the
 * end of each stage output, reporting:
 *   - Estimated time spent on the stage
 *   - Key decisions made and their rationale
 *   - Quality self-assessment (confidence level)
 *   - Files read/written (self-reported)
 *   - Blockers or concerns encountered
 *
 * This is the lowest-cost observability approach for IDE Agent mode:
 *   - No IDE plugin needed (avoids all risks from Plan B)
 *   - No additional LLM calls (zero token overhead for collection)
 *   - Works across all IDEs (Cursor, CodeBuddy, Claude Code, Windsurf)
 *   - Relies on model compliance (~85-95% for structured output)
 *
 * Architecture Compliance:
 *   - ADR-37 IDE-First: No self-built tools needed; leverages prompt engineering
 *   - Zero new dependencies
 *   - Integrates with existing Observability and IntrospectionCollector
 *
 * @module agent-self-report
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Self-Report Prompt Instruction ───────────────────────────────────────────

/**
 * The prompt instruction injected into agent prompts when running in IDE mode.
 * Asks the Agent to emit a structured JSON block at the end of its output.
 *
 * Design decisions:
 *   - Uses a fenced code block with `json:self-report` language tag for easy parsing
 *   - Fields are minimal to avoid prompt bloat (~400 chars)
 *   - All fields are optional to maximise compliance rate
 *   - Confidence is a simple 1-5 scale (not percentage) to reduce hallucination
 */
const SELF_REPORT_INSTRUCTION = `
### 📊 Stage Self-Report (MANDATORY)

At the **very end** of your response, you MUST include a self-report block.
This helps track workflow quality and efficiency. Use this exact format:

\`\`\`json:self-report
{
  "stage": "<current stage name>",
  "confidence": <1-5 scale: 1=very uncertain, 3=moderate, 5=very confident>,
  "decisions": [
    {"what": "<key decision made>", "why": "<brief rationale>"}
  ],
  "filesRead": ["<file paths you read>"],
  "filesWritten": ["<file paths you created or modified>"],
  "blockers": ["<any concerns, ambiguities, or blockers encountered>"],
  "qualityNotes": "<brief self-assessment of output quality>"
}
\`\`\`

Rules for self-report:
- Include it as the LAST block in your response
- Be honest about confidence — low confidence is valuable signal
- List ALL files you actually read or wrote (not planned, but actual)
- If no blockers, use an empty array: \`"blockers": []\`
- **TEST stage only**: Add a \`"testSteps"\` field recording each step's execution result:
  \`\`\`json
  "testSteps": {
    "lint": "pass|fail|skip",
    "unitTests": "pass|fail|skip",
    "syntaxCheck": "pass|fail|skip",
    "ideTestRunner": "pass|fail|skip (reason)",
    "cveAudit": "pass|fail|skip (reason)",
    "entropyCheck": "pass|fail|skip (reason)"
  }
  \`\`\`
  Use \`"pass"\` / \`"fail: <brief reason>"\` / \`"skip: <reason>"\` for each step.
  This provides step-level observability without a separate checklist.
`;

// ─── Self-Report Parser ───────────────────────────────────────────────────────

/**
 * Regex to extract the self-report JSON block from agent output.
 * Matches: ```json:self-report ... ```
 * Also matches: ```json:self-report\n{...}\n``` (with or without trailing newline)
 */
const SELF_REPORT_REGEX = /```json:self-report\s*\n([\s\S]*?)```/;

/**
 * Alternative regex for agents that use plain json blocks with a self-report marker.
 * Matches: <!-- self-report --> ```json ... ```
 */
const SELF_REPORT_ALT_REGEX = /<!--\s*self-report\s*-->\s*```json\s*\n([\s\S]*?)```/;

/**
 * Parses a self-report JSON block from agent output text.
 *
 * @param {string} agentOutput - The full agent output text
 * @returns {{ found: boolean, report: object|null, raw: string|null, parseError: string|null }}
 */
function parseSelfReport(agentOutput) {
  if (!agentOutput || typeof agentOutput !== 'string') {
    return { found: false, report: null, raw: null, parseError: null };
  }

  // Try primary regex first
  let match = SELF_REPORT_REGEX.exec(agentOutput);
  if (!match) {
    // Try alternative format
    match = SELF_REPORT_ALT_REGEX.exec(agentOutput);
  }

  if (!match) {
    return { found: false, report: null, raw: null, parseError: null };
  }

  const raw = match[1].trim();

  try {
    const report = JSON.parse(raw);
    const validated = validateSelfReport(report);
    return { found: true, report: validated, raw, parseError: null };
  } catch (err) {
    return { found: true, report: null, raw, parseError: err.message };
  }
}

/**
 * Validates and normalises a parsed self-report object.
 * Ensures all expected fields exist with sensible defaults.
 *
 * @param {object} report - Raw parsed JSON
 * @returns {object} Normalised self-report
 */
function validateSelfReport(report) {
  return {
    stage: typeof report.stage === 'string' ? report.stage : 'unknown',
    confidence: _clamp(Number(report.confidence) || 3, 1, 5),
    decisions: Array.isArray(report.decisions)
      ? report.decisions.filter(d => d && typeof d.what === 'string').slice(0, 10)
      : [],
    filesRead: Array.isArray(report.filesRead)
      ? report.filesRead.filter(f => typeof f === 'string').slice(0, 50)
      : [],
    filesWritten: Array.isArray(report.filesWritten)
      ? report.filesWritten.filter(f => typeof f === 'string').slice(0, 50)
      : [],
    blockers: Array.isArray(report.blockers)
      ? report.blockers.filter(b => typeof b === 'string').slice(0, 10)
      : [],
    qualityNotes: typeof report.qualityNotes === 'string'
      ? report.qualityNotes.slice(0, 500)
      : '',
    // TEST stage step-level execution results (P1: step-level observability)
    testSteps: report.testSteps && typeof report.testSteps === 'object'
      ? _validateTestSteps(report.testSteps)
      : undefined,
  };
}

// ─── Code-Forced Self-Report Builder (Plan A: 100% Compliance) ────────────────
//
// The original design relied on LLM compliance to emit a json:self-report block
// at the end of each stage output. Actual compliance: 0% across 125 attempts.
//
// Plan A replaces this with deterministic extraction from existing data sources:
//   - Artifact validation (hash, lineCount, path)
//   - Socratic challenge (confidence, questions, blindSpots)
//   - Metrics gate (passed, errors, duration, llmCalls)
//   - Trace events (stage_start/stage_end timestamps, stageInput)
//   - code.diff parsing (filesWritten for DEVELOP stage)
//
// Result: 100% compliance rate, zero LLM dependency, richer data.

/**
 * Builds a self-report from deterministic data sources available at stage-complete time.
 *
 * This is the Plan A replacement for prompt-based self-report collection.
 * All data comes from code-enforced gates that already run in stage-complete:
 *   - artifactValidation: from _validateArtifact() — hash, lineCount, path
 *   - socraticResult: from runSocraticChallenge() — confidence, questions, blindSpots
 *   - metricsGate: from runQualityGate() — passed, errors, duration
 *   - traceEvents: from workflow-trace.jsonl — stage_start/stage_end timestamps
 *
 * @param {object} opts
 * @param {string} opts.stage - Stage name (ANALYSE, ARCHITECT, etc.)
 * @param {string} opts.session - Session ID
 * @param {object} [opts.artifactValidation] - Result from _validateArtifact()
 * @param {object} [opts.socraticResult] - Result from runSocraticChallenge()
 * @param {object} [opts.metricsGate] - Result from runQualityGate()
 * @param {Array}  [opts.traceEvents] - Recent trace events for this session
 * @param {string} [opts.summary] - User-provided summary from stage-complete args
 * @param {string} [opts.projectRoot] - Project root for code.diff parsing
 * @returns {object} Normalised self-report compatible with validateSelfReport() output
 */
function buildCodeForcedReport({
  stage,
  session,
  artifactValidation = {},
  socraticResult = null,
  metricsGate = null,
  traceEvents = [],
  summary = '',
  projectRoot = '.',
}) {
  // ── confidence: from Socratic challenge (1-5 scale) ──
  const socData = socraticResult?.data || socraticResult || {};
  const rawConfidence = socData.confidence;
  // Socratic confidence is 0-100 or 0-5 depending on version; normalise to 1-5
  const confidence = typeof rawConfidence === 'number'
    ? (rawConfidence > 5 ? _clamp(Math.round(rawConfidence / 20), 1, 5) : _clamp(rawConfidence, 1, 5))
    : 3; // default moderate if no socratic data

  // ── decisions: extract from socratic questions (these are the decision points challenged) ──
  const questions = socData.questions || [];
  const decisions = questions.slice(0, 5).map(q => ({
    what: typeof q === 'string' ? q.slice(0, 120) : (q.question || q.text || String(q)).slice(0, 120),
    why: 'Socratic challenge — decision point identified by rule-based quality gate',
  }));

  // ── filesWritten: from artifact path + code.diff parsing ──
  const filesWritten = [];
  if (artifactValidation.artifactPath) {
    filesWritten.push(artifactValidation.artifactPath);
  }
  // For DEVELOP stage, parse code.diff to extract modified files
  if (stage === 'DEVELOP' || stage === 'CODE') {
    try {
      const diffPath = path.join(projectRoot, 'output', 'code.diff');
      if (fs.existsSync(diffPath)) {
        const diffContent = fs.readFileSync(diffPath, 'utf-8');
        const diffFiles = diffContent.match(/^(?:---|\/\/\/) [ab]\/(.+)$/gm);
        if (diffFiles) {
          const uniqueFiles = [...new Set(diffFiles.map(f => f.replace(/^(?:---|\/\/\/) [ab]\//, '')))];
          filesWritten.push(...uniqueFiles.slice(0, 30));
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── filesRead: from trace stage_start event's stageInput ──
  const filesRead = [];
  const stageStartEvent = traceEvents.find(ev => ev.event === 'stage_start' && ev.stage === stage);
  if (stageStartEvent) {
    // Extract file paths from stageInput or summary
    const inputText = stageStartEvent.summary || stageStartEvent.stageInput || '';
    const pathMatches = inputText.match(/(?:output\/[\w.-]+|[\w/.-]+\.[a-z]{1,5})/g);
    if (pathMatches) {
      filesRead.push(...[...new Set(pathMatches)].slice(0, 20));
    }
  }

  // ── blockers: from socratic blindSpots ──
  const blindSpots = socData.blindSpots || [];
  const blockers = blindSpots.slice(0, 5).map(bs =>
    typeof bs === 'string' ? bs : (bs.description || bs.text || String(bs))
  );

  // ── qualityNotes: composite from metrics gate + artifact validation ──
  const qualityParts = [];
  if (metricsGate) {
    const mgData = metricsGate.data || metricsGate;
    const passed = mgData.passed !== false;
    qualityParts.push(`Metrics: ${passed ? 'PASSED' : 'FAILED'}`);
    if (mgData.errorCount != null) qualityParts.push(`errors=${mgData.errorCount}`);
    if (mgData.durationMs != null) qualityParts.push(`duration=${Math.round(mgData.durationMs / 1000)}s`);
  }
  if (artifactValidation.valid && !artifactValidation.skipped) {
    qualityParts.push(`Artifact: ${artifactValidation.lineCount} lines, hash=${artifactValidation.hash}`);
    if (artifactValidation.evidenceVerified) qualityParts.push('ADR-37 evidence verified');
  }
  if (summary) {
    qualityParts.push(summary.slice(0, 200));
  }
  const qualityNotes = qualityParts.join('; ') || 'No quality data available';

  // ── Compute duration from trace events ──
  const stageEndEvent = traceEvents.find(ev => ev.event === 'stage_end' && ev.stage === stage);
  let durationMs = null;
  if (stageStartEvent?.ts && stageEndEvent?.ts) {
    try {
      durationMs = new Date(stageEndEvent.ts).getTime() - new Date(stageStartEvent.ts).getTime();
    } catch { /* ignore */ }
  }

  return {
    stage,
    confidence,
    decisions,
    filesRead: [...new Set(filesRead)],
    filesWritten: [...new Set(filesWritten)],
    blockers,
    qualityNotes,
    // Extended fields (not in original self-report schema but valuable)
    _codeForcedMeta: {
      source: 'code-forced',
      session,
      artifactHash: artifactValidation.hash || null,
      artifactLines: artifactValidation.lineCount || null,
      socraticConfidence: rawConfidence,
      socraticQuestionCount: questions.length,
      blindSpotCount: blindSpots.length,
      durationMs,
      metricsGatePassed: metricsGate ? (metricsGate.data?.passed !== false) : null,
    },
  };
}

// ─── Self-Report Collector ────────────────────────────────────────────────────

/**
 * Collects self-reports across stages within a single workflow session.
 * Designed to be instantiated once per session and flushed at teardown.
 */
class AgentSelfReportCollector {
  constructor(options = {}) {
    /** @type {object[]} Collected self-reports */
    this._reports = [];
    /** @type {string|null} Session ID */
    this._sessionId = options.sessionId || null;
    /** @type {string|null} Output directory */
    this._outputDir = options.outputDir || null;
    /** @type {boolean} Whether collection is enabled */
    this._enabled = options.enabled !== false;
    /** @type {object} Compliance statistics */
    this._stats = {
      stagesTotal: 0,
      stagesWithReport: 0,
      parseErrors: 0,
      avgConfidence: 0,
    };
  }

  /**
   * Records a self-report from agent output (legacy: prompt-based parsing).
   *
   * @param {string} stageName - Current workflow stage
   * @param {string} agentOutput - Full agent output text
   * @param {object} [meta] - Additional metadata (agentRole, durationMs, etc.)
   * @returns {{ found: boolean, report: object|null }}
   */
  record(stageName, agentOutput, meta = {}) {
    if (!this._enabled) return { found: false, report: null };

    this._stats.stagesTotal++;

    const { found, report, raw, parseError } = parseSelfReport(agentOutput);

    if (!found) {
      this._reports.push({
        stage: stageName,
        timestamp: new Date().toISOString(),
        found: false,
        report: null,
        meta,
      });
      return { found: false, report: null };
    }

    if (parseError) {
      this._stats.parseErrors++;
      this._reports.push({
        stage: stageName,
        timestamp: new Date().toISOString(),
        found: true,
        parseError,
        raw: raw ? raw.slice(0, 200) : null, // Truncate for debugging
        report: null,
        meta,
      });
      return { found: true, report: null };
    }

    this._stats.stagesWithReport++;
    this._reports.push({
      stage: stageName,
      timestamp: new Date().toISOString(),
      found: true,
      report,
      meta,
    });

    // Update running average confidence
    this._stats.avgConfidence = this._reports
      .filter(r => r.report?.confidence)
      .reduce((sum, r, _, arr) => sum + r.report.confidence / arr.length, 0);

    return { found: true, report };
  }

  /**
   * Records a code-forced self-report (Plan A: 100% compliance).
   *
   * Unlike record() which parses LLM output (0% compliance), this method
   * accepts a pre-built report from buildCodeForcedReport() — constructed
   * entirely from deterministic data sources in stage-complete.
   *
   * @param {string} stageName - Current workflow stage
   * @param {object} report - Pre-built report from buildCodeForcedReport()
   * @param {object} [meta] - Additional metadata
   * @returns {{ found: boolean, report: object }}
   */
  recordCodeForced(stageName, report, meta = {}) {
    if (!this._enabled) return { found: false, report: null };

    this._stats.stagesTotal++;
    this._stats.stagesWithReport++;

    this._reports.push({
      stage: stageName,
      timestamp: new Date().toISOString(),
      found: true,
      source: 'code-forced',
      report,
      meta,
    });

    // Update running average confidence
    this._stats.avgConfidence = this._reports
      .filter(r => r.report?.confidence)
      .reduce((sum, r, _, arr) => sum + r.report.confidence / arr.length, 0);

    return { found: true, report };
  }

  /**
   * Returns all collected reports.
   * @returns {object[]}
   */
  getReports() {
    return [...this._reports];
  }

  /**
   * Returns compliance and quality statistics.
   * @returns {object}
   */
  getStats() {
    const complianceRate = this._stats.stagesTotal > 0
      ? (this._stats.stagesWithReport / this._stats.stagesTotal * 100).toFixed(1)
      : '0.0';

    return {
      ...this._stats,
      complianceRate: `${complianceRate}%`,
    };
  }

  /**
   * Returns a compact summary suitable for dashboard display.
   * @returns {string}
   */
  getSummary() {
    const stats = this.getStats();
    const lines = [
      `📊 Agent Self-Report Summary`,
      `   Compliance: ${stats.complianceRate} (${stats.stagesWithReport}/${stats.stagesTotal} stages)`,
      `   Avg Confidence: ${stats.avgConfidence.toFixed(1)}/5`,
      `   Parse Errors: ${stats.parseErrors}`,
    ];

    // List blockers across all stages
    const allBlockers = this._reports
      .filter(r => r.report?.blockers?.length > 0)
      .flatMap(r => r.report.blockers.map(b => `[${r.stage}] ${b}`));

    if (allBlockers.length > 0) {
      lines.push(`   ⚠️ Blockers reported:`);
      allBlockers.slice(0, 5).forEach(b => lines.push(`      - ${b}`));
    }

    return lines.join('\n');
  }

  /**
   * Persists collected reports to disk as JSONL.
   * File: <outputDir>/agent-self-reports.jsonl
   *
   * @returns {number} Number of reports written
   */
  flush() {
    if (!this._outputDir || this._reports.length === 0) return 0;

    const filePath = path.join(this._outputDir, 'agent-self-reports.jsonl');

    try {
      // Ensure output directory exists
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }

      const lines = this._reports.map(r => JSON.stringify({
        sessionId: this._sessionId,
        ...r,
      }));

      fs.appendFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
      console.log(`[AgentSelfReport] 📊 ${this._reports.length} report(s) persisted to ${filePath}`);
      return this._reports.length;
    } catch (err) {
      console.warn(`[AgentSelfReport] ⚠️ Failed to persist reports: ${err.message}`);
      return 0;
    }
  }

  /**
   * Resets the collector for a new session.
   * @param {object} [options]
   */
  reset(options = {}) {
    this._reports = [];
    this._sessionId = options.sessionId || this._sessionId;
    this._outputDir = options.outputDir || this._outputDir;
    this._stats = {
      stagesTotal: 0,
      stagesWithReport: 0,
      parseErrors: 0,
      avgConfidence: 0,
    };
  }
}

// ─── Singleton Instance ───────────────────────────────────────────────────────

const selfReportCollector = new AgentSelfReportCollector();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validates and normalises the testSteps field from a TEST stage self-report.
 * Accepts only known step keys, truncates values to 200 chars.
 *
 * @param {object} steps - Raw testSteps object from self-report
 * @returns {object} Normalised testSteps
 */
const VALID_TEST_STEP_KEYS = ['lint', 'unitTests', 'syntaxCheck', 'ideTestRunner', 'cveAudit', 'entropyCheck'];

function _validateTestSteps(steps) {
  const result = {};
  for (const key of VALID_TEST_STEP_KEYS) {
    if (typeof steps[key] === 'string') {
      result[key] = steps[key].slice(0, 200);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  SELF_REPORT_INSTRUCTION,
  parseSelfReport,
  validateSelfReport,
  buildCodeForcedReport,
  AgentSelfReportCollector,
  selfReportCollector,
};
