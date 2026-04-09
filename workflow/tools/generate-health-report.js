#!/usr/bin/env node
/**
 * generate-health-report.js
 *
 * Standalone health report generator.
 * Reads workflow-trace.jsonl and generates health-report.md
 * WITHOUT requiring Orchestrator initialization (no network calls, no LLM).
 *
 * Usage:
 *   node workflow/tools/generate-health-report.js [--output-dir ./output] [--run-category prod|test|diag] [--session <id>] [--project-root <dir>]
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getConfig } = require('../core/config-loader');
const { resolveHealthPaths, normalizeRunCategory } = require('../core/health-observability');
const { computeHealthScore, createHealthScoringModel, toFiniteNumber, clampScore } = require('../core/health-score-model');

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf-8').digest('hex');
}

function fileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false, path: filePath || null, size: 0, hash: null, mtime: null };
  }
  const stat = fs.statSync(filePath);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return {
    exists: true,
    path: filePath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    hash: sha256(raw),
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
};

const outputDirArg = getArg('--output-dir');
const outputDir = path.resolve(outputDirArg || path.join(__dirname, '../../output'));
const sessionFilter = getArg('--session') || null; // null = use latest session
const projectRoot = path.resolve(getArg('--project-root') || path.join(__dirname, '../..'));
const workflowConfig = getConfig(projectRoot, true);
const hmConfig = workflowConfig?.healthMonitoring || {};
const scoringConfig = hmConfig.scoring || {};
const trendConfig = hmConfig.trend || {};

const runCategory = normalizeRunCategory(getArg('--run-category'));
const healthPaths = resolveHealthPaths({ outputDir, runCategory });
const healthDir = healthPaths.healthDir;

let tracePath = healthPaths.tracePath;
let healthReportPath = healthPaths.healthReportPath;
let evolutionLogPath = healthPaths.evolutionLogPath;
let qualityReportPath = healthPaths.qualityReportPath;
let healthHistoryPath = healthPaths.healthHistoryPath;

const trendEnabled = trendConfig.enabled !== false;
const trendWindowSize = Math.max(2, Math.floor(toFiniteNumber(trendConfig.windowSize, 5)));
const trendMinSessions = Math.max(2, Math.floor(toFiniteNumber(trendConfig.minSessions, 3)));
const trendDegradationThreshold = Math.max(0, toFiniteNumber(trendConfig.degradationThreshold, 8));
const trendLowScoreThreshold = clampScore(toFiniteNumber(trendConfig.lowScoreThreshold, 75));
const trendMaxHistoryEntries = Math.max(20, Math.floor(toFiniteNumber(trendConfig.maxHistoryEntries, 200)));

// ─── Read Trace ───────────────────────────────────────────────────────────────

if (!fs.existsSync(tracePath)) {
  console.error(`[HealthReport] ❌ Trace file not found for runCategory=${runCategory}: ${tracePath}`);
  process.exit(1);
}

const rawLines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
const allEvents = rawLines.map(line => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

if (allEvents.length === 0) {
  console.error(`[HealthReport] ❌ No events found in trace file`);
  process.exit(1);
}

// Determine which session to use
let sessionId = sessionFilter;
if (!sessionId) {
  // Use the latest COMPLETE session (has at least one stage_end event).
  // This prevents "ghost sessions" (e.g. from runTraceSessionStart test calls or
  // socratic-challenge test runs) from being picked as the "latest" session when
  // they only have a workflow_start but no actual stage execution.
  //
  // Selection priority:
  //   1. Latest session with workflow_start + at least 1 stage_end (complete run)
  //   2. Latest session with workflow_start only (incomplete but real)
  //   3. Any session (fallback)
  //
  // Filter out: sessions ending in -test, entryHint=TEST, entryHint=EVAL_SCRIPT
  const workflowStarts = allEvents.filter(e => e.event === 'workflow_start');
  const realStarts = workflowStarts.filter(e => {
    const hint = e.data?.callStack?.entryHint || '';
    return !e.session?.endsWith('-test')
      && hint !== 'TEST'
      && hint !== 'EVAL_SCRIPT';
  });
  const candidateStarts = realStarts.length > 0 ? realStarts : workflowStarts;

  // Build a set of sessions that have at least one stage_end event
  const sessionsWithStageEnd = new Set(
    allEvents.filter(e => e.event === 'stage_end' || e.event === 'stage_error').map(e => e.session)
  );

  // Prefer sessions with actual stage execution (complete runs)
  const completeStarts = candidateStarts.filter(e => sessionsWithStageEnd.has(e.session));
  const targetStarts = completeStarts.length > 0 ? completeStarts : candidateStarts;

  if (targetStarts.length > 0) {
    sessionId = targetStarts[targetStarts.length - 1].session;
  } else {
    sessionId = allEvents[allEvents.length - 1].session;
  }
}

const events = allEvents.filter(e => e.session === sessionId);
console.log(`[HealthReport] 📖 Session: ${sessionId}`);
console.log(`[HealthReport] 📊 Events: ${events.length} (from ${allEvents.length} total)`);

// ─── Parse Events ─────────────────────────────────────────────────────────────

const workflowStartEvt = events.find(e => e.event === 'workflow_start');
const workflowEndEvt   = events.find(e => e.event === 'workflow_end');
const stageStartEvts   = events.filter(e => e.event === 'stage_start');
const stageEndEvts     = events.filter(e => e.event === 'stage_end' || e.event === 'stage_error');

// De-duplicate stage_start: keep only the LAST start event per stage
// (handles cases where IDE Agent re-ran a stage or wrote duplicate trace events)
const stageStartMap = new Map();
stageStartEvts.forEach(e => { stageStartMap.set(e.stage, e); });
const dedupedStageStartEvts = Array.from(stageStartMap.values())
  .sort((a, b) => a.seq - b.seq);
const socraticEvts     = events.filter(e => e.event === 'socratic_challenge');
const errorEvts        = events.filter(e => e.event === 'error');

const userData = workflowStartEvt?.data || {};
const endData  = workflowEndEvt?.data || {};
const observationMainline = Array.isArray(userData.observationMainline) && userData.observationMainline.length > 0
  ? userData.observationMainline
  : ['goal', 'tool', 'plan', 'execute', 'evaluate', 'retry'];

// Completeness check
const EXPECTED_STAGES = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'];
const presentStages = [];
const missingStages = [];

for (const stage of EXPECTED_STAGES) {
  const hasStart = stageStartEvts.some(e => e.stage === stage);
  const hasEnd   = stageEndEvts.some(e => e.stage === stage);
  if (hasStart && hasEnd) {
    presentStages.push(stage);
  } else {
    missingStages.push(`${stage} (${hasStart ? '✓start' : '✗start'}/${hasEnd ? '✓end' : '✗end'})`);
  }
}

const completenessOk = missingStages.length === 0;

// Socratic coverage: how many completed stages have a socratic_challenge event?
const socraticCoveredStages = presentStages.filter(s => socraticEvts.some(e => e.stage === s));
const socraticCoverage = presentStages.length > 0
  ? socraticCoveredStages.length / presentStages.length
  : 0;

const challengedStages = Array.from(new Set(
  socraticEvts
    .filter(e => e.data?.challenged !== false)
    .map(e => e.stage)
    .filter(Boolean)
));

const effectiveChallengeStages = Array.from(new Set(
  socraticEvts
    .filter(e => e.data?.challenged !== false && e.data?.effectiveChallenge === true)
    .map(e => e.stage)
    .filter(Boolean)
));

const effectiveChallengeRate = challengedStages.length > 0
  ? effectiveChallengeStages.length / challengedStages.length
  : 1;
const scoreModel = createHealthScoringModel(scoringConfig);
const weights = scoreModel.weights;
const penalties = scoreModel.penalties;
const thresholds = scoreModel.thresholds;

// Socratic penalty: config-driven max penalty
const socraticPenalty = Math.round((1 - socraticCoverage) * penalties.socraticMax);

// Metrics Gate: collect per-stage gate results from stage_end events
// IDE Agent mode embeds metricsGate into data field of stage_end events
const stageMetricsGateResults = {}; // stageName -> { passed, failedGates, gates }
stageEndEvts.forEach(e => {
  if (e.data?.metricsGate) {
    stageMetricsGateResults[e.stage] = e.data.metricsGate;
  }
});
const stagesWithGateFailures = Object.entries(stageMetricsGateResults)
  .filter(([, r]) => !r.passed)
  .map(([s]) => s);
const metricsGatePenalty = Math.min(
  penalties.metricsGateMax,
  stagesWithGateFailures.length * penalties.metricsGatePerFailedStage
);

const completenessScore = completenessOk
  ? 100
  : Math.max(0, 100 - missingStages.length * penalties.missingStage);
const processScore = Math.max(0, 100 - socraticPenalty - metricsGatePenalty);

let qualityOverallScore = null;
let qualityDeliveryScore = null;
let qualityDetectionScore = null;

try {
  if (fs.existsSync(qualityReportPath)) {
    const qualityContent = fs.readFileSync(qualityReportPath, 'utf-8');
    const overallMatch = qualityContent.match(/\|\s*Overall Quality Score\s*\|\s*\*\*(\d+(?:\.\d+)?)\*\*/i);
    const deliveryMatch = qualityContent.match(/\|\s*Delivery Score\s*\|\s*(\d+(?:\.\d+)?)\s*\|/i);
    const detectionMatch = qualityContent.match(/\|\s*Detection Score\s*\|\s*(\d+(?:\.\d+)?)\s*\|/i);

    if (overallMatch) qualityOverallScore = parseFloat(overallMatch[1]);
    if (deliveryMatch) qualityDeliveryScore = parseFloat(deliveryMatch[1]);
    if (detectionMatch) qualityDetectionScore = parseFloat(detectionMatch[1]);
  }
} catch {
  // Ignore quality parsing errors and fallback to process/completeness-only scoring
}

