'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildPromptContextInventory,
  writePromptContextInventory,
  buildPromptContextDuplicateGovernance,
  writePromptContextDuplicateGovernance,
  buildPromptContextRegistry,
  writePromptContextRegistry,
  buildPromptContextAssemblerShadowDiff,
  writePromptContextAssemblerShadowDiff,
  buildPromptContextDynamicContextShadowDiff,
  buildPromptContextSelectionBudget,
  buildPromptContextFullPromptShadowParity,
  buildPromptContextDualWriteCanary,
  buildPromptContextMigrationGate,
  buildPromptContextMigrationCheck,
  buildUnifiedLLMInjectionCallSiteInventory,
  buildUnifiedLLMInjectionRuntimeReadinessGate,
  buildUnifiedLLMInjectionCandidateRuntimeCanary,
  buildUnifiedLLMInjectionDefaultRuntimeReplacement,
  buildUnifiedLLMInjectionCIGate,
  buildUnifiedLLMInjectionSLODashboard,
} = require('./prompt-context-inventory');
const {
  runPromptContextInventory,
  runPromptContextGovernance,
  runPromptContextRegistry,
  runPromptContextAssemblerDiff,
  runPromptContextMigrationCheck,
  runUnifiedLLMInjectionCallSiteInventory,
  runUnifiedLLMInjectionRuntimeReadinessGate,
  runUnifiedLLMInjectionCandidateRuntimeCanary,
  runUnifiedLLMInjectionDefaultRuntimeReplacement,
  runUnifiedLLMInjectionCIGate,
  runUnifiedLLMInjectionSLODashboard,
} = require('../tools/ide-workflow-bridge');
const { resolvePromptContextAssemblerMode, MODES } = require('./prompt-context-assembler-mode');

const pendingTests = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pendingTests.push(result
        .then(() => console.log(`✓ ${name}`))
        .catch((err) => {
          console.error(`✗ ${name}`);
          console.error(err.stack || err.message);
          process.exitCode = 1;
        }));
      return;
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfa-prompt-inventory-'));
  write(path.join(root, 'AGENTS.md'), '# AGENTS\n\n## Hard Rules\n\nAlways prefer IDE-native tools.');
  write(path.join(root, 'workflow/docs/architecture-constraints.md'), '# Architecture Constraints\n\n## IDE-First Principle\n\nAlways prefer IDE-native tools for reads, edits, and workflow operations.\n\n## Module Boundaries\n\nKeep prompt registry shadow-only and avoid runtime prompt mutation.');
  write(path.join(root, 'output/project-profile.md'), '# Project Profile\n\nNode.js workflow runtime with ContextLoader dynamic injection.');
  write(path.join(root, 'output/code-graph.md'), '# Code Graph\n\nPromptContextRegistry and ContextLoader are core prompt context modules.');
  write(path.join(root, 'output/execution-plan.md'), '# Execution Plan\n\nImplement registry scan scope tuning without changing runtime prompt output.');
  write(path.join(root, 'workflow/core/agent-prompt-template.js'), [
    "'use strict';",
    'function buildAgentPromptTemplate() {',
    '  return `# Agent Prompt',
    '',
    '## Shared Rule',
    'Always prefer IDE-native tools.',
    '',
    '## Runtime',
    'Use PowerShell on Windows.`;',
    '}',
    'module.exports = { buildAgentPromptTemplate };',
  ].join('\n'));
  write(path.join(root, 'workflow/core/prompt-agent-prefixes.js'), [
    "'use strict';",
    'const AGENT_FIXED_PREFIXES = {',
    '  analyst: `You are analyst. Always prefer IDE-native tools.`,',
    '  developer: `You are developer. Implement minimal changes.`,',
    '};',
    'module.exports = { AGENT_FIXED_PREFIXES };',
  ].join('\n'));
  write(path.join(root, 'workflow/core/context-loader-config.js'), [
    "'use strict';",
    'module.exports = {',
    "  ROLE_MANDATORY_DOCS: { analyst: ['docs/architecture-constraints.md', 'output/project-profile.md'], developer: ['output/code-graph.md', 'output/execution-plan.md'] },",
    "  ROLE_CONSTRAINT_SECTIONS: { analyst: ['Hard Rules'] },",
    "  BUILTIN_SKILL_KEYWORDS: { 'workflow-orchestration': ['workflow'] },",
    "  SKILL_ROLE_FILTER: { 'workflow-orchestration': ['analyst'] },",
    "  RISK_SKILL_PACKS: { security: ['security-audit'] },",
    '};',
  ].join('\n'));
  write(path.join(root, 'workflow/tools/ide-workflow-bridge.js'), [
    'const baseInstructions = [',
    '  `Execute stage`,',
    '  `Write output`,',
    '].filter(Boolean);',
  ].join('\n'));
  write(path.join(root, 'workflow/core/prompt-builder.js'), 'function buildAgentPrompt() { return "prompt"; }');
  write(path.join(root, 'workflow/core/prompt-runtime-supplement-builder.js'), [
    "'use strict';",
    "function buildRuntimeSupplementSections() { return ['### Runtime Environment\\n- **OS**: Windows']; }",
    "module.exports = { buildRuntimeSupplementSections };",
  ].join('\n'));
  write(path.join(root, 'workflow/core/context-loader.js'), 'class ContextLoader {}');
  write(path.join(root, 'workflow/core/sample-llm-call-site.js'), [
    "const { prepareGatewayPrompt } = require('./llm-injection-gateway');",
    "async function run(llmCall) {",
    "  const prompt = 'sample prompt';",
    "  return llmCall(prepareGatewayPrompt({ _outputDir: 'output' }, { callSite: 'fixture:sample', runtimePrompt: prompt, metadata: { category: 'injected-llm-call' } }));",
    "}",
    "module.exports = { run };",
  ].join('\n'));
  write(path.join(root, 'workflow/core/token-budget.js'), 'const BLOCK_PRIORITY = {};');
  write(path.join(root, 'workflow/core/adapter-telemetry.js'), 'class AdapterTelemetry {}');
  write(path.join(root, 'workflow/skills/workflow-orchestration.md'), '# Workflow\n\n## Shared Rule\n\nAlways prefer IDE-native tools.');
  write(path.join(root, 'workflow/skills/template-a.md'), '# Template A\n\n## Rules\n<!-- PURPOSE: Prescriptive constraints that MUST be followed. -->');
  write(path.join(root, 'workflow/skills/template-b.md'), '# Template B\n\n## Rules\n<!-- PURPOSE: Prescriptive constraints that MUST be followed. -->');
  write(path.join(root, 'workflow/skills/domain-a.md'), '# Domain A\n\n## Shared Domain Guidance\n\nValidate inputs before executing workflow actions.');
  write(path.join(root, 'workflow/skills/domain-b.md'), '# Domain B\n\n## Shared Domain Guidance\n\nValidate inputs before executing workflow actions.');
  write(path.join(root, 'workflow/skills/android-dev.md'), '# Android\n\n## Standard Project Structure\n\n```\nproject-root/\n├── app/\n└── build.gradle.kts\n```');
  write(path.join(root, 'workflow/skills/flutter-dev.md'), '# Flutter\n\n## Standard Project Structure\n\n```\nproject-root/\n├── lib/\n└── pubspec.yaml\n```');
  write(path.join(root, 'workflow/skills/ios-dev.md'), '# iOS\n\n## Standard Project Structure\n\n```\nproject-root/\n├── ProjectName/\n└── ProjectName.xcodeproj\n```');
  write(path.join(root, '.workflow/skills/project-standards.md'), '# Project Standards\n\n## Coding\n\nImplement minimal changes.');
  write(path.join(root, '.workflow/skills/project-standards-knowledge.md'), '# Project Standards Knowledge\n\n## Coding\n\nImplement minimal changes.');
  write(path.join(root, 'output/context-digests/analysis.json'), JSON.stringify({ stage: 'ANALYSE', content: { summary: 'done' } }, null, 2));
  return root;
}

