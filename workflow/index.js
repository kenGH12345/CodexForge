/**
 * Orchestrator – Main workflow entry point
 *
 * Wires together all components:
 *  - StateMachine (state management + checkpoint)
 *  - FileRefBus (file-reference communication protocol)
 *  - HookSystem (lifecycle events + human review)
 *  - SocraticEngine (structured decision making)
 *  - MemoryManager (context memory)
 *  - All four Agents (Analyst, Architect, Developer, Tester)
 *  - PromptBuilder (KV-cache optimised prompts)
 *  - TaskManager (AgentFlow: task decomposition + dependency orchestration)
 *  - ExperienceStore (AgentFlow: persistent experience accumulation)
 *  - ComplaintWall (AgentFlow: error correction feedback loop)
 *  - SkillEvolutionEngine (AgentFlow: skill auto-evolution)
 *
 * Usage:
 *   const orchestrator = new Orchestrator({ projectId: 'my-project', llmCall });
 *   await orchestrator.run('Build a REST API for user management');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { StateMachine } = require('./core/state-machine');
const { FileRefBus } = require('./core/file-ref-bus');
const { MemoryManager } = require('./core/memory-manager');
const { SocraticEngine, DECISION_QUESTIONS } = require('./core/socratic-engine');
const { HookSystem } = require('./hooks/hook-system');
const { AnalystAgent } = require('./agents/analyst-agent');
const { ArchitectAgent } = require('./agents/architect-agent');
const { DeveloperAgent } = require('./agents/developer-agent');
const { TesterAgent } = require('./agents/tester-agent');
const { PlannerAgent } = require('./agents/planner-agent');
const { buildAgentPrompt, setPromptSlotManager, getPromptSlotManager, setSelfReflectionEngine, setSkillEvolutionEngine, setOrchestrator, setEmbeddingService, setContextLoaderCheapLlm, setContextLoaderExperienceStore, setAdmissionMatrixConfig, preloadAdrDigest } = require('./core/prompt-builder');
const { PromptSlotManager } = require('./core/prompt-slot-manager');
const { WorkflowState, AgentRole, STATE_ORDER } = require('./core/types');
const { PATHS, HOOK_EVENTS, outputPath, getDefaultOutputDir } = require('./core/constants');
// AgentFlow modules
const { TaskManager, TaskStatus } = require('./core/task-manager');
const { ExperienceStore, ExperienceType, ExperienceCategory } = require('./core/experience-store');
const { ComplaintWall, ComplaintSeverity, ComplaintTarget, ComplaintStatus, RootCause } = require('./core/complaint-wall');
const { SkillEvolutionEngine } = require('./core/skill-evolution');
const { SkillLlmRefiner } = require('./core/skill-llm-refiner');
const { SkillEvolutionTriggers } = require('./core/skill-evolution-triggers');
const { SelfReflectionEngine } = require('./core/self-reflection-engine');
const { selfReportCollector } = require('./core/agent-self-report');
const { SessionSignalDetector } = require('./core/session-signal-detector');
const { getConfig } = require('./core/config-loader');
const { SelfCorrectionEngine, formatClarificationReport } = require('./core/clarification-engine');
const { RequirementClarifier } = require('./core/requirement-clarifier');
const { CoverageChecker } = require('./core/coverage-checker');
const { CodeReviewAgent, REVIEW_DIMENSIONS, ITEM_TO_DIMENSION } = require('./core/code-review-agent');
const { ARCHITECTURE_CHECKLIST } = require('./core/review-checklists');
const { TestRunner } = require('./core/test-runner');
const { Observability } = require('./core/observability');
const { P0RuntimeLoop } = require('./core/p0-runtime-loop');
const { EntropyGC } = require('./core/entropy-gc');

const { CIIntegration } = require('./core/ci-integration');
const { CodeGraph } = require('./core/code-graph');
const { GitIntegration } = require('./core/git-integration');
const { DryRunSandbox } = require('./core/sandbox');
const { FileLockManager, fileLockManager } = require('./core/file-lock-manager');
const { AutoDeployer } = require('./core/auto-deployer');
const _git       = require('./core/orchestrator-git');
const _stages    = require('./core/orchestrator-stages');
const _helpers   = require('./core/orchestrator-helpers');
const _lifecycle = require('./core/orchestrator-lifecycle');
const _task      = require('./core/orchestrator-task');
const _run       = require('./core/orchestrator-run');
const { StageContextStore } = require('./core/stage-context-store');
// P0/P1 optimisation: ServiceContainer (DI), StageRunner (stage interface), StageRegistry (stage registration)
const { ServiceContainer } = require('./core/service-container');
const { StageRunner, StageRegistry } = require('./core/stage-runner');
const { AnalystStage, ArchitectStage, PlannerStage, DeveloperStage, TesterStage } = require('./core/stages');
// P3 optimisation: multi-model routing support
const { LlmRouter } = require('./core/llm-router');
const { getGlobalHealth, callWithFallback } = require('./core/model-fallback-manager');
// Direction 1+2: Cost-aware gateway + Global run guard
const { RunGuard } = require('./core/run-guard');
// Direction 4: Structured Decision Audit Log
const { DecisionTrail } = require('./core/decision-trail');
// Direction 5: Adaptive Stage Skipping based on task complexity
const { StageSmartSkip } = require('./core/stage-smart-skip');
// P1-2: Agent Negotiation Protocol (inter-agent concern resolution)


// P1-4: Structured Logger (JSON Lines logging)
const { Logger, logger: structuredLogger } = require('./core/logger');
// P2-1: Cross-project experience routing
const { ExperienceRouter } = require('./core/experience-router');
// P2-3: Long-running service mode + health check
const { WorkflowServer } = require('./core/workflow-server');
// P3-1: MCP Server (Model Context Protocol) for IDE plugin integration
const { MCPServer } = require('./core/mcp-server');
// P3-2: RequestTriage (auto-detect complexity + enforce best practices)
const { RequestTriage } = require('./core/request-triage');
// P2-4: Core module contracts (explicit interface validation)
const { validateContract, assertContract, listContracts, ALL_CONTRACTS } = require('./core/contracts');
// ADR-45: Write-Around Review (zero-trust edit validation for direct file edits)
const { quickReview, validateBeforeEdit, reviewAfterEdit, withWriteAroundReview } = require('./core/write-around-review');
// Plan-C: Lightweight local embedding for semantic skill/experience matching
const { EmbeddingService } = require('./core/embedding-service');
// Plan-A: Loop guard for conditional rollback retry limits
const { LoopGuard } = require('./core/loop-guard');
// RetryDivergenceGuard: prevents duplicate output during rollback retries
const { buildRetryContext, compareOutputFingerprint, setCheapLlmCall: setRetryGuardCheapLlm } = require('./core/retry-divergence-guard');
const { setSemanticCompressorCheapLlm } = require('./core/token-budget');
// Bottom-up dark disconnection prevention: ES6 Proxy wraps shared objects
// to catch calls to non-existent methods at access time, not at failure time.
const { createSafeProxy, getDefaultProxyMode } = require('./core/safe-interface-proxy');
// ADR-37: IDE Detection – displays running mode banner
const { displayModeBanner } = require('./core/ide-detection');
// IDE Agent mode visual logging support
const { AgentHandoffLog, isIDEAgentMode } = require('./core/agent-handoff-log');
// Smart Context Selection: dynamic adapter block priority adjustment based on project/task type
// (moved to orchestrator-mcp.js; imports kept only if directly referenced elsewhere)
// MCP (Model Context Protocol) adapters: moved to orchestrator-mcp.js (P1-1 extraction)

class Orchestrator {
  /**
   * @param {object} options
   * @param {string}   options.projectId    - Unique project identifier
   * @param {Function} options.llmCall      - async (prompt: string) => string
   * @param {string}   [options.projectRoot]  - Root dir for memory scanning
   * @param {Function} [options.askUser]      - async (questions: string[]) => string[]
   * @param {boolean}  [options.dryRun=false] - Dry-run mode: intercept all file writes,
   *                                            record as pending ops, never touch real FS.
   *                                            Call orchestrator.sandbox.apply() to commit.
   * @param {object}   [options.git]          - Git PR workflow options
   * @param {boolean}  [options.git.enabled=false]      - Auto-create feature branch + PR on completion
   * @param {string}   [options.git.baseBranch='main']  - Target branch for the PR
   * @param {string}   [options.git.branchType='feat']  - Branch prefix: feat|fix|chore|refactor
   * @param {boolean}  [options.git.autoPush=false]     - Push branch to remote before creating PR
   * @param {boolean}  [options.git.draft=false]        - Create PR as draft
   * @param {string[]} [options.git.labels=[]]          - Labels to apply to the PR
   * @param {string[]} [options.git.reviewers=[]]       - Reviewer usernames
   * @param {Object<string, Function>} [options.llmRoutes] - P3: Per-role LLM model overrides.
   *   Keys are role names (e.g. 'ANALYST', 'ARCHITECT', 'DEVELOPER', 'TESTER').
   *   Values are async (prompt: string) => string functions.
   *   When specified, each role uses its own LLM model instead of the shared llmCall.
   *   Roles without an explicit override fall back to the default llmCall.
   *   Example: { ARCHITECT: claudeOpusCall, DEVELOPER: gpt4oCall }
   * @param {Object} [options.llmTiers] - P1: Tier-based complexity-aware routing.
   *   Defines model tiers that are automatically assigned to roles after ANALYSE
   *   stage based on task complexity. More cost-effective than per-role routing
   *   because assignment is dynamic – simple tasks use cheaper models.
   *   Keys: 'fast', 'default', 'strong'. Values: async (prompt: string) => string.
   *   Example: { fast: gpt4oMiniCall, default: gpt4oCall, strong: claudeOpusCall }
   *   Note: Per-role overrides (llmRoutes) always take priority over tier routing.
   */
  constructor({ projectId, llmCall, projectRoot = null, askUser = null, dryRun = false, git = {}, outputDir = null, runCategory = 'prod', llmRoutes = {}, llmTiers = null, llmSource = 'external' }) {
this.projectId = projectId;
    this._llmSource = String(llmSource || 'external').toLowerCase() === 'mock' ? 'mock' : 'external';
    this.projectRoot = projectRoot || path.resolve(__dirname, '..');

    // ── ServiceContainer (early init) ───────────────────────────────────────
    // Must be initialized early because subsequent code uses this.services
    this.services = new ServiceContainer();
    this.services.registerValue('projectId', this.projectId);
    this.services.registerValue('projectRoot', this.projectRoot);

    // P1-D fix: support per-instance outputDir so multiple Orchestrator instances
    // (e.g. one per task in a multi-project setup) can write to isolated directories
    // without conflicting on shared files like stage-context.json, architecture.md, etc.
    //
    // Previously StageContextStore (and several helpers) always used the global
    // PATHS.OUTPUT_DIR constant, which is a single shared directory. If two Orchestrator
    // instances ran concurrently (or sequentially in the same process), their output
    // files would overwrite each other.
    //
    // Fix: accept an optional outputDir constructor argument. If not provided, fall back
    // to getDefaultOutputDir() (runtime-evaluated, backward-compatible). Store as this._outputDir so
    // all instance methods (StageContextStore, buildDeveloperContextBlock, etc.) can use
    // it instead of the global constant.
    this._outputDir = outputDir || getDefaultOutputDir();
    this._runCategory = ['prod', 'test', 'diag'].includes(String(runCategory || '').toLowerCase())
      ? String(runCategory).toLowerCase()
      : 'prod';
    // N4 fix (revised): per-stage source-file cache for investigation tools.
    // Each stage (Architecture / Code / Test) reads a different set of files and
    // reads them at a different point in time (architecture.md doesn't exist yet
    // when ARCHITECT runs; code.diff doesn't exist yet when CODE runs).
    // Using a single shared cache would cause later stages to reuse stale content
    // from an earlier stage (e.g. CODE stage seeing the pre-review architecture.md).
    // A Map keyed by stageLabel gives each stage its own isolated cache entry.
    /** @type {Map<string, string|null>} stageLabel → cached source content */
    this._investigationSourceCacheMap = new Map();
    // askUser: async (questions: string[]) => string[]
    // Provide this callback to enable interactive requirement clarification.
    // If null, clarification is skipped (non-interactive / CI mode).
    this.askUser = askUser || null;

    // ── Dry-run / Sandbox mode ───────────────────────────────────────────────
    // When dryRun=true, all file-system writes are intercepted by DryRunSandbox.
    // The real FS is never touched until sandbox.apply() is called explicitly.
    this.dryRun = dryRun === true;
    this.sandbox = new DryRunSandbox({
      projectRoot: this.projectRoot,
      outputDir:   this._outputDir,
      verbose:     true,
    });
    if (this.dryRun) {
      console.error(`[Orchestrator] 🧪 DRY-RUN MODE ENABLED – file writes will be intercepted.`);
      console.error(`[Orchestrator]    Call orchestrator.sandbox.apply() to commit changes.`);
    }

    // ── Git PR workflow options ──────────────────────────────────────────────
    this._gitOptions = {
      enabled:    git.enabled    ?? false,
      baseBranch: git.baseBranch ?? 'main',
      branchType: git.branchType ?? 'feat',
      autoPush:   git.autoPush   ?? false,
      draft:      git.draft      ?? false,
      labels:     git.labels     ?? [],
      reviewers:  git.reviewers  ?? [],
    };
    this.git = new GitIntegration(this.projectRoot);

    // ── P1 ADR-34: AutoDeployer (Staged Self-Deployment) ──────────────────
    // Implements GREEN/YELLOW/RED tier deployment: auto-applies safe config
    // changes, generates PRs for structural changes, maintains audit trail.
    this.autoDeployer = new AutoDeployer({
      outputDir:   this._outputDir,
      projectRoot: this.projectRoot,
      verbose:     true,
    });

    // Load project config (workflow.config.js) for this project root.
    // N46 fix: do NOT call clearConfigCache() here. N43 fix made getConfig(projectRoot)
    // bypass the module-level cache when projectRoot is provided, so clearConfigCache()
    // is redundant and harmful – it would wipe the cache entry written by MemoryManager
    // (or vice versa), breaking the "first caller writes, others reuse" invariant.
    this._config = getConfig(this.projectRoot);

    // Merge workflow.config.js git/sandbox settings as defaults (constructor args take priority)
    const cfgGit     = (this._config && this._config.git)     || {};
    const cfgSandbox = (this._config && this._config.sandbox) || {};

    // Re-apply git options with config fallback (constructor args already set above,
    // but if git={} was passed (default), config values should win)
    if (!git || Object.keys(git).length === 0) {
      this._gitOptions = {
        enabled:    cfgGit.enabled    ?? false,
        baseBranch: cfgGit.baseBranch ?? 'main',
        branchType: cfgGit.branchType ?? 'feat',
        autoPush:   cfgGit.autoPush   ?? false,
        draft:      cfgGit.draft      ?? false,
        labels:     cfgGit.labels     ?? [],
        reviewers:  cfgGit.reviewers  ?? [],
      };
    }

    // Re-apply dryRun with config fallback
    if (!dryRun && cfgSandbox.dryRun) {
      this.dryRun = true;
      console.error(`[Orchestrator] 🧪 DRY-RUN MODE ENABLED (from workflow.config.js) – file writes will be intercepted.`);
      console.error(`[Orchestrator]    Call orchestrator.sandbox.apply() to commit changes.`);
    }

    // Initialise core subsystems
    this.hooks = new HookSystem();

    // P1: Initialize Tool Hook Executor for automatic tool execution hooks
    // This enables BEFORE/AFTER tool execution hooks across all tool calls
    const { initializeToolHookExecutor } = require('./tools/tool-hook-executor');
    initializeToolHookExecutor(this.hooks, {
      enabled: true,
      sessionId: this._sessionId || this.projectId || `session-${Date.now()}`,
    });
    console.error(`[Orchestrator] 🔧 Tool Hook Executor initialized (P1: automatic tool-level hooks)`);

    this.bus = new FileRefBus();

    const runtimeStateOpts = {};
    if (this._config && this._config.runtimeState && this._config.runtimeState.enabled) {
      runtimeStateOpts.useRuntimeState = true;
      runtimeStateOpts.runtimeDir = this._config.runtimeState.runtimeDir || path.join(this._outputDir, 'runtime');
    }

    this.stateMachine = new StateMachine(projectId, this.hooks.getEmitter(), {
      manifestPath: path.join(this._outputDir, 'manifest.json'),
      ...runtimeStateOpts,
    });
    this.memory = new MemoryManager(this.projectRoot);
    this.socratic = new SocraticEngine();

    // IDE Agent mode: initialise handoffLog for visual output capture
    this.handoffLog = new AgentHandoffLog({ 
      ideMode: isIDEAgentMode(),
      verbose: true 
    });

    // Initialise AgentFlow subsystems
    this.taskManager = new TaskManager();
    // ADR-43 Extension: Scope-aware ExperienceStore
    // WORKFLOW scope: ~/.codexforge/workflow-experiences.json (global)
    // PROJECT scope: <project-root>/.workflow/experiences.json (version-controllable)
    this.experienceStore = new ExperienceStore({ projectRoot: this.projectRoot });
    // Purge expired experiences at startup to keep the store lean.
    // Negative experiences expire after 90 days, positive after 365 days (configurable via ttlDays).
    this.experienceStore.purgeExpired();
    this.complaintWall = new ComplaintWall();

    // ── ADR-43: Session Signal Detector ─────────────────────────────────────
    // Automatic capture of "pitfall moments" from workflow sessions.
    // Tracks file edits, tool calls, and complaints to detect signal-worthy sessions.
    this._sessionSignalDetector = new SessionSignalDetector({
      orchestrator: this,
      verbose: this._verbose,
    });
    console.error(`[Orchestrator] 🎯 SessionSignalDetector initialised (ADR-43: signal-driven experience capture).`);

    // ── Defect F fix: Bidirectional sync between ExperienceStore and ComplaintWall ──
    // Previously these two systems were isolated information silos:
    //   - Resolving a complaint didn't create a positive experience (knowledge lost)
    //   - Recording a negative experience didn't file a complaint (problem untracked)
    // Now they cross-reference each other:
    //   ComplaintWall.resolve() → auto-creates POSITIVE experience (solution capture)
    //   ExperienceStore.record(NEGATIVE) → auto-files complaint (problem tracking)
    this.experienceStore.setComplaintWall(this.complaintWall);
    this.complaintWall.setExperienceStore(this.experienceStore);
    console.error(`[Orchestrator] 🔗 ExperienceStore ↔ ComplaintWall bidirectional sync established.`);

    this.skillEvolution = new SkillEvolutionEngine();

    // ADR-29: Register callback for auto-enriching newly created placeholder skills.
    // When a new skill file is created (e.g. via auto-create from experience), this
    // ADR-45 (Revised): Lazy enrichment on first use, not eager on creation.
    //
    // OLD BEHAVIOR: Immediately called enrichSkillFromExternalKnowledge() when a
    // skill file was created, which added latency to initialization and could
    // fetch irrelevant knowledge before the skill's context was known.
    //
    // NEW BEHAVIOR: Mark the skill as "needs enrichment" and trigger the actual
    // enrichment when ContextLoader first attempts to load the skill. This:
    //   1. Reduces initialization time (no blocking web searches)
    //   2. Ensures enrichment happens only for skills that are actually used
    //   3. Allows the task context to inform the enrichment queries
    //
    // The enrichment is triggered by ContextLoader._loadSkill() when it detects
    // a placeholder skill. MAPE Engine continues to monitor and refresh stale skills.
    this.skillEvolution.onSkillFileCreated = (meta) => {
      // Mark as needing enrichment (will be triggered on first use)
      meta.needsEnrichment = true;
      meta.enrichmentTriggeredAt = null;
      meta.enrichmentCompletedAt = null;
      console.error(`[Orchestrator] 📝 New skill "${meta.name}" registered (enrichment deferred until first use)`);
    };

    // ── P1 Self-Reflection Engine: quality gating + proactive audit ──────────
    // This engine observes workflow execution, records issues, and proactively
    // identifies improvement opportunities. It bridges to ExperienceStore (negative
    // experiences) and ComplaintWall (high-severity auto-complaints).
    this._selfReflection = new SelfReflectionEngine({
      outputDir: this._outputDir,
      experienceStore: this.experienceStore,
      complaintWall: this.complaintWall,
      cheapLlmCall: this.llmRouter?.getTierConfig()?.fast || null,
    });
    console.error(`[Orchestrator] 🔍 SelfReflectionEngine initialised (${this._selfReflection.getStats().total} historical reflections loaded).`);

    // ── StageContextStore: cross-stage semantic context propagation ──────────
    // P2-A fix: initialise StageContextStore eagerly in the constructor instead of
    // lazily in _runAnalyst. The lazy pattern had two problems:
    //   1. If _runAnalyst is skipped (e.g. direct call to _runArchitect or checkpoint
    //      resume past ANALYSE), stageCtx is never initialised and downstream helpers
    //      (buildArchitectUpstreamCtx, storeArchitectContext, etc.) throw TypeError.
    //   2. Hiding a side-effect (this.stageCtx = ...) inside a "pure" stage runner
    //      violates the single-responsibility principle and makes the code harder to test.
    // The store is always fresh per Orchestrator instance (one instance = one workflow run).
    //
    // P1-D fix: use this._outputDir instead of the global PATHS.OUTPUT_DIR constant.
    // If multiple Orchestrator instances run concurrently (e.g. one per project in a
    // multi-project setup), each instance now writes stage-context.json to its own
    // isolated output directory, preventing file conflicts.
    this.stageCtx = new StageContextStore({
      outputDir: this._outputDir,
      verbose: false,
    });
    console.error(`[Orchestrator] 🔗 StageContextStore initialised for cross-stage context propagation.`);

    // Register built-in skills
    this._registerBuiltinSkills();

    // Wrap llmCall with prompt builder
    // P1-NEW-4 fix: wrap _rawLlmCall itself with a token-metering layer so that ALL
    // LLM calls (SelfCorrectionEngine, _runRealTestLoop, runAuto, translateMdFile, etc.)
    // are counted – not just the ones that go through wrappedLlm.
    // Previously ~60% of token consumption from these "hidden" callers was invisible
    // to the Observability module. The wrapper is transparent: it estimates tokens from
    // the prompt length, records the call under the special role '__internal', and
    // returns the response unchanged.
    const _originalLlmCall = llmCall;

    // ── P3: LlmRouter (multi-model routing) ──────────────────────────────────
    // When llmRoutes is provided, different agent roles can use different LLM models.
    // This enables cost optimisation (cheap model for requirement analysis, strong model
    // for architecture design) and quality tuning (best coding model for development).
    // The router maintains a Map<role, llmCall> with a default fallback.
    this.llmRouter = new LlmRouter(_originalLlmCall, llmRoutes, llmTiers);
    this.modelHealth = getGlobalHealth();
    if (Object.keys(llmRoutes).length > 0) {
      console.error(`[Orchestrator] 🔀 LlmRouter configured with ${Object.keys(llmRoutes).length} role-specific route(s): [${Object.keys(llmRoutes).join(', ')}]`);
    }
    if (llmTiers && typeof llmTiers === 'object' && Object.keys(llmTiers).length > 0) {
      console.error(`[Orchestrator] 🎯 LlmRouter tier-based routing enabled: [${Object.keys(llmTiers).join(', ')}] – will auto-assign after ANALYSE stage.`);
    }

    // ── P2 Feature #2: SmartRouterEnhancement – Bottleneck-aware routing ──
    // Enhances LlmRouter with bottleneck detection and automatic tier optimization
    // Requires output directory for observability data access
    if (this._config?.smartRouterEnhancement !== false) {
      this.llmRouter.withSmartEnhancement();
    } else {
      console.error(`[Orchestrator] ⏭️  SmartRouterEnhancement disabled by config`);
    }
    this._rawLlmCall = async (prompt) => {
      // Estimate tokens from prompt length (char / 4 heuristic, same as buildAgentPrompt)
      const promptStr = Array.isArray(prompt)
        ? prompt.map(m => (typeof m === 'object' ? (m.content || '') : String(m))).join(' ')
        : String(prompt || '');
      const estimatedTokens = Math.ceil(promptStr.length / 4);
      try {
        this.obs.recordLlmCall('__internal', estimatedTokens, promptStr);
      } catch (_) { /* metering must never break the call */ }

      // P1-A fix: when prompt is a multi-turn conversation array, try to pass it
      // directly to _originalLlmCall first (works if the caller's llmCall supports
      // the OpenAI messages array format). If _originalLlmCall throws a TypeError
      // (e.g. it only accepts strings), fall back to serialising the history into a
      // single string so the multi-turn context is not silently lost.
      //
      // Serialisation format:
      //   [User]: <content>
      //   [Assistant]: <content>
      //   ...
      // This is readable by any LLM and preserves the full reasoning chain.

      // ── P0 fix: RunGuard beforeLlmCall check ─────────────────────────
      // Checks global LLM call limits before executing. If limits are exceeded,
      // throws RunGuardAbortError which propagates to the orchestrator's catch.
      try {
        if (this.runGuard && typeof this.runGuard.beforeLlmCall === 'function') {
          this.runGuard.beforeLlmCall('__internal', estimatedTokens || 4000);
        }
      } catch (rgErr) {
        if (rgErr.code === 'RUN_GUARD_ABORT') throw rgErr;
        /* other errors are non-fatal */
      }

      let response;
      if (Array.isArray(prompt)) {
        // T2: Conversation compaction (R2-safe). Only the Array branch runs this —
        // string prompts go through formatConversationWithBudget's L1 budget instead.
        // Lazy-init singleton per orchestrator to keep session state across calls.
        let effectivePrompt = prompt;
        try {
          if (!this._compactor) {
            const { ConversationCompactor } = require('./core/conversation-compactor');
            this._compactor = new ConversationCompactor({});
          }
          const sessionId = this.sessionId || this.runId || '_default';
          const compactResult = await this._compactor.compact(prompt, {
            sessionId,
            // Hand back the *raw* underlying channel so Compactor's summary LLM
            // call cannot re-enter this wrapper (would spiral into recursion).
            llmCall: (p) => _originalLlmCall(p),
            _skipCompaction: false,
          });
          if (compactResult.strategy === 'llm' || compactResult.strategy === 'truncate') {
            console.error(`[Orchestrator] 🗜️  Compacted ${compactResult.originalMessageCount}→${compactResult.compactedMessageCount} msgs, saved ${compactResult.savedChars} chars (${compactResult.strategy})`);
            effectivePrompt = compactResult.messages;
            if (compactResult.overuseWarning) {
              console.error(`[Orchestrator] ⚠️  ${compactResult.warningMessage}`);
            }
          }
        } catch (compactErr) {
          console.error(`[Orchestrator] ⚠️  Compaction failed non-fatally: ${compactErr.message}`);
        }

        try {
          response = await _originalLlmCall(effectivePrompt);
        } catch (arrayErr) {
          // _originalLlmCall does not support array input – serialise to string
          console.warn(`[Orchestrator] ⚠️  _rawLlmCall: llmCall does not support message arrays (${arrayErr.message}). Serialising conversation history to string.`);
          const { formatConversationWithBudget, CONVERSATION_BUDGET_CHARS } = require('./core/token-budget');
          const CONVERSATION_BUDGET = CONVERSATION_BUDGET_CHARS;
          const { formatted, stats } = formatConversationWithBudget(effectivePrompt, CONVERSATION_BUDGET);
          console.error(`[Orchestrator] 💬 Conversation budget: total=${stats.total}, essential=${stats.essential}, skipped=${stats.skipped}`);
          this._lastBudgetStats = stats;
          response = await _originalLlmCall(formatted);
        }
      } else {
        response = await _originalLlmCall(prompt);
      }
      try {
        const actualTokens = (response && typeof response === 'object')
          ? (response.usage?.total_tokens ?? response.usage?.input_tokens ?? null)
          : null;
        if (actualTokens != null) {
          this.obs.recordActualTokens('__internal', actualTokens);
        }
      } catch (_) { /* metering must never break the call */ }

      // ── P1 fix: Emit LLM_CALL_RECORDED hook event ───────────────────
      // Previously defined in constants.js HOOK_EVENTS but never emitted.
      // Consumers: EventJournal, IntrospectionManager, RunGuard.
      try {
        if (this.hooks && typeof this.hooks.emit === 'function') {
          const { HOOK_EVENTS } = require('./core/constants');
          this.hooks.emit(HOOK_EVENTS.LLM_CALL_RECORDED, {
            role: '__internal',
            estimatedTokens: estimatedTokens || 0,
            responseTokens: (response && typeof response === 'object')
              ? (response.usage?.total_tokens ?? null) : null,
          }).catch(() => {});
        }
      } catch (_) { /* hook emit must never break the call */ }

      // ── P0 fix: RunGuard afterLlmCall integration ────────────────────
      // Records the LLM call in RunGuard for budget and limit tracking.
      try {
        if (this.runGuard && typeof this.runGuard.afterLlmCall === 'function') {
          const respTokens = (response && typeof response === 'object')
            ? (response.usage?.total_tokens ?? 0) : 0;
          this.runGuard.afterLlmCall('__internal', estimatedTokens || 0, respTokens, 0);
        }
      } catch (_) { /* runGuard must never break the call */ }

      // ── T-3: Budget diagnostic summary on fallback path ─────────────
      if (this._lastBudgetStats) {
        try {
          const { getBudgetSummary } = require('./core/token-budget');
          const l2Stats = { total: 0, estimatedTokens: 0, dropped: [], truncated: [] };
          const budgetLine = getBudgetSummary(l2Stats, null, null, this._lastBudgetStats);
          console.error(`[Orchestrator] 📊 Budget diagnostic:\n${budgetLine}`);
          this._lastBudgetStats = null;
        } catch (_) { /* diagnostic must never break the call */ }
      }

      return response;
    };

    // ── LLM Query Expansion: inject LLM into ExperienceStore ─────────────────
    // The experience store uses LLM-based query expansion to semantically expand
    // search keywords with synonyms, abbreviations, and related terms. This bridges
    // the vocabulary gap between how experiences are stored and how they are searched.
    // Uses the metered _rawLlmCall so expansion calls are tracked by Observability.
    this.experienceStore.setLlmCall(this._rawLlmCall);

    // ── Cheap LLM for Experience Distillation ────────────────────────────────
    // Enables LLM semantic merge in ExperienceDistillationMixin.distill().
    // Uses cheapLlmCall (GPT-4o-mini tier, ~$0.003/call) for 3x quality improvement
    // over heuristic concatenation. Non-fatal: falls back to heuristic if unavailable.
    try {
      const distillCheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
      if (distillCheapLlm) {
        this.experienceStore.setCheapLlmCall(distillCheapLlm);
      }
    } catch (_) { /* non-fatal */ }

    // ── Cheap LLM for RetryDivergenceGuard ────────────────────────────────
    // Enables LLM semantic decision extraction in extractKeyDecisions().
    // Uses cheapLlmCall (GPT-4o-mini tier) for ~90% accuracy vs ~50% regex.
    // Non-fatal: falls back to regex heuristic if unavailable.
    try {
      const retryGuardCheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
      if (retryGuardCheapLlm) {
        setRetryGuardCheapLlm(retryGuardCheapLlm);
      }
    } catch (_) { /* non-fatal */ }

    // ── Cheap LLM for SemanticCompressor ──────────────────────────────────
    // Enables LLM-based summarisation in the token budget pipeline.
    // For natural language blocks > 2000 chars, LLM summary replaces TF-IDF
    // sentence selection, yielding ~25% better information density.
    // Non-fatal: falls back to heuristic compression if unavailable.
    try {
      const compressorCheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
      if (compressorCheapLlm) {
        setSemanticCompressorCheapLlm(compressorCheapLlm);
      }
    } catch (_) { /* non-fatal */ }

    // ── Cheap LLM for Experience context block compression (P1-3) ─────────
    // Replaces raw.slice(0, 6000) in getContextBlockWithIds with semantic
    // compression. Expected per-stage token savings: 1.5-2.4k tokens when
    // experience block exceeds 6000 chars. Falls back to heuristic + original
    // truncation on any failure.
    try {
      const { setExperienceCompressorCheapLlm } = require('./core/experience-query');
      const expCheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
      if (typeof setExperienceCompressorCheapLlm === 'function' && expCheapLlm) {
        setExperienceCompressorCheapLlm(expCheapLlm);
      }
    } catch (_) { /* non-fatal */ }

    // ── Cheap LLM for ContextLoader ADR Digest ───────────────────────────
    // Enables LLM semantic relevance scoring and concise summarisation for
    // ADR entries injected into every prompt. Replaces keyword-count heuristic
    // with semantic understanding, yielding ~100% better information density.
    // Non-fatal: falls back to keyword-count + line-truncation heuristic.
    try {
      const contextLoaderCheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
      if (contextLoaderCheapLlm) {
        setContextLoaderCheapLlm(contextLoaderCheapLlm);
      }
      // ADR-55: inject ExperienceStore into ContextLoader for Prevention Rule injection
      // (MemGPT retrieval pattern — retrieve relevant memories on demand)
      if (this._experienceStore) {
        setContextLoaderExperienceStore(this._experienceStore);
      }
      // T-6: Load admission matrix from workflow.config.js
      try {
        const config = require('../workflow.config.js');
        if (config.admissionMatrix) {
          setAdmissionMatrixConfig(config.admissionMatrix);
        }
      } catch (_) { /* admission matrix is optional */ }
    } catch (_) { /* non-fatal */ }

    // ── LLM-Lite Skill Refiner: inject LLM into SkillEvolutionEngine ─────────
    // Enables 3 LLM-Lite scenarios: refine bloated skills, fix underperforming
    // skills, and generate high-quality initial content for auto-created skills.
    // Cost-aware: prefers cheapLlmCall from LlmRouter 'fast' tier (GPT-4o-mini /
    // Gemini Flash) over the main workflow model. ~50x cost reduction.
    // Falls back to _rawLlmCall if no 'fast' tier is configured.
    // ADR-37 compliant: LLM is enhancement, not dependency (graceful fallback).
    try {
      const tierConfig = this.llmRouter.getTierConfig();
      const cheapLlmCall = tierConfig?.fast || null;
      const skillRefiner = new SkillLlmRefiner({
        llmCall: this._rawLlmCall,
        cheapLlmCall,
      });
      this.skillEvolution.setLlmRefiner(skillRefiner);
      this._skillRefiner = skillRefiner;
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  SkillLlmRefiner init failed (non-fatal): ${err.message}`);
      this._skillRefiner = null;
    }

    // P1-NEW-3 fix: independent rollback counter Map, keyed by stage name.
    // Using stageCtx.meta for rollback counting is unsafe because RollbackCoordinator
    // calls stageCtx.delete(stage) during rollback, which resets the counter to 0
    // and can cause infinite recursion (_runTester → rollback → _runDeveloper → _runTester).
    // This Map lives on the Orchestrator instance and is never cleared by rollback logic.
    this._rollbackCounters = new Map();

    // ── Observability: session-level metrics collector ──────────────────────
    this.obs = new Observability(this._outputDir, projectId);

    // ── P0 Runtime Loop: event stream + task recovery + metrics cache ───────
    this.p0RuntimeLoop = new P0RuntimeLoop({
      outputDir: this._outputDir,
      projectId: this.projectId,
      stateMachine: this.stateMachine,
      obs: this.obs,
      verbose: false,
    });

    // ── Adaptive Strategy: derive from cross-session history ────────────────
    // Reads metrics-history.jsonl (if it exists) and adjusts retry/review counts
    // based on recent failure patterns. Falls back to config defaults if no history.
    const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
    this._adaptiveStrategy = Observability.deriveStrategy(this._outputDir, {
      maxFixRounds:    cfgAutoFix.maxFixRounds    ?? 2,
      maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
      maxExpInjected:  cfgAutoFix.maxExpInjected  ?? 5,
      projectId:       projectId,
    });
    if (this._adaptiveStrategy.source !== 'defaults') {
      console.error(`[Orchestrator] 📈 Adaptive strategy loaded from ${this._adaptiveStrategy.source}:`);
      console.error(`[Orchestrator]    maxFixRounds=${this._adaptiveStrategy.maxFixRounds} | maxReviewRounds=${this._adaptiveStrategy.maxReviewRounds} | skipEntropyOnClean=${this._adaptiveStrategy.skipEntropyOnClean} | maxExpInjected=${this._adaptiveStrategy.maxExpInjected}`);
      if (this._adaptiveStrategy._debug) {
        const d = this._adaptiveStrategy._debug;
        console.error(`[Orchestrator]    (testFailRate=${d.testFailRate}, errorTrend=${d.errorTrend}, sessions=${d.sessionCount}, expHitRate=${d.expHitRate})`);
      }
    }

    // ── PromptSlotManager: Prefix-Level A/B testing ─────────────────────────
    // Manages prompt variant selection and auto-promotion for agent fixed prefixes.
    // If prompt-variants.json exists, buildAgentPrompt() will resolve prefixes from
    // the variant registry instead of using hardcoded AGENT_FIXED_PREFIXES.
    this.promptSlotManager = new PromptSlotManager(
      outputPath('prompt-variants.json', this._outputDir),
      this.hooks.getEmitter()
    );
    // Inject into prompt-builder module so buildAgentPrompt() can access it
    setPromptSlotManager(this.promptSlotManager);

    // P1: Inject SelfReflectionEngine into prompt-builder so buildAgentPrompt()
    // auto-injects known-issues summary into every agent prompt.
    setSelfReflectionEngine(this._selfReflection);

    // A-1 fix: Inject SkillEvolutionEngine into SelfReflectionEngine so HealthAuditor
    // uses the runtime instance instead of creating orphan SkillEvolutionEngine instances.
    this._selfReflection.setSkillEvolution(this.skillEvolution);

    // Gap 1 fix: Inject SkillEvolutionEngine into prompt-builder so buildAgentPrompt()
    // can query retired skill names and exclude them from ContextLoader injection.
    // This closes the loop: retireStaleSkills() → retiredAt → ContextLoader exclusion.
    setSkillEvolutionEngine(this.skillEvolution);

    // ── Agent Self-Report Collector (Prompt-level observability for IDE mode) ─
    // Initialise the singleton collector with session context so it can
    // persist self-report data at teardown. Zero overhead when not in IDE.
    this._selfReportCollector = selfReportCollector;
    selfReportCollector.reset({
      sessionId: projectId,
      outputDir: this._outputDir,
    });
    this.services.registerValue('selfReportCollector', selfReportCollector);

    // ── Skill Evolution Triggers: multi-dimensional trigger system ────────────
    // Registers event handlers for 4 trigger types: anomaly-driven, skill
    // degradation, quality gate failure, and skill staleness.
    // Trigger evaluation is pure rule-based. High-value triggers (degradation,
    // quality gate failure) invoke SkillLlmRefiner downstream via cheapLlmCall.
    // Low-value triggers (anomaly, staleness) only detect + record + emit.
    try {
      this._skillEvolutionTriggers = new SkillEvolutionTriggers({
        skillEvolution: this.skillEvolution,
        skillRefiner: this._skillRefiner || null,
      });
      this._unregisterTriggers = this._skillEvolutionTriggers.register();
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  SkillEvolutionTriggers init failed (non-fatal): ${err.message}`);
    }

    // ADR-45: Inject Orchestrator reference into prompt-builder for lazy skill enrichment.
    // ContextLoader uses this to trigger enrichSkillFromExternalKnowledge() when it
    // detects a placeholder skill during loading (first-use trigger pattern).
    setOrchestrator(this);

    // ── Plan-C: EmbeddingService (semantic skill/experience matching) ────────
    // Lightweight local embedding model for cosine-similarity-based semantic search.
    // Zero LLM token cost, ~50ms per inference. Gracefully degrades if package not installed.
    const embeddingCfg = (this._config && this._config.embedding) || {};
    if (embeddingCfg.enabled !== false) {
      this._embeddingService = new EmbeddingService({
        cacheDir: path.join(this.projectRoot || getDefaultOutputDir(), '.workflow', 'models'),
        maxCacheSize: embeddingCfg.maxCacheSize || 500,
        quantized: embeddingCfg.quantized !== false,
      });
      // Async init (non-blocking): model loads in background, semantic matching
      // becomes available once loaded. Keyword matching is used as fallback until then.
      this._embeddingService.init().then(ready => {
        if (ready) {
          setEmbeddingService(this._embeddingService);
          // Also inject into ExperienceStore for semantic boost
          if (this.experienceStore) {
            this.experienceStore._embeddingService = this._embeddingService;
          }
          console.error(`[Orchestrator] 🧠 EmbeddingService ready (Plan-C: semantic skill/experience matching + ADR-OpenSpace BM25 hybrid ranking enabled)`);
        }
      }).catch(() => { /* non-fatal, logged inside EmbeddingService */ });
    } else {
      this._embeddingService = null;
      console.error(`[Orchestrator] ⏭️  EmbeddingService disabled by config (embedding.enabled=false)`);
    }

    // ── Plan-A: LoopGuard (conditional rollback retry limits) ────────────────
    // Prevents infinite backward transitions when ConditionalEdge rules trigger
    // stage rollbacks (e.g. TEST → ARCHITECT). Pure rule engine, zero LLM calls.
    const loopGuardCfg = (this._config && this._config.loopGuard) || {};
    this._loopGuard = new LoopGuard({
      maxRetries: loopGuardCfg.maxRetries ?? 2,
      edgeLimits: loopGuardCfg.edgeLimits || {},
    });
    console.error(`[Orchestrator] 🔄 LoopGuard initialised (Plan-A: max ${this._loopGuard._maxRetries} retries per backward edge)`);