const deliveryScore = Number.isFinite(qualityDeliveryScore)
  ? qualityDeliveryScore
  : (Number.isFinite(qualityOverallScore) ? qualityOverallScore : processScore);
const detectionScore = Number.isFinite(qualityDetectionScore)
  ? qualityDetectionScore
  : (Number.isFinite(qualityOverallScore) ? qualityOverallScore : processScore);

const scoreResult = computeHealthScore({
  completenessOk,
  missingStages,
  presentStages,
  socraticCoveredStages,
  challengedStages,
  effectiveChallengeStages,
  failedGateStages: stagesWithGateFailures,
  deliveryScore,
  detectionScore,
  scoringConfig,
});
const healthScore = scoreResult.score;
const healthGrade = scoreResult.grade;
const gradeEmoji  = healthGrade === 'A' ? '🟢' : healthGrade === 'B' ? '🟡' : healthGrade === 'C' ? '🟠' : healthGrade === 'D' ? '🔴' : '⛔';
// Count total stages that have metrics gate data (IDE Agent mode)
const stagesWithGateData = Object.keys(stageMetricsGateResults).length;

// ── Rolling Trend (B) ──────────────────────────────────────────────────────
let historyEntries = [];
if (trendEnabled && fs.existsSync(healthHistoryPath)) {
  try {
    const raw = fs.readFileSync(healthHistoryPath, 'utf-8').trim();
    if (raw) {
      historyEntries = raw.split('\n').map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    }
  } catch {
    historyEntries = [];
  }
}

