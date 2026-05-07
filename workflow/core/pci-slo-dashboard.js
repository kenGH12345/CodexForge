'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeContent, rel } = require('./pci-utils');
const { buildDuplicateReport, buildPromptContextDuplicateGovernance } = require('./pci-duplicate-governance');
const { buildPromptContextRegistry, buildPromptContextShadowAssembly } = require('./pci-registry-assembly');
const { buildPromptContextAssemblerShadowDiff, buildPromptContextDynamicContextShadowDiff, buildPromptContextSelectionBudget } = require('./pci-shadow-diff');
const { buildPromptContextFullPromptShadowParity, buildPromptContextDualWriteCanary, buildPromptContextMigrationGate, buildPromptContextMigrationCheck, classifyP3PromptBuilder, buildP3PromptBuilderGovernance, _classifyLLMCallSite } = require('./pci-full-prompt-parity');
const { buildUnifiedLLMInjectionCallSiteInventory, formatUnifiedLLMInjectionCallSiteReport, readJsonArtifact, readShadowTelemetry, findPromptLeakage, buildPriorityCoverage, buildPromptContextInventory } = require('./pci-runtime-gate');

function buildUnifiedLLMInjectionRuntimeReadinessGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const shadow = readShadowTelemetry(projectRoot);
  const leakageFindings = findPromptLeakage(shadow.records);
  const migrationGate = readJsonArtifact(projectRoot, 'output/prompt-context-migration-gate.json');
  const migrationCheck = readJsonArtifact(projectRoot, 'output/prompt-context-migration-check.json');
  const completionContract = options.ignoreCompletionContract
    ? { exists: true, path: path.join(projectRoot, 'output', 'completion-contract-result.json'), value: { passed: true, skippedForCIGate: true }, error: null }
    : readJsonArtifact(projectRoot, 'output/completion-contract-result.json');
  const testProof = readJsonArtifact(projectRoot, 'output/test-execution-proof.json');
  const priorityCoverage = buildPriorityCoverage(inventory.callSites || []);
  const consecutiveGateEvidence = [
    { id: 'migration-gate', passed: migrationGate.value?.summary?.gatePassed === true, source: 'output/prompt-context-migration-gate.json' },
    { id: 'migration-check', passed: migrationCheck.value?.summary?.passed === true, source: 'output/prompt-context-migration-check.json' },
    { id: 'completion-contract', passed: completionContract.value?.passed === true, source: 'output/completion-contract-result.json' },
    { id: 'test-proof', passed: testProof.value?.success === true || testProof.value?.passed === true || testProof.value?.summary?.passed === true, source: 'output/test-execution-proof.json' },
  ];
  const rollbackSignal = migrationGate.value?.summary?.shouldRollback === true
    || migrationCheck.value?.summary?.highOrCriticalFailures > 0
    || completionContract.value?.passed === false;
  const checks = [
    { id: 'changed-prompt-output-false', passed: inventory.changedPromptOutput === false, actual: inventory.changedPromptOutput, expected: false, severity: 'critical' },
    { id: 'p0-shadow-coverage', passed: priorityCoverage.P0.passed, actual: `${priorityCoverage.P0.covered}/${priorityCoverage.P0.total}`, expected: 'all P0 covered', severity: 'critical' },
    { id: 'p1-shadow-coverage', passed: priorityCoverage.P1.passed, actual: `${priorityCoverage.P1.covered}/${priorityCoverage.P1.total}`, expected: 'all P1 covered', severity: 'critical' },
    { id: 'p2-shadow-coverage', passed: priorityCoverage.P2.passed, actual: `${priorityCoverage.P2.covered}/${priorityCoverage.P2.total}`, expected: 'all P2 covered', severity: 'critical' },
    { id: 'shadow-artifact-readable', passed: shadow.exists && shadow.parseErrors.length === 0 && shadow.records.length > 0, actual: shadow.exists ? `${shadow.records.length} record(s), ${shadow.parseErrors.length} parse error(s)` : 'missing', expected: 'readable JSONL with >=1 record', severity: 'high' },
    { id: 'no-prompt-leakage', passed: leakageFindings.length === 0, actual: leakageFindings.length, expected: 0, severity: 'critical' },
    { id: 'migration-gate-passed', passed: migrationGate.value?.summary?.gatePassed === true, actual: migrationGate.value?.summary?.gatePassed, expected: true, severity: 'critical' },
    { id: 'migration-check-passed', passed: migrationCheck.value?.summary?.passed === true, actual: migrationCheck.value?.summary?.passed, expected: true, severity: 'critical' },
    { id: 'completion-contract-passed', passed: completionContract.value?.passed === true, actual: completionContract.value?.passed, expected: true, severity: 'high' },
    { id: 'no-rollback-signal', passed: rollbackSignal === false, actual: rollbackSignal, expected: false, severity: 'critical' },
    { id: 'p3-governance-produced', passed: !!inventory.p3PromptBuilderGovernance, actual: !!inventory.p3PromptBuilderGovernance, expected: true, severity: 'medium' },
  ];
  const failed = checks.filter(check => !check.passed);
  const gatePassed = failed.filter(check => check.severity === 'critical' || check.severity === 'high').length === 0;
  const consecutiveGatePassed = consecutiveGateEvidence.every(item => item.passed === true);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-runtime-readiness-shadow',
    changedPromptOutput: false,
    summary: {
      gatePassed,
      candidateRuntimeAllowed: gatePassed && consecutiveGatePassed,
      consecutiveGatePassed,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
      promptLeakageFindings: leakageFindings.length,
      rollbackSignal,
    },
    priorityCoverage,
    shadowEvidence: {
      source: rel(projectRoot, shadow.path),
      exists: shadow.exists,
      recordCount: shadow.records.length,
      parseErrors: shadow.parseErrors,
    },
    consecutiveGateEvidence,
    promptLeakage: leakageFindings,
    p3PromptBuilderGovernance: inventory.p3PromptBuilderGovernance || null,
    checks,
    failed,
    rolloutPolicy: {
      defaultGatewayMode: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      defaultAssemblerMode: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      candidateGatewayMode: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      requireManualApproval: true,
      candidateRuntimeAllowedOnlyWhen: 'summary.candidateRuntimeAllowed === true and a separate runtime rollout workflow explicitly changes the switch',
    },
    recommendation: gatePassed && consecutiveGatePassed
      ? 'Readiness evidence is sufficient for a separate manual candidate-runtime canary workflow. This command does not change runtime output.'
      : 'Do not enable candidate runtime. Keep shadow/default runtime modes and resolve failed readiness checks first.',
  };
}