test('resolvePromptContextAssemblerMode defaults to candidate-runtime and supports rollback/canary modes', () => {
  const defaultMode = resolvePromptContextAssemblerMode({});
  assert.strictEqual(defaultMode.mode, MODES.CANDIDATE_RUNTIME);
  assert.strictEqual(defaultMode.shouldSendCandidate, true);
  assert.strictEqual(defaultMode.rollbackMode, 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime');
  const runtimeMode = resolvePromptContextAssemblerMode({ PROMPT_CONTEXT_ASSEMBLER_MODE: 'runtime' });
  assert.strictEqual(runtimeMode.mode, MODES.RUNTIME);
  assert.strictEqual(runtimeMode.shouldSendCandidate, false);
  const canaryMode = resolvePromptContextAssemblerMode({ PROMPT_CONTEXT_ASSEMBLER_MODE: 'dual-write-canary' });
  assert.strictEqual(canaryMode.shouldRecordCanary, true);
  assert.strictEqual(canaryMode.changedPromptOutput, false);
  const candidateMode = resolvePromptContextAssemblerMode({ PROMPT_CONTEXT_ASSEMBLER_MODE: 'candidate-runtime' });
  assert.strictEqual(candidateMode.shouldSendCandidate, true);
  assert.strictEqual(candidateMode.changedPromptOutput, true);
});

test('buildPromptContextInventory scans prompt/context sources as blocks', () => {
  const root = makeProject();
  const { inventory, duplicateReport } = buildPromptContextInventory({ projectRoot: root });
  assert.strictEqual(inventory.changedPromptOutput, false);
  assert(inventory.summary.totalBlocks >= 8);
  assert(inventory.summary.byType.skill >= 2);
  assert(inventory.summary.byType['context-loader-doc'] >= 1);
  assert(inventory.summary.byType['context-loader-artifact'] >= 3);
  assert(inventory.summary.byOwner.ContextLoader >= 1);
  assert(inventory.blocks.some(block => block.source === 'workflow/docs/architecture-constraints.md'));
  assert(inventory.blocks.some(block => block.source === 'output/code-graph.md'));
  assert(duplicateReport.summary.totalBlocks === inventory.summary.totalBlocks);
});

test('writePromptContextInventory writes inventory and duplicate reports', () => {
  const root = makeProject();
  const result = writePromptContextInventory({ projectRoot: root });
  assert(fs.existsSync(result.paths.inventory));
  assert(fs.existsSync(result.paths.duplicates));
  assert(fs.existsSync(result.paths.duplicatesMarkdown));
  const inventory = JSON.parse(fs.readFileSync(result.paths.inventory, 'utf-8'));
  assert.strictEqual(inventory.mode, 'shadow-only');
  assert.strictEqual(inventory.changedPromptOutput, false);
});

test('runPromptContextInventory returns artifact paths without changing prompt output', () => {
  const root = makeProject();
  const result = runPromptContextInventory({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.changedPromptOutput, false);
  assert.strictEqual(result.data.artifacts.inventory, 'output/prompt-context-inventory.json');
  assert(result.data.duplicateSummary.totalBlocks > 0);
});

test('buildPromptContextDuplicateGovernance classifies duplicate groups', () => {
  const root = makeProject();
  const { inventory, duplicateReport } = buildPromptContextInventory({ projectRoot: root });
  const governance = buildPromptContextDuplicateGovernance({ inventory, duplicateReport });
  assert.strictEqual(governance.changedPromptOutput, false);
  assert(governance.summary.byClassification['template-noise'] >= 1);
  assert(governance.summary.byClassification['reasonable-repeat'] >= 1);
  assert(governance.summary.byClassification['domain-specific-repeat'] >= 1);
  assert(governance.summary.byClassification['true-duplicate'] >= 1);
  assert(governance.allowlist.entries.length >= 3);
  assert(governance.mergeSuggestions.length >= 1);
});

test('writePromptContextDuplicateGovernance writes allowlist and merge suggestions', () => {
  const root = makeProject();
  const result = writePromptContextDuplicateGovernance({ projectRoot: root });
  assert(fs.existsSync(result.paths.governance));
  assert(fs.existsSync(result.paths.allowlist));
  assert(fs.existsSync(result.paths.mergeSuggestions));
  assert(fs.existsSync(result.paths.mergeSuggestionsMarkdown));
  assert.strictEqual(result.governance.mode, 'shadow-only');
});

test('runPromptContextGovernance returns governance artifact paths', () => {
  const root = makeProject();
  const result = runPromptContextGovernance({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.changedPromptOutput, false);
  assert.strictEqual(result.data.artifacts.allowlist, 'output/prompt-context-duplicate-allowlist.json');
  assert(result.data.summary.mergeSuggestionCount >= 1);
});

test('buildPromptContextRegistry creates registry and shadow assembly', () => {
  const root = makeProject();
  const { inventory, duplicateReport } = buildPromptContextInventory({ projectRoot: root });
  const governance = buildPromptContextDuplicateGovernance({ inventory, duplicateReport });
  const { registry, shadowAssembly } = buildPromptContextRegistry({ inventory, governance });
  assert.strictEqual(registry.changedPromptOutput, false);
  assert.strictEqual(shadowAssembly.changedPromptOutput, false);
  assert.strictEqual(registry.entries.length, inventory.blocks.length);
  assert(registry.summary.byGovernanceClassification['domain-specific-repeat'] >= 1);
  assert(shadowAssembly.views.some(view => view.id === 'all.priority-order'));
  assert(shadowAssembly.views.some(view => view.id === 'skills.priority-order'));
});

test('writePromptContextRegistry writes registry and shadow assembly reports', () => {
  const root = makeProject();
  const result = writePromptContextRegistry({ projectRoot: root });
  assert(fs.existsSync(result.paths.registry));
  assert(fs.existsSync(result.paths.shadowAssembly));
  assert(fs.existsSync(result.paths.shadowAssemblyMarkdown));
  assert.strictEqual(result.registry.mode, 'shadow-only');
  assert.strictEqual(result.shadowAssembly.mode, 'shadow-only');
});

test('runPromptContextRegistry returns registry artifact paths', () => {
  const root = makeProject();
  const result = runPromptContextRegistry({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.changedPromptOutput, false);
  assert.strictEqual(result.data.artifacts.registry, 'output/prompt-context-registry.json');
  assert.strictEqual(result.data.artifacts.shadowAssemblyMarkdown, 'output/prompt-context-shadow-assembly.md');
  assert(result.data.registrySummary.totalBlocks > 0);
  assert(result.data.shadowAssemblySummary.totalViews >= 3);
});

test('buildPromptContextAssemblerShadowDiff compares candidates with runtime prompts', () => {
  const root = makeProject();
  const result = writePromptContextRegistry({ projectRoot: root });
  const diff = buildPromptContextAssemblerShadowDiff({
    registry: result.registry,
    shadowAssembly: result.shadowAssembly,
  });
  assert.strictEqual(diff.changedPromptOutput, false);
  assert(diff.summary.rolesCompared >= 2);
  assert(diff.summary.averageRuntimePrefixCoverage >= 0.8);
  assert(diff.summary.totalCandidateBlocks <= diff.summary.rolesCompared * 6);
  assert(diff.candidatePrompts.length >= 2);
  assert(diff.roleDiffs.every(item => item.selectionStrategy === 'role-specific-prefix-first'));
  assert(diff.roleDiffs.every(item => item.comparison && typeof item.comparison.jaccardSimilarity === 'number'));
});

test('buildPromptContextDynamicContextShadowDiff matches injected sections to registry blocks', () => {
  const root = makeProject();
  const result = writePromptContextRegistry({ projectRoot: root });
  const diff = buildPromptContextDynamicContextShadowDiff({
    registry: result.registry,
    projectRoot: root,
    injectedContexts: [{
      stage: 'DEVELOP',
      role: 'developer',
      taskText: 'workflow',
      tokenCount: 12,
      sources: ['architecture-constraints.md (2 sections for analyst)', 'workflow/skills/workflow-orchestration.md'],
      sections: [
        { index: 0, source: 'architecture-constraints.md (2 sections for analyst)', content: '## 📐 architecture-constraints.md (2 sections for analyst)\n\n## IDE-First Principle\n\nAlways prefer IDE-native tools for reads, edits, and workflow operations.' },
        { index: 1, source: 'workflow/skills/workflow-orchestration.md', content: '# Workflow\n\n## Shared Rule\n\nAlways prefer IDE-native tools.' },
      ],
    }],
  });
  assert.strictEqual(diff.changedPromptOutput, false);
  assert.strictEqual(diff.summary.contextsCompared, 1);
  assert.strictEqual(diff.summary.totalInjectedSections, 2);
  assert(diff.summary.sectionCoverage >= 1);
  assert(diff.roleDiffs[0].sectionDiffs[0].match.blockId.startsWith('context-loader-doc.architecture-constraints'));
});

test('buildPromptContextSelectionBudget budgets context-loader doc and artifact matches', () => {
  const root = makeProject();
  const result = writePromptContextRegistry({ projectRoot: root });
  const diff = buildPromptContextDynamicContextShadowDiff({
    registry: result.registry,
    projectRoot: root,
    injectedContexts: [{
      stage: 'DEVELOP',
      role: 'developer',
      taskText: 'workflow',
      tokenCount: 12,
      sources: ['architecture-constraints.md (2 sections for analyst)', 'code-graph.md'],
      sections: [
        { index: 0, source: 'architecture-constraints.md (2 sections for analyst)', content: '## 📐 architecture-constraints.md (2 sections for analyst)\n\n## IDE-First Principle\n\nAlways prefer IDE-native tools for reads, edits, and workflow operations.' },
        { index: 1, source: 'code-graph.md', content: '# Code Graph\n\nPromptContextRegistry and ContextLoader are core prompt context modules.' },
      ],
    }],
  });
  const budget = buildPromptContextSelectionBudget({ registry: result.registry, dynamicContextDiff: diff });
  assert.strictEqual(budget.changedPromptOutput, false);
  assert.strictEqual(budget.summary.rolesCompared, 1);
  assert(budget.summary.selectedBlocks >= 1);
  assert(budget.roleBudgets[0].blocks.every(block => block.type === 'context-loader-doc' || block.type === 'context-loader-artifact'));
});

test('buildPromptContextFullPromptShadowParity compares full candidate prompt with runtime snapshot', async () => {
  const root = makeProject();
  const parity = await buildPromptContextFullPromptShadowParity({
    projectRoot: root,
    requirement: 'workflow parity',
    contexts: [{
      stage: 'ANALYSE',
      role: 'analyst',
      tokenCount: 12,
      sources: ['workflow/skills/workflow-orchestration.md'],
      sections: [{ index: 0, source: 'workflow/skills/workflow-orchestration.md', content: '# Workflow\n\n## Shared Rule\n\nAlways prefer IDE-native tools.' }],
    }],
  });
  assert.strictEqual(parity.changedPromptOutput, false);
  assert.strictEqual(parity.summary.rolesCompared, 1);
  assert.strictEqual(parity.candidatePrompts.length, 1);
  assert(typeof parity.roleDiffs[0].runtimeTokenCoverage === 'number');
  assert(parity.roleDiffs[0].candidatePromptLength > 0);
  assert(parity.roleDiffs[0].runtimePromptLength > 0);
  assert(parity.candidatePrompts[0].candidatePrompt.includes('### Runtime Environment'));
  try {
    const { getIDEDetectionResult } = require('./ide-detection');
    if (getIDEDetectionResult().isInsideIDE) {
      assert(parity.candidatePrompts[0].candidatePrompt.includes('Tool Guidance'));
      assert(parity.candidatePrompts[0].candidatePrompt.includes('json:self-report'));
    }
  } catch (_) { /* IDE-only assertions are best-effort in standalone runs. */ }
});

test('buildPromptContextDualWriteCanary records runtime and candidate payloads with rollback gate', async () => {
  const root = makeProject();
  const canary = await buildPromptContextDualWriteCanary({
    projectRoot: root,
    requirement: 'workflow canary',
    contexts: [{
      stage: 'ANALYSE',
      role: 'analyst',
      tokenCount: 12,
      sources: ['workflow/skills/workflow-orchestration.md'],
      sections: [{ index: 0, source: 'workflow/skills/workflow-orchestration.md', content: '# Workflow\n\n## Shared Rule\n\nAlways prefer IDE-native tools.' }],
    }],
  });
  assert.strictEqual(canary.changedPromptOutput, false);
  assert.strictEqual(canary.mode, 'dual-write-shadow');
  assert.strictEqual(canary.payloads.length, 1);
  assert(canary.payloads[0].runtime.prompt.length > 0);
  assert(canary.payloads[0].candidate.prompt.length > 0);
  assert(canary.rollbackGate.summary.totalChecks >= 4);
});

test('buildPromptContextMigrationGate consumes canary rollback gate and defines rollout policy', async () => {
  const root = makeProject();
  const canary = await buildPromptContextDualWriteCanary({
    projectRoot: root,
    requirement: 'workflow migration gate',
    contexts: [{
      stage: 'ANALYSE',
      role: 'analyst',
      tokenCount: 12,
      sources: ['workflow/skills/workflow-orchestration.md'],
      sections: [{ index: 0, source: 'workflow/skills/workflow-orchestration.md', content: '# Workflow\n\n## Shared Rule\n\nAlways prefer IDE-native tools.' }],
    }],
  });
  const gate = buildPromptContextMigrationGate(canary);
  assert.strictEqual(gate.changedPromptOutput, false);
  assert.strictEqual(gate.mode, 'migration-gate-shadow');
  assert(gate.rolloutSwitch.name);
  assert(gate.rollbackStrategy.immediateAction.includes(gate.policy.defaultMode));
  assert.strictEqual(typeof gate.summary.canProceedToManualCanary, 'boolean');
});

test('buildPromptContextMigrationCheck consumes migration gate and blocks failed artifacts', () => {
  const root = makeProject();
  const gate = {
    changedPromptOutput: false,
    summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true, migrationAllowed: false },
    rolloutSwitch: { safeDefault: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime' },
  };
  const check = buildPromptContextMigrationCheck({ projectRoot: root, gate });
  assert.strictEqual(check.changedPromptOutput, false);
  assert.strictEqual(check.mode, 'migration-check-shadow');
  assert.strictEqual(check.summary.passed, true);
  assert.strictEqual(check.summary.ciExitCode, 0);
});

test('buildUnifiedLLMInjectionCallSiteInventory scans prompt and LLM call sites', () => {
  const root = makeProject();
  const inventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot: root });
  assert.strictEqual(inventory.changedPromptOutput, false);
  assert.strictEqual(inventory.mode, 'call-site-inventory-shadow');
  assert(inventory.summary.totalCallSites >= 1);
  assert(inventory.callSites.some(site => site.file.endsWith('sample-llm-call-site.js')));
});

test('buildUnifiedLLMInjectionCallSiteInventory classifies P3 prompt builders with governance', () => {
  const root = makeProject();
  write(path.join(root, 'workflow/agents/analyst-agent.js'), [
    "class AnalystAgent {",
    "  buildPrompt(inputContent) { return `Analyse ${inputContent}`; }",
    "}",
    "module.exports = { AnalystAgent };",
  ].join('\n'));
  write(path.join(root, 'workflow/core/clarification-prompts.js'), [
    "function buildSemanticDetectionPrompt(text) { return `Detect ${text}`; }",
    "module.exports = { buildSemanticDetectionPrompt };",
  ].join('\n'));
  const inventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot: root });
  assert(inventory.p3PromptBuilderGovernance);
  assert(inventory.p3PromptBuilderGovernance.totalPromptBuilders >= 2);
  assert(inventory.p3PromptBuilderGovernance.exceptions.some(item => item.kind === 'caller-covered-runtime-builder'));
  assert(inventory.p3PromptBuilderGovernance.exceptions.some(item => item.kind === 'non-runtime-builder'));
});