// ── EntropyGC: architectural drift scanner ──────────────────────────────
    // P0-STARTUP-1: wrapped in try/catch — EntropyGC is non-critical for
    // workflow execution. If init fails (e.g. project scan OOM), degrade to null
    // and log. Downstream code must check this.entropyGC before calling methods.
    const entropyCfg = (this._config && this._config.entropyGC) || {};
    try {
      this.entropyGC = new EntropyGC({
        projectRoot:  this.projectRoot,
        outputDir:    this._outputDir,
        extensions:   entropyCfg.sourceExtensions,
        ignoreDirs:   entropyCfg.ignoreDirs,
        maxLines:     entropyCfg.maxLines,
        docPaths:     entropyCfg.docPaths || [],
        lintCommand:  entropyCfg.lintCommand || null,
        llmCall:      this._rawLlmCall,
      });
    } catch (entropyErr) {
      console.error(`[Orchestrator] ⚠️ EntropyGC init failed (non-fatal, degraded to null): ${entropyErr.message}`);
      this.entropyGC = null;
    }

    // ── CIIntegration: pipeline validation bridge ───────────────────────────
    // P0-STARTUP-1: wrapped in try/catch — CIIntegration is only used in TEST
    // stage and can safely degrade if init fails (e.g. no lint/test commands).
    const ciCfg = (this._config && this._config.ci) || {};
    try {
      this.ci = new CIIntegration({
        projectRoot:  this.projectRoot,
        lintCommand:  ciCfg.lintCommand || null,
        testCommand:  ciCfg.testCommand || null,
      });
    } catch (ciErr) {
      console.error(`[Orchestrator] ⚠️ CIIntegration init failed (non-fatal, degraded to null): ${ciErr.message}`);
      this.ci = null;
    }

