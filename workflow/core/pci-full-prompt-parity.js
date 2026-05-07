'use strict';

const path = require('path');
const fs = require('fs');
const { sha256, rel } = require('./pci-utils');
const { comparePromptTexts } = require('./pci-shadow-diff');

function stageOutputPath(stage) {
  const map = {
    ANALYSE: 'output/analysis.md',
    ARCHITECT: 'output/architecture.md',
    PLAN: 'output/execution-plan.md',
    DEVELOP: 'output/code.diff',
    TEST: 'output/test-report.md',
    REVIEW: 'output/review-output.md',
    DEPLOY: 'output/deploy-output.md',
  };
  return map[stage] || 'output/stage-output.md';
}

function buildStageInstructionSnapshot(stage) {
  return [
    `Execute the ${stage} stage using the provided context and prompt.`,
    `Write output to: ${stageOutputPath(stage)}.`,
    'Respect shadow-only diagnostics: do not change runtime prompt output from candidate prompt artifacts.',
  ].join('\n');
}

function fullPromptStageRoles() {
  return [
    ['ANALYSE', 'analyst'],
    ['ARCHITECT', 'architect'],
    ['PLAN', 'planner'],
    ['DEVELOP', 'developer'],
    ['TEST', 'tester'],
  ];
}

function loadFixedPrefix(projectRoot, role) {
  const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
  try {
    delete require.cache[require.resolve(prefixesPath)];
    const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
    return AGENT_FIXED_PREFIXES?.[role] || '';
  } catch {
    return '';
  }
}

function buildRuntimeParitySections() {
  try {
    const { buildRuntimeSupplementSections } = require('./prompt-runtime-supplement-builder');
    return buildRuntimeSupplementSections();
  } catch {
    return [];
  }
}

function renderFullCandidatePrompt({ projectRoot, stage, role, requirement, context }) {
  const fixedPrefix = loadFixedPrefix(projectRoot, role);
  const dynamicSections = (context?.sections || []).map(section => section.content).filter(Boolean);
  const dynamicSuffix = [
    ...dynamicSections,
    ...buildRuntimeParitySections(),
    `### Input\n${requirement || 'PromptContextAssembler full prompt shadow parity'}`,
    `## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`,
  ].join('\n\n');
  return fixedPrefix + '\n\n<!-- KV_CACHE_BOUNDARY: dynamic content below -->\n\n' + dynamicSuffix;
}


async function loadRuntimeFullPromptSnapshot({ projectRoot, stage, role, requirement }) {
  try {
    const { buildAgentPrompt } = require('./prompt-builder');
    const result = await buildAgentPrompt(role, requirement || 'PromptContextAssembler full prompt shadow parity', [], {
      projectRoot,
      stage,
      usePatterns: false,
      trackMetrics: false,
    });
    const runtimePrompt = `${result.prompt}\n\n## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`;
    return {
      stage,
      role,
      source: 'workflow/core/prompt-builder.js + workflow/tools/ide-workflow-bridge.js#workflow-stage.instructions',
      runtimePromptHash: sha256(runtimePrompt),
      runtimePromptLength: runtimePrompt.length,
      runtimePrompt,
      meta: result.meta || {},
    };
  } catch (err) {
    const fallback = `${loadFixedPrefix(projectRoot, role)}\n\n## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`;
    return {
      stage,
      role,
      source: 'fallback:prompt-agent-prefixes + stage instructions',
      error: err.message,
      runtimePromptHash: sha256(fallback),
      runtimePromptLength: fallback.length,
      runtimePrompt: fallback,
    };
  }
}

async function resolveFullPromptContextSnapshots(projectRoot, requirement) {
  const ContextLoader = require('./context-loader').ContextLoader || require('./context-loader');
  const configPath = path.join(projectRoot, 'workflow.config.js');
  let config = {};
  try {
    delete require.cache[require.resolve(configPath)];
    if (fs.existsSync(configPath)) config = require(configPath);
  } catch { config = {}; }
  const loader = new ContextLoader({
    workflowRoot: path.join(projectRoot, 'workflow'),
    projectRoot,
    skillKeywords: config.skillKeywords || {},
    alwaysLoadSkills: config.alwaysLoadSkills || [],
    globalSkills: config.globalSkills || [],
    projectSkills: config.projectSkills || [],
    registeredSkills: config.builtinSkills || [],
  });
  const contexts = [];
  for (const [stage, role] of fullPromptStageRoles()) {
    const resolved = await loader.resolve(requirement || 'PromptContextAssembler full prompt shadow parity', role, { stage });
    const sources = resolved.sources || [];
    contexts.push({
      stage,
      role,
      taskText: requirement || '',
      tokenCount: resolved.tokenCount || 0,
      sources,
      sections: (resolved.sections || []).map((content, index) => ({
        index,
        source: sources[index] || 'unknown',
        content,
      })),
    });
  }
  return contexts;
}