historyEntries = historyEntries.filter(e => e && e.sessionId !== sessionId);
const currentTrendEntry = {
  ts: new Date().toISOString(),
  sessionId,
  runCategory,
  healthScore,
  healthGrade,
  scoringModel: scoringConfig.model || 'unified-v1',
};
historyEntries.push(currentTrendEntry);
if (historyEntries.length > trendMaxHistoryEntries) {
  historyEntries = historyEntries.slice(-trendMaxHistoryEntries);
}

const recentWindow = historyEntries.slice(-trendWindowSize);
const previousWindow = historyEntries.slice(-trendWindowSize * 2, -trendWindowSize);
const recentAvg = recentWindow.length > 0
  ? recentWindow.reduce((sum, e) => sum + (Number(e.healthScore) || 0), 0) / recentWindow.length
  : null;
const previousAvg = previousWindow.length > 0
  ? previousWindow.reduce((sum, e) => sum + (Number(e.healthScore) || 0), 0) / previousWindow.length
  : null;
const trendDelta = (recentAvg != null && previousAvg != null)
  ? Number((recentAvg - previousAvg).toFixed(1))
  : null;

const enoughSessionsForAlert = historyEntries.length >= Math.max(trendMinSessions, trendWindowSize);
const trendDirection = trendDelta == null
  ? 'insufficient_data'
  : trendDelta <= -trendDegradationThreshold
    ? 'degrading'
    : trendDelta >= trendDegradationThreshold
      ? 'improving'
      : 'stable';

const trendAlertTriggered = !!(
  trendEnabled &&
  enoughSessionsForAlert &&
  (trendDirection === 'degrading' || healthScore < trendLowScoreThreshold)
);

const trendAlertMessage = !trendEnabled
  ? 'Trend alert disabled by config'
  : !enoughSessionsForAlert
    ? `Insufficient history (${historyEntries.length}/${Math.max(trendMinSessions, trendWindowSize)} sessions)`
    : trendDirection === 'degrading'
      ? `Rolling-window degradation detected (${trendDelta} pts, window=${trendWindowSize})`
      : healthScore < trendLowScoreThreshold
        ? `Latest health score ${healthScore.toFixed(1)} is below threshold ${trendLowScoreThreshold}`
        : 'No trend alert';

// Event type counts
const eventTypeCounts = {};
events.forEach(e => { eventTypeCounts[e.event] = (eventTypeCounts[e.event] || 0) + 1; });

// Duration
const startTs = workflowStartEvt ? new Date(workflowStartEvt.ts).getTime() : null;
const endTs   = workflowEndEvt   ? new Date(workflowEndEvt.ts).getTime()   : null;
const durationMs = (startTs && endTs) ? endTs - startTs : (endData.totalDuration || 0);

const stageArtifactMap = {
  ANALYSE: path.join(outputDir, 'analysis.md'),
  ARCHITECT: path.join(outputDir, 'architecture.md'),
  PLAN: path.join(outputDir, 'execution-plan.md'),
  CODE: path.join(outputDir, 'code.diff'),
  TEST: path.join(outputDir, 'test-report.md'),
};

const evidenceArtifacts = Object.entries(stageArtifactMap).map(([stage, filePath]) => ({
  stage,
  ...fileFingerprint(filePath),
}));

const evidenceProtocol = {
  protocolVersion: 'evidence-v1',
  generatedAt: new Date().toISOString(),
  sessionId,
  runCategory,
  traceFingerprint: fileFingerprint(tracePath),
  qualityReportFingerprint: fileFingerprint(qualityReportPath),
  evolutionLogFingerprint: fileFingerprint(evolutionLogPath),
  stageArtifacts: evidenceArtifacts,
  verification: {
    missingStageArtifacts: evidenceArtifacts.filter(a => !a.exists).map(a => a.stage),
    stageCount: evidenceArtifacts.length,
    completedStages: presentStages.length,
  },
};

// ─── Build Report ─────────────────────────────────────────────────────────────