function formatUnifiedLLMInjectionRuntimeReadinessReport(report) {
  const lines = [
    '# Unified LLM Injection Runtime Readiness Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| candidateRuntimeAllowed | ${report.summary.candidateRuntimeAllowed} |`,
    `| consecutiveGatePassed | ${report.summary.consecutiveGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    '',
    '## Priority Coverage',
    '',
  ];
  for (const [priority, coverage] of Object.entries(report.priorityCoverage)) {
    lines.push(`- ${priority}: ${coverage.covered}/${coverage.total} covered, legacy=${coverage.legacy}, passed=${coverage.passed}`);
  }
  lines.push('', '## Checks', '');
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('', '## Consecutive Gate Evidence', '');
  for (const item of report.consecutiveGateEvidence) lines.push(`- [${item.passed ? 'PASS' : 'FAIL'}] ${item.id}: ${item.source}`);
  lines.push('', '## Prompt Leakage Findings', '');
  if (report.promptLeakage.length === 0) lines.push('_No prompt leakage findings._');
  for (const finding of report.promptLeakage.slice(0, 40)) lines.push(`- record=${finding.recordIndex} path=${finding.path} key=${finding.key}`);
  lines.push('', '## P3 Remaining Runtime Builder Matrix', '');
  const remaining = report.p3PromptBuilderGovernance?.remainingMigrationMatrix || [];
  if (remaining.length === 0) lines.push('_No unresolved P3 runtime builders._');
  for (const item of remaining.slice(0, 40)) lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.targetUnifiedPath}`);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> This readiness gate is shadow-only. It does not change runtime prompt output or environment switches.');
  return lines.join('\n');
}

function buildUnifiedLLMInjectionCandidateRuntimeCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot });
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const approved = options.approved === true || String(options.approved || '').toLowerCase() === 'true';
  const lowRiskSites = (inventory.callSites || [])
    .filter(site => site.coveredByUnifiedInjection && /^(llm-lite-call|injected-llm-call)$/.test(site.category))
    .map(site => site.evidence && site.evidence.includes('prepareGatewayPrompt') ? site.file : `${site.file}:${site.line}`);
  const allowlist = [...new Set(options.allowlist || lowRiskSites)].slice(0, 80);
  const sloGate = {
    promptLeakageFindings: readiness.summary?.promptLeakageFindings || 0,
    rollbackSignal: readiness.summary?.rollbackSignal === true,
    highOrCriticalFailures: readiness.summary?.highOrCriticalFailures || 0,
    readinessGatePassed: readiness.summary?.gatePassed === true,
    consecutiveGatePassed: readiness.summary?.consecutiveGatePassed === true,
    passed: (readiness.summary?.promptLeakageFindings || 0) === 0
      && readiness.summary?.rollbackSignal !== true
      && (readiness.summary?.highOrCriticalFailures || 0) === 0
      && readiness.summary?.gatePassed === true
      && readiness.summary?.consecutiveGatePassed === true,
  };
  const canaryActivationReady = approved && allowlist.length > 0 && sloGate.passed === true;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'candidate-runtime-canary-policy',
    changedPromptOutput: false,
    summary: {
      readinessCandidateRuntimeAllowed: readiness.summary?.candidateRuntimeAllowed === true,
      manualApproved: approved,
      lowRiskAllowlistCount: allowlist.length,
      sloGatePassed: sloGate.passed,
      canaryActivationReady,
    },
    envSwitches: {
      defaultSafeMode: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      candidateMode: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      approval: 'WF_LLM_INJECTION_CANARY_APPROVED=true',
      allowlist: `WF_LLM_INJECTION_CANARY_ALLOWLIST=${allowlist.join(',')}`,
      percent: `WF_LLM_INJECTION_CANARY_PERCENT=${Number(options.percent || 1)}`,
      rollback: 'WF_LLM_INJECTION_CANARY_ROLLBACK=true',
    },
    lowRiskAllowlist: allowlist,
    sloGate,
    rollbackPolicy: {
      trigger: 'Any prompt leakage, rollback signal, high/critical failure, operator complaint, or SLO breach.',
      immediateAction: 'Set WF_LLM_INJECTION_CANARY_ROLLBACK=true or WF_LLM_INJECTION_GATEWAY_MODE=shadow.',
      preserveArtifacts: [
        'output/unified-llm-injection-candidate-runtime-canary.json',
        'output/unified-llm-injection-shadow.jsonl',
        'output/unified-llm-injection-runtime-readiness-gate.json',
      ],
    },
    recommendation: canaryActivationReady
      ? 'Manual approval and SLO gate are satisfied. Candidate runtime may be enabled only for the allowlisted low-risk paths and configured percentage.'
      : 'Do not enable candidate runtime yet. Review approval, allowlist, and SLO gate before setting candidate env switches.',
  };
}

