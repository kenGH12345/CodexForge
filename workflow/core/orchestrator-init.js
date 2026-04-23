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
const path = require('path');
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

    // P2-STARTUP-1/2: startup performance tracking
    if (!this._initTimings) this._initTimings = {};
    const _timing = (stepName) => {
      this._initTimings[stepName] = { start: Date.now() };
      return () => {
        this._initTimings[stepName].end = Date.now();
        this._initTimings[stepName].durationMs = this._initTimings[stepName].end - this._initTimings[stepName].start;
        console.error(`[Orchestrator] ⏱️  init step "${stepName}" took ${this._initTimings[stepName].durationMs}ms`);
      };
    };

    // ── Step 0: TTL cleanup for stale workflow state (P2-STARTUP-7) ──────────
    // Mirrors the fine-grained cleanup in IDE Bridge's input-received handler.
    // Three scenarios handled:
    //   1. File-level timestamp > 24h → delete entire file (very stale)
    //   2. activeWorkflow.ttlExpiry expired → clear activeWorkflow + pendingRetry
    //   3. pendingRetry from previous session → clear (cross-session contamination)
    // Without this, Node mode's second run reuses stale workflow-status.json
    // from the previous run, causing "workflow already running" or state confusion.
    if (!this._initCompleted.has('ttlCleanup')) {
      try {
        // ── Dual-path TTL cleanup (ADR-DUAL-PATH) ──
        // Orchestrator reads/writes workflow-status.json in this._outputDir,
        // but IDE Bridge and hooks (pre-tool-use-guard, stop-guard) read/write in
        // <projectRoot>/output/. Both paths must be cleaned to prevent stale state
        // from blocking new workflow startup.
        const projectRoot = this.projectRoot || process.cwd();
        const statusPaths = [
          path.join(this._outputDir, 'workflow-status.json'),
          path.join(projectRoot, 'output', 'workflow-status.json'),
        ];
        // Deduplicate (same path if projectRoot == workflow/..)
        const uniquePaths = [...new Set(statusPaths)];

        for (const statusPath of uniquePaths) {
          if (fs.existsSync(statusPath)) {
            try {
              const statusData = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
              let wroteChanges = false;

              // Scenario 1: File-level timestamp > 24h → delete entire file
              if (statusData.timestamp) {
                const statusAge = Date.now() - new Date(statusData.timestamp).getTime();
                const FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
                if (statusAge > FILE_TTL_MS) {
                  fs.unlinkSync(statusPath);
                  console.error(`[Orchestrator] 🧹 TTL cleanup: removed stale ${statusPath} (${Math.round(statusAge / 3600000)}h old)`);
                  continue; // Next path
                }
              }

              // Scenario 2 & 3: Fine-grained session-level cleanup (mirrors IDE Bridge)
              // Only run if the file was NOT deleted by Scenario 1
              if (fs.existsSync(statusPath)) {
                const currentSessionId = this._sessionId || `wf-${Date.now()}`;

                // Scenario 2: activeWorkflow.ttlExpiry expired → clear activeWorkflow + pendingRetry
                if (statusData.activeWorkflow && statusData.activeWorkflow.ttlExpiry) {
                  const ttlExpired = new Date(statusData.activeWorkflow.ttlExpiry) < new Date();
                  if (ttlExpired) {
                    console.error(`[Orchestrator] 🧹 TTL expired for session=${statusData.activeWorkflow.session} (expired at ${statusData.activeWorkflow.ttlExpiry}). Clearing stale activeWorkflow.`);
                    delete statusData.activeWorkflow;
                    wroteChanges = true;
                    // Also clear pendingRetry — it belongs to the expired session
                    if (statusData.pendingRetry) {
                      console.error(`[Orchestrator] 🧹 Clearing stale pendingRetry for stage=${statusData.pendingRetry.stage} (belonged to expired session)`);
                      delete statusData.pendingRetry;
                    }
                  }
                }

                // Scenario 3: pendingRetry from a different session (always clear, regardless of TTL)
                // This prevents cross-session contamination where a new Orchestrator instance
                // inherits an unrelated pendingRetry from a previous failed workflow.
                if (statusData.pendingRetry && statusData.activeWorkflow) {
                  const retrySession = statusData.pendingRetry.session;
                  const activeSession = statusData.activeWorkflow.session;
                  if (retrySession && activeSession && retrySession !== activeSession) {
                    console.error(`[Orchestrator] 🧹 Clearing stale pendingRetry for stage=${statusData.pendingRetry.stage} (retry session=${retrySession} != active session=${activeSession})`);
                    delete statusData.pendingRetry;
                    wroteChanges = true;
                  }
                } else if (statusData.pendingRetry && !statusData.activeWorkflow) {
                  // Orphaned pendingRetry with no activeWorkflow — always clear
                  console.error(`[Orchestrator] 🧹 Clearing orphaned pendingRetry for stage=${statusData.pendingRetry.stage} (no activeWorkflow)`);
                  delete statusData.pendingRetry;
                  wroteChanges = true;
                }

                if (wroteChanges) {
                  fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2), 'utf-8');
                  console.error(`[Orchestrator] 🧹 TTL cleanup: updated ${statusPath} (removed stale entries)`);
                }
              }
            } catch (_) { /* malformed status file — ignore */ }
          }
        } // end for (statusPath of uniquePaths)
        // Also clean up stale trace files older than 48 hours
        const traceDir = this._outputDir;
        if (fs.existsSync(traceDir)) {
          const TRACE_TTL_MS = 48 * 60 * 60 * 1000;
          try {
            for (const entry of fs.readdirSync(traceDir)) {
              if (entry.startsWith('trace-') && entry.endsWith('.jsonl')) {
                const fullPath = path.join(traceDir, entry);
                const stat = fs.statSync(fullPath);
                if (Date.now() - stat.mtimeMs > TRACE_TTL_MS) {
                  fs.unlinkSync(fullPath);
                }
              }
            }
          } catch (_) { /* non-fatal */ }
        }
        this._initCompleted.add('ttlCleanup');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  Step 0 (TTL cleanup) failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 1: StateMachine init (MUST run first, not idempotent-guarded) ──
    const _done1 = _timing('StateMachine.init');
    const resumeState = await this.stateMachine.init();
    _done1();
    console.log(`[Orchestrator] StateMachine initialised. Resume state: ${resumeState}`);

    // ── Step 2: Memory context + AGENTS.md (idempotent: re-reading is safe) ──
    if (!this._initCompleted.has('memory')) {
      const _done2 = _timing('Memory+AGENTS.md');
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
      _done2();
    }

    // ── Step 3: Complaint awareness check (idempotent: read-only) ──
    if (!this._initCompleted.has('complaints')) {
      const _done3 = _timing('Complaints');
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
      _done3();
    }

    // ── Step 4: SkillWatcher (idempotent: guarded by this._skillWatcher check) ──
    if (!this._initCompleted.has('skillWatcher')) {
      const _done4 = _timing('SkillWatcher');
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
      _done4();
    }

    // ── Step 5: MCP adapters (idempotent: connectAll is safe to re-call) ──
    if (!this._initCompleted.has('mcpAdapters')) {
      const _done5 = _timing('MCP-Adapters');
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
      _done5();
    }

    // ── Step 5b: Core module contract validation ──────────────────────────
    if (!this._initCompleted.has('contractValidation')) {
      const _done5b = _timing('Contract-Validation');
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
      _done5b();
    }

    // ── Step 6: Experience preheat (idempotent: only fires when total < 3) ──
    if (!this._initCompleted.has('experiencePreheat')) {
      const _done6 = _timing('Experience-Preheat');
      try {
        if (this.experienceStore) {
          const stats = this.experienceStore.getStats();
          if (stats.total < 3) {
            const { preheatExperienceStore } = require('./context-budget-manager');
            const techStack = this._detectTechStackForPreheat();
            preheatExperienceStore(this, { techStack, projectType: this._detectProjectType() })
              .then(r => {
                if (r.success && r.seeded > 0) {
                  console.log(`[Orchestrator 🌱 Experience cold-start preheated: ${r.seeded} seed experiences injected.`);
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
      _done6();
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
      const _done6c = _timing('Skill-Discovery');
      try {
        if (this.skillEvolution) {
          const { discoverProjectSkills } = require('./skill-discovery');
          // Fire-and-forget: discovery is non-blocking and non-fatal
          // Prefer cheapLlmCall (GPT-4o-mini tier) for skill refinement (~50x cost reduction)
          const cheapLlm = this.llmRouter?.getTierConfig()?.fast || null;
          discoverProjectSkills({
            projectRoot: this.projectRoot || process.cwd(),
            skillEvolution: this.skillEvolution,
            llmCall: this._rawLlmCall || null,
            cheapLlmCall: cheapLlm,
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
      _done6c();
    }

    // ── Steps 7-9: Island modules (Logger, Negotiation, ExperienceRouter) ──
    if (!this._initCompleted.has('islandModules')) {
      const _done7 = _timing('Island-Modules');
      try {
        await this._initIslandModules(resumeState);
        this._initCompleted.add('islandModules');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P1-4] Steps 7-9 (Island Modules) failed (non-fatal): ${err.message}`);
      }
      _done7();
    }

    // ── Step 10: P2-1 EventJournal + RuntimeEventStore — Unified event sourcing ──
    if (!this._initCompleted.has('eventJournal')) {
      const _done10 = _timing('EventJournal');
      try {
        const { EventJournal } = require('./event-journal');
        const { RuntimeEventStore } = require('./runtime/runtime-event-store');
        const { JsonlEventStore } = require('./runtime/jsonl-event-store');
        const sessionId = `${this.projectId || 'session'}-${Date.now()}`;

        const backingStore = new JsonlEventStore({
          eventsDir: path.join(this._outputDir, 'runtime', 'events'),
        });
        const runtimeEventStore = new RuntimeEventStore({
          backingStore,
          sessionId,
        });
        this.runtimeEventStore = runtimeEventStore;

        this.eventJournal = new EventJournal({
          outputDir: this._outputDir,
          sessionId,
          enabled: true,
          runtimeEventStore,
        });
        this.eventJournal.attachToHookSystem(this.hooks);
        this.runtimeEventStore.attachToHookSystem(this.hooks);

        if (this.p0RuntimeLoop) {
          this.p0RuntimeLoop.attachEventJournal(this.eventJournal);
          const restoreResult = this.p0RuntimeLoop.restoreCheckpoint();
          this.p0RuntimeLoop.markWorkflowStart({
            initResumeState: resumeState,
            checkpointRestored: restoreResult.restored,
          });
          if (restoreResult.restored) {
            console.log(`[Orchestrator] ♻️  P0 recovery checkpoint loaded (${restoreResult.checkpoint?.status || 'unknown'})`);
          }
        }

        this._initCompleted.add('eventJournal');
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [P2-1] Step 10 (EventJournal) failed (non-fatal): ${err.message}`);
      }
      _done10();
    }

    // ── Step 11: Workflow Introspection Manager ───────────────────────────────
    if (!this._initCompleted.has('introspectionManager')) {
      const _done11 = _timing('Introspection-Manager');
      try {
        const { introspectionManager } = require('./introspection-manager');
        introspectionManager.initialize({
          sessionId: `${this.projectId || 'session'}-${Date.now()}`,
          outputDir: this._outputDir,
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
      _done11();
    }

    // ── Step 12: Agent Handoff Log ─────────────────────────────────────────────
    if (!this._initCompleted.has('handoffLog')) {
      const _done12 = _timing('Agent-Handoff-Log');
      try {
        const { AgentHandoffLog } = require('./agent-handoff-log');
        this.handoffLog = new AgentHandoffLog({
          outputDir: this._outputDir,
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
      _done12();
    }

    // ── Step 12b: Agent Feedback System initialization ────────────────────────
    if (!this._initCompleted.has('feedbackSystem')) {
      const _done12b = _timing('Agent-Feedback-System');
      try {
        const { AgentFeedbackSystem } = require('./agent-feedback-system');
        this.feedbackSystem = new AgentFeedbackSystem({
          outputDir: this._outputDir,
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
      _done12b();
    }

    // ── Step 13: Register built-in Tool Hook handlers ─────────────────────────
    if (!this._initCompleted.has('toolHooks')) {
      const _done13 = _timing('Tool-Hooks');
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
      _done13();
    }

    // ── Step 14: Lifecycle Plugin Registry (init-phase activation) ──────────
    if (!this._initCompleted.has('lifecyclePluginRegistry')) {
      const _done14 = _timing('Lifecycle-Plugin-Registry');
      try {
        const { LifecyclePluginRegistry } = require('./lifecycle-plugin-registry');
        const pluginDir = path.join(__dirname, 'plugins');

        if (!this._pluginRegistry) {
          this._pluginRegistry = new LifecyclePluginRegistry();
          this._pluginRegistry.autoDiscover(pluginDir);
          this._pluginInstances = this._pluginInstances || {};
        }

        // Register into ServiceContainer so context-builders and other modules
        // can resolve it via services.resolve('pluginRegistry')
        if (this.services && typeof this.services.registerValue === 'function') {
          this.services.registerValue('pluginRegistry', this._pluginRegistry);
        }

        // Activate init-phase and both-phase plugins
        const { activated, failed } = await this._pluginRegistry.activateAll('init', this);

        // Store activated instances for plugin-internal access
        for (const plugin of this._pluginRegistry.getActivated()) {
          if (plugin._instance) {
            this._pluginInstances[plugin.name] = plugin._instance;
          }
        }

        // Subscribe plugin hooks to the HookSystem
        if (this.hooks) {
          this._pluginRegistry.subscribeAll(this.hooks);
        }

        if (activated.length > 0) {
          console.log(`[Orchestrator] 🔌 Lifecycle Plugin Registry (init): ${activated.length} plugin(s) activated${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
        }
      } catch (err) {
        console.warn(`[Orchestrator] ⚠️  [Step 14] Lifecycle Plugin Registry (init) failed (non-fatal): ${err.message}`);
      }
      _done14();
    }

    // ── Declarative Teardown Pipeline (P0 teardown-impl) ──────────────────
    if (!this._initCompleted.has('teardownPipeline')) {
      const _doneTeardown = _timing('Teardown-Pipeline');
      try {
        const { createTeardownPipeline } = require('./teardown-steps');
        this._teardownPipeline = createTeardownPipeline();

        // Register into ServiceContainer for bridge access
        if (this.services && typeof this.services.registerValue === 'function') {
          this.services.registerValue('teardownPipeline', this._teardownPipeline);
        }

        this._initCompleted.add('teardownPipeline');

        if (this._verbose) {
          const order = this._teardownPipeline.getOrder();
          console.log(`[Orchestrator] 🔧 Teardown Pipeline: ${order.length} step(s) registered`);
        }
      } catch (tpErr) {
        console.warn(`[Orchestrator] ⚠️  Teardown Pipeline init failed (will use legacy fallback): ${tpErr.message}`);
      }
      _doneTeardown();
    }

    // ── P2-STARTUP-1: Startup performance summary ──────────────────────────
    // Print a summary of init timings so developers can identify slow steps.
    if (this._initTimings) {
      const steps = Object.entries(this._initTimings);
      if (steps.length > 0) {
        const totalMs = steps.reduce((sum, [, t]) => sum + (t.durationMs || 0), 0);
        const slowSteps = steps
          .filter(([, t]) => (t.durationMs || 0) > 100)
          .sort((a, b) => (b[1].durationMs || 0) - (a[1].durationMs || 0));
        console.error(`[Orchestrator] ⏱️  _initWorkflow completed in ${totalMs}ms across ${steps.length} steps`);
        if (slowSteps.length > 0) {
          console.error(`[Orchestrator] 🐢 Slow steps (>100ms): ${slowSteps.map(([n, t]) => `${n}=${t.durationMs}ms`).join(', ')}`);
        }
        // Store on instance for health report access
        this._lastInitTotalMs = totalMs;
      }
    }

    return resumeState;  },

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

    // Step 8: NegotiationEngine — REMOVED (migrated to negotiation-engine-plugin.js)
    // The plugin's activate() now handles reset() during Lifecycle Plugin Registry init.

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
      const history = ObsStrategy.loadHistory(this._outputDir);
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