const lines = [];

lines.push(`# 🏥 System Health Monitoring Report`);
lines.push(``);
lines.push(`> Generated: ${new Date().toISOString()}`);
lines.push(`> Session ID: \`${sessionId}\``);
lines.push(`> Run Category: \`${runCategory}\``);
lines.push(``);
lines.push(`---`);
lines.push(``);

// ── User Input ────────────────────────────────────────────────────────────────
lines.push(`## 📝 User Input`);
lines.push(``);
lines.push(`| Field | Value |`);
lines.push(`|-------|-------|`);
lines.push(`| **Requirement** | ${userData.requirement || 'N/A'} |`);
lines.push(`| **Entry Point** | \`${userData.callStack?.entryHint || 'unknown'}\` |`);
lines.push(`| **Mode** | \`${userData.mode || 'sequential'}\` |`);
lines.push(``);

if (userData.userInput) {
  lines.push(`### Full User Input`);
  lines.push(``);
  lines.push('```');
  lines.push(userData.userInput.slice(0, 500));
  lines.push('```');
  lines.push(``);
}

lines.push(`---`);
lines.push(``);

// ── Unified Observation Mainline ─────────────────────────────────────────────
const mainlineStageMap = {};
observationMainline.forEach(step => { mainlineStageMap[step] = []; });

stageStartEvts.forEach(evt => {
  const step = evt?.data?.mainlinePhase;
  if (!step || !mainlineStageMap[step]) return;
  if (!mainlineStageMap[step].includes(evt.stage)) {
    mainlineStageMap[step].push(evt.stage);
  }
});

lines.push(`## 🎯 Unified Observation Mainline`);
lines.push(``);
lines.push(`| # | Mainline Step | Mapped Stage(s) | Status |`);
lines.push(`|---|---------------|-----------------|--------|`);
observationMainline.forEach((step, idx) => {
  const mappedStages = mainlineStageMap[step] || [];
  const mappedText = mappedStages.length > 0 ? mappedStages.map(s => `\`${s}\``).join(', ') : '-';
  const complete = mappedStages.length > 0 && mappedStages.some(stage =>
    stageEndEvts.some(e => e.stage === stage)
  );
  const status = complete ? '✅ observed' : '⬜ pending';
  lines.push(`| ${idx + 1} | \`${step}\` | ${mappedText} | ${status} |`);
});
lines.push(``);

lines.push(`---`);
lines.push(``);

// ── Completeness Check ────────────────────────────────────────────────────────
lines.push(`## 📋 Completeness Check`);
lines.push(``);
lines.push(`| Check | Status |`);
lines.push(`|-------|--------|`);
lines.push(`| Workflow Start | ${workflowStartEvt ? '✅' : '❌'} |`);
lines.push(`| Workflow End | ${workflowEndEvt ? '✅' : '❌'} |`);

EXPECTED_STAGES.forEach(stage => {
  const ok = presentStages.includes(stage);
  lines.push(`| Stage: ${stage} | ${ok ? '✅' : '❌'} |`);
});

lines.push(`| **Overall Status** | **${completenessOk ? '✅ PASSED' : '⚠️ INCOMPLETE'}** |`);
lines.push(``);

if (presentStages.length > 0) {
  lines.push(`**Stages Completed:** ${presentStages.map(s => `\`${s}\``).join(', ')}`);
  lines.push(``);
}
if (missingStages.length > 0) {
  lines.push(`**⚠️ Missing Stages:** ${missingStages.map(s => `\`${s}\``).join(', ')}`);
  lines.push(``);
}

lines.push(`---`);
lines.push(``);

// ── Event Statistics ──────────────────────────────────────────────────────────
lines.push(`## 📊 Event Statistics`);
lines.push(``);
lines.push(`| Metric | Value |`);
lines.push(`|--------|-------|`);
lines.push(`| Total Events | ${events.length} |`);
lines.push(`| Stage Starts | ${dedupedStageStartEvts.length} (raw: ${stageStartEvts.length}) |`);
lines.push(`| Stage Ends | ${stageEndEvts.length} |`);
const socraticCoverageStr = presentStages.length > 0
  ? `${socraticCoveredStages.length}/${presentStages.length} stages (${(socraticCoverage * 100).toFixed(0)}%)`
  : '0/0';
lines.push(`| Socratic Checks | ${socraticEvts.length} (coverage: ${socraticCoverageStr}) |`);
lines.push(`| Effective Challenge Rate | ${(effectiveChallengeRate * 100).toFixed(0)}% (${effectiveChallengeStages.length}/${challengedStages.length || 0}) |`);
lines.push(`| Errors | ${errorEvts.length} |`);
lines.push(`| Duration | ${(durationMs / 1000).toFixed(2)}s |`);
lines.push(``);

lines.push(`### Event Types Distribution`);
lines.push(``);
lines.push(`| Event Type | Count |`);
lines.push(`|------------|-------|`);
Object.entries(eventTypeCounts).forEach(([type, count]) => {
  lines.push(`| \`${type}\` | ${count} |`);
});
lines.push(``);

lines.push(`---`);
lines.push(``);