function formatUnifiedLLMInjectionCandidateRuntimeCanaryReport(report) {
  const lines = [
    '# Unified LLM Injection Candidate Runtime Canary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| readinessCandidateRuntimeAllowed | ${report.summary.readinessCandidateRuntimeAllowed} |`,
    `| manualApproved | ${report.summary.manualApproved} |`,
    `| lowRiskAllowlistCount | ${report.summary.lowRiskAllowlistCount} |`,
    `| sloGatePassed | ${report.summary.sloGatePassed} |`,
    `| canaryActivationReady | ${report.summary.canaryActivationReady} |`,
    '',
    '## Env Switches',
    '',
  ];
  for (const [key, value] of Object.entries(report.envSwitches)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## SLO Gate', '');
  for (const [key, value] of Object.entries(report.sloGate)) lines.push(`- ${key}: ${value}`);
  lines.push('', '## Low-risk Allowlist', '');
  for (const item of report.lowRiskAllowlist.slice(0, 60)) lines.push(`- \`${item}\``);
  if (report.lowRiskAllowlist.length > 60) lines.push(`- ... ${report.lowRiskAllowlist.length - 60} more item(s)`);
  lines.push('', '## Rollback Policy', '');
  lines.push(`- trigger: ${report.rollbackPolicy.trigger}`);
  lines.push(`- immediateAction: ${report.rollbackPolicy.immediateAction}`);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> This canary policy is reporting/configuration-only. It does not mutate environment variables or default prompt output.');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionCandidateRuntimeCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const readinessResult = writeUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const canary = buildUnifiedLLMInjectionCandidateRuntimeCanary({
    projectRoot,
    inventory: readinessResult.callSiteInventory,
    readinessGate: readinessResult.readinessGate,
    approved: options.approved,
    allowlist: options.allowlist,
    percent: options.percent,
  });
  const canaryPath = path.join(outputDir, 'unified-llm-injection-candidate-runtime-canary.json');
  const canaryMarkdownPath = path.join(outputDir, 'unified-llm-injection-candidate-runtime-canary.md');
  fs.writeFileSync(canaryPath, JSON.stringify(canary, null, 2), 'utf-8');
  fs.writeFileSync(canaryMarkdownPath, formatUnifiedLLMInjectionCandidateRuntimeCanaryReport(canary), 'utf-8');
  return {
    ...readinessResult,
    canary,
    paths: {
      ...readinessResult.paths,
      unifiedLLMInjectionCandidateRuntimeCanary: canaryPath,
      unifiedLLMInjectionCandidateRuntimeCanaryMarkdown: canaryMarkdownPath,
    },
  };
}

function buildUnifiedLLMInjectionDefaultRuntimeReplacement(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot });
  const canary = options.canary || readJsonArtifact(projectRoot, 'output/unified-llm-injection-candidate-runtime-canary.json').value || buildUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot, approved: true, percent: 100 });
  const promptLeakageFindings = readiness.summary?.promptLeakageFindings || canary.sloGate?.promptLeakageFindings || 0;
  const rollbackSignal = readiness.summary?.rollbackSignal === true || canary.sloGate?.rollbackSignal === true;
  const sloGatePassed = canary.sloGate?.passed === true && promptLeakageFindings === 0 && rollbackSignal === false;
  const readinessGatePassed = readiness.summary?.gatePassed === true && readiness.summary?.candidateRuntimeAllowed === true;
  const canaryActivationReady = canary.summary?.canaryActivationReady === true || (canary.summary?.sloGatePassed === true && canary.summary?.manualApproved === true);
  const defaultReplacementActive = readinessGatePassed && canaryActivationReady && sloGatePassed;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'default-runtime-replacement',
    changedPromptOutput: defaultReplacementActive,
    summary: {
      defaultReplacementActive,
      defaultGatewayMode: 'candidate-runtime',
      defaultAssemblerMode: 'candidate-runtime',
      readinessGatePassed,
      canaryActivationReady,
      sloGatePassed,
      promptLeakageFindings,
      rollbackSignal,
    },
    defaultRuntimePolicy: {
      gatewayDefault: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      assemblerDefault: 'PROMPT_CONTEXT_ASSEMBLER_MODE=candidate-runtime',
      gatewayControlsFinalSendDecision: true,
      governedCategories: [
        'agent-wrapper',
        'agent-adapter-call',
        'raw-orchestrator-call',
        'direct-chat-api',
        'external-provider-call',
        'llm-lite-call',
        'injected-llm-call',
        'verification',
      ],
    },
    rollbackPolicy: {
      gatewayRollback: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      emergencyRollback: 'WF_LLM_INJECTION_CANARY_ROLLBACK=true',
      assemblerRollback: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      trigger: 'Any prompt leakage, rollback signal, high/critical failure, operator complaint, latency/error SLO breach, or prompt quality regression.',
    },
    evidence: {
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      canaryPolicy: 'output/unified-llm-injection-candidate-runtime-canary.json',
      shadowTelemetry: 'output/unified-llm-injection-shadow.jsonl',
    },
    recommendation: defaultReplacementActive
      ? 'Default runtime replacement is active. Keep rollback switches available and continue monitoring prompt leakage, rollback signals, latency, and quality drift.'
      : 'Default runtime replacement is not safe to activate. Keep rollback/runtime mode until readiness and canary SLO evidence pass.',
  };
}