async function buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts }) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const contextSnapshots = contexts || await resolveFullPromptContextSnapshots(actualProjectRoot, requirement);
  const candidatePrompts = [];
  const runtimePrompts = [];
  const roleDiffs = [];

  for (const context of contextSnapshots) {
    const candidatePrompt = renderFullCandidatePrompt({
      projectRoot: actualProjectRoot,
      stage: context.stage,
      role: context.role,
      requirement,
      context,
    });
    const runtime = await loadRuntimeFullPromptSnapshot({
      projectRoot: actualProjectRoot,
      stage: context.stage,
      role: context.role,
      requirement,
    });
    const comparison = comparePromptTexts(candidatePrompt, runtime.runtimePrompt || '');
    const runtimeTokenCoverage = comparison.runtimeTokenCount > 0
      ? Number((comparison.commonTokenCount / comparison.runtimeTokenCount).toFixed(4))
      : 0;
    runtimePrompts.push({
      stage: context.stage,
      role: context.role,
      mode: 'runtime-snapshot',
      changedPromptOutput: false,
      source: runtime.source,
      runtimePromptHash: runtime.runtimePromptHash,
      runtimePromptLength: runtime.runtimePromptLength,
      runtimePrompt: runtime.runtimePrompt || '',
      runtimeMeta: runtime.meta || null,
      runtimeError: runtime.error || null,
    });
    candidatePrompts.push({
      stage: context.stage,
      role: context.role,
      mode: 'shadow-only',
      changedPromptOutput: false,
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidatePrompt.length,
      contextSections: context.sections.length,
      contextTokenCount: context.tokenCount,
      candidatePrompt,
    });
    roleDiffs.push({
      stage: context.stage,
      role: context.role,
      runtimePromptSource: runtime.source,
      runtimePromptHash: runtime.runtimePromptHash,
      runtimePromptLength: runtime.runtimePromptLength,
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidatePrompt.length,
      contextSections: context.sections.length,
      contextTokenCount: context.tokenCount,
      runtimeTokenCoverage,
      jaccardSimilarity: comparison.jaccardSimilarity,
      comparison,
      runtimeMeta: runtime.meta || null,
      runtimeError: runtime.error || null,
    });
  }

  const averageRuntimeTokenCoverage = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, item) => sum + item.runtimeTokenCoverage, 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageJaccardSimilarity = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, item) => sum + item.jaccardSimilarity, 0) / roleDiffs.length).toFixed(4))
    : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Full prompt shadow parity compares registry-derived candidate prompts with current runtime prompt snapshots. It does not change runtime output.',
    summary: {
      rolesCompared: roleDiffs.length,
      candidatePromptCount: candidatePrompts.length,
      averageRuntimeTokenCoverage,
      averageJaccardSimilarity,
      totalCandidateLength: candidatePrompts.reduce((sum, item) => sum + item.candidatePromptLength, 0),
      totalRuntimeLength: roleDiffs.reduce((sum, item) => sum + item.runtimePromptLength, 0),
    },
    candidatePrompts,
    runtimePrompts,
    roleDiffs,
  };
}