// ── Health Score ──────────────────────────────────────────────────────────────
lines.push(`## 🏥 Health Score`);
lines.push(``);
lines.push(`| **Grade** | Score | Status |`);
lines.push(`|-------|-------|--------|`);
const overallStatus = completenessOk && socraticPenalty === 0 && metricsGatePenalty === 0
  ? 'Healthy'
  : !completenessOk ? 'Incomplete' : 'Partial';
lines.push(`| **${healthGrade}** | ${healthScore}/100 | ${gradeEmoji} ${overallStatus} |`);
lines.push(``);
lines.push(`### Unified Scoring (Model: ${scoringConfig.model || 'unified-v1'})`);
lines.push(``);
lines.push(`| Component | Score | Weight | Weighted |`);
lines.push(`|-----------|-------|--------|----------|`);
lines.push(`| Completeness | ${completenessScore.toFixed(1)} | ${(weights.completeness * 100).toFixed(0)}% | ${(completenessScore * weights.completeness).toFixed(1)} |`);
lines.push(`| Process (Socratic + Metrics Gate + Effectiveness) | ${processScore.toFixed(1)} | ${(weights.process * 100).toFixed(0)}% | ${(processScore * weights.process).toFixed(1)} |`);
lines.push(`| Delivery (Quality) | ${deliveryScore.toFixed(1)} | ${(weights.delivery * 100).toFixed(0)}% | ${(deliveryScore * weights.delivery).toFixed(1)} |`);
lines.push(`| Detection (Quality) | ${detectionScore.toFixed(1)} | ${(weights.detection * 100).toFixed(0)}% | ${(detectionScore * weights.detection).toFixed(1)} |`);
lines.push(`| **Total** |  |  | **${healthScore.toFixed(1)}** |`);
lines.push(``);

if (!completenessOk) {
  lines.push(`> ⚠️ **Completeness deduction**: ${missingStages.length} stage(s) missing`);
  lines.push(``);
}
if (socraticPenalty > 0) {
  const uncoveredStages = presentStages.filter(s => !socraticCoveredStages.includes(s));
  lines.push(`> 🤔 **Socratic process impact**: ${socraticCoveredStages.length}/${presentStages.length} stages have Socratic checks`);
  if (uncoveredStages.length > 0) {
    lines.push(`> &nbsp;&nbsp;&nbsp;Missing checks for: ${uncoveredStages.map(s => `\`${s}\``).join(', ')}`);
    lines.push(`> &nbsp;&nbsp;&nbsp;→ After each stage, call: \`node workflow/tools/ide-workflow-bridge.js socratic-challenge --stage <STAGE> --session <SESSION>\``);
  }
  lines.push(``);
}
if (metricsGatePenalty > 0) {
  lines.push(`> 🚦 **Metrics gate process impact**: ${stagesWithGateFailures.length} stage(s) failed metric gates`);
  lines.push(`> &nbsp;&nbsp;&nbsp;Failed stages: ${stagesWithGateFailures.map(s => `\`${s}\``).join(', ')}`);
  lines.push(``);
}
const ineffectiveChallengePenalty = Number(scoreResult.breakdown?.ineffectiveChallengePenalty || 0);
if (ineffectiveChallengePenalty > 0) {
  lines.push(`> 🧪 **Challenge effectiveness impact**: only ${effectiveChallengeStages.length}/${challengedStages.length || 0} triggered challenges produced measurable gain`);
  lines.push(`> &nbsp;&nbsp;&nbsp;Ineffective challenge penalty: -${ineffectiveChallengePenalty}`);
  lines.push(``);
}
lines.push(`---`);
lines.push(``);

// ── Rolling Trend Alerts ─────────────────────────────────────────────────────
lines.push(`## 📈 Rolling Trend Alerts`);
lines.push(``);
lines.push(`| Metric | Value |`);
lines.push(`|--------|-------|`);
lines.push(`| Trend Enabled | ${trendEnabled ? '✅ Yes' : '❌ No'} |`);
lines.push(`| Window Size | ${trendWindowSize} |`);
lines.push(`| History Sessions | ${historyEntries.length} |`);
lines.push(`| Recent Avg Score | ${recentAvg != null ? recentAvg.toFixed(1) : 'N/A'} |`);
lines.push(`| Previous Avg Score | ${previousAvg != null ? previousAvg.toFixed(1) : 'N/A'} |`);
lines.push(`| Delta (Recent-Previous) | ${trendDelta != null ? `${trendDelta > 0 ? '+' : ''}${trendDelta}` : 'N/A'} |`);
lines.push(`| Low Score Threshold | ${trendLowScoreThreshold} |`);
lines.push(`| Alert Status | ${trendAlertTriggered ? '🚨 Triggered' : '✅ Normal'} |`);
lines.push(``);
lines.push(`> ${trendAlertMessage}`);
lines.push(``);
lines.push(`---`);
lines.push(``);