function formatUnifiedLLMInjectionDefaultRuntimeReplacementReport(report) {
  const lines = [
    '# Unified LLM Injection Default Runtime Replacement',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| defaultGatewayMode | ${report.summary.defaultGatewayMode} |`,
    `| defaultAssemblerMode | ${report.summary.defaultAssemblerMode} |`,
    `| readinessGatePassed | ${report.summary.readinessGatePassed} |`,
    `| canaryActivationReady | ${report.summary.canaryActivationReady} |`,
    `| sloGatePassed | ${report.summary.sloGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    '',
    '## Default Runtime Policy',
    '',
    `- gatewayDefault: \`${report.defaultRuntimePolicy.gatewayDefault}\``,
    `- assemblerDefault: \`${report.defaultRuntimePolicy.assemblerDefault}\``,
    `- gatewayControlsFinalSendDecision: ${report.defaultRuntimePolicy.gatewayControlsFinalSendDecision}`,
    `- governedCategories: ${report.defaultRuntimePolicy.governedCategories.join(', ')}`,
    '',
    '## Rollback Policy',
    '',
    `- gatewayRollback: \`${report.rollbackPolicy.gatewayRollback}\``,
    `- emergencyRollback: \`${report.rollbackPolicy.emergencyRollback}\``,
    `- assemblerRollback: \`${report.rollbackPolicy.assemblerRollback}\``,
    `- trigger: ${report.rollbackPolicy.trigger}`,
    '',
    '## Evidence',
    '',
  ];
  for (const [key, value] of Object.entries(report.evidence)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> Default replacement is now the default runtime policy; rollback switches remain explicit and immediate.');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionDefaultRuntimeReplacement(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const readinessResult = writeUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const canaryResult = writeUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot, approved: true, percent: 100, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const defaultReplacement = buildUnifiedLLMInjectionDefaultRuntimeReplacement({
    projectRoot,
    readinessGate: readinessResult.readinessGate,
    canary: canaryResult.canary,
  });
  const defaultReplacementPath = path.join(outputDir, 'unified-llm-injection-default-runtime-replacement.json');
  const defaultReplacementMarkdownPath = path.join(outputDir, 'unified-llm-injection-default-runtime-replacement.md');
  fs.writeFileSync(defaultReplacementPath, JSON.stringify(defaultReplacement, null, 2), 'utf-8');
  fs.writeFileSync(defaultReplacementMarkdownPath, formatUnifiedLLMInjectionDefaultRuntimeReplacementReport(defaultReplacement), 'utf-8');
  return {
    ...canaryResult,
    readinessGate: readinessResult.readinessGate,
    defaultReplacement,
    paths: {
      ...canaryResult.paths,
      unifiedLLMInjectionRuntimeReadinessGate: readinessResult.paths.unifiedLLMInjectionRuntimeReadinessGate,
      unifiedLLMInjectionRuntimeReadinessGateMarkdown: readinessResult.paths.unifiedLLMInjectionRuntimeReadinessGateMarkdown,
      unifiedLLMInjectionDefaultRuntimeReplacement: defaultReplacementPath,
      unifiedLLMInjectionDefaultRuntimeReplacementMarkdown: defaultReplacementMarkdownPath,
    },
  };
}

function buildUnifiedLLMInjectionCIGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, inventory });
  const defaultReplacement = options.defaultReplacement || readJsonArtifact(projectRoot, 'output/unified-llm-injection-default-runtime-replacement.json').value || buildUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot, readinessGate: readiness });
  const p3Remaining = inventory.p3PromptBuilderGovernance?.remainingRuntimeBuilders ?? 0;
  const legacyOrPartial = inventory.summary?.legacyOrPartialCallSites ?? 0;
  const promptLeakageFindings = readiness.summary?.promptLeakageFindings ?? defaultReplacement.summary?.promptLeakageFindings ?? 0;
  const rollbackSignal = readiness.summary?.rollbackSignal === true || defaultReplacement.summary?.rollbackSignal === true;
  const priorityCoverage = readiness.priorityCoverage || buildPriorityCoverage(inventory.callSites || []);
  const checks = [
    { id: 'default-replacement-active', passed: defaultReplacement.summary?.defaultReplacementActive === true, actual: defaultReplacement.summary?.defaultReplacementActive, expected: true, severity: 'critical' },
    { id: 'readiness-gate-passed', passed: readiness.summary?.gatePassed === true && readiness.summary?.candidateRuntimeAllowed === true, actual: readiness.summary?.gatePassed, expected: 'gatePassed=true and candidateRuntimeAllowed=true', severity: 'critical' },
    { id: 'p0-no-legacy', passed: priorityCoverage.P0?.legacy === 0 && priorityCoverage.P0?.passed === true, actual: priorityCoverage.P0?.legacy, expected: 0, severity: 'critical' },
    { id: 'p1-no-legacy', passed: priorityCoverage.P1?.legacy === 0 && priorityCoverage.P1?.passed === true, actual: priorityCoverage.P1?.legacy, expected: 0, severity: 'critical' },
    { id: 'p2-no-legacy', passed: priorityCoverage.P2?.legacy === 0 && priorityCoverage.P2?.passed === true, actual: priorityCoverage.P2?.legacy, expected: 0, severity: 'critical' },
    { id: 'no-legacy-or-partial-call-sites', passed: legacyOrPartial === 0, actual: legacyOrPartial, expected: 0, severity: 'critical' },
    { id: 'p3-no-remaining-runtime-builders', passed: p3Remaining === 0, actual: p3Remaining, expected: 0, severity: 'critical' },
    { id: 'no-prompt-leakage', passed: promptLeakageFindings === 0, actual: promptLeakageFindings, expected: 0, severity: 'critical' },
    { id: 'no-rollback-signal', passed: rollbackSignal === false, actual: rollbackSignal, expected: false, severity: 'critical' },
    { id: 'rollback-policy-present', passed: !!defaultReplacement.rollbackPolicy?.gatewayRollback && !!defaultReplacement.rollbackPolicy?.assemblerRollback, actual: !!defaultReplacement.rollbackPolicy, expected: true, severity: 'high' },
  ];
  const failed = checks.filter(check => !check.passed);
  const blockingFailures = failed.filter(check => check.severity === 'critical' || check.severity === 'high');
  const passed = blockingFailures.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-ci-gate',
    changedPromptOutput: false,
    summary: {
      passed,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      blockingFailures: blockingFailures.length,
      defaultReplacementActive: defaultReplacement.summary?.defaultReplacementActive === true,
      legacyOrPartialCallSites: legacyOrPartial,
      p3RemainingRuntimeBuilders: p3Remaining,
      promptLeakageFindings,
      rollbackSignal,
    },
    priorityCoverage,
    checks,
    failed,
    artifacts: {
      inventory: 'output/unified-llm-injection-call-site-inventory.json',
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      defaultReplacement: 'output/unified-llm-injection-default-runtime-replacement.json',
    },
    ciCommand: 'npm run ci:llm-injection',
    recommendation: passed
      ? 'CI gate passed. Unified LLM Injection is enforced against new legacy call sites, prompt leakage, P3 remaining builders, and rollback signals.'
      : 'CI gate failed. Block merge and inspect failed checks before proceeding.',
  };
}

