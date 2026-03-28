/**
 * Orchestrator Init – Initialization Logic Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from orchestrator-lifecycle.js.
 * Contains all initialization methods mixed into Orchestrator.prototype:
 *   - _initWorkflow()         – shared startup sequence
 *   - _initIslandModules()    – Logger, Negotiation, ExperienceRouter init
 *   - _detectTechStackForPreheat() – tech stack detection for experience preheating
 *   - _detectProjectType()    – project type classification
 *   - _shouldTriggerEvolution() – Smart Trigger for evolution modules
 *
 * These methods are mixed into Orchestrator.prototype via Object.assign,
 * so all `this.stateMachine`, `this.memory`, etc. references resolve correctly.
 *
 * @module orchestrator-init
 */

'use strict';

const fs = require('fs');
const { PATHS } = require('./constants');

// ─── Init Mixin ───────────────────────────────────────────────────────────────

const OrchestratorInitMixin = {

  /**
   * Shared startup sequence used by both run() and runTaskBased().
   * Initialises StateMachine, builds memory context, loads AGENTS.md, and
   * prints any open complaints so agents are aware before execution begins.
   *
   * P1-4: Side Effect Isolation — each setup step is:
   *   1. Wrapped in an idempotent guard (safe to call multiple times)
   *   2. Isolated in its own try/catch (one failure doesn't block others)
   *   3. Labelled for structured logging and debugging
   *
   * @returns {string} resumeState – the state to resume from (from StateMachine)
   */
  async _initWorkflow() {
    // P1-4: Track which init steps have completed (idempotent re-entry guard)
    if (!this._initCompleted) this._initCompleted = new Set();

    // ── Step 1: StateMachine init (MUST run first, not idempotent-guarded) ──
    const resumeState = await this.stateMachine.init();
    console.log(`[Orchestrator] StateMachine initialised. Resume state: ${resumeState}`);

    // ── Step 2: Memory context + AGENTS.md (idempotent: re-reading is safe) ──
    if (!this._initCompleted.has('memory')) {
      try {
        await this.memory.buildGlobalContext().catch(err =>
          console.warn(`[Orchestrator] Memory build warning: ${err.message}`)
        );
        this.memory.startWatching();
        this._agentsMdContent = fs.existsSync(PATHS.AGENTS_MD)
          ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
          : '';
        if (this._agentsMdContent) {
          console.log(`[Orchestrator] 📋 AGENTS.md loaded (${this._agentsMdContent.length} chars) – will be injected into all Agent prompts.`);
        }
        this._initCompleted.add('memory');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 2 (Memory/AGENTS.md) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 3: Complaint awareness check (idempotent: read-only) ──
    if (!this._initCompleted.has('complaints')) {
      try {
        const openComplaints = this.complaintWall.getOpenComplaints();
        if (openComplaints.length > 0) {
          console.warn(`[Orchestrator] ⚠️  ${openComplaints.length} open complaint(s) need attention:`);
          for (const c of openComplaints.slice(0, 3)) {
            console.warn(`  [${c.severity}] ${c.description}`);
          }
        }
        this._initCompleted.add('complaints');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 3 (Complaints) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 4: SkillWatcher (idempotent: guarded by this._skillWatcher check) ──
    if (!this._initCompleted.has('skillWatcher')) {
      try {
        const { getCachedLoader, onLoaderReady } = require('./prompt-builder');
        const cachedLoader = getCachedLoader();
        if (cachedLoader && this.skillEvolution) {
          const { SkillWatcher } = require('./skill-watcher');
          this._skillWatcher = new SkillWatcher(cachedLoader, PATHS.SKILLS_DIR, {
            skillEvolution: this.skillEvolution,
          });
          this._skillWatcher.on('skill:changed', ({ filename, eventType }) => {
            console.log(`[Orchestrator] 🔄 Skill hot-reload: ${filename} (${eventType})`);
          });
          this._skillWatcher.start();
        } else if (!cachedLoader) {
          this._skillWatcherDeferred = true;
          const { SkillWatcher } = require('./skill-watcher');
          const { onLoaderReady } = require('./prompt-builder');
          onLoaderReady((loader) => {
            if (this._skillWatcher || !this.skillEvolution) return;
            this._skillWatcher = new SkillWatcher(loader, PATHS.SKILLS_DIR, {
              skillEvolution: this.skillEvolution,
            });
            this._skillWatcher.on('skill:changed', ({ filename, eventType }) => {
              console.log(`[Orchestrator] 🔄 Skill hot-reload: ${filename} (${eventType})`);
            });
            this._skillWatcher.start();
            this._skillWatcherDeferred = false;
            console.log(`[Orchestrator] 🔄 SkillWatcher started (deferred → ContextLoader now available).`);
          });
          console.log(`[Orchestrator] ℹ️  SkillWatcher deferred: ContextLoader not yet initialised (will activate on first LLM call).`);
        }
        this._initCompleted.add('skillWatcher');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 4 (SkillWatcher) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 5: MCP adapters (idempotent: connectAll is safe to re-call) ──
    if (!this._initCompleted.has('mcpAdapters')) {
      try {
        if (this.services.has('mcpRegistry')) {
          const registry = this.services.resolve('mcpRegistry');
          registry.connectAll().catch(err =>
            console.warn(`[Orchestrator] ⚠️  MCP connectAll failed (non-fatal): ${err.message}`)
          );
        }
        this._initCompleted.add('mcpAdapters');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 5 (MCP Adapters) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 5b: Core module contract validation ──────────────────────────
    // Validates that key shared objects satisfy their interface contracts.
    // This catches "dark disconnection" bugs where a module calls a method
    // that doesn't exist on the target object (e.g. the .query() bug).
    if (!this._initCompleted.has('contractValidation')) {
      try {
        const { validateContract } = require('./contracts');
        const contractChecks = [
          { name: 'IExperienceStore', instance: this.experienceStore },
          { name: 'IHookSystem',      instance: this.hooks },
          { name: 'IStateMachine',    instance: this.stateMachine },
        ];
        let totalViolations = 0;
        for (const { name, instance } of contractChecks) {
          if (!instance) continue;
          const { valid, violations } = validateContract(name, instance);
          if (!valid) {
            totalViolations += violations.length;
            console.warn(`[Orchestrator] ⚠️  Contract ${name}: ${violations.length} violation(s):`);
            for (const v of violations.slice(0, 5)) {
              console.warn(`[Orchestrator]    - ${v}`);
            }
          }
        }
        if (totalViolations === 0) {
          console.log(`[Orchestrator] ✅ Core module contracts validated (${contractChecks.filter(c => c.instance).length} modules, 0 violations).`);
        }
        this._initCompleted.add('contractValidation');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 5b] Contract validation failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6: Experience preheat (idempotent: only fires when total < 3) ──
    if (!this._initCompleted.has('experiencePreheat')) {
      try {
        if (this.experienceStore) {
          const stats = this.experienceStore.getStats();
          if (stats.total < 3) {
            const { preheatExperienceStore } = require('./context-budget-manager');
            const techStack = this._detectTechStackForPreheat();
            preheatExperienceStore(this, { techStack, projectType: this._detectProjectType() })
              .then(r => {
                if (r.success && r.seeded > 0) {
                  console.log(`[Orchestrator] 🌱 Experience cold-start preheated: ${r.seeded} seed experiences injected.`);
                }
              })
              .catch(err => {
                console.warn(`[Orchestrator] ⚠️  Experience preheat failed (non-fatal): ${err.message}`);
              });
          }
        }
        this._initCompleted.add('experiencePreheat');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 6 (Experience Preheat) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6b: P1 fix – Set ExperienceStore reference in PromptBuilder for synonym expansion ──
    if (!this._initCompleted.has('experienceStoreRef')) {
      try {
        if (this.experienceStore) {
          const { setExperienceStore } = require('./prompt-builder');
          setExperienceStore(this.experienceStore);
          console.log(`[Orchestrator] 🔗 ExperienceStore linked to PromptBuilder (synonym expansion enabled).`);
        }
        this._initCompleted.add('experienceStoreRef');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Step 6b (ExperienceStore Ref) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6b-sentinel: Optimization Trigger — sentinel experience for contract mismatch ──
    // Plants a low-cost "sentinel" experience that auto-injects into ARCHITECT/PLAN/CODE
    // prompts when relevant. When contract drift occurs, this experience surfaces as a
    // warning, building evidence for implementing structured InterfaceContract storage.
    // See: workflow/docs/pending-optimizations.md#2-interface-contract-structured-storage
    if (!this._initCompleted.has('sentinelExperiences')) {
      try {
        if (this.experienceStore) {
          const { ExperienceType, ExperienceCategory } = require('./experience-types');
          this.experienceStore.recordIfAbsent(
            'Interface contract text-block format may cause cross-module inconsistency',
            {
              type: ExperienceType.NEGATIVE,
              category: ExperienceCategory.ARCHITECTURE,
              title: 'Interface contract text-block format may cause cross-module inconsistency',
              content: [
                'When module count >= 4 and interface contracts are passed as text blocks between',
                'ARCHITECT → PLAN → CODE stages, there is a risk of contract drift.',
                'Example: module A declares getUser(id: string) but module B implements getUser(userId: number).',
                'If this pattern recurs 3+ times, implement structured InterfaceContract storage',
                'with programmatic dependency checking.',
                'See: workflow/docs/pending-optimizations.md#2-interface-contract-structured-storage',
              ].join(' '),
              skill: 'architecture-design',
              tags: ['interface-contract', 'module-split', 'contract-mismatch', 'sentinel', 'optimization-trigger'],
              ttlDays: 365,
            }
          );
        }
        this._initCompleted.add('sentinelExperiences');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 6b-sentinel] Sentinel experience injection failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 6c: Skill Discovery — auto-discover project conventions (cold-start) ──
    // Runs once when no project-specific standards skill exists yet.
    // Rule-based scanning (zero LLM calls) + optional LLM refinement (1 call).
    if (!this._initCompleted.has('skillDiscovery')) {
      try {
        if (this.skillEvolution) {
          const { discoverProjectSkills } = require('./skill-discovery');
          // Fire-and-forget: discovery is non-blocking and non-fatal
          discoverProjectSkills({
            projectRoot: this.projectRoot || process.cwd(),
            skillEvolution: this.skillEvolution,
            llmCall: this._rawLlmCall || null,
            force: false,
          }).then(result => {
            if (result.discovered) {
              console.log(`[Orchestrator] 🔍 Skill Discovery: auto-generated "${result.skillName}" (${result.signalCount} signals, LLM: ${result.usedLLM})`);
              // Emit hook event for observability
              if (this.hooks && this.hooks.emit) {
                this.hooks.emit('skill_discovery_complete', {
                  skillName: result.skillName,
                  signalCount: result.signalCount,
                  usedLLM: result.usedLLM,
                });
              }
            }
          }).catch(err => {
            console.warn(`[Orchestrator] ⚠️  Skill Discovery failed (non-fatal): ${err.message}`);
          });
        }
        this._initCompleted.add('skillDiscovery');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 6c] Skill Discovery failed (non-fatal): ${err.message}`);
      }
    }

    // ── Steps 7-9: Island modules (Logger, Negotiation, ExperienceRouter) ──
    if (!this._initCompleted.has('islandModules')) {
      try {
        await this._initIslandModules(resumeState);
        this._initCompleted.add('islandModules');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Steps 7-9 (Island Modules) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 10: P2-1 EventJournal — Append-only event sourcing log ──────────
    if (!this._initCompleted.has('eventJournal')) {
      try {
        const { EventJournal } = require('./event-journal');
        this.eventJournal = new EventJournal({
          outputDir: this._outputDir || PATHS.OUTPUT_DIR,
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          enabled: true,
        });
        this.eventJournal.attachToHookSystem(this.hooks);
        this._initCompleted.add('eventJournal');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P2-1] Step 10 (EventJournal) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 11: Workflow Introspection Manager ───────────────────────────────
    if (!this._initCompleted.has('introspectionManager')) {
      try {
        const { introspectionManager } = require('./introspection-manager');
        introspectionManager.initialize({
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          outputDir: this._outputDir || PATHS.OUTPUT_DIR,
          enabled: true,
          autoGenerateReports: true,
        });
        this.introspectionManager = introspectionManager;
        
        // Subscribe to workflow hooks for automatic stage tracking
        if (this.hooks) {
          introspectionManager.hookSubscribe(this.hooks);
        }
        
        this._initCompleted.add('introspectionManager');
        console.log(`[Orchestrator] 🔍 Workflow Introspection Manager initialized`);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 11] Introspection Manager failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 12: Agent Handoff Log ─────────────────────────────────────────────
    if (!this._initCompleted.has('handoffLog')) {
      try {
        const { AgentHandoffLog } = require('./agent-handoff-log');
        this.handoffLog = new AgentHandoffLog({
          outputDir: this._outputDir || PATHS.OUTPUT_DIR,
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          verbose: !this._quietMode,
        });
        
        // Wrap the FileRefBus to automatically capture all handoffs
        if (this.bus && typeof this.bus.publish === 'function') {
          const { wrapFileRefBus } = require('./agent-handoff-log');
          wrapFileRefBus(this.bus, this.handoffLog);
        }
        
        // Print the banner at workflow start
        if (this.handoffLog && !this._quietMode) {
          this.handoffLog.printBanner();
        }
        
        this._initCompleted.add('handoffLog');
        console.log(`[Orchestrator] 🔄 Agent Handoff Log initialized`);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 12] Agent Handoff Log failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 12b: Agent Feedback System initialization ────────────────────────
    // P1: Feedback loop for continuous improvement
    if (!this._initCompleted.has('feedbackSystem')) {
      try {
        const { AgentFeedbackSystem } = require('./agent-feedback-system');
        this.feedbackSystem = new AgentFeedbackSystem({
          outputDir: this._outputDir || PATHS.OUTPUT_DIR,
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          eventBus: this.experienceEventBus || null,
          verbose: !this._quietMode,
        });

        // Set session ID when handoff log is available
        if (this.handoffLog) {
          this.feedbackSystem.setSessionId(this.handoffLog._sessionId);
        }

        this._initCompleted.add('feedbackSystem');
        console.log(`[Orchestrator] 🔄 Agent Feedback System initialized`);

        // Initialize feedback helpers for easy agent access
        const { integrateWithOrchestrator } = require('./feedback-helpers');
        integrateWithOrchestrator(this);
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 12b] Agent Feedback System failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 13: Register built-in Tool Hook handlers ─────────────────────────
    // P1: Register default handlers for tool execution observability
    if (!this._initCompleted.has('toolHooks')) {
      try {
        const { _registerBuiltinToolHooks } = require('../tools/tool-hook-executor');
        if (this.hooks && _registerBuiltinToolHooks) {
          _registerBuiltinToolHooks(this.hooks);
          this._initCompleted.add('toolHooks');
          console.log(`[Orchestrator] 🔧 Tool Hook handlers registered`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 13] Tool Hook registration failed (non-fatal): ${err.message}`);
      }
    }

    return resumeState;
  },

  /**
   * Initialises the "island" modules that were previously created but not
   * connected to the lifecycle. Called at the end of _initWorkflow().
   *
   * @param {string} resumeState
   */
  async _initIslandModules(resumeState) {
    // Step 7: Structured Logger — first structured log entry
    if (this.logger) {
      this.logger.info('Orchestrator', 'Workflow initialised', {
        projectId: this.projectId,
        resumeState,
        outputDir: this._outputDir,
      });
    }

    // Step 8: NegotiationEngine — reset round counters for fresh run
    if (this.negotiation) {
      this.negotiation.reset();
      if (this.logger) {
        this.logger.info('Negotiation', 'Round counters reset for new workflow run');
      }
    }

    // Step 9: ExperienceRouter — update tech stack and auto-import
    if (this.experienceRouter) {
      // Update tech stack from AGENTS.md (now loaded) so discovery uses accurate tags
      const detectedTechStack = this._detectTechStackForPreheat();
      if (detectedTechStack.length > 0) {
        this.experienceRouter._techStack = new Set(detectedTechStack.map(t => t.toLowerCase()));
      }

      // Fire-and-forget: auto-import relevant experiences from other projects
      try {
        const importResult = this.experienceRouter.autoImport();
        if (importResult.imported > 0 && this.logger) {
          this.logger.info('ExperienceRouter', `Auto-imported ${importResult.imported} experience(s)`, {
            sources: importResult.sources,
            skipped: importResult.skipped,
          });
        }
      } catch (routerErr) {
        console.warn(`[Orchestrator] ⚠️  ExperienceRouter auto-import failed (non-fatal): ${routerErr.message}`);
      }
    }
  },

  /**
   * ADR-30 P1: Detects the project's tech stack from AGENTS.md and skill files.
   * Used to construct targeted web search queries for experience preheating.
   * @returns {string[]} Array of tech stack terms (e.g. ['React', 'TypeScript', 'Next.js'])
   */
  _detectTechStackForPreheat() {
    const techPattern = /\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Docker|Kubernetes|TypeScript|JavaScript|Python|Java|Go|Rust|Lua|C#|Unity|Flutter|Dart|Swift|Kotlin|Electron|Tauri)\b/gi;
    let source = this._agentsMdContent || '';
    // Also scan skill filenames for domain hints
    try {
      const skillFiles = require('fs').readdirSync(PATHS.SKILLS_DIR).filter(f => f.endsWith('.md'));
      source += ' ' + skillFiles.map(f => f.replace('.md', '').replace(/-/g, ' ')).join(' ');
    } catch (_) { /* non-fatal */ }
    const matches = source.match(techPattern) || [];
    return [...new Set(matches.map(t => t.trim()))].slice(0, 6);
  },

  /**
   * ADR-30 P1: Detects the project type (frontend/backend/fullstack/game/mobile).
   * @returns {string} Project type string
   */
  _detectProjectType() {
    const content = (this._agentsMdContent || '').toLowerCase();
    if (/\bgame\b|\bunity\b|\bgodot\b|\bunreal\b|\bcocos\b/.test(content)) return 'game';
    if (/\bmobile\b|\bflutter\b|\breact\s?native\b|\bswiftui\b|\bkotlin\b/.test(content)) return 'mobile';
    if (/\bfrontend\b|\breact\b|\bvue\b|\bangular\b|\bsvelte\b/.test(content)) {
      if (/\bbackend\b|\bapi\b|\bserver\b|\bdatabase\b/.test(content)) return 'fullstack';
      return 'frontend';
    }
    if (/\bbackend\b|\bapi\b|\bserver\b|\bmicroservice\b/.test(content)) return 'backend';
    return 'general';
  },

  /**
   * Smart Trigger: determines which evolution modules should run based on current state.
   *
   * This is the core of the "conditional trigger" optimization. Instead of running all
   * evolution modules on every workflow completion, we check if there's meaningful work
   * to do. This avoids unnecessary token consumption and improves performance.
   *
   * Trigger conditions:
   *   - selfReflection: errorRate > 0 OR durationMs > 60s OR has quality gate history
   *   - aefRefinement: has open complaints OR has negative experiences
   *   - autoDeploy: has metrics history (source !== 'defaults')
   *   - mape: has anomaly signals OR has metrics history (>= 3 sessions)
   *   - sleeptime: experienceCount > 20 OR skillCount > 10
   *
   * @returns {{ selfReflection: boolean, aefRefinement: boolean, autoDeploy: boolean, mape: boolean, sleeptime: boolean }}
   */
  _shouldTriggerEvolution() {
    const metrics = this.obs?.getMetricsSnapshot?.() || {};
    const expStats = this.experienceStore?.getStats?.() || {};
    const skillCount = this.skillEvolution?.registry?.size || 0;
    const openComplaints = this.complaintWall?.getOpenComplaints?.() || [];
    const negativeExps = this.experienceStore?.getAll?.()?.filter(e => e.type === 'negative') || [];

    // Check metrics history for MAPE and Auto-Deploy
    let hasMetricsHistory = false;
    let historyLength = 0;
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(this._outputDir || PATHS.OUTPUT_DIR);
      historyLength = history.length;
      hasMetricsHistory = historyLength >= 3;
    } catch (_) { /* non-fatal */ }

    // Check for anomaly signals (quick scan without full MAPE cycle)
    let hasAnomalySignals = false;
    try {
      const errorCount = (metrics.errors?.count || 0);
      const tokenTrend = metrics.tokenTrend || 0;
      const durationTrend = metrics.durationTrend || 0;
      hasAnomalySignals = errorCount > 0 || tokenTrend > 0.1 || durationTrend > 0.2;
    } catch (_) { /* non-fatal */ }

    // Determine triggers
    const selfReflection = (metrics.errors?.count || 0) > 0 ||
                           (metrics.totalDurationMs || 0) > 60000 ||
                           hasMetricsHistory;

    const aefRefinement = openComplaints.length > 0 || negativeExps.length > 0;

    const autoDeploy = hasMetricsHistory;

    const mape = hasAnomalySignals || hasMetricsHistory;

    const sleeptime = (expStats.total || 0) > 20 || skillCount > 10;

    // Log trigger decisions in verbose mode
    if (this._verbose) {
      console.log(`[Orchestrator] 🎯 Smart Trigger: selfReflection=${selfReflection}, aefRefinement=${aefRefinement}, autoDeploy=${autoDeploy}, mape=${mape}, sleeptime=${sleeptime}`);
    }

    return {
      selfReflection,
      aefRefinement,
      autoDeploy,
      mape,
      sleeptime,
    };
  },
};

module.exports = { OrchestratorInitMixin };