// ── CodeGraph: structured code index ───────────────────────────────────
    // P0-STARTUP-1: wrapped in try/catch — CodeGraph is ADR-37 fallback only;
    // IDE Agent mode never uses it. If init fails, semantic search degrades to
    // keyword-only. Downstream code already handles null codeGraph.
    const codeGraphCfg = (this._config && this._config.codeGraph) || {};
    try {
      this.codeGraph = new CodeGraph({
        projectRoot:    this.projectRoot,
        outputDir:      this._outputDir,
        extensions:     codeGraphCfg.sourceExtensions,
        ignoreDirs:     codeGraphCfg.ignoreDirs,
        scopeDirs:      codeGraphCfg.scopeDirs,
        llmCall:        this._rawLlmCall,
      });
    } catch (codeGraphErr) {
      console.error(`[Orchestrator] ⚠️ CodeGraph init failed (non-fatal, degraded to null): ${codeGraphErr.message}`);
      this.codeGraph = null;
    }

    // Create agents with hook emitter
    const emitter = this.hooks.getEmitter();
    // P1-NEW-4: wrappedLlm calls _originalLlmCall directly (not _rawLlmCall) to avoid
    // double-counting: wrappedLlm already records the call under the agent role, and
    // _rawLlmCall's metering wrapper would add a second '__internal' entry for the same call.
    const wrappedLlm = (role) => async (prompt) => {
      // N72 fix: wrap buildAgentPrompt in try/catch so an unknown role does not
      // crash the entire task worker – fall back to the raw prompt instead.
      let optimisedPrompt = prompt;
      let routeMetaRef = null;
      try {
        // Pre-populate ADR digest cache using cheap LLM (if available).
        // This must happen BEFORE buildAgentPrompt() because resolve() is synchronous
        // and can only use cached LLM results. Non-fatal: falls back to heuristic.
        await preloadAdrDigest(prompt, { projectRoot: this._projectRoot });

        // T-U2 (orchestrator upstream integration): forward stage signal for
        // T-2 dynamic budget sizing. role -> stage mapping mirrors bridge's
        // stageToRole (runWorkflowStage, line ~6085). score intentionally not
        // passed here — orchestrator has no reliable triage-score in scope at
        // call time; the dynamic budget gracefully falls back to NORMAL.
        const _roleToStage = {
          analyst: 'ANALYSE', architect: 'ARCHITECT', planner: 'PLAN',
          developer: 'CODE',  tester: 'TEST',          reviewer: 'ARCHITECT',
        };
        const _buildOpts = _roleToStage[role] ? { stage: _roleToStage[role] } : {};
        const result = buildAgentPrompt(role, prompt, [], _buildOpts);
        
        // Defensive: Handle undefined/null result from buildAgentPrompt
        if (!result || typeof result !== 'object') {
          console.warn(`[Orchestrator] buildAgentPrompt returned ${result === undefined ? 'undefined' : typeof result} for role "${role}". Using raw prompt.`);
        } else {
          optimisedPrompt = result.prompt || prompt;

          // Optimization C: API Prompt Caching – when buildAgentPrompt returns
          // cache breakpoint metadata, convert to messages array format so the
          // LLM adapter can leverage API-level caching (Anthropic cache_control,
          // OpenAI automatic prefix caching). The system message (fixedPrefix)
          // is stable across calls for the same role, achieving ~90% cost reduction
          // on cached tokens. Falls back to string format if the adapter rejects arrays.
          if (result.meta && result.meta.cacheBreakpoint && result.meta.cacheablePrefix && result.meta.dynamicSuffix) {
            optimisedPrompt = [
              {
                role: 'system',
                content: result.meta.cacheablePrefix,
                cache_control: { type: 'ephemeral' },
              },
              {
                role: 'user',
                content: result.meta.dynamicSuffix,
              },
            ];
          }

          const estimatedTokens = (result.meta && result.meta.estimatedTokens) || 0;
          console.error(`[Orchestrator] LLM call for ${role}: ~${estimatedTokens} tokens`);
          // Skill Lifecycle: record injected skill names for effectiveness tracking
          if (result.meta && result.meta.injectedSkillNames && result.meta.injectedSkillNames.length > 0) {
            this.obs.recordSkillUsage(result.meta.injectedSkillNames);
          }

          // P0 Prompt Tracing: pass the optimised prompt text for digest extraction
          const promptTextForTrace = typeof optimisedPrompt === 'string'
            ? optimisedPrompt
            : (Array.isArray(optimisedPrompt)
                ? optimisedPrompt.map(m => (typeof m === 'object' ? (m.content || '') : String(m))).join('\n')
                : String(optimisedPrompt || ''));

          // P1: AgentHub-inspired route decision + fallback + trace context
          const tierConfig = this.llmRouter.getTierConfig() || {};
          const rawRouteFn = this.llmRouter.getRawForRole(role);
          const matchedTier = rawRouteFn === tierConfig.strong ? 'strong'
            : rawRouteFn === tierConfig.fast ? 'fast'
            : 'default';
          const routeCallId = `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const routeMeta = {
            callId: routeCallId,
            sessionId: this.projectId,
            role,
            selectedTier: matchedTier,
            timestamp: new Date().toISOString(),
            fallback: {
              triggered: false,
              chain: [],
            },
          };
          routeMetaRef = routeMeta;

          this.obs.recordLlmCall(role, estimatedTokens, promptTextForTrace, routeMeta);

          try {
            await this.hooks.emit(HOOK_EVENTS.ROUTER_DECISION_MADE, {
              role,
              routeMeta,
            });
          } catch (_) { /* hook emission must never break the call */ }
        }
      } catch (err) {
        console.warn(`[Orchestrator] buildAgentPrompt failed for role "${role}": ${err.message}. Using raw prompt.`);
        const fallbackRouteMeta = {
          callId: `route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: this.projectId,
          role,
          selectedTier: 'default',
          timestamp: new Date().toISOString(),
          fallback: { triggered: false, chain: [] },
        };
        routeMetaRef = fallbackRouteMeta;
        this.obs.recordLlmCall(role, 0, typeof prompt === 'string' ? prompt : '', fallbackRouteMeta);
      }
      // P2-A fix: extract actual token usage from LLM response (if the LLM client
      // attaches a .usage object to the response string, e.g. via a custom wrapper).
      // Standard OpenAI/Anthropic SDKs return usage in the response object; if the
      // caller wraps the response as a plain string, actual tokens remain null and
      // we fall back to the estimated count. No error is thrown either way.
      // P3: use LlmRouter to get the role-specific LLM function.
      // If llmRoutes was configured with a per-role override (e.g. ARCHITECT → Claude Opus),
      // that function is used instead of the default _originalLlmCall.
      const tierConfig = this.llmRouter.getTierConfig() || {};
      const pickTierFn = (tierName) => {
        if (tierName === 'strong') return tierConfig.strong || tierConfig.default || this.llmRouter.getDefault();
        if (tierName === 'fast') return tierConfig.fast || tierConfig.default || this.llmRouter.getDefault();
        return tierConfig.default || this.llmRouter.getDefault();
      };

      let activeTier = this.llmRouter.getRawForRole(role) === tierConfig.strong
        ? 'strong'
        : (this.llmRouter.getRawForRole(role) === tierConfig.fast ? 'fast' : 'default');
      let activeFn = this.llmRouter.getRawForRole(role);
      let rawResponse = null;
      let lastError = null;
      const fallbackChain = [];

      for (let hop = 0; hop < 4; hop++) {
        const modelId = `${role}:${activeTier}`;
        const result = await callWithFallback(() => activeFn(optimisedPrompt), {
          role,
          tier: activeTier,
          modelId,
        });

        if (result.success) {
          rawResponse = result.result;
          break;
        }

        lastError = result.error || new Error('LLM call failed without explicit error');

        if (result.retryAllowed && result.maxRetries > 0) {
          let retrySucceeded = false;
          for (let i = 0; i < result.maxRetries; i++) {
            const retryResult = await callWithFallback(() => activeFn(optimisedPrompt), {
              role,
              tier: activeTier,
              modelId,
            });
            if (retryResult.success) {
              rawResponse = retryResult.result;
              retrySucceeded = true;
              break;
            }
            lastError = retryResult.error || lastError;
          }
          if (retrySucceeded) break;
        }

        if (result.fallbackTier) {
          fallbackChain.push({ from: activeTier, to: result.fallbackTier, reason: result.decision?.reason || 'fallback' });
          activeTier = result.fallbackTier;
          activeFn = pickTierFn(activeTier);
          continue;
        }

        break;
      }

      if (!rawResponse) {
        throw lastError || new Error(`LLM routing failed for role ${role}`);
      }

      if (routeMetaRef) {
        routeMetaRef.selectedTier = activeTier;
        routeMetaRef.fallback = {
          triggered: fallbackChain.length > 0,
          chain: fallbackChain,
        };
      }

      if (fallbackChain.length > 0) {
        try {
          await this.hooks.emit(HOOK_EVENTS.ROUTER_FALLBACK_TRIGGERED, {
            role,
            fallbackChain,
            sessionId: this.projectId,
            routeMeta: routeMetaRef,
          });
        } catch (_) { /* hook emission must never break the call */ }
      }
      // ── ADR-42: Output Truncation Detection ─────────────────────────────
      // Check stop_reason/finish_reason to detect when the LLM response was
      // cut off due to max_tokens limit. This is the L1 detection layer.
      // When detected, we emit an event and record it for observability.
      try {
        const stopReason = rawResponse?.stop_reason || rawResponse?.finish_reason
          || rawResponse?.choices?.[0]?.finish_reason;
        if (stopReason === 'max_tokens' || stopReason === 'length') {
          console.warn(`[Orchestrator] ⚠️  OUTPUT TRUNCATED: ${role} response hit max_tokens limit (stop_reason="${stopReason}")`);
          // Record in observability for cross-session pattern detection
          if (this.obs && typeof this.obs.recordLlmCall === 'function') {
            this.obs._truncationEvents = this.obs._truncationEvents || [];
            this.obs._truncationEvents.push({
              role,
              stopReason,
              timestamp: new Date().toISOString(),
            });
          }
          // Record in SelfReflection for pattern detection
          if (this._selfReflection && typeof this._selfReflection.recordIssue === 'function') {
            this._selfReflection.recordIssue({
              severity: 'medium',
              title: `Output truncated for ${role} (stop_reason=${stopReason})`,
              description: `The LLM response for role "${role}" was truncated because it hit the max_tokens limit. ` +
                `This may indicate the prompt is too large or the expected output is too long. ` +
                `Consider: (1) reducing context injection, (2) splitting the task, (3) increasing max_output_tokens.`,
              source: 'wrappedLlm.truncation_detection',
              patternKey: `output-truncation:${role}`,
            });
          }
          // Emit hook event for downstream handling
          try {
            await this.hooks.emit(HOOK_EVENTS.OUTPUT_TRUNCATED, { role, stopReason });
          } catch (_) { /* hook emission must never break the call */ }
        }
      } catch (_) { /* truncation detection must never break the call */ }
      const actualTokens = (rawResponse && typeof rawResponse === 'object')
        ? (rawResponse.usage?.total_tokens ?? rawResponse.usage?.input_tokens ?? null)
        : null;
      if (actualTokens != null) {
        this.obs.recordActualTokens(role, actualTokens);
        console.error(`[Orchestrator] 📊 Token usage for ${role}: ${actualTokens} actual tokens`);
      }
      // R4-2 audit: wrap response extraction in try/catch. Some LLM SDKs return
      // response objects with getter-based .text that may throw (e.g. streaming response
      // accessed after close). Graceful fallback to String(rawResponse).
      try {
        return (typeof rawResponse === 'object' && rawResponse !== null && 'text' in rawResponse)
          ? rawResponse.text
          : rawResponse;
      } catch (extractErr) {
        console.warn(`[Orchestrator] ⚠️  Failed to extract .text from LLM response for ${role}: ${extractErr.message}. Falling back to string coercion.`);
        return String(rawResponse);
      }
    };

    // P2-b: pass instance-level outputDir so agents write to the correct directory
    const agentOpts = { outputDir: this._outputDir };
    this.agents = {
      [AgentRole.ANALYST]:   new AnalystAgent(wrappedLlm(AgentRole.ANALYST), emitter, agentOpts),
      [AgentRole.ARCHITECT]: new ArchitectAgent(wrappedLlm(AgentRole.ARCHITECT), emitter, agentOpts),
      [AgentRole.PLANNER]:   new PlannerAgent(wrappedLlm(AgentRole.PLANNER), emitter, agentOpts),
      [AgentRole.DEVELOPER]: new DeveloperAgent(wrappedLlm(AgentRole.DEVELOPER), emitter, agentOpts),
      [AgentRole.TESTER]:    new TesterAgent(wrappedLlm(AgentRole.TESTER), emitter, agentOpts),
    };

