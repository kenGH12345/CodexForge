/**
 * ContextLoader Configuration Constants
 *
 * Extracted from context-loader.js for maintainability (ADR-41).
 * Contains skill keyword mappings, role mandatory docs, and load levels.
 *
 * @module workflow/core/context-loader-config
 */

'use strict';

// ─── Token Budget Configuration ──────────────────────────────────────────────

/** Max tokens to inject from skills + ADRs combined (per prompt call) */
const MAX_INJECT_TOKENS = 2800;

/** Max tokens for a single skill file injection */
const MAX_SKILL_TOKENS = 800;

/** Max tokens for the ADR digest injection */
const MAX_ADR_TOKENS = 600;

/** Max tokens for the code graph injection (compact summary only) */
const MAX_GRAPH_TOKENS = 600;

/** Max tokens for a dependency skill injection (compact summary) */
const MAX_DEP_SKILL_TOKENS = 200;

/** Max dependency resolution depth to prevent infinite recursion */
const MAX_DEP_DEPTH = 2;

/** Risk-driven skill pack token cap per skill (P1.5) */
const RISK_SKILL_TOKEN_CAP = 420;

/** Max number of risk-pack skills to load per prompt (P1.5) */
const RISK_SKILL_MAX_COUNT = 3;

// ─── Incremental Skill Loading (T-2) ─────────────────────────────────────────

/** Enable incremental loading: only load high-priority sections per skill */
const INCREMENTAL_LOAD_ENABLED = true;

/** Default token budget per skill when incremental loading is active */
const INCREMENTAL_SKILL_BUDGET = 400;

/** Max tokens per skill when incremental loading is active */
const INCREMENTAL_MAX_SKILL_TOKENS = 600;

// ─── Injection Gating Thresholds (P0 Token Optimization) ─────────────────────

/** Min relevance score for skill injection — below this, skill is skipped (saves ~15% tokens) */
const MIN_SKILL_RELEVANCE = 0.3;

/** Min relevance score for ADR injection — below this, ADR entry is skipped */
const MIN_ADR_RELEVANCE = 0.2;

/** Min keyword overlap ratio for mandatory doc injection — below this, doc is summarized instead of full-inject */
const MIN_DOC_KEYWORD_OVERLAP = 0.1;

/**
 * Risk profile → skill pack mapping (P1.5)
 * Used by ContextLoader to pre-load focused review skills based on diff risk.
 */
const RISK_SKILL_PACKS = {
  security: ['review-security', 'security-audit'],
  performance: ['review-performance', 'bp-performance-optimization'],
  interface: ['review-interface-contract', 'api-design'],
};

// ─── Three-Layer Load Levels ──────────────────────────────────────────────────
// Skills are loaded in three priority tiers:
//   Level 1 – Global:  Always loaded for every task (safety, coding standards)
//   Level 2 – Project: Loaded for all tasks in the project (from config)
//   Level 3 – Task:    Dynamically matched by keyword from task text

const LOAD_LEVEL = {
  GLOBAL:  'global',
  PROJECT: 'project',
  TASK:    'task',
};

// ─── Keyword → Skill mapping (built-in defaults) ─────────────────────────────
// Keys are skill file names (without .md), values are trigger keyword arrays.
// Projects can extend this via workflow.config.js → skillKeywords.

