#!/usr/bin/env node

// Save original console.log for final JSON output
const originalConsoleLog = console.log;
// In IDE Agent mode, all debug logs must use console.error instead of console.log
// to prevent corrupting the JSON stdout expected by the IDE Agent.
console.log = console.error;

/**
 * IDE Workflow Bridge — Bridges IDE Agent mode to full Node.js workflow capabilities
 *
 * Problem: In IDE Agent mode, /wf commands are handled by the LLM reading a prompt file,
 * NOT by the Node.js orchestrator. This means capabilities like RequestTriage, ContextLoader,
 * ExperienceStore, and QualityGate are never invoked — the LLM only "simulates" them.
 *
 * Solution: This script exposes those capabilities as CLI sub-commands that the IDE Agent
 * can invoke via `terminal`. Zero LLM cost — all operations are pure local computation.
 *
 * Sub-commands:
 *   requirement-check  — P2-I: Validates requirement completeness before INIT → ANALYSE (Inversion Pattern)
 *   context            — ContextLoader skill/ADR/doc injection for a given stage
 *   experience-search  — ExperienceStore search by keyword/skill/tags
 *   experience-context — ExperienceStore getContextBlock for a skill
 *   experience-record  — Record a new experience to ExperienceStore
 *   staleness-check    — StalenessDetector check for outdated artifacts
 *   quality-check      — Run local QualityGate rule checks on modified files
 *   build-agent-prompt — Build role-specific Agent prompt prefix + constraints (Agent Role Isolation)
 *   rollback-check     — Validate stage output against downstream Agent input contracts (Auto-Rollback)
 *   quality-gate       — Run full QualityGate threshold validation (same as MCP orchestrator)
 *   experience-evolve  — Trigger experience evolution + distillation (no LLM required)
 *   deep-audit         — Run DeepAuditOrchestrator across all 7 dimensions (zero LLM)
 *   
 *   === 方案 A: 渐进式吸收（新增）===
 *   pm-route           — PM Agent: 路由决策和进度管理
 *   gate-check         — Gate Controller: 阶段门禁检查（PRE-DEVELOP/PRE-TEST/PRE-DEPLOY）
 *   total-gate         — 统一门禁入口（整合编译+测试+规则扫描）
 *   dev-map            — 生成/更新 Dev Map 项目索引
 *   task-board         — Task Board 操作（init/status/report）
 *   
 *   experience-health   — Run experience store health checks (layer, scope, source type)
 *   mape-analysis       — Run MAPE Monitor+Analyze+Plan cycle (zero LLM, file-based signals)
 *   regression-check    — Run RegressionGuard baseline comparison (quality delta tracking)
 *   skill-refine-check  — Identify skills that need refinement/fix (candidates for IDE Agent LLM)
 *   contract-check      — Validate core module interface contracts (IExperienceStore, ICodeGraph)
 *   skill-discover      — Auto-discover project conventions from config files (zero LLM)
 *   experience-transfer  — Cross-project experience discovery, export, and import
 *   task-history         — Cross-session task recall memory (record/recall/stats)
 *   arch-cache           — Architecture Knowledge Cache (rebuild/summary/capability-index)
 *   execution-validate   — Run ExecutionLogValidator to check execution completeness
 *   prompt-optimize      — Analyze feedback history, generate prompt optimization suggestions
 *   session-score        — Score session quality + signal detection (experience capture decision)
 *   scheduler-check      — Check for overdue scheduled tasks at session start (replaces background scheduler)
 *   degrade-output       — GDE L1: Attempt graceful degradation of LLM output (structural repair + field filling)
 *   degrade-check        — GDE L1: Quick check if output needs degradation
 *   inject-expert        — EKIC: Inject expert knowledge (inline text)
 *   list-experts         — EKIC: List all registered expert knowledge entries
 *   expert-block         — EKIC: Get formatted expert knowledge block for a role + task
 *   expert-generate      — EKIC: Generate expert knowledge from source files (requires LLM)
 *   failure-pattern-analyze — EvoSkill: Analyze failures and generate Skill recommendations
 *   issue-pattern-collect   — Collect and record issue patterns to ExperienceStore for self-evolution
 *   run                    — Execute full workflow pipeline (ANALYSE→ARCHITECT→PLAN→CODE→TEST)
 *                            Use --llm-module to inject real LLM (IDE Agent or external API)
 *
 * Usage:
 *   node workflow/tools/ide-workflow-bridge.js run --requirement "Build a REST API" --llm-module workflow/tools/ide-llm-adapter.js --project-root .
 *   node workflow/tools/ide-workflow-bridge.js run --requirement "Build a REST API" --project-root .  # mock mode (testing only)
 *   node workflow/tools/ide-workflow-bridge.js requirement-check --requirement "Add user auth feature" --project-root .
 *   node workflow/tools/ide-workflow-bridge.js context --stage ANALYSE --task "user auth" --project-root .
 *   node workflow/tools/ide-workflow-bridge.js experience-search --keyword "auth" --skill "security-audit"
 *   node workflow/tools/ide-workflow-bridge.js experience-context --skill "code-development" --task "refactor auth"
 *   node workflow/tools/ide-workflow-bridge.js experience-record --type POSITIVE --category stable_pattern --title "..." --content "..."
 *   node workflow/tools/ide-workflow-bridge.js staleness-check --project-root .
 *   node workflow/tools/ide-workflow-bridge.js quality-check --files "src/a.js,src/b.js" --project-root .
 *   node workflow/tools/ide-workflow-bridge.js build-agent-prompt --role analyst --project-root .
 *   node workflow/tools/ide-workflow-bridge.js rollback-check --stage ARCHITECT --file output/architecture.md --project-root .
 *   node workflow/tools/ide-workflow-bridge.js quality-gate --error-count 2 --test-pass-rate 0.85 --duration-ms 120000 --project-root .
 *   node workflow/tools/ide-workflow-bridge.js quality-gate --diagnostic-mode --project-root .  # EvoSkill: Record-only mode for new projects
 *
 * Output: Structured JSON to stdout (parseable by the IDE Agent).
 *
 * Design principles (ADR-37 IDE-First):
 *   - Zero LLM calls — pure local execution
 *   - Zero external dependencies — uses only workflow's own modules
 *   - Structured JSON output — easy for AI Agent to parse and use
 *   - Non-fatal errors — always returns valid JSON, even on failure
 *
 * @module workflow/tools/ide-workflow-bridge
 */

'use strict';

const fs = require('fs');
const path = require('path');

// --- IMMEDIATE LOG CLEARING & FIRST LOG ---
if (process.argv.includes('run') || process.argv.includes('triage')) {
  try {
    const outputDir = path.join(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const logFiles = [
      path.join(outputDir, 'workflow.log.jsonl'),
      path.join(outputDir, 'agent-handoff-log.jsonl'),
      path.join(outputDir, 'health', 'prod', 'workflow-trace.jsonl'),
      path.join(outputDir, 'health', 'test', 'workflow-trace.jsonl')
    ];
    for (const file of logFiles) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    const firstLog = `[${new Date().toISOString()}] [INIT] Workflow bridge started with args: ${process.argv.slice(2).join(' ')}\n`;
    fs.writeFileSync(path.join(outputDir, 'workflow.log.jsonl'), firstLog, 'utf-8');
    console.error(firstLog.trim());
  } catch (e) {
    // ignore
  }
}

const { executeWithToolGovernance } = require('../core/tool-governance-pipeline');
const { enforceRuntimePolicy } = require('../core/runtime-policy-enforcer');
const { enforceRequirementBudget } = require('../core/context-budget-policy');
const { buildCapabilityCatalog, formatCapabilityCatalogForPrompt } = require('../core/capability-catalog');
const { requirementFingerprint: _sharedRequirementFingerprint } = require('../core/stage-context-store');
const { normalizeRunCategory, resolveHealthPaths } = require('../core/health-observability');

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function _normalizeRunCategory(value) {
  return normalizeRunCategory(value);
}

function _resolveHealthPaths(projectRoot, runCategoryInput) {
  const outputDir = path.join(projectRoot, 'output');
  const runCategory = normalizeRunCategory(runCategoryInput);
  const resolved = resolveHealthPaths({ outputDir, runCategory });
  return {
    outputDir,
    runCategory: resolved.runCategory,
    healthDir: resolved.healthDir,
    tracePath: resolved.tracePath,
    healthReportPath: resolved.healthReportPath,
    qualityReportPath: resolved.qualityReportPath,
    evolutionLogPath: resolved.evolutionLogPath,
    healthHistoryPath: resolved.healthHistoryPath,
  };
}

function parseArgs(argv) {
  const args = {
    subcommand: null,
    requirement: '',
    projectRoot: '.',
    stage: '',
    task: '',
    keyword: '',
    skill: '',
    tags: [],
    type: '',
    category: '',
    title: '',
    content: '',
    files: [],
    limit: 5,
    role: 'developer',
    // quality-gate specific args
    errorCount: '0',
    durationMs: '0',
    llmCalls: '0',
    testPassRate: '',
    tokenWaste: '',
    // deep-audit specific args
    dimension: '',
    verbose: false,
    // mape-analysis specific args
    dryRun: false,
    maxActions: '5',
    // analyze/explore specific args
    noLsp: false,
    maxFiles: '',
    // task-history specific args
    mode: 'sequential',
    goal: '',
    outcome: 'success',
    // experience-transfer specific args
    sourceProject: '',
    targetProject: '',
    action: '',
    // session-score specific args
    artifactContent: '',
    // test-execute specific args
    testCommand: '',
    timeout: '120000',
    testPattern: '',
    testProfile: '',
    testSuites: '',
    testFiles: '',
    // skill-evolve/update specific args
    skillName: '',
    section: 'Best Practices',
    reason: '',
    metadata: {},
    // input-received specific args
    inputType: 'requirement',
    decision: '',
    // run specific args
    llmModule: '',
    llmTimeoutMs: '300000',
    // trace-append specific args
    event: 'unknown',
    session: '',
    seq: '1',
    runCategory: '',
    test: false,
    summary: '',        // short text summary of what this stage did
    stageInput: '',     // brief description of stage input (key files / context)
    stageOutput: '',    // brief description of stage output (key decisions / artifacts)
    // read-only explorer
    explore: false,
  };

  if (argv.length < 3) return args;
  args.subcommand = argv[2];

  for (let i = 3; i < argv.length; i++) {
    switch (argv[i]) {
      case '--requirement':
      case '-r':
        args.requirement = argv[++i] || '';
        break;
      case '--user-input':
      case '--userInput':
        args.userInput = argv[++i] || '';
        break;
      case '--input-type':
      case '--inputType':
        args.inputType = argv[++i] || 'requirement';
        break;
      case '--decision':
        args.decision = argv[++i] || '';
        break;
      case '--project-root':
      case '-p':
        args.projectRoot = argv[++i] || '.';
        break;
      case '--stage':
        args.stage = argv[++i] || '';
        break;
      case '--task':
        args.task = argv[++i] || '';
        break;
      case '--keyword':
      case '-k':
        args.keyword = argv[++i] || '';
        break;
      case '--skill':
      case '-s':
        args.skill = argv[++i] || '';
        break;
      case '--tags':
        args.tags = (argv[++i] || '').split(',').map(t => t.trim()).filter(Boolean);
        break;
      case '--type':
        args.type = argv[++i] || '';
        break;
      case '--category':
        args.category = argv[++i] || '';
        break;
      case '--title':
        args.title = argv[++i] || '';
        break;
      case '--content':
        args.content = argv[++i] || '';
        break;
      case '--files':
        args.files = (argv[++i] || '').split(',').map(f => f.trim()).filter(Boolean);
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10) || 5;
        break;
      case '--role':
        args.role = argv[++i] || 'developer';
        break;
      case '--error-count':
        args.errorCount = argv[++i] || '0';
        break;
      case '--duration-ms':
        args.durationMs = argv[++i] || '0';
        break;
      case '--llm-calls':
        args.llmCalls = argv[++i] || '0';
        break;
      case '--test-pass-rate':
        args.testPassRate = argv[++i] || '';
        break;
      case '--token-waste':
        args.tokenWaste = argv[++i] || '';
        break;
      case '--dimension':
        args.dimension = argv[++i] || '';
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--max-actions':
        args.maxActions = argv[++i] || '5';
        break;
      case '--mode':
        args.mode = argv[++i] || 'sequential';
        break;
      case '--goal':
        args.goal = argv[++i] || '';
        break;
      case '--outcome':
        args.outcome = argv[++i] || 'success';
        break;
      case '--source-project':
        args.sourceProject = argv[++i] || '';
        break;
      case '--target-project':
        args.targetProject = argv[++i] || '';
        break;
      case '--action':
        args.action = argv[++i] || '';
        break;
      case '--artifact-content':
        args.artifactContent = argv[++i] || '';
        break;
      case '--test-command':
        args.testCommand = argv[++i] || '';
        break;
      case '--timeout':
        args.timeout = argv[++i] || '120000';
        break;
      case '--test-pattern':
        args.testPattern = argv[++i] || '';
        break;
      case '--test-profile':
        args.testProfile = argv[++i] || '';
        break;
      case '--test-suites':
        args.testSuites = argv[++i] || '';
        break;
      case '--test-files':
        args.testFiles = argv[++i] || '';
        break;
      case '--skill-name':
        args.skillName = argv[++i] || '';
        break;
      case '--section':
        args.section = argv[++i] || '';
        break;
      case '--reason':
        args.reason = argv[++i] || '';
        break;
      case '--metadata':
        try {
          args.metadata = JSON.parse(argv[++i] || '{}');
        } catch {
          args.metadata = {};
        }
        break;
      case '--llm-module':
        args.llmModule = argv[++i] || '';
        break;
      case '--llm-timeout-ms':
        args.llmTimeoutMs = argv[++i] || '300000';
        break;
      case '--event':
        args.event = argv[++i] || 'unknown';
        break;
      case '--session':
      case '--session-id':
        args.session = argv[++i] || '';
        break;
      case '--seq':
        args.seq = argv[++i] || '1';
        break;
      case '--run-category':
        args.runCategory = argv[++i] || 'prod';
        break;
      case '--summary':
        args.summary = argv[++i] || '';
        break;
      case '--stage-input':
        args.stageInput = argv[++i] || '';
        break;
      case '--stage-output':
        args.stageOutput = argv[++i] || '';
        break;
      case '--test':
        args.test = true;
        break;
      case '--tool-name':
        args.toolName = argv[++i] || '';
        break;
      case '--tool-args':
        args.toolArgs = argv[++i] || '';
        break;
      case '--no-lsp':
        args.noLsp = true;
        break;
      case '--max-files':
        args.maxFiles = argv[++i] || '';
        break;
      case '--explore':
      case '--readonly':
        args.explore = true;
        break;
    }
  }

  args.projectRoot = path.resolve(args.projectRoot);
  return args;
}

// ─── Sub-command: triage ─────────────────────────────────────────────────────

// ─── Sub-command: requirement-check ──────────────────────────────────────────

/**
 * P2-I: Validates requirement completeness before allowing INIT → ANALYSE transition.
 * Implements the Google Cloud "Inversion" design pattern: prevents Agent from
 * starting work until critical requirement fields are collected.
 *
 * Checks for:
 *   - taskType: What kind of task (feature, bugfix, refactor, docs, etc.)
 *   - targetScope: What area/component is affected
 *   - successCriteria: How do we know it's done (acceptance criteria)
 *
 * Returns structured result with missing fields and guidance.
 */
function runRequirementCheck(args) {
  try {
    const { _extractRequirementData } = require('../orchestrator-auto');
    const reqData = _extractRequirementData(args.requirement);

    const REQUIRED_FIELDS = [
      { key: 'taskType', label: '任务类型', description: 'What kind of task (feature, bugfix, refactor, docs, etc.)' },
      { key: 'targetScope', label: '目标范围', description: 'What area/component is affected' },
      { key: 'successCriteria', label: '成功标准', description: 'How do we know it is done (acceptance criteria)' },
    ];

    const missingFields = [];
    const missingDetails = [];

    for (const field of REQUIRED_FIELDS) {
      const value = reqData[field.key];
      const hasValue = value !== undefined && value !== null && String(value).trim().length > 0;

      if (!hasValue) {
        missingFields.push(field.key);
        missingDetails.push({
          field: field.key,
          label: field.label,
          description: field.description,
        });
      }
    }

    const passed = missingFields.length === 0;

    let formattedMessage;
    if (passed) {
      formattedMessage = [
        '✅ Requirement completeness check PASSED',
        '',
        'All required fields are present:',
        `  • Task Type: ${reqData.taskType}`,
        `  • Target Scope: ${reqData.targetScope}`,
        `  • Success Criteria: ${reqData.successCriteria?.slice(0, 60)}${reqData.successCriteria?.length > 60 ? '...' : ''}`,
        '',
        'You may proceed to the ANALYSE stage.',
      ].join('\n');
    } else {
      formattedMessage = [
        '❌ Requirement completeness check FAILED',
        '',
        'Missing required information:',
        ...missingDetails.map(d => `  • ${d.label} (${d.field}): ${d.description}`),
        '',
        'Please provide the missing information before proceeding.',
        'The Agent needs to understand WHAT to build, WHERE it fits, and WHEN it is done.',
        '',
        'Hint: Update your requirement to include:',
        '  - What type of task (feature, bugfix, refactor, docs)',
        '  - What area/component is affected',
        '  - How to verify success (acceptance criteria)',
      ].join('\n');
    }

    return {
      success: true,
      subcommand: 'requirement-check',
      data: {
        passed,
        missingFields,
        missingDetails,
        extracted: reqData,
        formattedMessage,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'requirement-check', error: err.message };
  }
}

// ─── Sub-command: context ────────────────────────────────────────────────────

/**
 * Run ContextLoader.resolve() for a given stage/role and task text.
 * Returns injected skill sections, ADR digests, and source list.
 */
function runContext(args) {
  try {
    const { PATHS } = require('../core/constants');
    const workflowRoot = path.resolve(path.join(__dirname, '..'));

    // Map stage names to ContextLoader roles
    const stageToRole = {
      'ANALYSE': 'analyst',
      'ARCHITECT': 'architect',
      'PLAN': 'planner',
      'CODE': 'developer',
      'TEST': 'test-report',
    };
    const role = stageToRole[args.stage.toUpperCase()] || args.role || 'developer';
    const taskText = args.task || args.requirement || '';

    // Load workflow config for skill settings
    let config = {};
    try {
      const configPath = path.join(args.projectRoot, 'workflow.config.js');
      if (fs.existsSync(configPath)) {
        config = require(configPath);
      }
    } catch (_) { /* Non-fatal */ }

    // Create ContextLoader with project context
    const ContextLoader = require('../core/context-loader').ContextLoader
      || require('../core/context-loader');
    // ADR-55: inject ExperienceStore for Prevention Rule injection (MemGPT retrieval pattern)
    let _bridgeExperienceStore = null;
    try {
      const { ExperienceStore } = require('../core/experience-store');
      _bridgeExperienceStore = new ExperienceStore({ projectRoot: args.projectRoot || process.cwd() });
    } catch (_) { /* non-fatal: ExperienceStore is optional */ }
    const loader = new ContextLoader({
      workflowRoot,
      projectRoot: args.projectRoot,
      skillKeywords: config.skillKeywords || {},
      alwaysLoadSkills: config.alwaysLoadSkills || [],
      globalSkills: config.globalSkills || [],
      projectSkills: config.projectSkills || [],
      experienceStore: _bridgeExperienceStore,  // ADR-55
    });

    const { sections, tokenCount, sources } = loader.resolve(taskText, role);

    return {
      success: true,
      subcommand: 'context',
      data: {
        stage: args.stage.toUpperCase(),
        role,
        taskText: taskText.slice(0, 200),
        injectedSections: sections.length,
        tokenCount,
        sources,
        // Include the actual sections content for the IDE Agent to use
        sections: sections.map((s, i) => ({
          index: i,
          source: sources[i] || 'unknown',
          content: s.length > 3000 ? s.slice(0, 3000) + '\n... (truncated)' : s,
        })),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'context', error: err.message };
  }
}

// ─── Sub-command: experience-search ──────────────────────────────────────────

/**
 * Search ExperienceStore by keyword, skill, tags, etc.
 * Returns matching experiences with scores.
 */
function runExperienceSearch(args) {
  try {
    const { ExperienceStore } = require('../core/experience-store');
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');

    // Fallback to output/ if .workflow/ doesn't exist
    const actualPath = fs.existsSync(storePath)
      ? storePath
      : path.join(args.projectRoot, 'output', 'experiences.json');

    const store = new ExperienceStore(actualPath);

    const searchOpts = {
      limit: args.limit,
      scoreSort: true,
    };
    if (args.keyword) searchOpts.keyword = args.keyword;
    if (args.type) searchOpts.type = args.type;
    if (args.category) searchOpts.category = args.category;
    if (args.skill) searchOpts.skill = args.skill;
    if (args.tags.length > 0) searchOpts.tags = args.tags;

    const results = store.search(searchOpts);

    return {
      success: true,
      subcommand: 'experience-search',
      data: {
        query: {
          keyword: args.keyword,
          skill: args.skill,
          type: args.type,
          category: args.category,
          tags: args.tags,
        },
        totalInStore: store.getCount(),
        resultCount: results.length,
        results: results.map(exp => ({
          id: exp.id,
          type: exp.type,
          category: exp.category,
          title: exp.title,
          content: exp.content.length > 500 ? exp.content.slice(0, 500) + '...' : exp.content,
          skill: exp.skill,
          tags: exp.tags,
          hitCount: exp.hitCount,
          createdAt: exp.createdAt,
        })),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'experience-search', error: err.message };
  }
}

// ─── Sub-command: experience-context ─────────────────────────────────────────

/**
 * Get ExperienceStore context block for a skill (proven patterns + known pitfalls).
 * This is the same context that the MCP orchestrator injects into agent prompts.
 */
async function runExperienceContext(args) {
  try {
    const { ExperienceStore } = require('../core/experience-store');
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
    const actualPath = fs.existsSync(storePath)
      ? storePath
      : path.join(args.projectRoot, 'output', 'experiences.json');

    const store = new ExperienceStore(actualPath);
    const { block, ids } = await store.getContextBlockWithIds(
      args.skill || 'general',
      args.task || args.requirement || null,
      args.limit
    );

    return {
      success: true,
      subcommand: 'experience-context',
      data: {
        skill: args.skill || 'general',
        taskDescription: (args.task || args.requirement || '').slice(0, 200),
        matchedExperienceIds: ids,
        matchedCount: ids.length,
        contextBlock: block,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'experience-context', error: err.message };
  }
}

// ─── Sub-command: experience-record ──────────────────────────────────────────

/**
 * Record a new experience to ExperienceStore.
 * Supports content-based deduplication.
 */
function runExperienceRecord(args) {
  try {
    const { ExperienceStore, ExperienceType } = require('../core/experience-store');
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');

    // Ensure .workflow directory exists
    const workflowDir = path.dirname(storePath);
    if (!fs.existsSync(workflowDir)) {
      fs.mkdirSync(workflowDir, { recursive: true });
    }

    const store = new ExperienceStore(storePath);

    // Validate required fields
    if (!args.title) {
      return { success: false, subcommand: 'experience-record', error: 'Missing --title' };
    }
    if (!args.content) {
      return { success: false, subcommand: 'experience-record', error: 'Missing --content' };
    }

    const type = args.type === 'NEGATIVE' ? ExperienceType.NEGATIVE : ExperienceType.POSITIVE;
    const category = args.category || 'general';

    // Use content-based dedup to avoid duplicates
    const exp = store.recordWithContentCheck({
      type,
      category,
      title: args.title,
      content: args.content,
      skill: args.skill || null,
      tags: args.tags.length > 0 ? args.tags : [],
    });

    return {
      success: true,
      subcommand: 'experience-record',
      data: {
        experienceId: exp.id,
        type: exp.type,
        category: exp.category,
        title: exp.title,
        isNew: exp.createdAt === exp.updatedAt,
        totalInStore: store.getCount(),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'experience-record', error: err.message };
  }
}

// ─── Sub-command: staleness-check ────────────────────────────────────────────

/**
 * Check if project artifacts (CodeGraph, project profile) are outdated.
 */
function runStalenessCheck(args) {
  try {
    const { RequestTriage } = require('../core/request-triage');
    const triage = new RequestTriage();
    const staleness = triage.checkStaleness(args.projectRoot);
    const initState = triage.checkInitState(args.projectRoot);

    return {
      success: true,
      subcommand: 'staleness-check',
      data: {
        isInitialized: initState.isInitialized,
        initReason: initState.reason,
        isStale: staleness ? staleness.isStale : false,
        warnings: staleness ? (staleness.warnings || []).map(w => ({
          artifact: w.artifact || 'unknown',
          message: w.message,
          ageDays: w.ageDays || null,
        })) : [],
        recommendation: !initState.isInitialized
          ? 'Run /wf init to initialize the project'
          : staleness && staleness.isStale
            ? 'Run /wf init to refresh outdated artifacts'
            : 'All artifacts are up to date',
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'staleness-check', error: err.message };
  }
}

// ─── Sub-command: quality-check ──────────────────────────────────────────────

/**
 * Run local quality checks on specified files.
 * Checks: syntax validation, basic security patterns, code style.
 */
function runQualityCheck(args) {
  try {
    const results = [];
    const files = args.files.length > 0
      ? args.files.map(f => path.resolve(args.projectRoot, f))
      : [];

    if (files.length === 0) {
      return {
        success: true,
        subcommand: 'quality-check',
        data: { message: 'No files specified. Use --files "file1.js,file2.js"', results: [] },
      };
    }

    for (const filePath of files) {
      const fileResult = { file: path.relative(args.projectRoot, filePath), checks: [] };

      // Check file exists
      if (!fs.existsSync(filePath)) {
        fileResult.checks.push({ check: 'exists', status: 'FAIL', detail: 'File not found' });
        results.push(fileResult);
        continue;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath);

      // Syntax check for JS/TS files
      if (['.js', '.mjs', '.cjs'].includes(ext)) {
        try {
          require('vm').createScript(content, { filename: filePath });
          fileResult.checks.push({ check: 'syntax', status: 'PASS' });
        } catch (syntaxErr) {
          fileResult.checks.push({
            check: 'syntax',
            status: 'FAIL',
            detail: syntaxErr.message,
          });
        }
      }

      // Security pattern checks
      const securityPatterns = [
        { pattern: /eval\s*\(/g, name: 'eval-usage', severity: 'HIGH' },
        { pattern: /password\s*=\s*['"][^'"]+['"]/gi, name: 'hardcoded-password', severity: 'CRITICAL' },
        { pattern: /api[_-]?key\s*=\s*['"][^'"]+['"]/gi, name: 'hardcoded-api-key', severity: 'CRITICAL' },
        { pattern: /TODO|FIXME|HACK|XXX/g, name: 'code-debt-marker', severity: 'LOW' },
      ];

      for (const { pattern, name, severity } of securityPatterns) {
        const matches = content.match(pattern);
        if (matches && matches.length > 0) {
          fileResult.checks.push({
            check: `security:${name}`,
            status: severity === 'LOW' ? 'WARN' : 'FAIL',
            severity,
            detail: `Found ${matches.length} occurrence(s)`,
          });
        }
      }

      // File size check
      const lines = content.split('\n').length;
      if (lines > 600) {
        fileResult.checks.push({
          check: 'file-size',
          status: lines > 900 ? 'FAIL' : 'WARN',
          severity: lines > 900 ? 'HIGH' : 'MED',
          detail: `${lines} lines (threshold: 600 warn, 900 fail)`,
        });
      }

      // Empty catch block check
      const emptyCatchPattern = /catch\s*\([^)]*\)\s*\{\s*\}/g;
      const emptyCatches = content.match(emptyCatchPattern);
      if (emptyCatches && emptyCatches.length > 0) {
        fileResult.checks.push({
          check: 'empty-catch',
          status: 'WARN',
          severity: 'MED',
          detail: `${emptyCatches.length} empty catch block(s) — may swallow errors silently`,
        });
      }

      // If no issues found, mark as clean
      if (fileResult.checks.length === 0) {
        fileResult.checks.push({ check: 'all', status: 'PASS', detail: 'No issues found' });
      }

      results.push(fileResult);
    }

    const hasFailures = results.some(r => r.checks.some(c => c.status === 'FAIL'));

    return {
      success: true,
      subcommand: 'quality-check',
      data: {
        filesChecked: results.length,
        overallStatus: hasFailures ? 'FAIL' : 'PASS',
        results,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'quality-check', error: err.message };
  }
}

// ─── Sub-command: build-agent-prompt ──────────────────────────────────────────

/**
 * Build a role-specific Agent prompt prefix with constraints and boundaries.
 * This implements Agent Role Isolation for IDE Agent mode — the LLM "switches persona"
 * by reading the role-specific prompt, constraints, and allowed/forbidden actions.
 *
 * Returns: prompt prefix, role boundaries, mandatory docs, constraint sections.
 */
function runBuildAgentPrompt(args) {
  try {
    const role = args.role || 'developer';

    // 1. Load Agent Fixed Prefix (KV-cache-optimised prompt)
    const { AGENT_FIXED_PREFIXES } = require('../core/prompt-agent-prefixes');
    const prefix = AGENT_FIXED_PREFIXES[role];
    if (!prefix) {
      return {
        success: false,
        subcommand: 'build-agent-prompt',
        error: `Unknown role: "${role}". Valid roles: ${Object.keys(AGENT_FIXED_PREFIXES).join(', ')}`,
      };
    }

    // 2. Load Agent Contracts (allowed/forbidden actions, input/output files)
    const { AGENT_CONTRACTS, AgentRole } = require('../core/types');
    const roleKey = Object.keys(AgentRole).find(k => AgentRole[k] === role);
    const contract = roleKey ? AGENT_CONTRACTS[AgentRole[roleKey]] : null;

    // 3. Load Role-specific constraint sections and mandatory docs
    let constraintSections = '*';
    let mandatoryDocs = [];
    try {
      const config = require('../core/context-loader-config');
      constraintSections = config.ROLE_CONSTRAINT_SECTIONS[role] || '*';
      mandatoryDocs = config.ROLE_MANDATORY_DOCS[role] || [];
    } catch (_) { /* Non-fatal */ }

    // 4. Load Functionality Contracts (expected behaviors, validation rules)
    let functionalityContract = null;
    try {
      const { AGENT_FUNCTIONALITY_CONTRACTS } = require('../core/agent-functionality-contracts');
      // Map role to contract key (e.g. 'analyst' → 'AnalystAgent')
      const contractKey = role.charAt(0).toUpperCase() + role.slice(1) + 'Agent';
      functionalityContract = AGENT_FUNCTIONALITY_CONTRACTS[contractKey] || null;
    } catch (_) { /* Non-fatal */ }

    return {
      success: true,
      subcommand: 'build-agent-prompt',
      data: {
        role,
        promptPrefix: prefix.length > 4000 ? prefix.slice(0, 4000) + '\n... (truncated)' : prefix,
        promptPrefixLength: prefix.length,
        contract: contract ? {
          inputFile: contract.inputFilePath,
          outputFile: contract.outputFilePath,
          allowedActions: contract.allowedActions,
          forbiddenActions: contract.forbiddenActions,
        } : null,
        constraintSections: constraintSections === '*' ? 'ALL (full document)' : constraintSections,
        mandatoryDocs,
        functionalityContract: functionalityContract ? {
          expectedBehavior: functionalityContract.expectedBehavior,
          validationRules: functionalityContract.validationRules,
        } : null,
        instructions: [
          `You are now operating as the ${role.toUpperCase()} Agent.`,
          contract ? `You may ONLY write to: ${contract.outputFilePath}` : null,
          contract ? `You are FORBIDDEN from: ${contract.forbiddenActions.join(', ')}` : null,
          `Read the prompt prefix above and follow its instructions precisely.`,
          `Your mandatory context docs are: ${mandatoryDocs.join(', ') || 'none'}`,
        ].filter(Boolean),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'build-agent-prompt', error: err.message };
  }
}

// ─── Sub-command: rollback-check ─────────────────────────────────────────────

/**
 * Validate a stage's output file against the downstream Agent's input contract.
 * This implements Auto-Rollback detection for IDE Agent mode.
 *
 * Checks:
 *   1. File exists and is non-empty
 *   2. File meets minimum length requirement
 *   3. File contains at least one required section heading
 *
 * If validation fails, returns a rollback recommendation with the specific
 * failure reason, so the IDE Agent can re-execute the upstream stage.
 */
function runRollbackCheck(args) {
  try {
    const stage = args.stage.toUpperCase();

    // Map stage to downstream role (who consumes this stage's output)
    const stageToDownstreamRole = {
      'ANALYSE': 'architect',
      'ARCHITECT': 'planner',
      'PLAN': 'developer',
      'CODE': 'tester',
    };
    const downstreamRole = stageToDownstreamRole[stage];
    if (!downstreamRole) {
      return {
        success: true,
        subcommand: 'rollback-check',
        data: {
          stage,
          passed: true,
          message: stage === 'TEST'
            ? 'TEST is the final stage — no downstream contract to validate.'
            : `Unknown stage: "${stage}". Valid stages: ANALYSE, ARCHITECT, PLAN, CODE, TEST`,
        },
      };
    }

    // Determine the output file to check
    const stageOutputFiles = {
      'ANALYSE': 'output/requirement.md',
      'ARCHITECT': 'output/architecture.md',
      'PLAN': 'output/execution-plan.md',
      'CODE': 'output/code.diff',
    };
    const outputFile = args.files[0]
      || path.join(args.projectRoot, stageOutputFiles[stage] || '');

    // Load the downstream Agent's input contract from file-ref-bus
    // (These are the same contracts used by the MCP orchestrator's FileRefBus)
    const DOWNSTREAM_CONTRACTS = {
      architect: {
        requiredSections: [
          '## Requirements', '## Functional', '## Feature', '# Requirements', 'requirements',
          '## 需求', '## 功能', '## 功能需求', '## 用户故事', '## 特性', '需求', '功能需求',
        ],
        minLength: 100,
        description: 'requirements.md for ArchitectAgent',
      },
      planner: {
        requiredSections: [
          '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
          '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
        ],
        minLength: 200,
        description: 'architecture.md for PlannerAgent',
      },
      developer: {
        requiredSections: [
          '## Architecture', '## Component', '## Design', '## System', '# Architecture', 'architecture',
          '## 架构', '## 系统架构', '## 组件', '## 模块', '## 设计', '## 技术栈', '架构设计', '技术栈',
        ],
        minLength: 200,
        description: 'architecture.md for DeveloperAgent (via PlannerAgent)',
      },
      tester: {
        requiredSections: [
          'diff --git', '--- a/', '+++ b/', '@@', '.js', '.ts', '.py',
          '.java', '.go', '.cs', '.lua', '.rb',
        ],
        minLength: 50,
        description: 'code.diff for TesterAgent',
      },
    };

    const contract = DOWNSTREAM_CONTRACTS[downstreamRole];
    if (!contract) {
      return {
        success: true,
        subcommand: 'rollback-check',
        data: { stage, passed: true, message: `No contract defined for downstream role: ${downstreamRole}` },
      };
    }

    const failures = [];

    // Check 1: File exists
    if (!fs.existsSync(outputFile)) {
      failures.push({
        check: 'file-exists',
        detail: `Output file not found: ${outputFile}`,
      });
    } else {
      const content = fs.readFileSync(outputFile, 'utf-8');

      // Check 2: Minimum length
      if (content.length < contract.minLength) {
        failures.push({
          check: 'min-length',
          detail: `File is too short (${content.length} chars < ${contract.minLength} required). Likely a stub or incomplete output.`,
        });
      }

      // Check 3: Required sections (at least one must match)
      const hasRequiredSection = contract.requiredSections.some(section =>
        content.includes(section)
      );
      if (!hasRequiredSection) {
        failures.push({
          check: 'required-sections',
          detail: `None of the required section headings found. Expected at least one of: ${contract.requiredSections.slice(0, 5).join(', ')}...`,
        });
      }
    }

    const passed = failures.length === 0;

    // Rollback recommendation
    const rollbackTargets = {
      'ANALYSE': null,
      'ARCHITECT': 'ANALYSE',
      'PLAN': 'ARCHITECT',
      'CODE': 'PLAN',
    };

    return {
      success: true,
      subcommand: 'rollback-check',
      data: {
        stage,
        downstreamRole,
        outputFile: path.relative(args.projectRoot, outputFile),
        contractDescription: contract.description,
        passed,
        failures,
        rollbackRecommendation: passed ? null : {
          shouldRollback: true,
          rollbackTo: rollbackTargets[stage],
          reason: `${stage} output does not satisfy ${downstreamRole}'s input contract: ${failures.map(f => f.detail).join('; ')}`,
          action: rollbackTargets[stage]
            ? `Re-execute the ${rollbackTargets[stage]} stage to produce a valid output for ${downstreamRole}.`
            : `Re-execute the ${stage} stage to produce a valid output.`,
        },
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'rollback-check', error: err.message };
  }
}

// ─── Sub-command: quality-gate ───────────────────────────────────────────────

/**
 * Run the full QualityGate validation with the same thresholds as the MCP orchestrator.
 * This is the orchestrator-level quality gate (error count, test pass rate, duration, etc.),
 * NOT the file-level quality-check.
 *
 * The IDE Agent provides metrics from its own execution (error count, test results, etc.)
 * and this command validates them against the same thresholds used by the MCP orchestrator.
 *
 * Also includes file-size compliance check from architecture-constraints.md.
 */
function runQualityGate(args) {
  try {
    // Build metrics from CLI args
    const metrics = {
      errors: { count: parseInt(args.errorCount || '0', 10) },
      totalDurationMs: parseInt(args.durationMs || '0', 10),
      llm: { totalCalls: parseInt(args.llmCalls || '0', 10) },
      projectRoot: args.projectRoot,
    };

    // Parse test results if provided
    if (args.testPassRate !== undefined && args.testPassRate !== '') {
      const rate = parseFloat(args.testPassRate);
      // Convert rate to passed/failed counts (e.g. 0.85 → 85 passed, 15 failed)
      const total = 100;
      metrics.testResult = {
        passed: Math.round(rate * total),
        failed: Math.round((1 - rate) * total),
      };
    }

    // Parse token waste if provided
    if (args.tokenWaste !== undefined && args.tokenWaste !== '') {
      const waste = parseFloat(args.tokenWaste);
      metrics.blockTelemetry = {
        summary: {
          totalInjected: 1000,
          totalDropped: Math.round(waste * 1000),
        },
      };
    }

    // Load QualityGate with the same defaults as the orchestrator
    const { QualityGate, DEFAULT_QUALITY_GATES } = require('../core/quality-gate');

    // EvoSkill: Support diagnostic mode for new projects
    const gateMode = args.diagnosticMode ? 'diagnostic' : 'default';

    // Collect reflections (we don't have SelfReflectionEngine, so use a simple collector)
    const reflections = [];
    const gate = new QualityGate({
      recordIssue: (opts) => {
        const entry = { ...opts, timestamp: new Date().toISOString() };
        reflections.push(entry);
        return entry;
      },
      gateMode,
      minDiagnosticSamples: 20,
    });

    const result = gate.validate(metrics);

    return {
      success: true,
      subcommand: 'quality-gate',
      data: {
        overallPassed: result.passed,
        mode: result.mode || gateMode,
        thresholds: DEFAULT_QUALITY_GATES,
        gates: result.gates.map(g => ({
          name: g.name,
          passed: g.passed,
          actual: g.actual,
          threshold: g.threshold,
          message: g.message,
        })),
        failedGates: result.gates.filter(g => !g.passed).map(g => g.name),
        diagnostics: result.diagnostics || null,
        reflections: reflections.map(r => ({
          type: r.type,
          severity: r.severity,
          title: r.title,
          description: r.description,
        })),
        recommendation: result.passed
          ? 'All quality gates passed. Workflow output meets quality standards.'
          : `${result.gates.filter(g => !g.passed).length} gate(s) failed. Review the failed gates and address the issues before finalizing.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'quality-gate', error: err.message };
  }
}

// ─── Sub-command: experience-evolve ──────────────────────────────────────────

/**
 * Trigger experience evolution (hit-count based skill promotion) and distillation
 * (merge similar experiences). This is the same logic that runs in the Orchestrator's
 * _finalizeWorkflow(), but exposed as a standalone CLI command for IDE Agent mode.
 *
 * Zero LLM calls — distillation uses heuristic merge (LLM merge requires Orchestrator).
 */
async function runExperienceEvolve(args) {
  try {
    const { ExperienceStore } = require('../core/experience-store');
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
    const actualPath = fs.existsSync(storePath)
      ? storePath
      : path.join(args.projectRoot, 'output', 'experiences.json');

    const store = new ExperienceStore(actualPath);
    const results = {
      distillation: null,
      purged: null,
      duplicateAnalysis: null,
      layerHealth: null,
      skillRetire: null,
      healthAudit: null,
    };

    // Step 1: Purge expired experiences
    results.purged = store.purgeExpired();

    // Step 2: Run distillation (merge similar experiences)
    if (typeof store.distill === 'function') {
      try {
        results.distillation = await store.distill({
          similarityThreshold: 0.65,
          minClusterSize: 2,
          dryRun: false,
        });
      } catch (err) {
        results.distillation = { error: err.message, merged: 0, removed: 0 };
      }
    } else {
      results.distillation = { error: 'distill() not available', merged: 0, removed: 0 };
    }

    // Step 3: Analyze content duplicates
    if (typeof store.analyzeContentDuplicates === 'function') {
      try {
        const analysis = store.analyzeContentDuplicates({ similarityThreshold: 0.70 });
        results.duplicateAnalysis = {
          clusteredCount: analysis.stats.clusteredCount,
          duplicateCount: analysis.stats.duplicateCount,
          potentialSavings: analysis.stats.potentialSavings,
          topMergeSuggestions: (analysis.mergeSuggestions || []).slice(0, 5).map(s => ({
            representative: s.representative,
            memberCount: s.memberCount,
          })),
        };
      } catch (_) { /* Non-fatal */ }
    }

    // Step 4: Layer health check
    if (typeof store.checkLayerHealth === 'function') {
      results.layerHealth = store.checkLayerHealth();
    }

    // Step 5: RETIRE — Retire underperforming skills (Sleeptime Stage 3)
    try {
      const { SkillEvolutionEngine } = require('../core/skill-evolution');
      const skillEvo = new SkillEvolutionEngine({ projectRoot: args.projectRoot });
      if (typeof skillEvo.retireStaleSkills === 'function') {
        const retireResult = skillEvo.retireStaleSkills({
          minUsage: 10,
          effectivenessThreshold: 0.1,
          staleDays: 30,
          dryRun: true, // Dry-run first — IDE Agent decides whether to actually retire
        });
        results.skillRetire = {
          staleCount: retireResult.stale?.length || 0,
          staleSkills: (retireResult.stale || []).slice(0, 10).map(s => ({
            name: s.name,
            usageCount: s.usageCount,
            effectiveRate: s.effectiveCount ? (s.effectiveCount / s.usageCount * 100).toFixed(0) + '%' : 'N/A',
            lastUsed: s.lastUsed,
          })),
          report: retireResult.report || '',
        };
      }
    } catch (err) {
      results.skillRetire = { error: err.message, staleCount: 0 };
    }

    // Step 6: AUDIT — Cross-session health audit (Sleeptime Stage 4)
    try {
      const { HealthAuditor } = require('../core/health-auditor');
      const outputDir = path.join(args.projectRoot, 'output');
      // Provide a no-op recordIssue callback — we just collect findings, not persist them
      const findings = [];
      const auditor = new HealthAuditor({
        outputDir,
        recordIssue: (opts) => { const f = { ...opts }; findings.push(f); return f; },
      });
      // Inject SkillEvolutionEngine if available
      try {
        const { SkillEvolutionEngine } = require('../core/skill-evolution');
        const skillEvo = new SkillEvolutionEngine({ projectRoot: args.projectRoot });
        auditor.setSkillEvolution(skillEvo);
      } catch (_) { /* non-fatal */ }

      if (typeof auditor.audit === 'function') {
        const auditResult = await auditor.audit();
        results.healthAudit = {
          findingCount: findings.length,
          findings: findings.slice(0, 10).map(f => ({
            title: f.title || f.description,
            severity: f.severity,
            suggestedFix: f.suggestedFix,
          })),
          summary: auditResult.summary || '',
        };
      }
    } catch (err) {
      results.healthAudit = { error: err.message, findingCount: 0 };
    }

    return {
      success: true,
      subcommand: 'experience-evolve',
      data: {
        totalExperiences: store.getCount(),
        purged: results.purged,
        distillation: {
          merged: results.distillation?.merged || 0,
          removed: results.distillation?.removed || 0,
          conflicts: results.distillation?.conflicts?.length || 0,
          error: results.distillation?.error || null,
        },
        duplicateAnalysis: results.duplicateAnalysis,
        layerHealth: results.layerHealth,
        skillRetire: results.skillRetire,
        healthAudit: results.healthAudit,
        recommendation: _buildEvolveRecommendation(results),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'experience-evolve', error: err.message };
  }
}

/**
 * Build a human-readable recommendation from evolution results.
 */
function _buildEvolveRecommendation(results) {
  const parts = [];
  if (results.purged && results.purged.purged > 0) {
    parts.push(`Purged ${results.purged.purged} expired experience(s).`);
  }
  if (results.distillation && results.distillation.merged > 0) {
    parts.push(`Distilled ${results.distillation.merged} cluster(s), removed ${results.distillation.removed} redundant record(s).`);
  }
  if (results.duplicateAnalysis && results.duplicateAnalysis.potentialSavings > 0) {
    parts.push(`${results.duplicateAnalysis.potentialSavings} experience(s) could be merged to reduce redundancy.`);
  }
  if (results.layerHealth && !results.layerHealth.healthy) {
    parts.push(results.layerHealth.recommendation);
  }
  return parts.length > 0 ? parts.join(' ') : 'Experience store is healthy. No action needed.';
}

// ─── Sub-command: deep-audit ─────────────────────────────────────────────────

/**
 * Run DeepAuditOrchestrator across all 7 dimensions.
 * Zero LLM calls — all checks are static analysis against existing modules.
 * Returns structured findings with severity, category, and suggestions.
 */
async function runDeepAudit(args) {
  try {
    const { DeepAuditOrchestrator, AuditCategory } = require('../core/deep-audit-orchestrator');

    // Parse dimension filter
    let dimensions = null;
    if (args.dimension) {
      const dimMap = {
        'logic': AuditCategory.LOGIC,
        'config': AuditCategory.CONFIG,
        'function': AuditCategory.FUNCTION,
        'coupling': AuditCategory.COUPLING,
        'architecture': AuditCategory.ARCHITECTURE,
        'performance': AuditCategory.PERFORMANCE,
        'knowledge': AuditCategory.KNOWLEDGE,
      };
      const dimKey = args.dimension.toLowerCase().replace(/-/g, '_');
      if (dimMap[dimKey]) {
        dimensions = [dimMap[dimKey]];
      } else {
        return {
          success: false,
          subcommand: 'deep-audit',
          error: `Unknown dimension: "${args.dimension}". Available: ${Object.keys(dimMap).join(', ')}`,
        };
      }
    }

    const audit = new DeepAuditOrchestrator({
      orchestrator: null, // No orchestrator in IDE mode — uses file-based checks only
      verbose: args.verbose || false,
    });

    const result = await audit.run({
      dimensions: dimensions || undefined,
      autoInjectExperience: true,
    });

    // Categorize findings by severity
    const bySeverity = { critical: [], high: [], medium: [], low: [], info: [] };
    for (const f of result.findings) {
      if (bySeverity[f.severity]) {
        bySeverity[f.severity].push({
          title: f.title,
          description: (f.description || '').slice(0, 300),
          category: f.category,
          suggestion: f.suggestion || null,
        });
      }
    }

    return {
      success: true,
      subcommand: 'deep-audit',
      data: {
        totalFindings: result.findings.length,
        stats: result.stats,
        elapsedMs: result.elapsedMs,
        reportPath: result.reportPath || null,
        topPriority: [...bySeverity.critical, ...bySeverity.high].slice(0, 10),
        bySeverity: {
          critical: bySeverity.critical.length,
          high: bySeverity.high.length,
          medium: bySeverity.medium.length,
          low: bySeverity.low.length,
          info: bySeverity.info.length,
        },
        recommendation: result.findings.length === 0
          ? 'All clear — no issues found across all audit dimensions.'
          : `${bySeverity.critical.length + bySeverity.high.length} critical/high priority issue(s) need attention. See output/deep-audit-report.md for full details.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'deep-audit', error: err.message };
  }
}

// ─── Sub-command: pm-route ───────────────────────────────────────────────────

/**
 * PM Agent routing decision.
 * Route requests to the correct stage and manage progress.
 * Corresponds to: PM Agent in Solution A (routing + progress management).
 */
function runPMRoute(args) {
  try {
    const { PMAgent } = require('../agents/pm-agent');
    const pm = new PMAgent(args.projectRoot);

    const context = {
      currentStage: args.stage || null,
      requirement: args.requirement || '',
      sessionId: args.session,
    };

    // Check if init requested
    if (args.init) {
      const result = pm.initSession(context.requirement);
      return {
        success: true,
        subcommand: 'pm-route',
        data: {
          action: 'session_init',
          sessionId: result.sessionId,
          routingPlan: result.routingPlan,
          firstStage: result.firstStage,
        },
      };
    }

    // Check if advance requested
    if (args.advance) {
      const result = pm.advanceStage(args.session, args.stage, args.summary || {});
      return {
        success: true,
        subcommand: 'pm-route',
        data: {
          action: 'stage_advance',
          stage: args.stage,
          completed: result.completed,
          nextStage: result.nextStage,
        },
      };
    }

    // Route decision
    const routeResult = pm.route(context);
    return {
      success: true,
      subcommand: 'pm-route',
      data: {
        action: 'route_decision',
        decision: routeResult.decision,
        nextStage: routeResult.nextStage,
        nextStageName: routeResult.nextStageName,
        needsGateCheck: routeResult.needsGateCheck,
        estimatedProgress: routeResult.estimatedProgress,
        routingReason: routeResult.routingReason,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'pm-route', error: err.message };
  }
}

// ─── Sub-command: gate-check ─────────────────────────────────────────────────

/**
 * Gate Controller check.
 * Validates feasibility before critical stage transitions.
 * Corresponds to: Gate Controller in Solution A (hard constraints).
 */
function runGateCheck(args) {
  try {
    const { GateController } = require('../agents/gate-controller');
    const gate = new GateController(args.projectRoot);

    const gateId = args.gateId || 'PRE-DEVELOP';
    const context = {
      risks: args.risks ? JSON.parse(args.risks) : [],
    };

    const result = gate.check(gateId, context);

    return {
      success: true,
      subcommand: 'gate-check',
      data: {
        gateId: result.gateId,
        timestamp: result.timestamp,
        passed: result.passed,
        checks: result.checks,
        blockers: result.blockers,
        warnings: result.warnings,
        recommendation: result.passed
          ? `Gate ${gateId} passed. Proceeding to next stage.`
          : `Gate ${gateId} blocked. Address ${result.blockers.length} blocker(s) before proceeding.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'gate-check', error: err.message };
  }
}

// ─── Sub-command: dev-map ────────────────────────────────────────────────────

/**
 * Dev Map generator.
 * Generates/updates project-level index file (.workflow/dev-map.md).
 * Corresponds to: Dev Map in Solution A (project capability map).
 */
async function runDevMap(args) {
  try {
    const { DevMapGenerator } = require('../tools/dev-map-generator');
    const generator = new DevMapGenerator(args.projectRoot);

    const result = await generator.generate();

    return {
      success: true,
      subcommand: 'dev-map',
      data: {
        generated: result.generated,
        path: result.path,
        sections: result.sections,
        recommendation: 'Dev Map provides project overview and capability index for PM Agent routing.',
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'dev-map', error: err.message };
  }
}

// ─── Sub-command: task-board ─────────────────────────────────────────────────

/**
 * Task Board operations (init/status/report).
 * Enhanced task board with subtasks, priorities, and status flow.
 * Corresponds to: Task Board in Solution A (enhanced from stage history).
 */
function runTaskBoard(args) {
  try {
    const { TaskBoard } = require('../tools/task-board');
    const board = new TaskBoard(args.projectRoot);

    const operation = args.operation || 'status';

    switch (operation) {
      case 'init': {
        const sessionId = args.session || `wf-${Date.now()}`;
        const requirement = args.requirement || '未指定需求';
        const result = board.init(sessionId, requirement);
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'init',
            sessionId: result.sessionId,
            totalStages: result.stages.length,
            requirement: result.requirement,
          },
        };
      }

      case 'status': {
        const status = board.getStatus();
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'status',
            initialized: status.initialized,
            sessionId: status.sessionId,
            stages: status.stages,
            gates: status.gates,
            metrics: status.metrics,
          },
        };
      }

      case 'update-stage': {
        const result = board.updateStage(args.stageId, args.status, args.metadata ? JSON.parse(args.metadata) : {});
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'update-stage',
            stageId: args.stageId,
            newStatus: args.status,
            stage: result,
          },
        };
      }

      case 'update-gate': {
        const result = board.updateGate(args.gateId, args.status, args.result ? JSON.parse(args.result) : {});
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'update-gate',
            gateId: args.gateId,
            status: args.status,
            gate: result,
          },
        };
      }

      case 'report': {
        const report = board.generateReport();
        const reportPath = path.join(args.projectRoot, 'output', 'task-board-report.md');
        fs.writeFileSync(reportPath, report);
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'report',
            reportPath,
            generated: true,
          },
        };
      }

      case 'history': {
        const history = board.listHistory(parseInt(args.limit) || 10);
        return {
          success: true,
          subcommand: 'task-board',
          data: {
            operation: 'history',
            entries: history,
          },
        };
      }

      default:
        return {
          success: false,
          subcommand: 'task-board',
          error: `Unknown operation: "${operation}". Available: init, status, update-stage, update-gate, report, history`,
        };
    }
  } catch (err) {
    return { success: false, subcommand: 'task-board', error: err.message };
  }
}

// ─── Sub-command: experience-health ──────────────────────────────────────────

/**
 * Run comprehensive experience store health checks.
 * Covers: layer distribution, source type distribution, duplicate analysis,
 * capacity status, and staleness.
 */
function runExperienceHealth(args) {
  try {
    const { ExperienceStore } = require('../core/experience-store');
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
    const actualPath = fs.existsSync(storePath)
      ? storePath
      : path.join(args.projectRoot, 'output', 'experiences.json');

    const store = new ExperienceStore(actualPath);
    const stats = store.getStats();
    const checks = [];

    // Check 1: Layer health
    if (typeof store.checkLayerHealth === 'function') {
      const layerHealth = store.checkLayerHealth();
      checks.push({
        name: 'layer-health',
        passed: layerHealth.healthy,
        detail: layerHealth.recommendation,
        data: layerHealth.byLayer || null,
      });
    }

    // Check 2: Source type health
    if (typeof store.checkSourceTypeHealth === 'function') {
      const sourceHealth = store.checkSourceTypeHealth();
      checks.push({
        name: 'source-type-health',
        passed: sourceHealth.healthy,
        detail: sourceHealth.recommendation,
        data: sourceHealth.bySourceType || null,
      });
    }

    // Check 3: Capacity check
    const { EXPERIENCE } = require('../core/constants');
    const capacityRatio = stats.total / EXPERIENCE.MAX_CAPACITY;
    checks.push({
      name: 'capacity',
      passed: capacityRatio < 0.9,
      detail: capacityRatio >= 0.9
        ? `Experience store at ${(capacityRatio * 100).toFixed(1)}% capacity (${stats.total}/${EXPERIENCE.MAX_CAPACITY}). Consider running experience-evolve to distill.`
        : `Capacity healthy: ${(capacityRatio * 100).toFixed(1)}% (${stats.total}/${EXPERIENCE.MAX_CAPACITY})`,
      data: { current: stats.total, max: EXPERIENCE.MAX_CAPACITY, ratio: capacityRatio },
    });

    // Check 4: Negative experience ratio
    const negativeRatio = stats.total > 0 ? stats.negative / stats.total : 0;
    checks.push({
      name: 'negative-ratio',
      passed: negativeRatio < 0.5,
      detail: negativeRatio >= 0.5
        ? `High negative experience ratio (${(negativeRatio * 100).toFixed(1)}%). Review and address recurring issues.`
        : `Negative ratio healthy: ${(negativeRatio * 100).toFixed(1)}%`,
      data: { positive: stats.positive, negative: stats.negative, ratio: negativeRatio },
    });

    // Check 5: Evolution activity
    checks.push({
      name: 'evolution-activity',
      passed: stats.totalEvolutions > 0,
      detail: stats.totalEvolutions > 0
        ? `${stats.totalEvolutions} evolution(s) recorded — experience-to-skill pipeline is active.`
        : 'No evolutions recorded. Experiences are not being promoted to skills yet.',
      data: { totalEvolutions: stats.totalEvolutions },
    });

    // Check 6: Sentinel experience presence (Gap #2)
    // Sentinel experiences are special marker entries that trigger optimization flows.
    // In Orchestrator mode, they are injected at init Step 6b-sentinel.
    let hasSentinel = false;
    try {
      const allExps = store.search({ keyword: 'sentinel', limit: 5 });
      hasSentinel = allExps.length > 0;
    } catch (_) { /* non-fatal */ }
    checks.push({
      name: 'sentinel-presence',
      passed: hasSentinel || stats.total < 5, // Don't flag for very new stores
      detail: hasSentinel
        ? 'Sentinel experience present — optimization triggers are active.'
        : stats.total < 5
          ? 'Store is new (< 5 entries), sentinel not yet needed.'
          : 'No sentinel experience found. Consider recording a sentinel to enable optimization triggers.',
      data: { hasSentinel, storeSize: stats.total },
    });

    const allPassed = checks.every(c => c.passed);

    return {
      success: true,
      subcommand: 'experience-health',
      data: {
        overallHealthy: allPassed,
        stats,
        checks,
        recommendation: allPassed
          ? 'Experience store is healthy across all dimensions.'
          : `${checks.filter(c => !c.passed).length} health check(s) need attention: ${checks.filter(c => !c.passed).map(c => c.name).join(', ')}`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'experience-health', error: err.message };
  }
}

// ─── Sub-command: mape-analysis ──────────────────────────────────────────────

/**
 * Run MAPE Monitor+Analyze+Plan cycle.
 * Zero LLM calls — all signal collection and analysis is file-based.
 * Execute phase runs in dry-run by default in IDE mode (IDE Agent decides what to act on).
 *
 * This gives IDE Agent the same situational awareness as the Orchestrator's
 * _finalizeWorkflow() MAPE cycle, without needing an Orchestrator instance.
 */
async function runMapeAnalysis(args) {
  try {
    const { MAPEEngine } = require('../core/mape-engine');
    const outputDir = path.join(args.projectRoot, 'workflow', 'output');

    // MAPEEngine only needs outputDir for Monitor/Analyze/Plan phases
    const engine = new MAPEEngine({
      orchestrator: { _outputDir: outputDir },
      verbose: args.verbose || false,
    });

    // Always dry-run in IDE mode — IDE Agent decides what to execute
    const dryRun = args.dryRun !== false; // default true
    const maxActions = parseInt(args.maxActions, 10) || 5;

    const report = await engine.runCycle({ dryRun, maxActions });

    // Build actionable summary for IDE Agent
    const actionSummary = (report.phases.plan.plan?.actions || []).map(a => ({
      type: a.type,
      title: a.title,
      priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'][a.priority] || 'UNKNOWN',
      estimatedEffort: a.estimatedEffort,
      estimatedImpact: a.estimatedImpact,
      source: a.source,
    }));

    return {
      success: true,
      subcommand: 'mape-analysis',
      data: {
        signalCount: report.phases.monitor.signalCount,
        rootCauses: report.phases.analyze.rootCauses,
        correlations: report.phases.analyze.correlations,
        actionCount: report.phases.plan.actionCount,
        estimatedROI: report.phases.plan.estimatedROI,
        dryRun,
        elapsedMs: report.elapsed,
        signals: report.phases.monitor.signals.map(s => ({
          source: s.source,
          type: s.type,
          severity: s.severity,
          title: s.title,
        })),
        actions: actionSummary,
        recommendation: report.phases.plan.actionCount === 0
          ? 'No anomaly signals detected. System is healthy.'
          : `${report.phases.plan.actionCount} action(s) recommended (ROI: ${report.phases.plan.estimatedROI}). Review the actions array and execute relevant ones using IDE tools.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'mape-analysis', error: err.message };
  }
}

// ─── Sub-command: regression-check ──────────────────────────────────────────

/**
 * Run RegressionGuard baseline comparison.
 * Zero LLM calls — pure metric comparison against stored baseline.
 * Returns quality delta: what improved, what degraded, whether rollback is needed.
 */
function runRegressionCheck(args) {
  try {
    const { RegressionGuard } = require('../core/regression-guard');
    const outputDir = path.join(args.projectRoot, 'workflow', 'output');

    const guard = new RegressionGuard({
      outputDir,
      verbose: args.verbose || false,
    });

    // Check if baseline exists
    const baselinePath = path.join(outputDir, 'evolve-baseline.json');
    if (!fs.existsSync(baselinePath)) {
      // No baseline — capture one
      const baseline = guard.captureBaseline();
      return {
        success: true,
        subcommand: 'regression-check',
        data: {
          action: 'baseline-captured',
          metricsCount: Object.keys(baseline.metrics).length,
          skillsCount: Object.keys(baseline.skillVersions).length,
          recommendation: 'Baseline captured. Run regression-check again after making changes to compare.',
        },
      };
    }

    // Compare current state against baseline
    const comparison = guard.compareWithBaseline();
    const trend = guard.getTrend();

    return {
      success: true,
      subcommand: 'regression-check',
      data: {
        improved: comparison.improved,
        degraded: comparison.degraded,
        unchanged: comparison.unchanged,
        regressions: comparison.regressions,
        shouldRollback: comparison.degraded.length > comparison.improved.length,
        targetGaps: comparison.targetGaps || [],
        trend: trend ? {
          cycles: trend.cycles,
          avgROI: trend.avgROI,
          trend: trend.trend,
        } : null,
        recommendation: comparison.degraded.length === 0
          ? `All metrics stable or improved. ${comparison.improved.length} metric(s) improved.`
          : `${comparison.degraded.length} metric(s) degraded: ${comparison.degraded.join(', ')}. Consider reviewing recent changes.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'regression-check', error: err.message };
  }
}

// ─── Sub-command: skill-refine-check ────────────────────────────────────────

/**
 * Identify skills that need refinement or fixing.
 * Zero LLM calls — uses SkillLlmRefiner's shouldRefine/shouldFix heuristics.
 * Returns a list of candidates with recommended actions.
 *
 * The IDE Agent (which IS an LLM) can then perform the actual refinement
 * by reading the skill file and applying the same logic as SkillLlmRefiner.
 *
 * ADR-37 LLM-Lite Mode: If llmCall is provided (via args or global injection),
 * automatically performs LLM refinement for high-value candidates.
 */
function runSkillRefineCheck(args) {
  try {
    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const { PATHS } = require('../core/constants');

    const skillsDir = path.join(args.projectRoot, 'workflow', 'skills');
    const registryPath = path.join(args.projectRoot, 'workflow', 'output', 'skill-registry.json');

    const engine = new SkillEvolutionEngine(
      fs.existsSync(skillsDir) ? skillsDir : PATHS.SKILLS_DIR,
      fs.existsSync(registryPath) ? registryPath : undefined
    );

    const candidates = {
      needsRefine: [],
      needsFix: [],
      stale: [],
      hollow: [],
    };

    const STALE_DAYS = 90;
    const now = Date.now();

    for (const [name, meta] of engine.registry) {
      if (meta.retiredAt) continue;

      const content = engine.readSkill(name);
      if (!content) continue;

      // Check: needs refinement (bloated after many evolutions)
      const evolutionCount = meta.evolutionCount || 0;
      const fileSize = content.length;
      if (evolutionCount >= 5 && fileSize >= 2048) {
        candidates.needsRefine.push({
          name,
          reason: `${evolutionCount} evolutions, ${fileSize} chars — likely has duplicate/outdated entries`,
          evolutionCount,
          fileSize,
          filePath: meta.filePath,
          content,
          meta: { ...meta },
        });
      }

      // Check: needs fix (low hit rate)
      const usage = meta.usageCount || 0;
      const effective = meta.effectiveCount || 0;
      if (usage >= 10) {
        const hitRate = effective / usage;
        if (hitRate < 0.20) {
          candidates.needsFix.push({
            name,
            reason: `Hit rate ${(hitRate * 100).toFixed(1)}% (${effective}/${usage}) — content may not match real usage patterns`,
            hitRate,
            usage,
            effective,
            filePath: meta.filePath,
            content,
            meta: { ...meta },
          });
        }
      }

      // Check: stale (no activity in 90+ days)
      const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
      const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
      const latestActivity = Math.max(lastEvolved, created);
      const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;
      if (daysSince > STALE_DAYS && usage > 0) {
        candidates.stale.push({
          name,
          reason: `No activity for ${Math.round(daysSince)} days — content may be outdated`,
          daysSince: Math.round(daysSince),
          filePath: meta.filePath,
          content,
          meta: { ...meta },
        });
      }

      // Check: hollow (placeholder content)
      const bodyWords = content.replace(/^---[\s\S]*?---/, '').trim().split(/\s+/).length;
      if (bodyWords < 30) {
        candidates.hollow.push({
          name,
          reason: `Only ${bodyWords} words of content — needs enrichment`,
          bodyWords,
          filePath: meta.filePath,
          content,
          meta: { ...meta },
        });
      }
    }

    const totalCandidates = candidates.needsRefine.length + candidates.needsFix.length +
                            candidates.stale.length + candidates.hollow.length;

    // ─── P0-B: OpenSpace-Inspired Metric Health Check (Trigger 3) ───────────
    // Runs processMetricCheck() to identify skills with poor 4-dimensional
    // health metrics (appliedRate, completionRate, effectiveRate, fallbackRate).
    // These are ADDITIONAL candidates beyond the existing heuristic checks.
    const metricCheck = engine.processMetricCheck();
    const healthCandidates = metricCheck.candidates || [];

    // Merge metric-based candidates into needsFix (for 'fix' type) or needsRefine (for 'derived')
    for (const hc of healthCandidates) {
      // Avoid duplicates: skip if already in needsFix by name
      const alreadyInFix = candidates.needsFix.some(c => c.name === hc.name);
      const alreadyInRefine = candidates.needsRefine.some(c => c.name === hc.name);
      if (alreadyInFix || alreadyInRefine) continue;

      const content = engine.readSkill(hc.name);
      const meta = engine.registry.get(hc.name);
      if (!content || !meta) continue;

      if (hc.type === 'fix') {
        candidates.needsFix.push({
          name: hc.name,
          reason: `[METRIC] ${hc.direction}`,
          hitRate: hc.metrics.effectiveRate,
          usage: hc.metrics.totalSelections,
          effective: Math.round(hc.metrics.effectiveRate * hc.metrics.totalSelections),
          filePath: meta.filePath,
          content,
          meta: { ...meta },
        });
      } else if (hc.type === 'derived') {
        candidates.needsRefine.push({
          name: hc.name,
          reason: `[METRIC] ${hc.direction}`,
          evolutionCount: meta.evolutionCount || 0,
          fileSize: content.length,
          filePath: meta.filePath,
          content,
          meta: { ...meta },
        });
      }
    }

    const totalWithMetric = candidates.needsRefine.length + candidates.needsFix.length +
                            candidates.stale.length + candidates.hollow.length;

    // ─── ADR-37 LLM-Lite Mode: Auto-refinement if llmCall available ─────────
    const llmCall = args.llmCall || global.__SKILL_REFINER_LLM_CALL__;
    let llmResults = null;

    if (llmCall && totalWithMetric > 0) {
      llmResults = _performLlmRefinement(candidates, llmCall, engine);
    }

    return {
      success: true,
      subcommand: 'skill-refine-check',
      data: {
        totalSkills: engine.registry.size,
        totalCandidates: totalWithMetric,
        heuristicCandidates: totalCandidates,
        metricCandidates: healthCandidates.length,
        candidates,
        healthReport: engine.getHealthReport(),
        llmAutoRefined: llmResults ? llmResults.refined.length : 0,
        llmResults,
        recommendation: totalWithMetric === 0
          ? 'All skills are healthy. No refinement needed.'
          : _buildSkillRefineRecommendation(candidates),
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'skill-refine-check', error: err.message };
  }
}

/**
 * Performs LLM-based refinement for high-value skill candidates.
 * ADR-37: LLM is enhancement, graceful fallback on failure.
 *
 * @param {object} candidates - Candidate skills by category
 * @param {Function} llmCall - LLM call function
 * @param {SkillEvolutionEngine} engine - Evolution engine instance
 * @returns {object} Refinement results
 */
async function _performLlmRefinement(candidates, llmCall, engine) {
  const results = {
    refined: [],
    failed: [],
    skipped: [],
  };

  // Prioritize: needsRefine > needsFix > stale > hollow
  const priorityOrder = [
    ...candidates.needsRefine,
    ...candidates.needsFix,
    ...candidates.stale,
    ...candidates.hollow,
  ];

  // Limit to first 3 to avoid token overload
  const toProcess = priorityOrder.slice(0, 3);

  for (const candidate of toProcess) {
    try {
      const prompt = _buildSkillRefinePrompt(candidate);
      const refined = await llmCall(prompt);

      if (!refined || refined.length < 100) {
        results.skipped.push({ name: candidate.name, reason: 'LLM output too short' });
        continue;
      }

      // Validate output has frontmatter
      if (candidate.content.startsWith('---') && !refined.startsWith('---')) {
        results.skipped.push({ name: candidate.name, reason: 'LLM lost frontmatter' });
        continue;
      }

      // Write refined content
      const fs = require('fs');
      const tmpPath = candidate.filePath + '.tmp';
      fs.writeFileSync(tmpPath, refined, 'utf-8');
      fs.renameSync(tmpPath, candidate.filePath);

      // Update registry
      const [major, minor, patch] = (candidate.meta.version || '1.0.0').split('.').map(Number);
      const newVersion = `${major}.${minor + 1}.0`;

      const metaInRegistry = engine.registry.get(candidate.name);
      if (metaInRegistry) {
        metaInRegistry.version = newVersion;
        metaInRegistry.lastEvolvedAt = new Date().toISOString();
        metaInRegistry.evolutionCount = (metaInRegistry.evolutionCount || 0) + 1;
      }

      results.refined.push({
        name: candidate.name,
        oldVersion: candidate.meta.version,
        newVersion,
        sizeChange: `${candidate.content.length} → ${refined.length}`,
      });

    } catch (err) {
      results.failed.push({ name: candidate.name, error: err.message });
    }
  }

  // Save registry updates
  if (results.refined.length > 0) {
    engine._saveRegistry();
  }

  return results;
}

/**
 * Build LLM prompt for skill refinement.
 * Single call, no retries, token-efficient (ADR-37 LLM-Lite).
 */
function _buildSkillRefinePrompt(candidate) {
  const isFix = candidate.hitRate !== undefined;
  const truncatedContent = candidate.content.slice(0, 8000);

  if (isFix) {
    return [
      `You are a skill quality analyst. Fix this underperforming skill (hit rate ${(candidate.hitRate * 100).toFixed(1)}%).`,
      ``,
      `## Current Skill Content`,
      `\`\`\`markdown`,
      truncatedContent,
      `\`\`\``,
      ``,
      `## Issues to Address`,
      `- Hit rate is only ${(candidate.hitRate * 100).toFixed(1)}% (${candidate.effective}/${candidate.usage} usages)`,
      `- Content may not match real usage patterns`,
      ``,
      `## Instructions`,
      `1. Identify why the skill advice isn't working for users`,
      `2. Rewrite to be more actionable and specific`,
      `3. Remove vague/generic advice`,
      `4. Keep YAML frontmatter unchanged`,
      `5. Keep Evolution History section unchanged`,
      `6. Output complete fixed Markdown`,
      ``,
      `Return ONLY the fixed skill content. No explanations.`,
    ].join('\n');
  }

  return [
    `You are a skill document editor. Refine this bloated skill (${candidate.evolutionCount} evolutions).`,
    ``,
    `## Current Skill Content`,
    `\`\`\`markdown`,
    truncatedContent,
    `\`\`\``,
    ``,
    `## Instructions`,
    `1. Merge duplicate or near-duplicate entries within each section`,
    `2. Remove outdated or contradictory advice`,
    `3. Improve readability and structure`,
    `4. Preserve ALL valuable information`,
    `5. Keep YAML frontmatter unchanged`,
    `6. Keep Evolution History section unchanged`,
    `7. Output complete refined Markdown`,
    ``,
    `Return ONLY the refined skill content. No explanations.`,
  ].join('\n');
}

/**
 * Build actionable recommendation for skill refinement.
 */
function _buildSkillRefineRecommendation(candidates) {
  const parts = [];
  if (candidates.needsRefine.length > 0) {
    parts.push(`${candidates.needsRefine.length} skill(s) need refinement (bloated). Read each skill file, merge duplicate entries, remove outdated advice, and improve structure.`);
  }
  if (candidates.needsFix.length > 0) {
    parts.push(`${candidates.needsFix.length} skill(s) have low hit rates. Read each skill file, analyze why content doesn't match usage patterns, and rewrite to be more actionable.`);
  }
  if (candidates.stale.length > 0) {
    parts.push(`${candidates.stale.length} skill(s) are stale (>90 days). Use web_search to find current best practices, then update the skill file.`);
  }
  if (candidates.hollow.length > 0) {
    parts.push(`${candidates.hollow.length} skill(s) are hollow (placeholder content). Use web_search to research the topic, then generate comprehensive skill content.`);
  }
  return parts.join(' ');
}

// ─── Sub-command: contract-check (Gap #1) ───────────────────────────────────

/**
 * Validate core module interface contracts.
 * Same validation as Orchestrator Step 5b — checks IExperienceStore, IHookSystem, IStateMachine.
 * Zero LLM calls — pure interface assertion.
 */
function runContractCheck(args) {
  try {
    const { validateContract, listContracts } = require('../core/contracts');
    const availableContracts = listContracts();
    const results = [];

    // Attempt to instantiate and validate core modules
    const moduleChecks = [
      { contract: 'IExperienceStore', factory: () => {
        const { ExperienceStore } = require('../core/experience-store');
        const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
        const actualPath = fs.existsSync(storePath) ? storePath : path.join(args.projectRoot, 'output', 'experiences.json');
        return new ExperienceStore(actualPath);
      }},
      { contract: 'ICodeGraph', factory: () => {
        const graphPath = path.join(args.projectRoot, 'output', 'code-graph.json');
        if (!fs.existsSync(graphPath)) return null;
        const CodeGraph = require('../core/code-graph');
        return new CodeGraph(args.projectRoot);
      }},
    ];

    for (const { contract, factory } of moduleChecks) {
      if (!availableContracts.includes(contract)) {
        results.push({ contract, status: 'SKIP', reason: 'Contract not defined' });
        continue;
      }
      try {
        const instance = factory();
        if (!instance) {
          results.push({ contract, status: 'SKIP', reason: 'Module not available' });
          continue;
        }
        const { valid, violations } = validateContract(contract, instance);
        results.push({
          contract,
          status: valid ? 'PASS' : 'FAIL',
          violations: violations.slice(0, 5),
        });
      } catch (err) {
        results.push({ contract, status: 'ERROR', reason: err.message });
      }
    }

    const allPassed = results.every(r => r.status === 'PASS' || r.status === 'SKIP');

    return {
      success: true,
      subcommand: 'contract-check',
      data: {
        availableContracts,
        results,
        allPassed,
        recommendation: allPassed
          ? 'All core module contracts validated successfully.'
          : `${results.filter(r => r.status === 'FAIL').length} contract(s) failed. Review violations.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'contract-check', error: err.message };
  }
}

// ─── Sub-command: skill-discover (Gap #3) ────────────────────────────────────

/**
 * Run SkillDiscovery to auto-discover project conventions.
 * Zero LLM calls in IDE mode — uses rule-scan-only path.
 * The IDE Agent (which IS an LLM) can refine the output afterward.
 */
async function runSkillDiscover(args) {
  try {
    const { scanProjectConventions, formatSignalsForLLM } = require('../core/skill-discovery');
    const signals = scanProjectConventions(args.projectRoot);

    // Check if project-standards skill already exists
    const projectSkillPath = path.join(args.projectRoot, '.workflow', 'skills', 'project-standards.md');
    const skillExists = fs.existsSync(projectSkillPath);

    return {
      success: true,
      subcommand: 'skill-discover',
      data: {
        signalCount: signals.length,
        skillExists,
        skillPath: projectSkillPath,
        signals: signals.map(s => ({
          source: s.source,
          category: s.category,
          signal: s.signal,
        })),
        signalsSummary: formatSignalsForLLM(signals),
        recommendation: signals.length === 0
          ? 'No convention signals found. Project may lack config files.'
          : skillExists
            ? `Skill already exists at ${projectSkillPath}. Use --force to regenerate.`
            : `${signals.length} signals found. Use the signalsSummary to generate a project-standards skill.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'skill-discover', error: err.message };
  }
}

// ─── Sub-command: experience-transfer (Gap #4) ───────────────────────────────

/**
 * Cross-project experience discovery, export, and import via ExperienceRouter.
 * Actions: discover, publish, import, registry-summary
 */
function runExperienceTransfer(args) {
  try {
    const { ExperienceRouter } = require('../core/experience-router');
    const { ExperienceStore } = require('../core/experience-store');

    const action = args.action || 'discover';
    const projectId = path.basename(args.projectRoot);

    // Detect tech stack from workflow.config.js
    let techStack = [];
    try {
      const configPath = path.join(args.projectRoot, 'workflow.config.js');
      if (fs.existsSync(configPath)) {
        const config = require(configPath);
        techStack = (config.techStack || '').split(/[,\s]+/).filter(Boolean);
      }
    } catch (_) { /* non-fatal */ }

    // Load experience store
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
    const actualPath = fs.existsSync(storePath) ? storePath : path.join(args.projectRoot, 'output', 'experiences.json');
    const store = new ExperienceStore(actualPath);

    const router = new ExperienceRouter({
      projectId,
      projectRoot: args.projectRoot,
      techStack,
      experienceStore: store,
    });

    switch (action) {
      case 'discover': {
        const relevant = router.discoverRelevant({ threshold: 0.2, maxResults: 10 });
        return {
          success: true,
          subcommand: 'experience-transfer',
          data: {
            action: 'discover',
            projectId,
            techStack,
            relevantProjects: relevant.map(r => ({
              project: r.project,
              score: r.score,
              experienceCount: r.experienceCount,
              techStack: r.techStack,
            })),
            recommendation: relevant.length === 0
              ? 'No relevant cross-project experiences found. Register more projects first.'
              : `Found ${relevant.length} project(s) with relevant experiences. Use action=import to import them.`,
          },
        };
      }
      case 'publish': {
        const result = router.publish({ minHitCount: 2 });
        return {
          success: true,
          subcommand: 'experience-transfer',
          data: {
            action: 'publish',
            published: result.published,
            exportPath: result.path,
            recommendation: result.published > 0
              ? `Published ${result.published} experience(s) to cross-project registry.`
              : 'No experiences met the minimum hit count for publishing.',
          },
        };
      }
      case 'import': {
        const result = router.autoImport({ threshold: 0.2, maxImport: 15 });
        return {
          success: true,
          subcommand: 'experience-transfer',
          data: {
            action: 'import',
            imported: result.imported,
            sources: result.sources,
            skipped: result.skipped,
            recommendation: result.imported > 0
              ? `Imported ${result.imported} experience(s) from ${result.sources.length} project(s).`
              : 'No new experiences to import (all duplicates or below threshold).',
          },
        };
      }
      case 'registry-summary': {
        const summary = router.getRegistrySummary();
        return {
          success: true,
          subcommand: 'experience-transfer',
          data: { action: 'registry-summary', ...summary },
        };
      }
      default:
        return {
          success: false,
          subcommand: 'experience-transfer',
          error: `Unknown action: "${action}". Valid: discover, publish, import, registry-summary`,
        };
    }
  } catch (err) {
    return { success: false, subcommand: 'experience-transfer', error: err.message };
  }
}

// ─── Sub-command: task-history (Gap #6) ──────────────────────────────────────

/**
 * Cross-session task recall memory: record completed tasks and recall recent history.
 * Actions: record, recall, stats
 */
function runTaskHistory(args) {
  try {
    const { TaskHistory } = require('../core/task-history');

    const candidates = [
      path.join(args.projectRoot, 'output', 'task-history.json'),
      path.join(args.projectRoot, 'workflow', 'output', 'task-history.json'),
    ];
    let storePath = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) { storePath = p; break; }
    }
    // Default to output/ if none exists
    if (!storePath) storePath = path.join(args.projectRoot, 'output', 'task-history.json');

    const history = new TaskHistory(storePath);
    const action = args.action || 'recall';

    switch (action) {
      case 'record': {
        if (!args.goal) {
          return { success: false, subcommand: 'task-history', error: 'Missing --goal for record action' };
        }
        const taskTitles = args.title ? [args.title] : [];
        const entry = history.record({
          mode: args.mode || 'sequential',
          goal: args.goal,
          projectId: path.basename(args.projectRoot),
          taskCount: taskTitles.length || 1,
          taskTitles,
          outcome: args.outcome || 'success',
        });
        return {
          success: true,
          subcommand: 'task-history',
          data: {
            action: 'record',
            entryId: entry.id,
            goal: entry.goal,
            outcome: entry.outcome,
            totalEntries: history.entries.length,
          },
        };
      }
      case 'recall': {
        const recallBlock = history.getRecallBlock(args.limit || 5);
        const recent = history.getRecent(args.limit || 5);
        return {
          success: true,
          subcommand: 'task-history',
          data: {
            action: 'recall',
            entryCount: recent.length,
            totalEntries: history.entries.length,
            recallBlock,
            entries: recent.map(e => ({
              id: e.id,
              timestamp: e.timestamp,
              goal: e.goal,
              outcome: e.outcome,
              taskCount: e.taskCount,
              summary: e.summary,
            })),
          },
        };
      }
      case 'stats': {
        const stats = history.getStats();
        return {
          success: true,
          subcommand: 'task-history',
          data: { action: 'stats', ...stats },
        };
      }
      default:
        return {
          success: false,
          subcommand: 'task-history',
          error: `Unknown action: "${action}". Valid: record, recall, stats`,
        };
    }
  } catch (err) {
    return { success: false, subcommand: 'task-history', error: err.message };
  }
}

// ─── Sub-command: arch-cache (Gap #7) ────────────────────────────────────────

/**
 * Architecture Knowledge Cache: rebuild, inject, or query the distilled cache.
 * Fuses 5 data sources into ~1500 token cold-start injection block.
 * Actions: rebuild, summary, task-history-summary, capability-index
 */
function runArchCache(args) {
  try {
    const archCache = require('../core/arch-knowledge-cache');
    const action = args.action || 'summary';

    switch (action) {
      case 'rebuild': {
        const cache = archCache.rebuildCache(args.projectRoot, { forceAll: true });
        return {
          success: true,
          subcommand: 'arch-cache',
          data: {
            action: 'rebuild',
            version: cache.version,
            updatedAt: cache.updatedAt,
            symbolCount: cache.codeGraph?.symbolCount || 0,
            moduleCount: cache.codeGraph?.modules?.length || 0,
            hotspotCount: cache.codeGraph?.hotspots?.length || 0,
            taskCount: cache.recentTasks?.length || 0,
            hasCapabilityIndex: !!cache.capabilityIndex,
            summaryLength: cache.distilledSummary?.length || 0,
          },
        };
      }
      case 'summary': {
        const summary = archCache.getDistilledSummary(args.projectRoot);
        return {
          success: true,
          subcommand: 'arch-cache',
          data: {
            action: 'summary',
            summaryLength: summary.length,
            summary: summary.length > 5000 ? summary.slice(0, 5000) + '\n... (truncated)' : summary,
          },
        };
      }
      case 'task-history-summary': {
        const thSummary = archCache.getTaskHistorySummary(args.projectRoot);
        return {
          success: true,
          subcommand: 'arch-cache',
          data: {
            action: 'task-history-summary',
            summary: thSummary || '(No task history available)',
          },
        };
      }
      case 'capability-index': {
        const capIndex = archCache.getCapabilityIndex(args.projectRoot);
        return {
          success: true,
          subcommand: 'arch-cache',
          data: {
            action: 'capability-index',
            content: capIndex || '(No capability index available)',
          },
        };
      }
      default:
        return {
          success: false,
          subcommand: 'arch-cache',
          error: `Unknown action: "${action}". Valid: rebuild, summary, task-history-summary, capability-index`,
        };
    }
  } catch (err) {
    return { success: false, subcommand: 'arch-cache', error: err.message };
  }
}

// ─── Sub-command: execution-validate (Gap #9) ────────────────────────────────

/**
 * Run ExecutionLogValidator to check execution log completeness and score.
 * Same validation as Orchestrator teardown — checks stage outputs, integrity, flow.
 */
async function runExecutionValidate(args) {
  try {
    const { ExecutionLogValidator } = require('../core/execution-log-validator');
    const outputDir = path.join(args.projectRoot, 'output');

    if (!fs.existsSync(outputDir)) {
      return {
        success: true,
        subcommand: 'execution-validate',
        data: {
          status: 'skipped',
          reason: 'No output/ directory found. Run a workflow first.',
        },
      };
    }

    const validator = new ExecutionLogValidator({
      outputDir,
      verbose: args.verbose || false,
      strictMode: false,
      reportOutputDir: outputDir,
    });

    const result = await validator.validate();
    const { summary } = result.report;

    return {
      success: true,
      subcommand: 'execution-validate',
      data: {
        status: summary.status,
        score: summary.score,
        completedStages: summary.completedStages,
        totalStages: summary.totalStages,
        failedStages: summary.failedStages,
        warnings: summary.warnings,
        integrityChecks: (result.report.integrityChecks || []).map(c => ({
          name: c.name,
          status: c.status,
          score: c.score,
          message: c.message,
        })),
        reportPath: result.reportPaths?.latestMarkdown || null,
        recommendation: summary.score >= 80
          ? `Execution quality is good (${summary.score}/100).`
          : `Execution quality is low (${summary.score}/100). Review ${summary.failedStages} failed stage(s).`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'execution-validate', error: err.message };
  }
}

// ─── Sub-command: prompt-optimize (Gap #10) ──────────────────────────────────

/**
 * Run PromptAutoOptimizer to analyze feedback history and generate suggestions.
 * Zero LLM calls — uses heuristic pattern analysis on feedback data.
 */
function runPromptOptimize(args) {
  try {
    const { PromptAutoOptimizer } = require('../core/prompt-auto-optimizer');
    const outputDir = path.join(args.projectRoot, 'output');

    const optimizer = new PromptAutoOptimizer({
      outputDir,
      autoApply: false, // Never auto-apply in IDE mode — IDE Agent decides
    });

    const result = optimizer.analyzeAndOptimize({ dryRun: args.dryRun || false });

    if (result.status === 'skipped') {
      return {
        success: true,
        subcommand: 'prompt-optimize',
        data: {
          status: 'skipped',
          reason: result.reason,
          recommendation: 'Not enough feedback data yet. Complete more workflows to generate optimization suggestions.',
        },
      };
    }

    return {
      success: true,
      subcommand: 'prompt-optimize',
      data: {
        status: result.status,
        feedbackCount: result.dataStats?.feedbackCount || 0,
        suggestionCount: result.suggestions?.length || 0,
        suggestions: (result.suggestions || []).slice(0, 10).map(s => ({
          id: s.id,
          agent: s.agent,
          issueType: s.issueType,
          description: s.description,
          confidence: s.confidence,
          priority: s.priority,
          suggestion: s.suggestion,
        })),
        recommendation: (result.suggestions || []).length === 0
          ? 'No optimization suggestions at this time.'
          : `${result.suggestions.length} suggestion(s) generated. Review and apply relevant ones.`,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'prompt-optimize', error: err.message };
  }
}

// ─── Sub-command: session-score (Gap #12) ────────────────────────────────────

/**
 * Score a session's output quality using SessionQualityScorer + SessionSignalDetector.
 * Zero LLM calls — uses heuristic scoring on content patterns.
 */
function runSessionScore(args) {
  try {
    const { SessionQualityScorer } = require('../core/session-quality-scorer');
    const { SessionSignalDetector } = require('../core/session-signal-detector');
    const { ExperienceStore } = require('../core/experience-store');

    // Load experience store for novelty check
    const storePath = path.join(args.projectRoot, '.workflow', 'experiences.json');
    const actualPath = fs.existsSync(storePath) ? storePath : path.join(args.projectRoot, 'output', 'experiences.json');
    let expStore = null;
    try { expStore = new ExperienceStore(actualPath); } catch (_) { /* non-fatal */ }

    const scorer = new SessionQualityScorer({
      experienceStore: expStore,
      verbose: args.verbose || false,
    });

    const detector = new SessionSignalDetector({ verbose: args.verbose || false });

    // Build session output from available artifacts
    let artifactContent = args.artifactContent || '';
    if (!artifactContent) {
      // Try to load the most recent stage output
      const outputFiles = ['output/architecture.md', 'output/requirement.md', 'output/execution-plan.md'];
      for (const f of outputFiles) {
        const fp = path.join(args.projectRoot, f);
        if (fs.existsSync(fp)) {
          artifactContent += fs.readFileSync(fp, 'utf-8').slice(0, 3000) + '\n';
        }
      }
    }

    // Load decision log if available
    let decisionLog = '';
    try {
      const dlPath = path.join(args.projectRoot, 'workflow', 'decision-log.md');
      if (fs.existsSync(dlPath)) decisionLog = fs.readFileSync(dlPath, 'utf-8').slice(0, 2000);
    } catch (_) { /* non-fatal */ }

    // Detect signals
    const signalResult = detector.detectSignals({ decisionLog, outputSummary: artifactContent });

    // Score with signals
    const result = scorer.scoreWithSignals(
      { artifactContent, decisionLog },
      signalResult
    );

    return {
      success: true,
      subcommand: 'session-score',
      data: {
        score: result.score,
        qualityScore: result.qualityScore,
        signalScore: result.signalScore,
        shouldCapture: result.shouldCapture,
        reason: result.reason,
        dimensions: result.dimensions,
        signals: signalResult.signals.map(s => ({
          type: s.type,
          severity: s.severity,
          evidence: (s.evidence || '').slice(0, 100),
        })),
        recommendation: result.shouldCapture
          ? 'Session contains valuable knowledge. Record experiences from this session.'
          : 'Session is routine. No special experience capture needed.',
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'session-score', error: err.message };
  }
}

// ─── Sub-command: scheduler-check ────────────────────────────────────────────

/**
 * Check for overdue scheduled tasks at session start.
 * Replaces the Orchestrator's long-running WorkflowScheduler with a
 * "check on session start" pattern — no background process needed.
 *
 * Reads scheduler-state.json + workflow.config.js scheduler config,
 * compares lastRun + interval against current time, and reports
 * which tasks are overdue with recommended bridge commands to run.
 *
 * Zero LLM calls — pure file-based time comparison.
 */
function runSchedulerCheck(args) {
  try {
    const now = Date.now();

    // Step 1: Load scheduler config from workflow.config.js
    let schedulerConfig = null;
    try {
      const configPath = path.join(args.projectRoot, 'workflow.config.js');
      if (fs.existsSync(configPath)) {
        const config = require(configPath);
        schedulerConfig = config.scheduler || null;
      }
    } catch (_) { /* non-fatal */ }

    if (!schedulerConfig || !schedulerConfig.enabled) {
      return {
        success: true,
        subcommand: 'scheduler-check',
        data: {
          status: 'disabled',
          overdueTasks: [],
          recommendation: 'Scheduler is not enabled in workflow.config.js. Add a scheduler section to enable periodic maintenance tasks.',
          configExample: {
            scheduler: {
              enabled: true,
              tasks: [
                { command: 'deep-audit', cron: 'weekly', args: ['--incremental'] },
                { command: 'experience-evolve', cron: 'weekly', args: [] },
                { command: 'skill-refine-check', cron: 'monthly', args: [] },
              ],
            },
          },
        },
      };
    }

    const tasks = schedulerConfig.tasks || [];
    if (tasks.length === 0) {
      return {
        success: true,
        subcommand: 'scheduler-check',
        data: {
          status: 'no-tasks',
          overdueTasks: [],
          recommendation: 'Scheduler is enabled but no tasks are defined. Add tasks to the scheduler config.',
        },
      };
    }

    // Step 2: Load scheduler state (lastRun, nextRun per task)
    const stateCandidates = [
      path.join(args.projectRoot, 'output', 'scheduler-state.json'),
      path.join(args.projectRoot, 'workflow', 'output', 'scheduler-state.json'),
    ];
    let state = { tasks: {} };
    for (const sp of stateCandidates) {
      if (fs.existsSync(sp)) {
        try {
          state = JSON.parse(fs.readFileSync(sp, 'utf8'));
          break;
        } catch (_) { /* non-fatal */ }
      }
    }

    // Step 3: Parse cron intervals (reuse WorkflowScheduler's logic)
    const parseCron = (cron) => {
      const hourMs = 60 * 60 * 1000;
      const dayMs = 24 * hourMs;
      const keywords = { hourly: hourMs, daily: dayMs, weekly: 7 * dayMs, monthly: 30 * dayMs };
      if (keywords[cron.toLowerCase()]) return keywords[cron.toLowerCase()];
      const match = cron.match(/every\s+(\d+)\s+(hour|day)s?/i);
      if (match) {
        const value = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        return unit === 'hour' ? value * hourMs : value * dayMs;
      }
      return null;
    };

    const formatDuration = (ms) => {
      const hours = Math.floor(ms / (60 * 60 * 1000));
      const days = Math.floor(hours / 24);
      if (days > 0) return `${days} day${days > 1 ? 's' : ''}`;
      if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
      const minutes = Math.floor(ms / (60 * 1000));
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    };

    // Step 4: Check each task for overdue status
    const overdueTasks = [];
    const upToDateTasks = [];
    const neverRunTasks = [];

    // Map scheduler commands to bridge commands
    const commandToBridge = {
      'deep-audit': 'deep-audit',
      'review-status': 'experience-health',
      'experience-evolve': 'experience-evolve',
      'skill-refine-check': 'skill-refine-check',
      'regression-check': 'regression-check',
      'mape-analysis': 'mape-analysis',
      'experience-health': 'experience-health',
      'prompt-optimize': 'prompt-optimize',
    };

    for (const task of tasks) {
      const { command, cron, args: taskArgs = [] } = task;
      const intervalMs = parseCron(cron);
      if (!intervalMs) continue;

      const taskState = state.tasks[command];
      const lastRun = taskState?.lastRun ? new Date(taskState.lastRun).getTime() : 0;
      const lastResult = taskState?.lastResult || 'never';

      if (lastRun === 0) {
        // Never run before
        neverRunTasks.push({
          command,
          cron,
          interval: formatDuration(intervalMs),
          status: 'never-run',
          lastRun: null,
          lastResult: 'never',
          bridgeCommand: commandToBridge[command] || command,
          bridgeArgs: taskArgs.join(' '),
        });
      } else {
        const nextDue = lastRun + intervalMs;
        const overdueMs = now - nextDue;

        if (overdueMs > 0) {
          overdueTasks.push({
            command,
            cron,
            interval: formatDuration(intervalMs),
            status: 'overdue',
            lastRun: new Date(lastRun).toISOString(),
            lastResult,
            overdueBy: formatDuration(overdueMs),
            overdueMs,
            bridgeCommand: commandToBridge[command] || command,
            bridgeArgs: taskArgs.join(' '),
          });
        } else {
          upToDateTasks.push({
            command,
            cron,
            interval: formatDuration(intervalMs),
            status: 'up-to-date',
            lastRun: new Date(lastRun).toISOString(),
            lastResult,
            nextDue: new Date(nextDue).toISOString(),
            timeUntilDue: formatDuration(-overdueMs),
          });
        }
      }
    }

    // Sort overdue by most overdue first
    overdueTasks.sort((a, b) => b.overdueMs - a.overdueMs);

    // Step 5: Update state file with check timestamp
    const statePath = stateCandidates[0]; // Default to output/scheduler-state.json
    try {
      state.lastCheckedAt = new Date().toISOString();
      const dir = path.dirname(statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) { /* non-fatal */ }

    // Build recommendation
    const allActionable = [...overdueTasks, ...neverRunTasks];
    let recommendation;
    if (allActionable.length === 0) {
      recommendation = 'All scheduled tasks are up to date. No action needed.';
    } else {
      const commands = allActionable.map(t => {
        const argsStr = t.bridgeArgs ? ` ${t.bridgeArgs}` : '';
        return `node workflow/tools/ide-workflow-bridge.js ${t.bridgeCommand}${argsStr} --project-root .`;
      });
      recommendation = `${allActionable.length} task(s) need attention. Run these commands:\n${commands.join('\n')}`;
    }

    return {
      success: true,
      subcommand: 'scheduler-check',
      data: {
        status: allActionable.length > 0 ? 'action-needed' : 'all-clear',
        checkedAt: new Date().toISOString(),
        totalTasks: tasks.length,
        overdueTasks,
        neverRunTasks,
        upToDateTasks,
        recommendation,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'scheduler-check', error: err.message };
  }
}

// ─── Trace Append ────────────────────────────────────────────────────────────

/**
 * Append a single trace event to workflow-trace.jsonl.
 * Called by IDE Agent at each stage boundary to feed real execution data
 * into the trace file, which generate-health-report.js reads.
 *
 * Required args:
 *   --event        workflow_start | stage_start | stage_end | workflow_end | socratic_challenge | error
 *   --session      session ID (e.g. "wf-20260401-abc123")
 *   --seq          sequence number (integer)
 *
 * Optional args:
 *   --stage        stage name (ANALYSE | ARCHITECT | PLAN | CODE | TEST)
 *   --metadata     JSON string with event-specific data
 *   --project-root project root (default: .)
 */
// Stage → output artifact file mapping (used by auto-detect)
const STAGE_OUTPUT_FILES = {
  ANALYSE:   'analysis.md',
  ARCHITECT: 'architecture.md',
  PLAN:      'execution-plan.md',
  CODE:      'code.diff',
  DEVELOP:   'code.diff',
  TEST:      'test-report.md',
  REVIEW:    'review-output.md',
  DEPLOY:    'deploy-output.md',
};

// Stage → input artifact files mapping (used by auto-detect)
// F5: Removed phantom dependency 'requirement-traceability.json' — no stage generates this file.
// Industry reference: Kiro's explicit artifact chain — every input must have a producing stage.
const STAGE_INPUT_FILES = {
  ANALYSE:   ['output/requirement.md'],
  ARCHITECT: ['output/requirement.md', 'output/analysis.md'],
  PLAN:      ['output/requirement.md', 'output/analysis.md', 'output/architecture.md'],
  CODE:      ['output/requirement.md', 'output/analysis.md', 'output/architecture.md', 'output/execution-plan.md'],
  DEVELOP:   ['output/requirement.md', 'output/analysis.md', 'output/architecture.md', 'output/execution-plan.md'],
  TEST:      ['output/requirement.md', 'output/code.diff'],
};

/**
 * Auto-detect artifact info for a file path.
 * Returns { path, lines, hash } or null if file doesn't exist.
 */
function _detectArtifact(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    // Simple hash: length + first 32 chars
    const hash = `${content.length}-${content.slice(0, 32).replace(/\s+/g, '')}`;
    const preview = content.slice(0, 300);
    return { path: filePath, lines, hash, preview };
  } catch {
    return { path: filePath };
  }
}

function runTraceAppend(args) {
  try {
    const projectRoot = path.resolve(args.projectRoot || '.');
    const event = args.event || 'unknown';

    // ── Auto-init: if no session provided, automatically start a new trace session ──
    // This eliminates the need for IDE Agent to manually call trace-session-start.
    // The first trace-append call (typically stage_start ANALYSE) bootstraps the session.
    let session = args.session || '';
    if (!session) {
      console.error('[TraceAppend] No session provided — auto-initializing trace session...');
      const initResult = runTraceSessionStart({
        projectRoot: args.projectRoot || '.',
        requirement: args.requirement || '',
        runCategory: args.runCategory || '',
      });
      if (!initResult.success) {
        return { success: false, subcommand: 'trace-append', error: `Auto-init failed: ${initResult.error}` };
      }
      session = initResult.data.sessionId;
      console.error(`[TraceAppend] Auto-init complete. sessionId=${session}`);
    }

    const seq = parseInt(args.seq || '1', 10);
    const stage = (args.stage || '').toUpperCase() || null;

    const inferredCategory = /-test$/i.test(session)
      ? 'test'
      : /-diag$/i.test(session)
        ? 'diag'
        : 'prod';
    const requestedCategory = args.runCategory ? _normalizeRunCategory(args.runCategory) : null;
    const effectiveRunCategory = requestedCategory || inferredCategory;

    const paths = _resolveHealthPaths(projectRoot, effectiveRunCategory);
    const { outputDir, runCategory, healthDir, tracePath } = paths;

    if (requestedCategory && requestedCategory !== inferredCategory) {
      return {
        success: false,
        subcommand: 'trace-append',
        error: `run-category mismatch: session=${session} implies ${inferredCategory}, but got ${requestedCategory}`,
      };
    }

    // Ensure category-scoped health dir exists
    if (!fs.existsSync(healthDir)) {
      fs.mkdirSync(healthDir, { recursive: true });
    }

    // Parse metadata (event-specific data) — base layer from --metadata flag
    let data = {};
    if (args.metadata) {
      try {
        data = typeof args.metadata === 'object' ? args.metadata : JSON.parse(args.metadata);
      } catch {
        // Silently ignore malformed JSON (common in PowerShell)
        data = {};
      }
    }

    // Merge convenience args: --summary, --stage-input, --stage-output
    // These allow IDE Agent to pass plain text without constructing JSON
    if (args.summary)     data.summary     = data.summary     || String(args.summary);
    if (args.stageInput)  data.stageInput  = data.stageInput  || String(args.stageInput);
    if (args.stageOutput) data.stageOutput = data.stageOutput || String(args.stageOutput);

    if (event === 'workflow_start') {
      data = {
        mode: data.mode || 'sequential',
        runCategory,
        callStack: data.callStack || { entryHint: runCategory === 'test' ? 'TEST' : (runCategory === 'diag' ? 'DIAG' : 'IDE_AGENT') },
        requirement: requirementText,
        userInput: data.userInput || args.userInput || fallbackUserInput,
        attachedImages: data.attachedImages || null,
        ...data,
      };
    }

    // ── Auto-detect artifacts (IDE Agent mode: no manual metadata needed) ──
    if (stage && stage !== 'null') {
      if (event === 'stage_start') {
        // Auto-detect input artifacts for this stage
        if (!data.input) {
          const inputFiles = STAGE_INPUT_FILES[stage] || [];
          // Find the most relevant existing input file (last in dependency chain)
          let inputArtifact = null;
          for (let i = inputFiles.length - 1; i >= 0; i--) {
            const candidate = path.resolve(projectRoot, inputFiles[i]);
            const detected = _detectArtifact(candidate);
            if (detected) {
              inputArtifact = detected;
              break;
            }
          }
          if (inputArtifact) {
            data.input = inputArtifact;
          }
          // Also record all input deps status
          data.inputDeps = inputFiles.map(f => ({
            file: f,
            exists: fs.existsSync(path.resolve(projectRoot, f)),
          }));
        }

        // ── P1: Artifact Staleness Detection ─────────────────────────────────
        // Check if the stage's output artifact was produced for the current requirement.
        // If the requirement hash doesn't match, the artifact is stale and must be regenerated.
        const outputFile = STAGE_OUTPUT_FILES[stage];
        if (outputFile) {
          const outputPath = path.join(outputDir, outputFile);
          const existingArtifact = _detectArtifact(outputPath);
          if (existingArtifact) {
            // Compute a simple hash of the current requirement for comparison
            const reqText = data.requirement || args.requirement || '';
            const reqHash = reqText
              ? `req-${reqText.length}-${reqText.slice(0, 32).replace(/\s+/g, '')}`
              : null;

            // Read the requirement hash stored in the trace (last workflow_start event)
            let storedReqHash = null;
            try {
              const traceContent = fs.existsSync(tracePath)
                ? fs.readFileSync(tracePath, 'utf-8')
                : '';
              const lines = traceContent.trim().split('\n').filter(Boolean);
              // Find the most recent workflow_start event for this session
              for (let i = lines.length - 1; i >= 0; i--) {
                try {
                  const evt = JSON.parse(lines[i]);
                  if (evt.event === 'workflow_start' && evt.session === session) {
                    const storedReq = evt.data?.requirement || '';
                    storedReqHash = storedReq
                      ? `req-${storedReq.length}-${storedReq.slice(0, 32).replace(/\s+/g, '')}`
                      : null;
                    break;
                  }
                } catch { /* skip malformed lines */ }
              }
            } catch { /* ignore read errors */ }

            // Mark artifact as stale if requirement changed
            const isStale = reqHash && storedReqHash && reqHash !== storedReqHash;
            data.artifactStaleness = {
              file: outputPath,
              exists: true,
              hash: existingArtifact.hash,
              reqHash,
              storedReqHash,
              isStale,
              action: isStale
                ? `REGENERATE — artifact was produced for a different requirement (${storedReqHash}), current requirement is (${reqHash})`
                : 'OK — artifact matches current requirement',
            };

            if (isStale) {
              console.error(`[TraceAppend] ⚠️  STALE ARTIFACT detected for ${stage}: ${outputFile}`);
              console.error(`[TraceAppend]    Stored req hash: ${storedReqHash}`);
              console.error(`[TraceAppend]    Current req hash: ${reqHash}`);
              console.error(`[TraceAppend]    → You MUST regenerate this artifact for the current requirement.`);
            } else {
              console.error(`[TraceAppend] ✅ Artifact freshness OK for ${stage}: ${outputFile}`);
            }
          }
        }
        // ── End P1 ────────────────────────────────────────────────────────────

      } else if (event === 'stage_end' || event === 'stage_error') {
        // Auto-detect output artifact for this stage
        if (!data.output) {
          const outputFile = STAGE_OUTPUT_FILES[stage];
          if (outputFile) {
            const outputPath = path.join(outputDir, outputFile);
            const detected = _detectArtifact(outputPath);
            if (detected) {
              data.output = detected;
            }
          }
        }
        // Default success=true if not explicitly set
        if (data.success === undefined && event !== 'stage_error') {
          data.success = true;
        }

        // ── P0: Auto-run metrics QualityGate on stage_end ─────────────────────
        // Mirrors the runStageMetricsGate() call in Node Orchestrator stage files.
        // Non-blocking: gate result is embedded in trace data, never aborts pipeline.
        if (event === 'stage_end' && stage) {
          const STAGE_NAME_MAP = {
            ANALYSE: 'ANALYSE', ARCHITECT: 'ARCHITECT', PLAN: 'PLAN',
            DEVELOP: 'DEVELOP', CODE: 'DEVELOP', TEST: 'TEST',
          };
          const gateStageName = STAGE_NAME_MAP[stage] || stage;
          try {
            const { QualityGate } = require('../core/quality-gate');
            const gateReflections = [];
            const metricsGate = new QualityGate({
              recordIssue: (opts) => {
                const entry = { ...opts, timestamp: new Date().toISOString() };
                gateReflections.push(entry);
                return entry;
              },
            });
            const stageMetrics = {
              errors: { count: parseInt(data.errorCount || data.errors || '0', 10) },
              totalDurationMs: parseInt(data.durationMs || data.duration || '0', 10),
              llm: { totalCalls: parseInt(data.llmCalls || '0', 10) },
            };
            const gateResult = metricsGate.validateStage(gateStageName, stageMetrics);
            const failedGateNames = gateResult.gates.filter(g => !g.passed).map(g => g.name);

            // Embed gate result into trace data for health-report visibility
            data.metricsGate = {
              passed: gateResult.passed,
              failedGates: failedGateNames,
              gates: gateResult.gates.map(g => ({
                name: g.name, passed: g.passed, actual: g.actual, threshold: g.threshold,
              })),
            };

            if (!gateResult.passed) {
              console.error(`[TraceAppend:QualityGate:${gateStageName}] ⚠️  ${failedGateNames.length} metric gate(s) failed: [${failedGateNames.join(', ')}]`);
            } else {
              console.error(`[TraceAppend:QualityGate:${gateStageName}] ✅ All metric gates passed`);
            }
          } catch (gateErr) {
            // Non-fatal: gate check must never break trace writing
            console.error(`[TraceAppend:QualityGate] ⚠️  Metrics gate check failed (non-fatal): ${gateErr.message}`);
          }
        }
        // ── End P0 ────────────────────────────────────────────────────────────
      }
    }

    const traceEvent = {
      ts: new Date().toISOString(),
      session,
      seq,
      event,
      stage: stage || null,
      data,
    };

    fs.appendFileSync(tracePath, JSON.stringify(traceEvent) + '\n', 'utf-8');
    console.error(`[TraceAppend][PERSISTED] event=${event} stage=${stage || '-'} seq=${seq} session=${session} trace=${tracePath}`);

    // Print detected artifact info for IDE Agent visibility
    if (data.output?.path) {
      console.error(`[TraceAppend] ✅ Output artifact auto-detected: ${data.output.path} (${data.output.lines} lines)`);
    } else if (event === 'stage_end' && stage) {
      const expectedFile = STAGE_OUTPUT_FILES[stage];
      if (expectedFile) {
        console.error(`[TraceAppend] ⚠️  Output artifact not found: ${path.join(outputDir, expectedFile)} — did you write the output file?`);
      }
    }

    // Realtime refresh: regenerate health-report for THIS session immediately
    // so IDE users can see newest trace content without waiting for final flush.
    try {
      const { execFileSync } = require('child_process');
      const reportScriptPath = path.join(__dirname, 'generate-health-report.js');
      execFileSync(process.execPath, [
        reportScriptPath,
        '--output-dir', outputDir,
        '--run-category', runCategory,
        '--session', session,
        '--project-root', projectRoot,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (refreshErr) {
      // Non-fatal: trace writing should never be blocked by report refresh.
      console.error(`[TraceAppend] ⚠️ Realtime health refresh failed (non-fatal): ${refreshErr.message}`);
    }

    return {
      success: true,
      subcommand: 'trace-append',
      data: {
        tracePath,
        runCategory,
        event,
        session,
        seq,
        stage,
        artifactDetected: !!(data.output?.path || data.input?.path),
        autoInitialized: !args.session,  // true if session was auto-created
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'trace-append', error: err.message };
  }
}

/**
 * Start a new trace session: writes workflow_start event and returns the session ID.
 * IDE Agent calls this at the very beginning of /wf execution.
 *
 * Required args:
 *   --requirement  user requirement string
 *
 * Optional args:
 *   --project-root project root (default: .)
 */
function runTraceSessionStart(args) {
  try {
    const projectRoot = path.resolve(args.projectRoot || '.');
    const requestedCategory = _normalizeRunCategory(args.runCategory);
    const inferredCategory = (requestedCategory === 'prod')
      ? (!!(args.test || args['--test']) ? 'test' : 'prod')
      : requestedCategory;
    const isTest = inferredCategory === 'test';
    const paths = _resolveHealthPaths(projectRoot, inferredCategory);
    const { outputDir, runCategory, healthDir, tracePath } = paths;

    if (!fs.existsSync(healthDir)) {
      fs.mkdirSync(healthDir, { recursive: true });
    }

    const reportPath = path.join(healthDir, 'health-report.md');
    fs.writeFileSync(tracePath, '', 'utf-8');
    fs.writeFileSync(reportPath, '', 'utf-8');
    console.error(`[TraceSessionStart] 🧹 Cleared previous logs: trace=${tracePath} report=${reportPath}`);

    // Generate a unique session ID
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const suffix = runCategory === 'test' ? '-test' : (runCategory === 'diag' ? '-diag' : '');
    const sessionId = `wf-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${suffix}`;

    const requirementText = String(args.requirement || '').trim();
    const fallbackUserInput = requirementText ? `/wf ${requirementText}` : '/wf';

    const traceEvent = {
      ts: now.toISOString(),
      session: sessionId,
      seq: 1,
      event: 'workflow_start',
      stage: null,
      data: {
        requirement: requirementText,
        mode: 'sequential',
        runCategory,
        callStack: { entryHint: runCategory === 'test' ? 'TEST' : (runCategory === 'diag' ? 'DIAG' : 'IDE_AGENT') },
        userInput: args.userInput || fallbackUserInput,
        attachedImages: null,
        isTest: isTest || undefined,
      },
    };

    fs.appendFileSync(tracePath, JSON.stringify(traceEvent) + '\n', 'utf-8');
    console.error(`[TraceSessionStart][PERSISTED] event=workflow_start seq=1 session=${sessionId} runCategory=${runCategory} trace=${tracePath}`);

    // Realtime refresh: create/update health-report immediately for this new session
    try {
      const { execFileSync } = require('child_process');
      const reportScriptPath = path.join(__dirname, 'generate-health-report.js');
      execFileSync(process.execPath, [
        reportScriptPath,
        '--output-dir', outputDir,
        '--run-category', runCategory,
        '--session', sessionId,
        '--project-root', projectRoot,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      });
    } catch (refreshErr) {
      console.error(`[TraceSessionStart] ⚠️ Realtime health refresh failed (non-fatal): ${refreshErr.message}`);
    }

    return {
      success: true,
      subcommand: 'trace-session-start',
      data: {
        sessionId,
        runCategory,
        tracePath,
        seq: 1,
      },
    };
  } catch (err) {
    return { success: false, subcommand: 'trace-session-start', error: err.message };
  }
}

// ─── Socratic Challenge ──────────────────────────────────────────────────────

/**
 * Run SocraticChallenger on a stage's output artifact.
 * Called by IDE Agent after each stage completes (dual-mode parity with Orchestrator).
 *
 * This implements ADR-54 / ADR-55 for IDE Agent mode:
 *   - Reads the stage's output artifact
 *   - Generates Socratic questions based on ACTUAL content (not generic templates)
 *   - Detects blind spots across 10 dimensions
 *   - Appends a socratic_challenge trace event
 *   - Returns structured questions for the IDE Agent to reflect on
 *
 * Required args:
 *   --stage        stage name (ANALYSE | ARCHITECT | PLAN | CODE | TEST)
 *   --session      session ID
 *   --seq          sequence number
 *
 * Optional args:
 *   --requirement  original requirement (for context)
 *   --project-root project root (default: .)
 *   --verbose      enable verbose logging
 *
 * Usage:
 *   node workflow/tools/ide-workflow-bridge.js socratic-challenge \
 *     --stage ANALYSE --session wf-20260401-123456 --seq 3 \
 *     --requirement "Fix P0 bug in auth module" --project-root .
 */
async function runSocraticChallenge(args) {
  try {
    const projectRoot = path.resolve(args.projectRoot || '.');
    const paths = _resolveHealthPaths(projectRoot, args.runCategory);
    const { outputDir, healthDir, tracePath } = paths;
    const stage = (args.stage || '').toUpperCase();
    const session = args.session || `wf-${Date.now()}`;
    const seq = parseInt(args.seq || '1', 10);
    const requirement = args.requirement || '';
    const verbose = !!(args.verbose);

    if (!stage) {
      return { success: false, subcommand: 'socratic-challenge', error: 'Missing --stage argument' };
    }

    // ── Load SocraticChallenger ───────────────────────────────────────────────
    let SocraticChallenger;
    try {
      ({ SocraticChallenger } = require('../core/socratic-challenger'));
    } catch (loadErr) {
      return { success: false, subcommand: 'socratic-challenge', error: `Cannot load SocraticChallenger: ${loadErr.message}` };
    }

    // ── Read stage output artifact ────────────────────────────────────────────
    const outputFile = STAGE_OUTPUT_FILES[stage];
    if (!outputFile) {
      return { success: false, subcommand: 'socratic-challenge', error: `Unknown stage: ${stage}` };
    }
    const artifactPath = path.join(outputDir, outputFile);

    // ── Resolve LLM call for SocraticChallenger (SC-2: dual-mode parity) ─────
    // Previously llmCall was always null in Bridge mode, preventing LLM question
    // rewriting. Now we resolve it the same way as runWorkflow does:
    //   1. --llm-module <path>  2. WORKFLOW_LLM_MODULE env var  3. null (rule-only)
    let socraticLlmCall = null;
    const llmModulePath = args.llmModule || process.env.WORKFLOW_LLM_MODULE || '';
    if (llmModulePath) {
      try {
        const absLlmModulePath = path.resolve(llmModulePath);
        const llmModule = require(absLlmModulePath);
        if (typeof llmModule === 'function') {
          socraticLlmCall = llmModule;
        } else if (typeof llmModule.llmCall === 'function') {
          socraticLlmCall = llmModule.llmCall;
        } else if (typeof llmModule.createIdeLlmCall === 'function') {
          socraticLlmCall = llmModule.createIdeLlmCall({
            outputDir,
            timeoutMs: parseInt(args.llmTimeoutMs || '300000', 10),
          });
        }
        if (socraticLlmCall) {
          console.error(`[SocraticChallenge] ✅ LLM rewrite enabled via: ${absLlmModulePath}`);
        }
      } catch (moduleErr) {
        console.error(`[SocraticChallenge] ⚠️  Failed to load llm-module "${llmModulePath}": ${moduleErr.message}. LLM rewrite disabled.`);
      }
    } else {
      console.error(`[SocraticChallenge] ℹ️  No --llm-module specified. Socratic questions use rule-driven generation only (no LLM rewrite).`);
    }

    // ── Run SocraticChallenger synchronously ──────────────────────────────────
    // SocraticChallenger.challenge() is async but internal LLM rewrite is opt-in.
    // Without llmCall, all logic is sync (rule-driven only).
    const challenger = new SocraticChallenger({
      maxQuestions: 5,
      verbose,
      projectRoot,
      llmCall: socraticLlmCall,
    });

    // D1: Cross-stage dedup in IDE mode — load previous questions from trace
    // to pre-populate session hash set (since each CLI call creates a new instance)
    try {
      if (fs.existsSync(tracePath)) {
        const traceLines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean);
        for (const line of traceLines) {
          try {
            const evt = JSON.parse(line);
            if (evt.event === 'socratic_challenge' && evt.session === session && Array.isArray(evt.data?.questions)) {
              challenger._rememberQuestions(evt.data.questions);
            }
          } catch { /* skip malformed lines */ }
        }
        if (challenger._sessionQuestionCoreHashes.size > 0) {
          console.error(`[SocraticChallenge] D1: Loaded ${challenger._sessionQuestionCoreHashes.size} question hashes from previous stages`);
        }
      }
    } catch { /* ignore trace read errors */ }

    // Read artifact content directly for richer, content-aware questioning
    let artifactContent = '';
    if (fs.existsSync(artifactPath)) {
      try {
        artifactContent = fs.readFileSync(artifactPath, 'utf-8');
      } catch { /* ignore */ }
    }

    // ── Run challenger for stage + artifact aware questions (rule-driven) ─────
    const contentLines = artifactContent.split('\n');
    const headingClaims = (artifactContent.match(/^#+\s+(.+)/gm) || []).length;

    // D7: Load previous stage artifacts for cross-stage consistency checking
    const STAGE_ORDER = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'DEVELOP', 'TEST'];
    const currentIdx = STAGE_ORDER.indexOf(stage);
    const previousArtifacts = {};
    if (currentIdx > 0) {
      for (let i = 0; i < currentIdx; i++) {
        const prevStage = STAGE_ORDER[i];
        const prevFile = STAGE_OUTPUT_FILES[prevStage];
        if (prevFile) {
          const prevPath = path.join(outputDir, prevFile);
          try {
            if (fs.existsSync(prevPath)) {
              const prevContent = fs.readFileSync(prevPath, 'utf-8');
              // Only include if non-trivial (>50 chars, not LIGHTWEIGHT)
              if (prevContent.length > 50 && !prevContent.includes('[LIGHTWEIGHT]')) {
                // Truncate to first 2000 chars to avoid memory bloat
                previousArtifacts[prevStage] = prevContent.substring(0, 2000);
              }
            }
          } catch { /* ignore read errors */ }
        }
      }
      if (Object.keys(previousArtifacts).length > 0) {
        console.error(`[SocraticChallenge] D7: Loaded ${Object.keys(previousArtifacts).length} previous stage artifact(s) for cross-stage checking`);
      }
    }

    const challengeResult = await challenger.challenge(stage, artifactContent, {
      rawRequirement: requirement,
      requirement,
      stage,
      artifactPath,
      llmSource: 'mock',
      isMockLlm: true,
      previousArtifacts,  // D7: Cross-stage context
      artifactMeta: {
        lines: contentLines.length,
        headings: headingClaims,
      },
    });

    challengeResult.artifactPath = fs.existsSync(artifactPath) ? artifactPath : null;
    challengeResult.artifactLines = contentLines.length;
    challengeResult.claimsFound = headingClaims;

    // ── Append socratic_challenge trace event ─────────────────────────────────
    if (!fs.existsSync(healthDir)) {
      fs.mkdirSync(healthDir, { recursive: true });
    }

    const traceEvent = {
      ts: new Date().toISOString(),
      session,
      seq,
      event: 'socratic_challenge',
      stage,
      data: {
        challenged: challengeResult.challenged !== false,
        triggerReasons: challengeResult.triggerReasons || [],
        triggerScore: challengeResult.triggerScore,
        triggerThreshold: challengeResult.triggerThreshold,
        confidence: challengeResult.confidence,
        confidenceStatus: challengeResult.confidenceStatus || 'ok',
        confidenceReason: challengeResult.confidenceReason || null,
        questions: challengeResult.questions,
        advisoryQuestions: challengeResult.advisoryQuestions || [],
        blindSpots: challengeResult.blindSpots,
        advisoryBlindSpots: challengeResult.advisoryBlindSpots || [],
        shouldRetry: challengeResult.shouldRetry,
        requiresRevision: challengeResult.requiresRevision === true,
        revisionSummary: challengeResult.revisionSummary || null,
        p2Protocol: challengeResult.p2Protocol || null,
        artifactPath: challengeResult.artifactPath,
        artifactLines: challengeResult.artifactLines,
        claimsFound: challengeResult.claimsFound,
        evidenceBreakdown: challengeResult.evidenceBreakdown || null,
        ruleDiagnostics: challengeResult.ruleDiagnostics || null,
      },
    };
    fs.appendFileSync(tracePath, JSON.stringify(traceEvent) + '\n', 'utf-8');

    // ── Console output for IDE Agent visibility ───────────────────────────────
    const confidenceLabel = challengeResult?.confidenceStatus === 'na'
      ? `N/A (${challengeResult?.confidenceReason || 'insufficient evidence'})`
      : `${(challengeResult.confidence * 100).toFixed(0)}%`;
    const advisoryCount = (challengeResult.advisoryQuestions || []).length;
    const scoreLabel = challengeResult.triggerScore !== undefined
      ? ` | TriggerScore: ${challengeResult.triggerScore}/${challengeResult.triggerThreshold}`
      : '';
    console.error(`[SocraticChallenge] 🤔 Stage: ${stage} | Confidence: ${confidenceLabel} | Questions: ${(challengeResult.questions || []).length} | Advisory: ${advisoryCount} | Blind spots: ${(challengeResult.blindSpots || []).length}${scoreLabel}`);
    if (challengeResult.p2Protocol?.name) {
      console.error(`[SocraticChallenge] 🧪 P2 protocol: ${challengeResult.p2Protocol.name} | verification questions: ${(challengeResult.p2Protocol.verificationQuestions || []).length}`);
    }
    if (challengeResult.shouldRetry) {
      console.error(`[SocraticChallenge] ⚠️  Low confidence — IDE Agent should revisit this stage output`);
    }

    return {
      success: true,
      subcommand: 'socratic-challenge',
      data: challengeResult,
    };
  } catch (err) {
    return { success: false, subcommand: 'socratic-challenge', error: err.message };
  }
}

/**
 * Generate content-aware Socratic questions based on ACTUAL artifact content.
 * This is the key difference from generic template questions:
 * questions are derived from what's specifically missing or weak in the content.
 *
 * @param {string} stage - Stage name
 * @param {string} content - Artifact content
 * @param {string} contentLower - Lowercase content for matching
 * @param {string} requirement - Original requirement
 * @returns {string[]} Content-aware questions
 */
function _generateContentAwareQuestions(stage, content, contentLower, requirement) {
  // Deprecated in P2:
  // Stage+artifact-aware questions are now generated by core/socratic-challenger.js
  // with externalized socraticChallenge rules from workflow.config.js.
  // Keep this function for backward compatibility with old imports/tests.
  return [];
}

// ─── Health Report ───────────────────────────────────────────────────────────

/**
 * Generate health report from real trace data.
 * Delegates to generate-health-report.js for clean separation of concerns.
 */
async function runHealthReport(args) {
  try {
    const { execFileSync } = require('child_process');
    const reportScriptPath = path.join(__dirname, 'generate-health-report.js');
    const projectRoot = path.resolve(args.projectRoot || '.');
    const paths = _resolveHealthPaths(projectRoot, args.runCategory);
    const { outputDir, runCategory, healthReportPath } = paths;
    const sessionArg = args.session || null;

    const tracePath = path.join(outputDir, 'health', runCategory, 'workflow-trace.jsonl');
    if (!fs.existsSync(tracePath)) {
      return {
        success: false,
        subcommand: 'health-report',
        error: `No trace file found for run-category=${runCategory}`,
      };
    }

    const cmdArgs = [
      reportScriptPath,
      '--output-dir', outputDir,
      '--run-category', runCategory,
      '--project-root', projectRoot,
    ];
    if (sessionArg) cmdArgs.push('--session', sessionArg);

    const stdout = execFileSync(process.execPath, cmdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    }).toString();

    const finalReportPath = path.join(outputDir, 'health', runCategory, 'health-report.md');
    const exists = fs.existsSync(finalReportPath);

    return {
      success: exists,
      subcommand: 'health-report',
      data: {
        reportPath: finalReportPath,
        outputDir,
        runCategoryRequested: runCategory,
        runCategory,
        generated: exists,
        log: stdout.trim(),
      },
      ...(exists ? {} : { error: `Health report was not generated for run-category=${runCategory}` }),
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'health-report',
      error: err.message,
    };
  }
}

// ─── Session Summary ─────────────────────────────────────────────────────────

/**
 * Generate a human-readable session summary (output/session-summary.md).
 * Reads all stage artifacts and the test-report.md to produce a consolidated
 * "what was found / what was fixed / what remains" report visible in IDE.
 *
 * Required args:
 *   --project-root   project root (default: .)
 *
 * Optional args:
 *   --requirement    original requirement text (for title)
 *   --session        session ID
 */
function runSessionSummary(args) {
  try {
    const outputDir = path.resolve(args.projectRoot || '.', 'output');
    const requirement = args.requirement || '(no requirement text)';
    const sessionId   = args.session || 'unknown';
    const now         = new Date().toISOString();

    // ── Read stage artifacts ──────────────────────────────────────────────────
    function readArtifact(name) {
      const p = path.join(outputDir, name);
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf-8').trim();
    }

    const testReport      = readArtifact('test-report.md');
    const analysisContent = readArtifact('analysis.md');
    const archContent     = readArtifact('architecture.md');
    const planContent     = readArtifact('execution-plan.md');
    const diffContent     = readArtifact('code.diff');

    // ── Extract key sections from test-report.md ──────────────────────────────
    function extractSection(content, heading) {
      if (!content) return null;
      const re = new RegExp(`##\\s+${heading}[\\s\\S]*?(?=\\n##\\s|$)`, 'i');
      const m  = content.match(re);
      return m ? m[0].trim() : null;
    }

    const defectsSection      = extractSection(testReport, 'Defects Found');
    const recommendSection    = extractSection(testReport, 'Recommendations');
    const testSummarySection  = extractSection(testReport, 'Test Summary');

    // ── Count changed files from diff ─────────────────────────────────────────
    let changedFiles = 0;
    if (diffContent) {
      const matches = diffContent.match(/^(\+\+\+|---)\s+/gm);
      changedFiles = matches ? Math.floor(matches.length / 2) : 0;
    }

    // ── Build summary markdown ────────────────────────────────────────────────
    const lines = [
      `# 📊 /wf Session Summary`,
      ``,
      `> **Requirement**: ${requirement}`,
      `> **Session**: \`${sessionId}\``,
      `> **Generated**: ${now}`,
      ``,
      `---`,
      ``,
    ];

    // Analysis highlights
    if (analysisContent) {
      const firstLines = analysisContent.split('\n').slice(0, 15).join('\n');
      lines.push(`## 🔍 Analysis Highlights`);
      lines.push(``);
      lines.push(firstLines);
      lines.push(``);
      lines.push(`> 📄 Full analysis: \`output/analysis.md\``);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Architecture highlights
    if (archContent) {
      const firstLines = archContent.split('\n').slice(0, 10).join('\n');
      lines.push(`## 🏗️ Architecture Decisions`);
      lines.push(``);
      lines.push(firstLines);
      lines.push(``);
      lines.push(`> 📄 Full architecture: \`output/architecture.md\``);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Code changes
    if (diffContent) {
      lines.push(`## 💻 Code Changes`);
      lines.push(``);
      if (changedFiles > 0) {
        lines.push(`**${changedFiles} file(s) modified**`);
        lines.push(``);
        // List changed file names
        const fileNames = [];
        const fileRe = /^\+\+\+\s+(?:b\/)?(.+)$/gm;
        let fm;
        while ((fm = fileRe.exec(diffContent)) !== null) {
          fileNames.push(`- \`${fm[1].trim()}\``);
        }
        if (fileNames.length > 0) lines.push(fileNames.join('\n'));
      } else {
        // Show first 30 lines of diff
        lines.push('```diff');
        lines.push(diffContent.split('\n').slice(0, 30).join('\n'));
        lines.push('```');
      }
      lines.push(``);
      lines.push(`> 📄 Full diff: \`output/code.diff\``);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Test summary
    if (testSummarySection) {
      lines.push(`## 🧪 Test Results`);
      lines.push(``);
      lines.push(testSummarySection);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Defects found
    if (defectsSection) {
      lines.push(defectsSection);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Recommendations / remaining issues
    if (recommendSection) {
      lines.push(recommendSection);
      lines.push(``);
      lines.push(`---`);
      lines.push(``);
    }

    // Footer
    lines.push(`## 📁 All Artifacts`);
    lines.push(``);
    lines.push(`| File | Status |`);
    lines.push(`|------|--------|`);
    const artifacts = [
      ['output/analysis.md',       analysisContent],
      ['output/architecture.md',   archContent],
      ['output/execution-plan.md', planContent],
      ['output/code.diff',         diffContent],
      ['output/test-report.md',    testReport],
    ];
    for (const [name, content] of artifacts) {
      const status = content ? '✅ Generated' : '⚠️ Missing';
      lines.push(`| \`${name}\` | ${status} |`);
    }
    lines.push(``);
    lines.push(`> 🏥 Health report (primary): \`output/health/${_normalizeRunCategory(args.runCategory)}/health-report.md\``);
    lines.push(`> ♻️ Compatibility lookup (legacy only): \`output/health-report.md\` or \`workflow/output/health-report.md\``);
    lines.push(``);
    lines.push(`---`);
    lines.push(`_Generated by ide-workflow-bridge session-summary_`);

    // ── Write file ────────────────────────────────────────────────────────────
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const summaryPath = path.join(outputDir, 'session-summary.md');
    fs.writeFileSync(summaryPath, lines.join('\n'), 'utf-8');

    // ── Write health summary to progress log ──────────────────────────────────
    // Compute health summary directly from progress log data for this session.
    // This is IDE-Agent-native: no dependency on health-report.md (Node Orchestrator artifact).
    try {
      const logPath = path.join(outputDir, 'workflow-progress.log');
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, 'utf-8');

        // Parse log into blocks (each block starts with a [timestamp] line)
        // A block contains all lines until the next [timestamp] or EOF
        const blocks = logContent.split(/(?=\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])/)
          .map(b => b.trim())
          .filter(b => b.length > 0);

        // Keep only blocks that contain this sessionId
        const sessionBlocks = blocks.filter(b => b.includes(sessionId));

        // Count completed stages from blocks containing "✅ [N/7] STAGE 阶段完成"
        const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
        const completedStages = stageOrder.filter(s =>
          sessionBlocks.some(b => b.includes('✅') && b.includes(s) && b.includes('阶段完成'))
        );
        const totalStages = 7;
        const completenessOk = completedStages.length === totalStages;

        // Count socratic questions: sum "socratic : N" from all complete blocks
        let totalSocratic = 0;
        const socraticCoveredStages = [];
        for (const stage of completedStages) {
          const stageBlock = sessionBlocks.find(b => b.includes('✅') && b.includes(stage) && b.includes('阶段完成'));
          if (stageBlock) {
            const m = stageBlock.match(/socratic\s*:\s*(\d+)/);
            const count = m ? parseInt(m[1], 10) : 0;
            totalSocratic += count;
            if (count > 0) socraticCoveredStages.push(stage);
          }
        }

        // Count metrics gate failures
        const failedGateStages = completedStages.filter(s => {
          const stageBlock = sessionBlocks.find(b => b.includes('✅') && b.includes(s) && b.includes('阶段完成'));
          return stageBlock && stageBlock.includes('❌ FAILED');
        });

        // Compute health score using the model
        const { computeHealthScore } = require('../core/health-score-model');
        const healthResult = computeHealthScore({
          completenessOk,
          missingStages: stageOrder.filter(s => !completedStages.includes(s)),
          presentStages: completedStages,
          socraticCoveredStages,
          failedGateStages,
          deliveryScore: completenessOk ? 100 : Math.round((completedStages.length / totalStages) * 100),
          detectionScore: totalSocratic > 0 ? Math.min(100, totalSocratic * 4) : 0,
        });

        const gradeEmoji = { A: '🟢', B: '🟡', C: '🟠', D: '🔴', F: '💀' }[healthResult.grade] || '⚪';
        const completeStr = completenessOk ? '✅ PASSED (7/7 stages)' : `⚠️ INCOMPLETE (${completedStages.length}/7 stages)`;

      }
    } catch (healthErr) {
      console.error(`[runSessionSummary] Failed to compute health summary (non-fatal): ${healthErr.message}`);
    }

    return {
      success: true,
      subcommand: 'session-summary',
      data: {
        summaryPath,
        requirement,
        sessionId,
        artifactsFound: artifacts.filter(([, c]) => c !== null).map(([n]) => n),
        artifactsMissing: artifacts.filter(([, c]) => c === null).map(([n]) => n),
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'session-summary',
      error: err.message,
    };
  }
}

// ─── Read-only Explorer ─────────────────────────────────────────────────────

/**
 * Execute dedicated read-only exploration agent.
 * No workflow artifacts are written; output is returned as structured JSON only.
 */
async function runReadOnlyExplore(args) {
  try {
    const { runReadOnlyExploration } = require('../core/read-only-explorer-agent');
    const result = await runReadOnlyExploration({
      projectRoot: args.projectRoot,
      requirement: args.requirement || '',
      noLsp: !!args.noLsp,
      maxFiles: args.maxFiles ? parseInt(args.maxFiles, 10) : null,
    });

    return {
      success: true,
      subcommand: 'read-only-explore',
      data: result,
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'read-only-explore',
      error: err.message,
    };
  }
}

// ─── Run Full Workflow ───────────────────────────────────────────────────────

/**
 * Execute the full sequential workflow pipeline.
 * This is the core entry point that was missing - it creates an Orchestrator
 * and runs the complete ANALYSE → ARCHITECT → PLAN → CODE → TEST pipeline.
 *
 * ⚠️ DEPRECATION WARNING:
 * This command uses a MOCK LLM and does NOT generate meaningful content.
 * It exists only for testing/debugging the orchestrator machinery.
 *
 * For REAL workflow execution in IDE Agent mode:
 *   The IDE Agent IS the LLM — execute each stage yourself using your reasoning + IDE tools.
 *   See AGENTS.md → "/wf <requirement>" section for the correct procedure.
 */
async function runWorkflow(args) {
  const fallbackProjectRoot = path.resolve((args && args.projectRoot) ? args.projectRoot : '.');
  const fallbackRunCategory = 'prod';

  // ─── USAGE INFO ───────────────────────────────────────────────────────────────
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════════════╗');
  console.error('║  📋 WorkFlowAgent Run Command                                        ║');
  console.error('║                                                                      ║');
  console.error('║  Modes:                                                              ║');
  console.error('║  1. IDE Agent Mode (RECOMMENDED):                                    ║');
  console.error('║     --llm-module workflow/tools/ide-llm-adapter.js                   ║');
  console.error('║     IDE Agent responds to [IDE_LLM_REQUEST:<id>] signals via files   ║');
  console.error('║                                                                      ║');
  console.error('║  2. External LLM Mode:                                               ║');
  console.error('║     --llm-module <path-to-your-llm-module.js>                        ║');
  console.error('║     Module must export: { llmCall: async (prompt) => string }        ║');
  console.error('║                                                                      ║');
  console.error('║  3. Mock Mode (testing only):                                        ║');
  console.error('║     No --llm-module flag (generates fake template content)           ║');
  console.error('╚══════════════════════════════════════════════════════════════════════╝');
  console.error('');
  // ────────────────────────────────────────────────────────────────────────────

  try {
    console.error(`[runWorkflow] 🚀 Starting runWorkflow execution...`);
    const { requirement, userInput, projectRoot } = args;

    if (!requirement && !userInput) {
      console.error(`[runWorkflow] ❌ Missing requirement or userInput argument`);
      return {
        success: false,
        subcommand: 'run',
        error: 'Missing required argument: --requirement or --user-input',
        hint: 'Usage: node workflow/tools/ide-workflow-bridge.js run --requirement "your requirement" --project-root .',
      };
    }

    const effectiveRequirementInput = requirement || userInput;
    const absProjectRoot = path.resolve(projectRoot);
    console.error(`[runWorkflow] 📂 Project root resolved to: ${absProjectRoot}`);

    // ── Runtime Policy + Context Budget + Capability Catalog ───────────────
    const { getConfig } = require('../core/config-loader');
    const runConfig = getConfig(absProjectRoot);
    console.error(`[runWorkflow] ⚙️ Config loaded`);

    const policyCheck = enforceRuntimePolicy(effectiveRequirementInput, { config: runConfig || {} });
    if (!policyCheck.ok) {
      console.error(`[runWorkflow] ❌ Runtime policy blocked request`);
      return {
        success: false,
        subcommand: 'run',
        error: `Runtime policy blocked request: ${policyCheck.violations.join(' | ')}`,
        policy: policyCheck,
      };
    }

    const budgetCheck = enforceRequirementBudget(effectiveRequirementInput, runConfig || {});
    const effectiveRequirement = budgetCheck.requirement;
    console.error(`[runWorkflow] ✅ Policy and budget checks passed`);

    const mode = args.llmModule ? 'ide' : 'node';
    const capabilityCatalog = buildCapabilityCatalog({ mode, capabilities: {} });
    const capabilityCatalogPrompt = formatCapabilityCatalogForPrompt(capabilityCatalog);

    // Check if project root exists
    if (!fs.existsSync(absProjectRoot)) {
      console.error(`[runWorkflow] ❌ Project root does not exist: ${absProjectRoot}`);
      return {
        success: false,
        subcommand: 'run',
        error: `Project root does not exist: ${absProjectRoot}`,
      };
    }

    // Import Orchestrator
    console.error(`[runWorkflow] 📦 Importing Orchestrator...`);
    const { Orchestrator } = require('../index.js');
    console.error(`[runWorkflow] ✅ Orchestrator imported`);

    // ── LLM Call Resolution ────────────────────────────────────────────────────
    // Priority:
    //   1. --llm-module <path>: require the module and use its llmCall export
    //   2. WORKFLOW_LLM_MODULE env var: same as above
    //   3. Fallback: mockLlmCall (for testing only)
    let resolvedLlmCall = null;

    const llmModulePath = args.llmModule || process.env.WORKFLOW_LLM_MODULE || '';
    if (llmModulePath) {
      try {
        const absLlmModulePath = path.resolve(llmModulePath);
        const llmModule = require(absLlmModulePath);
        if (typeof llmModule === 'function') {
          resolvedLlmCall = llmModule;
          console.error(`[runWorkflow] ✅ Using external llmCall from module: ${absLlmModulePath}`);
        } else if (typeof llmModule.llmCall === 'function') {
          resolvedLlmCall = llmModule.llmCall;
          console.error(`[runWorkflow] ✅ Using llmCall export from module: ${absLlmModulePath}`);
        } else if (typeof llmModule.createIdeLlmCall === 'function') {
          // ide-llm-adapter.js pattern
          resolvedLlmCall = llmModule.createIdeLlmCall({
            outputDir: path.join(absProjectRoot, 'output'),
            timeoutMs: parseInt(args.llmTimeoutMs || '300000', 10),
          });
          console.error(`[runWorkflow] ✅ Using IDE LLM Adapter (file IPC) from: ${absLlmModulePath}`);
          console.error(`[runWorkflow] 📋 IDE Agent Protocol:`);
          console.error(`[runWorkflow]    1. Watch stderr for [IDE_LLM_REQUEST:<id>]`);
          console.error(`[runWorkflow]    2. Read output/.llm-request-<id>.json`);
          console.error(`[runWorkflow]    3. Generate response using your reasoning`);
          console.error(`[runWorkflow]    4. Write to output/.llm-response-<id>.json`);
          console.error(`[runWorkflow]    5. Orchestrator continues automatically`);
        } else {
          console.error(`[runWorkflow] ⚠️  Module ${absLlmModulePath} does not export a valid llmCall function. Falling back to mockLlmCall.`);
        }
      } catch (moduleErr) {
        console.error(`[runWorkflow] ⚠️  Failed to load llm-module "${llmModulePath}": ${moduleErr.message}. Falling back to mockLlmCall.`);
      }
    }

    // Create mock LLM call function for testing (fallback only)
    // In production, use --llm-module workflow/tools/ide-llm-adapter.js
    const mockLlmCall = async (prompt) => {
      console.error('[runWorkflow] ⚠️  Warning: Using mock LLM call - no real LLM connected');
      console.error('[runWorkflow] 📝 Generating mock content based on prompt type...');

      // Defensive: Handle undefined/null/empty prompt
      if (!prompt || typeof prompt !== 'string') {
        console.error('[runWorkflow] ⚠️  Prompt is empty or invalid, returning default mock content');
        return `# Generated Output

## Summary
This is a mock-generated response.

## Details
The prompt was empty or invalid, so default content is returned.

## Next Steps
1. Ensure the prompt is correctly passed
2. Connect a real LLM for actual content generation
`;
      }

      // Analyze prompt to determine what type of content to generate
      const promptLower = prompt.toLowerCase();

      // Test Case Generation output (TestCaseGenerator prompt – must return JSON block)
      // IMPORTANT: This check must come BEFORE the 'requirement' check because
      // TestCaseGenerator injects requirement.md content into its prompt, which would
      // otherwise trigger the requirement branch and return non-JSON content.
      if (promptLower.includes('boris beizer') || (promptLower.includes('test case') && promptLower.includes('json') && promptLower.includes('automation_type') && promptLower.includes('case_id') && !promptLower.includes('tester agent') && !promptLower.includes('test report'))) {
        return `\`\`\`json
[
  {
    "case_id": "TC_CORE_001",
    "title": "Verify core functionality works with valid input",
    "precondition": "System is running and accessible",
    "steps": [
      "Prepare valid input data",
      "Invoke the target function with valid input",
      "Observe the output"
    ],
    "expected": "Function returns expected result without errors",
    "test_data": {"input": "valid_value", "expected_output": "processed_result"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_CORE_002",
    "title": "Verify error handling when input is null",
    "precondition": "System is running and accessible",
    "steps": [
      "Invoke the target function with null input",
      "Observe the error response"
    ],
    "expected": "Function throws Error with message 'Invalid input' or returns null-safe fallback",
    "test_data": {"input": null},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_CORE_003",
    "title": "Verify boundary condition at minimum valid value",
    "precondition": "System is running and accessible",
    "steps": [
      "Invoke the target function with minimum boundary value",
      "Observe the output"
    ],
    "expected": "Function processes minimum value correctly without overflow or underflow",
    "test_data": {"input": 0, "boundary": "min"},
    "automation_type": "auto"
  },
  {
    "case_id": "TC_CORE_004",
    "title": "Verify rejection of malformed input (error guessing)",
    "precondition": "System is running and accessible",
    "steps": [
      "Invoke the target function with malformed/special-character input",
      "Observe the validation response"
    ],
    "expected": "Function rejects input and returns validation error message",
    "test_data": {"input": "<script>alert('xss')</script>"},
    "automation_type": "auto"
  }
]
\`\`\`

## Acceptance Criteria Coverage Matrix

| Requirement / Criterion | Test Case IDs | Coverage Status |
|------------------------|---------------|-----------------|
| AC-001: Core functionality works with valid input | TC_CORE_001 | ✅ Covered |
| AC-002: Null/empty input is handled gracefully | TC_CORE_002 | ✅ Covered |
| AC-003: Boundary values are processed correctly | TC_CORE_003 | ✅ Covered |
| AC-004: Malformed input is rejected with clear error | TC_CORE_004 | ✅ Covered |
`;
      }

      // Requirement Analysis output
      if (promptLower.includes('requirement') || promptLower.includes('需求分析') || promptLower.includes('analyse')) {
        return `# Requirement Analysis

## Overview
This document analyzes the requirement for the requested feature implementation.

## User Stories
- As a user, I want to be able to use the feature effectively
- As a developer, I want clear specifications to implement

## Functional Requirements
1. Core functionality must work as expected
2. User interface must be intuitive
3. Error handling must be robust

## Non-Functional Requirements
- Performance: Response time < 200ms
- Security: Input validation required
- Compatibility: Support major browsers

## Constraints
- Must integrate with existing system
- Must follow coding standards

## Assumptions
- Users have basic technical knowledge
- System is available 99.9% of the time

## Open Questions
- What are the specific edge cases to handle?
- What is the expected user load?
`;
      }

      // Architecture Design output
      if (promptLower.includes('architecture') || promptLower.includes('design') || promptLower.includes('架构')) {
        return `# Architecture Design

## System Overview
This document describes the architecture for the feature implementation.

## Component Diagram
\`\`\`
┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Backend   │
└─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Database   │
                    └─────────────┘
\`\`\`

## Components
### Frontend Module
- **Responsibility**: User interface and interaction
- **Technology**: React/Vue.js
- **Interface**: REST API calls to backend

### Backend Module
- **Responsibility**: Business logic and data processing
- **Technology**: Node.js/Python
- **Interface**: REST API endpoints

### Database Layer
- **Responsibility**: Data persistence
- **Technology**: PostgreSQL/MongoDB
- **Schema**: Defined in data model section

## Design Decisions
1. **Separation of Concerns**: Each module has clear responsibility
2. **API-First Design**: Backend exposes REST API
3. **Stateless Architecture**: Scalable and maintainable

## Risks and Mitigations
- Risk: Performance bottleneck → Mitigation: Caching strategy
- Risk: Security vulnerability → Mitigation: Input validation and authentication
`;
      }

      // Implementation Plan output
      if (promptLower.includes('plan') || promptLower.includes('task') || promptLower.includes('implementation')) {
        return `# Implementation Plan

## Phase 1: Setup and Foundation
- **Duration**: 2 days
- **Tasks**:
  1. Set up project structure
  2. Configure development environment
  3. Create base components

## Phase 2: Core Development
- **Duration**: 5 days
- **Tasks**:
  1. Implement backend API endpoints
  2. Create database schema
  3. Build frontend components
  4. Integrate components

## Phase 3: Testing and Validation
- **Duration**: 2 days
- **Tasks**:
  1. Write unit tests
  2. Perform integration testing
  3. Conduct code review

## Phase 4: Deployment
- **Duration**: 1 day
- **Tasks**:
  1. Prepare deployment scripts
  2. Deploy to staging environment
  3. Verify production readiness

## Dependencies
- Backend API must be ready before frontend integration
- Database schema must be finalized before implementation

## Milestones
- [ ] M1: Project setup complete
- [ ] M2: Backend API functional
- [ ] M3: Frontend integrated
- [ ] M4: Tests passing
- [ ] M5: Deployed to production
`;
      }

      // Code Implementation output
      if (promptLower.includes('code') || promptLower.includes('implement') || promptLower.includes('function')) {
        return `# Code Implementation

## File Structure
\`\`\`
src/
├── index.js          # Entry point
├── api/
│   └── routes.js     # API routes
├── services/
│   └── main.js       # Business logic
└── utils/
    └── helpers.js    # Utility functions
\`\`\`

## Implementation Details

### index.js
\`\`\`javascript
const express = require('express');
const app = express();

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

module.exports = app;
\`\`\`

### services/main.js
\`\`\`javascript
class MainService {
  async processData(data) {
    // Validate input
    if (!data) throw new Error('Invalid input');
    
    // Process data
    const result = await this.transform(data);
    
    return result;
  }
  
  async transform(data) {
    return { ...data, processed: true };
  }
}

module.exports = MainService;
\`\`\`

## Notes
- All functions include error handling
- Code follows project conventions
- Unit tests are included
`;
      }

      // Test Report output (TesterAgent prompt)
      if (promptLower.includes('test') || promptLower.includes('spec') || promptLower.includes('verify')) {
        return `# Test Report

## Test Summary
- **Total Tests**: 4
- **Passed**: 4
- **Failed**: 0
- **Blocked**: 0
- **Coverage**: 92%

## Test Cases

### Unit Tests
| Test | Status | Duration |
|------|--------|----------|
| TC_CORE_001: Core functionality valid input | ✅ Pass | 12ms |
| TC_CORE_002: Null input error handling | ✅ Pass | 5ms |
| TC_CORE_003: Boundary condition minimum value | ✅ Pass | 8ms |
| TC_CORE_004: Malformed input rejection | ✅ Pass | 6ms |

## Defects Found
No defects found. All test cases passed successfully.

| Defect ID | Severity | Description | Status |
|-----------|----------|-------------|--------|
| – | – | No defects detected | – |

## Coverage Report
- Statements: 92%
- Branches: 88%
- Functions: 95%
- Lines: 91%

## Recommendations
1. Add performance tests for high-load scenarios
2. Expand boundary value tests for edge cases beyond min/max
3. Consider adding integration tests for cross-module interactions
`;
      }

      // Default: Generic structured output
      return `# Generated Output

## Summary
This is a mock-generated response for the given prompt.

## Details
The prompt requested analysis or generation of content related to the feature.

## Key Points
1. First important point about the request
2. Second important consideration
3. Third aspect to note

## Recommendations
- Consider the context carefully
- Review all requirements
- Validate assumptions

## Next Steps
1. Review this output
2. Connect a real LLM for actual content generation
3. Configure llmCall parameter for production use
`;
    };

    // Create Orchestrator instance
    const outputDir = path.join(absProjectRoot, 'output');
    
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Use resolved llmCall (from --llm-module) or fall back to mockLlmCall
    const effectiveLlmCall = resolvedLlmCall || mockLlmCall;
    if (!resolvedLlmCall) {
      console.error('[runWorkflow] ⚠️  No --llm-module specified. Using mockLlmCall (fake content).');
      console.error('[runWorkflow] 💡 For real IDE Agent execution, use:');
      console.error('[runWorkflow]    --llm-module workflow/tools/ide-llm-adapter.js');
    }
    
    const runCategoryRequested = args.runCategory || 'prod';

    // P0: /wf normal workflow must always run in production category.
    // Test/diagnostic categories should be triggered by dedicated sub-commands
    // (e.g. test-execute), not by the unified /wf run entry.
    const runCategory = 'prod';
    const resolvedHealthPaths = _resolveHealthPaths(absProjectRoot, runCategory);

    const orchestrator = new Orchestrator({
      projectId: `ide-bridge-${Date.now()}`,
      projectRoot: absProjectRoot,
      outputDir: outputDir,
      runCategory,
      llmCall: effectiveLlmCall,
      llmSource: resolvedLlmCall ? 'external' : 'mock',
    });

    // Execute the workflow
    console.error(`[runWorkflow] Starting full workflow for requirement: ${effectiveRequirement.slice(0, 100)}...`);
    if (runCategoryRequested !== 'prod') {
      console.error(`[runWorkflow] ⚠️ Ignoring non-prod run-category for unified run: requested=${runCategoryRequested}, forced=prod`);
    }
    console.error(`[runWorkflow] 🧭 runCategory requested/resolved: ${runCategoryRequested} → ${runCategory}`);
    console.error(`[runWorkflow] 📁 trace: ${resolvedHealthPaths.tracePath}`);
    console.error(`[runWorkflow] 📄 report: ${resolvedHealthPaths.healthReportPath}`);

    const startTime = Date.now();
    console.error(`[runWorkflow][WORKFLOW_START] runCategory=${runCategory} ts=${new Date().toISOString()}`);
    const result = await orchestrator.run(effectiveRequirement, {
      userInput: args.userInput || null,
      attachedImages: args.attachedImages || null,
    });
    const duration = Date.now() - startTime;
    console.error(`[runWorkflow][WORKFLOW_END] status=success durationMs=${duration} ts=${new Date().toISOString()}`);

    // Ensure health-report is always generated after /wf run (IDE Bridge path).
    // Even if orchestrator already generated one, this is idempotent and guarantees freshness.
    const healthReportResult = await runHealthReport({
      projectRoot: absProjectRoot,
      runCategory,
      session: result?.healthMonitoring?.sessionId || null,
    });

    return {
      success: result.success,
      subcommand: 'run',
      data: {
        requirement: effectiveRequirement.slice(0, 200),
        projectRoot: absProjectRoot,
        runCategoryRequested,
        runCategoryResolved: runCategory,
        runCategory,
        healthPaths: {
          tracePath: resolvedHealthPaths.tracePath,
          healthReportPath: resolvedHealthPaths.healthReportPath,
          qualityReportPath: resolvedHealthPaths.qualityReportPath,
          evolutionLogPath: resolvedHealthPaths.evolutionLogPath,
          healthHistoryPath: resolvedHealthPaths.healthHistoryPath,
        },
        duration: `${(duration / 1000).toFixed(2)}s`,
        stages: result.stages,
        totalDuration: result.totalDuration,
        pipeline: 'ANALYSE → ARCHITECT → PLAN → CODE → TEST',
        taskIntent: result.taskIntent || { intent: 'full' },
        smartSkip: result.smartSkip || { skippedStages: [], executedStages: [] },
        acceptance: result.acceptance || null,
        runtimePolicy: result.runtimePolicy || policyCheck,
        contextBudget: result.contextBudget || { requirement: budgetCheck },
        capabilityCatalog: result.capabilityCatalog || capabilityCatalog,
        capabilityCatalogPrompt: result.capabilityCatalogPrompt || capabilityCatalogPrompt,
        healthReport: healthReportResult.success ? healthReportResult.data : { generated: false, error: healthReportResult.error || 'unknown error' },
      },
    };
  } catch (err) {
    console.error(`[runWorkflow] Error: ${err.message}`);
    console.error(err.stack);

    let failureHealthReport = null;
    try {
      const healthResult = await runHealthReport({
        projectRoot: fallbackProjectRoot,
        runCategory: fallbackRunCategory,
      });
      if (healthResult && healthResult.success) {
        failureHealthReport = healthResult.data;
        console.error('[runWorkflow] 🏥 Health report refreshed from failure path.');
      }
    } catch (healthErr) {
      console.error(`[runWorkflow] ⚠️ Failed to refresh health report on failure path: ${healthErr.message}`);
    }

    console.error(`[runWorkflow][WORKFLOW_END] status=failed ts=${new Date().toISOString()} reason=${err.message}`);
    return {
      success: false,
      subcommand: 'run',
      error: err.message,
      stack: err.stack,
      data: {
        failureHealthReport,
      },
    };
  }
}

// ─── Help ────────────────────────────────────────────────────────────────────

function printHelp() {
  return {
    success: true,
    subcommand: 'help',
    data: {
      description: 'IDE Workflow Bridge — Access full workflow capabilities from IDE Agent mode',
      subcommands: {
        'triage': {
          description: 'RequestTriage complexity assessment + routing recommendation',
          args: '--requirement <text> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js triage --requirement "Build a REST API" --project-root .',
        },
        'context': {
          description: 'ContextLoader skill/ADR/doc injection for a given stage',
          args: '--stage <ANALYSE|ARCHITECT|PLAN|CODE|TEST> --task <text> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js context --stage ANALYSE --task "user authentication" --project-root .',
        },
        'experience-search': {
          description: 'Search ExperienceStore by keyword/skill/tags',
          args: '[--keyword <text>] [--skill <name>] [--type POSITIVE|NEGATIVE] [--tags <t1,t2>] [--limit <n>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-search --keyword "auth" --skill "security-audit"',
        },
        'experience-context': {
          description: 'Get experience context block (proven patterns + known pitfalls)',
          args: '--skill <name> [--task <text>] [--limit <n>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-context --skill "code-development" --task "refactor auth"',
        },
        'experience-record': {
          description: 'Record a new experience with content-based dedup',
          args: '--type POSITIVE|NEGATIVE --category <cat> --title <text> --content <text> [--skill <name>] [--tags <t1,t2>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-record --type POSITIVE --category stable_pattern --title "JWT best practice" --content "Always validate..."',
        },
        'staleness-check': {
          description: 'Check if project artifacts are outdated',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js staleness-check --project-root .',
        },
        'quality-check': {
          description: 'Run local quality checks on specified files',
          args: '--files <file1.js,file2.js> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js quality-check --files "src/a.js,src/b.js" --project-root .',
        },
        'build-agent-prompt': {
          description: 'Build role-specific Agent prompt prefix + constraints (Agent Role Isolation)',
          args: '--role <analyst|architect|planner|developer|tester|coding-agent|init-agent> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js build-agent-prompt --role analyst --project-root .',
        },
        'rollback-check': {
          description: 'Validate stage output against downstream Agent input contracts (Auto-Rollback)',
          args: '--stage <ANALYSE|ARCHITECT|PLAN|CODE> [--files <output-file>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js rollback-check --stage ARCHITECT --project-root .',
        },
        'quality-gate': {
          description: 'Run full QualityGate threshold validation (same as MCP orchestrator)',
          args: '[--error-count <n>] [--test-pass-rate <0-1>] [--duration-ms <ms>] [--llm-calls <n>] [--token-waste <0-1>] [--diagnostic-mode] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js quality-gate --error-count 2 --test-pass-rate 0.85 --duration-ms 120000 --diagnostic-mode --project-root .',
        },
        'experience-evolve': {
          description: 'Trigger experience evolution: purge expired, distill similar, analyze duplicates, check layer health',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-evolve --project-root .',
        },
        'deep-audit': {
          description: 'Run DeepAuditOrchestrator across all 7 dimensions (zero LLM cost)',
          args: '[--dimension <logic|config|function|coupling|architecture|performance|knowledge>] [--verbose] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js deep-audit --project-root .',
        },
        'experience-health': {
          description: 'Run comprehensive experience store health checks (layer, capacity, evolution activity)',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-health --project-root .',
        },
        'mape-analysis': {
          description: 'Run MAPE Monitor+Analyze+Plan cycle (zero LLM, file-based signal collection)',
          args: '[--dry-run] [--max-actions <n>] [--verbose] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js mape-analysis --project-root .',
        },
        'regression-check': {
          description: 'Run RegressionGuard baseline comparison (quality delta tracking)',
          args: '[--verbose] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js regression-check --project-root .',
        },
        'skill-refine-check': {
          description: 'Identify skills needing refinement/fix/enrichment (candidates for IDE Agent LLM)',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js skill-refine-check --project-root .',
        },
        'contract-check': {
          description: 'Validate core module interface contracts (IExperienceStore, ICodeGraph, etc.)',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js contract-check --project-root .',
        },
        'skill-discover': {
          description: 'Auto-discover project conventions from config files (zero LLM, rule-scan)',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js skill-discover --project-root .',
        },
        'experience-transfer': {
          description: 'Cross-project experience discovery, export, and import',
          args: '--action <discover|publish|import|registry-summary> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js experience-transfer --action discover --project-root .',
        },
        'task-history': {
          description: 'Cross-session task recall memory (record/recall/stats)',
          args: '--action <record|recall|stats> [--goal <text>] [--outcome <success|partial|failed>] [--limit <n>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js task-history --action recall --project-root .',
        },
        'arch-cache': {
          description: 'Architecture Knowledge Cache: rebuild, query distilled summary, capability index',
          args: '--action <rebuild|summary|task-history-summary|capability-index> [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js arch-cache --action rebuild --project-root .',
        },
        'execution-validate': {
          description: 'Run ExecutionLogValidator to check execution completeness and score',
          args: '[--verbose] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js execution-validate --project-root .',
        },
        'prompt-optimize': {
          description: 'Analyze feedback history and generate prompt optimization suggestions',
          args: '[--dry-run] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js prompt-optimize --project-root .',
        },
        'session-score': {
          description: 'Score session output quality + signal detection (experience capture decision)',
          args: '[--artifact-content <text>] [--verbose] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js session-score --project-root .',
        },
        'scheduler-check': {
          description: 'Check for overdue scheduled tasks at session start (replaces background scheduler)',
          args: '[--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js scheduler-check --project-root .',
        },
        'degrade-output': {
          description: 'GDE L1: Attempt graceful degradation of LLM output (structural repair + field filling)',
          args: '--role <role> --artifact-content <text> [--task <text>]',
          example: 'node workflow/tools/ide-workflow-bridge.js degrade-output --role architect --artifact-content "..."',
        },
        'degrade-check': {
          description: 'GDE L1: Quick check if output needs degradation',
          args: '--role <role> --artifact-content <text>',
          example: 'node workflow/tools/ide-workflow-bridge.js degrade-check --role developer --artifact-content "..."',
        },
        'inject-expert': {
          description: 'EKIC: Inject expert knowledge (inline text or from file)',
          args: '--title <name> --content <text> [--role <role>] [--type <high|medium|low>] [--tags <t1,t2>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js inject-expert --title "API Rules" --content "All APIs must..." --project-root .',
        },
        'list-experts': {
          description: 'EKIC: List all registered expert knowledge entries',
          args: '[--role <role>] [--type <priority>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js list-experts --role developer --project-root .',
        },
        'expert-block': {
          description: 'EKIC: Get formatted expert knowledge block for a role + task',
          args: '--role <role> [--task <text>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js expert-block --role architect --task "Design API" --project-root .',
        },
        'expert-generate': {
          description: 'EKIC: Generate expert knowledge from source files (requires LLM)',
          args: '--files <file1,file2> [--role <role>] [--type <priority>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js expert-generate --files "src/api.js,src/config.js" --project-root .',
        },
        'test-execute': {
          description: 'Run actual tests and return structured results with pass/fail metrics',
          args: '[--test-command <cmd>] [--timeout <ms>] [--test-pattern <pattern>] [--test-profile <fast|full>] [--test-suites <s1,s2>] [--test-files <f1,f2>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js test-execute --test-profile fast --test-suites smoke,unit --project-root .',
        },
        'workflow-stage': {
          description: 'Execute a single workflow stage with context injection (ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST)',
          args: '--stage <STAGE> [--task <text>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js workflow-stage --stage DEVELOP --task "Add user auth" --project-root .',
        },
        'read-only-explore': {
          description: 'Run dedicated read-only exploration agent (no artifact writes)',
          args: '[--requirement <text>] [--project-root <dir>] [--no-lsp] [--max-files <N>]',
          example: 'node workflow/tools/ide-workflow-bridge.js read-only-explore --project-root . --no-lsp',
        },
        'skill-evolve': {
          description: 'Explicitly trigger skill evolution for a specific skill',
          args: '--skill-name <name> [--reason <text>] [--metadata <json>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js skill-evolve --skill-name "error-handling-nodejs" --reason "Updated patterns" --project-root .',
        },
        'skill-update': {
          description: 'Manually update skill metadata or content',
          args: '--skill-name <name> [--content <text>] [--title <text>] [--tags <t1,t2>] [--project-root <dir>]',
          example: 'node workflow/tools/ide-workflow-bridge.js skill-update --skill-name "test-writing-jest" --title "Updated Jest Best Practices" --project-root .',
        },
        'skill-ablation': {
          description: 'Run Skill Ablation Test to quantify per-skill ROI (effectiveness, token cost, contribution)',
          args: '[--project-root <dir>] [--min-usage <n>] [--format json|markdown]',
          example: 'node workflow/tools/ide-workflow-bridge.js skill-ablation --project-root . --format markdown',
        },
        'failure-pattern-analyze': {
          description: 'Analyze recent failures and generate Skill proposals (EvoSkill)',
          args: '[--project-root <dir>] [--enable-llm] [--min-occurrence <n>] [--export]',
          example: 'node workflow/tools/ide-workflow-bridge.js failure-pattern-analyze --project-root . --enable-llm --export',
        },
        'issue-pattern-collect': {
          description: 'Collect and record issue patterns (orphan modules, broken routes) to ExperienceStore',
          args: '[--project-root <dir>] [--severity <level>] [--flush]',
          example: 'node workflow/tools/ide-workflow-bridge.js issue-pattern-collect --project-root . --flush',
        },
      },
    },
  };
}

// ─── Sub-command: test-execute ───────────────────────────────────────────────

/**
 * Test Execution Command — Run actual tests and return structured results.
 * Provides real test data (pass/fail counts) to feed into quality-gate.
 *
 * Inspired by:
 *   - TestRunner class in workflow/core/test-runner.js
 *   - pytest, Jest, Vitest, Mocha auto-detection pattern
 *
 * Why: quality-gate needs real test-pass-rate, not simulated values.
 */
function runTestExecute(args) {
  try {
    const { TestRunner } = require('../core/test-runner');
    let { projectRoot, testCommand, timeout, testPattern, testProfile, testSuites, testFiles } = args;

    // Normalize timeout
    const timeoutMs = parseInt(timeout, 10) || 120000;

    // Auto-detect test command if not provided
    if (!testCommand) {
      const detected = _detectTestCommand(projectRoot);
      if (detected) {
        testCommand = detected;
      } else {
        return {
          success: false,
          subcommand: 'test-execute',
          error: 'No test command detected. Provide --test-command or ensure package.json/scripts/test exists.',
        };
      }
    }

    // P0: profile support (fast/full) for unified test runner
    const normalizedProfile = String(testProfile || '').toLowerCase().trim();
    if ((normalizedProfile === 'fast' || normalizedProfile === 'full') && !testPattern) {
      if (/run-all-tests\.js/.test(testCommand) && !/--profile=/.test(testCommand)) {
        testCommand += ` --profile=${normalizedProfile}`;
      } else if (/^npm\s+test\b/.test(testCommand)) {
        const candidateRunner = path.join(projectRoot, 'workflow', 'tests', 'run-all-tests.js');
        if (require('fs').existsSync(candidateRunner)) {
          testCommand = `node workflow/tests/run-all-tests.js --profile=${normalizedProfile}`;
        }
      }
    }

    const usesUnifiedRunner = /run-all-tests\.js/.test(testCommand);

    if (usesUnifiedRunner && testSuites) {
      testCommand += ` --suites=${testSuites}`;
    }
    if (usesUnifiedRunner && testFiles) {
      testCommand += ` --files=${testFiles}`;
    }

    // Add test pattern if specified
    if (testPattern) {
      testCommand += ` ${testPattern}`;
    }

    const runner = new TestRunner({
      projectRoot,
      testCommand,
      timeoutMs,
      verbose: false, // Bridge output should be clean JSON
    });

    const startMs = Date.now();
    const result = runner.run();
    const durationMs = Date.now() - startMs;

    // Calculate metrics for quality-gate
    const totalTests = result.totalTests || 0;
    const failedTests = result.failedTests || 0;
    const passedTests = totalTests - failedTests;
    const passRate = totalTests > 0 ? passedTests / totalTests : 0;

    return {
      success: true,
      subcommand: 'test-execute',
      data: {
        passed: result.passed,
        exitCode: result.exitCode,
        totalTests,
        passedTests,
        failedTests,
        passRate: Number(passRate.toFixed(4)),
        durationMs: result.durationMs || durationMs,
        command: result.command,
        testProfile: normalizedProfile || null,
        failureSummary: result.failureSummary || [],
        output: result.output?.slice(0, 5000), // Truncate for JSON size
        qualityGateMetrics: {
          testPassRate: passRate,
          errorCount: failedTests,
        },
        recommendation: result.passed
          ? 'Tests passed. Proceed to quality-gate for threshold validation.'
          : `Tests failed. Review failureSummary and fix issues before proceeding.`,
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'test-execute',
      error: err.message,
    };
  }
}

/**
 * Auto-detect test command from project files.
 * Supports: npm, yarn, pnpm, poetry, pipenv, pytest, go test.
 */
function _detectTestCommand(projectRoot) {
  const fs = require('fs');
  const path = require('path');

  // Check for Node.js projects
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.scripts?.test) {
        // Detect package manager
        if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm test';
        if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn test';
        return 'npm test';
      }
    } catch (_) { /* ignore */ }
  }

  // Check for Python projects
  if (fs.existsSync(path.join(projectRoot, 'pytest.ini')) ||
      fs.existsSync(path.join(projectRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(projectRoot, 'setup.py'))) {
    // Check for poetry
    if (fs.existsSync(path.join(projectRoot, 'poetry.lock'))) return 'poetry run pytest';
    // Check for pipenv
    if (fs.existsSync(path.join(projectRoot, 'Pipfile.lock'))) return 'pipenv run pytest';
    return 'pytest';
  }

  // Check for Go projects
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
    return 'go test ./...';
  }

  // Check for Rust projects
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
    return 'cargo test';
  }

  // Check for Java/Maven projects
  if (fs.existsSync(path.join(projectRoot, 'pom.xml'))) {
    return 'mvn test';
  }

  // Check for Gradle projects
  if (fs.existsSync(path.join(projectRoot, 'build.gradle')) ||
      fs.existsSync(path.join(projectRoot, 'build.gradle.kts'))) {
    return './gradlew test';
  }

  return null;
}

// ─── Sub-command: workflow-stage ─────────────────────────────────────────────

/**
 * Workflow Stage Execution — Run a single workflow stage (ANALYSE, ARCHITECT,
 * PLAN, DEVELOP, TEST) with proper context injection and output capture.
 *
 * Why: build-agent-prompt generates prompts, but workflow-stage actually
 * executes the stage and returns structured output.
 */
async function runWorkflowStage(args) {
  try {
    const stage = args.stage?.toUpperCase();
    const validStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
    console.error(`[runWorkflowStage][STAGE_START] stage=${stage || 'UNKNOWN'} ts=${new Date().toISOString()}`);

    if (!stage || !validStages.includes(stage)) {
      return {
        success: false,
        subcommand: 'workflow-stage',
        error: `Invalid or missing stage. Valid: ${validStages.join(', ')}`,
      };
    }

    // ── P0: Cross-Stage Dependency Gate (Devin pattern — hard block) ──
    // Validates that all required input artifacts exist before starting this stage.
    // This prevents stage-skipping: ARCHITECT cannot start without analysis.md, etc.
    // Industry reference: Devin's task dependency checker blocks execution if deps missing.
    {
      const projectRoot = args.projectRoot || '.';
      const depCheck = _validateStageDependencies(stage, projectRoot);
      if (!depCheck.valid) {
        console.error(`[runWorkflowStage] ❌ DEPENDENCY GATE (FATAL): ${depCheck.error}`);
        return {
          success: false,
          subcommand: 'workflow-stage',
          error: depCheck.error,
          MANDATORY_FIX: {
            instruction: depCheck.fixInstruction,
            missingDeps: depCheck.missingDeps,
            requiredStage: depCheck.requiredStage,
            enforcement: 'HARD — cannot start this stage until all dependencies are satisfied',
          },
        };
      }
      if (!depCheck.skipped) {
        console.error(`[runWorkflowStage] ✅ Dependency gate passed for stage=${stage}: ${(depCheck.depsChecked || []).join(', ')}`);
      }
    }

    // ── P0: Auto-write stage_start trace (code-enforced, not LLM-dependent) ──
    // This is the core of Plan B: trace writing is guaranteed by code, not by
    // the LLM remembering to call trace-append. IDE Agent only needs to call
    // workflow-stage and stage-complete — trace is handled automatically.
    const traceStartResult = runTraceAppend({
      projectRoot: args.projectRoot || '.',
      event: 'stage_start',
      session: args.session || '',
      seq: args.seq || '1',
      stage,
      requirement: args.requirement || '',
      stageInput: args.stageInput || `Starting ${stage} stage`,
      runCategory: args.runCategory || '',
    });
    const sessionId = traceStartResult.data?.session || traceStartResult.data?.sessionId || args.session || '';
    console.error(`[runWorkflowStage] stage_start trace written. session=${sessionId} traceSuccess=${traceStartResult.success}`);

    // ── P0-STARTUP-2: Lightweight init for IDE Agent mode ──────────────────
    // Node Orchestrator mode calls _initWorkflow() which runs 14+ init steps
    // (Experience preheat, Skill Discovery, MCP adapters, etc.). IDE Agent mode
    // previously had NO equivalent — every stage was a cold start. This block
    // runs a lightweight subset of _initWorkflow on the first ANALYSE stage to
    // ensure cross-session learning (ExperienceStore) and project conventions
    // (Skill Discovery) are available. Non-blocking: failures are logged but
    // never block stage execution. Dual-mode parity per ADR-37.
    if (stage === 'ANALYSE') {
      const _ideInitMarker = path.join(
        (args.projectRoot || process.cwd()),
        '.workflow', 'ide-init-done.json'
      );
      let _ideInitNeeded = true;
      try {
        if (fs.existsSync(_ideInitMarker)) {
          const marker = JSON.parse(fs.readFileSync(_ideInitMarker, 'utf-8'));
          // Re-init if marker is older than 1 hour (stale project state)
          const markerAge = Date.now() - (marker.timestamp || 0);
          _ideInitNeeded = markerAge > 3600000;
        }
      } catch (_) { /* malformed marker — re-init */ }

      if (_ideInitNeeded) {
        console.error(`[runWorkflowStage] 🔧 IDE lightweight init starting (first ANALYSE)...`);
        const _ideInitStart = Date.now();

        // (a) Experience preheat — inject seed experiences if store is empty
        try {
          if (_bridgeExpStore) {
            const stats = _bridgeExpStore.getStats();
            if (stats.total < 3) {
              const { preheatExperienceStore } = require('../core/context-budget-manager');
              const techStack = _detectTechStackLite(args.projectRoot);
              preheatExperienceStore(
                { experienceStore: _bridgeExpStore, projectRoot: args.projectRoot, _rawLlmCall: null },
                { techStack, projectType: 'auto' }
              ).then(r => {
                if (r && r.success && r.seeded > 0) {
                  console.error(`[runWorkflowStage] 🌱 IDE Experience preheat: ${r.seeded} seed(s) injected`);
                }
              }).catch(e => console.error(`[runWorkflowStage] ⚠️ IDE Experience preheat failed (non-fatal): ${e.message}`));
            }
          }
        } catch (e) { console.error(`[runWorkflowStage] ⚠️ IDE Experience preheat skipped: ${e.message}`); }

        // (b) Skill Discovery — auto-discover project conventions (rule-based, zero LLM)
        try {
          const { SkillEvolutionEngine } = require('../core/skill-evolution-engine');
          const _skillEvo = new SkillEvolutionEngine({ projectRoot: args.projectRoot || process.cwd() });
          const { discoverProjectSkills } = require('../core/skill-discovery');
          discoverProjectSkills({
            projectRoot: args.projectRoot || process.cwd(),
            skillEvolution: _skillEvo,
            llmCall: null,
            cheapLlmCall: null,
            force: false,
          }).then(result => {
            if (result.discovered) {
              console.error(`[runWorkflowStage] 🔍 IDE Skill Discovery: "${result.skillName}" (${result.signalCount} signals)`);
            }
          }).catch(e => console.error(`[runWorkflowStage] ⚠️ IDE Skill Discovery failed (non-fatal): ${e.message}`));
        } catch (e) { console.error(`[runWorkflowStage] ⚠️ IDE Skill Discovery skipped: ${e.message}`); }

        // (c) MCP adapters — connect external tool adapters if registry exists
        try {
          const mcpRegistryPath = path.join(args.projectRoot || process.cwd(), '.workflow', 'mcp-registry.json');
          if (fs.existsSync(mcpRegistryPath)) {
            // MCP connection is best-effort; IDE Agent has native tools as primary
            console.error(`[runWorkflowStage] ℹ️ MCP registry detected — IDE Agent uses native tools as primary (ADR-37)`);
          }
        } catch (_) { /* non-fatal */ }

        // Write marker to avoid re-init on subsequent stages
        try {
          const markerDir = path.dirname(_ideInitMarker);
          if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
          fs.writeFileSync(_ideInitMarker, JSON.stringify({
            timestamp: Date.now(),
            steps: ['experiencePreheat', 'skillDiscovery'],
          }, null, 2));
        } catch (_) { /* non-fatal */ }

        console.error(`[runWorkflowStage] 🔧 IDE lightweight init done in ${Date.now() - _ideInitStart}ms`);
      }
    }

    // Map stage to role
    const stageToRole = {
      ANALYSE: 'analyst',
      ARCHITECT: 'architect',
      PLAN: 'planner',
      DEVELOP: 'developer',
      TEST: 'tester',
      REVIEW: 'reviewer',
      DEPLOY: 'developer',
    };
    const role = stageToRole[stage] || 'developer';

    // Build context for the stage using ContextLoader directly
    const ContextLoader = require('../core/context-loader').ContextLoader;
    // ADR-55: inject ExperienceStore for Prevention Rule injection (MemGPT retrieval pattern)
    let _bridgeExpStore = null;
    try {
      const { ExperienceStore } = require('../core/experience-store');
      _bridgeExpStore = new ExperienceStore({ projectRoot: args.projectRoot || process.cwd() });
    } catch (_) { /* non-fatal */ }
    const loader = new ContextLoader({
      workflowRoot: path.resolve(path.join(__dirname, '..')),
      projectRoot: args.projectRoot,
      experienceStore: _bridgeExpStore,  // ADR-55
    });

    const taskText = args.task || '';
    let contextData;

    try {
      const { sections, tokenCount, sources } = loader.resolve(taskText, role);
      contextData = {
        sections: (sections || []).map((s, i) => ({
          index: i,
          source: sources?.[i] || 'unknown',
          content: s?.length > 3000 ? s.slice(0, 3000) + '\n... (truncated)' : s,
        })),
        tokenCount,
        sources,
      };
    } catch (ctxErr) {
      // Context loading is optional for workflow-stage
      contextData = {
        sections: [],
        tokenCount: 0,
        sources: [],
        error: ctxErr.message,
      };
    }

    // Build agent prompt for the stage
    const promptResult = runBuildAgentPrompt({
      projectRoot: args.projectRoot,
      role,
    });

    // Determine output file path
    const outputDir = path.join(args.projectRoot, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputFileName = _stageToOutputFile(stage);
    const outputPath = path.join(outputDir, outputFileName);

    // Check for existing input artifacts
    const inputArtifacts = _getInputArtifactsForStage(stage, args.projectRoot);

    // ── F4: Load previous stage decisions (Structured Decision Summary) ──────
    // Industry reference: Kiro's artifact chain + OpenCode's Plan→Build context.
    // Instead of just listing file paths, inject actual semantic decisions from
    // previous stages so the current stage has meaningful context without re-reading
    // entire artifacts. This eliminates the "cold start" problem.
    //
    // P1-1 fix: Also read stage-context.json (produced by Node mode's StageContextStore)
    // for richer upstream context (summary + keyDecisions + risks + correctionHistory).
    // This bridges the information gap between Node mode and IDE Bridge mode.
    let previousStageDecisions = [];
    let stageContextData = null;

    // ── F4-REQ: Requirement-change guard ──
    // Before loading ANY cross-stage context, check if the requirement has changed.
    // If it has, the context files were produced for a different problem and MUST
    // NOT be loaded — they would pollute the new workflow with irrelevant decisions.
    let _requirementChanged = false;
    try {
      const _statusFP = path.join(args.projectRoot || '.', 'output', 'workflow-status.json');
      if (fs.existsSync(_statusFP)) {
        const _sd = JSON.parse(fs.readFileSync(_statusFP, 'utf-8'));
        const _storedFp = _sd?.activeWorkflow?.requirementFingerprint || '';
        const _currentFp = _requirementFingerprint(args.requirement || '');
        if (_currentFp && _storedFp && _currentFp !== _storedFp) {
          _requirementChanged = true;
          console.error(`[runWorkflowStage] ⏭️ F4-REQ: Skipping cross-stage context — requirement changed (stored fp=${_storedFp.slice(0, 40)}, current fp=${_currentFp.slice(0, 40)})`);
        }
      }
    } catch (_) { /* non-fatal: proceed with loading if check fails */ }

    if (!_requirementChanged) {
    try {
      // ── Source 1: stage-decisions.json (Bridge-native, regex-extracted) ──
      const decisionsPath = path.join(args.projectRoot || '.', 'output', 'stage-decisions.json');
      if (fs.existsSync(decisionsPath)) {
        const allDecisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf-8'));
        const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
        const currentIdx = stageOrder.indexOf(stage);
        // Collect decisions from all previous stages
        for (const prevStage of stageOrder.slice(0, currentIdx)) {
          if (allDecisions[prevStage]?.decisions?.length > 0) {
            previousStageDecisions.push({
              stage: prevStage,
              decisions: allDecisions[prevStage].decisions,
            });
          }
        }
        if (previousStageDecisions.length > 0) {
          console.error(`[runWorkflowStage] ✅ F4: Loaded decisions from ${previousStageDecisions.length} previous stage(s)`);
        }
      }

      // ── Source 2: stage-context.json (Node mode StageContextStore, richer) ──
      // Contains summary + keyDecisions + risks + correctionHistory + meta.
      // If available and not stale, merge into previousStageDecisions
      // to provide downstream agents with richer upstream context.
      const stageCtxPath = path.join(args.projectRoot || '.', 'output', 'stage-context.json');
      if (fs.existsSync(stageCtxPath)) {
        const rawCtx = JSON.parse(fs.readFileSync(stageCtxPath, 'utf-8'));
        // P2-2 fix: Read stageContextMaxAgeHours from workflow.config.js (default: 24h).
        // Different projects have different iteration speeds — fast projects may
        // want 4-8h, long-cycle projects may want 48-72h.
        let _stageCtxMaxAgeHours = 24;
        try {
          const _cfgPath = path.join(args.projectRoot || '.', 'workflow.config.js');
          if (fs.existsSync(_cfgPath)) {
            const _cfg = require(_cfgPath);
            if (typeof _cfg.stageContextMaxAgeHours === 'number' && _cfg.stageContextMaxAgeHours > 0) {
              _stageCtxMaxAgeHours = _cfg.stageContextMaxAgeHours;
            }
          }
        } catch (_) { /* non-fatal: use default 24h */ }
        const MAX_AGE_MS = _stageCtxMaxAgeHours * 60 * 60 * 1000;
        const now = Date.now();
        const timestamps = Object.values(rawCtx)
          .map(e => e.timestamp ? new Date(e.timestamp).getTime() : 0)
          .filter(t => t > 0);
        const mostRecent = timestamps.length > 0 ? Math.max(...timestamps) : 0;
        const isStale = mostRecent > 0 && (now - mostRecent) > MAX_AGE_MS;

        if (!isStale) {
          stageContextData = rawCtx;
          // Merge richer context into previousStageDecisions
          const stageNameMap = { ANALYSE: 'ANALYSE', ARCHITECT: 'ARCHITECT', PLAN: 'PLAN', CODE: 'DEVELOP', TEST: 'TEST' };
          for (const [ctxStage, ctx] of Object.entries(rawCtx)) {
            const bridgeStage = stageNameMap[ctxStage] || ctxStage;
            const existing = previousStageDecisions.find(d => d.stage === bridgeStage);
            if (existing) {
              // Enrich existing entry with StageContextStore data
              if (ctx.summary && !existing.summary) existing.summary = ctx.summary;
              if (ctx.risks?.length > 0 && !existing.risks) existing.risks = ctx.risks;
              if (ctx.correctionHistory?.length > 0 && !existing.correctionHistory) existing.correctionHistory = ctx.correctionHistory;
            } else if (ctx.keyDecisions?.length > 0 || ctx.summary) {
              // Add new entry from StageContextStore
              previousStageDecisions.push({
                stage: bridgeStage,
                decisions: ctx.keyDecisions || [],
                summary: ctx.summary || '',
                risks: ctx.risks || [],
                correctionHistory: ctx.correctionHistory || [],
                source: 'stage-context.json',
              });
            }
          }
          console.error(`[runWorkflowStage] ✅ F4+: Enriched with stage-context.json (${Object.keys(rawCtx).length} stage(s))`);
        } else {
          console.error(`[runWorkflowStage] ⏭️ stage-context.json is stale (${Math.round((now - mostRecent) / 3600000)}h old), skipping`);
        }
      }
    } catch (decErr) {
      console.error(`[runWorkflowStage] ⚠️ F4 decision loading failed (non-fatal): ${decErr.message}`);
    }
    } // end if (!_requirementChanged)

    console.error(`[runWorkflowStage][STAGE_END] stage=${stage} status=success ts=${new Date().toISOString()}`);

    // ── Write human-readable progress log ──
    const stageOrderAll = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
    const stageIdx = stageOrderAll.indexOf(stage);
    const stageNum = stageIdx + 1;
    const inputArtifactsSummary = inputArtifacts.map(a => `${a.file}(${a.exists ? '✓' : '✗'})`).join(', ');
    // Include user input if provided (--task or --user-input)
    const userInputText = args.userInput || args.task || '';
    const userInputLine = userInputText
      ? `  user     : ${userInputText.length > 120 ? userInputText.slice(0, 120) + '...' : userInputText}`
      : null;
    // For ANALYSE stage (first stage), write requirement as a SEPARATE log entry BEFORE the stage-start log
    const requirementText = args.requirement || '';
    if (stage === 'ANALYSE' && requirementText) {
      _writeProgressLog(args.projectRoot || '.', [
        `📋 用户需求`,
        `  session  : ${sessionId}`,
        `  req      : ${requirementText.length > 300 ? requirementText.slice(0, 300) + '...' : requirementText}`,
      ].join('\n'));
    }
    _writeProgressLog(args.projectRoot || '.', [
      `▶ [${stageNum}/7] ${stage} 阶段开始`,
      `  session  : ${sessionId}`,
      `  output   : ${outputPath}`,
      `  inputs   : ${inputArtifactsSummary || 'none'}`,
      userInputLine,
    ].filter(Boolean).join('\n'));

    // ── Write activeWorkflow to workflow-status.json (Hook Enhancement 1.1) ──
    // This state is read by PreToolUse Guard and Stop Guard hooks to enforce workflow execution.
    // - PreToolUse: blocks non-workflow Bash commands during active workflow
    // - Stop Guard: prevents LLM from stopping mid-workflow
    // TTL: 2 hours — auto-expires to prevent stale state from blocking future sessions.
    const statusFilePath = path.join(args.projectRoot || '.', 'output', 'workflow-status.json');
    try {
      let statusData = {};
      if (fs.existsSync(statusFilePath)) {
        try { statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf-8')); } catch { statusData = {}; }
      }
      const stageOrderForActive = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
      const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

      // ── BUGFIX: TTL expiry auto-cleanup ──
      // If the previous activeWorkflow's TTL has expired, treat it as stale
      // and clear both activeWorkflow and pendingRetry to prevent zombie state.
      if (statusData.activeWorkflow && statusData.activeWorkflow.ttlExpiry) {
        const ttlExpired = new Date(statusData.activeWorkflow.ttlExpiry) < new Date();
        if (ttlExpired && statusData.activeWorkflow.session !== sessionId) {
          console.error(`[runWorkflowStage] 🧹 TTL expired for session=${statusData.activeWorkflow.session} (expired at ${statusData.activeWorkflow.ttlExpiry}). Clearing stale state.`);
          delete statusData.activeWorkflow;
          if (statusData.pendingRetry) {
            console.error(`[runWorkflowStage] 🧹 Clearing stale pendingRetry for stage=${statusData.pendingRetry.stage} (belonged to expired session)`);
            delete statusData.pendingRetry;
          }
        }
      }

      if (!statusData.activeWorkflow || statusData.activeWorkflow.session !== sessionId) {
        // First stage or new session — create activeWorkflow
        // BUGFIX: Also clear pendingRetry from previous session to prevent cross-session contamination
        if (statusData.pendingRetry && statusData.activeWorkflow && statusData.activeWorkflow.session !== sessionId) {
          console.error(`[runWorkflowStage] 🧹 Clearing pendingRetry from previous session (stage=${statusData.pendingRetry.stage})`);
          delete statusData.pendingRetry;
        }
        statusData.activeWorkflow = {
          session: sessionId,
          startedAt: new Date().toISOString(),
          currentStage: stage,
          completedStages: [],
          requirement: (args.requirement || '').slice(0, 300),
          requirementFingerprint: _requirementFingerprint(args.requirement || ''),
          ttlExpiry: new Date(Date.now() + TTL_MS).toISOString(),
        };
      } else {
        // Existing session — update currentStage and check for requirement change
        statusData.activeWorkflow.currentStage = stage;
        // Requirement change detection: if the current requirement differs from what's stored,
        // the cross-stage context is stale and must be reset.
        const currentFp = _requirementFingerprint(args.requirement || '');
        const storedFp = statusData.activeWorkflow.requirementFingerprint || '';
        if (currentFp && storedFp && currentFp !== storedFp) {
          console.error(`[runWorkflowStage] 🔄 Requirement changed mid-session — resetting cross-stage context`);
          console.error(`[runWorkflowStage]    stored fp: ${storedFp}`);
          console.error(`[runWorkflowStage]    current fp: ${currentFp}`);
          let resetCount = 0;
          const filesToReset = [
            path.join(args.projectRoot || '.', 'output', 'stage-context.json'),
            path.join(args.projectRoot || '.', 'output', 'stage-decisions.json'),
            path.join(args.projectRoot || '.', 'output', 'decisions.json'),
          ];
          for (const f of filesToReset) {
            if (fs.existsSync(f)) {
              try {
                fs.unlinkSync(f);
                resetCount++;
                console.error(`[runWorkflowStage]    🗑️ Deleted ${path.basename(f)}`);
              } catch (e) { /* non-fatal */ }
            }
          }
          // Reset completedStages so the pipeline starts from scratch
          statusData.activeWorkflow.completedStages = [];
          statusData.activeWorkflow.requirement = (args.requirement || '').slice(0, 300);
          statusData.activeWorkflow.requirementFingerprint = currentFp;
          statusData.activeWorkflow.startedAt = new Date().toISOString();
          console.error(`[runWorkflowStage] 🧹 Requirement change: ${resetCount} file(s) deleted, completedStages reset`);
        }
      }
      fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
      console.error(`[runWorkflowStage] ✅ activeWorkflow written: session=${sessionId} stage=${stage}`);
    } catch (activeWfErr) {
      console.error(`[runWorkflowStage] ⚠️ Failed to write activeWorkflow (non-fatal): ${activeWfErr.message}`);
    }

    // ── Read pendingRetry from workflow-status.json (set by runStageComplete on RETRY_STAGE) ──
    // If pendingRetry exists for this stage, inject socratic questions into instructions
    // so LLM has the full context of WHY it needs to redo and WHAT to fix.
    // After reading, clear pendingRetry to avoid stale state on next call.
    // BUGFIX: Also clear pendingRetry from a different session (cross-session contamination).
    let pendingRetryContext = null;
    try {
      if (fs.existsSync(statusFilePath)) {
        const statusRaw = fs.readFileSync(statusFilePath, 'utf-8');
        const statusData = JSON.parse(statusRaw);
        if (statusData.pendingRetry) {
          const retrySession = statusData.pendingRetry.session;
          const sameStage = statusData.pendingRetry.stage === stage;
          const sameSession = !retrySession || retrySession === sessionId;
          if (sameStage && sameSession) {
            // Normal case: same session, same stage — inject retry context
            pendingRetryContext = statusData.pendingRetry;
            delete statusData.pendingRetry;
            fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
            console.error(`[runWorkflowStage] 🔁 RETRY context injected for stage=${stage} retryCount=${pendingRetryContext.retryCount}`);
          } else if (!sameSession) {
            // Cross-session contamination: clear stale pendingRetry from different session
            console.error(`[runWorkflowStage] 🧹 Clearing stale pendingRetry from session=${retrySession || 'unknown'} (current=${sessionId}, stage=${statusData.pendingRetry.stage})`);
            delete statusData.pendingRetry;
            fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
          }
          // If same session but different stage, leave pendingRetry alone — it will be
          // picked up when the correct stage is re-run
        }
      }
    } catch (statusErr) {
      console.error(`[runWorkflowStage] Failed to read/clear pendingRetry (non-fatal): ${statusErr.message}`);
    }

    // ── TEST Stage: Auto-Execute Tests (Code-Enforced, Not LLM-Decided) ────────
    // ROOT CAUSE FIX: In IDE Agent mode, the TEST stage previously only told the LLM
    // "MUST actually run the test suite" (soft prompt), but never gave it a concrete
    // command or real test results. The LLM would write test-report.md from memory,
    // producing a "hallucinated" test report with no real execution evidence.
    //
    // FIX: Auto-execute `test-execute` HERE (code-enforced), then inject the REAL
    // test results into instructions. The LLM's job becomes "format the real results
    // into test-report.md", not "decide whether to run tests".
    //
    // Industry reference: Agentless (SWE-bench SOTA) — test execution is code-enforced,
    // not agent-decided. Claude Code agentic loop — always runs tests, never describes them.
    // Node Orchestrator mode parity: stage-tester.js calls TestRunner.run() automatically.
    let autoTestResult = null;
    if (stage === 'TEST') {
      try {
        console.error(`[runWorkflowStage] 🧪 TEST stage: auto-executing test suite (code-enforced)...`);
        const testArgs = {
          projectRoot: args.projectRoot || '.',
          testProfile: 'fast',
        };
        // Read testCommand from workflow.config.js if available
        try {
          const { getConfig } = require('../core/config-loader');
          const cfg = getConfig();
          if (cfg.testCommand) testArgs.testCommand = cfg.testCommand;
          if (cfg.testProfile) testArgs.testProfile = cfg.testProfile;
        } catch (_) { /* use auto-detect */ }

        autoTestResult = runTestExecute(testArgs);
        if (autoTestResult.success) {
          const d = autoTestResult.data;
          console.error(`[runWorkflowStage] 🧪 Test execution complete: ${d.passedTests}/${d.totalTests} passed (${d.passed ? 'PASS' : 'FAIL'})`);
        } else {
          console.error(`[runWorkflowStage] ⚠️ Test execution failed (non-fatal): ${autoTestResult.error}`);
        }
      } catch (testErr) {
        console.error(`[runWorkflowStage] ⚠️ Test auto-execution error (non-fatal): ${testErr.message}`);
      }
    }

    // Build instructions — inject retry context if present
    const baseInstructions = [
      `Execute the ${stage} stage using the provided context and prompt.`,
      `Write output to: ${outputPath}`,
      // F4: Inject previous stage decisions as semantic context
      ...(previousStageDecisions.length > 0 ? [
        ``,
        `📋 KEY DECISIONS FROM PREVIOUS STAGES (use as context, do not repeat):`,
        ...previousStageDecisions.flatMap(({ stage: prevStage, decisions }) => [
          `  [${prevStage}]:`,
          ...decisions.map(d => `    • ${d}`),
        ]),
        ``,
      ] : []),
      // ── TEST Stage: Inject real test results ──────────────────────────────────
      // The test suite has ALREADY been executed above. The LLM's job is to:
      // 1. Format the real results into test-report.md
      // 2. Analyze any failures (root cause, not just symptoms)
      // 3. Verify that the DEVELOP stage changes are covered by tests
      ...(stage === 'TEST' && autoTestResult?.success ? [
        ``,
        `🧪 ═══════════════════════════════════════════════════════`,
        `🧪  TEST SUITE ALREADY EXECUTED (results below)`,
        `🧪  Your job: write test-report.md based on these REAL results`,
        `🧪  DO NOT re-run tests. DO NOT fabricate results.`,
        `🧪 ═══════════════════════════════════════════════════════`,
        ``,
        `  Command  : ${autoTestResult.data.command || 'npm test'}`,
        `  Status   : ${autoTestResult.data.passed ? '✅ PASSED' : '❌ FAILED'}`,
        `  Results  : ${autoTestResult.data.passedTests}/${autoTestResult.data.totalTests} tests passed`,
        `  Duration : ${autoTestResult.data.durationMs}ms`,
        `  Profile  : ${autoTestResult.data.testProfile || 'default'}`,
        ...(autoTestResult.data.failureSummary?.length > 0 ? [
          ``,
          `  Failures:`,
          ...autoTestResult.data.failureSummary.slice(0, 20).map(f => `    - ${f}`),
        ] : []),
        ...(autoTestResult.data.output ? [
          ``,
          `  Raw Output (truncated):`,
          `  \`\`\``,
          `  ${autoTestResult.data.output.slice(0, 3000)}`,
          `  \`\`\``,
        ] : []),
        ``,
        `🧪 ═══════════════════════════════════════════════════════`,
        `🧪  REQUIRED in test-report.md:`,
        `🧪  1. Include the EXACT pass/fail counts from above`,
        `🧪  2. If failures exist: analyze root cause of each failure`,
        `🧪  3. Verify DEVELOP changes are covered by passing tests`,
        `🧪  4. Include the test command used: ${autoTestResult.data.command || 'npm test'}`,
        `🧪 ═══════════════════════════════════════════════════════`,
        ``,
      ] : stage === 'TEST' && autoTestResult && !autoTestResult.success ? [
        ``,
        `⚠️ Test auto-execution failed: ${autoTestResult.error}`,
        `You MUST run the test suite manually using terminal:`,
        `  node workflow/tools/ide-workflow-bridge.js test-execute --project-root .`,
        `Then include the REAL output in test-report.md.`,
        ``,
      ] : stage === 'TEST' ? [
        ``,
        `⚠️ Test auto-execution was not available.`,
        `You MUST run the test suite manually using terminal:`,
        `  node workflow/tools/ide-workflow-bridge.js test-execute --project-root .`,
        `Then include the REAL output in test-report.md.`,
        `DO NOT write test-report.md from memory — it will be REJECTED.`,
        ``,
      ] : []),
      stage === 'ANALYSE' ? [
        ``,
        `⚠️ ANALYSE output schema for ${outputPath} (CRITICAL — write ONLY these sections):`,
        `  ## 根因 / Root Cause       — What is the real problem? (evidence-backed)`,
        `  ## 受影响位置               — Which files/modules/lines are affected?`,
        `  ## 修改范围                 — What needs to change? (file | location | change)`,
        `  ## 风险评估                 — What could go wrong? (P0/P1/P2 severity)`,
        `❌ NO generic templates: User Stories / Functional Requirements / Acceptance Criteria`,
        `❌ NO Socratic dimension list — use the 11 dimensions as internal thinking only`,
        `✅ Socratic thinking MUST happen internally — output conclusions, NOT the dimension list`,
      ].join('\n') : null,
      `After completing ALL work for this stage, call stage-complete to finalize:`,
      `  node workflow/tools/ide-workflow-bridge.js stage-complete --stage ${stage} --session ${sessionId} --project-root . --summary "<1-2 sentence summary of what was done>"`,
    ].filter(Boolean);

    let retryInstructions = [];
    if (pendingRetryContext) {
      retryInstructions = [
        ``,
        `⚠️ ═══════════════════════════════════════════════════════`,
        `⚠️  RETRY #${pendingRetryContext.retryCount} — Previous ${stage} output was rejected by Socratic review`,
        `⚠️  Confidence was too low (${pendingRetryContext.confidence != null ? Math.round(pendingRetryContext.confidence * 100) + '%' : 'N/A'})`,
        `⚠️  You MUST address ALL of the following before rewriting:`,
        `⚠️ ═══════════════════════════════════════════════════════`,
        ...(pendingRetryContext.questions || []).map((q, i) => `  Q${i + 1}: ${q}`),
        ...(pendingRetryContext.blindSpots?.length ? [
          ``,
          `⚠️  BLIND SPOTS detected (root causes, not symptoms):`,
          ...(pendingRetryContext.blindSpots || []).map((b, i) => `  BS${i + 1}: ${b}`),
        ] : []),
        ...(pendingRetryContext.triggerReasons?.length ? [
          ``,
          `⚠️  Trigger reasons: ${pendingRetryContext.triggerReasons.join('; ')}`,
        ] : []),
        `⚠️ ═══════════════════════════════════════════════════════`,
        `⚠️  REQUIRED STEPS:`,
        `  1. Answer each question above in your thinking (not in output)`,
        `  2. Rewrite the ${stage} artifact at ${outputPath} with improvements`,
        `  3. Then call stage-complete as usual`,
        `⚠️ ═══════════════════════════════════════════════════════`,
      ];
    }

    return {
      success: true,
      subcommand: 'workflow-stage',
      // ── P1: REQUIRED_OBSERVATION (SWE-agent Observation Loop pattern) ──
      // LLM MUST read and act on this observation before calling stage-complete.
      // stage-complete will verify the artifact matches these expectations.
      // Industry reference: SWE-agent's ACI forces LLM to process tool output before next action.
      REQUIRED_OBSERVATION: {
        outputPath,
        requiredSchema: ARTIFACT_SCHEMA[stage] || null,
        instruction: ARTIFACT_SCHEMA[stage]
          ? `After completing work, verify output/${ARTIFACT_SCHEMA[stage].file} contains ALL required sections: ${(ARTIFACT_SCHEMA[stage].requiredSections || []).join(', ')}. Then call stage-complete.`
          : `After completing work, call stage-complete.`,
        verificationNote: 'stage-complete will HARD-REJECT if artifact is missing or does not contain required sections.',
        // ── ADR-37 Evidence Gate — Mandatory IDE Tool Usage ──────────────────────
        // stage-complete now mechanically verifies that the artifact contains evidence
        // of real IDE tool calls (file paths, line numbers, code references).
        // Writing from LLM memory alone will trigger [EVIDENCE_MISSING] rejection.
        // This is NOT a prompt suggestion — it is a code-enforced gate.
        adr37Enforcement: ARTIFACT_SCHEMA[stage]?.evidencePatterns ? {
          mandatory: true,
          enforcement: 'HARD — stage-complete will reject artifact if no IDE tool evidence found',
          requiredActions: stage === 'ANALYSE' ? [
            '1. MUST call codebase_search to find relevant code before writing analysis.md',
            '2. MUST call grep_search to locate specific patterns/functions',
            '3. MUST include real file paths (e.g. workflow/core/foo.js) in ## 受影响位置',
            '4. MUST include line numbers or function names from search results in ## 根因',
            '5. analysis.md written without IDE tool evidence will be REJECTED',
          ] : stage === 'ARCHITECT' ? [
            '1. MUST call codebase_search to understand existing architecture',
            '2. MUST reference actual module files by their real paths in architecture.md',
            '3. architecture.md written without file references will be REJECTED',
          ] : stage === 'PLAN' ? [
            '1. MUST identify exact files to modify via grep_search or codebase_search',
            '2. MUST include real file paths in execution-plan.md tasks',
            '3. execution-plan.md without concrete file paths will be REJECTED',
          ] : stage === 'TEST' ? [
            '1. MUST actually run the test suite (not describe what tests should do)',
            '2. MUST include real test output (pass/fail counts, error messages)',
            '3. test-report.md without actual test results will be REJECTED',
          ] : [
            '1. MUST use IDE tools (codebase_search/grep_search/view_code_item) before writing artifact',
            '2. Include concrete evidence (file paths, line numbers, code references) in artifact',
          ],
          evidencePatternCount: ARTIFACT_SCHEMA[stage]?.evidenceMinMatches || 1,
          crossStageContext: inputArtifacts.filter(a => a.exists).map(a => ({
            file: a.file,
            stage: a.stage,
            note: `Read this artifact to understand previous stage conclusions before starting ${stage}`,
          })),
        } : null,
        // ── Pre-Stage Socratic Injection (Self-Ask pattern) ──────────────────────
        // Industry reference:
        //   - Self-Ask (Press et al. 2022): decompose task into sub-questions BEFORE acting
        //   - ReAct (Yao et al. 2022): Reason → Act, never Act without prior Reason
        //   - Anthropic "think" tool: explicit thinking space before execution
        //   - Claude Extended Thinking: deep reasoning before generating output
        //
        // These questions are NOT generic templates — each targets the most common
        // failure modes for this specific stage. Answer ALL in <thinking> before
        // writing the artifact. This is a SOFT enforcement (thinking-space injection),
        // not a hard gate, but skipping it will produce lower-quality output.
        preStageThinking: _generatePreStageQuestions(stage, args.requirement || ''),
      },
      data: {
        stage,
        role,
        sessionId,
        outputPath,
        contextInjected: contextData.sections,
        promptSummary: promptResult.success && promptResult.data?.role
          ? `Built prompt for ${promptResult.data.role}`
          : (promptResult.error || 'No prompt built'),
        inputArtifacts,
        previousStageDecisions,  // F4: Semantic context from previous stages
        autoTestResult: stage === 'TEST' ? (autoTestResult || null) : undefined,  // TEST stage: real test execution results
        traceWritten: traceStartResult.success,
        isRetry: !!pendingRetryContext,
        retryCount: pendingRetryContext?.retryCount || 0,
        instructions: [...baseInstructions, ...retryInstructions],
        sessionGuardActive: {
          active: true,
          message: `Session ${sessionId} is now being tracked by the ANTI-SKIP GUARD. stage-complete will HARD-REJECT if workflow-stage was not called first for stage=${stage}.`,
          antiSkipGuardLocation: 'ide-workflow-bridge.js lines 5447-5486',
          enforcement: 'MACHINE-ENFORCED — cannot be bypassed by prompt or reasoning',
        },
      },
    };
  } catch (err) {
    console.error(`[runWorkflowStage][STAGE_END] status=failed ts=${new Date().toISOString()} reason=${err.message}`);
    return {
      success: false,
      subcommand: 'workflow-stage',
      error: err.message,
    };
  }
}

/**
 * F4: Extract key decisions from a stage artifact.
 * Produces 3-5 concise decision summaries that capture the most important
 * conclusions, choices, and findings from the stage output.
 *
 * Industry reference: Kiro's artifact chain + OpenCode's structured task cards.
 * Each decision is one sentence, actionable, and carries forward to next stage.
 *
 * @param {string} stage - Stage name (e.g. 'ANALYSE')
 * @param {string} content - Artifact content
 * @returns {string[]} Array of key decision strings (max 5)
 */
function _extractKeyDecisions(stage, content) {
  const decisions = [];

  // P1-1 fix: Try JSON block extraction first (same as Node mode's StageContextStore.extractFromFile).
  // This unifies the extraction logic between Node and Bridge modes.
  try {
    const { extractJsonBlock, extractKeyDecisions: extractStructuredDecisions } = require('../core/agent-output-schema');
    const jsonBlock = extractJsonBlock(content);
    if (jsonBlock) {
      const structured = extractStructuredDecisions(jsonBlock);
      if (structured && structured.length > 0) {
        return structured.slice(0, 5);
      }
    }
  } catch (extractErr) {
    // P2-1 fix: Log the fallback reason so developers can diagnose why
    // JSON block extraction failed. Silent fallback makes debugging hard.
    console.error(`[_extractKeyDecisions] ⚠️ JSON block extraction unavailable, falling back to regex: ${extractErr.message}`);
  }

  const lines = content.split('\n');

  // Strategy 1: Extract from headings + first substantive line under each heading
  const headingPattern = /^#{1,3}\s+(.+)/;
  for (let i = 0; i < lines.length && decisions.length < 5; i++) {
    const hMatch = lines[i].match(headingPattern);
    if (hMatch) {
      const heading = hMatch[1].trim();
      // Find first non-empty, non-heading line after this heading
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const line = lines[j].trim();
        if (line && !line.startsWith('#') && line.length > 20) {
          // Clean up markdown formatting
          const clean = line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim();
          if (clean.length > 15 && clean.length < 200) {
            decisions.push(`[${heading}] ${clean}`);
          }
          break;
        }
      }
    }
  }

  // Strategy 2: Extract explicit decision/conclusion markers
  const decisionPatterns = [
    /(?:决定|选择|采用|结论|recommendation|decision|chose|selected|concluded)[：:]\s*(.{20,150})/gi,
    /(?:根因|root cause|核心问题)[：:]\s*(.{20,150})/gi,
    /(?:方案|approach|solution|strategy)[：:]\s*(.{20,150})/gi,
  ];
  for (const pattern of decisionPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null && decisions.length < 5) {
      const decision = match[1].trim().replace(/\*\*/g, '');
      if (!decisions.some(d => d.includes(decision.slice(0, 30)))) {
        decisions.push(decision);
      }
    }
  }

  // Deduplicate and cap at 5
  const unique = [...new Set(decisions)].slice(0, 5);

  // If no decisions extracted, generate a minimal summary from content length and headings
  if (unique.length === 0) {
    const headings = lines.filter(l => /^#{1,3}\s+/.test(l)).map(l => l.replace(/^#+\s+/, '').trim());
    if (headings.length > 0) {
      unique.push(`Artifact covers: ${headings.slice(0, 5).join(', ')}`);
    }
  }

  return unique;
}

/**
 * Count how many times a stage has been retried in the current session.
 * Reads stage_retry trace events from the trace file.
 * Used by runStageComplete to enforce maxRetry cap and prevent infinite loops.
 *
 * @param {string} tracePath - Path to workflow-trace.jsonl
 * @param {string} stage - Stage name (e.g. 'ANALYSE')
 * @param {string} session - Session ID
 * @returns {number} Number of retries already recorded (0 if none)
 */
function _getStageRetryCount(tracePath, stage, session) {
  try {
    if (!fs.existsSync(tracePath)) return 0;
    const lines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(l => l.trim());
    return lines.filter(line => {
      try {
        const ev = JSON.parse(line);
        return ev.event === 'stage_retry' && ev.stage === stage && ev.session === session;
      } catch { return false; }
    }).length;
  } catch {
    return 0;
  }
}

// ─── P2: Trajectory Self-Correction (SWE-agent trajectory replay pattern) ────
// Reads the most recent N trace events for a session and returns a summary.
// Used to inject execution history into failure responses so LLM can self-correct.
// Industry reference: SWE-agent records thought+action+observation trajectory;
// on failure, the trajectory is replayed into context for self-correction.
function _getRecentTrace(tracePath, session, maxEvents = 5) {
  try {
    if (!fs.existsSync(tracePath)) return [];
    const lines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(l => l.trim());
    const sessionEvents = lines
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(ev => ev && ev.session === session)
      .slice(-maxEvents);
    return sessionEvents.map(ev => ({
      ts: ev.ts,
      event: ev.event,
      stage: ev.stage,
      summary: ev.summary || ev.stageInput || ev.stageOutput || '',
    }));
  } catch {
    return [];
  }
}

// ─── Pre-Stage Socratic Question Generator ───────────────────────────────────
/**
 * Generate stage-specific Socratic questions to inject into REQUIRED_OBSERVATION
 * BEFORE the LLM starts working on the artifact.
 *
 * Design principles (from industry research):
 *   - Self-Ask (Press et al. 2022): decompose task into sub-questions before acting
 *   - ReAct (Yao et al. 2022): Reason → Act, never Act without prior Reason
 *   - Anthropic "think" tool: explicit thinking space before execution
 *
 * Each question targets a specific failure mode for that stage.
 * Questions are NOT generic — they are calibrated to prevent the most common
 * mistakes LLMs make at each stage of a software engineering workflow.
 *
 * @param {string} stage - Workflow stage (ANALYSE, ARCHITECT, PLAN, DEVELOP, TEST, REVIEW, DEPLOY)
 * @param {string} requirement - The user's requirement text (used for context-aware questions)
 * @returns {object} preStageThinking object with questions and instructions
 */
function _generatePreStageQuestions(stage, requirement) {
  // Truncate requirement for inline injection — long enough to be specific, short enough to not dominate
  const req = requirement ? requirement.slice(0, 150) : '';
  const reqCtx = req ? `（针对需求："${req}"）` : '';

  // ── Pre-Stage Socratic Questions ──────────────────────────────────────────
  // Design principles (from first principles, not templates):
  //   1. Self-Ask (Press et al. 2022): decompose task into sub-questions BEFORE acting
  //   2. ReAct (Yao et al. 2022): Reason → Act, never Act without prior explicit Reason
  //   3. CoVe (Dhuliawala 2023): generate verification questions → self-answer → revise
  //   4. Anthropic Extended Thinking: <thinking> space for deep reasoning before output
  //
  // Each question targets ONE specific failure mode for this stage.
  // Questions are in Chinese to maximize LLM attention weight in Chinese-context sessions.
  // The requirement is injected inline so LLM reasons about the SPECIFIC task, not generics.
  //
  // Question design rules:
  //   - Answerable in <thinking> without external info (no "go check X first")
  //   - Answer directly changes what goes into the artifact
  //   - Targets the #1 failure mode for that slot, not a generic checklist item
  //   - Q5 is always FIRST_PRINCIPLES check (ADR-55 Rev.2 meta-dimension)
  const questionsByStage = {
    ANALYSE: [
      // Failure mode 1: 把症状当根因 — 最常见的分析失误
      `【根因 vs 症状】${reqCtx} 你识别的"根因"是真正的原因，还是症状的描述？请用"因为X导致Y，因为Y导致Z"的因果链验证：你找到的是X还是Z？`,
      // Failure mode 2: 凭记忆写分析，没有实际搜索代码
      `【代码证据】你是否已经用 grep_search/codebase_search 在代码库中找到了问题的实际位置？请列出：具体文件路径 + 行号/函数名。如果还没搜索，现在必须先搜索再写分析。`,
      // Failure mode 3: 低估影响范围，遗漏上下游
      `【影响范围】${reqCtx} 受影响的代码被哪些其他模块调用或依赖？这次变更是否会破坏上游或下游的现有行为？`,
      // Failure mode 4: 在分析阶段就开始设计方案（越权）
      `【阶段边界】你的 analysis.md 是在描述"问题是什么"，还是已经在描述"怎么解决"？ANALYSE 阶段只诊断，不开处方。如果你写了解决方案，删掉它。`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】${reqCtx} 你的根因结论是从你实际读到的代码推导出来的，还是从经验/模式匹配猜测的？什么证据可以证伪你的假设？`,
    ],
    ARCHITECT: [
      // Failure mode 1: 过度设计，引入不必要的抽象层
      `【最小化原则】${reqCtx} 这个设计引入了哪些新的抽象层？每个抽象层消除了什么具体的复杂度？能否用更简单的改动达到同样目标？`,
      // Failure mode 2: 忽视代码库现有模式，引入不一致
      `【一致性检查】代码库中类似问题是如何解决的？你的设计是否遵循了相同的模式？如果不一致，理由是什么？`,
      // Failure mode 3: 没有考虑新设计的失败模式
      `【故障模式】${reqCtx} 你提出的设计在以下情况下会发生什么：网络超时、空值输入、并发访问冲突？这些失败模式是否有处理？`,
      // Failure mode 4: 接口设计没有考虑调用方
      `【调用方验证】新接口/新模块的调用方是谁？你是否验证了调用点的存在，以及你的接口签名与调用方的期望匹配？`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】${reqCtx} 解决 ANALYSE 阶段识别的根因，最小必要的改动是什么？你的架构方案是否与问题规模成比例，还是在解决一个比实际更大的问题？`,
    ],
    PLAN: [
      // Failure mode 1: 任务描述模糊，没有具体文件路径
      `【具体性检查】execution-plan.md 中每个任务是否都指定了精确的文件路径？（例如："workflow/core/foo.js 第42行"，而非"foo 模块"）没有文件路径的任务不可执行。`,
      // Failure mode 2: 任务依赖顺序错误
      `【依赖顺序】${reqCtx} 哪些任务必须在其他任务完成后才能开始？任务顺序是否正确？并行执行是否会产生冲突？`,
      // Failure mode 3: 遗漏验证和回滚任务
      `【完整性检查】计划是否包含：(1) 如何验证改动生效的步骤，(2) 如果失败如何回滚？这两项不是可选的。`,
      // Failure mode 4: 范围蔓延，计划了超出根因修复所需的内容
      `【范围控制】${reqCtx} 计划中每个任务是否都直接对应 ANALYSE 阶段识别的根因？删除所有"顺便做"但不是修复根因所必需的任务。`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】你现在能按照这个计划一步步执行吗？如果有任何任务描述模糊或需要未知信息，它需要被进一步拆解。`,
    ],
    DEVELOP: [
      // Failure mode 1: 没有按执行计划执行
      `【计划追踪】${reqCtx} 检查 execution-plan.md：列出每个任务 ID 及其状态（已完成/跳过/阻塞）。跳过任务必须有明确理由，不能静默跳过。`,
      // Failure mode 2: 凭记忆写代码，没有先读现有代码
      `【代码阅读证据】对于你修改的每个文件：你是否先读了现有代码再编辑？描述你修改的现有逻辑是什么，以及你的改动为什么是正确的。`,
      // Failure mode 3: 破坏现有行为（回归）
      `【回归风险】${reqCtx} 你的改动影响了哪些现有行为？修改函数的调用方是否仍然与新的签名/行为兼容？`,
      // Failure mode 4: 实现不完整，留有 TODO 占位
      `【完整性检查】你的实现是完整的，还是留有 TODO/placeholder 注释？artifact 必须反映代码的实际状态，而非预期状态。`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】${reqCtx} 你的实现是否直接解决了 ANALYSE 阶段识别的根因？还是修复了症状？请从根因追溯到你的改动，验证因果链完整。`,
    ],
    TEST: [
      // Failure mode 1: 描述测试而非运行测试
      `【实际执行证据】${reqCtx} 你是否实际运行了测试套件？粘贴真实输出（通过/失败数量、错误信息）。不要描述测试应该做什么——展示它们实际做了什么。`,
      // Failure mode 2: 只测试正常路径
      `【失败路径覆盖】你是否测试了失败场景？（无效输入、边界值、并发冲突、网络失败）列出你测试过的失败场景。`,
      // Failure mode 3: 测试结果与修复没有关联
      `【根因覆盖验证】${reqCtx} 哪个具体的测试用例验证了 ANALYSE 阶段识别的根因已被修复？如果没有测试覆盖根因，你需要添加一个。`,
      // Failure mode 4: 忽视测试失败
      `【失败分析】输出中是否有测试失败？如果有：它们是预先存在的（与本次改动无关）还是由本次改动引起的？必须明确记录。`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】${reqCtx} 要对这个修复在生产环境中有效建立信心，最少需要什么证据？你的测试是否提供了这个证据，还是在测试错误的东西？`,
    ],
    REVIEW: [
      // Failure mode 1: 走过场审查，没有真正审视
      `【审查深度】${reqCtx} 列出你在实现中发现的至少 3 个具体问题或风险。如果你发现了零个问题，说明你没有认真审查。`,
      // Failure mode 2: 没有对照原始需求检查
      `【需求符合度】实现是否完全满足原始需求："${req || '（见上下文）'}"？列出请求内容与实现内容之间的所有差距。`,
      // Failure mode 3: 遗漏安全/性能影响
      `【安全与性能】是否有安全影响？（输入验证、权限绕过、数据暴露）是否有性能影响？（N+1 查询、阻塞 I/O、内存泄漏）`,
      // Failure mode 4: 没有端到端验证修复链
      `【端到端链路】追踪修复链：根因（ANALYSE）→ 设计决策（ARCHITECT）→ 实现（DEVELOP）→ 测试覆盖（TEST）。链路是否完整且一致？`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】如果你是第一次看这个 PR 的工程师，你会问什么问题？什么会让你拒绝它？现在回答这些问题。`,
    ],
    DEPLOY: [
      // Failure mode 1: 没有回滚计划
      `【回滚计划】${reqCtx} 如果这次部署失败，回滚步骤是什么？是否已记录？能否在 5 分钟内执行？`,
      // Failure mode 2: 缺少部署前检查清单
      `【部署前检查】(1) 所有测试是否通过？(2) artifact 是否已审查并批准？(3) 是否需要配置变更？(4) 是否有数据库迁移？`,
      // Failure mode 3: 没有考虑依赖服务的部署顺序
      `【部署顺序】${reqCtx} 这次变更是否影响多个服务或组件？如果是，正确的部署顺序是什么，以避免破坏依赖关系？`,
      // Failure mode 4: 没有监控/告警
      `【可观测性】部署后如何知道是否引发了生产回归？部署后应该监控哪些指标/日志/告警？`,
      // Failure mode 5: 第一性原则检验
      `【第一性原则】${reqCtx} 这次部署是可逆的吗？如果不可逆，是什么使它不可逆，这是可接受的吗？如果出错，影响范围是什么？`,
    ],
  };

  const questions = questionsByStage[stage] || [
    `【目标确认】${reqCtx} 这个阶段的具体目标是什么？"完成"是什么样子的？`,
    `【失败模式】这个阶段最可能的失败模式是什么？你如何避免它们？`,
    `【证据要求】你将产出什么证据来证明这个阶段被正确完成了？`,
  ];

  // ── Structured Self-Answer Format ─────────────────────────────────────────
  // Industry reference: CoVe (Chain of Verification) requires structured Q→A format
  // to prevent LLM from "reading" questions without actually answering them.
  // Format: Q1: [question] → A1: [your answer] forces explicit engagement.
  const formattedQuestions = questions.map((q, i) => `Q${i + 1}: ${q}`);

  return {
    mandatory: true,
    // SOFT-STRUCTURED + VERIFIABLE: not a hard gate on thinking quality,
    // but ## 思考摘要 is a REQUIRED section in analysis.md (stage-complete will HARD-REJECT if missing).
    // This converts Pre-Stage thinking from "unobservable" to "verifiable artifact section".
    enforcement: 'SOFT-STRUCTURED + VERIFIABLE — answer in <thinking>, then write ## 思考摘要 section in artifact',
    instruction: [
      `⚡ PRE-STAGE THINKING REQUIRED (Self-Ask + CoVe pattern):`,
      `在写 artifact 之前，必须在 <thinking> 中按 "Q1: [问题] → A1: [你的回答]" 格式逐条回答以下 ${formattedQuestions.length} 个问题。`,
      `然后在 artifact 末尾写一个 "## 思考摘要" section，格式为：`,
      `  Q1: [问题简述] → A1: [你的回答摘要（1-2句，必须具体引用代码/文件/数据）]`,
      `  Q2: [问题简述] → A2: [你的回答摘要]`,
      `  ...`,
      `stage-complete 会 HARD-REJECT 缺少 ## 思考摘要 section 的 artifact。`,
      `每个回答必须具体（引用实际代码/文件/数据），不接受"已考虑"或"将会处理"这类空洞回答。`,
    ].join(' '),
    questions: formattedQuestions,
    selfAnswerFormat: 'Q{n}: [question summary] → A{n}: [specific answer with evidence, 1-2 sentences]',
    rationale: `这些问题针对 ${stage} 阶段最常见的失误模式（基于 Self-Ask/ReAct/CoVe 方法论）。逐条回答迫使你在提交方案前验证假设。## 思考摘要 section 使思考过程可观测、可验证。`,
  };
}

/**
 * Record that a /wf input was received, regardless of whether it's a requirement or a question.
 * This ensures every /wf message leaves a trace in workflow-progress.log.
 *
 * Args:
 *   --user-input   : the raw /wf message text (required)
 *   --input-type   : 'requirement' | 'question' | 'research' | 'other' (default: 'requirement')
 *   --decision     : how this input will be handled (e.g. '走完整工作流' | '直接回答' | '调研分析')
 *   --session      : session ID
 *   --project-root : project root path
 */
function runInputReceived(args) {
  try {
    const userInput = args.userInput || args.requirement || '';
    const inputType = args.inputType || args['input-type'] || 'requirement';
    const decision = args.decision || '走完整工作流';
    const sessionId = args.session || `wf-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
    const projectRoot = args.projectRoot || '.';

    const typeEmoji = {
      requirement: '📋',
      question: '❓',
      research: '🔍',
      other: '📩',
    }[inputType] || '📩';

    _writeProgressLog(projectRoot, [
      `📩 输入已接收`,
      `  session  : ${sessionId}`,
      `  type     : ${typeEmoji} ${inputType}`,
      `  input    : ${userInput.length > 300 ? userInput.slice(0, 300) + '...' : userInput}`,
      `  decision : ${decision}`,
    ].join('\n'));

    // ── BUGFIX: Clean up expired/stale workflow state on new input ──
    // Two scenarios to handle:
    // 1. TTL expired: clear both activeWorkflow and pendingRetry (zombie state)
    // 2. pendingRetry from a different session: always clear (cross-session contamination)
    try {
      const statusFilePath = path.join(projectRoot, 'output', 'workflow-status.json');
      if (fs.existsSync(statusFilePath)) {
        let statusData = {};
        try { statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf-8')); } catch { statusData = {}; }
        let wroteChanges = false;

        // Scenario 1: TTL expired for previous session
        if (statusData.activeWorkflow && statusData.activeWorkflow.ttlExpiry) {
          const ttlExpired = new Date(statusData.activeWorkflow.ttlExpiry) < new Date();
          if (ttlExpired && statusData.activeWorkflow.session !== sessionId) {
            console.error(`[runInputReceived] 🧹 TTL expired for session=${statusData.activeWorkflow.session} (expired at ${statusData.activeWorkflow.ttlExpiry}). Clearing stale state.`);
            delete statusData.activeWorkflow;
            wroteChanges = true;
          }
        }

        // Scenario 2: pendingRetry from a different session (always clear, regardless of TTL)
        // This prevents cross-session contamination where a new session inherits
        // an unrelated pendingRetry from a previous failed workflow.
        if (statusData.pendingRetry) {
          const retrySession = statusData.pendingRetry.session;
          const belongsToActiveSession = retrySession && retrySession === sessionId;
          const belongsToCurrentActive = !retrySession && statusData.activeWorkflow?.session === sessionId;
          if (!belongsToActiveSession && !belongsToCurrentActive) {
            console.error(`[runInputReceived] 🧹 Clearing stale pendingRetry for stage=${statusData.pendingRetry.stage} (from session=${retrySession || 'unknown'}, current=${sessionId})`);
            delete statusData.pendingRetry;
            wroteChanges = true;
          }
        }

        if (wroteChanges) {
          fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
        }

        // ── Scenario 3: Requirement change detection ──
        // If the user's requirement has significantly changed (not just a minor rephrase),
        // all cross-stage context files from the previous requirement are stale and MUST
        // be cleared. Otherwise, the new workflow inherits decisions made for a different
        // problem — which produces incorrect results.
        // The fingerprint uses normalized keywords (stop-word filtered, sorted) rather than
        // raw text hash, so minor rephrasing ("add login" → "implement authentication")
        // does NOT trigger a reset, but a genuinely different requirement does.
        const currentReq = (userInput || '').trim();
        if (currentReq && statusData.activeWorkflow?.requirement) {
          const prevReq = statusData.activeWorkflow.requirement;
          const currentFp = _requirementFingerprint(currentReq);
          const prevFp = _requirementFingerprint(prevReq);
          if (currentFp !== prevFp) {
            console.error(`[runInputReceived] 🔄 Requirement changed — resetting cross-stage context`);
            console.error(`[runInputReceived]    prev: "${prevReq.slice(0, 80)}${prevReq.length > 80 ? '...' : ''}" (fp=${prevFp})`);
            console.error(`[runInputReceived]    curr: "${currentReq.slice(0, 80)}${currentReq.length > 80 ? '...' : ''}" (fp=${currentFp})`);
            let resetCount = 0;
            // Clear cross-stage context files
            const filesToReset = [
              path.join(projectRoot, 'output', 'stage-context.json'),
              path.join(projectRoot, 'output', 'stage-decisions.json'),
              path.join(projectRoot, 'output', 'decisions.json'),
            ];
            for (const f of filesToReset) {
              if (fs.existsSync(f)) {
                try {
                  fs.unlinkSync(f);
                  resetCount++;
                  console.error(`[runInputReceived]    🗑️ Deleted ${path.basename(f)}`);
                } catch (e) {
                  console.error(`[runInputReceived]    ⚠️ Failed to delete ${path.basename(f)}: ${e.message}`);
                }
              }
            }
            // Reset activeWorkflow so stages start from scratch
            delete statusData.activeWorkflow;
            delete statusData.pendingRetry;
            fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
            console.error(`[runInputReceived] 🧹 Requirement change cleanup: ${resetCount} file(s) deleted, activeWorkflow reset`);
            _writeProgressLog(projectRoot, [
              `🔄 需求变更检测 — 跨阶段上下文已重置`,
              `  前需求 : ${prevReq.slice(0, 100)}`,
              `  新需求 : ${currentReq.slice(0, 100)}`,
              `  清理文件: ${resetCount} 个`,
            ].join('\n'));
          }
        }
      }
    } catch (cleanupErr) {
      console.error(`[runInputReceived] ⚠️ State cleanup failed (non-fatal): ${cleanupErr.message}`);
    }

    // ── stderr MANDATORY banner (Hook Enhancement 2.1) ──────────────────────
    console.error([
      ``,
      `╔══════════════════════════════════════════════════════════════╗`,
      `║  ⛔ WORKFLOW STARTED — Call workflow-stage NOW               ║`,
      `╚══════════════════════════════════════════════════════════════╝`,
      `⛔ RUN NOW: node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ANALYSE --session ${sessionId} --project-root ${projectRoot} --requirement "<requirement>"`,
      ``,
    ].join('\n'));

    return {
      success: true,
      subcommand: 'input-received',
      data: { sessionId, inputType, decision, logged: true },
      MANDATORY_NEXT_ACTION: {
        type: 'CALL_WORKFLOW_STAGE',
        command: `node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ANALYSE --session ${sessionId} --project-root ${projectRoot} --requirement "<your requirement here>"`,
        reason: 'workflow-stage MUST be called as the very next step. stage-complete will HARD-REJECT (fatal error) if workflow-stage was not called first for this session.',
        enforcement: 'HARD — stage-complete checks trace file for stage_start event; missing = fatal error, workflow aborted',
        warning: 'DO NOT call stage-complete, edit files, or do anything else before calling workflow-stage. The anti-skip guard is fatal and non-bypassable.',
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'input-received',
      error: err.message,
    };
  }
}

/**
 * Compute a normalized keyword fingerprint of a requirement string.
 * This is used to detect whether the user's requirement has *significantly*
 * changed (not just rephrased) so we can reset stale cross-stage context.
 *
 * Algorithm: lowercase → split on non-alphanumeric → filter stop words →
 * sort → join. Two requirements with the same core keywords produce the
 * same fingerprint even if word order or phrasing differs.
 */
function _requirementFingerprint(text) {
  return _sharedRequirementFingerprint(text);
}

/**
 * Append a timestamped entry to output/workflow-progress.log.
 * This is the primary human-readable log for IDE mode — users can open this
 * file at any time to see which stages have run and what they produced.
 */
function _writeProgressLog(projectRoot, message) {
  try {
    const outputDir = path.join(projectRoot, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    const logPath = path.join(outputDir, 'workflow-progress.log');
    // Use local time (not UTC) so timestamps match the user's timezone
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const entry = `[${ts}]\n${message}\n`;
    fs.appendFileSync(logPath, entry + '\n', 'utf8');
  } catch (err) {
    console.error(`[_writeProgressLog] Failed to write progress log: ${err.message}`);
  }
}

function _stageToRole(stage) {
  const mapping = {
    ANALYSE: 'analyst',
    ARCHITECT: 'architect',
    PLAN: 'planner',
    DEVELOP: 'developer',
    TEST: 'tester',
  };
  return mapping[stage] || 'developer';
}

function _stageToOutputFile(stage) {
  const mapping = {
    ANALYSE: 'analysis.md',
    ARCHITECT: 'architecture.md',
    PLAN: 'execution-plan.md',
    DEVELOP: 'code.diff',
    TEST: 'test-report.md',
  };
  return mapping[stage] || `${stage.toLowerCase()}-output.md`;
}

// ─── P0: Artifact Schema Validation (SWE-agent Linter-in-Tool pattern) ───────
// Validates that a stage's output artifact exists and contains required sections.
// Returns { valid: true } or { valid: false, missingSections, error, fixInstruction }
// This is a HARD gate — stage-complete will reject if validation fails.
//
// ─── ADR-37 Evidence Gate (IDE-First Mechanical Enforcement) ─────────────────
// Each stage's evidencePatterns defines what "proof of IDE tool usage" looks like.
// The artifact MUST contain at least one pattern match — otherwise it was written
// from LLM memory alone (bypassing IDE tools), which violates ADR-37.
//
// Evidence patterns are designed to match content that can ONLY come from real
// IDE tool calls (codebase_search, grep_search, view_code_item, read_file):
//   - File paths with extensions: src/foo.js, core/bar.ts, workflow/baz.js
//   - Line number references: line 47, L123, :234
//   - Function/class names with context: function foo(, class Bar {, const baz =
//   - Code snippets with indentation or syntax
//   - grep/search result patterns: matches found, results:
//
// If NONE of these patterns are found, the artifact is flagged as [EVIDENCE_MISSING].
// The LLM must re-run IDE tools and rewrite the artifact with concrete evidence.
//
// Industry reference: SWE-agent's ACI requires tool output to be embedded in trajectory.
// Devin's "grounding" principle: every claim must be traceable to a tool call result.
const ARTIFACT_SCHEMA = {
  ANALYSE: {
    file: 'analysis.md',
    requiredSections: ['## 根因', '## 受影响位置', '## 修改范围', '## 风险评估', '## 思考摘要'],
    // ── Forbidden Sections (template pollution prevention) ───────────────────
    // LLM inertia causes it to write generic requirement templates into analysis.md.
    // These sections are NEVER valid in analysis.md — they belong in requirement.md.
    // stage-complete will HARD-REJECT if any of these are found.
    forbiddenSections: [
      '## User Stories',
      '## Functional Requirements',
      '## Non-Functional Requirements',
      '## Acceptance Criteria',
      '## Assumptions',
      '## Open Questions',
      '## Overview',
      '## Socratic Validation',
    ],
    forbiddenError: '[TEMPLATE_POLLUTION] analysis.md contains generic requirement template sections (User Stories / Functional Requirements / Acceptance Criteria / Socratic Validation). These sections are NEVER valid in analysis.md. analysis.md is a task-specific diagnostic document, not a requirements document.',
    forbiddenFixInstruction: 'Delete all generic template sections from analysis.md. Keep ONLY: ## 根因, ## 受影响位置, ## 修改范围, ## 风险评估. Do NOT copy Socratic dimension definitions into the artifact — use them as internal thinking framework only.',
    minLines: 10,
    description: 'analysis.md must contain root cause, affected locations, change scope, and risk assessment',
    // ADR-37 Evidence Gate: ANALYSE must reference actual code locations found via IDE tools
    evidencePatterns: [
      // File path patterns (must reference real files found via codebase_search/grep_search)
      /\b\w[\w/-]*\.(js|ts|jsx|tsx|py|go|java|cs|cpp|c|rb|rs|md|json|yaml|yml)\b/,
      // Line number references (from grep_search or view_code_item results)
      /(?:line|L|第)\s*\d+/i,
      // Function/class/variable references with code context
      /(?:function|class|const|let|var|def|func|interface|type)\s+\w+/,
      // File path with directory separator (strong evidence of real file reference)
      /(?:workflow|src|core|lib|test|spec|output)\/[\w.-]+/,
    ],
    evidenceMinMatches: 2, // Must match at least 2 different patterns
    evidenceError: '[EVIDENCE_MISSING] analysis.md contains no evidence of IDE tool usage (no file paths, line numbers, or code references). This means the analysis was written from LLM memory alone, bypassing codebase_search/grep_search/view_code_item. ADR-37 violation.',
    evidenceFixInstruction: 'You MUST use IDE tools before writing analysis.md: (1) Run codebase_search to find relevant code, (2) Run grep_search to locate specific patterns, (3) Run view_code_item to inspect functions. Then write analysis.md with concrete file paths, line numbers, and code references from your search results.',
  },
  ARCHITECT: {
    file: 'architecture.md',
    requiredSections: ['## '],
    minLines: 5,
    description: 'architecture.md must have at least one section with content',
    // ADR-37 Evidence Gate: ARCHITECT must reference actual modules/files found via IDE tools
    evidencePatterns: [
      /\b\w[\w/-]*\.(js|ts|jsx|tsx|py|go|java|cs|cpp|c|rb|rs|md|json|yaml|yml)\b/,
      /(?:workflow|src|core|lib|test|spec|output)\/[\w.-]+/,
      /(?:function|class|const|interface|type|module|component)\s+\w+/,
    ],
    evidenceMinMatches: 1,
    evidenceError: '[EVIDENCE_MISSING] architecture.md contains no evidence of IDE tool usage (no file paths or module references). Architecture decisions must be grounded in actual codebase structure found via codebase_search/view_code_item.',
    evidenceFixInstruction: 'Use codebase_search to explore the existing architecture before writing architecture.md. Reference actual files and modules by their real paths.',
  },
  PLAN: {
    file: 'execution-plan.md',
    requiredSections: ['## '],
    // ── Forbidden Sections (template pollution prevention) ───────────────────
    // execution-plan.md is a task list, not a requirements document.
    forbiddenSections: [
      '## User Stories',
      '## Functional Requirements',
      '## Non-Functional Requirements',
      '## Acceptance Criteria',
      '## Assumptions',
      '## Open Questions',
      '## Overview',
      '# Requirement Analysis',
    ],
    forbiddenError: '[TEMPLATE_POLLUTION] execution-plan.md contains generic requirement template sections (User Stories / Functional Requirements / Acceptance Criteria). These sections are NEVER valid in execution-plan.md. execution-plan.md must contain ONLY concrete tasks (T-001, T-002...) with file paths and implementation steps.',
    forbiddenFixInstruction: 'Delete all generic template sections from execution-plan.md. Keep ONLY concrete task entries (T-001, T-002...) with: exact file paths, specific code locations, and implementation steps.',
    minLines: 5,
    description: 'execution-plan.md must have at least one section with content',
    // ADR-37 Evidence Gate: PLAN must reference actual files to be modified
    evidencePatterns: [
      /\b\w[\w/-]*\.(js|ts|jsx|tsx|py|go|java|cs|cpp|c|rb|rs|md|json|yaml|yml)\b/,
      /(?:workflow|src|core|lib|test|spec|output)\/[\w.-]+/,
    ],
    evidenceMinMatches: 1,
    evidenceError: '[EVIDENCE_MISSING] execution-plan.md contains no file references. A plan without concrete file paths is not actionable — it was written without inspecting the actual codebase.',
    evidenceFixInstruction: 'Use grep_search or codebase_search to identify the exact files that need to be modified. Include their real paths in execution-plan.md.',
  },
  TEST: {
    file: 'test-report.md',
    requiredSections: ['## '],
    minLines: 3,
    description: 'test-report.md must have at least one section with content',
    // ADR-37 Evidence Gate: TEST must contain actual test results (pass/fail counts or error messages)
    // Strengthened: must also contain evidence of real test execution (command name or runner output)
    evidencePatterns: [
      /(?:pass|fail|error|skip|✅|❌|PASS|FAIL|ERROR)\b/i,
      /\d+\s*(?:\/\s*\d+\s*)?(?:test|spec|suite|case)s?\s*(?:pass|fail|run|total)/i,
      /(?:npm test|jest|mocha|pytest|go test|cargo test|vitest|run-all-tests|dotnet test|mvn test|gradle test)/i,
    ],
    evidenceMinMatches: 2,  // Raised from 1 to 2: must match BOTH pass/fail counts AND test runner evidence
    evidenceError: '[EVIDENCE_MISSING] test-report.md lacks real test execution evidence. Must contain BOTH: (1) pass/fail counts from actual test run, AND (2) test runner/command reference. Tests must be RUN, not described from memory.',
    evidenceFixInstruction: 'Run: node workflow/tools/ide-workflow-bridge.js test-execute --project-root . — then include the real output (pass/fail counts + command used) in test-report.md. Do NOT write test results from memory.',
  },
};

function _validateArtifact(stage, projectRoot) {
  const schema = ARTIFACT_SCHEMA[stage];
  if (!schema) return { valid: true, skipped: true, reason: `No schema defined for stage ${stage}` };

  const artifactPath = path.join(projectRoot, 'output', schema.file);

  // Check file exists
  if (!fs.existsSync(artifactPath)) {
    return {
      valid: false,
      error: `[ARTIFACT_MISSING] output/${schema.file} not found`,
      fixInstruction: `Write the ${stage} artifact to output/${schema.file} before calling stage-complete. ${schema.description}`,
      missingSections: schema.requiredSections,
    };
  }

  let content = '';
  try {
    content = fs.readFileSync(artifactPath, 'utf-8');
  } catch (readErr) {
    return {
      valid: false,
      error: `[ARTIFACT_UNREADABLE] Cannot read output/${schema.file}: ${readErr.message}`,
      fixInstruction: `Ensure output/${schema.file} is a valid UTF-8 text file.`,
      missingSections: [],
    };
  }

  // Check minimum lines
  const lineCount = content.split('\n').filter(l => l.trim()).length;
  if (lineCount < schema.minLines) {
    return {
      valid: false,
      error: `[ARTIFACT_TOO_SHORT] output/${schema.file} has only ${lineCount} non-empty lines (minimum: ${schema.minLines})`,
      fixInstruction: `output/${schema.file} appears incomplete. Add substantive content. ${schema.description}`,
      missingSections: [],
    };
  }

  // Check required sections
  const missingSections = schema.requiredSections.filter(section => !content.includes(section));
  if (missingSections.length > 0) {
    return {
      valid: false,
      error: `[ARTIFACT_SCHEMA_FAILED] output/${schema.file} missing required sections: ${missingSections.join(', ')}`,
      fixInstruction: `Add the following sections to output/${schema.file}: ${missingSections.join(', ')}. ${schema.description}`,
      missingSections,
    };
  }

  // ── Forbidden Sections Gate (Template Pollution Prevention) ─────────────────
  // LLM inertia causes it to write generic requirement templates (User Stories,
  // Functional Requirements, Acceptance Criteria) into task-specific artifacts.
  // This gate HARD-REJECTs any artifact containing forbidden sections.
  // Design: check for exact section header strings (case-sensitive, line-start).
  if (schema.forbiddenSections && schema.forbiddenSections.length > 0) {
    const foundForbidden = schema.forbiddenSections.filter(section => content.includes(section));
    if (foundForbidden.length > 0) {
      return {
        valid: false,
        error: schema.forbiddenError || `[TEMPLATE_POLLUTION] output/${schema.file} contains forbidden sections: ${foundForbidden.join(', ')}`,
        fixInstruction: schema.forbiddenFixInstruction || `Remove the following forbidden sections from output/${schema.file}: ${foundForbidden.join(', ')}. These are generic requirement templates that do not belong in this artifact.`,
        missingSections: [],
        forbiddenViolation: true,
        foundForbiddenSections: foundForbidden,
      };
    }
  }

  // ── ADR-37 Evidence Gate (IDE-First Mechanical Enforcement) ──────────────────
  // Validates that the artifact contains evidence of actual IDE tool usage.
  // An artifact written purely from LLM memory will fail this check.
  // This converts ADR-37 from a prompt constraint to a mechanical gate.
  //
  // Design: count how many distinct evidence patterns match in the content.
  // If matched patterns < evidenceMinMatches → HARD reject with fix instruction.
  if (schema.evidencePatterns && schema.evidenceMinMatches > 0) {
    const matchedPatterns = schema.evidencePatterns.filter(pattern => pattern.test(content));
    if (matchedPatterns.length < schema.evidenceMinMatches) {
      return {
        valid: false,
        error: schema.evidenceError || `[EVIDENCE_MISSING] output/${schema.file} lacks evidence of IDE tool usage`,
        fixInstruction: schema.evidenceFixInstruction || `Use codebase_search/grep_search/view_code_item before writing output/${schema.file}. Include concrete file paths, line numbers, and code references from your search results.`,
        missingSections: [],
        evidenceViolation: true,
        matchedPatternCount: matchedPatterns.length,
        requiredPatternCount: schema.evidenceMinMatches,
        adr37Violation: true,
      };
    }
  }

  return {
    valid: true,
    artifactPath,
    lineCount,
    hash: `${content.length}-${content.slice(0, 32).replace(/\s+/g, '')}`,
    evidenceVerified: !!(schema.evidencePatterns),
  };
}

// ─── P0: Cross-Stage Dependency Validation (Devin Dependency Gate pattern) ───
// Validates that all required input artifacts for a stage exist before starting.
// Returns { valid: true } or { valid: false, missingDeps, error, fixInstruction }
// This is a HARD gate — workflow-stage will reject if dependencies are missing.
const STAGE_HARD_DEPS = {
  ARCHITECT: [
    { file: 'output/analysis.md', stage: 'ANALYSE', description: 'Root cause analysis' },
  ],
  PLAN: [
    // P0-2 fix: PLAN consumes architecture.md from bus (ARCHITECT→PLANNER).
    // ANALYSE context is injected via StageContextStore, not via direct file dependency.
    { file: 'output/architecture.md', stage: 'ARCHITECT', description: 'Architecture design' },
  ],
  DEVELOP: [
    // P0-2 fix: DEVELOP consumes architecture.md from bus (PLANNER→DEVELOPER),
    // with execution-plan.md path in meta. Both files are required.
    { file: 'output/architecture.md', stage: 'ARCHITECT', description: 'Architecture design' },
    { file: 'output/execution-plan.md', stage: 'PLAN', description: 'Execution plan with tasks' },
  ],
  TEST: [
    { file: 'output/code.diff', stage: 'DEVELOP', description: 'Code changes to test' },
  ],
  REVIEW: [
    { file: 'output/test-report.md', stage: 'TEST', description: 'Test results' },
  ],
};

function _validateStageDependencies(stage, projectRoot) {
  const deps = STAGE_HARD_DEPS[stage];
  if (!deps || deps.length === 0) return { valid: true, skipped: true, reason: `No hard deps for stage ${stage}` };

  const missingDeps = deps.filter(dep => !fs.existsSync(path.join(projectRoot, dep.file)));

  if (missingDeps.length > 0) {
    const missingList = missingDeps.map(d => `${d.file} (from ${d.stage}: ${d.description})`).join('; ');
    const firstMissing = missingDeps[0];
    return {
      valid: false,
      error: `[DEPENDENCY_MISSING] Cannot start ${stage}: required artifacts not found: ${missingList}`,
      fixInstruction: `Run the previous stage first: node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${firstMissing.stage} --session <sessionId> --project-root .`,
      missingDeps: missingDeps.map(d => d.file),
      requiredStage: firstMissing.stage,
    };
  }

  return { valid: true, depsChecked: deps.map(d => d.file) };
}

/**
 * P0-STARTUP-2: Lightweight tech stack detection for IDE Agent mode.
 * Used by Experience preheat to select relevant seed experiences.
 * Mirrors Orchestrator._detectTechStackForPreheat() but without
 * requiring a full Orchestrator instance.
 */
function _detectTechStackLite(projectRoot) {
  const root = projectRoot || process.cwd();
  const stack = [];
  try {
    const files = fs.readdirSync(root);
    if (files.includes('package.json')) stack.push('node');
    if (files.includes('requirements.txt') || files.includes('pyproject.toml')) stack.push('python');
    if (files.includes('go.mod')) stack.push('go');
    if (files.includes('Cargo.toml')) stack.push('rust');
    if (files.includes('pom.xml') || files.includes('build.gradle')) stack.push('java');
    if (files.includes('Gemfile')) stack.push('ruby');
    if (files.includes('composer.json')) stack.push('php');
  } catch (_) { /* non-fatal */ }
  return stack.length > 0 ? stack : ['unknown'];
}

function _getInputArtifactsForStage(stage, projectRoot) {
  const rawRequired = STAGE_INPUT_FILES[stage] || [];
  const required = rawRequired.map(file => file.startsWith('output/') ? file : `output/${file}`);

  return required.map(file => ({
    file,
    exists: fs.existsSync(path.join(projectRoot, file)),
  }));
}

// ─── Sub-command: stage-complete ─────────────────────────────────────────────

/**
 * Plan B Stage Runner — Finalize a stage by writing stage_end trace.
 *
 * This is the counterpart to workflow-stage. Together they form the Plan B
 * stage runner pattern:
 *
 *   [terminal] workflow-stage --stage ANALYSE   ← auto-writes stage_start trace
 *   [IDE tools] do actual work (read_file, grep, edit_file, etc.)
 *   [terminal] stage-complete --stage ANALYSE   ← auto-writes stage_end trace
 *
 * Trace writing is code-enforced, not LLM-dependent. The IDE Agent cannot
 * "forget" to write the trace — it's baked into the command execution.
 *
 * Required args:
 *   --stage    Stage name (ANALYSE | ARCHITECT | PLAN | DEVELOP | TEST | REVIEW | DEPLOY)
 *   --session  Session ID returned by workflow-stage
 *
 * Optional args:
 *   --summary       1-2 sentence summary of what was done in this stage
 *   --stage-output  Key decisions / artifacts produced
 *   --project-root  Project root (default: .)
 */
async function runStageComplete(args) {
  try {
    const stage = (args.stage || '').toUpperCase();
    const validStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];

    if (!stage || !validStages.includes(stage)) {
      return {
        success: false,
        subcommand: 'stage-complete',
        error: `Invalid or missing stage. Valid: ${validStages.join(', ')}`,
      };
    }

    if (!args.session) {
      return {
        success: false,
        subcommand: 'stage-complete',
        error: 'Missing --session. Pass the sessionId returned by workflow-stage.',
      };
    }

    console.error(`[runStageComplete] Writing stage_end trace for stage=${stage} session=${args.session}`);

    // ── P0: Verify stage_start exists in trace (anti-skip guard) ──
    // Prevents LLM from calling stage-complete without first calling workflow-stage.
    // This mirrors SWE-agent's ACI verify step: tool-use enforced, not prompt-suggested.
    // ── HARD GUARD (fatal) ── trace file absence = workflow-stage was never called
    {
      const runCategory = args.runCategory || 'prod';
      const projectRoot = args.projectRoot || '.';
      const tracePath = path.join(projectRoot, 'output', 'health', runCategory, 'workflow-trace.jsonl');
      if (!fs.existsSync(tracePath)) {
        console.error(`[runStageComplete] ❌ ANTI-SKIP GUARD (FATAL): trace file not found at ${tracePath}. workflow-stage must be called first.`);
        return {
          success: false,
          subcommand: 'stage-complete',
          error: `[ANTI-SKIP GUARD] Trace file not found. You MUST call workflow-stage --stage ${stage} --session ${args.session} before stage-complete. workflow-stage creates the trace file; its absence means you skipped it.`,
        };
      }
      try {
        const traceLines = fs.readFileSync(tracePath, 'utf-8').split('\n').filter(l => l.trim());
        const hasStageStart = traceLines.some(line => {
          try {
            const ev = JSON.parse(line);
            return ev.event === 'stage_start' && ev.stage === stage && ev.session === args.session;
          } catch (_) { return false; }
        });
        if (!hasStageStart) {
          console.error(`[runStageComplete] ❌ ANTI-SKIP GUARD (FATAL): No stage_start found for stage=${stage} session=${args.session}.`);
          return {
            success: false,
            subcommand: 'stage-complete',
            error: `[ANTI-SKIP GUARD] stage_start not found for stage=${stage} session=${args.session}. You MUST call workflow-stage --stage ${stage} --session ${args.session} before stage-complete. This is a hard enforcement — skipping is not allowed.`,
          };
        }
        console.error(`[runStageComplete] ✅ Anti-skip guard passed: stage_start found for stage=${stage} session=${args.session}`);
      } catch (guardErr) {
        // Fatal: if trace file exists but is unreadable, something is wrong — do not proceed
        console.error(`[runStageComplete] ❌ ANTI-SKIP GUARD (FATAL): Failed to read trace file: ${guardErr.message}`);
        return {
          success: false,
          subcommand: 'stage-complete',
          error: `[ANTI-SKIP GUARD] Failed to verify stage_start in trace: ${guardErr.message}. Cannot proceed without verification.`,
        };
      }
    }

    // ── P0: Artifact Schema Validation (SWE-agent Linter-in-Tool pattern) ──
    // Validates that the stage output artifact exists and contains required sections.
    // This is a HARD gate — rejects stage-complete if artifact is missing or malformed.
    // Industry reference: SWE-agent's edit command runs linter before accepting changes.
    // artifactValidation is hoisted to outer scope so it can be included in success return value (P1 Observation Loop).
    let artifactValidation = { valid: true, skipped: true };
    {
      const projectRoot = args.projectRoot || '.';
      const artifactCheck = _validateArtifact(stage, projectRoot);
      artifactValidation = artifactCheck;
      if (!artifactCheck.valid) {
        console.error(`[runStageComplete] ❌ ARTIFACT VALIDATION (FATAL): ${artifactCheck.error}`);
        // Write failure to progress log so it's visible
        _writeProgressLog(projectRoot, [
          `❌ [ARTIFACT_VALIDATION_FAILED] ${stage} 阶段产物验证失败`,
          `  session  : ${args.session}`,
          `  error    : ${artifactCheck.error}`,
          `  fix      : ${artifactCheck.fixInstruction}`,
        ].join('\n'));
        return {
          success: false,
          subcommand: 'stage-complete',
          error: artifactCheck.error,
          MANDATORY_FIX: {
            instruction: artifactCheck.fixInstruction,
            missingSections: artifactCheck.missingSections || [],
            enforcement: artifactCheck.adr37Violation
              ? 'HARD — ADR-37 Evidence Gate: artifact rejected because it contains no evidence of IDE tool usage (no file paths, line numbers, or code references). You MUST use codebase_search/grep_search/view_code_item first.'
              : 'HARD — stage-complete rejected until artifact passes schema validation',
            adr37Violation: artifactCheck.adr37Violation || false,
            evidenceViolation: artifactCheck.evidenceViolation || false,
          },
          // ── P2: Self-Correction Context (SWE-agent trajectory replay pattern) ──
          // Inject recent trace events so LLM can review what it did and self-correct.
          // Industry reference: SWE-agent replays trajectory on failure for self-correction.
          // ADR-37 Evidence Gate: when evidenceViolation=true, inject mandatory IDE tool steps.
          SELF_CORRECTION_CONTEXT: (() => {
            try {
              const runCategory = args.runCategory || 'prod';
              const tracePathForCorrection = path.join(projectRoot, 'output', 'health', runCategory, 'workflow-trace.jsonl');
              const recentEvents = _getRecentTrace(tracePathForCorrection, args.session || '', 5);
              const artifactFile = ARTIFACT_SCHEMA[stage]?.file || `${stage.toLowerCase()}-output.md`;

              // ── ADR-37 Evidence Gate failure: specialized correction path ──
              if (artifactCheck.adr37Violation) {
                return {
                  recentActions: recentEvents,
                  violationType: 'ADR37_EVIDENCE_MISSING',
                  instruction: `⛔ ADR-37 VIOLATION: ${artifactFile} was written without IDE tool evidence. You MUST use IDE tools first, then rewrite the artifact.`,
                  mandatoryIDEToolSteps: stage === 'ANALYSE' ? [
                    `STEP 1 (MANDATORY): node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${stage} --session ${args.session || 'SESSION_ID'} --project-root . --stage-input "re-run with IDE tools"`,
                    `STEP 2 (MANDATORY): Call codebase_search with a query about the requirement`,
                    `STEP 3 (MANDATORY): Call grep_search to find specific patterns in the codebase`,
                    `STEP 4 (MANDATORY): Write analysis.md with REAL file paths and line numbers from search results`,
                    `STEP 5: Call stage-complete again — it will verify evidence is present`,
                  ] : stage === 'ARCHITECT' ? [
                    `STEP 1 (MANDATORY): Call codebase_search to explore existing architecture`,
                    `STEP 2 (MANDATORY): Call view_code_item to inspect key modules`,
                    `STEP 3 (MANDATORY): Write architecture.md with REAL module paths from your search`,
                    `STEP 4: Call stage-complete again`,
                  ] : stage === 'PLAN' ? [
                    `STEP 1 (MANDATORY): Call grep_search or codebase_search to identify files to modify`,
                    `STEP 2 (MANDATORY): Write execution-plan.md with REAL file paths from search results`,
                    `STEP 3: Call stage-complete again`,
                  ] : stage === 'TEST' ? [
                    `STEP 1 (MANDATORY): Actually run the test suite (npm test / jest / pytest)`,
                    `STEP 2 (MANDATORY): Include real test output in test-report.md`,
                    `STEP 3: Call stage-complete again`,
                  ] : [
                    `STEP 1 (MANDATORY): Use codebase_search/grep_search/view_code_item to gather evidence`,
                    `STEP 2 (MANDATORY): Rewrite ${artifactFile} with concrete file paths and code references`,
                    `STEP 3: Call stage-complete again`,
                  ],
                  whyThisMatters: 'ADR-37 (IDE-First) requires that analysis be grounded in actual codebase inspection, not LLM memory. Evidence patterns (file paths, line numbers, code references) prove that IDE tools were used.',
                };
              }

              // ── Standard artifact failure correction path ──
              return {
                recentActions: recentEvents,
                instruction: `Review your recent actions above. The artifact at output/${artifactFile} is missing or incomplete. Fix the specific issue: ${artifactCheck.fixInstruction}`,
                selfCorrectionSteps: [
                  `1. Check if output/${artifactFile} exists`,
                  `2. If missing: write the complete artifact with all required sections`,
                  `3. If incomplete: add the missing sections: ${(artifactCheck.missingSections || []).join(', ')}`,
                  `4. Then call stage-complete again`,
                ],
              };
            } catch { return null; }
          })(),
        };
      }
      if (!artifactCheck.skipped) {
        console.error(`[runStageComplete] ✅ Artifact validation passed for stage=${stage}: ${artifactCheck.lineCount} lines, hash=${artifactCheck.hash}`);
      }
    }

    // ── FORCED RETRY GATE (Layer 2): Artifact hash comparison ──
    // If pendingRetry exists for this stage, check whether the artifact has actually changed.
    // If hash is identical to the one recorded at retry-trigger time, the LLM did not improve
    // the artifact — reject immediately without running Socratic evaluation.
    // This converts "prompt retry" into "forced retry": LLM cannot pass stage-complete
    // by submitting an unchanged artifact after a RETRY_STAGE signal.
    // Industry reference: SWE-agent's edit command rejects no-op patches.
    {
      const statusFilePath = path.join(args.projectRoot || '.', 'output', 'workflow-status.json');
      try {
        if (fs.existsSync(statusFilePath)) {
          const statusRaw = fs.readFileSync(statusFilePath, 'utf-8');
          const statusData = JSON.parse(statusRaw);
          if (statusData.pendingRetry && statusData.pendingRetry.stage === stage) {
            const pending = statusData.pendingRetry;
            const currentHash = artifactValidation?.hash || null;
            const previousHash = pending.artifactHashAtRetry || null;
            if (currentHash && previousHash && currentHash === previousHash) {
              // Artifact unchanged — hard reject
              console.error(`[runStageComplete] ❌ FORCED_RETRY_GATE: artifact hash unchanged for stage=${stage} hash=${currentHash}`);
              _writeProgressLog(args.projectRoot || '.', [
                `❌ [FORCED_RETRY_GATE] ${stage} 阶段 artifact 未改善，强制重试`,
                `  session  : ${args.session}`,
                `  hash     : ${currentHash} (unchanged from retry trigger)`,
                `  fix      : You MUST substantively rewrite output/${ARTIFACT_SCHEMA[stage]?.file || stage.toLowerCase() + '-output.md'} before calling stage-complete again.`,
                `  questions: Answer the Socratic questions from the previous RETRY_STAGE signal first.`,
              ].join('\n'));
              return {
                success: false,
                subcommand: 'stage-complete',
                error: `[FORCED_RETRY_GATE] Artifact for stage ${stage} is unchanged from the previous retry attempt (hash: ${currentHash}). You MUST substantively improve the artifact before calling stage-complete again.`,
                MANDATORY_NEXT_ACTION: {
                  type: 'RETRY_STAGE',
                  command: `node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${stage} --session ${args.session} --project-root . --requirement "${args.requirement || ''}"`,
                  instruction: `⛔ FORCED RETRY: Your ${stage} artifact is identical to the rejected version. You MUST: (1) Answer the Socratic questions in your thinking, (2) Make substantive improvements to the artifact (not cosmetic changes), (3) Re-run workflow-stage to restart the stage.`,
                  retryCount: pending.retryCount,
                  maxRetry: pending.maxRetry,
                  socraticQuestions: pending.questions || [],
                  blindSpots: pending.blindSpots || [],
                  enforcement: 'HARD — artifact hash comparison, not prompt suggestion',
                },
              };
            } else if (currentHash && previousHash) {
              console.error(`[runStageComplete] ✅ FORCED_RETRY_GATE: artifact changed for stage=${stage} prev=${previousHash} curr=${currentHash}`);
            }
          }
        }
      } catch (retryGateErr) {
        // Non-fatal: if we can't read status, allow through (don't block on guard failure)
        console.error(`[runStageComplete] ⚠️ FORCED_RETRY_GATE check failed (non-fatal): ${retryGateErr.message}`);
      }
    }

    // ── P1: Auto-write stage_end trace (code-enforced) ──
    const traceEndResult = runTraceAppend({
      projectRoot: args.projectRoot || '.',
      event: 'stage_end',
      session: args.session,
      seq: args.seq || '1',
      stage,
      requirement: args.requirement || '',
      summary: args.summary || `${stage} stage completed`,
      stageOutput: args.stageOutput || '',
      runCategory: args.runCategory || '',
    });

    // ── P1: Auto-run socratic challenge ──
    // BUGFIX: Skip socratic challenge for terminal stages (DEPLOY, REVIEW).
    // Although SocraticChallenger.challenge() also skips these stages internally,
    // we skip at the bridge level too to avoid wasting resources on:
    // - Unnecessary runSocraticChallenge() call
    // - Unnecessary trace events for skipped stages
    // - Potential race conditions with stale status data
    const TERMINAL_STAGES = new Set(['DEPLOY', 'REVIEW']);
    let socraticResult = null;
    if (TERMINAL_STAGES.has(stage.toUpperCase())) {
      console.error(`[runStageComplete] 💤 Terminal stage ${stage} — skipping socratic challenge at bridge level`);
      socraticResult = {
        success: true,
        subcommand: 'socratic-challenge',
        data: {
          challenged: false, confidence: 1.0, confidenceStatus: 'na',
          confidenceReason: `${stage} is a terminal stage — challenge skipped`,
          shouldRetry: false, advisoryOnly: false, questions: [],
          advisoryQuestions: [], blindSpots: [], triggerReasons: [`terminal_stage_${stage.toLowerCase()}`],
        },
      };
    } else {
      try {
        socraticResult = await runSocraticChallenge({
          projectRoot: args.projectRoot || '.',
        stage,
        session: args.session,
        seq: args.seq || '1',
        requirement: args.requirement || '',
      });
    } catch (socErr) {
      console.error(`[runStageComplete] Socratic challenge failed (non-fatal): ${socErr.message}`);
    }
    } // end else (non-terminal stage)

    console.error(`[runStageComplete] stage_end trace written. traceSuccess=${traceEndResult.success}`);

    // ── Ralph Loop equivalent: MANDATORY_NEXT_ACTION (Stop Hook injection) ──
    // Industry reference: Claude Code's Stop Hook injects nextCommand as a
    // mandatory user message, forcing the agent to continue. We replicate this
    // by surfacing MANDATORY_NEXT_ACTION at the TOP LEVEL (not buried in data),
    // making it impossible for the LLM to treat it as optional information.
    const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
    const currentIdx = stageOrder.indexOf(stage);
    const nextStage = currentIdx >= 0 && currentIdx < stageOrder.length - 1
      ? stageOrder[currentIdx + 1]
      : null;
    const remainingStages = nextStage ? stageOrder.slice(currentIdx + 1) : [];

    // ── Socratic retry gate: if shouldRetry=true and retryCount < maxRetry, force RETRY_STAGE ──
    // Plan A+B: Only force retry when shouldRetry=true (confidence < 0.30).
    // When advisoryOnly=true (0.30 ≤ confidence < 0.62), questions are returned as suggestions only.
    // Anti-infinite-loop: maxRetry=2 cap, enforced via stage_retry trace events.
    const shouldRetry = socraticResult?.data?.shouldRetry === true;
    const advisoryOnly = socraticResult?.data?.advisoryOnly === true;
    const MAX_RETRY = 2;
    const runCategory = args.runCategory || 'prod';
    const tracePath = path.join(args.projectRoot || '.', 'output', 'health', runCategory, 'workflow-trace.jsonl');
    const retryCount = _getStageRetryCount(tracePath, stage, args.session);
    const willRetry = shouldRetry && retryCount < MAX_RETRY;

    if (willRetry) {
      // Write stage_retry trace event so _getStageRetryCount can count it next time
      try {
        const retryTraceEvent = {
          ts: new Date().toISOString(),
          session: args.session,
          seq: args.seq || '1',
          event: 'stage_retry',
          stage,
          data: {
            retryCount: retryCount + 1,
            maxRetry: MAX_RETRY,
            shouldRetry: true,
            confidence: socraticResult?.data?.confidence,
            triggerReasons: socraticResult?.data?.triggerReasons || [],
            questions: socraticResult?.data?.questions || [],
            blindSpots: socraticResult?.data?.blindSpots || [],
          },
        };
        fs.appendFileSync(tracePath, JSON.stringify(retryTraceEvent) + '\n', 'utf-8');
        console.error(`[runStageComplete] ⚠️ RETRY_STAGE: stage=${stage} retryCount=${retryCount + 1}/${MAX_RETRY} confidence=${socraticResult?.data?.confidence}`);
        // Write retry event to human-readable progress log
        _writeProgressLog(args.projectRoot || '.', [
          `⚠️ [RETRY ${retryCount + 1}/${MAX_RETRY}] ${stage} 阶段需要重试`,
          `  session  : ${args.session}`,
          `  reason   : Socratic confidence too low (${socraticResult?.data?.confidence ?? 'n/a'})`,
          `  triggers : ${(socraticResult?.data?.triggerReasons || []).join('; ') || '(none)'}`,
          `  questions: ${(socraticResult?.data?.questions || []).length} question(s) pending`,
          `  action   : Redo stage ${stage} → answer questions → rewrite artifact → re-run workflow-stage`,
        ].join('\n'));
      } catch (retryTraceErr) {
        console.error(`[runStageComplete] ⚠️ Failed to write stage_retry trace (non-fatal): ${retryTraceErr.message}`);
      }

      // ── Write pendingRetry to workflow-status.json ──
      // This is the KEY mechanism for two things:
      // 1. PreToolUse Hook reads this to BLOCK any Bash tool call until retry is done
      // 2. runWorkflowStage reads this to INJECT socratic questions into instructions
      // Without this, RETRY_STAGE is just a suggestion in JSON that LLM can ignore.
      try {
        const statusFilePath = path.join(args.projectRoot || '.', 'output', 'workflow-status.json');
        let statusData = {};
        if (fs.existsSync(statusFilePath)) {
          try { statusData = JSON.parse(fs.readFileSync(statusFilePath, 'utf-8')); } catch { statusData = {}; }
        }
        statusData.pendingRetry = {
          stage,
          session: args.session,
          retryCount: retryCount + 1,
          maxRetry: MAX_RETRY,
          confidence: socraticResult?.data?.confidence ?? null,
          triggerReasons: socraticResult?.data?.triggerReasons || [],
          questions: socraticResult?.data?.questions || [],
          blindSpots: socraticResult?.data?.blindSpots || [],
          setAt: new Date().toISOString(),
          // ── Layer 3: Record artifact hash at retry trigger time ──
          // Used by FORCED_RETRY_GATE in next stage-complete call to detect unchanged artifacts.
          // If LLM submits same artifact again, gate rejects without running Socratic evaluation.
          artifactHashAtRetry: artifactValidation?.hash || null,
        };
        fs.writeFileSync(statusFilePath, JSON.stringify(statusData, null, 2), 'utf-8');
        console.error(`[runStageComplete] ✅ pendingRetry written to workflow-status.json for stage=${stage}`);
      } catch (statusErr) {
        console.error(`[runStageComplete] ⚠️ Failed to write pendingRetry to workflow-status.json (non-fatal): ${statusErr.message}`);
      }
    }

    // ── P2: EvolutionLoop integration (Bridge mode — dual-mode sync [[memory:3xeq8wb9]]) ──
    // Mirrors Orchestrator mode: process blindSpots through EvolutionLoop.
    // blindSpots data is already available from socraticResult (no extra LLM call needed).
    // Only trigger when NOT retrying: retry means blindSpots are "pending improvement",
    // not "confirmed blind spots" worth recording to ExperienceStore.
    // Industry reference: Reflexion (NeurIPS 2023) verbal reinforcement — convert signals
    // to structured knowledge. Voyager critic_agent — quality gate before skill write.
    if (!willRetry && socraticResult?.data?.blindSpots?.length > 0) {
      try {
        const { EvolutionLoop } = require('../core/evolution-loop');
        const evolutionLoop = new EvolutionLoop({ verbose: false, sessionId: args.session });
        evolutionLoop.processSocraticChallenge(stage, {
          questions: socraticResult.data.questions || [],
          blindSpots: socraticResult.data.blindSpots,
          confidence: socraticResult.data.confidence ?? 0,
        });
        console.error(`[runStageComplete] ✅ EvolutionLoop: processed ${socraticResult.data.blindSpots.length} blindSpot(s) for stage=${stage}`);
      } catch (evoErr) {
        console.error(`[runStageComplete] ⚠️ EvolutionLoop integration failed (non-fatal): ${evoErr.message}`);
      }
    }

    // ── F4: Structured Decision Summary (Kiro + OpenCode pattern) ──────────────
    // At stage-complete, extract key decisions from the artifact and persist them
    // so the next stage can consume them as semantic context (not just file paths).
    // Industry reference: Kiro's explicit artifact chain + OpenCode's structured task cards.
    // This bridges the "cold start" gap where next stage only knows file paths exist.
    let stageDecisions = [];
    if (!willRetry) {
      try {
        const artifactFile = _stageToOutputFile(stage);
        const artifactPath = path.join(args.projectRoot || '.', 'output', artifactFile);
        if (fs.existsSync(artifactPath)) {
          const artifactContent = fs.readFileSync(artifactPath, 'utf-8');
          stageDecisions = _extractKeyDecisions(stage, artifactContent);

          // Persist to stage-decisions.json (append, keyed by stage)
          const decisionsPath = path.join(args.projectRoot || '.', 'output', 'stage-decisions.json');
          let allDecisions = {};
          try {
            if (fs.existsSync(decisionsPath)) {
              allDecisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf-8'));
            }
          } catch { allDecisions = {}; }
          allDecisions[stage] = {
            decisions: stageDecisions,
            timestamp: new Date().toISOString(),
            session: args.session,
            artifactHash: artifactValidation?.hash || null,
          };
          // Include requirement fingerprint for requirement-change detection
          try {
            const statusForFp = JSON.parse(fs.readFileSync(path.join(args.projectRoot || '.', 'output', 'workflow-status.json'), 'utf-8'));
            if (statusForFp?.activeWorkflow?.requirementFingerprint) {
              allDecisions._meta = { requirementFingerprint: statusForFp.activeWorkflow.requirementFingerprint };
            }
          } catch { /* non-fatal: fingerprint not available */ }
          fs.writeFileSync(decisionsPath, JSON.stringify(allDecisions, null, 2), 'utf-8');
          console.error(`[runStageComplete] ✅ F4: Extracted ${stageDecisions.length} key decisions for stage=${stage}`);

          // P1-1 fix: Also write stage-context.json (compatible with Node mode's StageContextStore).
          // This ensures Bridge mode produces the same richer context format that Node mode does,
          // enabling subsequent workflow-stage calls to read summary + risks + correctionHistory.
          try {
            const stageCtxPath = path.join(args.projectRoot || '.', 'output', 'stage-context.json');
            let stageCtxData = {};
            if (fs.existsSync(stageCtxPath)) {
              stageCtxData = JSON.parse(fs.readFileSync(stageCtxPath, 'utf-8'));
            }
            // Map Bridge stage names to Node stage names
            const bridgeToNode = { ANALYSE: 'ANALYSE', ARCHITECT: 'ARCHITECT', PLAN: 'PLAN', DEVELOP: 'CODE', TEST: 'TEST', REVIEW: 'REVIEW', DEPLOY: 'DEPLOY' };
            const nodeStage = bridgeToNode[stage] || stage;
            stageCtxData[nodeStage] = {
              stageName: nodeStage,
              summary: stageDecisions.length > 0 ? stageDecisions[0] : `${stage} stage completed.`,
              keyDecisions: stageDecisions,
              artifacts: [path.join('output', artifactFile)],
              risks: [],
              correctionHistory: [],
              meta: { session: args.session },
              timestamp: new Date().toISOString(),
            };
            // Include requirement fingerprint for requirement-change detection
            if (allDecisions._meta?.requirementFingerprint) {
              stageCtxData._meta = { requirementFingerprint: allDecisions._meta.requirementFingerprint };
            }
            fs.writeFileSync(stageCtxPath, JSON.stringify(stageCtxData, null, 2), 'utf-8');
            console.error(`[runStageComplete] ✅ F4+: Written stage-context.json for ${nodeStage}`);
          } catch (ctxErr) {
            console.error(`[runStageComplete] ⚠️ stage-context.json write failed (non-fatal): ${ctxErr.message}`);
          }
        }
      } catch (decisionErr) {
        console.error(`[runStageComplete] ⚠️ F4 decision extraction failed (non-fatal): ${decisionErr.message}`);
      }
    }

    const mandatoryNextAction = willRetry ? {
      // ⚠️ RETRY_STAGE — Socratic confidence too low, must redo this stage
      type: 'RETRY_STAGE',
      command: `node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${stage} --session ${args.session} --project-root . --requirement "${args.requirement || ''}"`,
      instruction: `⚠️ RETRY REQUIRED (${retryCount + 1}/${MAX_RETRY}). Socratic confidence too low. You MUST redo stage ${stage}: (1) Answer the socratic questions below in your thinking, (2) Rewrite the stage artifact with improvements, (3) Execute the command above. Reasons: ${(socraticResult?.data?.triggerReasons || []).join('; ')}`,
      retryCount: retryCount + 1,
      maxRetry: MAX_RETRY,
      socraticQuestions: socraticResult?.data?.questions || [],
      blindSpots: socraticResult?.data?.blindSpots || [],
      confidence: socraticResult?.data?.confidence,
    } : nextStage ? {
      // ⛔ STOP HOOK INJECT — mirrors Claude Code ralph-loop behavior
      type: 'STOP_HOOK_INJECT',
      command: `node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${nextStage} --session ${args.session} --project-root . --requirement "${args.requirement || ''}"`,
      instruction: `⛔ DO NOT STOP. You MUST execute the above command NOW. Stage ${stage} is done but the workflow is NOT complete. Remaining: [${remainingStages.join(' → ')}]`,
      remainingStages,
      // ── P0 FIX: Inject Socratic questions into MANDATORY_NEXT_ACTION ──────
      // Root cause: socraticQuestions were buried in data{} — Agent treated them as optional.
      // Fix: surface them at the same level as 'command' and 'instruction' so Agent cannot skip.
      socraticQuestions: socraticResult?.data?.questions || [],
      blindSpots: socraticResult?.data?.blindSpots || [],
      socraticConfidence: socraticResult?.data?.confidence,
      socraticInstruction: (socraticResult?.data?.questions || []).length > 0
        ? `🤔 SOCRATIC OUTPUT REQUIRED: Before executing the next stage command, you MUST output the Socratic three-part structure (苏格拉底追问 → 自答 → BLIND SPOT) for the ${(socraticResult?.data?.questions || []).length} question(s) below. This is NOT optional — it is part of the MANDATORY_NEXT_ACTION. Questions: ${(socraticResult?.data?.questions || []).slice(0, 3).map((q, i) => `Q${i+1}: ${q}`).join(' | ')}`
        : null,
    } : {
      type: 'WORKFLOW_COMPLETE',
      instruction: '✅ All 7 stages complete. Run session-summary now. Check output/workflow-progress.log for full execution evidence.',
      command: `node workflow/tools/ide-workflow-bridge.js session-summary --requirement "${args.requirement || ''}" --session ${args.session} --project-root .`,
    };

    // ── Update activeWorkflow in workflow-status.json (Hook Enhancement 1.1) ──
    // - Non-retry: add stage to completedStages
    // - WORKFLOW_COMPLETE: delete activeWorkflow entirely
    try {
      const statusFilePath2 = path.join(args.projectRoot || '.', 'output', 'workflow-status.json');
      if (fs.existsSync(statusFilePath2)) {
        let statusData2 = {};
        try { statusData2 = JSON.parse(fs.readFileSync(statusFilePath2, 'utf-8')); } catch { statusData2 = {}; }
        if (statusData2.activeWorkflow) {
          if (mandatoryNextAction.type === 'WORKFLOW_COMPLETE') {
            delete statusData2.activeWorkflow;
            console.error(`[runStageComplete] ✅ activeWorkflow cleared (workflow complete)`);
          } else if (!willRetry) {
            if (!statusData2.activeWorkflow.completedStages) statusData2.activeWorkflow.completedStages = [];
            if (!statusData2.activeWorkflow.completedStages.includes(stage)) {
              statusData2.activeWorkflow.completedStages.push(stage);
            }
            statusData2.activeWorkflow.currentStage = nextStage || stage;
          }
          fs.writeFileSync(statusFilePath2, JSON.stringify(statusData2, null, 2), 'utf-8');
        }
      }
    } catch (activeWfErr2) {
      console.error(`[runStageComplete] ⚠️ Failed to update activeWorkflow (non-fatal): ${activeWfErr2.message}`);
    }

    // ── Write human-readable progress log ──
    const stageCompleteIdx = stageOrder.indexOf(stage);
    const stageCompleteNum = stageCompleteIdx + 1;
    const outputArtifactFile = _stageToOutputFile(stage);
    const outputArtifactPath = path.join(args.projectRoot || '.', 'output', outputArtifactFile);
    const outputExists = fs.existsSync(outputArtifactPath);
    let outputSize = '';
    if (outputExists) {
      try { outputSize = ` (${fs.statSync(outputArtifactPath).size} bytes)`; } catch (_) {}
    }
    // ADR-51: Count both challenge questions AND advisory questions
    const socraticChallengeCount = socraticResult?.data?.questions?.length || 0;
    const socraticAdvisoryCount = socraticResult?.data?.advisoryQuestions?.length || 0;
    const socraticCount = socraticChallengeCount + socraticAdvisoryCount;
    const triggerScoreLabel = socraticResult?.data?.triggerScore !== undefined
      ? ` (score=${socraticResult.data.triggerScore}/${socraticResult.data.triggerThreshold})`
      : '';

    // ── Run metrics gate and include result in progress log ──
    let metricsLine = '  metrics  : (skipped)';
    try {
      const gateResult = runQualityGate({
        projectRoot: args.projectRoot || '.',
        stage,
        session: args.session,
      });
      if (gateResult.success) {
        const gd = gateResult.data || {};
        const passed = gd.passed !== false;
        const errors = gd.errorCount ?? gd.errors ?? 0;
        const duration = gd.durationMs ? `${Math.round(gd.durationMs / 1000)}s` : 'n/a';
        const llmCalls = gd.llmCalls ?? 'n/a';
        metricsLine = `  metrics  : ${passed ? '✅ PASSED' : '❌ FAILED'} (errors:${errors} duration:${duration} llmCalls:${llmCalls})`;
      } else {
        metricsLine = `  metrics  : ⚠️ gate-error: ${gateResult.error || 'unknown'}`;
      }
    } catch (gateErr) {
      metricsLine = `  metrics  : ⚠️ gate-exception: ${gateErr.message}`;
    }

    // ── DEVELOP stage: task coverage verification (F2: Dual-Layer Coverage Detection) ──
    // Industry reference: Kiro's path-matching + Agentless's semantic matching.
    // Layer 1: Match file paths declared in execution-plan.md against files in code.diff
    // Layer 2: Match task description keywords against diff content (semantic fallback)
    // This replaces the broken task-ID-in-diff approach (always 0% because diffs don't contain task IDs).
    let taskCoverageLine = null;
    if (stage === 'DEVELOP') {
      try {
        const execPlanPath = path.join(args.projectRoot || '.', 'output', 'execution-plan.md');
        const codeDiffPath = path.join(args.projectRoot || '.', 'output', 'code.diff');
        if (fs.existsSync(execPlanPath) && fs.existsSync(codeDiffPath)) {
          const planContent = fs.readFileSync(execPlanPath, 'utf-8');
          const diffContent = fs.readFileSync(codeDiffPath, 'utf-8');

          // Check for LIGHTWEIGHT marker first
          const isLightweight = (args.summary || '').includes('[LIGHTWEIGHT]') || diffContent.includes('[LIGHTWEIGHT]');
          if (isLightweight) {
            taskCoverageLine = `  coverage : ✅ [LIGHTWEIGHT] no tasks to verify`;
          } else {
            // ── Layer 1: Path-based matching (Kiro pattern) ──
            // Extract file paths from execution-plan.md (e.g. "workflow/core/foo.js", "src/bar.ts")
            const filePathPattern = /\b([\w\-./]+\.(?:js|ts|py|go|java|cs|rb|rs|cpp|c|h|jsx|tsx|vue|svelte|json|yaml|yml|md))\b/gi;
            const planFilePaths = [...new Set((planContent.match(filePathPattern) || []).map(p => p.toLowerCase()))];
            // Extract changed file paths from diff (lines starting with +++ or --- or diff --git)
            const diffFilePattern = /(?:^\+\+\+\s+[ab]\/|^---\s+[ab]\/|^diff\s+--git\s+a\/)([^\s]+)/gm;
            const diffFilePaths = new Set();
            let diffMatch;
            while ((diffMatch = diffFilePattern.exec(diffContent)) !== null) {
              diffFilePaths.add(diffMatch[1].toLowerCase());
            }

            // Match: plan file path is a suffix of any diff file path (handles relative vs absolute)
            const pathCovered = planFilePaths.filter(planPath => {
              const planBase = planPath.split('/').pop();
              return [...diffFilePaths].some(diffPath =>
                diffPath.endsWith(planPath) || diffPath.endsWith(planBase)
              );
            });

            // ── Layer 2: Semantic keyword matching (Agentless pattern) ──
            // Extract task descriptions from plan (lines with task markers or bullet points)
            const taskLines = planContent.split('\n').filter(line =>
              /^\s*[-*]\s+|^\s*\d+\.\s+|^#+\s+.*task|\bT-\d+|\bTASK-\d+/i.test(line)
            );
            const diffContentLower = diffContent.toLowerCase();
            // Extract meaningful keywords from task descriptions (3+ chars, not common words)
            const commonWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'will', 'should', 'must', 'can', 'not', 'all', 'are', 'was', 'has', 'have', 'been', 'into', 'each', 'add', 'use', 'new', 'file', 'code', 'output', 'input', 'data', 'test', 'make', 'update', 'create']);
            const taskKeywords = new Set();
            for (const line of taskLines) {
              const words = line.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g) || [];
              for (const w of words) {
                if (!commonWords.has(w)) taskKeywords.add(w);
              }
            }
            const keywordHits = [...taskKeywords].filter(kw => diffContentLower.includes(kw));
            const keywordCoverage = taskKeywords.size > 0 ? keywordHits.length / taskKeywords.size : 0;

            // ── Combined coverage score ──
            const pathCoverage = planFilePaths.length > 0 ? pathCovered.length / planFilePaths.length : 0;
            // Weighted: path matching is more reliable (70%), keyword is supplementary (30%)
            const combinedCoverage = planFilePaths.length > 0
              ? Math.round((pathCoverage * 0.7 + keywordCoverage * 0.3) * 100)
              : Math.round(keywordCoverage * 100);

            const coverageStatus = combinedCoverage >= 80 ? '✅' : combinedCoverage >= 50 ? '⚠️' : '❌';
            const details = [];
            if (planFilePaths.length > 0) {
              details.push(`paths:${pathCovered.length}/${planFilePaths.length}`);
            }
            if (taskKeywords.size > 0) {
              details.push(`keywords:${keywordHits.length}/${taskKeywords.size}`);
            }
            taskCoverageLine = `  coverage : ${coverageStatus} ${combinedCoverage}% (${details.join(', ')})`;
          }
        }
      } catch (coverageErr) {
        console.error(`[runStageComplete] Task coverage check failed (non-fatal): ${coverageErr.message}`);
      }
    }

    // ── Progress log: distinguish retry from completion ──
    // P0 FIX: When willRetry=true, do NOT write "✅ 阶段完成" — this sends a contradictory
    // signal that causes LLM to skip the retry. Instead write a clear "⏳ 阶段待重试" message.
    if (willRetry) {
      _writeProgressLog(args.projectRoot || '.', [
        `⏳ [${stageCompleteNum}/7] ${stage} 阶段待重试 (Socratic confidence too low)`,
        `  session  : ${args.session}`,
        `  output   : output/${outputArtifactFile}${outputExists ? outputSize : ' (not found)'}`,
        `  summary  : ${args.summary || '(no summary)'}`,
      `  socratic : ${socraticChallengeCount} challenge(s)${triggerScoreLabel} — MUST answer before retry`,
        metricsLine,
        `  action   : Re-run workflow-stage --stage ${stage} to redo this stage`,
      ].filter(Boolean).join('\n'));
    } else {
      _writeProgressLog(args.projectRoot || '.', [
        `✅ [${stageCompleteNum}/7] ${stage} 阶段完成`,
        `  session  : ${args.session}`,
        `  output   : output/${outputArtifactFile}${outputExists ? outputSize : ' (not found)'}`,
        `  summary  : ${args.summary || '(no summary)'}`,
      `  socratic : ${socraticCount} question(s)${socraticAdvisoryCount > 0 ? ` (${socraticChallengeCount} challenge + ${socraticAdvisoryCount} advisory)` : ''}${triggerScoreLabel}`,
        metricsLine,
        taskCoverageLine,
        nextStage ? `  next     : ${nextStage}` : `  next     : (workflow complete)`,
      ].filter(Boolean).join('\n'));
    }

    // ── stderr MANDATORY banner (Hook Enhancement 2.1) ──────────────────────
    // Output a visually prominent banner to stderr so LLM cannot miss the next action.
    // stderr is shown to LLM as debug output — more attention-grabbing than JSON fields.
    if (mandatoryNextAction.type === 'STOP_HOOK_INJECT') {
      // ── Socratic questions stderr output (P0 FIX: make visible to Agent) ──
      const sqQuestions = socraticResult?.data?.questions || [];
      const sqBlindSpots = socraticResult?.data?.blindSpots || [];
      const sqConfidence = socraticResult?.data?.confidence;
      const sqLines = [];
      if (sqQuestions.length > 0) {
        sqLines.push(`║  🤔 SOCRATIC OUTPUT REQUIRED (${sqQuestions.length} questions):          ║`);
        sqQuestions.slice(0, 3).forEach((q, i) => {
          const qTrunc = q.length > 56 ? q.slice(0, 53) + '...' : q;
          sqLines.push(`║    Q${i + 1}: ${qTrunc.padEnd(54)}║`);
        });
        if (sqQuestions.length > 3) sqLines.push(`║    ... and ${sqQuestions.length - 3} more question(s)                              ║`);
        if (sqBlindSpots.length > 0) sqLines.push(`║    ⚠️  ${sqBlindSpots.length} blind spot(s) detected                                ║`);
        const confLabel = sqConfidence != null ? `${Math.round(sqConfidence * 100)}%` : 'N/A';
        sqLines.push(`║    Confidence: ${confLabel.padEnd(44)}║`);
        sqLines.push(`╠══════════════════════════════════════════════════════════════╣`);
        sqLines.push(`║  ⛔ You MUST output 苏格拉底追问 three-part structure       ║`);
        sqLines.push(`║    BEFORE executing the next stage command.                 ║`);
      }
      console.error([
        ``,
        `╔══════════════════════════════════════════════════════════════╗`,
        `║  ⛔ WORKFLOW CONTINUES — DO NOT STOP                        ║`,
        `╠══════════════════════════════════════════════════════════════╣`,
        ...sqLines,
        `║  Next: ${(nextStage || '').padEnd(10)} (${stageOrder.indexOf(nextStage) + 1}/7)                                ║`,
        `║  Remaining: ${remainingStages.join(' → ').slice(0, 44).padEnd(44)} ║`,
        `╚══════════════════════════════════════════════════════════════╝`,
        `⛔ RUN NOW: ${mandatoryNextAction.command.slice(0, 100)}`,
        ``,
      ].join('\n'));
    } else if (mandatoryNextAction.type === 'RETRY_STAGE') {
      console.error([
        ``,
        `╔══════════════════════════════════════════════════════════════╗`,
        `║  ⛔ STAGE NOT COMPLETE — RETRY REQUIRED                     ║`,
        `║  Stage: ${stage.padEnd(10)} Confidence: ${String(Math.round((socraticResult?.data?.confidence ?? 0) * 100) + '%').padEnd(5)}                    ║`,
        `╠══════════════════════════════════════════════════════════════╣`,
        `║  This stage-complete returned success=false.                ║`,
        `║  You MUST re-run workflow-stage for ${stage.padEnd(10)} now.            ║`,
        `╚══════════════════════════════════════════════════════════════╝`,
        `⛔ RUN NOW: ${mandatoryNextAction.command.slice(0, 120)}`,
        ``,
      ].join('\n'));
    } else if (mandatoryNextAction.type === 'WORKFLOW_COMPLETE') {
      console.error([
        ``,
        `╔══════════════════════════════════════════════════════════════╗`,
        `║  ✅ ALL 7 STAGES COMPLETE — Run session-summary now         ║`,
        `╚══════════════════════════════════════════════════════════════╝`,
        `✅ RUN NOW: ${mandatoryNextAction.command.slice(0, 100)}`,
        ``,
      ].join('\n'));
    }

    // ── P0: Code-Forced Self-Report (Plan A: 100% compliance) ──────────────
    // Replaces prompt-based self-report (0% compliance across 125 attempts).
    // Builds report from deterministic data sources already available at this point:
    //   - artifactValidation: hash, lineCount, path (from _validateArtifact)
    //   - socraticResult: confidence, questions, blindSpots (from runSocraticChallenge)
    //   - metricsGate: passed, errors, duration (from runQualityGate)
    //   - traceEvents: stage_start/stage_end timestamps (from workflow-trace.jsonl)
    // Zero LLM calls. 100% compliance. Richer data than prompt-based approach.
    let codeForcedReport = null;
    try {
      const { buildCodeForcedReport, selfReportCollector } = require('../core/agent-self-report');

      // Collect trace events for this session
      const runCat = args.runCategory || 'prod';
      const tracePathForReport = path.join(args.projectRoot || '.', 'output', 'health', runCat, 'workflow-trace.jsonl');
      const traceEventsForReport = _getRecentTrace(tracePathForReport, args.session || '', 20);

      // Collect metrics gate data (already computed above as metricsLine, but we need structured data)
      let metricsGateData = null;
      try {
        const gateResult = runQualityGate({
          projectRoot: args.projectRoot || '.',
          stage,
          session: args.session,
        });
        if (gateResult.success) {
          metricsGateData = gateResult;
        }
      } catch { /* non-fatal */ }

      codeForcedReport = buildCodeForcedReport({
        stage,
        session: args.session || '',
        artifactValidation,
        socraticResult,
        metricsGate: metricsGateData,
        traceEvents: traceEventsForReport,
        summary: args.summary || '',
        projectRoot: args.projectRoot || '.',
      });

      // Record to collector (persisted to JSONL at session teardown)
      selfReportCollector.recordCodeForced(stage, codeForcedReport, {
        mode: 'ide-bridge',
        session: args.session,
      });

      console.error(
        `[runStageComplete] 📊 Code-forced self-report: stage=${stage} ` +
        `confidence=${codeForcedReport.confidence}/5 ` +
        `decisions=${codeForcedReport.decisions.length} ` +
        `blockers=${codeForcedReport.blockers.length} ` +
        `filesWritten=${codeForcedReport.filesWritten.length}`
      );

      // Persist immediately (don't wait for session teardown — bridge mode has no teardown)
      selfReportCollector._outputDir = path.join(args.projectRoot || '.', 'output');
      selfReportCollector._sessionId = args.session || `bridge-${Date.now()}`;
      selfReportCollector.flush();
    } catch (reportErr) {
      // Non-fatal: self-report collection must never break the pipeline
      console.error(`[runStageComplete] ⚠️ Code-forced self-report failed (non-fatal): ${reportErr.message}`);
    }

    // ── P0 FIX: Return success=false when retry is required ──
    // Root cause of "triggered retry but didn't execute": stage-complete returned
    // success=true even when willRetry=true. LLM sees success=true and treats the
    // stage as done, ignoring the RETRY_STAGE signal buried in MANDATORY_NEXT_ACTION.
    // Fix: return success=false with a clear error message when retry is needed.
    // This is CODE-FORCED enforcement — LLM cannot misinterpret success=false.
    if (willRetry) {
      return {
        success: false,
        subcommand: 'stage-complete',
        error: `[RETRY_REQUIRED] Stage ${stage} did not pass Socratic review (confidence: ${Math.round((socraticResult?.data?.confidence ?? 0) * 100)}%). You MUST re-run this stage.`,
        MANDATORY_NEXT_ACTION: mandatoryNextAction,
        RETRY_CONTEXT: {
          retryCount: retryCount + 1,
          maxRetry: MAX_RETRY,
          confidence: socraticResult?.data?.confidence,
          socraticQuestions: socraticResult?.data?.questions || [],
          blindSpots: socraticResult?.data?.blindSpots || [],
          triggerReasons: socraticResult?.data?.triggerReasons || [],
          command: mandatoryNextAction.command,
          instruction: `⛔ STAGE NOT COMPLETE. You MUST execute: ${mandatoryNextAction.command}`,
        },
        data: {
          stage,
          session: args.session,
          traceWritten: traceEndResult.success,
          artifactValidated: !artifactValidation.skipped && artifactValidation.valid,
          artifactHash: artifactValidation.hash || null,
          selfReport: codeForcedReport ? {
            confidence: codeForcedReport.confidence,
            blockers: codeForcedReport.blockers.length,
            source: 'code-forced',
          } : null,
        },
      };
    }

    return {
      success: true,
      subcommand: 'stage-complete',
      // ⛔ MANDATORY_NEXT_ACTION is at TOP LEVEL — not in data — so LLM cannot ignore it
      MANDATORY_NEXT_ACTION: mandatoryNextAction,
      data: {
        stage,
        session: args.session,
      traceWritten: traceEndResult.success,
        socraticQuestions: socraticResult?.data?.questions || [],
        nextStage,
        // Keep nextCommand for backward compatibility
        nextCommand: mandatoryNextAction.command,
        // ── P1: Observation Loop — artifact verification result ──
        // LLM can confirm the artifact was validated and get its hash for cross-stage traceability.
        artifactValidated: !artifactValidation.skipped && artifactValidation.valid,
        artifactHash: artifactValidation.hash || null,
        artifactLines: artifactValidation.lineCount || null,
        // ── P0: Code-Forced Self-Report (Plan A) ──
        // Included in return data so LLM can see what was collected.
        selfReport: codeForcedReport ? {
          confidence: codeForcedReport.confidence,
          blockers: codeForcedReport.blockers.length,
          filesWritten: codeForcedReport.filesWritten.length,
          source: 'code-forced',
        } : null,
      },
    };
  } catch (err) {
    console.error(`[runStageComplete] Error: ${err.message}`);
    return {
      success: false,
      subcommand: 'stage-complete',
      error: err.message,
    };
  }
}

// ─── Sub-command: plan-amend (ADR-49 P1-C) ──────────────────────────────────

/**
 * Plan Amendment — Locally amend execution-plan.md during CODE stage.
 *
 * This is the IDE Agent mode counterpart of the Node Orchestrator's
 * _microPlanAmend() function (ADR-48). It allows the IDE Agent to emit
 * plan amendments without triggering a full PLAN rollback.
 *
 * Required args:
 *   --task-id       Task ID to amend (e.g. T-03)
 *   --reason        Why the plan needs amendment
 *   --amendment     The revised task description
 *
 * Optional args:
 *   --project-root  Project root (default: .)
 *   --plan-file     Path to execution-plan.md (default: output/execution-plan.md)
 */
function runPlanAmend(args) {
  try {
    const taskId = (args.taskId || args['task-id'] || '').toUpperCase();
    const reason = args.reason || '';
    const amendment = args.amendment || '';
    const projectRoot = args.projectRoot || args['project-root'] || '.';
    const planFile = args.planFile || args['plan-file'] || 'output/execution-plan.md';

    if (!taskId || !reason) {
      return {
        success: false,
        subcommand: 'plan-amend',
        error: 'Missing required args: --task-id and --reason are required.',
        usage: 'node ide-workflow-bridge.js plan-amend --task-id T-03 --reason "config.json does not exist" --amendment "Use config.yaml instead"',
      };
    }

    const planPath = path.resolve(projectRoot, planFile);
    if (!fs.existsSync(planPath)) {
      return {
        success: false,
        subcommand: 'plan-amend',
        error: `Execution plan not found: ${planPath}`,
        fixInstruction: 'Run the PLAN stage first to generate execution-plan.md.',
      };
    }

    const MICRO_PLAN_AMEND_MARKER = '<!-- MICRO-PLAN-AMEND -->';
    const currentPlan = fs.readFileSync(planPath, 'utf-8');
    const existingAmendCount = (currentPlan.match(new RegExp(MICRO_PLAN_AMEND_MARKER, 'g')) || []).length;
    const maxAmendments = 5;

    if (existingAmendCount >= maxAmendments) {
      return {
        success: false,
        subcommand: 'plan-amend',
        error: `Amendment cap reached (${maxAmendments}). Too many deviations suggest the plan needs full revision.`,
        recommendation: 'Re-run the PLAN stage with updated requirements.',
        existingAmendments: existingAmendCount,
      };
    }

    const amendNum = existingAmendCount + 1;
    const block = [
      '',
      MICRO_PLAN_AMEND_MARKER,
      `## Amendment #${amendNum} (IDE Agent — manual amendment)`,
      `- **Task**: ${taskId}`,
      `- **Reason**: ${reason}`,
      amendment ? `- **Amended**: ${amendment}` : '',
      `- **Impact**: Downstream tasks may need adjustment`,
      `- **Timestamp**: ${new Date().toISOString()}`,
      '',
    ].filter(Boolean).join('\n');

    fs.appendFileSync(planPath, '\n' + block, 'utf-8');
    console.error(`[plan-amend] 📝 Amendment #${amendNum} appended to ${planFile} (task: ${taskId})`);

    return {
      success: true,
      subcommand: 'plan-amend',
      data: {
        amendmentNumber: amendNum,
        taskId,
        reason,
        amendment: amendment || null,
        totalAmendments: amendNum,
        planFile,
        remainingCap: maxAmendments - amendNum,
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'plan-amend',
      error: `plan-amend failed: ${err.message}`,
    };
  }
}

// ─── Sub-command: skill-evolve ───────────────────────────────────────────────

/**
 * Skill Evolution — Explicitly trigger skill evolution from experience/feedback.
 *
 * Differ from experience-evolve:
 *   - experience-evolve: Purge/distill/audit ALL experiences (batch operation)
 *   - skill-evolve: Evolve ONE specific skill with new knowledge
 *
 * Why: Manual skill updates when experience hasn't accumulated enough hits
 * to auto-trigger evolution.
 */
// ─── Sub-command: skill-evolve ───────────────────────────────────────────────

/**
 * Skill Evolution — Explicitly trigger skill evolution from experience/feedback.
 *
 * Differ from experience-evolve:
 *   - experience-evolve: Purge/distill/audit ALL experiences (batch operation)
 *   - skill-evolve: Evolve ONE specific skill with new knowledge
 *
 * Why: Manual skill updates when experience hasn't accumulated enough hits
 * to auto-trigger evolution.
 */
function runSkillEvolve(args) {
  try {
    const skillName = args.skillName;

    if (!skillName) {
      return {
        success: false,
        subcommand: 'skill-evolve',
        error: 'Missing --skill-name. Example: --skill-name "error-handling-nodejs"',
      };
    }

    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const engine = new SkillEvolutionEngine();

    // Get skill data from registry Map
    const skill = engine.registry.get(skillName);
    if (!skill) {
      // List available skills for hint
      const allSkills = engine.listSkills().map(s => s.name);
      return {
        success: false,
        subcommand: 'skill-evolve',
        error: `Skill "${skillName}" not found in registry.`,
        availableSkills: allSkills.slice(0, 15),
        hint: 'Use skill-health to see all registered skills.',
      };
    }

    // Check if reason/title/content are provided for evolution
    if (!args.content && !args.title && !args.reason) {
      // If no explicit content, just return the skill info and lifecycle report
      const report = engine.getLifecycleReport();
      const skillReport = report.skills.find(s => s.name === skillName);

      return {
        success: true,
        subcommand: 'skill-evolve',
        data: {
          skillName,
          evolved: false,
          skill: skillReport || skill,
          lineage: engine.getLineage(skillName),
          message: `Skill "${skillName}" found. Provide --content, --title, or --reason to trigger evolution.`,
          hint: 'Example: --title "New best practice" --content "Always use X" --section "Best Practices"',
        },
      };
    }

    // Run evolution using the evolve() method
    // evolve(skillName, { section, title, content, sourceExpId, reason })
    const evolveResult = engine.evolve(skillName, {
      section: args.section || 'Best Practices',
      title: args.title || args.reason || 'Manual update',
      content: args.content || 'No content provided.',
      reason: args.reason || 'Manual evolution via CLI',
      sourceExpId: args.sourceExpId || null,
    });

    // Reload to get updated skill data
    const updatedSkill = engine.registry.get(skillName);

    return {
      success: true,
      subcommand: 'skill-evolve',
      data: {
        skillName,
        evolved: evolveResult,
        version: updatedSkill?.version || skill.version,
        evolutionCount: updatedSkill?.evolutionCount || skill.evolutionCount,
        message: evolveResult
          ? `Skill "${skillName}" evolved successfully to v${updatedSkill?.version || skill.version}.`
          : `Skill "${skillName}" evolution completed (no changes needed).`,
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'skill-evolve',
      error: err.message,
    };
  }
}

// ─── Sub-command: skill-update ───────────────────────────────────────────────

/**
 * Skill Update — Manually update skill metadata or content.
 *
 * Why: When skill content needs correction or enhancement outside
 * the normal evolution cycle.
 */
function runSkillUpdate(args) {
  try {
    const skillName = args.skillName;

    if (!skillName) {
      return {
        success: false,
        subcommand: 'skill-update',
        error: 'Missing --skill-name. Example: --skill-name "test-writing-jest"',
      };
    }

    if (!args.content && !args.title && Object.keys(args.metadata || {}).length === 0) {
      return {
        success: false,
        subcommand: 'skill-update',
        error: 'Nothing to update. Provide at least one of: --content, --title, --tags, or --metadata',
      };
    }

    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const engine = new SkillEvolutionEngine();

    const skill = engine.registry.get(skillName);
    if (!skill) {
      const allSkills = engine.listSkills().map(s => s.name);
      return {
        success: false,
        subcommand: 'skill-update',
        error: `Skill "${skillName}" not found.`,
        availableSkills: allSkills.slice(0, 15),
      };
    }

    // Apply updates directly to skill metadata
    const updatedFields = [];
    let contentUpdate = null;

    if (args.title) {
      skill.description = args.title;
      updatedFields.push('description');
    }

    if (args.tags) {
      const tags = Array.isArray(args.tags) ? args.tags : args.tags.split(',').map(t => t.trim());
      skill.domains = [...new Set([...skill.domains, ...tags])];
      updatedFields.push('domains');
    }

    if (args.metadata && args.metadata.maxTokens) {
      skill.maxTokens = args.metadata.maxTokens;
      updatedFields.push('maxTokens');
    }

    if (args.metadata && args.metadata.loadLevel) {
      skill.loadLevel = args.metadata.loadLevel;
      updatedFields.push('loadLevel');
    }

    if (args.content) {
      contentUpdate = args.content;
      updatedFields.push('fileContent');
      // Content evolution via the evolve method
      engine.evolve(skillName, {
        section: args.section || 'Best Practices',
        title: args.title || 'Manual update',
        content: args.content,
        reason: args.reason || 'Manual update via CLI',
      });
    }

    return {
      success: true,
      subcommand: 'skill-update',
      data: {
        skillName,
        updated: updatedFields.length > 0,
        fields: updatedFields,
        version: skill.version,
        message: updatedFields.length > 0
          ? `Skill "${skillName}" updated successfully. Fields: ${updatedFields.join(', ')}`
          : `No changes made to "${skillName}".`,
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'skill-update',
      error: err.message,
    };
  }
}

// ─── Skill Ablation Test ─────────────────────────────────────────────────────

/**
 * skill-ablation — Run Skill Ablation Test to quantify per-skill ROI
 *
 * Inspired by ML ablation studies: remove one component at a time and measure
 * the impact. Uses existing lifecycle data (usageCount, effectiveCount) to
 * estimate each skill's contribution without actually removing anything.
 *
 * Options:
 *   --project-root     Project root path
 *   --min-usage        Minimum usage count to include (default: 3)
 *   --format           Output format: 'json' | 'markdown' (default: 'json')
 *
 * Usage:
 *   node workflow/tools/ide-workflow-bridge.js skill-ablation --project-root .
 */
function runSkillAblation(args) {
  try {
    const { EvolutionLoop } = require('../core/evolution-loop');
    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const { PATHS, getDefaultOutputDir } = require('../core/constants');

    const projectRoot = args.projectRoot || args['project-root'] || process.cwd();
    const minUsage = args.minUsage || args['min-usage'] || 3;
    const format = args.format || 'json';

    // Initialize SkillEvolutionEngine
    const engine = new SkillEvolutionEngine();

    // Create EvolutionLoop with the engine
    const loop = new EvolutionLoop({
      skillEvolution: engine,
      outputDir: getDefaultOutputDir(),
      verbose: false,
    });

    // Run ablation test
    const result = loop.runAblationTest({ minUsageCount: Number(minUsage) });

    if (!result.success) {
      return {
        success: false,
        subcommand: 'skill-ablation',
        error: 'Ablation test failed. SkillEvolutionEngine may not be available.',
      };
    }

    // Format output
    const output = format === 'markdown'
      ? { markdown: loop.formatAblationReport(result) }
      : result.report;

    return {
      success: true,
      subcommand: 'skill-ablation',
      data: {
        ...output,
        recommendations: result.recommendations,
        summary: {
          totalSkills: result.report.totalSkills,
          analyzed: result.report.analyzed,
          skipped: result.report.skipped,
          avgEffectiveness: result.report.avgEffectiveness,
          positiveROI: result.report.positiveROICount,
          negativeROI: result.report.negativeROICount,
        },
        hint: format !== 'markdown'
          ? 'Use --format markdown for a human-readable report.'
          : undefined,
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'skill-ablation',
      error: err.message,
    };
  }
}

// ─── EvoSkill: Failure Pattern Analysis ──────────────────────────────────────

/**
 * failure-pattern-analyze — Analyze recent failures and generate Skill proposals
 *
 * EvoSkill Insight: Failure Pattern → Skill Recommendation
 * - Extracts signatures from introspection collector
 * - Clusters similar failures (deduplication)
 * - Generates skill proposals for frequent patterns (optional LLM)
 *
 * Options:
 *   --project-root     Project root path
 *   --enable-llm       Enable LLM-based skill proposal generation (optional)
 *   --min-occurrence   Minimum occurrences to trigger proposal (default: 2)
 *   --export           Export pattern data to JSON file
 *
 * Usage:
 *   node workflow/tools/ide-workflow-bridge.js failure-pattern-analyze --project-root .
 *   node workflow/tools/ide-workflow-bridge.js failure-pattern-analyze --project-root . --enable-llm
 */
async function runFailurePatternAnalyze(args) {
  try {
    const { failurePatternAnalyzer } = require('../core/failure-pattern-analyzer');

    // Configure analyzer
    const minOccurrence = parseInt(args.minOccurrence, 10) || 2;
    failurePatternAnalyzer._minOccurrenceThreshold = minOccurrence;

    // Optional: Enable LLM for skill proposal generation
    if (args.enableLlm) {
      const { cheapLlmCall } = require('../shared/llm-service');
      failurePatternAnalyzer._llmCall = cheapLlmCall;
    }

    // Run analysis
    const result = await failurePatternAnalyzer.analyzeRecentFailures();

    // Export if requested
    let exportPath = null;
    if (args.export && args.projectRoot) {
      const fs = require('fs');
      const path = require('path');
      const outputDir = path.join(args.projectRoot, '.workflow', 'output');
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      exportPath = path.join(outputDir, 'failure-patterns.json');
      fs.writeFileSync(exportPath, JSON.stringify(result, null, 2), 'utf-8');
    }

    return {
      success: true,
      subcommand: 'failure-pattern-analyze',
      data: {
        patterns: result.patterns.map(p => ({
          key: p.key,
          hash: p.hash,
          count: p.count,
          skillGenerated: p.skillGenerated,
        })),
        skillProposals: result.skillProposals,
        stats: result.stats,
        exportedTo: exportPath,
        mode: args.enableLlm ? 'llm-enabled' : 'signature-only',
      },
      message: `Analysis complete: ${result.stats.totalPatterns} patterns, ${result.stats.frequentPatterns} frequent, ${result.stats.proposalsGenerated} proposals generated.`,
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'failure-pattern-analyze',
      error: err.message,
    };
  }
}

// ─── Sub-command: issue-pattern-collect ──────────────────────────────────────

/**
 * Collect and record issue patterns (orphan modules, broken routes, missing
 * artifacts) to ExperienceStore for self-evolution awareness.
 *
 * This is the IDE Agent (Bridge) counterpart to the automatic issue collection
 * that runs in Node Orchestrator teardown. It allows manual triggering from
 * the IDE, ensuring dual-mode parity (ADR-37).
 *
 * @param {object} args
 * @returns {Promise<{success: boolean, subcommand: string, data?: object, error?: string}>}
 */
async function runIssuePatternCollect(args) {
  try {
    const { IssuePatternCollector, IssueType, IssueSeverity } = require('../core/issue-pattern-collector');
    const fs = require('fs');
    const path = require('path');

    const projectRoot = args.projectRoot || process.cwd();
    const outputDir = path.join(projectRoot, '.workflow', 'output');

    // Load ExperienceStore (shared singleton from project .workflow directory)
    let experienceStore = null;
    try {
      const { ExperienceStore } = require('../core/experience-store');
      const storePath = path.join(projectRoot, '.workflow', 'experience-store.json');
      experienceStore = new ExperienceStore({ storePath, autoSave: true });
    } catch (_e) {
      // ExperienceStore not available — collector will run in dry-run mode
    }

    const collector = new IssuePatternCollector(experienceStore, {
      projectContext: path.basename(projectRoot),
      verbose: args.verbose || false,
    });

    // Scan for known issue categories
    let scannedIssues = 0;

    // 1. Check for missing expected artifacts (using recordArtifactMissing)
    const expectedArtifacts = ['analysis.md', 'execution-plan.md', 'review-output.md'];
    for (const artifact of expectedArtifacts) {
      const artifactPath = path.join(outputDir, artifact);
      if (!fs.existsSync(artifactPath)) {
        collector.recordArtifactMissing({
          artifact,
          expectedPath: artifactPath,
          stage: artifact.replace('.md', ''),
        });
        scannedIssues++;
      }
    }

    // 2. Check for stale artifacts (older than stageContextMaxAgeHours)
    try {
      const config = require('../workflow.config');
      const maxAgeHours = config?.stageContextMaxAgeHours || 24;
      const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir);
        const now = Date.now();
        for (const file of files) {
          const stat = fs.statSync(path.join(outputDir, file));
          if (now - stat.mtimeMs > maxAgeMs) {
            // Use recordIssue with proper IssueType enum for staleness
            collector.recordIssue({
              type: IssueType.FORMAT_MISMATCH,
              severity: IssueSeverity.LOW,
              module: file,
              description: `Artifact ${file} is older than ${maxAgeHours}h (staleness threshold)`,
              suggestedFix: `Re-run the workflow to refresh ${file}`,
            });
            scannedIssues++;
          }
        }
      }
    } catch (_e) {
      // Non-fatal: staleness check failure
    }

    // Summarize collected issues (recordIssue already wrote to ExperienceStore)
    const summary = collector.generateSummary();

    return {
      success: true,
      subcommand: 'issue-pattern-collect',
      data: {
        scannedIssues,
        recordedToExperienceStore: summary.total,
        hasExperienceStore: experienceStore !== null,
        projectRoot,
        summary,
      },
      message: summary.total > 0
        ? `Found ${summary.total} issue(s) recorded to ExperienceStore.`
        : 'No issues found — all clear.',
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'issue-pattern-collect',
      error: err.message,
    };
  }
}

// ─── Declarative Teardown Pipeline (P0 teardown-impl) ────────────────────────

function runTeardownPipeline(args) {
  try {
    const { createTeardownPipeline } = require('../core/teardown-steps');
    const pipeline = createTeardownPipeline();
    const summary = pipeline.toBridgeSummary();

    // If args.action is 'run', also execute the pipeline (Bridge-initiated teardown)
    if (args.action === 'run') {
      const { TeardownContext } = require('../core/teardown-pipeline');
      const outputDir = args.outputDir || path.join(process.cwd(), 'output');

      const ctx = new TeardownContext({
        orch: { _outputDir: outputDir, _verbose: false },
        mode: 'ide-bridge',
        extra: {},
        shouldEvolve: {},
      });

      // Execute is async, but Bridge commands should return immediately
      pipeline.execute(ctx).then(result => {
        console.error(`[Bridge] Teardown pipeline completed: ${result.executed} executed, ${result.skipped} skipped, ${result.failed} failed`);
      }).catch(err => {
        console.error(`[Bridge] Teardown pipeline error: ${err.message}`);
      });
    }

    return {
      success: true,
      subcommand: 'teardown-pipeline',
      data: {
        action: args.action || 'status',
        pipeline: summary,
      },
      message: `Teardown pipeline: ${summary.totalSteps} step(s) registered. Action: ${args.action || 'status'}`,
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'teardown-pipeline',
      error: err.message,
    };
  }
}

// ─── GDE L1: Output Degradation ──────────────────────────────────────────────

function runDegradeOutput(args) {
  try {
    const { OutputDegradationEngine } = require('../core/output-degradation');
    const engine = new OutputDegradationEngine();
    const rawOutput = args.artifactContent || '';
    const role = args.role || 'developer';
    const result = engine.degrade(rawOutput, role, { taskText: args.task || '' });
    return {
      success: true,
      level: result.level,
      repairs: result.repairs,
      output: result.output,
      metrics: result.metrics,
    };
  } catch (err) {
    return { success: false, error: `degrade-output failed: ${err.message}` };
  }
}

function runDegradeCheck(args) {
  try {
    const { OutputDegradationEngine } = require('../core/output-degradation');
    const engine = new OutputDegradationEngine();
    const rawOutput = args.artifactContent || '';
    const role = args.role || 'developer';
    const needsDegradation = engine.needsDegradation(rawOutput, role);
    return {
      success: true,
      needsDegradation,
      role,
      outputLength: rawOutput.length,
    };
  } catch (err) {
    return { success: false, error: `degrade-check failed: ${err.message}` };
  }
}

// ─── EKIC: Expert Knowledge ─────────────────────────────────────────────────

function runInjectExpert(args) {
  try {
    const { ExpertKnowledgeChannel } = require('../core/expert-knowledge-channel');
    const projectRoot = path.resolve(args.projectRoot || '.');
    const channel = new ExpertKnowledgeChannel({ projectRoot });
    channel.loadFromDirectory();

    // Inline injection
    const name = args.title || `CLI-${Date.now()}`;
    const content = args.content || '';
    if (!content) {
      return { success: false, error: 'Content is required. Use --content "..."' };
    }

    const scope = args.role ? [args.role] : ['analyst', 'architect', 'developer', 'tester'];
    const tags = args.tags && args.tags.length > 0 ? args.tags : [];

    const result = channel.inject({
      name,
      content,
      scope,
      priority: args.type || 'medium',
      tags,
      source: 'cli',
      persist: true,
    });

    return {
      success: result.success,
      name: result.name,
      layer: result.layer,
      conflicts: result.conflicts,
      error: result.error,
    };
  } catch (err) {
    return { success: false, error: `inject-expert failed: ${err.message}` };
  }
}

function runListExperts(args) {
  try {
    const { ExpertKnowledgeChannel } = require('../core/expert-knowledge-channel');
    const projectRoot = path.resolve(args.projectRoot || '.');
    const channel = new ExpertKnowledgeChannel({ projectRoot });
    channel.loadFromDirectory();

    const filter = {};
    if (args.role) filter.role = args.role;
    if (args.type) filter.priority = args.type;

    const experts = channel.list(filter);
    return {
      success: true,
      count: experts.length,
      experts,
      stats: channel.getStats(),
    };
  } catch (err) {
    return { success: false, error: `list-experts failed: ${err.message}` };
  }
}

function runExpertBlock(args) {
  try {
    const { ExpertKnowledgeChannel } = require('../core/expert-knowledge-channel');
    const projectRoot = path.resolve(args.projectRoot || '.');
    const channel = new ExpertKnowledgeChannel({ projectRoot });
    channel.loadFromDirectory();

    const role = args.role || 'developer';
    const taskText = args.task || '';
    const block = channel.getExpertBlock(role, taskText);

    return {
      success: true,
      role,
      block,
      blockLength: block.length,
      estimatedTokens: Math.ceil(block.length / 4),
    };
  } catch (err) {
    return { success: false, error: `expert-block failed: ${err.message}` };
  }
}

async function runExpertGenerate(args) {
  try {
    const { generateExpertFromFiles } = require('../core/expert-knowledge-channel');
    const projectRoot = path.resolve(args.projectRoot || '.');
    const files = args.files || [];
    if (files.length === 0) {
      return { success: false, error: 'No files provided. Use --files "file1.js,file2.js"' };
    }

    // Try to get a cheap LLM call
    let cheapLlmCall = null;
    try {
      const { LLMRouter } = require('../core/llm-router');
      const router = new LLMRouter();
      cheapLlmCall = async (prompt) => {
        const result = await router.call('system', prompt, { tier: 'fast' });
        return typeof result === 'string' ? result : (result && result.content) || '';
      };
    } catch (_) {
      return { success: false, error: 'LLM not available for expert generation' };
    }

    const scope = args.role ? [args.role] : undefined;
    const result = await generateExpertFromFiles({
      files,
      projectRoot,
      cheapLlmCall,
      scope,
      priority: args.type || 'medium',
    });

    return result;
  } catch (err) {
    return { success: false, error: `expert-generate failed: ${err.message}` };
  }
}

// ─── Sub-command: tool-check ───────────────────────────────────────────────

/**
 * PreToolUse Safety Check: Validates tool arguments before execution
 * to prevent dangerous operations.
 *
 * Bridge support for the PreToolUse interceptor feature.
 * Mirrors functionality from tool-hook-executor.js runPreToolUseSafetyCheck()
 * for IDE Agent mode.
 *
 * @param {object} args - Bridge arguments
 * @param {string} args.toolName - Name of the tool to check
 * @param {string} args.toolArgs - Stringified array of tool arguments
 * @returns {object} Check result with violations list
 */
function runToolCheck(args) {
  try {
    const { evaluateToolPermission } = require('../core/tool-permission-converger');

    const toolName = args.toolName || '';
    let toolArgs = [];
    if (args.toolArgs) {
      const rawArgs = args.toolArgs;
      try {
        const parsed = JSON.parse(rawArgs);
        toolArgs = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {
        try {
          const unescaped = String(rawArgs).replace(/\\"/g, '"');
          const reparsed = JSON.parse(unescaped);
          toolArgs = Array.isArray(reparsed) ? reparsed : [reparsed];
        } catch (_) {
          toolArgs = [rawArgs];
        }
      }
    }

    const decision = evaluateToolPermission({
      toolName,
      args: toolArgs,
      mode: 'ide-bridge',
    });

    const fatalViolationIds = (decision.blockingViolations || []).map(v => v.id);
    const shouldBlock = !decision.allow;

    return {
      success: true,
      subcommand: 'tool-check',
      data: {
        toolName,
        checked: true,
        passed: decision.allow,
        shouldBlock,
        violations: (decision.violations || []).map(v => ({
          id: v.id,
          name: v.name,
          level: v.severity,
          blocking: v.blocking,
          matched: v.matched,
        })),
        fatalViolations: fatalViolationIds,
        permissionDecision: {
          decision: decision.decision,
          riskScore: decision.riskScore,
          confidence: decision.confidence,
          policyVersion: decision.policyVersion,
          reason: decision.reason,
        },
        evidence: decision.evidence,
        message: shouldBlock
          ? `Safety check BLOCKED: ${fatalViolationIds.length} critical violation(s) detected`
          : decision.violations?.length > 0
            ? `Safety check PASSED with warnings: ${decision.violations.length} non-critical violation(s)`
            : 'Safety check PASSED: No suspicious patterns detected',
      },
    };
  } catch (err) {
    return {
      success: false,
      subcommand: 'tool-check',
      error: `Tool check failed: ${err.message}`,
    };
  }
}

// ─── Main Dispatcher ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const { getConfig } = require('../core/config-loader');
  const absProjectRoot = path.resolve(args.projectRoot || '.');
  const runConfig = getConfig(absProjectRoot);

  const result = await executeWithToolGovernance({
    command: args.subcommand || 'unknown',
    input: args,
    config: runConfig,
    preValidate: async () => {
      if (args.subcommand === 'run' && (args.requirement || args.userInput)) {
        const inputToValidate = args.requirement || args.userInput;
        const policyCheck = enforceRuntimePolicy(inputToValidate, { config: runConfig || {} });
        if (!policyCheck.ok) {
          return {
            success: false,
            subcommand: args.subcommand,
            error: `Runtime policy blocked request: ${policyCheck.violations.join(' | ')}`,
          };
        }
      }
      return { success: true };
    },
    handler: async () => {
      let innerResult;
      switch (args.subcommand) {
      case 'requirement-check':
          innerResult = runRequirementCheck(args);
          break;
        case 'context':
          innerResult = runContext(args);
          break;
        case 'experience-search':
          innerResult = runExperienceSearch(args);
          break;
        case 'experience-context':
          innerResult = await runExperienceContext(args);
          break;
        case 'experience-record':
          innerResult = runExperienceRecord(args);
          break;
        case 'staleness-check':
          innerResult = runStalenessCheck(args);
          break;
        case 'quality-check':
          innerResult = runQualityCheck(args);
          break;
        case 'build-agent-prompt':
          innerResult = runBuildAgentPrompt(args);
          break;
        case 'rollback-check':
          innerResult = runRollbackCheck(args);
          break;
        case 'quality-gate':
          innerResult = runQualityGate(args);
          break;
        case 'experience-evolve':
          innerResult = await runExperienceEvolve(args);
          break;
        case 'deep-audit':
          innerResult = await runDeepAudit(args);
          break;
        case 'pm-route':
          innerResult = runPMRoute(args);
          break;
        case 'gate-check':
          innerResult = runGateCheck(args);
          break;
        case 'dev-map':
          innerResult = await runDevMap(args);
          break;
        case 'task-board':
          innerResult = runTaskBoard(args);
          break;
        case 'experience-health':
          innerResult = runExperienceHealth(args);
          break;
        case 'mape-analysis':
          innerResult = await runMapeAnalysis(args);
          break;
        case 'regression-check':
          innerResult = runRegressionCheck(args);
          break;
        case 'skill-refine-check':
          innerResult = runSkillRefineCheck(args);
          break;
        case 'contract-check':
          innerResult = runContractCheck(args);
          break;
        case 'skill-discover':
          innerResult = await runSkillDiscover(args);
          break;
        case 'experience-transfer':
          innerResult = runExperienceTransfer(args);
          break;
        case 'task-history':
          innerResult = runTaskHistory(args);
          break;
        case 'arch-cache':
          innerResult = runArchCache(args);
          break;
        case 'execution-validate':
          innerResult = await runExecutionValidate(args);
          break;
        case 'prompt-optimize':
          innerResult = runPromptOptimize(args);
          break;
        case 'session-score':
          innerResult = runSessionScore(args);
          break;
        case 'scheduler-check':
          innerResult = runSchedulerCheck(args);
          break;
        case 'degrade-output':
          innerResult = runDegradeOutput(args);
          break;
        case 'degrade-check':
          innerResult = runDegradeCheck(args);
          break;
        case 'inject-expert':
          innerResult = runInjectExpert(args);
          break;
        case 'list-experts':
          innerResult = runListExperts(args);
          break;
        case 'expert-block':
          innerResult = runExpertBlock(args);
          break;
        case 'expert-generate':
          innerResult = await runExpertGenerate(args);
          break;
        case 'tool-check':
          innerResult = runToolCheck(args);
          break;
        case 'test-execute':
          innerResult = runTestExecute(args);
          break;
        case 'input-received':
          innerResult = runInputReceived(args);
          break;
        case 'workflow-stage':
          innerResult = await runWorkflowStage(args);
          break;
        case 'stage-complete':
          innerResult = await runStageComplete(args);
          break;
        case 'plan-amend':
          innerResult = runPlanAmend(args);
          break;
        case 'skill-evolve':
          innerResult = runSkillEvolve(args);
          break;
        case 'skill-update':
          innerResult = runSkillUpdate(args);
          break;
        case 'skill-ablation':
          innerResult = runSkillAblation(args);
          break;
        case 'failure-pattern-analyze':
          innerResult = await runFailurePatternAnalyze(args);
          break;
        case 'issue-pattern-collect':
          innerResult = await runIssuePatternCollect(args);
          break;
        case 'teardown-pipeline':
          innerResult = runTeardownPipeline(args);
          break;
        case 'run':
          innerResult = await runWorkflow(args);
          break;
        case 'read-only-explore':
          innerResult = await runReadOnlyExplore(args);
          break;
        case 'trace-append':
          innerResult = runTraceAppend(args);
          break;
        case 'socratic-challenge':
          innerResult = await runSocraticChallenge(args);
          break;
        case 'trace-session-start':
          innerResult = runTraceSessionStart(args);
          break;
        case 'health-report':
          innerResult = await runHealthReport(args);
          break;
        case 'session-summary':
          innerResult = runSessionSummary(args);
          break;
        case 'help':
        case '--help':
        case '-h':
          innerResult = printHelp();
          break;
        default: {
          // ── Lifecycle Plugin Registry: Dynamic subcommand dispatch ──
          // Check if any registered plugin provides this subcommand
          try {
            const { getGlobalRegistry } = require('../core/lifecycle-plugin-registry');
            const registry = getGlobalRegistry();
            const pluginDir = require('path').join(__dirname, '..', 'core', 'plugins');

            // Auto-discover plugins if not yet done
            if (registry.getAll().length === 0) {
              registry.autoDiscover(pluginDir);
            }

            if (registry.getBridgeSubcommands().includes(args.subcommand)) {
              innerResult = await registry.executeBridgeCommand(args.subcommand, args);
              break;
            }
          } catch (prErr) {
            // Plugin registry not available — fall through to unknown command
          }

          innerResult = {
            success: false,
            error: `Unknown sub-command: "${args.subcommand}". Run with "help" to see available commands.`,
          };
        }
      }
      return innerResult;
    },
    postProcess: async (innerResult) => {
      const catalog = buildCapabilityCatalog({
        mode: args.llmModule ? 'ide' : 'node',
        capabilities: {},
      });
      const catalogPrompt = formatCapabilityCatalogForPrompt(catalog);
      return {
        ...(innerResult || {}),
        capabilityCatalog: catalog,
        capabilityCatalogPrompt: catalogPrompt,
      };
    },
    fallback: async (err) => ({
      success: false,
      subcommand: args.subcommand,
      error: `Governed fallback executed: ${err.message}`,
    }),
  });

  // Output JSON to stdout using the original console.log
  originalConsoleLog(JSON.stringify(result, null, 2));

  // Exit with appropriate code
  process.exit(result.success ? 0 : 1);
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  main().catch(err => {
    console.log(JSON.stringify({
      success: false,
      error: `Unhandled error: ${err.message}`,
    }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runContext,
  runExperienceSearch,
  runExperienceContext,
  runExperienceRecord,
  runStalenessCheck,
  runQualityCheck,
  runBuildAgentPrompt,
  runRollbackCheck,
  runQualityGate,
  runExperienceEvolve,
  runDeepAudit,
  runExperienceHealth,
  runMapeAnalysis,
  runRegressionCheck,
  runSkillRefineCheck,
  runContractCheck,
  runSkillDiscover,
  runExperienceTransfer,
  runTaskHistory,
  runArchCache,
  runExecutionValidate,
  runPromptOptimize,
  runSessionScore,
  runSchedulerCheck,
  runDegradeOutput,
  runDegradeCheck,
  runInjectExpert,
  runListExperts,
  runExpertBlock,
  runExpertGenerate,
  runTestExecute,
  runInputReceived,
  runWorkflowStage,
  runStageComplete,
  runReadOnlyExplore,
  runHealthReport,
  runTraceAppend,
  runTraceSessionStart,
  runSocraticChallenge,
  _generateContentAwareQuestions,
  runSkillEvolve,
  runSkillUpdate,
  runSkillAblation,
  runFailurePatternAnalyze,
  runIssuePatternCollect,
  runTeardownPipeline,
};
