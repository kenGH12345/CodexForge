/**
 * Orchestrator Teardown Implementation – Finalization Logic Mixin
 *
 * ADR-33 (P0 decomposition): Extracted from orchestrator-lifecycle.js.
 * Contains the complete teardown/finalization methods mixed into Orchestrator.prototype:
 *   - _finalizeWorkflow()     – shared teardown sequence
 *   - _runGitPRWorkflow()     – git PR workflow integration
 *   - Helper functions for risk correlation analysis
 *
 * This is a large mixin (~700 lines) that handles the complete teardown pipeline:
 *   1. AEF Self-Refinement (complaint resolution → skill evolution)
 *   2. Session Signal Detection + Quality Scoring
 *   3. Prompt A/B variant stats snapshot
 *   4. Adapter Telemetry report
 *   5. Self-Reflection quality gate validation
 *   6. Prompt Tracing flush
 *   7. RunGuard summary
 *   8. DecisionTrail timeline
 *   9. Skill Lifecycle sync and stale skill detection
 *   10. Observability flush and dashboard
 *   11. Risk Correlation Analysis
 *   12. MAPE Engine cycle
 *   13. Sleeptime maintenance pipeline
 *   14. Task history recording
 *   15. TechRadar/ArticleScout staleness checks
 *
 * @module orchestrator-teardown-impl
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { ExperienceType, ExperienceCategory, KnowledgeLayer, getLayerForCategory } = require('./experience-types');
const { ComplaintStatus } = require('./complaint-wall');
const { SessionSignalDetector } = require('./session-signal-detector');
const { SessionQualityScorer } = require('./session-quality-scorer');

// ─── P2 Feature Imports ─────────────────────────────────────────────────────
const { DashboardIntegration, generateDashboard } = require('./dashboard-integration');
// SmartRouterEnhancement: removed zombie require — already integrated inside
// llm-router.js via withSmartEnhancement(). No longer needed in teardown.
const { PromptAutoOptimizer } = require('./prompt-auto-optimizer');

// ─── Teardown Mixin ───────────────────────────────────────────────────────────

const OrchestratorTeardownMixin = {

  /**
   * Shared teardown sequence used by both run() and runTaskBased().
   * Flushes all observability, prints dashboards, generates reports, and triggers
   * evolution pipelines (MAPE, Sleeptime, AEF self-refinement).
   *
   * The sequence is carefully ordered:
   *   1. Evolution pipelines run BEFORE metrics flush so they're captured
   *   2. Metrics flush BEFORE dashboard print so numbers are accurate
   *   3. Dashboard print BEFORE git PR so summary is visible
   *   4. Git PR runs LAST so all artifacts are ready
   *
   * @param {string} mode - 'sequential' or 'task-based'
   * @param {object} extra - Additional context (goal, etc.)
   */
  async _finalizeWorkflow(mode, extra = {}) {
    // ── Declarative Teardown Pipeline (P0 teardown-impl) ──────────────────
    // If the pipeline is initialized, use the declarative approach.
    // Each step is an independent TeardownStep with before/after ordering.
    // Adding a new teardown step: 1 file + 1 registration line (was: 5+ files).
    if (this._teardownPipeline) {
      const shouldEvolve = this._shouldTriggerEvolution();
      const { TeardownContext } = require('./teardown-pipeline');
      const ctx = new TeardownContext({
        orch: this,
        mode,
        extra,
        shouldEvolve,
      });
      const summary = await this._teardownPipeline.execute(ctx);

      // Store summary for health reporting and bridge access
      this._teardownSummary = summary;

      // Log pipeline summary to observability
      if (this.obs && this.obs.recordTeardownPipeline) {
        this.obs.recordTeardownPipeline(summary);
      }
      return;
    }

    // ── Legacy fallback: hardcoded teardown sequence ─────────────────────
    // This path is kept for backward compatibility when _teardownPipeline
    // is not initialized. Will be removed in a future version.
    // Smart Trigger: determine which evolution modules should run
    const shouldEvolve = this._shouldTriggerEvolution();

    // ── Lifecycle Plugin Registry: Declarative module integration ──────────
    // Auto-discover and activate plugins from core/plugins/ directory.
    // This replaces hand-coded integration for FPA, IPC, RG, DAO, and RC.
    // Plugin instances are stored in this._pluginInstances for later access.
    try {
      const { LifecyclePluginRegistry } = require('./lifecycle-plugin-registry');
      const pluginDir = path.join(__dirname, 'plugins');

      if (!this._pluginRegistry) {
        this._pluginRegistry = new LifecyclePluginRegistry();
        this._pluginRegistry.autoDiscover(pluginDir);
        this._pluginInstances = this._pluginInstances || {};
      }

      // Activate all init-phase plugins (captures baselines, etc.)
      const { activated, failed } = await this._pluginRegistry.activateAll('teardown', this);

      // Store activated instances for plugin-internal access
      for (const plugin of this._pluginRegistry.getActivated()) {
        if (plugin._instance) {
          this._pluginInstances[plugin.name] = plugin._instance;
        }
      }

      if (activated.length > 0) {
        console.log(`[Orchestrator] 🔌 Plugin Registry: ${activated.length} plugin(s) activated${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
      }
    } catch (prErr) {
      console.warn(`[Orchestrator] ⚠️  Plugin Registry activation failed (non-fatal): ${prErr.message}`);
    }

    // ── AEF Self-Refinement: auto-evolve skills from resolved complaints ────
    if (this.complaintWall && this.skillEvolution && shouldEvolve.aefRefinement) {
      try {
        // Auto-evolve: for low-severity resolved complaints with clear patterns,
        // automatically add prevention rules to relevant skills
        const resolvedComplaints = this.complaintWall.complaints.filter(c => c.status === ComplaintStatus.RESOLVED && c.rootCause);
        for (const rc of resolvedComplaints.slice(-3)) {  // Last 3 resolved
          const skillName = rc.targetType === 'skill' ? rc.targetId : 'troubleshooting';
          if (this.skillEvolution.registry.has(skillName)) {
            this.skillEvolution.evolve(skillName, {
              section: 'Prevention Rules',
              title: `[Auto] Prevention for ${rc.rootCause}: ${rc.description.slice(0, 60)}`,
              content: `**Root Cause**: ${rc.rootCause}\n**Prevention**: ${rc.suggestion}\n**Source**: Complaint ${rc.id}`,
              sourceExpId: rc.id,
              reason: `AEF self-refinement: auto-evolve from resolved complaint`,
            });
          }
        }
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  AEF Self-Refinement analysis failed (non-fatal): ${srErr.message}`);
      }
    } else if (this.complaintWall && !shouldEvolve.aefRefinement) {
      console.log(`[Orchestrator] ⏭️  AEF Self-Refinement skipped (no open complaints or negative experiences)`);
    }

    // ── ADR-43: Session Signal Detection + Quality Scoring ──────────────────
    if (this._sessionSignalDetector && this.experienceStore) {
      try {
        // 1. Gather session context for signal detection
        const decisionLogContent = this.decisionTrail
          ? this.decisionTrail.getTimeline().map(t => `${t.stage}: ${t.decision}`).join('\n')
          : '';
        const errorLogContent = this.complaintWall
          ? this.complaintWall.getOpenComplaints().map(c => c.description).join('\n')
          : '';

        // 2. Detect signals from session
        const signalResult = this._sessionSignalDetector.detectSignals({
          decisionLog: decisionLogContent,
          errorLog: errorLogContent,
        });

        // 3. Score session quality
        const qualityScorer = new SessionQualityScorer({
          experienceStore: this.experienceStore,
          verbose: this._verbose,
        });
        const qualityResult = qualityScorer.scoreWithSignals(
          { decisionLog: decisionLogContent, errorLog: errorLogContent },
          signalResult
        );

        // 4. Capture experience if warranted
        if (qualityResult.shouldCapture && signalResult.signals.length > 0) {
          console.log(`\n${'─'.repeat(60)}`);
          console.log(`  🎯 SESSION SIGNAL CAPTURE (ADR-43)`);
          console.log(`${'─'.repeat(60)}`);
          console.log(`  Signals: ${signalResult.signals.length} (score: ${signalResult.score.toFixed(2)})`);
          console.log(`  Quality: ${qualityResult.qualityScore.toFixed(2)}`);
          console.log(`  Reason: ${qualityResult.reason}`);
          console.log(`${'─'.repeat(60)}\n`);

          // 5. Extract experience using LLM (only if signals detected)
          if (this._rawLlmCall && signalResult.signals.length > 0) {
            const extractionPrompt = this._sessionSignalDetector.buildExtractionPrompt({
              decisionLog: decisionLogContent,
              errorLog: errorLogContent,
            });

            this._rawLlmCall(extractionPrompt, 'session-signal-extraction')
              .then(response => {
                if (!response) return;

                // Parse JSON response
                let extracted = null;
                try {
                  let cleaned = response.trim();
                  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
                  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
                  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
                  const startIdx = cleaned.indexOf('{');
                  const endIdx = cleaned.lastIndexOf('}');
                  if (startIdx !== -1 && endIdx !== -1) {
                    extracted = JSON.parse(cleaned.slice(startIdx, endIdx + 1));
                  }
                } catch (_) { /* parse error, ignore */ }

                // Record extracted experiences
                if (extracted && extracted.experiences && Array.isArray(extracted.experiences)) {
                  for (const exp of extracted.experiences.slice(0, 2)) {
                    if (!exp.title || !exp.content) continue;

                    const category = exp.category || 'pitfall';
                    const layer = getLayerForCategory(category);

                    this.experienceStore.record({
                      type: exp.type || 'negative',
                      category,
                      title: exp.title,
                      content: `${exp.content}\n> _Source: Session Signal Detection (ADR-43)_`,
                      tags: [...(exp.tags || []), 'signal-captured', `layer:${layer}`],
                      ttlDays: exp.type === 'negative' ? 90 : 180,
                    });

                    console.log(`[Orchestrator] 📝 Captured experience: "${exp.title.slice(0, 50)}..." (layer: ${layer})`);
                  }
                }
              })
              .catch(err => {
                console.warn(`[Orchestrator] ⚠️  Signal extraction failed (non-fatal): ${err.message}`);
              });
          }
        } else {
          console.log(`[Orchestrator] ⏭️  Session Signal Capture skipped (${qualityResult.reason})`);
        }

        // 6. Check experience store layer health
        if (this.experienceStore.checkLayerHealth) {
          const layerHealth = this.experienceStore.checkLayerHealth(0.5);
          if (!layerHealth.healthy) {
            console.warn(`[Orchestrator] ⚠️  ${layerHealth.recommendation}`);
          }
        }

        // 7. Reset detector for next session
        this._sessionSignalDetector.reset();
      } catch (ssErr) {
        console.warn(`[Orchestrator] ⚠️  Session Signal Detection failed (non-fatal): ${ssErr.message}`);
      }
    }

    // ── P1: Failure Pattern Analyzer → Skill Evolution Insight ──────────────
    // Cluster similar failures from introspection data and generate Skill suggestions.
    // This closes the loop: failure → pattern → skill suggestion → evolution.
    if (shouldEvolve.selfReflection && this.experienceStore) {
      try {
        const { FailurePatternAnalyzer } = require('./failure-pattern-analyzer');
        const analyzer = new FailurePatternAnalyzer({
          cheapLlmCall: this._rawLlmCall || null,
          minOccurrenceThreshold: 2,
        });

        const result = await analyzer.analyzeRecentFailures();
        const patterns = result.patterns || [];
        if (patterns.length > 0) {
          console.log(`[Orchestrator] 🔍 FailurePatternAnalyzer: ${patterns.length} pattern(s) identified`);
          for (const p of patterns.slice(0, 5)) {
            const sig = p.signature || {};
            console.log(`  → ${sig.compoundKey || sig.failureType || 'unknown'} (occurrences: ${p.occurrences || p.count || '?'}, skill suggestion: ${p.suggestedSkillName || p.skillProposal?.name || 'none'})`);
          }

          // Auto-record patterns as negative experiences for future routing
          for (const p of patterns) {
            const sig = p.signature || {};
            const occ = p.occurrences || p.count || 1;
            if (occ >= 2) {
              this.experienceStore.recordIfAbsent(`failure-pattern:${sig.hash || Date.now()}`, {
                type: 'negative',
                category: 'failure_pattern',
                title: `Failure pattern: ${sig.failureType || 'unknown'} in ${sig.stage || 'unknown'}`,
                content: `Root cause: ${sig.rootCause || 'unknown'}. Error signatures: ${(sig.errorSignatures || []).join(', ')}. ` +
                         `Occurred ${occ} time(s). Suggested skill: ${p.suggestedSkillName || p.skillProposal?.name || 'none'}`,
                tags: ['failure-pattern', `stage:${sig.stage || 'unknown'}`, `root-cause:${sig.rootCause || 'unknown'}`],
                ttlDays: 90,
              });
            }
          }
        }
      } catch (fpaErr) {
        console.warn(`[Orchestrator] ⚠️  Failure Pattern Analyzer failed (non-fatal): ${fpaErr.message}`);
      }
    }

    // ── P1: Issue Pattern Collector → ExperienceStore ────────────────────────
    // Automatically record orphaned modules, broken routes, and missing artifacts
    // into the experience store for self-evolution awareness.
    // NOTE: IssuePatternCollector.recordIssue() writes to ExperienceStore immediately;
    // there is no flush() step. Use getIssues() / generateSummary() to count.
    if (this.experienceStore) {
      try {
        const { IssuePatternCollector, IssueType, IssueSeverity } = require('./issue-pattern-collector');
        const collector = new IssuePatternCollector(this.experienceStore, {
          projectContext: this.projectId || 'workflow',
          verbose: this._verbose,
        });

        // Scan for known issue types from introspection data
        if (this.introspectionManager) {
          const healthCheck = this.introspectionManager.healthCheck?.() || {};
          if (healthCheck.issues) {
            const uncovered = healthCheck.issues.uncoveredModules || [];
            for (const mod of uncovered) {
              const modName = typeof mod === 'string' ? mod : (mod.name || 'unknown');
              collector.recordFeatureOrphaned({
                feature: modName,
                location: `core/${modName}`,
                mainFlow: 'orchestrator pipeline',
                integrationPoint: '_finalizeWorkflow()',
                evidence: healthCheck.issues,
              });
            }
          }
        }

        // Summarize collected issues (recordIssue already wrote to ExperienceStore)
        const summary = collector.generateSummary();
        if (summary.total > 0) {
          console.log(`[Orchestrator] 🐛 IssuePatternCollector: ${summary.total} issue(s) recorded to ExperienceStore`);
          if (summary.critical.length > 0) {
            console.warn(`[Orchestrator] 🚨 ${summary.critical.length} critical issue(s) detected!`);
          }
        }
      } catch (ipcErr) {
        console.warn(`[Orchestrator] ⚠️  Issue Pattern Collector failed (non-fatal): ${ipcErr.message}`);
      }
    }

    // ── Prompt A/B: snapshot variant stats into Observability before flush ──
    if (this.promptSlotManager) {
      this.obs.recordPromptVariantUsage(this.promptSlotManager.getStats());
    }

    // ── Adapter Telemetry: snapshot block lifecycle stats into Observability ──
    if (this._adapterTelemetry) {
      try {
        const telemetryReport = this._adapterTelemetry.getReport();
        this.obs.recordBlockTelemetry(telemetryReport);
        if (telemetryReport.recommendations.length > 0) {
          console.log(`[Orchestrator] 📊 Adapter telemetry: ${telemetryReport.recommendations.length} recommendation(s):`);
          for (const rec of telemetryReport.recommendations.slice(0, 5)) {
            console.log(`  → ${rec}`);
          }
        }
        if (telemetryReport.summary.totalSavedByCompression > 0) {
          console.log(`[Orchestrator] 🗜️  Total compression savings: ${telemetryReport.summary.totalSavedByCompression} chars across ${telemetryReport.summary.totalBlocks} block(s).`);
        }
      } catch (telErr) {
        console.warn(`[Orchestrator] ⚠️  Adapter telemetry report failed (non-fatal): ${telErr.message}`);
      }
    }

    // ── P1 Self-Reflection: Quality Gate Validation + Proactive Audit ────────
    if (this._selfReflection && shouldEvolve.selfReflection) {
      try {
        const preFlushMetrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : null;

        if (preFlushMetrics) {
          const gatingResult = this._selfReflection.validateRun(preFlushMetrics);
          this.obs.recordReflectionGating(gatingResult);

          if (!gatingResult.passed) {
            console.warn(`[Orchestrator] ❌ Self-Reflection: ${gatingResult.gates.filter(g => !g.passed).length} quality gate(s) failed.`);
          }
        }

        const auditResult = await this._selfReflection.auditHealth();
        if (auditResult.findings.length > 0) {
          console.log(`[Orchestrator] 🔍 Self-Reflection health audit: ${auditResult.findings.length} finding(s)`);
        }

        this._selfReflection.flush();
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  Self-Reflection integration failed (non-fatal): ${srErr.message}`);
      }
    } else if (this._selfReflection && !shouldEvolve.selfReflection) {
      console.log(`[Orchestrator] ⏭️  Self-Reflection skipped (no errors, short session)`);
    }

    // ── P0 Prompt Tracing: flush prompt trace digests ──
    try {
      const tracesWritten = this.obs.flushPromptTraces();
      if (tracesWritten > 0) {
        console.log(`[Orchestrator] 📝 Prompt traces: ${tracesWritten} trace(s) persisted for replay & debugging.`);
      }
    } catch (ptErr) {
      console.warn(`[Orchestrator] ⚠️  Prompt trace flush failed (non-fatal): ${ptErr.message}`);
    }

    // ── Agent Self-Report: flush collected self-reports ──
    if (this._selfReportCollector) {
      try {
        const reportsWritten = this._selfReportCollector.flush();
        if (reportsWritten > 0) {
          const stats = this._selfReportCollector.getStats();
          console.log(`[Orchestrator] 📊 Agent Self-Reports: ${reportsWritten} report(s) persisted (compliance: ${stats.complianceRate}, avg confidence: ${stats.avgConfidence.toFixed(1)}/5).`);
        }
      } catch (srErr) {
        console.warn(`[Orchestrator] ⚠️  Agent Self-Report flush failed (non-fatal): ${srErr.message}`);
      }
    }

    // ── RunGuard summary ──
    if (this.runGuard) {
      try {
        const guardSummary = this.runGuard.formatSummary();
        if (guardSummary) {
          console.log(guardSummary);
        }
        if (this.obs.recordRunGuardSummary) {
          this.obs.recordRunGuardSummary(this.runGuard.getSummary());
        }
      } catch (rgErr) {
        console.warn(`[Orchestrator] ⚠️  RunGuard summary failed (non-fatal): ${rgErr.message}`);
      }
    }

    // ── DecisionTrail timeline ──
    if (this.decisionTrail) {
      try {
        const timeline = this.decisionTrail.formatTimeline();
        if (timeline) {
          console.log(timeline);
        }
      } catch (dtErr) {
        console.warn(`[Orchestrator] ⚠️  DecisionTrail summary failed (non-fatal): ${dtErr.message}`);
      }
    }

    // ── StageSmartSkip summary ──
    if (this.stageSmartSkip) {
      try {
        const skipSummary = this.stageSmartSkip.formatSummary();
        if (skipSummary) {
          console.log(skipSummary);
        }
      } catch (ssErr) {
        console.warn(`[Orchestrator] ⚠️  StageSmartSkip summary failed (non-fatal): ${ssErr.message}`);
      }
    }

    // ── Skill Lifecycle sync ──
    if (this.skillEvolution && this.obs._skillInjectedCounts) {
      try {
        for (const [skillName, count] of this.obs._skillInjectedCounts) {
          this.skillEvolution.recordUsage(skillName, count);
        }
        for (const skillName of this.obs._skillEffectiveSet) {
          this.skillEvolution.recordEffective(skillName);
        }

        // P2: sync quality-gate effectiveness signals (pass/fail + false-positive proxies)
        const skillSnapshot = this.obs.getSkillEffectivenessSnapshot
          ? this.obs.getSkillEffectivenessSnapshot()
          : null;
        if (skillSnapshot) {
          const gatePass = skillSnapshot.gatePass || {};
          const gateFail = skillSnapshot.gateFail || {};
          const fpSignals = skillSnapshot.falsePositiveSignals || {};
          const allNames = new Set([
            ...Object.keys(gatePass),
            ...Object.keys(gateFail),
            ...Object.keys(fpSignals),
          ]);
          for (const skillName of allNames) {
            const passCount = Number(gatePass[skillName] || 0);
            const failCount = Number(gateFail[skillName] || 0);
            const fpCount = Number(fpSignals[skillName] || 0);

            for (let i = 0; i < passCount; i++) {
              this.skillEvolution.recordGateOutcome(skillName, { passed: true, falsePositiveSignals: 0 });
            }
            for (let i = 0; i < failCount; i++) {
              this.skillEvolution.recordGateOutcome(skillName, { passed: false, falsePositiveSignals: 0 });
            }
            if (fpCount > 0) {
              this.skillEvolution.recordGateOutcome(skillName, { passed: true, falsePositiveSignals: fpCount });
            }
          }
        }

        this.skillEvolution.flushLifecycleStats();

        // P2: auto downweight/retire low-adoption high-noise skills
        const policyResult = this.skillEvolution.applyEffectivenessPolicy
          ? this.skillEvolution.applyEffectivenessPolicy()
          : { downweighted: [], retired: [] };
        if (policyResult.downweighted.length > 0 || policyResult.retired.length > 0) {
          console.log(`[Orchestrator] 🧪 Skill effectiveness policy: ${policyResult.downweighted.length} downweighted, ${policyResult.retired.length} retired.`);
          for (const s of policyResult.downweighted.slice(0, 5)) {
            console.log(`[Orchestrator]   ↓ ${s.name}: weight ${s.oldWeight} → ${s.newWeight} (adoption=${s.adoptionRate}, fpRate=${s.falsePositiveRate})`);
          }
          for (const s of policyResult.retired.slice(0, 5)) {
            console.log(`[Orchestrator]   📦 retired ${s.name} (gateFail=${s.gateFailCount}, fpRate=${s.falsePositiveRate})`);
          }
        }

        const { stale } = this.skillEvolution.retireStaleSkills({ dryRun: true });
        if (stale.length > 0) {
          console.log(`[Orchestrator] 📦 Stale skill detection: ${stale.length} skill(s) underperforming:`);
          for (const s of stale) {
            const hr = ((s.effectiveCount || 0) / (s.usageCount || 1) * 100).toFixed(0);
            console.log(`[Orchestrator]   - ${s.name}: ${hr}% effective (${s.usageCount} uses)`);
          }
        }

        // ADR-32 P4: Stale Skill Auto-Refresh
        if (this.skillEvolution) {
          try {
            const STALE_DAYS = 90;
            const now = Date.now();
            const refreshCandidates = [];

            for (const meta of this.skillEvolution.registry.values()) {
              if (meta.retiredAt) continue;
              const lastEvolved = meta.lastEvolvedAt ? new Date(meta.lastEvolvedAt).getTime() : 0;
              const created = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
              const latestActivity = Math.max(lastEvolved, created);
              const daysSince = latestActivity > 0 ? (now - latestActivity) / (24 * 60 * 60 * 1000) : Infinity;

              if (daysSince > STALE_DAYS && (meta.usageCount || 0) > 0) {
                refreshCandidates.push(meta.name);
              }
            }

            if (refreshCandidates.length > 0) {
              console.log(`[Orchestrator] 🔄 Auto-refreshing ${refreshCandidates.length} stale skill(s)`);
              const { enrichSkillFromExternalKnowledge } = require('./context-budget-manager');
              for (const skillName of refreshCandidates.slice(0, 3)) {
                enrichSkillFromExternalKnowledge(this, skillName, { maxSearchResults: 3, maxFetchPages: 2 })
                  .then(r => {
                    if (r.success && r.sectionsAdded > 0) {
                      console.log(`[Orchestrator] 🔄→📝 Auto-refreshed stale skill "${skillName}": ${r.sectionsAdded} entries updated.`);
                    }
                  })
                  .catch(() => { /* non-fatal */ });
              }
            }
          } catch (refreshErr) {
            console.warn(`[Orchestrator] ⚠️ Stale skill auto-refresh failed (non-fatal): ${refreshErr.message}`);
          }
        }
      } catch (skillSyncErr) {
        console.warn(`[Orchestrator] ⚠️  Skill lifecycle sync failed (non-fatal): ${skillSyncErr.message}`);
      }
    }

    // ── Defect #3 fix: flush metrics BEFORE printDashboard ──
    try {
      this.obs.flush();
    } catch (flushErr) {
      console.warn(`[Orchestrator] ⚠️  Observability flush failed (non-fatal): ${flushErr.message}`);
    }

    // ── Agent Handoff Log: print summary and flush ──────────────────────────────
    if (this.handoffLog) {
      try {
        this.handoffLog.printSummary();
        this.handoffLog.flush();
      } catch (handoffErr) {
        console.warn(`[Orchestrator] ⚠️  Handoff Log flush failed (non-fatal): ${handoffErr.message}`);
      }
    }

    // ── P1 ADR-34: YELLOW Tier Auto-Deploy ──
    if (this.autoDeployer && shouldEvolve.autoDeploy) {
      try {
        const Observability = require('./observability');
        const cfgAutoFix = (this._config && this._config.autoFixLoop) || {};
        const postRunStrategy = Observability.deriveStrategy(this._outputDir, {
          maxFixRounds: cfgAutoFix.maxFixRounds ?? 2,
          maxReviewRounds: cfgAutoFix.maxReviewRounds ?? 2,
          maxExpInjected: cfgAutoFix.maxExpInjected ?? 5,
          projectId: this.projectId,
        });

        if (postRunStrategy.source !== 'defaults') {
          const yellowResult = this.autoDeployer.applyYellow(postRunStrategy);
          if (yellowResult.applied && yellowResult.changes.length > 0) {
            console.log(`[Orchestrator] 🟡 Auto-Deploy: ${yellowResult.changes.length} config param(s) updated for next run.`);
          }
        }
      } catch (adErr) {
        console.warn(`[Orchestrator] ⚠️  Auto-Deploy (YELLOW) failed (non-fatal): ${adErr.message}`);
      }
    } else if (this.autoDeployer && !shouldEvolve.autoDeploy) {
      console.log(`[Orchestrator] ⏭️  Auto-Deploy YELLOW skipped (no strategy history)`);
    }

    // Print Observability dashboard
    try {
      this.obs.printDashboard();
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Observability dashboard failed (non-fatal): ${dashErr.message}`);
    }

    // Generate HTML report
    try {
      const reportPath = this.obs.generateHTMLReport();
      console.log(`[Orchestrator] 📊 HTML session report: ${reportPath}`);
    } catch (htmlErr) {
      console.warn(`[Orchestrator] ⚠️  HTML report generation failed (non-fatal): ${htmlErr.message}`);
    }

    // P3: Generate cross-session trends report
    try {
      const ObsStrategy = require('./observability-strategy');
      const history = ObsStrategy.loadHistory(PATHS.OUTPUT_DIR);
      const trendsPath = ObsStrategy.generateTrendsReport(history, PATHS.OUTPUT_DIR);
      if (trendsPath) {
        console.log(`[Orchestrator] 📈 Cross-session trends report: ${trendsPath}`);
      }
    } catch (trendsErr) {
      console.warn(`[Orchestrator] ⚠️  Trends report generation failed (non-fatal): ${trendsErr.message}`);
    }

    // ── P2 Feature #1: Dashboard Integration – Visual analytics and feedback reporting ───
    try {
      const dashboardPath = generateDashboard({
        outputDir: this._outputDir || PATHS.OUTPUT,
      });
      if (dashboardPath) {
        console.log(`[Orchestrator] 📊 Integrated Dashboard generated: ${dashboardPath}`);
      }
    } catch (dashErr) {
      console.warn(`[Orchestrator] ⚠️  Dashboard integration failed (non-fatal): ${dashErr.message}`);
    }

    // ── P3 Cross-Stage Risk Correlation Analysis ──
    const risks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (risks.length >= 2) {
      try {
        const correlatedRisks = _analyseRiskCorrelations(risks, this.stageCtx);
        if (correlatedRisks.length > 0) {
          console.warn(`\n${'─'.repeat(60)}`);
          console.warn(`  🔗 RISK CORRELATION ANALYSIS (${correlatedRisks.length} chain(s) found)`);
          console.warn(`${'─'.repeat(60)}`);
          for (const chain of correlatedRisks) {
            console.warn(`  ⛓️  [${chain.severity.toUpperCase()}] ${chain.label}`);
            console.warn(`      Contributing factors:`);
            for (const factor of chain.factors) {
              console.warn(`        → [${factor.stage}] ${factor.description.slice(0, 120)}`);
            }
            console.warn(`      Impact: ${chain.impact}`);
            if (chain.recommendation) {
              console.warn(`      Recommendation: ${chain.recommendation}`);
            }
            this.stateMachine.recordRisk(chain.severity,
              `[RiskCorrelation] ${chain.label}: ${chain.factors.map(f => f.description.slice(0, 60)).join(' + ')}. Impact: ${chain.impact}`,
              false
            );
          }
          console.warn(`${'─'.repeat(60)}`);
          this.stateMachine.flushRisks();
        }
      } catch (corrErr) {
        console.warn(`[Orchestrator] ⚠️  Risk correlation analysis failed (non-fatal): ${corrErr.message}`);
      }
    }

    // Print accumulated risk summary
    const allRisks = this.stateMachine.getRisks ? this.stateMachine.getRisks() : [];
    if (allRisks.length > 0) {
      console.warn(`\n${'─'.repeat(60)}`);
      console.warn(`  ⚠️  RISK SUMMARY (${allRisks.length} item(s))`);
      console.warn(`${'─'.repeat(60)}`);
      for (const r of allRisks) {
        console.warn(`  [${r.severity?.toUpperCase() ?? 'UNKNOWN'}] ${r.description}`);
      }
      console.warn(`${'─'.repeat(60)}\n`);
    }

    // ── Dry-run: save report and print summary ──
    if (this.dryRun && this.sandbox.pendingCount > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  🧪 DRY-RUN SUMMARY: ${this.sandbox.pendingCount} pending operation(s)`);
      console.log(`${'─'.repeat(60)}`);
      const reportPath = this.sandbox.saveReport();
      console.log(`  Report saved to: ${reportPath}`);
      console.log(`  To apply changes: await orchestrator.sandbox.apply()`);
      console.log(`${'─'.repeat(60)}\n`);
      await this.hooks.emit(HOOK_EVENTS.DRYRUN_REPORT_SAVED, {
        reportPath,
        pendingCount: this.sandbox.pendingCount,
        ops: this.sandbox.getPendingOps().map(op => ({ type: op.type, path: op.relPath })),
      });
    }

    // ── Optimistic lock: report conflicts and reset ──
    try {
      const { fileLockManager } = require('./file-lock-manager');
      const lockStats = fileLockManager.getStats();
      if (lockStats.conflicts > 0) {
        console.warn(`\n${'─'.repeat(60)}`);
        console.warn(`  🔒 OPTIMISTIC LOCK SUMMARY`);
        console.warn(`  Tracked files: ${lockStats.trackedFiles} | Conflicts: ${lockStats.conflicts}`);
        for (const c of fileLockManager.getConflicts().slice(-5)) {
          console.warn(`  [${c.acquiredBy}→${c.conflictBy}] ${path.basename(c.file)}`);
        }
        console.warn(`${'─'.repeat(60)}\n`);
      }
      fileLockManager.reset();
    } catch (err) { console.warn(`[Orchestrator] fileLockManager.reset() failed: ${err.message}`); }

    // ── DocGen: Auto-generate CHANGELOG.md ──
    try {
      if (this.services && this.services.has('mcpRegistry')) {
        const registry = this.services.resolve('mcpRegistry');
        let docGenAdapter;
        try { docGenAdapter = registry.get('doc-gen'); } catch (_) { /* not registered */ }
        if (docGenAdapter && docGenAdapter.isConnected) {
          const changelogResult = await docGenAdapter.generateChangelog();
          if (changelogResult.markdown && changelogResult.entries.length > 0) {
            const changelogPath = docGenAdapter.appendChangelog(changelogResult.markdown);
            if (changelogPath) {
              console.log(`[Orchestrator] 📝 CHANGELOG.md auto-updated: ${changelogResult.entries.length} commit(s) for v${changelogResult.version}.`);
            }
          }
        }
      }
    } catch (clErr) {
      console.warn(`[Orchestrator] ⚠️  CHANGELOG auto-generation failed (non-fatal): ${clErr.message}`);
    }

    // ── P1-2: Flush NegotiationEngine log ──
    if (this.negotiation) {
      try {
        const negLog = this.negotiation.getLog();
        if (negLog.length > 0) {
          this.negotiation.flush();
          console.log(`[Orchestrator] 🤝 NegotiationEngine: ${negLog.length} negotiation(s) persisted.`);
        }
      } catch (negErr) {
        console.warn(`[Orchestrator] ⚠️  NegotiationEngine flush failed (non-fatal): ${negErr.message}`);
      }
    }

    // ── P2-1: ExperienceRouter publish ──
    if (this.experienceRouter) {
      try {
        const pubResult = this.experienceRouter.publish();
        if (pubResult.published > 0) {
          console.log(`[Orchestrator] 🌐 ExperienceRouter: published ${pubResult.published} experience(s) to cross-project registry.`);
        }
      } catch (pubErr) {
        console.warn(`[Orchestrator] ⚠️  ExperienceRouter publish failed (non-fatal): ${pubErr.message}`);
      }
    }

    // ── P2-1: EventJournal flush and close ──
    if (this.eventJournal) {
      try {
        await this.eventJournal.close();
        const stats = this.eventJournal.getStats();
        console.log(`[Orchestrator] 📖 EventJournal: ${stats.totalEvents} events captured in ${path.basename(this.eventJournal.journalPath)}`);
      } catch (ejErr) {
        console.warn(`[Orchestrator] ⚠️  EventJournal close failed (non-fatal): ${ejErr.message}`);
      }
    }

    // ── P0: refresh metrics cache + mark workflow end checkpoint ──
    if (this.p0RuntimeLoop) {
      try {
        const cacheResult = this.p0RuntimeLoop.refreshMetricsCache();
        this.p0RuntimeLoop.markWorkflowEnd({
          mode,
          metricsCacheHit: cacheResult.hit,
        });
        this.p0RuntimeLoop.detachEventJournal();
      } catch (p0Err) {
        console.warn(`[Orchestrator] ⚠️  P0 runtime loop finalization failed (non-fatal): ${p0Err.message}`);
      }
    }

    // ── P1-4: Structured Logger flush and close ──
    if (this.logger) {
      try {
        this.logger.info('Orchestrator', 'Workflow finalisation complete', {
          mode,
          projectId: this.projectId,
        });
        const entryCount = this.logger.flush();
        if (entryCount > 0) {
          console.log(`[Orchestrator] 📝 Structured Logger: ${entryCount} log entries written to workflow.log.jsonl`);
        }
      } catch (logErr) {
        console.warn(`[Orchestrator] ⚠️  Logger flush failed (non-fatal): ${logErr.message}`);
      }
    }

    // ── Git PR workflow ──
    if (this._gitOptions.enabled && !this.dryRun) {
      await this._runGitPRWorkflow(mode, extra);
    }

    // ── P1: Regression Guard – Capture pre-evolve quality baseline ──────────
    // Before any evolution (MAPE/sleeptime) runs, capture the current quality
    // metrics as a baseline. After evolution, compare to detect regressions.
    let regressionGuard = null;
    try {
      const { RegressionGuard } = require('./regression-guard');
      regressionGuard = new RegressionGuard({
        outputDir: this._outputDir || PATHS.OUTPUT,
        verbose: this._verbose,
      });
      const metrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : {};
      regressionGuard.captureBaseline();
      console.log(`[Orchestrator] 🛡️  RegressionGuard: quality baseline captured for post-evolve comparison.`);
    } catch (rgErr) {
      console.warn(`[Orchestrator] ⚠️  RegressionGuard baseline capture failed (non-fatal): ${rgErr.message}`);
    }

    // ── P0 MAPE Engine: Self-Adaptive Closed-Loop ──
    if (shouldEvolve.mape) {
      try {
        const { MAPEEngine } = require('./mape-engine');
        const mape = new MAPEEngine({ orchestrator: this, verbose: this._verbose });

        const mapeReport = await mape.runCycle({ dryRun: false, maxActions: 5 });

        if (mapeReport.phases.monitor.signalCount > 0) {
          console.log(`[Orchestrator] 🔄 MAPE Engine: ${mapeReport.phases.monitor.signalCount} signal(s) detected`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.analyze.rootCauses} root cause(s), ${mapeReport.phases.analyze.correlations} correlation(s)`);
          console.log(`[Orchestrator]    → ${mapeReport.phases.execute.executed} action(s) executed, ${mapeReport.phases.execute.skipped} skipped`);
        }

        if (this.obs && typeof this.obs.recordCustomMetric === 'function') {
          this.obs.recordCustomMetric('mape_cycle', {
            signalCount: mapeReport.phases.monitor.signalCount,
            rootCauses: mapeReport.phases.analyze.rootCauses,
            correlations: mapeReport.phases.analyze.correlations,
            executed: mapeReport.phases.execute.executed,
            elapsed: mapeReport.elapsed,
          });
        }
      } catch (mapeErr) {
        console.warn(`[Orchestrator] ⚠️  MAPE Engine cycle failed (non-fatal): ${mapeErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  MAPE Engine skipped (no anomaly signals or insufficient history)`);
    }

    // ── P1: Regression Guard – Post-evolve quality delta check ──────────────
    // Compare post-evolve metrics against the baseline captured before MAPE.
    // If quality degraded after skill/config changes, flag for auto-rollback.
    if (regressionGuard) {
      try {
        const postMetrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : {};
        const regressionResult = regressionGuard.compareWithBaseline(postMetrics);

        if (regressionResult.regressions.length > 0) {
          console.warn(`[Orchestrator] 🛡️  RegressionGuard: ${regressionResult.regressions.length} regression(s) detected after evolve!`);
          for (const reg of regressionResult.regressions.slice(0, 5)) {
            console.warn(`  → ${reg.metric}: ${reg.direction === 'minimize' ? '↑' : '↓'} ${reg.delta} (threshold: ${reg.threshold})`);
          }

          // Record regression as negative experience
          if (this.experienceStore) {
            this.experienceStore.recordIfAbsent('evolve-regression', {
              type: 'negative',
              category: 'quality_gate',
              title: 'Quality regression detected after evolve cycle',
              content: `Regressions: ${regressionResult.regressions.map(r => `${r.metric} ${r.delta}`).join(', ')}`,
              tags: ['regression', 'evolve', 'quality-guard'],
              ttlDays: 90,
            });
          }
        } else {
          console.log(`[Orchestrator] 🛡️  RegressionGuard: no regressions detected — evolve cycle was safe.`);
        }
      } catch (rgErr) {
        console.warn(`[Orchestrator] ⚠️  RegressionGuard post-evolve check failed (non-fatal): ${rgErr.message}`);
      }
    }

    // ── Sleeptime Maintenance Pipeline ──
    if (shouldEvolve.sleeptime) {
      try {
        const { sleeptime } = require('./sleeptime');
        const sleeptimeResult = await sleeptime({
          experienceStore: this.experienceStore,
          skillEvolution: this.skillEvolution,
          selfReflection: this._selfReflection,
          verbose: true,
        });
        if (this.obs && typeof this.obs.recordCustomMetric === 'function') {
          this.obs.recordCustomMetric('sleeptime', {
            totalDurationMs: sleeptimeResult.totalDurationMs,
            stages: sleeptimeResult.stages.map(s => ({ name: s.name, status: s.status })),
          });
        }
      } catch (stErr) {
        console.warn(`[Orchestrator] ⚠️  Sleeptime pipeline failed (non-fatal): ${stErr.message}`);
      }
    } else {
      console.log(`[Orchestrator] ⏭️  Sleeptime skipped (low experience/skill count)`);
    }

    // ── Recall Memory + Session Memory: record task history (L3) ──
    // ── Long-term Memory Extraction: capture stable lessons (L5) ──
    try {
      const { TaskHistory } = require('./task-history');
      const taskHistory = new TaskHistory();
      const metrics = this.obs.getMetricsSnapshot ? this.obs.getMetricsSnapshot() : {};
      const allTasks = this.taskManager ? this.taskManager.getAllTasks() : [];
      const doneTasks = allTasks.filter(t => t.status === 'done');
      const failedTasks = allTasks.filter(t => t.status === 'failed' || t.status === 'exhausted');
      const outcome = failedTasks.length === 0 ? 'success'
                    : doneTasks.length > 0 ? 'partial'
                    : 'failed';

      const changedFiles = (() => {
        try {
          const entries = this.handoffLog && typeof this.handoffLog.getEntries === 'function'
            ? this.handoffLog.getEntries()
            : [];
          const out = [];
          for (const e of entries || []) {
            const filePath = e?.path || e?.file || e?.artifact || e?.ref || null;
            if (typeof filePath === 'string' && filePath.trim()) out.push(filePath.trim());
          }
          return [...new Set(out)].slice(0, 20);
        } catch (_) {
          return [];
        }
      })();

      const riskList = (() => {
        try {
          const rs = this.stateMachine && typeof this.stateMachine.getRisks === 'function'
            ? this.stateMachine.getRisks()
            : [];
          return (rs || []).map(r => r?.description || '').filter(Boolean).slice(0, 8);
        } catch (_) {
          return [];
        }
      })();

      const decisionList = (() => {
        try {
          const timeline = this.decisionTrail && typeof this.decisionTrail.getTimeline === 'function'
            ? this.decisionTrail.getTimeline()
            : [];
          return (timeline || [])
            .map(t => t?.decision || t?.summary || '')
            .filter(Boolean)
            .slice(-8);
        } catch (_) {
          return [];
        }
      })();

      const openItems = failedTasks.map(t => t.title || '').filter(Boolean).slice(0, 8);

      taskHistory.record({
        mode,
        goal: extra.goal || this._currentRequirement || '',
        projectId: this.projectId,
        taskCount: allTasks.length,
        taskTitles: doneTasks.map(t => t.title || '').slice(0, 10),
        outcome,
        metrics: {
          durationMs: metrics.totalDurationMs || (Date.now() - (this.obs._startedAt || Date.now())),
          errorCount: (metrics.errors && metrics.errors.count) || 0,
          expRecorded: this.experienceStore ? this.experienceStore.getStats().total : 0,
        },
        sessionMemory: {
          decisions: decisionList,
          changedFiles,
          openItems,
          risks: riskList,
        },
      });
      console.log(`[Orchestrator] 📖 Task history recorded for recall/session memory (${taskHistory.getStats().totalEntries} total entries).`);

      // L5: extract stable long-term memory into ExperienceStore
      if (this.experienceStore && typeof this.experienceStore.recordIfAbsent === 'function') {
        const stablePatternTitle = `Workflow completion pattern: ${mode} outcome=${outcome}`;
        this.experienceStore.recordIfAbsent(stablePatternTitle, {
          type: outcome === 'failed' ? ExperienceType.NEGATIVE : ExperienceType.POSITIVE,
          category: ExperienceCategory.STABLE_PATTERN,
          title: stablePatternTitle,
          content: [
            `Mode: ${mode}`,
            `Outcome: ${outcome}`,
            `Done tasks: ${doneTasks.length}/${allTasks.length}`,
            `Top decisions: ${(decisionList || []).slice(0, 3).join(' | ') || 'N/A'}`,
            `Top risks: ${(riskList || []).slice(0, 3).join(' | ') || 'N/A'}`,
          ].join('\n'),
          tags: ['long-term-memory', 'workflow-completion', `mode:${mode}`, `outcome:${outcome}`],
          ttlDays: 180,
        });

        if (changedFiles.length > 0) {
          const projectConventionsTitle = `Project convention signal: changed files pattern (${mode})`;
          this.experienceStore.recordIfAbsent(projectConventionsTitle, {
            type: ExperienceType.POSITIVE,
            category: ExperienceCategory.WORKFLOW_PROCESS,
            title: projectConventionsTitle,
            content: `Frequent changed files in this session:\n${changedFiles.slice(0, 12).map(f => `- ${f}`).join('\n')}`,
            tags: ['long-term-memory', 'project-convention', 'file-pattern'],
            ttlDays: 180,
          });
        }

        if (outcome !== 'success' && riskList.length > 0) {
          const pitfallTitle = `Recurring pitfall candidate: ${mode} ${riskList[0].slice(0, 80)}`;
          this.experienceStore.recordIfAbsent(pitfallTitle, {
            type: ExperienceType.NEGATIVE,
            category: ExperienceCategory.PITFALL,
            title: pitfallTitle,
            content: `Potential recurring pitfall observed at workflow finalization.\n${riskList.slice(0, 5).map(r => `- ${r}`).join('\n')}`,
            tags: ['long-term-memory', 'pitfall', `mode:${mode}`],
            ttlDays: 120,
          });
        }

        console.log(`[Orchestrator] 🧠 Long-term memory extraction completed (L5).`);
      }

      try {
        const { rebuildCache } = require('./arch-knowledge-cache');
        rebuildCache(this.projectRoot, { projectProfile: this._config && this._config.projectProfile });
      } catch (cacheErr) {
        console.warn(`[Orchestrator] ⚠️  Arch knowledge cache rebuild failed (non-fatal): ${cacheErr.message}`);
      }
    } catch (thErr) {
      console.warn(`[Orchestrator] ⚠️  Task/session memory recording failed (non-fatal): ${thErr.message}`);
    }

    // ── ADR-38: TechRadar Staleness Check ──
    try {
      const { isTechRadarStale } = require('./techradar');
      const staleness = isTechRadarStale(this._manifest && this._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 TechRadar: ${daysText} since last tech scan.`);
        console.log(`[Orchestrator]    Run /techradar to discover new techniques and evaluate upgrades.`);
      }
    } catch (trErr) { /* Non-fatal */ }

    // ── ADR-32 P3: ArticleScout Staleness Check ──
    try {
      const { isArticleScoutStale } = require('./article-scout');
      const staleness = isArticleScoutStale(this._manifest && this._manifest.meta);

      if (staleness.isStale) {
        const daysText = staleness.daysSince === Infinity ? 'never' : `${staleness.daysSince} days`;
        console.log(`[Orchestrator] 🔔 ArticleScout: ${daysText} since last article discovery.`);
        console.log(`[Orchestrator]    Run /article-scout to discover high-value AI/Agent articles.`);
      }
    } catch (asErr) { /* Non-fatal */ }

    // ── Workflow Introspection: Finalize and generate reports ──
    if (this.introspectionManager) {
      try {
        // Perform validation before finalizing
        const healthCheck = this.introspectionManager.healthCheck();
        if (!healthCheck.healthy) {
          console.warn(`[Orchestrator] ⚠️  Introspection health check: ${healthCheck.issues.errors} error(s), ${healthCheck.issues.warnings} warning(s)`);
          console.warn(`[Orchestrator]    ${healthCheck.suggestion}`);
        } else {
          console.log(`[Orchestrator] ✅ Introspection health check: All modules operating consistently (${healthCheck.moduleCoverage} modules active)`);
        }

        // Generate final reports
        const reportPaths = this.introspectionManager.generateReports();
        if (reportPaths.markdownPath) {
          console.log(`[Orchestrator] 🔍 Workflow Introspection Report: ${reportPaths.markdownPath}`);
        }

        // Finalize the introspection session
        this.introspectionManager.finalize();
      } catch (introspectionErr) {
        console.warn(`[Orchestrator] ⚠️  Introspection finalize failed (non-fatal): ${introspectionErr.message}`);
      }
    }

    // ── ADR-XX: Execution Log Validation ────────────────────────────────────
    // Auto-validate execution against standard workflow flow templates
    // Generates execution quality report for post-mortem analysis
    try {
      const shouldValidate = this._config?.executionValidation !== false;
      if (shouldValidate) {
        const { ExecutionLogValidator } = require('./execution-log-validator');
        const validator = new ExecutionLogValidator({
          outputDir: this._outputDir || PATHS.OUTPUT,
          verbose: false, // Silent mode during automation
          strictMode: false,
          reportOutputDir: this._outputDir || PATHS.OUTPUT,
        });

        console.log(`[Orchestrator] 🔍 Running execution validation...`);
        const validationResult = await validator.validate();

        // Log summary to console
        const { summary } = validationResult.report;
        const statusEmoji = summary.status === 'passed' ? '✅' :
                           summary.status === 'passed_with_warnings' ? '⚠️' : '❌';
        console.log(`[Orchestrator] ${statusEmoji} Execution Validation: ${summary.status.toUpperCase()} (${summary.score}/100)`);
        console.log(`[Orchestrator]    Stages: ${summary.completedStages}/${summary.totalStages} completed, ${summary.failedStages} failed`);

        if (summary.warnings > 0) {
          console.log(`[Orchestrator]    Warnings: ${summary.warnings}`);
        }

        // Store validation result for downstream consumers
        this._lastExecutionValidation = validationResult;

        // Inject low-score findings into ExperienceStore
        if (summary.score < 80 && this.experienceStore) {
          this.experienceStore.recordIfAbsent('execution-validation-low-score', {
            type: 'negative',
            category: 'execution_quality',
            title: 'Execution validation score below threshold',
            content: `Execution validation score: ${summary.score}/100. ` +
                     `Failed stages: ${summary.failedStages}. ` +
                     `Warnings: ${summary.warnings}. ` +
                     `Report: ${validationResult.reportPaths?.latestMarkdown || 'N/A'}`,
            tags: ['execution-validation', 'quality-issue'],
            metrics: { score: summary.score },
          });

          console.log(`[Orchestrator]    ⚠️  Low execution quality recorded to ExperienceStore`);
        }

      // Show report location
        if (validationResult.reportPaths?.latestMarkdown) {
          console.log(`[Orchestrator]    Report: ${path.basename(validationResult.reportPaths.latestMarkdown)}`);
        }
      } else {
        console.log(`[Orchestrator] ⏭️  Execution validation skipped (disabled in config)`);
      }
    } catch (validationErr) {
      console.warn(`[Orchestrator] ⚠️  Execution validation failed (non-fatal): ${validationErr.message}`);
    }

    // ── ADR-52: Independent Evaluator – Multi-dimensional quality assessment ───
    // Run AFTER execution validation so artifacts are confirmed to exist.
    // This evaluator reads from DISK (not memory) to avoid "self-grading" bias.
    try {
      const { runIndependentEvaluation, createEvaluationGates } = require('./independent-evaluator');
      const outputDir = this._outputDir || PATHS.OUTPUT;

      console.log(`[Orchestrator] 🔬 Independent Evaluator: Running multi-dimensional assessment...`);
      const evaluation = runIndependentEvaluation(outputDir, {
        evaluatorMode: 'independent',
      });

      // Log evaluation summary
      const { summary, dimensions } = evaluation;
      console.log(`[Orchestrator]    Composite Score: ${summary.compositeScore}/100`);
      console.log(`[Orchestrator]    Passed: ${summary.passed ? '✅' : '❌'} (threshold: 60)`);
      console.log(`[Orchestrator]    Quality Gate: ${summary.qualityGatePassed ? '✅' : '❌'} (threshold: 70)`);

      for (const [dim, score] of Object.entries(summary.dimensions)) {
        console.log(`[Orchestrator]      - ${dim}: ${score}`);
      }

      // Generate recommendations if score is low
      if (summary.recommendations?.length > 0) {
        console.log(`[Orchestrator]    📋 Recommendations:`);
        for (const rec of summary.recommendations.slice(0, 3)) {
          console.log(`[Orchestrator]       [${rec.priority}] ${rec.message}`);
        }
      }

      // Save evaluation report
      const evaluationReportPath = path.join(outputDir, 'evaluation-report.json');
      fs.writeFileSync(evaluationReportPath, JSON.stringify(evaluation, null, 2));
      console.log(`[Orchestrator]    📄 Evaluation report: evaluation-report.json`);

      // Record low scores to ExperienceStore
      if (summary.compositeScore < 60 && this.experienceStore) {
        this.experienceStore.recordIfAbsent('evaluation-low-score', {
          type: 'negative',
          category: 'quality_gate',
          title: 'Independent evaluation score below threshold',
          content: `Composite score: ${summary.compositeScore}/100. ` +
                   `Dimensions: ${JSON.stringify(summary.dimensions)}. ` +
                   `Recommendations: ${summary.recommendations?.slice(0, 3).map(r => r.message).join('; ')}`,
          tags: ['evaluation', 'quality-issue', 'adr-52'],
          metrics: { compositeScore: summary.compositeScore },
        });
      }
    } catch (evalErr) {
      console.warn(`[Orchestrator] ⚠️  Independent Evaluator failed (non-fatal): ${evalErr.message}`);
    }

    // ── Agent Feedback System: Finalize and generate reports ───────────────
    // P1: Flush feedback history and print summary
    if (this.feedbackSystem) {
      try {
        // Print feedback summary
        this.feedbackSystem.printFeedbackSummary();

        // Save feedback report
        this.feedbackSystem.saveFeedbackReport();

        // Flush and close
        this.feedbackSystem.flush();
      } catch (feedbackErr) {
        console.warn(`[Orchestrator] ⚠️  Feedback system finalization failed (non-fatal): ${feedbackErr.message}`);
      }
    }

    // ── P2 Feature #3: Prompt Auto-Optimizer – Feedback-driven prompt improvement ───
    try {
      const promptOptimizer = new PromptAutoOptimizer({
        outputDir: this._outputDir || PATHS.OUTPUT,
        autoApply: this._config?.promptAutoOptimization?.autoApply ?? false,
      });
      const optResult = promptOptimizer.analyzeAndOptimize();

      if (optResult.status === 'completed') {
        console.log(`[Orchestrator] 📝 Prompt Auto-Optimizer: ${optResult.suggestions?.length || 0} suggestion(s) generated`);
        if (optResult.applied?.length > 0) {
          console.log(`[Orchestrator]    → ${optResult.applied.length} optimization(s) auto-applied`);
        }

        // Generate human-readable report
        const reportContent = promptOptimizer.generateReport(
          path.join(this._outputDir || PATHS.OUTPUT, 'prompt-optimization-report.md')
        );
        if (reportContent) {
          console.log(`[Orchestrator]    → Report generated: prompt-optimization-report.md`);
        }
      } else if (optResult.status === 'skipped') {
        console.log(`[Orchestrator] ⏭️  Prompt Auto-Optimizer: ${optResult.reason}`);
      }
    } catch (optErr) {
      console.warn(`[Orchestrator] ⚠️  Prompt Auto-Optimizer failed (non-fatal): ${optErr.message}`);
    }

    // ── P1: Deep Audit Orchestrator – Unified cross-module health assessment ──
    // Fire-and-forget: runs as the last step of teardown to perform a comprehensive
    // cross-module consistency check across SelfReflection, EntropyGC, CodeGraph,
    // QualityGate, and ArchitectureReviewAgent. Findings auto-injected into
    // ExperienceStore for future evolution awareness.
    try {
      const { DeepAuditOrchestrator } = require('./deep-audit-orchestrator');
      const auditor = new DeepAuditOrchestrator({
        outputDir: this._outputDir || PATHS.OUTPUT,
        experienceStore: this.experienceStore || null,
        verbose: this._verbose,
      });

      // Run audit in non-blocking mode: errors are caught and logged, never crash teardown
      const auditReport = await auditor.run();
      if (auditReport && auditReport.stats) {
        const { critical = 0, high = 0, medium = 0, low = 0, info = 0 } = auditReport.stats;
        const totalFindings = critical + high + medium + low + info;
        if (totalFindings > 0) {
          console.log(`[Orchestrator] 🔎 DeepAudit: ${totalFindings} finding(s) (${critical} critical, ${high} high, ${medium} medium)`);
        } else {
          console.log(`[Orchestrator] ✅ DeepAudit: no cross-module issues found`);
        }
      }
    } catch (daErr) {
      console.warn(`[Orchestrator] ⚠️  Deep Audit Orchestrator failed (non-fatal): ${daErr.message}`);
    }

    // ── Lifecycle Plugin Registry: Teardown phase ─────────────────────────
    // Deactivate all plugins in reverse priority order.
    // This runs deactivate() handlers (e.g. RegressionGuard post-evolve check).
    if (this._pluginRegistry) {
      try {
        const { deactivated, failed } = await this._pluginRegistry.deactivateAll('teardown', this);
        if (deactivated.length > 0) {
          console.log(`[Orchestrator] 🔌 Plugin Registry: ${deactivated.length} plugin(s) deactivated${failed.length > 0 ? `, ${failed.length} failed` : ''}`);
        }

        // Print registry summary
        const summary = this._pluginRegistry.getSummary();
        if (summary.total > 0) {
          console.log(`[Orchestrator] 🔌 Plugin Registry Summary: ${summary.activated}/${summary.total} activated, ${summary.bridgeSubcommands.length} bridge command(s)`);
        }
      } catch (prErr) {
        console.warn(`[Orchestrator] ⚠️  Plugin Registry deactivation failed (non-fatal): ${prErr.message}`);
      }
    }
  },

  /**
   * Runs the Git PR workflow (commit + push + PR creation).
   * Called at the end of _finalizeWorkflow if git is enabled.
   *
   * @param {string} mode
   * @param {object} extra
   */
  async _runGitPRWorkflow(mode, extra) {
    // Implementation delegated to orchestrator-git.js mixin
    if (this._runGitPRWorkflowImpl) {
      return this._runGitPRWorkflowImpl(mode, extra);
    }
    console.log(`[Orchestrator] Git PR workflow enabled but no implementation found.`);
  },
};

// ─── P3: Cross-Stage Risk Correlation Analysis ──────────────────────────────

function _analyseRiskCorrelations(risks, stageCtx) {
  if (!risks || risks.length < 2) return [];

  const correlations = [];

  // Group risks by inferred stage
  const stageRisks = new Map();
  for (const risk of risks) {
    const stage = _inferStageFromRisk(risk.description);
    if (!stageRisks.has(stage)) stageRisks.set(stage, []);
    stageRisks.get(stage).push(risk);
  }

  // Pattern 1: Error Cascade
  const errorHandlingRisks = risks.filter(r =>
    /error.?handl|exception|unhandled|uncaught|no.?retry|no.?fallback/i.test(r.description)
  );
  const failureRisks = risks.filter(r =>
    /fail|crash|abort|timeout|broken/i.test(r.description) && r.severity === 'high'
  );
  if (errorHandlingRisks.length > 0 && failureRisks.length > 0) {
    const ehStage = _inferStageFromRisk(errorHandlingRisks[0].description);
    const fStage = _inferStageFromRisk(failureRisks[0].description);
    if (ehStage !== fStage) {
      correlations.push({
        severity: 'high',
        label: 'Error Cascade: missing error handling + downstream failure',
        factors: [
          { stage: ehStage, description: errorHandlingRisks[0].description },
          { stage: fStage, description: failureRisks[0].description },
        ],
        impact: 'A failure in one component propagates unchecked to downstream stages.',
        recommendation: 'Add error boundaries and fallback mechanisms at stage boundaries.',
      });
    }
  }

  // Pattern 2: Security Amplification
  const authRisks = risks.filter(r =>
    /auth|validat|sanitiz|inject|xss|csrf|permission|access.?control/i.test(r.description)
  );
  const dataRisks = risks.filter(r =>
    /sql|database|query|file.?access|direct.?access|input|user.?data/i.test(r.description)
  );
  if (authRisks.length > 0 && dataRisks.length > 0) {
    correlations.push({
      severity: 'high',
      label: 'Security Amplification: validation gap + data access exposure',
      factors: [
        { stage: _inferStageFromRisk(authRisks[0].description), description: authRisks[0].description },
        { stage: _inferStageFromRisk(dataRisks[0].description), description: dataRisks[0].description },
      ],
      impact: 'A validation bypass combined with direct data access creates a potential data breach.',
      recommendation: 'Implement defense-in-depth: validate at API boundary AND before data access.',
    });
  }

  // Pattern 3: Quality Erosion
  const rollbackRisks = risks.filter(r =>
    /rollback|unresolved.*after|failed.*after.*round|quality.?gate.*fail/i.test(r.description)
  );
  if (rollbackRisks.length >= 2) {
    const affectedStages = [...new Set(rollbackRisks.map(r => _inferStageFromRisk(r.description)))];
    if (affectedStages.length >= 2) {
      correlations.push({
        severity: 'high',
        label: `Quality Erosion: rollback failures across ${affectedStages.length} stages`,
        factors: rollbackRisks.slice(0, 3).map(r => ({
          stage: _inferStageFromRisk(r.description),
          description: r.description,
        })),
        impact: 'Multiple stages failing quality gates indicates a systemic issue.',
        recommendation: 'Consider re-analysing the original requirement with tighter scope.',
      });
    }
  }

  // Deduplicate: max 5 correlations
  const severityOrder = { high: 0, medium: 1, low: 2 };
  return correlations
    .sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9))
    .slice(0, 5);
}

function _inferStageFromRisk(description) {
  const d = description.toLowerCase();
  if (d.includes('[archreview]') || d.includes('architecture') || d.includes('coverage')) return 'ARCHITECT';
  if (d.includes('test') || d.includes('spec')) return 'TEST';
  if (d.includes('code') || d.includes('implement')) return 'CODE';
  if (d.includes('requirement') || d.includes('analyse')) return 'ANALYSE';
  if (d.includes('plan') || d.includes('execution')) return 'PLAN';
  return 'UNKNOWN';
}

function _extractKeywords(text) {
  return (text || '').toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
}

module.exports = { OrchestratorTeardownMixin, _analyseRiskCorrelations, _inferStageFromRisk, _extractKeywords };