test('buildUnifiedLLMInjectionCallSiteInventory recognizes hidden injected LLM caller names', () => {
  const root = makeProject();
  write(path.join(root, 'workflow/core/hidden-caller.js'), [
    "const { prepareGatewayPrompt } = require('./llm-injection-gateway');",
    "async function run() {",
    "  const prompt = buildHiddenPrompt();",
    "  return effectiveLlmCall(prepareGatewayPrompt({ _outputDir: 'output' }, { runtimePrompt: prompt, callSite: 'hidden' }));",
    "}",
    "function buildHiddenPrompt() { return 'hidden prompt'; }",
    "module.exports = { run };",
  ].join('\n'));
  const inventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot: root });
  const hidden = inventory.callSites.find(site => site.file.endsWith('hidden-caller.js') && site.category === 'llm-lite-call');
  assert(hidden);
  assert.strictEqual(hidden.coveredByUnifiedInjection, true);
  const builder = inventory.callSites.find(site => site.file.endsWith('hidden-caller.js') && site.category === 'prompt-builder-function');
  assert(builder);
  assert.strictEqual(builder.governedByUnifiedInjection, true);
});

test('buildUnifiedLLMInjectionCallSiteInventory marks gateway-routed direct chat as covered', () => {
  const root = makeProject();
  write(path.join(root, 'workflow/core/gateway-routed-chat.js'), [
    "const { LLMInjectionGateway } = require('./llm-injection-gateway');",
    "async function run() {",
    "  const gateway = new LLMInjectionGateway({ outputDir: 'output' });",
    "  return this.llm.chat(gateway.prepare({ runtimePrompt: { system: 's', user: 'u' }, callSite: 'fixture' }).promptToSend);",
    "}",
    "module.exports = { run };",
  ].join('\n'));
  const inventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot: root });
  const routed = inventory.callSites.find(site => site.file.endsWith('gateway-routed-chat.js'));
  assert(routed);
  assert.strictEqual(routed.coveredByUnifiedInjection, true);
  assert.strictEqual(routed.status, 'covered-or-routed');
});