const BUILTIN_SKILL_KEYWORDS = {
  'flutter-dev':          ['flutter', 'dart', 'widget', 'riverpod', 'provider', 'bloc', 'pubspec'],
  'javascript-dev':       ['javascript', 'js', 'node', 'npm', 'typescript', 'ts', 'react', 'vue', 'express'],
  'go-crud':              ['go', 'golang', 'gin', 'gorm', 'grpc', 'protobuf'],
  'java-dev':             ['java', 'spring', 'maven', 'gradle', 'jvm', 'kotlin', 'ktor', 'quarkus'],
  'lua-scripting':        ['lua', 'luajit', 'coroutine', 'metatables', 'unity lua', 'xlua'],
  'unity-csharp':         ['unity', 'c#', 'csharp', 'monobehaviour', 'scriptableobject', 'ecs'],
  'api-design':           ['api', 'rest', 'graphql', 'endpoint', 'swagger', 'openapi', 'http'],
  'architecture-design':  ['architecture', 'design pattern', 'module', 'dependency', 'coupling', 'solid'],
  'code-review':          ['review', 'refactor', 'clean code', 'lint', 'quality', 'smell'],
  'test-report':          ['test', 'unit test', 'integration test', 'coverage', 'jest', 'pytest', 'mocha', 'rspec', 'phpunit', 'kotest'],
  'test-generation':      ['test case', 'test generation', 'boundary', 'edge case', 'equivalence', 'partition', 'state transition', 'mutation test', 'test design', 'test plan'],
  'project-onboarding':   ['onboard', 'setup', 'init', 'new project', 'getting started'],
  'workflow-orchestration':['workflow', 'orchestrat', 'agent', 'pipeline', 'stage'],
  'troubleshooting':      ['error', 'bug', 'fix', 'crash', 'fail', 'issue', 'debug', 'troubleshoot', 'exception'],
  'standards':            ['standard', 'convention', 'naming', 'style', 'format', 'lint'],
  'code-development':     ['code', 'develop', 'implement', 'build', 'program'],
  // ── Language-specific skills (auto-matched when skill files exist) ─────
  'php-dev':              ['php', 'laravel', 'symfony', 'composer', 'wordpress', 'eloquent', 'doctrine', 'blade'],
  'ruby-dev':             ['ruby', 'rails', 'sinatra', 'hanami', 'gemfile', 'bundler', 'activerecord', 'rspec', 'rack'],
  'swift-dev':            ['swift', 'swiftui', 'uikit', 'vapor', 'xcode', 'ios', 'macos', 'coredata', 'combine'],
  'cpp-dev':              ['c++', 'cpp', 'cmake', 'qt', 'boost', 'opencv', 'unreal', 'conan', 'vcpkg'],
  'scala-dev':            ['scala', 'akka', 'play framework', 'spark', 'sbt', 'slick', 'cats', 'zio'],
  'elixir-dev':           ['elixir', 'phoenix', 'liveview', 'ecto', 'mix', 'otp', 'erlang', 'genserver'],
  // ── AEF Best Practice Skills ──────────────────────────────────────────────
  'bp-coding-best-practices':  ['coding', 'clean code', 'naming', 'guard clause', 'RAII', 'readability', 'safety'],
  'bp-architecture-design':    ['architecture', 'module', 'dependency', 'data flow', 'trade-off', 'coupling'],
  'bp-component-design':       ['component', 'class', 'interface', 'SOLID', 'design pattern', 'concurrency', 'error handling'],
  'bp-distributed-systems':    ['distributed', 'RPC', 'network', 'replication', 'failover', 'consensus', 'circuit breaker'],
  'bp-performance-optimization':['performance', 'optimize', 'cache', 'latency', 'throughput', 'profiling', 'memory'],
  'self-refinement':           ['refine', 'reflect', 'improve', 'learn', 'mistake', 'correct', 'feedback'],
  'spec-template':             ['spec', 'specification', 'feature', 'requirement', 'design document'],
  'execution-planning':        ['plan', 'execution', 'task breakdown', 'dependency', 'phase', 'milestone', 'acceptance criteria', 'decompose'],
  // ── P2 Skills (ECC-inspired) ──────────────────────────────────────────────
  'security-audit':            ['security', 'audit', 'vulnerability', 'penetration', 'cve', 'owasp', 'injection', 'xss', 'csrf', 'auth', 'encrypt', 'secret', 'token', 'credential'],
  'database-design':           ['database', 'db', 'sql', 'nosql', 'migration', 'schema', 'index', 'query', 'table', 'column', 'foreign key', 'orm', 'model', 'entity', 'transaction', 'mongodb', 'postgresql', 'mysql', 'redis', 'sqlite'],
  'frontend-review':           ['frontend', 'react', 'vue', 'angular', 'svelte', 'css', 'html', 'dom', 'browser', 'webpack', 'vite', 'accessibility', 'a11y', 'responsive', 'spa', 'component', 'render', 'state management', 'hook', 'redux', 'zustand'],
  // ── P1.5 Review Skill Packs (split) ─────────────────────────────────────
  'review-security':           ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'auth', 'authorization', 'secret', 'token', 'credential', 'sql injection', 'audit'],
  'review-performance':        ['performance', 'latency', 'throughput', 'n+1', 'blocking', 'memory leak', 'hot path', 'cache', 'optimize'],
  'review-interface-contract': ['interface', 'contract', 'schema', 'api contract', 'type mismatch', 'breaking change', 'compatibility', 'export', 'signature'],
  // ── Methodology Skills ─────────────────────────────────────────────────────
  'requirements-analysis':       ['requirement', 'analysis', 'user story', 'acceptance criteria', 'prioritize', 'scope', 'elicit', 'stakeholder', 'moscow', '5 whys', 'invest', 'given when then'],
  'problem-solving':             ['problem', 'issue', 'root cause', 'debug', 'bug', 'fix', 'feature', 'requirement', 'analyse', 'analyze', 'investigate', 'diagnose', 'why', 'cause', 'gap', 'improve'],
  'git-conventions':             ['commit', 'git', 'changelog', 'version', 'semver', 'branch', 'merge', 'pull request', 'pr', 'mr', 'conventional commit'],
  // ── Output Quality Skills ──────────────────────────────────────────────────
  'structured-output':           ['structured output', 'write clearly', 'structure this', 'organize this', 'reduce redundancy', 'be concise', 'information density', 'token compression', 'concise', 'non-redundant'],
  // ── Documentation Skills (Agent Skills 9-category coverage) ────────────────
  'documentation-generation':      ['document', 'documentation', 'doc', 'readme', 'changelog', 'api doc', 'jsdoc', 'javadoc', 'docstring', 'comment', 'wiki', 'guide', 'tutorial', 'migration guide'],
};