function buildDualWriteRollbackGate(fullPromptParity, options = {}) {
  const thresholds = {
    minAverageRuntimeTokenCoverage: 0.9,
    minRoleRuntimeTokenCoverage: 0.85,
    minAverageJaccardSimilarity: 0.85,
    allowRuntimeErrors: false,
    ...(options.thresholds || {}),
  };
  const checks = [
    {
      id: 'changed-prompt-output',
      passed: fullPromptParity.changedPromptOutput === false,
      actual: fullPromptParity.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'average-runtime-token-coverage',
      passed: fullPromptParity.summary.averageRuntimeTokenCoverage >= thresholds.minAverageRuntimeTokenCoverage,
      actual: fullPromptParity.summary.averageRuntimeTokenCoverage,
      expected: `>=${thresholds.minAverageRuntimeTokenCoverage}`,
      severity: 'high',
    },
    {
      id: 'average-jaccard-similarity',
      passed: fullPromptParity.summary.averageJaccardSimilarity >= thresholds.minAverageJaccardSimilarity,
      actual: fullPromptParity.summary.averageJaccardSimilarity,
      expected: `>=${thresholds.minAverageJaccardSimilarity}`,
      severity: 'medium',
    },
    ...fullPromptParity.roleDiffs.map(item => ({
      id: `role-coverage.${item.stage}.${item.role}`,
      stage: item.stage,
      role: item.role,
      passed: item.runtimeTokenCoverage >= thresholds.minRoleRuntimeTokenCoverage,
      actual: item.runtimeTokenCoverage,
      expected: `>=${thresholds.minRoleRuntimeTokenCoverage}`,
      severity: 'high',
    })),
    ...fullPromptParity.roleDiffs.map(item => ({
      id: `runtime-error.${item.stage}.${item.role}`,
      stage: item.stage,
      role: item.role,
      passed: thresholds.allowRuntimeErrors || !item.runtimeError,
      actual: item.runtimeError || null,
      expected: null,
      severity: 'high',
    })),
  ];
  const failed = checks.filter(check => !check.passed);
  return {
    mode: 'rollback-gate',
    passed: failed.length === 0,
    shouldRollback: failed.some(check => check.severity === 'critical' || check.severity === 'high'),
    thresholds,
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.length - failed.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
    },
    checks,
    failed,
  };
}

function buildPromptContextDualWriteCanary({ projectRoot, requirement, contexts, thresholds } = {}) {
  return buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts }).then((fullPromptParity) => {
    const runtimeByRole = new Map((fullPromptParity.runtimePrompts || []).map(item => [`${item.stage}/${item.role}`, item]));
    const payloads = fullPromptParity.candidatePrompts.map(candidate => {
      const runtime = runtimeByRole.get(`${candidate.stage}/${candidate.role}`) || {};
      const roleDiff = fullPromptParity.roleDiffs.find(item => item.stage === candidate.stage && item.role === candidate.role) || {};
      return {
        stage: candidate.stage,
        role: candidate.role,
        mode: 'dual-write-shadow',
        changedPromptOutput: false,
        runtime: {
          source: runtime.source || null,
          hash: runtime.runtimePromptHash || null,
          length: runtime.runtimePromptLength || 0,
          prompt: runtime.runtimePrompt || '',
          error: runtime.runtimeError || null,
        },
        candidate: {
          source: 'PromptContextAssembler shared-builder candidate',
          hash: candidate.candidatePromptHash,
          length: candidate.candidatePromptLength,
          prompt: candidate.candidatePrompt,
        },
        diff: {
          runtimeTokenCoverage: roleDiff.runtimeTokenCoverage || 0,
          jaccardSimilarity: roleDiff.jaccardSimilarity || 0,
          runtimeOnlyTop: roleDiff.comparison?.runtimeOnlyTop || [],
          candidateOnlyTop: roleDiff.comparison?.candidateOnlyTop || [],
        },
      };
    });
    const rollbackGate = buildDualWriteRollbackGate(fullPromptParity, { thresholds });
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: 'dual-write-shadow',
      changedPromptOutput: false,
      description: 'Dual-write canary records runtime prompt payloads and shared-builder candidate payloads without changing runtime output.',
      summary: {
        ...fullPromptParity.summary,
        payloadCount: payloads.length,
        rollbackGatePassed: rollbackGate.passed,
        shouldRollback: rollbackGate.shouldRollback,
      },
      payloads,
      rollbackGate,
      roleDiffs: fullPromptParity.roleDiffs,
    };
  });
}

