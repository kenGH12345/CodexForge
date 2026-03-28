/**
 * Agent Functionality Contracts – Define expected behaviors for each Agent
 *
 * This module defines functionality contracts for Agent modules:
 *   - What each Agent should produce (expectedBehavior)
 *   - How to validate the output (validationRules)
 *   - Expected metrics (min/max requirements, modules, tasks, etc.)
 *
 * @module AgentFunctionalityContracts
 */

'use strict';

// ─── AnalystAgent Functionality Contract ──────────────────────────────────────

const ANALYST_FUNCTIONALITY = {
  module: 'AnalystAgent',
  version: '1.0',
  expectedBehavior: {
    description: 'Extract structured requirements, risks, clarifications, and module map from raw user input',
    input: 'string (raw user requirement text)',
    output: 'requirement.md with JSON block containing: requirements[], risks[], clarifications[], moduleMap',
    sideEffects: ['Write output/requirement.md', 'Emit ANALYSE_COMPLETE event'],
    preconditions: ['User input is non-empty string', 'Output directory exists'],
    postconditions: [
      'requirement.md exists and is valid markdown',
      'JSON block contains at least 1 requirement',
      'Each requirement has id and text fields',
      'moduleMap.modules contains module definitions if system detected',
    ],
  },
  validationRules: [
    { name: 'requirements-not-empty', check: 'jsonBlock.requirements && jsonBlock.requirements.length > 0', errorMessage: 'No requirements extracted from user input', severity: 'error' },
    { name: 'requirements-have-ids', check: 'jsonBlock.requirements.every(r => r.id && r.text)', errorMessage: 'Requirements missing id or text field', severity: 'error' },
    { name: 'moduleMap-valid-if-present', check: '!jsonBlock.moduleMap || (jsonBlock.moduleMap.modules && Array.isArray(jsonBlock.moduleMap.modules))', errorMessage: 'moduleMap present but modules array missing or invalid', severity: 'warning' },
    { name: 'risks-identified', check: 'jsonBlock.risks && jsonBlock.risks.length > 0', errorMessage: 'No risks identified - consider adding risk analysis', severity: 'warning' },
  ],
  testCases: [],
  metrics: { minRequirements: 1, maxRequirements: 50, typicalRisks: '2-5', coverageThreshold: 0.8 },
};

// ─── ArchitectAgent Functionality Contract ────────────────────────────────────

const ARCHITECT_FUNCTIONALITY = {
  module: 'ArchitectAgent',
  version: '1.0',
  expectedBehavior: {
    description: 'Design system architecture: modules, tech stack, APIs, data models, decisions',
    input: 'output/requirement.md (structured requirements)',
    output: 'architecture.md with JSON block containing: modules[], techStack{}, decisions[], apis[], dataModels[]',
    sideEffects: ['Write output/architecture.md', 'Emit ARCHITECT_COMPLETE event'],
    preconditions: ['requirement.md exists with valid JSON block', 'Requirements array is non-empty'],
    postconditions: [
      'architecture.md exists and is valid markdown',
      'JSON block contains modules and techStack',
      'Each module has name, description, responsibilities',
      'techStack contains at least language field',
      'Each decision has id, choice, and rationale',
    ],
  },
  validationRules: [
    { name: 'modules-not-empty', check: 'jsonBlock.modules && jsonBlock.modules.length > 0', errorMessage: 'No modules defined in architecture', severity: 'error' },
    { name: 'techstack-has-language', check: 'jsonBlock.techStack && jsonBlock.techStack.language', errorMessage: 'Tech stack missing language field', severity: 'error' },
    { name: 'modules-map-to-requirements', check: 'jsonBlock.modules.every(m => m.name && m.description)', errorMessage: 'Modules missing name or description', severity: 'error' },
    { name: 'decisions-have-rationale', check: '!jsonBlock.decisions || jsonBlock.decisions.every(d => d.choice && d.rationale)', errorMessage: 'Decisions missing choice or rationale', severity: 'warning' },
  ],
  testCases: [],
  metrics: { minModules: 1, maxModules: 20, minDecisions: 1, moduleRequirementRatio: '1 module per 2-5 requirements' },
};

// ─── PlannerAgent Functionality Contract ──────────────────────────────────────

