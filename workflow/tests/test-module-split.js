'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  runModuleAwareArchitect,
  buildModuleFocusedPrompt,
  extractInterfaceContracts,
  mergeModuleArchitectures,
  MIN_ISOLATABLE_FOR_SPLIT,
  MAX_MODULES_SPLIT,
  _topologicalSort,
} = require('../core/module-architect-runner');

const { StageContextStore } = require('../core/stage-context-store');
const { storeAnalyseContext } = require('../core/orchestrator-stage-helpers');
const { AgentRole } = require('../core/types');

const tmpDir = path.join(os.tmpdir(), 'wfa-test-p2-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ PASS: ${msg}`); }
  else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

(async () => {
try {

// ─── Test 1: _topologicalSort ───────────────────────────────────────────────
console.log('\n=== Test 1: Topological Sort ===');

const modules = [
  { id: 'mod-ui', name: 'UI', description: 'Frontend', boundaries: [], dependencies: ['mod-api'], complexity: 'medium', isolatable: true },
  { id: 'mod-api', name: 'API', description: 'Backend', boundaries: [], dependencies: ['mod-db'], complexity: 'high', isolatable: true },
  { id: 'mod-db', name: 'Database', description: 'Persistence', boundaries: [], dependencies: [], complexity: 'low', isolatable: true },
];

const sorted = _topologicalSort(modules);
assert(sorted[0].id === 'mod-db', 'Database (no deps) comes first');
assert(sorted[1].id === 'mod-api', 'API (depends on db) comes second');
assert(sorted[2].id === 'mod-ui', 'UI (depends on api) comes last');

// Test cycle handling
const cyclicModules = [
  { id: 'a', name: 'A', description: 'A', boundaries: [], dependencies: ['b'], complexity: 'low', isolatable: true },
  { id: 'b', name: 'B', description: 'B', boundaries: [], dependencies: ['a'], complexity: 'low', isolatable: true },
];
const cycleSorted = _topologicalSort(cyclicModules);
assert(cycleSorted.length === 2, 'Cyclic modules still all present');

// ─── Test 2: buildModuleFocusedPrompt ───────────────────────────────────────
console.log('\n=== Test 2: buildModuleFocusedPrompt ===');

const reqContent = 'Build a user management system with authentication, database, and UI.';
const focusModule = {
  id: 'mod-auth',
  name: 'Authentication',
  description: 'User login, registration, token management',
  boundaries: ['src/auth/*'],
  dependencies: ['mod-db'],
  complexity: 'high',
  isolatable: true,
};
const allModules = [
  focusModule,
  { id: 'mod-db', name: 'Database', description: 'Persistence', boundaries: ['src/db/*'], dependencies: [], complexity: 'medium', isolatable: true },
  { id: 'mod-ui', name: 'UI', description: 'Frontend', boundaries: ['src/ui/*'], dependencies: ['mod-auth'], complexity: 'medium', isolatable: true },
];
const upstreamContracts = ['### Module: Database (mod-db)\n\nDatabase provides getUser(id) and saveUser(user) interfaces.'];

const prompt = buildModuleFocusedPrompt(reqContent, focusModule, allModules, ['logging'], upstreamContracts, null);
assert(prompt.includes('Authentication'), 'Prompt mentions focus module name');
assert(prompt.includes('mod-auth'), 'Prompt mentions focus module ID');
assert(prompt.includes('mod-db'), 'Prompt mentions dependency module');
assert(prompt.includes('mod-ui'), 'Prompt mentions dependent module');
assert(prompt.includes('Boundary Rules'), 'Prompt includes boundary rules');
assert(prompt.includes('Interface Contracts'), 'Prompt requires interface contracts');
assert(prompt.includes('Upstream Module Interface Contracts'), 'Prompt includes upstream contracts');
assert(prompt.includes('getUser'), 'Prompt includes upstream contract content');
assert(prompt.includes('logging'), 'Prompt includes cross-cutting concerns');
assert(!prompt.includes('projectName'), 'Prompt does not contain project-specific hardcoding');

// ─── Test 3: extractInterfaceContracts ──────────────────────────────────────
console.log('\n=== Test 3: extractInterfaceContracts ===');

const mockOutput = `
# Module Architecture

## Internal Components
Some components here.

## Interface Contracts

### Provided Interfaces
- \`getUser(id: string): Promise<User>\` — Returns user by ID
- \`saveUser(user: User): Promise<void>\` — Persists a user

### Required Interfaces
- Needs \`ILogger\` from logging module

## Risks
Some risks.
`;

const contracts = extractInterfaceContracts(mockOutput, 'mod-auth', 'Authentication');
assert(contracts.includes('mod-auth'), 'Contract includes module ID');
assert(contracts.includes('Authentication'), 'Contract includes module name');
assert(contracts.includes('getUser'), 'Contract includes interface signature');

// Test fallback when no Interface Contracts section
const noContractOutput = 'Just some text without interface section but with `login(email, password)` signature.';
const fallback = extractInterfaceContracts(noContractOutput, 'mod-x', 'X');
assert(fallback.includes('mod-x'), 'Fallback includes module ID');

// ─── Test 4: mergeModuleArchitectures ───────────────────────────────────────
console.log('\n=== Test 4: mergeModuleArchitectures ===');

const moduleResults = [
  {
    moduleId: 'mod-db',
    moduleName: 'Database',
    complexity: 'low',
    output: '# Database module architecture\n\nPersistence layer with PostgreSQL.',
    contracts: '### Module: Database (mod-db)\n\n`getUser(id)` and `saveUser(user)`',
  },
  {
    moduleId: 'mod-auth',
    moduleName: 'Authentication',
    complexity: 'high',
    output: '# Auth module architecture\n\nJWT-based authentication.',
    contracts: '### Module: Authentication (mod-auth)\n\n`login(email, password)` and `register(user)`',
  },
];

const merged = mergeModuleArchitectures(moduleResults, ['logging', 'error-handling'], reqContent);
assert(merged.includes('Architecture Design Document'), 'Merged doc has title');
assert(merged.includes('Module-Aware Architecture Design'), 'Merged doc mentions module-aware');
assert(merged.includes('mod-db'), 'Merged doc includes mod-db');
assert(merged.includes('mod-auth'), 'Merged doc includes mod-auth');
assert(merged.includes('Interface Contracts (Cross-Module)'), 'Merged doc has interface contracts section');
assert(merged.includes('Cross-Cutting Concerns'), 'Merged doc has cross-cutting section');
assert(merged.includes('logging'), 'Merged doc includes logging concern');
assert(merged.includes('Architecture Design'), 'Merged doc has mandatory Architecture Design section');
assert(merged.includes('Execution Plan'), 'Merged doc has mandatory Execution Plan section');

// Execution plan should list high-complexity first
const authIndex = merged.indexOf('Authentication');
const dbIndex = merged.lastIndexOf('Database');
// In execution plan, auth (high) should appear before db (low)
const execPlanSection = merged.slice(merged.lastIndexOf('## Execution Plan'));
const authInPlan = execPlanSection.indexOf('Authentication');
const dbInPlan = execPlanSection.indexOf('Database');
assert(authInPlan < dbInPlan, 'Execution plan: high-complexity module scheduled first');

// ─── Test 5: runModuleAwareArchitect — not enough modules → fallback ────────
console.log('\n=== Test 5: runModuleAwareArchitect (fallback) ===');

// Create a mock orchestrator with only 1 module in the map
const store1 = new StageContextStore({ outputDir: tmpDir });
store1.set('ANALYSE', {
  summary: 'test',
  keyDecisions: [],
  artifacts: [],
  risks: [],
  meta: {
    moduleMap: {
      modules: [{ id: 'mod-only', name: 'Only', description: 'Single module', boundaries: [], dependencies: [], complexity: 'low', isolatable: true }],
      crossCuttingConcerns: [],
    },
  },
});

const mockOrch1 = { stageCtx: store1 };
const result1 = await runModuleAwareArchitect(mockOrch1, 'some requirement', null);
assert(result1.used === false, 'Returns used=false when < MIN_ISOLATABLE modules');

// ─── Test 6: runModuleAwareArchitect — no isolatable → fallback ─────────────
console.log('\n=== Test 6: runModuleAwareArchitect (no isolatable) ===');

const store2 = new StageContextStore({ outputDir: tmpDir });
store2.set('ANALYSE', {
  summary: 'test',
  keyDecisions: [],
  artifacts: [],
  risks: [],
  meta: {
    moduleMap: {
      modules: [
        { id: 'a', name: 'A', description: 'A', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
        { id: 'b', name: 'B', description: 'B', boundaries: [], dependencies: [], complexity: 'low', isolatable: false },
      ],
      crossCuttingConcerns: [],
    },
  },
});

const mockOrch2 = { stageCtx: store2 };
const result2 = await runModuleAwareArchitect(mockOrch2, 'some requirement', null);
assert(result2.used === false, 'Returns used=false when no isolatable modules');

// ─── Test 7: runModuleAwareArchitect — module split with mock LLM ───────────
console.log('\n=== Test 7: runModuleAwareArchitect (full split with mock LLM) ===');

const store3 = new StageContextStore({ outputDir: tmpDir });
store3.set('ANALYSE', {
  summary: 'test',
  keyDecisions: [],
  artifacts: [],
  risks: [],
  meta: {
    moduleMap: {
      modules: [
        { id: 'mod-db', name: 'Database', description: 'Persistence', boundaries: ['src/db/*'], dependencies: [], complexity: 'low', isolatable: true },
        { id: 'mod-auth', name: 'Auth', description: 'Authentication', boundaries: ['src/auth/*'], dependencies: ['mod-db'], complexity: 'high', isolatable: true },
        { id: 'mod-ui', name: 'UI', description: 'Frontend', boundaries: ['src/ui/*'], dependencies: ['mod-auth'], complexity: 'medium', isolatable: true },
      ],
      crossCuttingConcerns: ['logging', 'error-handling'],
    },
  },
});

// Mock ArchitectAgent with a simple llmCall that returns module-aware output
let llmCallCount = 0;
const mockLlmCall = async (prompt) => {
  llmCallCount++;
  const modMatch = prompt.match(/Module "([^"]+)" \(([^)]+)\)/);
  const modName = modMatch ? modMatch[1] : `Module-${llmCallCount}`;
  const modId = modMatch ? modMatch[2] : `mod-${llmCallCount}`;
  return `# ${modName} Architecture

## Module Overview
This is the ${modName} module.

## Internal Component Breakdown
- Component A
- Component B

## Interface Contracts
### Provided Interfaces
- \`get${modName}Data(): Promise<Data>\` — Main data getter

### Required Interfaces
- Needs upstream contracts

## Architecture Decisions
Chose layered pattern for ${modName}.

## Execution Plan
1. Build core
2. Add interfaces
`;
};

const mockArchAgent = {
  llmCall: mockLlmCall,
  parseResponse: (r) => r,
};

const archOutputPath = path.join(tmpDir, 'architecture.md');
const mockOrch3 = {
  stageCtx: store3,
  agents: { [AgentRole.ARCHITECT]: mockArchAgent },
};

const result3 = await runModuleAwareArchitect(mockOrch3, 'Build user management system', null, {
  outputPath: archOutputPath,
});

assert(result3.used === true, 'Module-split was used');
assert(result3.moduleCount === 3, 'Designed 3 modules');
assert(result3.meta.moduleSplit === true, 'Meta indicates module-split');
assert(result3.meta.successCount === 3, 'All 3 modules succeeded');
assert(result3.meta.failedCount === 0, 'No failures');
assert(llmCallCount === 3, 'Exactly 3 LLM calls made (one per module)');
assert(fs.existsSync(archOutputPath), 'architecture.md was written');

const archContent = fs.readFileSync(archOutputPath, 'utf-8');
assert(archContent.includes('Module-Aware Architecture Design'), 'Output mentions module-aware');
assert(archContent.includes('Database'), 'Output includes Database module');
assert(archContent.includes('Auth'), 'Output includes Auth module');
assert(archContent.includes('UI'), 'Output includes UI module');
assert(archContent.includes('Interface Contracts (Cross-Module)'), 'Output has interface contracts');
assert(archContent.includes('Architecture Design'), 'Output has mandatory Architecture Design section');
assert(archContent.includes('Execution Plan'), 'Output has mandatory Execution Plan section');

// Verify topological order: db should be designed first (no deps)
assert(result3.meta.moduleOrder[0] === 'mod-db', 'Module order: mod-db first (no deps)');
assert(result3.meta.moduleOrder[2] === 'mod-ui', 'Module order: mod-ui last (depends on mod-auth)');

// ─── Test 8: Constants ──────────────────────────────────────────────────────
console.log('\n=== Test 8: Constants ===');
assert(MIN_ISOLATABLE_FOR_SPLIT === 2, 'MIN_ISOLATABLE_FOR_SPLIT is 2');
assert(MAX_MODULES_SPLIT === 6, 'MAX_MODULES_SPLIT is 6');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

} catch (e) {
  console.error('\n❌ UNEXPECTED ERROR:', e.message, e.stack);
  failed++;
}

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`  Phase 2 Module-Split Tests: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
})();