// ─── Skill → Allowed Roles filtering ──────────────────────────────────────────
// Some skills should only be injected for specific roles to avoid wasting tokens.
// If a skill is listed here, it will ONLY be injected when the current role is
// in the allowed list. Skills NOT listed here have no role restriction (default).
//
// Rationale: structured-output is a writing-quality skill that benefits
// long-text-generating roles (analyst, architect, reviewer) but wastes tokens
// for code-generating roles (developer, tester) where output is mostly code.

const SKILL_ROLE_FILTER = {
  'structured-output': ['analyst', 'architect', 'reviewer', 'planner'],
  'requirements-analysis': ['analyst'],
  'problem-solving': ['analyst'],
  'git-conventions': ['developer', 'reviewer'],
  'documentation-generation': ['analyst', 'architect', 'developer', 'reviewer'],
  'javascript-dev': ['architect', 'planner', 'developer', 'reviewer', 'coding-agent'],
};

// ─── Role → architecture-constraints.md section filtering ─────────────────────
// Not all roles need the full architecture-constraints.md (~3K tokens).
// By injecting only relevant sections per role, we save ~6-9K tokens per pipeline.
//
// Section names must match the ## headings in docs/architecture-constraints.md.
// A role listed as '*' gets the full document (no filtering).
// Roles not listed here also get the full document (backward-compatible default).

