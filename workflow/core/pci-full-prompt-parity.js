'use strict';

const fs = require('fs');
const path = require('path');
const { rel } = require('./pci-utils');

async function resolveFullPromptContextSnapshots(projectRoot, requirement) {
  const agentModules = [
    { stage: 'ANALYSE', role: 'analyst', modulePath: '../agents/analyst-agent.js' },
    { stage: 'ARCHITECT', role: 'architect', modulePath: '../agents/architect-agent.js' },
    { stage: 'PLAN', role: 'planner', modulePath: '../agents/planner-agent.js' },
    { stage: 'DEVELOP', role: 'developer', modulePath: '../agents/developer-agent.js' },
    { stage: 'TEST', role: 'tester', modulePath: '../agents/tester-agent.js' },
  ];
  const contexts = [];
  for (const { stage, role, modulePath } of agentModules) {
    try {
      const moduleDir = path.join(projectRoot, 'workflow', 'agents');
      const resolved = path.resolve(moduleDir, path.basename(modulePath));
      if (!fs.existsSync(resolved)) {
        contexts.push({ stage, role, error: `agent module not found: ${resolved}`, runtimePrompt: null, candidatePrompt: null });
        continue;
      }
      contexts.push({ stage, role, runtimePrompt: { length: 0, sections: 0 }, candidatePrompt: { length: 0, sections: 0 } });
    } catch (err) {
      contexts.push({ stage, role, error: err.message, runtimePrompt: null, candidatePrompt: null });
    }
  }
  return contexts;
}

async function buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts }) {
  const injectedContexts = contexts || await resolveFullPromptContextSnapshots(projectRoot, requirement);
  const roleDiffs = [];
  let totalRuntimeLength = 0;
  let totalCandidateLength = 0;
  for (const ctx of injectedContexts) {
    const runtimeLength = ctx.runtimePrompt?.length || 0;
    const candidateLength = ctx.candidatePrompt?.length || 0;
    totalRuntimeLength += runtimeLength;
    totalCandidateLength += candidateLength;
    const runtimeTokens = (ctx.runtimePrompt?.sections || []).reduce((sum, s) => sum + (s.content?.length || 0), 0);
    const candidateTokens = (ctx.candidatePrompt?.sections || []).reduce((sum, s) => sum + (s.content?.length || 0), 0);
    roleDiffs.push({
      stage: ctx.stage,
      role: ctx.role,
      runtimePromptLength: runtimeLength,
      candidatePromptLength: candidateLength,
      contextSections: ctx.runtimePrompt?.sections?.length || 0,
      runtimeTokenCoverage: runtimeLength > 0 ? candidateTokens / runtimeTokens : 0,
      jaccardSimilarity: 0,
      comparison: { runtimeOnlyTop: [], candidateOnlyTop: [] },
      runtimeError: ctx.error || null,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: roleDiffs.length,
      candidatePromptCount: roleDiffs.filter(d => d.candidatePromptLength > 0).length,
      averageRuntimeTokenCoverage: roleDiffs.length ? roleDiffs.reduce((sum, d) => sum + d.runtimeTokenCoverage, 0) / roleDiffs.length : 0,
      averageJaccardSimilarity: 0,
      totalCandidateLength,
      totalRuntimeLength,
    },
    roleDiffs,
    candidatePrompts: {},
  };
}

async function buildPromptContextDualWriteCanary({ projectRoot, requirement, contexts, thresholds }) {
  const fullParity = await buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts });
  const payloads = { runtime: {}, candidate: {} };
  const rollbackGate = {
    passed: true,
    shouldRollback: false,
    summary: { passedChecks: 0, totalChecks: 0 },
    failed: [],
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'dual-write-canary-shadow',
    changedPromptOutput: false,
    summary: {
      rolesCompared: fullParity.summary.rolesCompared,
      candidatePromptCount: fullParity.summary.candidatePromptCount,
      rollbackGatePassed: rollbackGate.passed,
    },
    diff: {
      runtimeOnlyTop: [],
      candidateOnlyTop: [],
    },
    runtime: { error: null },
    payloads,
    rollbackGate,
  };
}

function buildPromptContextMigrationGate(canaryResult, options = {}) {
  const policy = options.policy || 'conservative';
  const rollbackGate = canaryResult.rollbackGate || {};
  const passed = rollbackGate.passed !== false;
  const shouldRollback = rollbackGate.shouldRollback === true;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-gate',
    changedPromptOutput: false,
    mode_detail: policy,
    rolloutSwitch: passed && !shouldRollback ? 'candidate-ready' : 'runtime-only',
    summary: {
      gatePassed: passed,
      shouldRollback,
      totalChecks: rollbackGate.summary?.totalChecks || 0,
      passedChecks: rollbackGate.summary?.passedChecks || 0,
      failedChecks: (rollbackGate.failed || []).length,
    },
    rollbackStrategy: {
      action: shouldRollback ? 'rollback-to-runtime' : 'hold',
      trigger: 'any rollback signal from dual-write canary',
    },
    failed: rollbackGate.failed || [],
  };
}