test('bridge migration check and unified inventory commands return artifacts', () => {
  const root = makeProject();
  const gate = {
    changedPromptOutput: false,
    summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true, migrationAllowed: false },
    rolloutSwitch: { safeDefault: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime' },
  };
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify(gate, null, 2));
  const checkResult = runPromptContextMigrationCheck({ projectRoot: root });
  assert.strictEqual(checkResult.success, true);
  assert.strictEqual(checkResult.data.artifacts.migrationCheck, 'output/prompt-context-migration-check.json');
  const inventoryResult = runUnifiedLLMInjectionCallSiteInventory({ projectRoot: root });
  assert.strictEqual(inventoryResult.success, true);
  assert.strictEqual(inventoryResult.data.artifacts.inventory, 'output/unified-llm-injection-call-site-inventory.json');
});

test('runtime readiness gate is fail-safe and reports prompt leakage', () => {
  const root = makeProject();
  const gate = {
    changedPromptOutput: false,
    summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true, migrationAllowed: false },
    rolloutSwitch: { safeDefault: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime' },
  };
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify(gate, null, 2));
  write(path.join(root, 'output/prompt-context-migration-check.json'), JSON.stringify({ changedPromptOutput: false, summary: { passed: true, highOrCriticalFailures: 0 } }, null, 2));
  write(path.join(root, 'output/completion-contract-result.json'), JSON.stringify({ passed: true }, null, 2));
  write(path.join(root, 'output/test-execution-proof.json'), JSON.stringify({ success: true }, null, 2));
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, changedPromptOutput: false, runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 }, metadata: {} }) + '\n');
  const readiness = buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot: root });
  assert.strictEqual(readiness.changedPromptOutput, false);
  assert.strictEqual(readiness.summary.promptLeakageFindings, 0);
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, prompt: 'raw prompt leak', runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 } }) + '\n');
  const leaked = buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot: root });
  assert(leaked.summary.promptLeakageFindings > 0);
  assert.strictEqual(leaked.summary.candidateRuntimeAllowed, false);
});