const ROLE_CONSTRAINT_SECTIONS = {
  // architect: full document — architecture constraints are core input
  architect: '*',

  // analyst: only high-level constraints (project structure, communication, state)
  analyst: [
    'IDE-First Principle',
    'Module Boundaries',
    'Communication Protocol',
    'State Management',
  ],

  // planner: only structural constraints relevant to task decomposition
  planner: [
    'File Size Limits',
    'Module Boundaries',
    'Communication Protocol',
    'Dual-Path Unification Rule',
  ],

  // developer: coding-relevant constraints (skip high-level architecture sections)
  developer: [
    'File Size Limits',
    'IDE-First Principle',
    'Module Boundaries',
    'Naming Conventions',
    'State Management',
    'Command Router Architecture',
    'Structured Logging',
    'Manifest Version Migration',
    'TypeScript Support',
    'Core Module Contracts',
    'Dual-Path Unification Rule',
  ],

  // tester: only constraints relevant to test design and validation
  tester: [
    'File Size Limits',
    'Module Boundaries',
    'Communication Protocol',
    'State Management',
    'Core Module Contracts',
  ],

  // reviewer: review-focused constraints for quality and contract checks
  reviewer: [
    'File Size Limits',
    'Module Boundaries',
    'Communication Protocol',
    'Core Module Contracts',
    'Dual-Path Unification Rule',
  ],

  // coding-agent: same as developer (direct code generation)
  'coding-agent': [
    'File Size Limits',
    'IDE-First Principle',
    'Module Boundaries',
    'Naming Conventions',
    'State Management',
    'Command Router Architecture',
    'Structured Logging',
    'Manifest Version Migration',
    'TypeScript Support',
    'Core Module Contracts',
    'Dual-Path Unification Rule',
  ],

  // init-agent: no constraints needed (project initialization)
  'init-agent': [],
};

// ─── Role → Mandatory docs mapping ───────────────────────────────────────────
// These docs are ALWAYS injected for the given role, regardless of task content.

const ROLE_MANDATORY_DOCS = {
  // analyst/architect/planner: first-time injection of spec + project-profile
  analyst:    ['docs/architecture-constraints.md', 'output/project-profile.md'],
  architect:  ['docs/architecture-constraints.md', 'docs/decision-log.md', 'output/spec.md', 'output/project-profile.md'],
  planner:    ['docs/architecture-constraints.md', 'output/spec.md', 'output/architecture.md', 'output/project-profile.md'],
  // developer/tester/reviewer: spec.md and project-profile.md already injected in earlier stages;
  // execution-plan.md carries the distilled requirements, avoiding cross-stage duplication.
  developer:  ['docs/architecture-constraints.md', 'output/code-graph.md', 'output/execution-plan.md'],
  tester:     ['docs/architecture-constraints.md', 'output/execution-plan.md'],
  reviewer:   ['docs/architecture-constraints.md', 'output/execution-plan.md'],
  'coding-agent': ['docs/architecture-constraints.md', 'output/code-graph.md', 'output/project-profile.md'],
  'init-agent':   [],
};

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Token budgets
  MAX_INJECT_TOKENS,
  MAX_SKILL_TOKENS,
  MAX_ADR_TOKENS,
  MAX_GRAPH_TOKENS,
  MAX_DEP_SKILL_TOKENS,
  MAX_DEP_DEPTH,
  RISK_SKILL_TOKEN_CAP,
  RISK_SKILL_PACKS,
  RISK_SKILL_MAX_COUNT,
  // Incremental loading (T-2)
  INCREMENTAL_LOAD_ENABLED,
  INCREMENTAL_SKILL_BUDGET,
  INCREMENTAL_MAX_SKILL_TOKENS,
  // Load levels
  LOAD_LEVEL,
  // Skill keywords
  BUILTIN_SKILL_KEYWORDS,
  // Role docs
  ROLE_MANDATORY_DOCS,
  // Role-specific constraint sections
  ROLE_CONSTRAINT_SECTIONS,
  // Injection gating (P0 Token Optimization)
  MIN_SKILL_RELEVANCE,
  MIN_ADR_RELEVANCE,
  MIN_DOC_KEYWORD_OVERLAP,
  // Skill → role filter
  SKILL_ROLE_FILTER,
};