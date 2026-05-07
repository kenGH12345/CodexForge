
'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION, createCollector, rel, safeRead, collectFiles, normalizeContent, sha256 } = require('./pci-utils');
const { scanStaticSourceFiles, scanContextLoaderMandatoryDocs, scanSkills, scanContextDigests } = require('./pci-scanners');
const { buildDuplicateReport, buildPromptContextDuplicateGovernance, formatMergeSuggestions } = require('./pci-duplicate-governance');
const { buildPromptContextRegistry, buildPromptContextShadowAssembly, formatShadowAssemblyReport, registryEntryFromBlock, governanceByBlockId } = require('./pci-registry-assembly');
const { buildPromptContextAssemblerShadowDiff, formatAssemblerShadowDiffReport, buildPromptContextDynamicContextShadowDiff, formatDynamicContextShadowDiffReport, buildPromptContextSelectionBudget } = require('./pci-shadow-diff');
const { buildPromptContextFullPromptShadowParity, buildPromptContextDualWriteCanary, buildPromptContextMigrationGate, formatMigrationGateReport, buildPromptContextMigrationCheck, formatMigrationCheckReport, classifyP3PromptBuilder, buildP3PromptBuilderGovernance, _classifyLLMCallSite } = require('./pci-full-prompt-parity');