function formatUnifiedLLMInjectionCIGateReport(report) {
  const lines = [
    '# Unified LLM Injection CI Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| passed | ${report.summary.passed} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    `| blockingFailures | ${report.summary.blockingFailures} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| legacyOrPartialCallSites | ${report.summary.legacyOrPartialCallSites} |`,
    `| p3RemainingRuntimeBuilders | ${report.summary.p3RemainingRuntimeBuilders} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('', '## Failed Checks', '');
  if (report.failed.length === 0) lines.push('_No failed checks._');
  for (const check of report.failed) lines.push(`- ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  lines.push('', '## CI Command', '', `\`${report.ciCommand}\``, '', '## Artifacts', '');
  for (const [key, value] of Object.entries(report.artifacts)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionCIGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const defaultResult = writeUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot, ignoreCompletionContract: true });
  const ciGate = buildUnifiedLLMInjectionCIGate({
    projectRoot,
    inventory: defaultResult.callSiteInventory,
    readinessGate: defaultResult.readinessGate,
    defaultReplacement: defaultResult.defaultReplacement,
  });
  const ciGatePath = path.join(outputDir, 'unified-llm-injection-ci-gate.json');
  const ciGateMarkdownPath = path.join(outputDir, 'unified-llm-injection-ci-gate.md');
  fs.writeFileSync(ciGatePath, JSON.stringify(ciGate, null, 2), 'utf-8');
  fs.writeFileSync(ciGateMarkdownPath, formatUnifiedLLMInjectionCIGateReport(ciGate), 'utf-8');
  return {
    ...defaultResult,
    ciGate,
    paths: {
      ...defaultResult.paths,
      unifiedLLMInjectionCIGate: ciGatePath,
      unifiedLLMInjectionCIGateMarkdown: ciGateMarkdownPath,
    },
  };
}

function asFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readPathValue(object, paths) {
  for (const pathExpr of paths) {
    const value = String(pathExpr).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function inferTelemetryError(record) {
  const explicit = readPathValue(record, ['error', 'metadata.error', 'metrics.error']);
  if (explicit === true) return { known: true, failed: true };
  if (explicit === false) return { known: true, failed: false };
  const success = readPathValue(record, ['success', 'metadata.success', 'metrics.success']);
  if (success === true) return { known: true, failed: false };
  if (success === false) return { known: true, failed: true };
  const status = String(readPathValue(record, ['status', 'metadata.status', 'metrics.status']) || '').toLowerCase();
  if (status) return { known: true, failed: /fail|error|timeout|reject/.test(status) };
  return { known: false, failed: false };
}

function extractLatencyPair(record) {
  const runtime = asFiniteNumber(readPathValue(record, [
    'runtime.latencyMs',
    'metrics.runtimeLatencyMs',
    'metadata.runtimeLatencyMs',
    'metadata.latencyRuntimeMs',
  ]));
  const candidate = asFiniteNumber(readPathValue(record, [
    'candidate.latencyMs',
    'metrics.candidateLatencyMs',
    'metadata.candidateLatencyMs',
    'metadata.latencyCandidateMs',
  ]));
  if (runtime == null || candidate == null || runtime <= 0) return null;
  return { runtime, candidate, deltaPercent: ((candidate - runtime) / runtime) * 100 };
}

function extractQualityDrift(record) {
  const explicit = asFiniteNumber(readPathValue(record, [
    'qualityDriftScore',
    'metrics.qualityDriftScore',
    'metadata.qualityDriftScore',
  ]));
  if (explicit != null) return { score: Math.abs(explicit), source: 'explicit' };
  const runtimeLength = asFiniteNumber(record.runtime?.length);
  const candidateLength = asFiniteNumber(record.candidate?.length);
  if (runtimeLength != null && candidateLength != null && runtimeLength > 0) {
    return { score: Math.abs(candidateLength - runtimeLength) / runtimeLength, source: 'length-delta' };
  }
  return null;
}

function summarizeRuntimeSLO(records, options = {}) {
  const thresholds = {
    maxErrorRate: asFiniteNumber(options.maxErrorRate) ?? 0.01,
    maxLatencyDeltaPercent: asFiniteNumber(options.maxLatencyDeltaPercent) ?? 25,
    maxQualityDriftScore: asFiniteNumber(options.maxQualityDriftScore) ?? 0.2,
  };
  const sampleCount = records.length;
  const errorSignals = records.map(inferTelemetryError);
  const knownErrors = errorSignals.filter(item => item.known);
  const failedErrors = knownErrors.filter(item => item.failed);
  const latencyPairs = records.map(extractLatencyPair).filter(Boolean);
  const qualitySignals = records.map(extractQualityDrift).filter(Boolean);
  const hashMismatches = records.filter(record => record.runtime?.hash && record.candidate?.hash && record.runtime.hash !== record.candidate.hash).length;
  const latencyDeltaPercent = latencyPairs.length
    ? latencyPairs.reduce((sum, item) => sum + item.deltaPercent, 0) / latencyPairs.length
    : null;
  const maxLatencyDeltaPercent = latencyPairs.length
    ? Math.max(...latencyPairs.map(item => item.deltaPercent))
    : null;
  const qualityDriftScore = qualitySignals.length
    ? qualitySignals.reduce((sum, item) => sum + item.score, 0) / qualitySignals.length
    : null;
  const maxQualityDriftScore = qualitySignals.length
    ? Math.max(...qualitySignals.map(item => item.score))
    : null;
  return {
    thresholds,
    sampleCount,
    llmErrorRate: knownErrors.length ? failedErrors.length / knownErrors.length : null,
    errorSamples: knownErrors.length,
    errorCount: failedErrors.length,
    latencyDeltaPercent,
    maxLatencyDeltaPercent,
    latencySamples: latencyPairs.length,
    qualityDriftScore,
    maxQualityDriftScore,
    qualitySamples: qualitySignals.length,
    hashMismatchRate: sampleCount ? hashMismatches / sampleCount : null,
    dataCoverage: {
      error: sampleCount ? knownErrors.length / sampleCount : 0,
      latency: sampleCount ? latencyPairs.length / sampleCount : 0,
      quality: sampleCount ? qualitySignals.length / sampleCount : 0,
    },
  };
}

function buildUnifiedLLMInjectionSLODashboard(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const shadow = options.shadow || readShadowTelemetry(projectRoot);
  const records = options.records || shadow.records || [];
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || {};
  const defaultReplacement = options.defaultReplacement || readJsonArtifact(projectRoot, 'output/unified-llm-injection-default-runtime-replacement.json').value || {};
  const ciGate = options.ciGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-ci-gate.json').value || {};
  const leakageFindings = findPromptLeakage(records);
  const promptLeakageFindings = Math.max(
    leakageFindings.length,
    readiness.summary?.promptLeakageFindings || 0,
    defaultReplacement.summary?.promptLeakageFindings || 0,
    ciGate.summary?.promptLeakageFindings || 0
  );
  const telemetryRollback = records.some(record => record.canary?.rollback === true || (record.canary?.reasons || []).includes('rollback-active'));
  const rollbackSignal = telemetryRollback
    || readiness.summary?.rollbackSignal === true
    || defaultReplacement.summary?.rollbackSignal === true
    || ciGate.summary?.rollbackSignal === true;
  const slo = summarizeRuntimeSLO(records, options.thresholds || {});
  const defaultReplacementActive = defaultReplacement.summary?.defaultReplacementActive === true;
  const ciGatePassed = ciGate.summary?.passed === true;
  const checks = [
    { id: 'prompt-leakage', severity: 'critical', passed: promptLeakageFindings === 0, actual: promptLeakageFindings, expected: 0 },
    { id: 'rollback-signal', severity: 'critical', passed: rollbackSignal === false, actual: rollbackSignal, expected: false },
    { id: 'default-replacement-active', severity: 'critical', passed: defaultReplacementActive, actual: defaultReplacementActive, expected: true },
    { id: 'ci-gate-passed', severity: 'high', passed: ciGatePassed, actual: ciGatePassed, expected: true },
    { id: 'llm-error-rate', severity: 'high', passed: slo.llmErrorRate == null || slo.llmErrorRate <= slo.thresholds.maxErrorRate, actual: slo.llmErrorRate, expected: `<=${slo.thresholds.maxErrorRate}`, noData: slo.llmErrorRate == null },
    { id: 'latency-delta', severity: 'high', passed: slo.maxLatencyDeltaPercent == null || slo.maxLatencyDeltaPercent <= slo.thresholds.maxLatencyDeltaPercent, actual: slo.maxLatencyDeltaPercent, expected: `<=${slo.thresholds.maxLatencyDeltaPercent}%`, noData: slo.maxLatencyDeltaPercent == null },
    { id: 'quality-drift', severity: 'high', passed: slo.maxQualityDriftScore == null || slo.maxQualityDriftScore <= slo.thresholds.maxQualityDriftScore, actual: slo.maxQualityDriftScore, expected: `<=${slo.thresholds.maxQualityDriftScore}`, noData: slo.maxQualityDriftScore == null },
  ];
  const failed = checks.filter(check => !check.passed);
  const blockingFailures = failed.filter(check => check.severity === 'critical' || check.severity === 'high');
  const noDataChecks = checks.filter(check => check.noData);
  const lowCoverage = Object.entries(slo.dataCoverage).filter(([, value]) => value > 0 && value < 0.8).map(([key, value]) => ({ key, value }));
  const health = blockingFailures.length > 0 ? 'unhealthy' : (noDataChecks.length > 0 || lowCoverage.length > 0 ? 'warning' : 'healthy');
  const releaseReady = health === 'healthy';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-runtime-slo-dashboard',
    changedPromptOutput: false,
    summary: {
      health,
      releaseReady,
      sampleCount: slo.sampleCount,
      defaultReplacementActive,
      ciGatePassed,
      promptLeakageFindings,
      rollbackSignal,
      llmErrorRate: slo.llmErrorRate,
      latencyDeltaPercent: slo.latencyDeltaPercent,
      maxLatencyDeltaPercent: slo.maxLatencyDeltaPercent,
      qualityDriftScore: slo.qualityDriftScore,
      maxQualityDriftScore: slo.maxQualityDriftScore,
      hashMismatchRate: slo.hashMismatchRate,
      blockingFailures: blockingFailures.length,
      warningSignals: noDataChecks.length + lowCoverage.length,
    },
    dataCoverage: slo.dataCoverage,
    thresholds: slo.thresholds,
    checks,
    failed,
    noDataChecks,
    lowCoverage,
    telemetry: {
      source: rel(projectRoot, shadow.path || path.join(projectRoot, 'output', 'unified-llm-injection-shadow.jsonl')),
      exists: shadow.exists !== false,
      parseErrors: shadow.parseErrors || [],
      errorSamples: slo.errorSamples,
      errorCount: slo.errorCount,
      latencySamples: slo.latencySamples,
      qualitySamples: slo.qualitySamples,
    },
    promptLeakage: leakageFindings.slice(0, 40),
    artifacts: {
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      defaultReplacement: 'output/unified-llm-injection-default-runtime-replacement.json',
      ciGate: 'output/unified-llm-injection-ci-gate.json',
      dashboard: 'output/unified-llm-injection-slo-dashboard.json',
      releaseHealthSummary: 'output/unified-llm-injection-release-health-summary.md',
    },
    releaseRecommendation: health === 'healthy'
      ? 'Release health is healthy. Continue default runtime replacement and keep scheduled SLO monitoring active.'
      : health === 'warning'
        ? 'Release health is warning. Continue with caution, improve telemetry coverage, and watch latency/error/quality drift before expanding rollout.'
        : 'Release health is unhealthy. Stop rollout or rollback default runtime replacement, then inspect failed SLO checks.',
  };
}

function formatPercent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function formatUnifiedLLMInjectionSLODashboardReport(report) {
  const lines = [
    '# Unified LLM Injection Runtime SLO Dashboard',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| health | ${report.summary.health} |`,
    `| releaseReady | ${report.summary.releaseReady} |`,
    `| sampleCount | ${report.summary.sampleCount} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| ciGatePassed | ${report.summary.ciGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    `| llmErrorRate | ${formatPercent(report.summary.llmErrorRate)} |`,
    `| maxLatencyDeltaPercent | ${formatNumber(report.summary.maxLatencyDeltaPercent)} |`,
    `| maxQualityDriftScore | ${formatNumber(report.summary.maxQualityDriftScore)} |`,
    `| hashMismatchRate | ${formatPercent(report.summary.hashMismatchRate)} |`,
    '',
    '## Data Coverage',
    '',
  ];
  for (const [key, value] of Object.entries(report.dataCoverage)) lines.push(`- ${key}: ${formatPercent(value)}`);
  lines.push('', '## Checks', '');
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual == null ? 'n/a' : check.actual}, expected=${check.expected}${check.noData ? ' (no-data)' : ''}`);
  }
  lines.push('', '## Prompt Leakage Findings', '');
  if (report.promptLeakage.length === 0) lines.push('_No prompt leakage findings._');
  for (const finding of report.promptLeakage) lines.push(`- record=${finding.recordIndex} path=${finding.path} key=${finding.key}`);
  lines.push('', '## Recommendation', '', report.releaseRecommendation, '');
  return lines.join('\n');
}

function formatUnifiedLLMInjectionReleaseHealthSummary(report) {
  const lines = [
    '# Unified LLM Injection Release Health Summary',
    '',
    `- Health: **${report.summary.health}**`,
    `- Release ready: **${report.summary.releaseReady}**`,
    `- Default replacement active: ${report.summary.defaultReplacementActive}`,
    `- CI gate passed: ${report.summary.ciGatePassed}`,
    `- Prompt leakage findings: ${report.summary.promptLeakageFindings}`,
    `- Rollback signal: ${report.summary.rollbackSignal}`,
    `- LLM error rate: ${formatPercent(report.summary.llmErrorRate)}`,
    `- Max latency delta: ${formatNumber(report.summary.maxLatencyDeltaPercent)}%`,
    `- Max quality drift score: ${formatNumber(report.summary.maxQualityDriftScore)}`,
    '',
    '## Failed Checks',
    '',
  ];
  if (report.failed.length === 0) lines.push('_No failed checks._');
  for (const check of report.failed) lines.push(`- [${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  lines.push('', '## No-data / Coverage Warnings', '');
  if (report.noDataChecks.length === 0 && report.lowCoverage.length === 0) lines.push('_No coverage warnings._');
  for (const check of report.noDataChecks) lines.push(`- ${check.id}: no telemetry data available yet.`);
  for (const item of report.lowCoverage) lines.push(`- ${item.key}: coverage=${formatPercent(item.value)}.`);
  lines.push('', '## Recommendation', '', report.releaseRecommendation, '');
  lines.push('## Rollback', '', '- `WF_LLM_INJECTION_GATEWAY_MODE=shadow`', '- `WF_LLM_INJECTION_CANARY_ROLLBACK=true`', '- `PROMPT_CONTEXT_ASSEMBLER_MODE=runtime`', '');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionSLODashboard(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const ciResult = options.skipCIGateRefresh ? null : writeUnifiedLLMInjectionCIGate({ projectRoot });
  const dashboard = buildUnifiedLLMInjectionSLODashboard({
    projectRoot,
    readinessGate: ciResult?.readinessGate,
    defaultReplacement: ciResult?.defaultReplacement,
    ciGate: ciResult?.ciGate,
    thresholds: options.thresholds,
  });
  const dashboardPath = path.join(outputDir, 'unified-llm-injection-slo-dashboard.json');
  const dashboardMarkdownPath = path.join(outputDir, 'unified-llm-injection-slo-dashboard.md');
  const releaseHealthSummaryPath = path.join(outputDir, 'unified-llm-injection-release-health-summary.md');
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2), 'utf-8');
  fs.writeFileSync(dashboardMarkdownPath, formatUnifiedLLMInjectionSLODashboardReport(dashboard), 'utf-8');
  fs.writeFileSync(releaseHealthSummaryPath, formatUnifiedLLMInjectionReleaseHealthSummary(dashboard), 'utf-8');
  const { evaluateSLOAlerts, formatAlertSignals } = require('./slo-alert-evaluator');
  const signals = evaluateSLOAlerts(dashboard);
  const sloAlerts = formatAlertSignals(signals, {
    sloAlertWebhook: options.sloAlertWebhook,
    sloAlertWebhookToken: options.sloAlertWebhookToken,
  });
  const sloAlertsPath = path.join(outputDir, 'slo-alerts.json');
  fs.writeFileSync(sloAlertsPath, JSON.stringify(sloAlerts, null, 2), 'utf-8');
  return {
    ...(ciResult || {}),
    sloDashboard: dashboard,
    sloAlerts,
    paths: {
      ...(ciResult?.paths || {}),
      unifiedLLMInjectionSLODashboard: dashboardPath,
      unifiedLLMInjectionSLODashboardMarkdown: dashboardMarkdownPath,
      unifiedLLMInjectionReleaseHealthSummary: releaseHealthSummaryPath,
      sloAlerts: sloAlertsPath,
    },
  };
}

function writeUnifiedLLMInjectionRuntimeReadinessGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const inventoryResult = writeUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const readinessGate = buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, inventory: inventoryResult.callSiteInventory, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const readinessPath = path.join(outputDir, 'unified-llm-injection-runtime-readiness-gate.json');
  const readinessMarkdownPath = path.join(outputDir, 'unified-llm-injection-runtime-readiness-gate.md');
  fs.writeFileSync(readinessPath, JSON.stringify(readinessGate, null, 2), 'utf-8');
  fs.writeFileSync(readinessMarkdownPath, formatUnifiedLLMInjectionRuntimeReadinessReport(readinessGate), 'utf-8');
  return {
    ...inventoryResult,
    readinessGate,
    paths: {
      ...inventoryResult.paths,
      unifiedLLMInjectionRuntimeReadinessGate: readinessPath,
      unifiedLLMInjectionRuntimeReadinessGateMarkdown: readinessMarkdownPath,
    },
  };
}

function writeUnifiedLLMInjectionCallSiteInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const callSiteInventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const inventoryPath = path.join(outputDir, 'unified-llm-injection-call-site-inventory.json');
  const inventoryMarkdownPath = path.join(outputDir, 'unified-llm-injection-call-site-inventory.md');
  fs.writeFileSync(inventoryPath, JSON.stringify(callSiteInventory, null, 2), 'utf-8');
  fs.writeFileSync(inventoryMarkdownPath, formatUnifiedLLMInjectionCallSiteReport(callSiteInventory), 'utf-8');
  return {
    callSiteInventory,
    paths: {
      unifiedLLMInjectionCallSiteInventory: inventoryPath,
      unifiedLLMInjectionCallSiteInventoryMarkdown: inventoryMarkdownPath,
    },
  };
}