// ── Stage Execution Details ───────────────────────────────────────────────────
if (dedupedStageStartEvts.length > 0) {
  lines.push(`## 🔄 Stage Execution Details`);
  lines.push(``);

  dedupedStageStartEvts.forEach((startEvt, idx) => {
    const stageName = startEvt.stage;
    const endEvt    = stageEndEvts.find(e => e.stage === stageName && e.seq >= startEvt.seq);
    const startData = startEvt.data || {};
    const endData   = endEvt?.data || {};
    const socEvt    = socraticEvts.find(e => e.stage === stageName);

    lines.push(`### ${idx + 1}. \`${stageName}\``);
    lines.push(``);

    const statusEmoji = endEvt ? (endData.success !== false ? '✅' : '❌') : '⏳';
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Status | ${statusEmoji} ${endEvt ? (endData.success !== false ? 'Success' : 'Failed') : 'Running...'} |`);
    if (endData.duration) {
      lines.push(`| Duration | ${endData.duration}ms |`);
    }
    if (endData.error) {
      lines.push(`| Error | \`${endData.error}\` |`);
    }
    if (socEvt?.data?.confidenceStatus === 'na') {
      const reason = socEvt.data.confidenceReason || 'insufficient evidence';
      lines.push(`| Confidence | ⬜ N/A (${reason}) |`);
    } else if (socEvt?.data?.confidence !== undefined) {
      const conf = (socEvt.data.confidence * 100).toFixed(0);
      const confEmoji = socEvt.data.confidence >= 0.7 ? '✅' : socEvt.data.confidence >= 0.5 ? '⚠️' : '❌';
      lines.push(`| Confidence | ${confEmoji} ${conf}% |`);
    }
    // Metrics Gate result (IDE Agent mode: embedded in stage_end data)
    const gateResult = stageMetricsGateResults[stageName];
    if (gateResult) {
      const gateEmoji = gateResult.passed ? '✅' : '⚠️';
      const gateStatus = gateResult.passed ? 'PASSED' : `FAILED (${gateResult.failedGates?.join(', ') || 'unknown'})`;
      lines.push(`| Metrics Gate | ${gateEmoji} ${gateStatus} |`);
    } else {
      lines.push(`| Metrics Gate | ⬜ N/A (Node Orchestrator mode) |`);
    }
    lines.push(``);

    // Stage Summary (from --summary arg or data.summary)
    const stageSummary = startData.summary || endData.summary;
    if (stageSummary) {
      lines.push(`**📋 Summary:** ${stageSummary}`);
      lines.push(``);
    }

    // Stage Input Description (from --stage-input arg)
    const stageInputDesc = startData.stageInput;
    if (stageInputDesc) {
      lines.push(`**📥 Input:** ${stageInputDesc}`);
      lines.push(``);
    }

    // Stage Output Description (from --stage-output arg)
    const stageOutputDesc = endData.stageOutput;
    if (stageOutputDesc) {
      lines.push(`**📤 Output:** ${stageOutputDesc}`);
      lines.push(``);
    }

    // Input Artifact
    const inputArtifact = startData.input;
    if (inputArtifact && inputArtifact.path) {
      lines.push(`**Input Artifact:** \`${inputArtifact.path}\``);
      if (inputArtifact.lines) lines.push(`- Lines: ${inputArtifact.lines}, Hash: \`${inputArtifact.hash || 'N/A'}\``);
      lines.push(``);
    } else {
      lines.push(`**Input Artifact:** None (first stage)`);
      lines.push(``);
    }

    // Output Artifact
    const outputArtifact = endData.output;
    if (outputArtifact && outputArtifact.path) {
      lines.push(`**Output Artifact:** \`${outputArtifact.path}\``);
      if (outputArtifact.lines) lines.push(`- Lines: ${outputArtifact.lines}, Hash: \`${outputArtifact.hash || 'N/A'}\``);
      if (outputArtifact.preview) {
        const preview = outputArtifact.preview.slice(0, 400);
        lines.push(``);
        lines.push(`<details><summary>Preview (first 400 chars)</summary>`);
        lines.push(``);
        lines.push('```');
        lines.push(preview);
        lines.push('```');
        lines.push(`</details>`);
      }
      lines.push(``);
    } else {
      lines.push(`**Output Artifact:** ⚠️ Not captured`);
      lines.push(``);
    }

    // Metrics Gate Detail (only show if gate ran and has per-gate breakdown)
    if (gateResult && gateResult.gates?.length > 0) {
      lines.push(`<details><summary>🚦 Metrics Gate Detail (${gateResult.passed ? 'PASSED' : 'FAILED'})</summary>`);
      lines.push(``);
      lines.push(`| Gate | Status | Actual | Threshold |`);
      lines.push(`|------|--------|--------|-----------|`);
      gateResult.gates.forEach(g => {
        const gEmoji = g.passed ? '✅' : '❌';
        lines.push(`| ${g.name} | ${gEmoji} ${g.passed ? 'pass' : 'fail'} | ${g.actual} | ${g.threshold} |`);
      });
      lines.push(``);
      lines.push(`</details>`);
      lines.push(``);
    }
  });

  lines.push(`---`);
  lines.push(``);
}