test('bridge readiness gate command returns shadow artifacts', () => {
  const root = makeProject();
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, changedPromptOutput: false, runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 }, metadata: {} }) + '\n');
  const result = runUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.changedPromptOutput, false);
  assert.strictEqual(result.data.artifacts.readinessGate, 'output/unified-llm-injection-runtime-readiness-gate.json');
});

test('candidate runtime canary requires manual approval and writes artifacts', () => {
  const root = makeProject();
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, changedPromptOutput: false, runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 }, metadata: {} }) + '\n');
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify({ changedPromptOutput: false, summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true } }, null, 2));
  write(path.join(root, 'output/prompt-context-migration-check.json'), JSON.stringify({ changedPromptOutput: false, summary: { passed: true, highOrCriticalFailures: 0 } }, null, 2));
  write(path.join(root, 'output/completion-contract-result.json'), JSON.stringify({ passed: true }, null, 2));
  write(path.join(root, 'output/test-execution-proof.json'), JSON.stringify({ success: true }, null, 2));
  const canary = buildUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot: root, approved: false });
  assert.strictEqual(canary.changedPromptOutput, false);
  assert.strictEqual(canary.summary.manualApproved, false);
  assert.strictEqual(canary.summary.canaryActivationReady, false);
  const result = runUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot: root, approved: 'true', percent: '1' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.artifacts.canary, 'output/unified-llm-injection-candidate-runtime-canary.json');
});