// ── P1-a: ServiceContainer (Dependency Injection) ────────────────────────
    // Instead of Orchestrator directly instantiating 20+ subsystems, the
    // ServiceContainer provides lazy initialisation, testability (mock injection),
    // and replaceability (swap subsystems at runtime via register with force=true).
    //
    // For backward compatibility, we register all existing subsystem instances
    // that were already created above. New code should use
    // this.services.resolve('name') instead of direct property access.
    // Note: this.services was created early in constructor, so we only register values here.
    this.services.registerValue('outputDir', this._outputDir);
    this.services.registerValue('config', this._config);
    this.services.registerValue('hooks', this.hooks);
    this.services.registerValue('bus', this.bus);
    this.services.registerValue('stateMachine', this.stateMachine);
    this.services.registerValue('memory', this.memory);
    this.services.registerValue('socratic', this.socratic);
    this.services.registerValue('taskManager', this.taskManager);
    this.services.registerValue('experienceStore', this.experienceStore);
    this.services.registerValue('complaintWall', this.complaintWall);
    this.services.registerValue('skillEvolution', this.skillEvolution);
    this.services.registerValue('stageCtx', this.stageCtx);
    this.services.registerValue('obs', this.obs);
    this.services.registerValue('p0RuntimeLoop', this.p0RuntimeLoop);
    this.services.registerValue('entropyGC', this.entropyGC);

    this.services.registerValue('ci', this.ci);
    this.services.registerValue('codeGraph', this.codeGraph);
    this.services.registerValue('git', this.git);
    this.services.registerValue('sandbox', this.sandbox);
    this.services.registerValue('agents', this.agents);
    this.services.registerValue('rawLlmCall', this._rawLlmCall);
    this.services.registerValue('adaptiveStrategy', this._adaptiveStrategy);
    this.services.registerValue('llmRouter', this.llmRouter);
    this.services.registerValue('modelHealth', this.modelHealth);

    // ── Direction 1+2: RunGuard — now managed by run-guard-plugin.js ──
    // Previously created manually here but core methods were never called.
    // Now auto-activated via LifecyclePluginRegistry → hooks.emit(STAGE_STARTED/ENDED).
    // Fallback: create a lightweight instance if plugin system is unavailable.
    if (!this._pluginRegistry) {
      const runGuardOpts = {
        maxTotalLlmCalls:   (this._adaptiveStrategy && this._adaptiveStrategy.maxTotalLlmCalls) || 50,
        maxTotalTokens:     (this._adaptiveStrategy && this._adaptiveStrategy.maxTotalTokens) || 800_000,
        maxTotalDurationMs: (this._adaptiveStrategy && this._adaptiveStrategy.maxTotalDurationMs) || 30 * 60 * 1000,
        budgetUsd:          (this._config && this._config.llmCostRouter && this._config.llmCostRouter.budgetUsd) || 5.0,
        enabled:            !(this._config && this._config.runGuard && this._config.runGuard.enabled === false),
      };
      if (this._config && this._config.runGuard) {
        Object.assign(runGuardOpts, this._config.runGuard);
      }
      this.runGuard = new RunGuard(runGuardOpts);
      this.services.registerValue('runGuard', this.runGuard);
      console.warn(`[Orchestrator] ⚠️  RunGuard created manually (plugin system unavailable) — hook integration disabled`);
    }

    // ── Direction 4: DecisionTrail — now managed by decision-trail-plugin.js ──
    // Previously created manually here but record() was only called from stage-smart-skip.
    // Now auto-records via LifecyclePluginRegistry → hooks.emit(STAGE_STARTED/ENDED).
    // Fallback: create a lightweight instance if plugin system is unavailable.
    if (!this._pluginRegistry) {
      this.decisionTrail = new DecisionTrail({
        enabled: !(this._config && this._config.decisionTrail && this._config.decisionTrail.enabled === false),
        maxEntries: (this._config && this._config.decisionTrail && this._config.decisionTrail.maxEntries) || 200,
      });
      this.services.registerValue('decisionTrail', this.decisionTrail);
    }

    // ── Direction 5: StageSmartSkip (adaptive stage skipping) ──
    // Evaluates task complexity (from ANALYSE) and skips non-essential stages
    // for simple tasks (e.g. one-file bug fix doesn't need architecture design).
    // Note: decisionTrail is now injected by decision-trail-plugin.js after
    // plugin activation, so we don't pass it here.
    const smartSkipOpts = {
      enabled: !(this._config && this._config.stageSmartSkip && this._config.stageSmartSkip.enabled === false),
      decisionTrail: this.decisionTrail || null,
    };
    if (this._config && this._config.stageSmartSkip && this._config.stageSmartSkip.skipRules) {
      smartSkipOpts.skipRules = this._config.stageSmartSkip.skipRules;
    }
    this.stageSmartSkip = new StageSmartSkip(smartSkipOpts);
    this.services.registerValue('stageSmartSkip', this.stageSmartSkip);

    console.error(`[Orchestrator] 🏗️  ServiceContainer initialised with ${this.services.getRegisteredNames().length} service(s).`);

    // ── P0/P1-b: StageRegistry (stage registration) ─────────────────────────
    // Replaces the hardcoded _runStage switch pattern. New stages can be added by:
    //   1. Creating a class that extends StageRunner
    //   2. Calling orchestrator.registerStage(name, runner)
    // Built-in stages are registered in order: ANALYSE → ARCHITECT → PLAN → CODE → TEST
    this.stageRegistry = new StageRegistry();
    this.stageRegistry.register(new AnalystStage());
    this.stageRegistry.register(new ArchitectStage());
    this.stageRegistry.register(new PlannerStage());
    this.stageRegistry.register(new DeveloperStage());
    this.stageRegistry.register(new TesterStage());
    console.error(`[Orchestrator] 🔧 StageRegistry initialised: [${this.stageRegistry.getOrder().join(' → ')}]`);

    // ── P1-2: NegotiationEngine (Agent Negotiation Protocol) ────────────────
    // MIGRATED to negotiation-engine-plugin.js (Lifecycle Plugin Registry).
    // The plugin's activate() creates the instance and registers it into
    // orch.negotiation + ServiceContainer. No manual creation needed here.

    // ── P1-4: Structured Logger (JSON Lines) ────────────────────────────────
    // Configure the module-level logger singleton with session context.
    // This adds JSONL file logging alongside existing console.log output.
    structuredLogger.setOutputDir(this._outputDir);
    structuredLogger.setSessionId(this.projectId);
    this.logger = structuredLogger;
    this.services.registerValue('logger', this.logger);
    console.error(`[Orchestrator] 📝 Structured Logger configured (outputDir=${this._outputDir}, session=${this.projectId}).`);

    // ── P2-1: ExperienceRouter (Cross-Project Experience Migration) ──────────
    // Intelligent layer on top of ExperienceTransferMixin that automatically
    // discovers, scores, and imports relevant experiences from other projects.
    this.experienceRouter = new ExperienceRouter({
      projectId: this.projectId,
      projectRoot: this.projectRoot,
      techStack: [],  // Will be populated in _initWorkflow after AGENTS.md is loaded
      experienceStore: this.experienceStore,
    });
    this.services.registerValue('experienceRouter', this.experienceRouter);
    console.error(`[Orchestrator] 🌐 ExperienceRouter initialised.`);

    // ── P2-4: Contract Validation Sweep (non-fatal, development-time) ────────
    // Validates registered services against their interface contracts.
    // Uses warn (not throw) so violations don't block production runs.
    const CONTRACT_MAP = {
      stateMachine:    'IStateMachine',
      hooks:           'IHookSystem',
      experienceStore: 'IExperienceStore',
      stageCtx:        'IStageContextStore',
      codeGraph:       'ICodeGraph',
    };
    for (const [svcName, contractName] of Object.entries(CONTRACT_MAP)) {
      if (this.services.has(svcName)) {
        const { valid, violations } = validateContract(contractName, this.services.resolve(svcName));
        if (!valid) {
          console.warn(`[Orchestrator] ⚠️  [Contract] ${contractName} violations on '${svcName}': ${violations.join('; ')}`);
        }
      }
    }
    console.error(`[Orchestrator] 📜 Contract validation sweep complete (${Object.keys(CONTRACT_MAP).length} service(s) checked).`);

    // ── Safe Interface Proxy: bottom-up dark disconnection prevention ────────
    // Wraps core shared objects with ES6 Proxy to catch calls to non-existent
    // methods immediately. This is the root-cause fix for the .query() class of
    // bugs: instead of typeof checks silently skipping broken code, the Proxy
    // throws a loud error with the missing method name and suggestions.
    //
    // Why here (after Contract Validation, before MCP init):
    //   - All shared objects are fully constructed and cross-linked
    //   - Contract validation has already run (it needs the raw objects)
    //   - MCP init and all subsequent code gets the protected versions
    //
    // Mode: 'warn' in production (log + no-op), 'throw' in tests.
    const _proxyMode = getDefaultProxyMode();
    this.experienceStore = createSafeProxy(this.experienceStore, 'ExperienceStore', { mode: _proxyMode });
    this.obs             = createSafeProxy(this.obs,             'Observability',    { mode: _proxyMode });
    this.complaintWall   = createSafeProxy(this.complaintWall,   'ComplaintWall',    { mode: _proxyMode });
    this.hooks           = createSafeProxy(this.hooks,           'HookSystem',       { mode: _proxyMode });
    this.stateMachine    = createSafeProxy(this.stateMachine,    'StateMachine',     { mode: _proxyMode });
    this.stageCtx        = createSafeProxy(this.stageCtx,        'StageContextStore', { mode: _proxyMode });
    // NegotiationEngine SafeProxy removed — now managed by negotiation-engine-plugin.js
    // Fix 1: Extend SafeProxy to cover 5 additional high-frequency shared objects
    // that were previously unprotected ("naked") — any call to a non-existent method
    // on these objects would silently return undefined instead of failing loudly.
    this.codeGraph        = createSafeProxy(this.codeGraph,        'CodeGraph',          { mode: _proxyMode });
    this.skillEvolution   = createSafeProxy(this.skillEvolution,   'SkillEvolution',     { mode: _proxyMode });
    this.bus              = createSafeProxy(this.bus,              'FileRefBus',         { mode: _proxyMode });
    this.experienceRouter = createSafeProxy(this.experienceRouter, 'ExperienceRouter',   { mode: _proxyMode });
    this.promptSlotManager = createSafeProxy(this.promptSlotManager, 'PromptSlotManager', { mode: _proxyMode });