// ── Socratic Challenge Details ────────────────────────────────────────────────
if (socraticEvts.length > 0) {
  lines.push(`## 🤔 Socratic Challenge Details`);
  lines.push(``);

  socraticEvts.forEach(evt => {
    const data = evt.data || {};
    lines.push(`### Stage: \`${evt.stage}\``);
    lines.push(``);

    if (data.confidenceStatus === 'na') {
      lines.push(`**Confidence:** ⬜ N/A (${data.confidenceReason || 'insufficient evidence'})`);
      lines.push(``);
    } else if (data.confidence !== undefined) {
      const confPct   = (data.confidence * 100).toFixed(0);
      const confEmoji = data.confidence >= 0.7 ? '✅' : data.confidence >= 0.5 ? '⚠️' : '❌';
      lines.push(`**Confidence:** ${confEmoji} ${confPct}%`);
      lines.push(``);
    }

    lines.push(`**Triggered:** ${data.challenged !== false ? '✅ Yes' : '⬜ No'}`);
    if (Array.isArray(data.triggerReasons) && data.triggerReasons.length > 0) {
      lines.push(`**Trigger Reasons:** ${data.triggerReasons.map(r => `\`${r}\``).join(', ')}`);
    }
    if (data.requiresRevision === true) {
      lines.push(`**Revision Required:** ✅ Yes`);
    }
    if (data.p2Protocol?.name) {
      lines.push(`**P2 Protocol:** \`${data.p2Protocol.name}\``);
      if (Array.isArray(data.p2Protocol.verificationQuestions) && data.p2Protocol.verificationQuestions.length > 0) {
        lines.push(`**Verification Questions:** ${data.p2Protocol.verificationQuestions.length}`);
      }
    }
    if (Number.isFinite(data.preChallengeScore) && Number.isFinite(data.postRevisionScore)) {
      lines.push(`**Revision Delta:** ${(data.preChallengeScore * 100).toFixed(0)}% → ${(data.postRevisionScore * 100).toFixed(0)}% (Δ ${(data.deltaScore * 100).toFixed(1)}%)`);
      lines.push(`**Effective Challenge:** ${data.effectiveChallenge === true ? '✅ Yes' : '⚠️ No'}`);
    }
    lines.push(``);

    if (data.questions?.length > 0) {
      lines.push(`**Questions (${data.questions.length}):**`);
      lines.push(``);
      data.questions.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
      lines.push(``);
    }

    if (data.blindSpots?.length > 0) {
      lines.push(`**Blind Spots (${data.blindSpots.length}):**`);
      lines.push(``);
      data.blindSpots.forEach((bs, i) => lines.push(`${i + 1}. ${bs}`));
      lines.push(``);
    }

    if (data.dimensionScores && Object.keys(data.dimensionScores).length > 0) {
      lines.push(`**Dimension Scores:**`);
      lines.push(``);
      lines.push(`| Dimension | Score | Status |`);
      lines.push(`|-----------|-------|--------|`);
      Object.entries(data.dimensionScores).forEach(([dim, score]) => {
        const scoreEmoji = score >= 0.7 ? '✅' : score >= 0.5 ? '⚠️' : '❌';
        lines.push(`| ${dim} | ${(score * 100).toFixed(0)}% | ${scoreEmoji} |`);
      });
      lines.push(``);
    }

    if (data.evidenceBreakdown) {
      const eb = data.evidenceBreakdown;
      lines.push(`**Evidence Breakdown (Claim-Chain):**`);
      lines.push(``);
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Model | ${eb.model || 'evidence-chain-v1'} |`);
      lines.push(`| Mode | ${eb.mode || 'normal'} |`);
      lines.push(`| Claims Supported | ${eb.coveredClaims ?? 0}/${eb.claimCount ?? 0} |`);
      lines.push(`| Support Ratio | ${Number.isFinite(eb.supportRatio) ? `${(eb.supportRatio * 100).toFixed(0)}%` : 'N/A'} |`);
      lines.push(`| Reasoning Signal | ${Number.isFinite(eb.reasoningSignal) ? `${(eb.reasoningSignal * 100).toFixed(0)}%` : 'N/A'} |`);
      lines.push(`| Evidence Signal | ${Number.isFinite(eb.evidenceSignal) ? `${(eb.evidenceSignal * 100).toFixed(0)}%` : 'N/A'} |`);
      if (Number.isFinite(eb.evidenceChainScore)) {
        lines.push(`| Evidence Chain Score | ${(eb.evidenceChainScore * 100).toFixed(0)}% |`);
      }
      lines.push(``);
    }
  });

  lines.push(`---`);
  lines.push(``);
}

// ── Evolution Signals ─────────────────────────────────────────────────────────
try {
  if (fs.existsSync(evolutionLogPath)) {
    const evolutionLog  = JSON.parse(fs.readFileSync(evolutionLogPath, 'utf-8'));
    const signals       = (evolutionLog.signals || evolutionLog);
    const recentSignals = Array.isArray(signals) ? signals.slice(-10) : [];

    if (recentSignals.length > 0) {
      lines.push(`## 📡 Evolution Signals (Last ${recentSignals.length})`);
      lines.push(``);
      lines.push(`| Time | Type | Stage | Severity | Message |`);
      lines.push(`|------|------|-------|----------|---------|`);

      [...recentSignals].reverse().forEach(signal => {
        const time     = signal.ts ? new Date(signal.ts).toISOString().slice(11, 19) : 'N/A';
        const type     = (signal.type || 'UNKNOWN').slice(0, 20);
        const stage    = signal.stage || '-';
        const severity = signal.severity || 'LOW';
        const message  = (signal.message || signal.details || '-').slice(0, 50);
        const sevEmoji = severity === 'CRITICAL' ? '🔴' : severity === 'HIGH' ? '🟠' : severity === 'MEDIUM' ? '🟡' : '🟢';
        lines.push(`| ${time} | ${type} | ${stage} | ${sevEmoji} ${severity} | ${message} |`);
      });
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }
} catch { /* skip */ }