test('default runtime replacement reports active policy and writes artifacts', () => {
  const root = makeProject();
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, changedPromptOutput: false, runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 }, metadata: {} }) + '\n');
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify({ changedPromptOutput: false, summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true } }, null, 2));
  write(path.join(root, 'output/prompt-context-migration-check.json'), JSON.stringify({ changedPromptOutput: false, summary: { passed: true, highOrCriticalFailures: 0 } }, null, 2));
  write(path.join(root, 'output/completion-contract-result.json'), JSON.stringify({ passed: true }, null, 2));
  write(path.join(root, 'output/test-execution-proof.json'), JSON.stringify({ success: true }, null, 2));
  const replacement = buildUnifiedLLMInjectionDefaultRuntimeReplacement({
    projectRoot: root,
    readinessGate: { summary: { gatePassed: true, candidateRuntimeAllowed: true, promptLeakageFindings: 0, rollbackSignal: false } },
    canary: { summary: { canaryActivationReady: true, manualApproved: true, sloGatePassed: true }, sloGate: { passed: true, promptLeakageFindings: 0, rollbackSignal: false } },
  });
  assert.strictEqual(replacement.changedPromptOutput, true);
  assert.strictEqual(replacement.summary.defaultReplacementActive, true);
  const result = runUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.artifacts.defaultReplacement, 'output/unified-llm-injection-default-runtime-replacement.json');
});