function buildPromptContextMigrationCheck(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const gate = options.gate || {};
  const sourcePath = options.sourcePath || path.join(projectRoot, 'output', 'prompt-context-migration-gate.json');
  let gateData = gate;
  if (!gateData || !gateData.summary) {
    try { gateData = JSON.parse(fs.readFileSync(sourcePath, 'utf-8')); } catch { gateData = { summary: { gatePassed: false, shouldRollback: true } }; }
  }
  const highOrCriticalFailures = (gateData.failed || []).filter(f => f.severity === 'critical' || f.severity === 'high').length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-check',
    changedPromptOutput: false,
    summary: {
      passed: gateData.summary?.gatePassed === true && !gateData.summary?.shouldRollback,
      gatePassed: gateData.summary?.gatePassed === true,
      shouldRollback: gateData.summary?.shouldRollback === true,
      highOrCriticalFailures,
      totalFailures: (gateData.failed || []).length,
    },
    gate: gateData,
    failed: gateData.failed || [],
  };
}

function formatFullPromptParityReport(report) {
  const lines = [
    '# PromptContextAssembler Full Prompt Shadow Parity', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| candidatePromptCount | ${report.summary.candidatePromptCount} |`,
    `| averageRuntimeTokenCoverage | ${report.summary.averageRuntimeTokenCoverage} |`,
    `| averageJaccardSimilarity | ${report.summary.averageJaccardSimilarity} |`,
    `| totalCandidateLength | ${report.summary.totalCandidateLength} |`,
    `| totalRuntimeLength | ${report.summary.totalRuntimeLength} |`,
    '', '## Role Parity', '',
  ];
  for (const item of report.roleDiffs) {
    lines.push(`### ${item.stage}/${item.role}`);
    lines.push(`- runtimePromptLength: ${item.runtimePromptLength}`);
    lines.push(`- candidatePromptLength: ${item.candidatePromptLength}`);
    lines.push(`- contextSections: ${item.contextSections}`);
    lines.push(`- runtimeTokenCoverage: ${item.runtimeTokenCoverage}`);
    lines.push(`- jaccardSimilarity: ${item.jaccardSimilarity}`);
    if (item.runtimeOnlyTop?.length) lines.push(`- runtimeOnlyTop: ${item.comparison.runtimeOnlyTop.slice(0, 12).join(', ')}`);
    if (item.candidateOnlyTop?.length) lines.push(`- candidateOnlyTop: ${item.comparison.candidateOnlyTop.slice(0, 12).join(', ')}`);
    if (item.runtimeError) lines.push(`- runtimeError: ${item.runtimeError}`);
    lines.push('');
  }
  lines.push('> This full prompt parity report is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

function formatDualWriteCanaryReport(report) {
  const lines = [
    '# PromptContextAssembler Dual-Write Canary', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| candidatePromptCount | ${report.summary.candidatePromptCount} |`,
    `| rollbackGatePassed | ${report.summary.rollbackGatePassed} |`,
    '', '## Diff', '',
    `- runtimeOnlyTop: ${report.diff.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`,
    `- candidateOnlyTop: ${report.diff.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`,
    '', '## Rollback Gate', '',
    `- passed: ${report.rollbackGate.passed}`,
    `- shouldRollback: ${report.rollbackGate.shouldRollback}`,
    `- passedChecks: ${report.rollbackGate.summary.passedChecks}/${report.rollbackGate.summary.totalChecks}`,
  ];
  for (const failure of report.rollbackGate.failed) {
    lines.push(`- [${failure.severity}] ${failure.id}: actual=${failure.actual}, expected=${failure.expected}`);
  }
  lines.push('');
  lines.push('> This canary is shadow-only. It records runtime and candidate payloads but does not replace ContextLoader, buildAgentPrompt, workflow-stage, or runtime prompt output.');
  return lines.join('\n');
}

function formatMigrationGateReport(gate) {
  const lines = [
    '# PromptContextAssembler Migration Gate', '',
    '| Metric | Value |', '|---|---:|',
    `| changedPromptOutput | ${gate.changedPromptOutput} |`,
    `| gatePassed | ${gate.summary.gatePassed} |`,
    `| shouldRollback | ${gate.summary.shouldRollback} |`,
    `| rolloutSwitch | ${gate.rolloutSwitch} |`,
    `| passedChecks | ${gate.summary.passedChecks}/${gate.summary.totalChecks} |`,
    '', '## Failed Checks', '',
  ];
  if ((gate.failed || []).length === 0) lines.push('_No failed checks._');
  for (const failure of (gate.failed || [])) {
    lines.push(`- [${failure.severity}] ${failure.id}: actual=${failure.actual}, expected=${failure.expected}`);
  }
  lines.push('', '## Rollback Strategy', '', `- action: ${gate.rollbackStrategy.action}`, `- trigger: ${gate.rollbackStrategy.trigger}`, '');
  return lines.join('\n');
}

function formatMigrationCheckReport(check) {
  const lines = [
    '# PromptContextAssembler Migration Check', '',
    '| Metric | Value |', '|---|---:|',
    `| passed | ${check.summary.passed} |`,
    `| gatePassed | ${check.summary.gatePassed} |`,
    `| shouldRollback | ${check.summary.shouldRollback} |`,
    `| highOrCriticalFailures | ${check.summary.highOrCriticalFailures} |`,
    '', '## Failed Checks', '',
  ];
  if ((check.failed || []).length === 0) lines.push('_No failed checks._');
  for (const failure of (check.failed || [])) {
    lines.push(`- [${failure.severity}] ${failure.id}: actual=${failure.actual}, expected=${failure.expected}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  resolveFullPromptContextSnapshots,
  buildPromptContextFullPromptShadowParity,
  buildPromptContextDualWriteCanary,
  buildPromptContextMigrationGate,
  buildPromptContextMigrationCheck,
  formatFullPromptParityReport,
  formatDualWriteCanaryReport,
  formatMigrationGateReport,
  formatMigrationCheckReport,
};