// ── Quality Gate ──────────────────────────────────────────────────────────────
try {
  if (fs.existsSync(qualityReportPath)) {
    const qualityContent = fs.readFileSync(qualityReportPath, 'utf-8');
    const scoreMatch     = qualityContent.match(/\*\*(\d+)\*\* \(([A-F])\)/);
    const signalsMatch   = qualityContent.match(/\*\*Total Signals\*\* \| (\d+)/);

    if (scoreMatch || signalsMatch) {
      lines.push(`## 🚦 Quality Gate Results`);
      lines.push(``);
      lines.push(`| Metric | Value |`);
      lines.push(`|--------|-------|`);
      if (scoreMatch) lines.push(`| Quality Score | **${scoreMatch[1]}** (${scoreMatch[2]}) |`);
      if (signalsMatch) lines.push(`| Total Signals | ${signalsMatch[1]} |`);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }
  }
} catch { /* skip */ }

// ── Verification Evidence Protocol ───────────────────────────────────────────
lines.push(`## 🧾 Verification Evidence Protocol`);
lines.push(``);
lines.push(`| Field | Value |`);
lines.push(`|-------|-------|`);
lines.push(`| Protocol Version | \`${evidenceProtocol.protocolVersion}\` |`);
lines.push(`| Session | \`${evidenceProtocol.sessionId}\` |`);
lines.push(`| Run Category | \`${evidenceProtocol.runCategory}\` |`);
lines.push(`| Missing Stage Artifacts | ${evidenceProtocol.verification.missingStageArtifacts.length} |`);
lines.push(``);
lines.push(`### Artifact Fingerprints`);
lines.push(``);
lines.push(`| Stage | Exists | Size(bytes) | SHA256 (prefix) |`);
lines.push(`|-------|--------|-------------|------------------|`);
evidenceProtocol.stageArtifacts.forEach(a => {
  lines.push(`| ${a.stage} | ${a.exists ? '✅' : '❌'} | ${a.size} | ${a.hash ? `\`${a.hash.slice(0, 16)}...\`` : '-'} |`);
});
lines.push(``);
lines.push(`- **Trace Hash**: ${evidenceProtocol.traceFingerprint.hash ? `\`${evidenceProtocol.traceFingerprint.hash}\`` : 'N/A'}`);
lines.push(`- **Quality Report Hash**: ${evidenceProtocol.qualityReportFingerprint.hash ? `\`${evidenceProtocol.qualityReportFingerprint.hash}\`` : 'N/A'}`);
lines.push(`- **Evolution Log Hash**: ${evidenceProtocol.evolutionLogFingerprint.hash ? `\`${evidenceProtocol.evolutionLogFingerprint.hash}\`` : 'N/A'}`);
lines.push(``);
lines.push(`---`);
lines.push(``);

// ── Footer ────────────────────────────────────────────────────────────────────
lines.push(`_Generated by generate-health-report.js from real trace data_`);
lines.push(`_Trace file: \`${tracePath}\`_`);

// ─── Write Report ─────────────────────────────────────────────────────────────

const reportContent = lines.join('\n');
fs.mkdirSync(path.dirname(healthReportPath), { recursive: true });
fs.writeFileSync(healthReportPath, reportContent, 'utf-8');

const evidenceJsonPath = path.join(healthDir, 'verification-evidence.json');
fs.writeFileSync(evidenceJsonPath, JSON.stringify(evidenceProtocol, null, 2), 'utf-8');

if (trendEnabled) {
  const historyContent = historyEntries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(healthHistoryPath, historyContent + (historyContent ? '\n' : ''), 'utf-8');
}

console.log(`[HealthReport] ✅ Report written: ${healthReportPath}`);
console.log(`[HealthReport] 🧾 Evidence written: ${evidenceJsonPath}`);
if (trendEnabled) {
  console.log(`[HealthReport] 📈 Trend history updated: ${healthHistoryPath}`);
  console.log(`[HealthReport] 🚨 Trend alert: ${trendAlertTriggered ? 'TRIGGERED' : 'normal'} (${trendAlertMessage})`);
}
console.log(`[HealthReport] 🧭 Run Category: ${runCategory}`);
console.log(`[HealthReport] 📊 Health Score: ${healthScore}/100 (Grade: ${healthGrade})`);
console.log(`[HealthReport] 📋 Stages: ${presentStages.join(', ') || 'none'}`);
if (missingStages.length > 0) {
  console.log(`[HealthReport] ⚠️  Missing: ${missingStages.join(', ')}`);
}