console.error(`[Orchestrator] 🛡️  SafeInterfaceProxy active (mode=${_proxyMode}, 11 shared objects protected).`);

    // Fix: Re-register SafeProxy-wrapped objects into ServiceContainer so that
    // services.resolve('name') returns the protected Proxy, not the original raw
    // object. Without this, code using resolve() bypasses SafeProxy protection.
    for (const svcName of [
      'experienceStore', 'obs', 'complaintWall', 'hooks', 'stateMachine',
      'stageCtx', 'codeGraph', 'skillEvolution', 'bus',
      'experienceRouter',
    ]) {
      this.services.registerValue(svcName, this[svcName], { force: true });
    }

    // ── MCP + Smart Context + Adapter Telemetry + Plugin Registry ────────────
    // Extracted to orchestrator-mcp.js (P1-1 big file treatment).
    // Initialises MCPRegistry, 14+ adapters, SmartContextSelector, AdapterTelemetry,
    // and AdapterPluginRegistry. See orchestrator-mcp.js for full documentation.
    const _mcp = require('./core/orchestrator-mcp');
    _mcp.initMCPSubsystems(this);

    // ── ADR-37: Display Running Mode Banner ──────────────────────────────────
    // Show visual indicator of current mode for user clarity:
    //   - Full IDE Agent Mode (with LSP)
    //   - Limited IDE Mode (CLI only)
    //   - Standalone Mode (Node Orchestrator)
    displayModeBanner({ showCapabilities: true, compact: false });

    // ── MAPE Engine: Closed-Loop Autonomous Controller (ADR-35) ──────────────
    // NOTE: MAPEEngine is now instantiated on-demand in _finalizeWorkflow()
    // (orchestrator-teardown-impl.js L668) via dynamic require. This avoids
    // maintaining a duplicate instance that is never used at runtime.
    // The previous `this.mape = new MAPEEngine(...)` was a zombie initialization
    // — it was created but never invoked; teardown always created a fresh instance.
    console.error(`[Orchestrator] 🔄 MAPE Engine: deferred to on-demand init in _finalizeWorkflow().`);
  }

  // ─── _initWorkflow and _finalizeWorkflow: see orchestrator-lifecycle.js ───

  // ─── Auto-Dispatch (delegated to orchestrator-auto.js, ADR-33 Phase 4) ──────

  async runAuto(rawRequirement, concurrency = 3) {
    const { runAuto } = require('./orchestrator-auto');
    return runAuto.call(this, rawRequirement, concurrency);
  }

  _parseDecompositionResponse(llmResponse, rawRequirement) {
    const { _parseDecompositionResponse } = require('./orchestrator-auto');
    return _parseDecompositionResponse.call(this, llmResponse, rawRequirement);
  }

  _recordWorkflowFailureExperience(err, rawRequirement) {
    const { _recordWorkflowFailureExperience } = require('./orchestrator-auto');
    return _recordWorkflowFailureExperience.call(this, err, rawRequirement);
  }

  // ─── Task-based execution methods → see orchestrator-task.js ───────────────
}