function buildUnifiedLLMInjectionCallSiteInventory({ projectRoot } = {}) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const workflowDir = path.join(actualProjectRoot, 'workflow');
  const files = collectFiles(workflowDir, (abs, name) => name.endsWith('.js') && !/\.test\.js$/.test(name));
  const callSites = [];
  const seen = new Set();
  const llmPattern = /buildAgentPrompt\s*\(|\.llm\.chat\s*\(|_rawLlmCall\s*\(|\b(?:this\.)?llmCall\s*\(|agent\.llmCall\s*\(|_llmCall\s*\(|cheapLlmCall\s*\(|_cheapLlmCall\s*\(|_semanticLlmCall\s*\(|effectiveLlmCall\s*\(|chat\/completions|axios\.post\s*\(|build[A-Za-z0-9_]*Prompt\s*\(/;
  for (const filePath of files) {
    const fileRel = rel(actualProjectRoot, filePath);
    if (/workflow\/tests?\//.test(fileRel) || /workflow\/examples\//.test(fileRel)) continue;
    const lines = safeRead(filePath).split(/\r?\n/);
    const gatewayLines = lines
      .map((line, index) => (/LLMInjectionGateway|llmInjectionGateway|prepareGatewayPrompt|prepareTaskLLMChatPayload|prepareAutoDispatchPrompt|initLlmInjectionGateway\.prepare/.test(line) ? index + 1 : null))
      .filter(Boolean);
    lines.forEach((line, index) => {
      const trimmed = String(line || '').trim();
      if (/^(\/\/|\/\*|\*)/.test(trimmed)) return;
      if (/\bllmCall\s*\(\s*\)/.test(trimmed)) return;
      if (/step\d+\s*:.*llmCall\(prompt\)/.test(trimmed)) return;
      if (!llmPattern.test(line)) return;
      const lineNumber = index + 1;
      const hasGatewayNearby = gatewayLines.some(gatewayLine => Math.abs(gatewayLine - lineNumber) <= 18);
      const site = _classifyLLMCallSite(fileRel, line, lineNumber, { hasGatewayNearby, fileHasGateway: gatewayLines.length > 0 });
      const key = `${site.file}:${site.line}:${site.category}`;
      if (seen.has(key)) return;
      seen.add(key);
      callSites.push(site);
    });
  }
  const byCategory = {};
  const byPriority = {};
  const byStatus = {};
  for (const site of callSites) {
    byCategory[site.category] = (byCategory[site.category] || 0) + 1;
    byPriority[site.priority] = (byPriority[site.priority] || 0) + 1;
    byStatus[site.status] = (byStatus[site.status] || 0) + 1;
  }
  const covered = callSites.filter(site => site.coveredByUnifiedInjection).length;
  const governed = callSites.filter(site => site.governedByUnifiedInjection).length;
  const legacyOrPartial = callSites.filter(site => site.status === 'legacy-direct-or-partial').length;
  const documentedExceptions = callSites.filter(site => site.status === 'documented-exception').length;
  const p3PromptBuilderGovernance = buildP3PromptBuilderGovernance(callSites);
  const migrationMatrix = callSites.map(site => ({
    file: site.file,
    line: site.line,
    category: site.category,
    priority: site.priority,
    currentPath: site.coveredByUnifiedInjection
      ? 'LLMInjectionGateway routed call site'
      : site.status === 'documented-exception'
        ? `documented P3 exception: ${site.p3Governance?.kind || 'exception'}`
        : 'legacy direct LLM call or unresolved prompt builder',
    targetUnifiedPath: site.status === 'documented-exception'
      ? site.p3Governance?.recommendedAction || 'Document exception and keep runtime send point gated.'
      : site.priority === 'P0'
        ? 'LLMInjectionGateway required'
        : 'LLMInjectionGateway or documented exception required',
    status: site.status,
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'call-site-inventory-shadow',
    changedPromptOutput: false,
    summary: {
      totalCallSites: callSites.length,
      coveredByUnifiedInjection: covered,
      governedByUnifiedInjection: governed,
      documentedExceptions,
      legacyOrPartialCallSites: legacyOrPartial,
      coverageRate: callSites.length ? Number((covered / callSites.length).toFixed(4)) : 1,
      governanceRate: callSites.length ? Number((governed / callSites.length).toFixed(4)) : 1,
      byCategory,
      byPriority,
      byStatus,
    },
    callSites,
    migrationMatrix,
    p3PromptBuilderGovernance,
    recommendations: [
      'Keep PromptContextAssembler default mode at runtime until CI/manual gate and canary evidence remain stable.',
      'Migrate P0 call sites first: workflow/index.js, BaseAgent, direct chat/API calls, and task orchestrator paths.',
      'Treat LLM-lite maintenance calls as documented exceptions unless they must receive full workflow context.',
    ],
  };
}

function formatUnifiedLLMInjectionCallSiteReport(report) {
  const lines = [
    '# Unified LLM Injection Call-Site Inventory',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| totalCallSites | ${report.summary.totalCallSites} |`,
    `| coveredByUnifiedInjection | ${report.summary.coveredByUnifiedInjection} |`,
    `| governedByUnifiedInjection | ${report.summary.governedByUnifiedInjection || report.summary.coveredByUnifiedInjection} |`,
    `| documentedExceptions | ${report.summary.documentedExceptions || 0} |`,
    `| legacyOrPartialCallSites | ${report.summary.legacyOrPartialCallSites} |`,
    `| coverageRate | ${report.summary.coverageRate} |`,
    `| governanceRate | ${report.summary.governanceRate || report.summary.coverageRate} |`,
    '',
    '## Priority Summary',
    '',
    ...Object.entries(report.summary.byPriority).map(([priority, count]) => `- ${priority}: ${count}`),
    '',
    '## Migration Matrix',
    '',
    '| Priority | Status | Category | Location | Target |',
    '|---|---|---|---|---|',
  ];
  for (const site of report.migrationMatrix.slice(0, 80)) {
    lines.push(`| ${site.priority} | ${site.status} | ${site.category} | \`${site.file}:${site.line}\` | ${site.targetUnifiedPath} |`);
  }
  if (report.migrationMatrix.length > 80) lines.push(`| ... | ... | ... | ... | ${report.migrationMatrix.length - 80} more call site(s) |`);
  lines.push('');
  if (report.p3PromptBuilderGovernance) {
    lines.push('## P3 Prompt Builder Governance');
    lines.push('');
    lines.push(`- totalPromptBuilders: ${report.p3PromptBuilderGovernance.totalPromptBuilders}`);
    lines.push(`- documentedExceptions: ${report.p3PromptBuilderGovernance.documentedExceptions}`);
    lines.push(`- remainingRuntimeBuilders: ${report.p3PromptBuilderGovernance.remainingRuntimeBuilders}`);
    lines.push('');
    lines.push('### Exception List');
    lines.push('');
    for (const item of report.p3PromptBuilderGovernance.exceptions.slice(0, 40)) {
      lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.reason}`);
    }
    if (report.p3PromptBuilderGovernance.exceptions.length > 40) lines.push(`- ... ${report.p3PromptBuilderGovernance.exceptions.length - 40} more exception(s)`);
    lines.push('');
    lines.push('### Remaining Runtime Builder Matrix');
    lines.push('');
    if (report.p3PromptBuilderGovernance.remainingMigrationMatrix.length === 0) lines.push('_No unresolved P3 runtime builders._');
    for (const item of report.p3PromptBuilderGovernance.remainingMigrationMatrix.slice(0, 40)) {
      lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.targetUnifiedPath}`);
    }
    if (report.p3PromptBuilderGovernance.remainingMigrationMatrix.length > 40) lines.push(`- ... ${report.p3PromptBuilderGovernance.remainingMigrationMatrix.length - 40} more unresolved builder(s)`);
    lines.push('');
  }
  lines.push('## Recommendations');
  lines.push('');
  for (const item of report.recommendations) lines.push(`- ${item}`);
  lines.push('');
  lines.push('> This inventory is shadow-only. It scans prompt/LLM call sites but does not change prompt output.');
  return lines.join('\n');
}

function formatDualWriteCanaryReport(report) {
  const lines = [
    '# PromptContextAssembler Dual-Write Canary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| payloadCount | ${report.summary.payloadCount} |`,
    `| averageRuntimeTokenCoverage | ${report.summary.averageRuntimeTokenCoverage} |`,
    `| averageJaccardSimilarity | ${report.summary.averageJaccardSimilarity} |`,
    `| rollbackGatePassed | ${report.summary.rollbackGatePassed} |`,
    `| shouldRollback | ${report.summary.shouldRollback} |`,
    '',
    '## Role Payload Diff',
    '',
  ];
  for (const payload of report.payloads) {
    lines.push(`### ${payload.stage}/${payload.role}`);
    lines.push(`- runtimeHash: ${payload.runtime.hash}`);
    lines.push(`- candidateHash: ${payload.candidate.hash}`);
    lines.push(`- runtimeLength: ${payload.runtime.length}`);
    lines.push(`- candidateLength: ${payload.candidate.length}`);
    lines.push(`- runtimeTokenCoverage: ${payload.diff.runtimeTokenCoverage}`);
    lines.push(`- jaccardSimilarity: ${payload.diff.jaccardSimilarity}`);
    lines.push(`- runtimeOnlyTop: ${payload.diff.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${payload.diff.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    if (payload.runtime.error) lines.push(`- runtimeError: ${payload.runtime.error}`);
    lines.push('');
  }
  lines.push('## Rollback Gate');
  lines.push('');
  lines.push(`- passed: ${report.rollbackGate.passed}`);
  lines.push(`- shouldRollback: ${report.rollbackGate.shouldRollback}`);
  lines.push(`- passedChecks: ${report.rollbackGate.summary.passedChecks}/${report.rollbackGate.summary.totalChecks}`);
  for (const failure of report.rollbackGate.failed) {
    lines.push(`- [${failure.severity}] ${failure.id}: actual=${failure.actual}, expected=${failure.expected}`);
  }
  lines.push('');
  lines.push('> This canary is shadow-only. It records runtime and candidate payloads but does not replace ContextLoader, buildAgentPrompt, workflow-stage, or runtime prompt output.');
  return lines.join('\n');
}

function formatFullPromptParityReport(report) {
  const lines = [
    '# PromptContextAssembler Full Prompt Shadow Parity',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| candidatePromptCount | ${report.summary.candidatePromptCount} |`,
    `| averageRuntimeTokenCoverage | ${report.summary.averageRuntimeTokenCoverage} |`,
    `| averageJaccardSimilarity | ${report.summary.averageJaccardSimilarity} |`,
    `| totalCandidateLength | ${report.summary.totalCandidateLength} |`,
    `| totalRuntimeLength | ${report.summary.totalRuntimeLength} |`,
    '',
    '## Role Parity',
    '',
  ];
  for (const item of report.roleDiffs) {
    lines.push(`### ${item.stage}/${item.role}`);
    lines.push(`- runtimePromptLength: ${item.runtimePromptLength}`);
    lines.push(`- candidatePromptLength: ${item.candidatePromptLength}`);
    lines.push(`- contextSections: ${item.contextSections}`);
    lines.push(`- runtimeTokenCoverage: ${item.runtimeTokenCoverage}`);
    lines.push(`- jaccardSimilarity: ${item.jaccardSimilarity}`);
    lines.push(`- runtimeOnlyTop: ${item.comparison.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${item.comparison.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    if (item.runtimeError) lines.push(`- runtimeError: ${item.runtimeError}`);
    lines.push('');
  }
  lines.push('> This full prompt parity report is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

function formatSelectionBudgetReport(report) {
  const lines = [
    '# PromptContextRegistry Selection Budget',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| selectedBlocks | ${report.summary.selectedBlocks} |`,
    `| selectedEstimatedTokens | ${report.summary.selectedEstimatedTokens} |`,
    `| omittedBlocks | ${report.summary.omittedBlocks} |`,
    `| driftAlertCount | ${report.summary.driftAlertCount} |`,
    `| highDriftAlertCount | ${report.summary.highDriftAlertCount} |`,
    '',
    '## Role Budgets',
    '',
  ];
  for (const roleBudget of report.roleBudgets) {
    lines.push(`### ${roleBudget.stage}/${roleBudget.role}`);
    lines.push(`- selectedBlocks: ${roleBudget.selectedBlocks}/${roleBudget.budget.maxBlocks}`);
    lines.push(`- selectedEstimatedTokens: ${roleBudget.selectedEstimatedTokens}/${roleBudget.budget.maxTokens}`);
    lines.push(`- omittedBlocks: ${roleBudget.omittedBlocks}`);
    for (const block of roleBudget.blocks) {
      lines.push(`  - ${block.blockId} — ${block.type} — tokens=${block.tokenEstimate} — score=${block.matchScore}`);
    }
    lines.push('');
  }
  lines.push('## Drift Alerts');
  lines.push('');
  if (report.driftAlerts.length === 0) lines.push('_No drift alerts._');
  for (const alert of report.driftAlerts.slice(0, 40)) {
    lines.push(`- [${alert.severity}] ${alert.type}: ${alert.message}`);
  }
  lines.push('');
  lines.push('> This selection budget is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

async function resolveContextLoaderSnapshots(projectRoot, requirement) {
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
  const stageRoles = [
    ['ANALYSE', 'analyst'],
    ['ARCHITECT', 'architect'],
    ['PLAN', 'planner'],
    ['DEVELOP', 'developer'],
    ['TEST', 'test-report'],
  ];
  const contexts = [];
  for (const [stage, role] of stageRoles) {
    const resolved = await loader.resolve(requirement || 'PromptContextAssembler dynamic context shadow diff', role, { stage });
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

function formatDuplicateReport(report) {
  const lines = [
    '# PromptContextBlock Duplicate Report',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| totalBlocks | ${report.summary.totalBlocks} |`,
    `| exactDuplicateGroups | ${report.summary.exactDuplicateGroups} |`,
    `| normalizedDuplicateGroups | ${report.summary.normalizedDuplicateGroups} |`,
    `| nearDuplicatePairs | ${report.summary.nearDuplicatePairs} |`,
    `| duplicateBlockCount | ${report.summary.duplicateBlockCount} |`,
    '',
    '## Normalized Duplicate Groups',
    '',
  ];

  if (report.normalizedDuplicates.length === 0) lines.push('_No normalized duplicate groups found._');
  for (const group of report.normalizedDuplicates.slice(0, 20)) {
    lines.push(`### ${group.hash.slice(0, 12)} (${group.count} blocks)`);
    for (const block of group.blocks) lines.push(`- \`${block.id}\` — ${block.source || '(unknown source)'}`);
    lines.push('');
  }

  lines.push('## Near Duplicate Candidates');
  lines.push('');
  if (report.nearDuplicateCandidates.length === 0) lines.push('_No near duplicate candidates found._');
  for (const pair of report.nearDuplicateCandidates.slice(0, 20)) {
    lines.push(`- score=${pair.score}: \`${pair.blocks[0].id}\` ↔ \`${pair.blocks[1].id}\``);
  }
  lines.push('');
  lines.push('> This report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

function buildPromptContextInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const collector = createCollector(projectRoot);

  scanStaticSourceFiles({ collector, projectRoot });
  scanContextLoaderMandatoryDocs({ collector, projectRoot, filePath: path.join(projectRoot, 'workflow/core/context-loader-config.js') });
  scanSkills({ collector, projectRoot });
  scanContextDigests({ collector, projectRoot });

  const stageContextPath = path.join(projectRoot, 'output', 'stage-context.json');
  if (fs.existsSync(stageContextPath)) {
    collector.addBlock({
      id: 'stage-context.current',
      type: 'stage-context',
      owner: 'StageContextStore',
      source: rel(projectRoot, stageContextPath),
      sourcePath: stageContextPath,
      priority: 80,
      dedupePolicy: 'exact',
      content: safeRead(stageContextPath),
    });
  }

  const blocks = collector.blocks.sort((a, b) => a.id.localeCompare(b.id));
  const byType = {};
  const byOwner = {};
  for (const block of blocks) {
    byType[block.type] = (byType[block.type] || 0) + 1;
    byOwner[block.owner] = (byOwner[block.owner] || 0) + 1;
  }

  const duplicateReport = buildDuplicateReport(blocks);
  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    projectRoot,
    summary: {
      totalBlocks: blocks.length,
      totalEstimatedTokens: blocks.reduce((sum, b) => sum + b.tokenEstimate, 0),
      totalChars: blocks.reduce((sum, b) => sum + b.charCount, 0),
      byType,
      byOwner,
      duplicateSummary: duplicateReport.summary,
    },
    blocks,
  };

  return { inventory, duplicateReport, duplicateMarkdown: formatDuplicateReport(duplicateReport) };
}

function writePromptContextInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const result = buildPromptContextInventory({ projectRoot });
  const inventoryPath = path.join(outputDir, 'prompt-context-inventory.json');
  const duplicatesPath = path.join(outputDir, 'prompt-context-duplicates.json');
  const duplicatesMarkdownPath = path.join(outputDir, 'prompt-context-duplicates.md');
  fs.writeFileSync(inventoryPath, JSON.stringify(result.inventory, null, 2), 'utf-8');
  fs.writeFileSync(duplicatesPath, JSON.stringify(result.duplicateReport, null, 2), 'utf-8');
  fs.writeFileSync(duplicatesMarkdownPath, result.duplicateMarkdown, 'utf-8');
  return {
    ...result,
    paths: {
      inventory: inventoryPath,
      duplicates: duplicatesPath,
      duplicatesMarkdown: duplicatesMarkdownPath,
    },
  };
}

function writePromptContextDuplicateGovernance(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const inventoryResult = writePromptContextInventory({ projectRoot });
  const governance = buildPromptContextDuplicateGovernance({
    inventory: inventoryResult.inventory,
    duplicateReport: inventoryResult.duplicateReport,
  });
  const governancePath = path.join(outputDir, 'prompt-context-duplicate-governance.json');
  const allowlistPath = path.join(outputDir, 'prompt-context-duplicate-allowlist.json');
  const mergeSuggestionsPath = path.join(outputDir, 'prompt-context-merge-suggestions.json');
  const mergeSuggestionsMarkdownPath = path.join(outputDir, 'prompt-context-merge-suggestions.md');
  fs.writeFileSync(governancePath, JSON.stringify(governance, null, 2), 'utf-8');
  fs.writeFileSync(allowlistPath, JSON.stringify(governance.allowlist, null, 2), 'utf-8');
  fs.writeFileSync(mergeSuggestionsPath, JSON.stringify(governance.mergeSuggestions, null, 2), 'utf-8');
  fs.writeFileSync(mergeSuggestionsMarkdownPath, formatMergeSuggestions(governance), 'utf-8');
  return {
    ...inventoryResult,
    governance,
    paths: {
      ...inventoryResult.paths,
      governance: governancePath,
      allowlist: allowlistPath,
      mergeSuggestions: mergeSuggestionsPath,
      mergeSuggestionsMarkdown: mergeSuggestionsMarkdownPath,
    },
  };
}

function writePromptContextRegistry(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const governanceResult = writePromptContextDuplicateGovernance({ projectRoot });
  const registryResult = buildPromptContextRegistry({
    inventory: governanceResult.inventory,
    governance: governanceResult.governance,
  });
  const registryPath = path.join(outputDir, 'prompt-context-registry.json');
  const shadowAssemblyPath = path.join(outputDir, 'prompt-context-shadow-assembly.json');
  const shadowAssemblyMarkdownPath = path.join(outputDir, 'prompt-context-shadow-assembly.md');
  fs.writeFileSync(registryPath, JSON.stringify(registryResult.registry, null, 2), 'utf-8');
  fs.writeFileSync(shadowAssemblyPath, JSON.stringify(registryResult.shadowAssembly, null, 2), 'utf-8');
  fs.writeFileSync(shadowAssemblyMarkdownPath, formatShadowAssemblyReport(registryResult.shadowAssembly), 'utf-8');
  return {
    ...governanceResult,
    ...registryResult,
    paths: {
      ...governanceResult.paths,
      registry: registryPath,
      shadowAssembly: shadowAssemblyPath,
      shadowAssemblyMarkdown: shadowAssemblyMarkdownPath,
    },
  };
}

function writePromptContextAssemblerShadowDiff(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const registryResult = writePromptContextRegistry({ projectRoot });
  const assemblerDiff = buildPromptContextAssemblerShadowDiff({
    registry: registryResult.registry,
    shadowAssembly: registryResult.shadowAssembly,
  });
  const candidatesPath = path.join(outputDir, 'prompt-context-shadow-candidates.json');
  const diffPath = path.join(outputDir, 'prompt-context-shadow-diff.json');
  const diffMarkdownPath = path.join(outputDir, 'prompt-context-shadow-diff.md');
  fs.writeFileSync(candidatesPath, JSON.stringify(assemblerDiff.candidatePrompts, null, 2), 'utf-8');
  fs.writeFileSync(diffPath, JSON.stringify({ ...assemblerDiff, candidatePrompts: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(diffMarkdownPath, formatAssemblerShadowDiffReport(assemblerDiff), 'utf-8');
  return {
    ...registryResult,
    assemblerDiff,
    paths: {
      ...registryResult.paths,
      shadowCandidates: candidatesPath,
      shadowDiff: diffPath,
      shadowDiffMarkdown: diffMarkdownPath,
    },
  };
}

async function writePromptContextDynamicContextShadowDiff(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const registryResult = writePromptContextRegistry({ projectRoot });
  const injectedContexts = options.injectedContexts || await resolveContextLoaderSnapshots(projectRoot, options.requirement || 'PromptContextAssembler dynamic context shadow diff');
  const dynamicContextDiff = buildPromptContextDynamicContextShadowDiff({
    registry: registryResult.registry,
    injectedContexts,
    projectRoot,
  });
  const injectedPath = path.join(outputDir, 'prompt-context-dynamic-context-injections.json');
  const diffPath = path.join(outputDir, 'prompt-context-dynamic-context-diff.json');
  const diffMarkdownPath = path.join(outputDir, 'prompt-context-dynamic-context-diff.md');
  fs.writeFileSync(injectedPath, JSON.stringify(injectedContexts, null, 2), 'utf-8');
  fs.writeFileSync(diffPath, JSON.stringify(dynamicContextDiff, null, 2), 'utf-8');
  fs.writeFileSync(diffMarkdownPath, formatDynamicContextShadowDiffReport(dynamicContextDiff), 'utf-8');
  return {
    ...registryResult,
    dynamicContextDiff,
    injectedContexts,
    paths: {
      ...registryResult.paths,
      dynamicContextInjections: injectedPath,
      dynamicContextDiff: diffPath,
      dynamicContextDiffMarkdown: diffMarkdownPath,
    },
  };
}

async function writePromptContextSelectionBudget(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const dynamicResult = await writePromptContextDynamicContextShadowDiff({
    projectRoot,
    requirement: options.requirement || 'PromptContextRegistry selection budget',
    injectedContexts: options.injectedContexts,
  });
  const selectionBudget = buildPromptContextSelectionBudget({
    registry: dynamicResult.registry,
    dynamicContextDiff: dynamicResult.dynamicContextDiff,
    budget: options.budget,
  });
  const budgetPath = path.join(outputDir, 'prompt-context-selection-budget.json');
  const budgetMarkdownPath = path.join(outputDir, 'prompt-context-selection-budget.md');
  fs.writeFileSync(budgetPath, JSON.stringify(selectionBudget, null, 2), 'utf-8');
  fs.writeFileSync(budgetMarkdownPath, formatSelectionBudgetReport(selectionBudget), 'utf-8');
  return {
    ...dynamicResult,
    selectionBudget,
    paths: {
      ...dynamicResult.paths,
      selectionBudget: budgetPath,
      selectionBudgetMarkdown: budgetMarkdownPath,
    },
  };
}

async function writePromptContextFullPromptShadowParity(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const budgetResult = await writePromptContextSelectionBudget({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler full prompt shadow parity',
    injectedContexts: options.injectedContexts,
  });
  const contexts = options.contexts || await resolveFullPromptContextSnapshots(projectRoot, options.requirement || 'PromptContextAssembler full prompt shadow parity');
  const fullPromptParity = await buildPromptContextFullPromptShadowParity({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler full prompt shadow parity',
    contexts,
  });
  const candidatesPath = path.join(outputDir, 'prompt-context-full-shadow-candidates.json');
  const parityPath = path.join(outputDir, 'prompt-context-full-shadow-parity.json');
  const parityMarkdownPath = path.join(outputDir, 'prompt-context-full-shadow-parity.md');
  fs.writeFileSync(candidatesPath, JSON.stringify(fullPromptParity.candidatePrompts, null, 2), 'utf-8');
  fs.writeFileSync(parityPath, JSON.stringify({ ...fullPromptParity, candidatePrompts: undefined, runtimePrompts: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(parityMarkdownPath, formatFullPromptParityReport(fullPromptParity), 'utf-8');
  return {
    ...budgetResult,
    fullPromptParity,
    paths: {
      ...budgetResult.paths,
      fullShadowCandidates: candidatesPath,
      fullShadowParity: parityPath,
      fullShadowParityMarkdown: parityMarkdownPath,
    },
  };
}

async function writePromptContextDualWriteCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const parityResult = await writePromptContextFullPromptShadowParity({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler dual-write canary',
    contexts: options.contexts,
    injectedContexts: options.injectedContexts,
  });
  const dualWriteCanary = await buildPromptContextDualWriteCanary({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler dual-write canary',
    contexts: options.contexts,
    thresholds: options.thresholds,
  });
  const payloadsPath = path.join(outputDir, 'prompt-context-dual-write-payloads.json');
  const canaryPath = path.join(outputDir, 'prompt-context-dual-write-canary.json');
  const canaryMarkdownPath = path.join(outputDir, 'prompt-context-dual-write-canary.md');
  const rollbackGatePath = path.join(outputDir, 'prompt-context-dual-write-rollback-gate.json');
  fs.writeFileSync(payloadsPath, JSON.stringify(dualWriteCanary.payloads, null, 2), 'utf-8');
  fs.writeFileSync(canaryPath, JSON.stringify({ ...dualWriteCanary, payloads: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(canaryMarkdownPath, formatDualWriteCanaryReport(dualWriteCanary), 'utf-8');
  fs.writeFileSync(rollbackGatePath, JSON.stringify(dualWriteCanary.rollbackGate, null, 2), 'utf-8');
  return {
    ...parityResult,
    dualWriteCanary,
    paths: {
      ...parityResult.paths,
      dualWritePayloads: payloadsPath,
      dualWriteCanary: canaryPath,
      dualWriteCanaryMarkdown: canaryMarkdownPath,
      dualWriteRollbackGate: rollbackGatePath,
    },
  };
}

async function writePromptContextMigrationGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const canaryResult = await writePromptContextDualWriteCanary({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler migration gate',
    contexts: options.contexts,
    injectedContexts: options.injectedContexts,
    thresholds: options.thresholds,
  });
  const migrationGate = buildPromptContextMigrationGate(canaryResult.dualWriteCanary, { policy: options.policy });
  const migrationGatePath = path.join(outputDir, 'prompt-context-migration-gate.json');
  const migrationGateMarkdownPath = path.join(outputDir, 'prompt-context-migration-gate.md');
  const rolloutPolicyPath = path.join(outputDir, 'prompt-context-migration-rollout-policy.json');
  fs.writeFileSync(migrationGatePath, JSON.stringify(migrationGate, null, 2), 'utf-8');
  fs.writeFileSync(migrationGateMarkdownPath, formatMigrationGateReport(migrationGate), 'utf-8');
  fs.writeFileSync(rolloutPolicyPath, JSON.stringify({
    mode: migrationGate.mode,
    rolloutSwitch: migrationGate.rolloutSwitch,
    rollbackStrategy: migrationGate.rollbackStrategy,
    changedPromptOutput: migrationGate.changedPromptOutput,
  }, null, 2), 'utf-8');
  return {
    ...canaryResult,
    migrationGate,
    paths: {
      ...canaryResult.paths,
      migrationGate: migrationGatePath,
      migrationGateMarkdown: migrationGateMarkdownPath,
      migrationRolloutPolicy: rolloutPolicyPath,
    },
  };
}

function writePromptContextMigrationCheck(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const migrationCheck = buildPromptContextMigrationCheck({ projectRoot, gate: options.gate, sourcePath: options.sourcePath });
  const checkPath = path.join(outputDir, 'prompt-context-migration-check.json');
  const checkMarkdownPath = path.join(outputDir, 'prompt-context-migration-check.md');
  fs.writeFileSync(checkPath, JSON.stringify(migrationCheck, null, 2), 'utf-8');
  fs.writeFileSync(checkMarkdownPath, formatMigrationCheckReport(migrationCheck), 'utf-8');
  return {
    migrationCheck,
    paths: {
      migrationCheck: checkPath,
      migrationCheckMarkdown: checkMarkdownPath,
    },
  };
}

function readJsonArtifact(projectRoot, relPath) {
  const filePath = path.join(projectRoot, relPath);
  try {
    if (!fs.existsSync(filePath)) return { exists: false, path: filePath, value: null, error: `${relPath} not found` };
    return { exists: true, path: filePath, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')), error: null };
  } catch (err) {
    return { exists: false, path: filePath, value: null, error: err.message };
  }
}

function readShadowTelemetry(projectRoot) {
  const filePath = path.join(projectRoot, 'output', 'unified-llm-injection-shadow.jsonl');
  if (!fs.existsSync(filePath)) return { exists: false, records: [], parseErrors: ['shadow artifact not found'], path: filePath };
  const records = [];
  const parseErrors = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  lines.forEach((line, index) => {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      parseErrors.push(`line ${index + 1}: ${err.message}`);
    }
  });
  return { exists: true, records, parseErrors, path: filePath };
}

function findPromptLeakage(records) {
  const forbiddenKeys = new Set(['prompt', 'prompts', 'messages', 'message', 'content', 'system', 'user', 'assistant', 'rawPrompt', 'runtimePrompt', 'candidatePrompt']);
  const findings = [];
  function visit(value, pathParts, recordIndex) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        findings.push({ recordIndex, path: [...pathParts, key].join('.'), key });
      }
      if (child && typeof child === 'object') visit(child, [...pathParts, key], recordIndex);
    }
  }
  records.forEach((record, index) => visit(record, ['record'], index));
  return findings;
}

function buildPriorityCoverage(callSites, priorities = ['P0', 'P1', 'P2']) {
  const result = {};
  for (const priority of priorities) {
    const sites = callSites.filter(site => site.priority === priority);
    const covered = sites.filter(site => site.coveredByUnifiedInjection).length;
    result[priority] = {
      total: sites.length,
      covered,
      legacy: sites.length - covered,
      passed: sites.length > 0 && covered === sites.length,
    };
  }
  return result;
}

module.exports = {
  buildUnifiedLLMInjectionCallSiteInventory,
  formatUnifiedLLMInjectionCallSiteReport,
  formatDualWriteCanaryReport,
  formatFullPromptParityReport,
  formatSelectionBudgetReport,
  formatDuplicateReport,
  buildPromptContextInventory,
  writePromptContextInventory,
  writePromptContextDuplicateGovernance,
  writePromptContextRegistry,
  writePromptContextAssemblerShadowDiff,
  writePromptContextDynamicContextShadowDiff,
  writePromptContextSelectionBudget,
  writePromptContextFullPromptShadowParity,
  writePromptContextDualWriteCanary,
  writePromptContextMigrationGate,
  writePromptContextMigrationCheck,
  readJsonArtifact,
  readShadowTelemetry,
  findPromptLeakage,
  buildPriorityCoverage,
};