test('Unified LLM Injection CI gate passes healthy evidence and blocks leakage or legacy', () => {
  const root = makeProject();
  const inventory = {
    changedPromptOutput: false,
    summary: { legacyOrPartialCallSites: 0 },
    callSites: [],
    p3PromptBuilderGovernance: { remainingRuntimeBuilders: 0 },
  };
  const readinessGate = {
    summary: { gatePassed: true, candidateRuntimeAllowed: true, promptLeakageFindings: 0, rollbackSignal: false },
    priorityCoverage: {
      P0: { total: 1, covered: 1, legacy: 0, passed: true },
      P1: { total: 1, covered: 1, legacy: 0, passed: true },
      P2: { total: 1, covered: 1, legacy: 0, passed: true },
    },
  };
  const defaultReplacement = {
    summary: { defaultReplacementActive: true, promptLeakageFindings: 0, rollbackSignal: false },
    rollbackPolicy: { gatewayRollback: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow', assemblerRollback: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime' },
  };
  const pass = buildUnifiedLLMInjectionCIGate({ projectRoot: root, inventory, readinessGate, defaultReplacement });
  assert.strictEqual(pass.summary.passed, true);
  const leaked = buildUnifiedLLMInjectionCIGate({
    projectRoot: root,
    inventory,
    readinessGate: { ...readinessGate, summary: { ...readinessGate.summary, promptLeakageFindings: 1 } },
    defaultReplacement,
  });
  assert.strictEqual(leaked.summary.passed, false);
  assert(leaked.failed.some(check => check.id === 'no-prompt-leakage'));
  const legacy = buildUnifiedLLMInjectionCIGate({
    projectRoot: root,
    inventory: { ...inventory, summary: { legacyOrPartialCallSites: 1 } },
    readinessGate,
    defaultReplacement,
  });
  assert.strictEqual(legacy.summary.passed, false);
  assert(legacy.failed.some(check => check.id === 'no-legacy-or-partial-call-sites'));
});

test('bridge CI gate command returns artifacts and preserves pass/fail data', () => {
  const root = makeProject();
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({ schemaVersion: 1, changedPromptOutput: false, runtime: { hash: 'a', length: 1 }, candidate: { hash: 'b', length: 1 }, metadata: {} }) + '\n');
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify({ changedPromptOutput: false, summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true } }, null, 2));
  write(path.join(root, 'output/prompt-context-migration-check.json'), JSON.stringify({ changedPromptOutput: false, summary: { passed: true, highOrCriticalFailures: 0 } }, null, 2));
  write(path.join(root, 'output/completion-contract-result.json'), JSON.stringify({ passed: true }, null, 2));
  write(path.join(root, 'output/test-execution-proof.json'), JSON.stringify({ success: true }, null, 2));
  const result = runUnifiedLLMInjectionCIGate({ projectRoot: root });
  assert.strictEqual(typeof result.success, 'boolean');
  assert(result.data.summary);
  assert.strictEqual(result.data.artifacts.ciGate, 'output/unified-llm-injection-ci-gate.json');
});