function buildPromptContextMigrationGate(dualWriteCanary, options = {}) {
  const policy = {
    rolloutSwitch: 'PROMPT_CONTEXT_ASSEMBLER_MODE',
    defaultMode: 'runtime',
    canaryMode: 'dual-write-canary',
    candidateMode: 'candidate-runtime',
    recommendedInitialPercent: 0,
    maxManualCanaryPercent: 5,
    requireManualApproval: true,
    ...(options.policy || {}),
  };
  const rollbackGate = dualWriteCanary.rollbackGate || {};
  const checks = [
    {
      id: 'canary-changed-prompt-output',
      passed: dualWriteCanary.changedPromptOutput === false,
      actual: dualWriteCanary.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'dual-write-rollback-gate-passed',
      passed: rollbackGate.passed === true,
      actual: rollbackGate.passed,
      expected: true,
      severity: 'critical',
    },
    {
      id: 'dual-write-should-rollback-false',
      passed: rollbackGate.shouldRollback === false,
      actual: rollbackGate.shouldRollback,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'payload-count-complete',
      passed: (dualWriteCanary.summary?.payloadCount || 0) >= (dualWriteCanary.summary?.rolesCompared || 0),
      actual: dualWriteCanary.summary?.payloadCount || 0,
      expected: `>=${dualWriteCanary.summary?.rolesCompared || 0}`,
      severity: 'high',
    },
    {
      id: 'no-high-critical-gate-failures',
      passed: (rollbackGate.summary?.highOrCriticalFailures || 0) === 0,
      actual: rollbackGate.summary?.highOrCriticalFailures || 0,
      expected: 0,
      severity: 'high',
    },
  ];
  const failed = checks.filter(check => !check.passed);
  const gatePassed = failed.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-gate-shadow',
    changedPromptOutput: false,
    description: 'Migration gate consumes dual-write rollback gate and defines rollout switches/rollback strategy without changing runtime output.',
    summary: {
      gatePassed,
      migrationAllowed: false,
      canProceedToManualCanary: gatePassed,
      shouldRollback: !gatePassed || rollbackGate.shouldRollback === true,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
    },
    policy,
    rolloutSwitch: {
      name: policy.rolloutSwitch,
      currentRequiredValue: policy.defaultMode,
      canaryValue: policy.canaryMode,
      candidateRuntimeValue: policy.candidateMode,
      recommendedInitialPercent: policy.recommendedInitialPercent,
      maxManualCanaryPercent: policy.maxManualCanaryPercent,
      requireManualApproval: policy.requireManualApproval,
      safeDefault: `${policy.rolloutSwitch}=${policy.defaultMode}`,
      canaryCommand: `${policy.rolloutSwitch}=${policy.canaryMode}`,
    },
    rollbackStrategy: {
      trigger: 'Any critical/high migration gate failure, canary rollbackGate failure, runtime error, or operator complaint.',
      immediateAction: `${policy.rolloutSwitch}=${policy.defaultMode}`,
      preserveArtifacts: [
        'output/prompt-context-dual-write-canary.md',
        'output/prompt-context-dual-write-rollback-gate.json',
        'output/prompt-context-migration-gate.json',
      ],
      investigation: [
        'Inspect failed migration gate checks.',
        'Compare runtimeOnlyTop/candidateOnlyTop in dual-write canary report.',
        'Keep runtime prompt path as source of truth until a follow-up /wf fixes the drift.',
      ],
    },
    checks,
    failed,
    source: {
      dualWriteMode: dualWriteCanary.mode,
      dualWriteSummary: dualWriteCanary.summary,
      rollbackGateSummary: rollbackGate.summary || null,
    },
  };
}