module.exports = {
  Orchestrator, ServiceContainer, StageRunner, StageRegistry, LlmRouter, FileLockManager, P0RuntimeLoop,
  // P1-2: Agent Negotiation Protocol (lazy require — class migrated to plugin but still exported for backward compat)
  get NegotiationEngine() { const { NegotiationEngine } = require('./core/negotiation-engine'); return NegotiationEngine; },
  // P1-4: Structured Logger
  Logger, logger: structuredLogger,
  // P2-1: Cross-project experience routing
  ExperienceRouter,
  // P2-3: Workflow Server (long-running service mode)
  WorkflowServer,
  // P3-1: MCP Server (Model Context Protocol for IDE plugin integration)
  MCPServer,
  // P3-2: RequestTriage (auto-detect complexity + enforce best practices)
  RequestTriage,
  // P2-4: Contracts (explicit interface validation)
  assertContract, validateContract, listContracts,
  // ADR-45: Write-Around Review (zero-trust edit validation)
  quickReview, validateBeforeEdit, reviewAfterEdit, withWriteAroundReview,
  // Plan-C: EmbeddingService (semantic skill/experience matching)
  EmbeddingService,
  // Plan-A: LoopGuard (conditional rollback retry limits)
  LoopGuard,
  // RetryDivergenceGuard: prevents duplicate output during rollback retries
  buildRetryContext,
  compareOutputFingerprint,
};

//  Mixin: attach extracted methods to Orchestrator.prototype 
// This keeps index.js slim while preserving the same public/private API surface.
// P2-STARTUP-8: conflict detection — warn if later mixins silently override
// methods from earlier ones. This catches accidental name collisions early.
const _mixinSources = [
  { name: '_git',       methods: _git },
  { name: '_stages',    methods: _stages },
  { name: '_helpers',   methods: _helpers },
  { name: '_lifecycle', methods: _lifecycle },
  { name: '_task',      methods: _task },
  { name: '_run',       methods: _run },
];
const _seenMethods = new Map(); // methodName → sourceName
for (const { name, methods } of _mixinSources) {
  for (const key of Object.keys(methods)) {
    if (_seenMethods.has(key)) {
      console.warn(`[Orchestrator] ⚠️  Mixin conflict: "${name}" overrides "${key}" from "${_seenMethods.get(key)}"`);
    }
    _seenMethods.set(key, name);
  }
}
for (const { methods } of _mixinSources) {
  Object.assign(Orchestrator.prototype, methods);
}