test('Unified LLM Injection SLO dashboard summarizes healthy and unhealthy runtime signals', () => {
  const root = makeProject();
  const healthyRecord = {
    schemaVersion: 1,
    changedPromptOutput: true,
    runtime: { hash: 'a', length: 100, latencyMs: 100 },
    candidate: { hash: 'b', length: 105, latencyMs: 110 },
    status: 'ok',
    metadata: { qualityDriftScore: 0.05 },
  };
  const readinessGate = { summary: { promptLeakageFindings: 0, rollbackSignal: false } };
  const defaultReplacement = { summary: { defaultReplacementActive: true, promptLeakageFindings: 0, rollbackSignal: false } };
  const ciGate = { summary: { passed: true, promptLeakageFindings: 0, rollbackSignal: false } };
  const healthy = buildUnifiedLLMInjectionSLODashboard({
    projectRoot: root,
    shadow: { exists: true, records: [healthyRecord], parseErrors: [], path: path.join(root, 'output/unified-llm-injection-shadow.jsonl') },
    readinessGate,
    defaultReplacement,
    ciGate,
  });
  assert.strictEqual(healthy.summary.health, 'healthy');
  assert.strictEqual(healthy.summary.releaseReady, true);
  assert.strictEqual(healthy.summary.promptLeakageFindings, 0);
  const unhealthy = buildUnifiedLLMInjectionSLODashboard({
    projectRoot: root,
    shadow: {
      exists: true,
      records: [{ ...healthyRecord, status: 'error', runtime: { hash: 'a', length: 100, latencyMs: 100 }, candidate: { hash: 'c', length: 160, latencyMs: 180 }, metadata: { qualityDriftScore: 0.6 }, canary: { rollback: true } }],
      parseErrors: [],
      path: path.join(root, 'output/unified-llm-injection-shadow.jsonl'),
    },
    readinessGate: { summary: { promptLeakageFindings: 1, rollbackSignal: true } },
    defaultReplacement,
    ciGate,
  });
  assert.strictEqual(unhealthy.summary.health, 'unhealthy');
  assert(unhealthy.failed.some(check => check.id === 'prompt-leakage'));
  assert(unhealthy.failed.some(check => check.id === 'rollback-signal'));
  assert(unhealthy.failed.some(check => check.id === 'llm-error-rate'));
  assert(unhealthy.failed.some(check => check.id === 'latency-delta'));
  assert(unhealthy.failed.some(check => check.id === 'quality-drift'));
});

test('bridge SLO dashboard command writes dashboard and release health artifacts', () => {
  const root = makeProject();
  write(path.join(root, 'output/unified-llm-injection-shadow.jsonl'), JSON.stringify({
    schemaVersion: 1,
    changedPromptOutput: true,
    runtime: { hash: 'a', length: 100, latencyMs: 100 },
    candidate: { hash: 'b', length: 105, latencyMs: 110 },
    status: 'ok',
    metadata: { qualityDriftScore: 0.05 },
  }) + '\n');
  write(path.join(root, 'output/prompt-context-migration-gate.json'), JSON.stringify({ changedPromptOutput: false, summary: { gatePassed: true, shouldRollback: false, canProceedToManualCanary: true } }, null, 2));
  write(path.join(root, 'output/prompt-context-migration-check.json'), JSON.stringify({ changedPromptOutput: false, summary: { passed: true, highOrCriticalFailures: 0 } }, null, 2));
  write(path.join(root, 'output/completion-contract-result.json'), JSON.stringify({ passed: true }, null, 2));
  write(path.join(root, 'output/test-execution-proof.json'), JSON.stringify({ success: true }, null, 2));
  const result = runUnifiedLLMInjectionSLODashboard({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert(result.data.summary);
  assert.strictEqual(result.data.artifacts.dashboard, 'output/unified-llm-injection-slo-dashboard.json');
  assert.strictEqual(result.data.artifacts.releaseHealthSummary, 'output/unified-llm-injection-release-health-summary.md');
});

test('writePromptContextAssemblerShadowDiff writes candidates and diff reports', () => {
  const root = makeProject();
  const result = writePromptContextAssemblerShadowDiff({ projectRoot: root });
  assert(fs.existsSync(result.paths.shadowCandidates));
  assert(fs.existsSync(result.paths.shadowDiff));
  assert(fs.existsSync(result.paths.shadowDiffMarkdown));
  assert.strictEqual(result.assemblerDiff.mode, 'shadow-only');
});

test('runPromptContextAssemblerDiff returns shadow diff artifact paths', () => {
  const root = makeProject();
  const result = runPromptContextAssemblerDiff({ projectRoot: root });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.changedPromptOutput, false);
  assert.strictEqual(result.data.artifacts.shadowCandidates, 'output/prompt-context-shadow-candidates.json');
  assert.strictEqual(result.data.artifacts.shadowDiffMarkdown, 'output/prompt-context-shadow-diff.md');
  assert(result.data.summary.rolesCompared >= 2);
});

Promise.all(pendingTests).then(() => {
  if (process.exitCode) process.exit(process.exitCode);
});