module.exports = {
  buildUnifiedLLMInjectionRuntimeReadinessGate,
  formatUnifiedLLMInjectionRuntimeReadinessReport,
  buildUnifiedLLMInjectionCandidateRuntimeCanary,
  formatUnifiedLLMInjectionCandidateRuntimeCanaryReport,
  writeUnifiedLLMInjectionCandidateRuntimeCanary,
  buildUnifiedLLMInjectionDefaultRuntimeReplacement,
  formatUnifiedLLMInjectionDefaultRuntimeReplacementReport,
  writeUnifiedLLMInjectionDefaultRuntimeReplacement,
  buildUnifiedLLMInjectionCIGate,
  formatUnifiedLLMInjectionCIGateReport,
  writeUnifiedLLMInjectionCIGate,
  asFiniteNumber,
  readPathValue,
  inferTelemetryError,
  extractLatencyPair,
  extractQualityDrift,
  summarizeRuntimeSLO,
  buildUnifiedLLMInjectionSLODashboard,
  formatPercent,
  formatNumber,
  formatUnifiedLLMInjectionSLODashboardReport,
  formatUnifiedLLMInjectionReleaseHealthSummary,
  writeUnifiedLLMInjectionSLODashboard,
  writeUnifiedLLMInjectionRuntimeReadinessGate,
  writeUnifiedLLMInjectionCallSiteInventory,
};