function formatMigrationGateReport(report) {
  const lines = [
    '# PromptContextAssembler Migration Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| migrationAllowed | ${report.summary.migrationAllowed} |`,
    `| canProceedToManualCanary | ${report.summary.canProceedToManualCanary} |`,
    `| shouldRollback | ${report.summary.shouldRollback} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    '',
    '## Rollout Switch',
    '',
    `- switch: ${report.rolloutSwitch.name}`,
    `- safeDefault: ${report.rolloutSwitch.safeDefault}`,
    `- canaryCommand: ${report.rolloutSwitch.canaryCommand}`,
    `- recommendedInitialPercent: ${report.rolloutSwitch.recommendedInitialPercent}`,
    `- maxManualCanaryPercent: ${report.rolloutSwitch.maxManualCanaryPercent}`,
    `- requireManualApproval: ${report.rolloutSwitch.requireManualApproval}`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('');
  lines.push('## Rollback Strategy');
  lines.push('');
  lines.push(`- trigger: ${report.rollbackStrategy.trigger}`);
  lines.push(`- immediateAction: ${report.rollbackStrategy.immediateAction}`);
  lines.push('- preserveArtifacts:');
  for (const artifact of report.rollbackStrategy.preserveArtifacts) lines.push(`  - ${artifact}`);
  lines.push('- investigation:');
  for (const step of report.rollbackStrategy.investigation) lines.push(`  - ${step}`);
  lines.push('');
  lines.push('> This migration gate is shadow-only. It defines CI/manual gate policy but does not change runtime prompt output.');
  return lines.join('\n');
}

function loadPromptContextMigrationGate(projectRoot) {
  const gatePath = path.join(projectRoot || process.cwd(), 'output', 'prompt-context-migration-gate.json');
  try {
    if (!fs.existsSync(gatePath)) {
      return { exists: false, source: gatePath, gate: null, error: 'prompt-context-migration-gate.json not found' };
    }
    return { exists: true, source: gatePath, gate: JSON.parse(fs.readFileSync(gatePath, 'utf-8')), error: null };
  } catch (err) {
    return { exists: false, source: gatePath, gate: null, error: err.message };
  }
}

function buildPromptContextMigrationCheck({ projectRoot, gate, sourcePath } = {}) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const loaded = gate ? { exists: true, source: sourcePath || 'provided', gate, error: null } : loadPromptContextMigrationGate(actualProjectRoot);
  const migrationGate = loaded.gate || {};
  const summary = migrationGate.summary || {};
  const checks = [
    {
      id: 'migration-gate-artifact-readable',
      passed: loaded.exists && !loaded.error,
      actual: loaded.error || 'readable',
      expected: 'readable JSON artifact',
      severity: 'critical',
    },
    {
      id: 'changed-prompt-output-false',
      passed: migrationGate.changedPromptOutput === false,
      actual: migrationGate.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'migration-gate-passed',
      passed: summary.gatePassed === true,
      actual: summary.gatePassed,
      expected: true,
      severity: 'critical',
    },
    {
      id: 'rollback-not-required',
      passed: summary.shouldRollback === false,
      actual: summary.shouldRollback,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'manual-canary-allowed',
      passed: summary.canProceedToManualCanary === true,
      actual: summary.canProceedToManualCanary,
      expected: true,
      severity: 'high',
    },
    {
      id: 'safe-default-runtime',
      passed: migrationGate.rolloutSwitch?.safeDefault === 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      actual: migrationGate.rolloutSwitch?.safeDefault || null,
      expected: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      severity: 'high',
    },
  ];
  const failed = checks.filter(check => !check.passed);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-check-shadow',
    changedPromptOutput: false,
    source: loaded.source ? rel(actualProjectRoot, loaded.source) : null,
    summary: {
      passed: failed.length === 0,
      ciExitCode: failed.length === 0 ? 0 : 1,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
      migrationAllowed: summary.migrationAllowed === true,
      canProceedToManualCanary: summary.canProceedToManualCanary === true,
    },
    checks,
    failed,
    recommendation: failed.length === 0
      ? 'CI/manual check may proceed. Keep default runtime mode unless a separate runtime migration is explicitly approved.'
      : 'Block CI/manual migration. Re-run prompt-context-migration-gate and inspect failed checks before proceeding.',
  };
}

function formatMigrationCheckReport(report) {
  const lines = [
    '# PromptContextAssembler CI/Manual Migration Check',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| passed | ${report.summary.passed} |`,
    `| ciExitCode | ${report.summary.ciExitCode} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    `| canProceedToManualCanary | ${report.summary.canProceedToManualCanary} |`,
    `| migrationAllowed | ${report.summary.migrationAllowed} |`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('');
  lines.push(`## Recommendation\n\n${report.recommendation}`);
  lines.push('');
  lines.push('> This check is shadow-only. It consumes migration-gate artifacts and does not change prompt output.');
  return lines.join('\n');
}

function classifyP3PromptBuilder(fileRel, normalized, options = {}) {
  const evidence = String(normalized || '');
  const agentSubclass = /^workflow\/agents\/(?!base-agent\.js$)[^/]+-agent\.js$/.test(fileRel) && /buildPrompt\s*\(/.test(evidence);
  if (options.hasGatewayNearby || options.fileHasGateway) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: options.hasGatewayNearby
        ? 'Prompt builder is consumed next to an LLMInjectionGateway/prepareGatewayPrompt call site.'
        : 'Prompt builder lives in a module whose LLM send points are routed through prepareGatewayPrompt.',
      recommendedAction: 'Keep builder unchanged; verify caller shadow evidence in readiness gate.',
    };
  }
  if (/workflow\/core\/code-review-agent\.js$/.test(fileRel)) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'CodeReviewAgent prompt builders are consumed by ReviewAgentBase, whose runReview/fix/adversarial calls are routed through prepareGatewayPrompt.',
      recommendedAction: 'Keep subclass builders unchanged; keep ReviewAgentBase as the injection boundary.',
    };
  }
  if (/workflow\/core\/session-signal-detector\.js$/.test(fileRel)) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Session signal extraction prompts are consumed by teardown callers already routed through LLMInjectionGateway shadow path.',
      recommendedAction: 'Keep detector as builder-only; verify teardown caller coverage.',
    };
  }
  if (/workflow\/core\/deep-audit-(?:experts|orchestrator)\.js$/.test(fileRel)) {
    return {
      kind: 'non-runtime-builder',
      runtimeBuilder: false,
      exception: true,
      exceptionReason: 'Deep audit expert review prompts are advisory/report helpers and are not direct runtime LLM send points in this path.',
      recommendedAction: 'Keep as documented P3 exception unless a direct LLM caller is introduced.',
    };
  }
  if (agentSubclass) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Agent subclass buildPrompt() returns a prompt that BaseAgent.run routes through LLMInjectionGateway.',
      recommendedAction: 'Do not wrap subclass builders directly; keep BaseAgent.run as the runtime injection boundary.',
    };
  }
  if (/workflow\/core\/prompt-builder\.js$/.test(fileRel) || /workflow\/core\/prompt-context-(?:assembler|degradation|registry|selector)/.test(fileRel)) {
    return {
      kind: 'shared-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Shared builder/helper is not itself an LLM call site; runtime send points are gated separately.',
      recommendedAction: 'Track with readiness gate and prompt parity checks; do not mutate output here.',
    };
  }
  if (/prompts\.js$|prompt-template|agent-generator|schema|formatter|report|inventory|policy|contract|config|budget|cache|digest|loader/.test(fileRel)) {
    return {
      kind: 'non-runtime-builder',
      runtimeBuilder: false,
      exception: true,
      exceptionReason: 'Builder creates templates, generated files, reports, or config fragments rather than sending runtime LLM payloads.',
      recommendedAction: 'Keep as documented P3 exception unless a direct LLM consumer is added.',
    };
  }
  if (/build[A-Za-z0-9_]*Prompt\s*\(/.test(evidence)) {
    return {
      kind: 'remaining-runtime-builder',
      runtimeBuilder: true,
      exception: false,
      exceptionReason: null,
      recommendedAction: 'Review caller path; either document caller coverage or route the send point through LLMInjectionGateway.',
    };
  }
  return {
    kind: 'non-runtime-builder',
    runtimeBuilder: false,
    exception: true,
    exceptionReason: 'Prompt-like expression is not classified as a runtime LLM send point.',
    recommendedAction: 'Keep as inventory-only documented exception.',
  };
}