const PLANNER_FUNCTIONALITY = {
  module: 'PlannerAgent',
  version: '1.0',
  expectedBehavior: {
    description: 'Create execution plan with tasks, dependencies, phases, and module grouping',
    input: 'output/architecture.md (structured architecture)',
    output: 'execution-plan.md with JSON block containing: tasks[], dependencies[], phases[], moduleGrouping',
    sideEffects: ['Write output/execution-plan.md', 'Emit PLAN_COMPLETE event'],
    preconditions: ['architecture.md exists with valid JSON block', 'Modules array is non-empty'],
    postconditions: [
      'execution-plan.md exists and is valid markdown',
      'JSON block contains tasks and phases',
      'Each task has id, title, description, moduleId',
      'Each phase has name and taskIds',
      'Tasks are grouped by module (moduleGrouping)',
    ],
  },
  validationRules: [
    { name: 'tasks-not-empty', check: 'jsonBlock.tasks && jsonBlock.tasks.length > 0', errorMessage: 'No tasks defined in execution plan', severity: 'error' },
    { name: 'phases-not-empty', check: 'jsonBlock.phases && jsonBlock.phases.length > 0', errorMessage: 'No phases defined in execution plan', severity: 'error' },
    { name: 'tasks-have-modules', check: 'jsonBlock.tasks.every(t => t.moduleId || t.module)', errorMessage: 'Tasks missing module assignment', severity: 'warning' },
    { name: 'dependencies-valid', check: '!jsonBlock.dependencies || jsonBlock.dependencies.every(d => d.from && d.to)', errorMessage: 'Dependencies missing from/to fields', severity: 'warning' },
  ],
  testCases: [],
  metrics: { minTasks: 1, maxTasks: 100, minPhases: 1, tasksPerModule: '3-10' },
};

// ─── DeveloperAgent Functionality Contract ────────────────────────────────────

const DEVELOPER_FUNCTIONALITY = {
  module: 'DeveloperAgent',
  version: '1.0',
  expectedBehavior: {
    description: 'Generate code diff that implements the planned tasks',
    input: 'output/execution-plan.md (structured execution plan)',
    output: 'code.diff with JSON block containing: filesChanged[], summary, implementedReqs[]',
    sideEffects: ['Write output/code.diff', 'Emit CODE_COMPLETE event'],
    preconditions: ['execution-plan.md exists with valid JSON block', 'Tasks array is non-empty'],
    postconditions: [
      'code.diff exists and contains valid diff content',
      'JSON block contains filesChanged and summary',
      'Each file change has path and type (create/modify/delete)',
      'Summary describes what was implemented',
    ],
  },
  validationRules: [
    { name: 'files-changed-not-empty', check: 'jsonBlock.filesChanged && jsonBlock.filesChanged.length > 0', errorMessage: 'No files changed in code diff', severity: 'error' },
    { name: 'summary-present', check: 'jsonBlock.summary && jsonBlock.summary.length > 10', errorMessage: 'Summary missing or too short', severity: 'error' },
    { name: 'implemented-reqs-mapped', check: '!jsonBlock.implementedReqs || jsonBlock.implementedReqs.length > 0', errorMessage: 'No requirements mapped to implementation', severity: 'warning' },
  ],
  testCases: [],
  metrics: { minFilesChanged: 1, maxFilesChanged: 50, diffLinesPerTask: '20-200' },
};

// ─── TesterAgent Functionality Contract ────────────────────────────────────────

const TESTER_FUNCTIONALITY = {
  module: 'TesterAgent',
  version: '1.0',
  expectedBehavior: {
    description: 'Execute tests and generate test report with pass/fail status',
    input: 'output/code.diff (code changes to test)',
    output: 'test-report.md with JSON block containing: passed, failed, coverage, failures[]',
    sideEffects: ['Write output/test-report.md', 'Emit TEST_COMPLETE event'],
    preconditions: ['code.diff exists with valid content', 'Test files are available for the changed code'],
    postconditions: [
      'test-report.md exists and is valid markdown',
      'JSON block contains passed and failed counts',
      'passed + failed > 0 (at least one test ran)',
      'failures array contains details for each failed test',
    ],
  },
  validationRules: [
    { name: 'tests-ran', check: 'typeof jsonBlock.passed === "number" && typeof jsonBlock.failed === "number"', errorMessage: 'Test counts not found in report', severity: 'error' },
    { name: 'at-least-one-test', check: 'jsonBlock.passed + jsonBlock.failed > 0', errorMessage: 'No tests executed', severity: 'error' },
    { name: 'failures-documented', check: 'jsonBlock.failed === 0 || (jsonBlock.failures && jsonBlock.failures.length === jsonBlock.failed)', errorMessage: 'Failure count does not match failures array', severity: 'warning' },
  ],
  testCases: [],
  metrics: { minPassRate: 0.8, minCoverage: 0.6, maxFailuresToPass: 0 },
};

// ─── Agent Contracts Registry ─────────────────────────────────────────────────

const AGENT_FUNCTIONALITY_CONTRACTS = {
  AnalystAgent: ANALYST_FUNCTIONALITY,
  ArchitectAgent: ARCHITECT_FUNCTIONALITY,
  PlannerAgent: PLANNER_FUNCTIONALITY,
  DeveloperAgent: DEVELOPER_FUNCTIONALITY,
  TesterAgent: TESTER_FUNCTIONALITY,
};

module.exports = {
  ANALYST_FUNCTIONALITY,
  ARCHITECT_FUNCTIONALITY,
  PLANNER_FUNCTIONALITY,
  DEVELOPER_FUNCTIONALITY,
  TESTER_FUNCTIONALITY,
  AGENT_FUNCTIONALITY_CONTRACTS,
};