function buildP3PromptBuilderGovernance(callSites) {
  const p3PromptBuilders = callSites.filter(site => site.priority === 'P3' && site.category === 'prompt-builder-function');
  const exceptions = p3PromptBuilders
    .filter(site => site.p3Governance && site.p3Governance.exception)
    .map(site => ({
      file: site.file,
      line: site.line,
      kind: site.p3Governance.kind,
      runtimeBuilder: site.p3Governance.runtimeBuilder,
      reason: site.p3Governance.exceptionReason,
      recommendedAction: site.p3Governance.recommendedAction,
      evidence: site.evidence,
    }));
  const remainingMigrationMatrix = p3PromptBuilders
    .filter(site => !site.p3Governance || !site.p3Governance.exception)
    .map(site => ({
      file: site.file,
      line: site.line,
      kind: site.p3Governance ? site.p3Governance.kind : 'unclassified',
      runtimeBuilder: site.p3Governance ? site.p3Governance.runtimeBuilder : true,
      evidence: site.evidence,
      targetUnifiedPath: 'Document caller coverage or route the runtime send point through LLMInjectionGateway shadow path.',
    }));
  const byKind = {};
  for (const site of p3PromptBuilders) {
    const kind = site.p3Governance ? site.p3Governance.kind : 'unclassified';
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return {
    totalPromptBuilders: p3PromptBuilders.length,
    documentedExceptions: exceptions.length,
    remainingRuntimeBuilders: remainingMigrationMatrix.length,
    runtimeBuilders: p3PromptBuilders.filter(site => site.p3Governance && site.p3Governance.runtimeBuilder).length,
    nonRuntimeBuilders: p3PromptBuilders.filter(site => site.p3Governance && !site.p3Governance.runtimeBuilder).length,
    byKind,
    exceptions,
    remainingMigrationMatrix,
  };
}

function _classifyLLMCallSite(fileRel, line, lineNumber, options = {}) {
  const text = String(line || '');
  const normalized = text.trim();
  const isTest = /(^|\/)tests?\//.test(fileRel) || /\.test\.js$/.test(fileRel);
  const category = (() => {
    if (/buildAgentPrompt\s*\(/.test(text)) return 'unified-prompt-builder';
    if (/\.llm\.chat\s*\(/.test(text)) return 'direct-chat-api';
    if (/_rawLlmCall\s*\(/.test(text)) return 'raw-orchestrator-call';
    if (/this\.llmCall\s*\(/.test(text) || /agent\.llmCall\s*\(/.test(text)) return 'agent-adapter-call';
    if (/_llmCall\s*\(/.test(text) || /cheapLlmCall\s*\(/.test(text) || /_cheapLlmCall\s*\(/.test(text) || /_semanticLlmCall\s*\(/.test(text) || /effectiveLlmCall\s*\(/.test(text)) return 'llm-lite-call';
    if (/llmCall\s*\(/.test(text)) return 'injected-llm-call';
    if (/chat\/completions|axios\.post\s*\(/.test(text)) return 'external-provider-call';
    if (/build[A-Za-z0-9_]*Prompt\s*\(/.test(text)) return 'prompt-builder-function';
    return 'prompt-related';
  })();
  const coveredByUnifiedInjection = category === 'unified-prompt-builder'
    || options.hasGatewayNearby === true
    || (category === 'agent-adapter-call' && /workflow\/agents\/base-agent\.js$/.test(fileRel))
    || (category === 'prompt-builder-function' && /workflow\/agents\/base-agent\.js$/.test(fileRel));
  const priority = (() => {
    if (isTest) return 'P3';
    if (/workflow\/index\.js$/.test(fileRel) || /workflow\/agents\/base-agent\.js$/.test(fileRel)) return 'P0';
    if (category === 'direct-chat-api' || category === 'external-provider-call') return 'P0';
    if (category === 'raw-orchestrator-call' || category === 'agent-adapter-call') return 'P1';
    if (category === 'llm-lite-call' || category === 'injected-llm-call') return 'P2';
    return 'P3';
  })();
  const p3Governance = priority === 'P3' && category === 'prompt-builder-function'
    ? classifyP3PromptBuilder(fileRel, normalized, options)
    : null;
  const status = coveredByUnifiedInjection
    ? 'covered-or-routed'
    : p3Governance && p3Governance.exception
      ? 'documented-exception'
      : 'legacy-direct-or-partial';
  return {
    id: sha256(`${fileRel}:${lineNumber}:${normalized}`).slice(0, 16),
    file: fileRel,
    line: lineNumber,
    category,
    priority,
    coveredByUnifiedInjection,
    governedByUnifiedInjection: coveredByUnifiedInjection || status === 'documented-exception',
    status,
    evidence: normalized.slice(0, 240),
    ...(p3Governance ? { p3Governance } : {}),
  };
}

module.exports = {
  stageOutputPath,
  buildStageInstructionSnapshot,
  fullPromptStageRoles,
  loadFixedPrefix,
  buildRuntimeParitySections,
  buildPromptContextFullPromptShadowParity,
  renderFullCandidatePrompt,
  buildDualWriteRollbackGate,
  buildPromptContextDualWriteCanary,
  buildPromptContextMigrationGate,
  formatMigrationGateReport,
  loadPromptContextMigrationGate,
  buildPromptContextMigrationCheck,
  formatMigrationCheckReport,
  classifyP3PromptBuilder,
  buildP3PromptBuilderGovernance,
  _classifyLLMCallSite,
};
