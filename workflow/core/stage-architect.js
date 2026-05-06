/**
 * Stage Runner: ARCHITECT
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runArchitect
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { CoverageChecker } = require('./coverage-checker');
const { CodeReviewAgent } = require('./code-review-agent');
const { ARCHITECTURE_CHECKLIST } = require('./review-checklists');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback, recordSelfReport, runStageMetricsGate } = require('./stage-runner-utils');
const { _recordPromptABOutcome } = require('./stage-analyst');
const { assessArchitectureGovernance } = require('./execution-validator-integration');
const {
  buildArchitectUpstreamCtx,
  buildArchitectContextBlock,
  storeArchitectContext,
  webSearchHelper,
  formatWebSearchBlock,
  securityCVEHelper,
} = require('./orchestrator-stage-helpers');
const { runModuleAwareArchitect } = require('./module-architect-runner');
const { buildRetryContext, compareOutputFingerprint } = require('./retry-divergence-guard');
const { buildAgentPrompt } = require('./prompt-builder');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');

// Forward reference: _runAnalyst is needed for rollback. Lazy-loaded to avoid circular deps.
let _runAnalyst = null;
function _getRunAnalyst() {
  if (!_runAnalyst) {
    _runAnalyst = require('./stage-analyst')._runAnalyst;
  }
  return _runAnalyst;
}

/**
 * Runs the ARCHITECT stage: architecture design, review, coverage check, and quality gate.
 *
 * P1-2 fix: @this annotation for IDE IntelliSense and safe refactoring.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {Promise<string>} Path to the generated architecture.md
 */
async function _runArchitect() {
  const _archStageStartTime = Date.now();
  // Print stage header via handoffLog if available
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('ARCHITECT', 'ArchitectAgent');
  } else {
    console.error(`\n[Orchestrator] Stage: ARCHITECT (ArchitectAgent)`);
  }  const inputPath = this.bus.consume(AgentRole.ARCHITECT);

  // ── Inject upstream cross-stage context ───────────────────────────────────
  const upstreamCtxForArch = buildArchitectUpstreamCtx(this);

  let techStackPrefix = '';
  try {
    const techDecision = this.socratic.askAsync(DECISION_QUESTIONS.TECH_STACK_PREFERENCE, 0);
    console.error(`[Orchestrator] ⚡ Tech stack preference (non-blocking): "${techDecision.optionText}"`);
    if (techDecision.optionIndex === 1) {
      techStackPrefix = '[Tech Stack: Minimal/Lightweight – prefer simple, low-dependency solutions]\n\n';
    } else if (techDecision.optionIndex === 2) {
      techStackPrefix = '[Tech Stack: Enterprise-grade – include full observability, logging, and monitoring]\n\n';
    }
  } catch (err) {
    this.stateMachine.recordRisk('low', `[SocraticEngine] Tech stack preference skipped (engine unavailable): ${err.message}`);
    console.warn(`[Orchestrator] ⚠️  SocraticEngine tech stack preference skipped – proceeding automatically. Reason: ${err.message}`);
  }

  // Enrich techStackPrefix with ProjectProfiler data (if available)
  try {
    const archConfig = this._config || {};
    const profile = archConfig.projectProfile;
    if (profile) {
      const enrichParts = [];
      if (profile.frameworks && profile.frameworks.length > 0) {
        enrichParts.push(`Frameworks: ${profile.frameworks.map(f => f.name).join(', ')}`);
      }
      if (profile.architecture && profile.architecture.pattern) {
        enrichParts.push(`Architecture: ${profile.architecture.pattern}`);
      }
      if (profile.dataLayer) {
        const dlParts = [];
        if (profile.dataLayer.orm && profile.dataLayer.orm.length > 0) dlParts.push(`ORM: ${profile.dataLayer.orm.join(', ')}`);
        if (profile.dataLayer.databases && profile.dataLayer.databases.length > 0) dlParts.push(`DB: ${profile.dataLayer.databases.join(', ')}`);
        if (dlParts.length > 0) enrichParts.push(`Data Layer: ${dlParts.join(', ')}`);
      }
      if (profile.communication && profile.communication.length > 0) {
        enrichParts.push(`Communication: ${profile.communication.join(', ')}`);
      }
      if (enrichParts.length > 0) {
        techStackPrefix += `[Project Profile: ${enrichParts.join(' | ')}]\n\n`;
        if (profile.lspEnhanced) {
          techStackPrefix += `[LSP-Enhanced: ${profile.lspServerName} – ${profile.lspStats?.symbolsCollected || 0} symbols analyzed]\n\n`;

          // Inject symbol inventory top 3 kinds
          if (profile.architecture && profile.architecture.symbolInventory) {
            const inv = profile.architecture.symbolInventory;
            const top3 = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, 3);
            if (top3.length > 0) {
              techStackPrefix += `[Symbol Inventory: ${top3.map(([k, v]) => `${k}=${v}`).join(', ')}]\n\n`;
            }
          }

          // Inject decorator patterns summary
          if (profile.architecture && profile.architecture.decoratorPatterns) {
            const decs = Object.entries(profile.architecture.decoratorPatterns);
            if (decs.length > 0) {
              techStackPrefix += `[Decorators: ${decs.map(([layer, ds]) => `${layer}(${ds.join(',')})`).join(' | ')}]\n\n`;
            }
          }
        }
        console.error(`[Orchestrator] 📋 ProjectProfile enrichment injected into ArchitectAgent.${profile.lspEnhanced ? ' (LSP-enhanced)' : ''}`);
      }
    }
  } catch (_) { /* non-fatal: projectProfile enrichment is optional */ }

  const analystMeta = this.bus.getMeta(AgentRole.ARCHITECT);
  if (analystMeta && !analystMeta.skipped && analystMeta.clarificationRounds > 0) {
    console.error(`[Orchestrator] ℹ️  Requirement was clarified in ${analystMeta.clarificationRounds} round(s) (${analystMeta.signalCount} signal(s) resolved). Architect should read requirements.md carefully.`);
  }

  // A-3 fix: buildArchitectContextBlock now returns { content, injectedExpIds } struct
  const archContextResult = await buildArchitectContextBlock(this, techStackPrefix, upstreamCtxForArch);
  const archExpContext = archContextResult.content;
  const archInjectedExpIds = archContextResult.injectedExpIds || [];
  this.obs.recordExpUsage({ injected: archInjectedExpIds.length });

  // ── P2-ModuleSplit: Attempt module-aware architecture design ───────────
  // If ANALYSE produced a moduleMap with ≥2 isolatable modules, split the
  // single ARCHITECT call into N focused calls (one per module, serial with
  // interface contract propagation). Falls back to standard single-pass if
  // the module map is absent or has too few modules.
  let outputPath;
  let _moduleSplitMeta = null;
  try {
    const requirementContent = fs.readFileSync(inputPath, 'utf-8');
    const moduleSplitResult = await runModuleAwareArchitect(
      this,
      requirementContent,
      archExpContext,
      { inputPath, outputPath: path.join(this._outputDir, 'architecture.md') },
    );
    if (moduleSplitResult.used) {
      outputPath = moduleSplitResult.outputPath;
      _moduleSplitMeta = moduleSplitResult.meta;
      console.error(`[Orchestrator] 🗺️  Module-split architecture completed: ${moduleSplitResult.moduleCount} module(s) designed.`);
    }
  } catch (msErr) {
    console.warn(`[Orchestrator] ⚠️  Module-split architecture failed (non-fatal): ${msErr.message}. Falling back to standard single-pass.`);
    _moduleSplitMeta = null;
  }

  // Standard single-pass fallback (or if module-split was not applicable)
  if (!outputPath) {
outputPath = await this.agents[AgentRole.ARCHITECT].run(inputPath, null, archExpContext, this.handoffLog);
  }

  // ── Adapter Telemetry ─────────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const archOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(archOutput, 'ARCHITECT');
      // ── Agent Self-Report: extract self-report from ARCHITECT output ──
      recordSelfReport('ARCHITECT', archOutput, { agentRole: AgentRole.ARCHITECT });
    } catch (_) { /* non-fatal */ }
  }
  // ── Optimization 5: Tech Stack Selection Validation ─────────────────────
  // Collect extra context for architecture review (before instantiating reviewer)
  let extraContext = '';
  try {
    if (fs.existsSync(outputPath)) {
      const archDoc = fs.readFileSync(outputPath, 'utf-8');
      const techPattern = /\b(?:React|Vue|Angular|Next\.js|Nuxt|Svelte|Express|Fastify|Koa|NestJS|Django|Flask|FastAPI|Spring\s?Boot|Laravel|Rails|Prisma|TypeORM|Sequelize|Mongoose|TailwindCSS|Bootstrap|Material[- ]UI|Chakra[- ]UI|Redis|MongoDB|PostgreSQL|MySQL|SQLite|GraphQL|gRPC|Socket\.io|WebSocket|Stripe|Auth0|Firebase|Supabase|Docker|Kubernetes|Terraform|AWS\s?SDK|Vite|Webpack|esbuild|Jest|Vitest|Playwright|Cypress|Gin|Echo|Fiber|GORM|Actix|Tokio|Axum|Rocket|XLua|toLua|Cocos2d|Defold|Love2D|Unity|Unreal|Godot|Flutter|Dart|Riverpod|SwiftUI|Combine|Electron|Tauri|RabbitMQ|Kafka|NATS|Celery|Nginx|Caddy|Traefik)\b/gi;
      const techMentions = [...new Set((archDoc.match(techPattern) || []).map(t => t.trim()))].slice(0, 6);
      if (techMentions.length > 0) {
        const validationQuery = `${techMentions.join(' ')} latest version known issues deprecation 2024 2025`.slice(0, 200);
        console.error(`[Orchestrator] 🌐 Tech stack validation: searching for: "${validationQuery.slice(0, 80)}..."`);
        const validationResult = await webSearchHelper(this, validationQuery, {
          maxResults: 4,
          label: 'Tech Stack Validation (ArchReview)',
        });
        if (validationResult) {
          extraContext = formatWebSearchBlock(validationResult, {
            title: 'Tech Stack Validation (Live Web Data)',
            guidance: 'These web search results provide the latest status of technologies used in this architecture. **Check for version mismatches, deprecated APIs, known security issues, or end-of-life announcements**. Flag any technology choice that conflicts with this real-time data.',
          });
        }
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] 🌐 Tech stack validation web search failed (non-fatal): ${err.message}`);
  }

  // ── Security CVE Audit ────────────────────────────────────────────────────
  try {
    const cveResult = await securityCVEHelper(this, null, {
      maxPackages: 10,
      label: 'Security Audit (ArchReview)',
    });
    if (cveResult && cveResult.totalVulns > 0) {
      extraContext = extraContext
        ? `${extraContext}\n\n${cveResult.block}`
        : cveResult.block;
      if (cveResult.criticalCount > 0) {
        this.stateMachine.recordRisk('high',
          `[SecurityCVE] ${cveResult.criticalCount} CRITICAL vulnerability(ies) found in project dependencies. Immediate remediation required.`,
          false
        );
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] 🛡️ Security CVE audit failed (non-fatal): ${err.message}`);
  }

  const coverageChecker = new CoverageChecker(this._rawLlmCall, { verbose: true, outputDir: this._outputDir });
  const reviewRiskProfile = (() => {
    const corpus = `${extraContext || ''}\n${outputPath && fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : ''}`.toLowerCase();
    const score = (regex) => (regex.test(corpus) ? 0.75 : 0);
    return {
      security: score(/\b(auth|xss|csrf|inject|sql|secret|token|credential|vulnerab|cve)\b/i),
      performance: score(/\b(perf|latency|throughput|n\+1|memory|blocking|cache|optimi)\b/i),
      interface: score(/\b(interface|contract|schema|export|signature|breaking|compatib)\b/i),
    };
  })();
  const reviewLlmCall = async (prompt) => {
    let optimisedPrompt = prompt;
    try {
      const result = await buildAgentPrompt('reviewer', prompt, [], {
        projectRoot: this.projectRoot,
        riskProfile: reviewRiskProfile,
        stage: 'ARCHITECT',  // T-U2: dynamic budget signal for reviewer sub-call
      });
      if (result && result.prompt) {
        optimisedPrompt = result.prompt;
      }
      const injectedSkillNames = result?.meta?.injectedSkillNames || [];
      if (injectedSkillNames.length > 0) {
        this.obs.recordSkillUsage(injectedSkillNames);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Reviewer prompt optimisation failed (non-fatal): ${err.message}`);
    }
    return this._rawLlmCall(prepareGatewayPrompt(this, {
      callSite: 'workflow/core/stage-architect.js:reviewLlmCall',
      role: 'architecture-reviewer',
      stage: 'ARCHITECT',
      runtimePrompt: optimisedPrompt,
      candidatePrompt: optimisedPrompt,
      metadata: { category: 'raw-orchestrator-call' },
    }));
  };
  const archReviewer = new CodeReviewAgent(
    reviewLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: this._outputDir,
      investigationTools: this._buildInvestigationTools('Architecture'),
      checklist: ARCHITECTURE_CHECKLIST,
      reportFileName: 'architecture-review.md',
      extraContext,
    }
  );

  // FIX: requirementPath should point to the requirement document (inputPath from ANALYSE)
  const requirementPath = inputPath;

  const [coverageSettled, archReviewSettled] = await this.stateMachine.runParallel([
    { name: 'CoverageCheck', fn: () => coverageChecker.check(requirementPath, outputPath) },
    { name: 'ArchReview',    fn: () => archReviewer.review(outputPath, requirementPath) },
  ]);

  if (coverageSettled.status === 'rejected') {
    throw new Error(`[_runArchitect] CoverageChecker failed: ${coverageSettled.reason?.message ?? coverageSettled.reason}`);
  }
  if (archReviewSettled.status === 'rejected') {
throw new Error(`[_runArchitect] CodeReviewAgent (architecture mode) failed: ${archReviewSettled.reason?.message ?? archReviewSettled.reason}`);
  }
  const coverageResult   = coverageSettled.value;
  const archReviewResult = archReviewSettled.value;

  const subtaskCoordinator = new RollbackCoordinator(this);
  subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'CoverageCheck', coverageResult);
  subtaskCoordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', archReviewResult);

  if (!coverageResult.skipped) {
    const coverageReport = coverageChecker.formatReport(coverageResult);
    fs.appendFileSync(outputPath, `\n\n---\n${coverageReport}`, 'utf-8');
    const evaluatedItems = coverageResult.covered + coverageResult.uncovered;
    console.error(`[Orchestrator] 📊 Coverage: ${coverageResult.covered}/${evaluatedItems} evaluated (${coverageResult.coverageRate}%) | total parsed: ${coverageResult.total}`);
  }

  for (const note of coverageResult.riskNotes) {
    this.stateMachine.recordRisk('high', note, false);
    console.warn(`[Orchestrator] ⚠️  ${note}`);
  }

  for (const note of archReviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  if (archReviewResult.failed === 0 || !archReviewResult.needsHumanReview) {
    // P1-6 fix: Corrected indentation — the try/catch block and its inner
    // if/else branches were misaligned (2-space vs 6-space), making the code
    // structure appear incorrect to readers and automated formatters.
    try {
      const socraticDecision = this.socratic.askAsync(DECISION_QUESTIONS.ARCHITECTURE_APPROVAL, 0);
      if (socraticDecision.optionIndex === 1) {
        const abortMsg = '[SocraticEngine] User rejected architecture. Workflow aborted by user decision.';
        this.stateMachine.recordRisk('high', abortMsg);
        throw new Error(abortMsg);
      } else if (socraticDecision.optionIndex === 2) {
        this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved architecture with reservations. Proceeding to code generation.');
        console.error(`[Orchestrator] ⚠️  Architecture approved with reservations. Proceeding.`);
      } else {
        console.error(`[Orchestrator] ✅ Architecture approved by user. Proceeding to code generation.`);
      }
    } catch (err) {
      if (err.message.includes('User rejected architecture')) throw err;
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture approval skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture approval skipped – proceeding automatically. Reason: ${err.message}`);
    }
  } else {
    const failedSummary = archReviewResult.riskNotes.slice(0, 2).join('; ');
    console.warn(`[Orchestrator] ⚠️  Architecture review FAILED: ${archReviewResult.failed} high-severity issue(s). Notifying user...`);
    try {
      const failureDecision = this.socratic.askAsync(
        DECISION_QUESTIONS.ARCHITECTURE_FAILURE_ACTION || DECISION_QUESTIONS.ARCHITECTURE_APPROVAL,
        0
      );
      console.error(`[Orchestrator] ⚡ Architecture failure action (non-blocking): "${failureDecision.optionText}"`);
      if (failureDecision.optionIndex === 1) {
        const proceedMsg = `[SocraticEngine] User chose to proceed despite architecture failure (${archReviewResult.failed} issue(s)): ${failedSummary}`;
        this.stateMachine.recordRisk('high', proceedMsg);
        console.warn(`[Orchestrator] ⚠️  User accepted architecture failure. Proceeding to CODE with high-severity risks recorded.`);
        archReviewResult.needsHumanReview = false;
      }
    } catch (err) {
      this.stateMachine.recordRisk('low', `[SocraticEngine] Architecture failure notification skipped (engine unavailable): ${err.message}`);
      console.warn(`[Orchestrator] ⚠️  SocraticEngine architecture failure notification skipped – proceeding with rollback. Reason: ${err.message}`);
    }
  }

  if (archReviewResult.failed === 0) {
    console.error(`[Orchestrator] ✅ Architecture review passed.`);
  }

  // ── Quality gate decision ───────────────────────────────────────────────
  const archGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
  const archCtxMeta = this.stageCtx?.get(WorkflowState.ARCHITECT)?.meta || {};
  const rollbackCount = archCtxMeta._archRollbackCount || 0;
  // Plan-A: Use LoopGuard for centralized retry limit management
  const loopGuard = this._loopGuard;
  const loopGuardCanRetry = loopGuard ? loopGuard.canRetry('ARCHITECT', 'ANALYSE') : true;
  const archDecision = archGate.evaluate(archReviewResult, WorkflowState.ARCHITECT, rollbackCount);
  archGate.recordExperience(archDecision, WorkflowState.ARCHITECT, archReviewResult, {
    skill: 'architecture-design',
    category: ExperienceCategory.ARCHITECTURE,
  });

  if (this.obs && this.obs._skillInjectedCounts && this.obs._skillInjectedCounts.size > 0) {
    const injectedNames = [...this.obs._skillInjectedCounts.keys()];
    const falsePositiveSignals = Math.max(0, Number(archReviewResult?.failed || 0) - Number(archReviewResult?.rounds || 0));
    this.obs.recordSkillGateOutcome(injectedNames, {
      passed: !!archDecision.pass,
      falsePositiveSignals,
    });
  }

  _recordPromptABOutcome('architect', archDecision.pass, archReviewResult.rounds ?? 0);

  if (!archDecision.pass && archDecision.rollback) {
    // Plan-A: Check LoopGuard before allowing rollback
    if (loopGuard && !loopGuardCanRetry) {
      console.warn(`[Orchestrator] ⚠️  LoopGuard: ARCHITECT→ANALYSE retry blocked (max retries reached: ${loopGuard.getRetryCount('ARCHITECT', 'ANALYSE')}/${loopGuard.getMaxRetries('ARCHITECT', 'ANALYSE')}). Proceeding with risks recorded.`);
      this.stateMachine.recordRisk('medium', `[LoopGuard] ARCHITECT→ANALYSE rollback blocked after ${loopGuard.getRetryCount('ARCHITECT', 'ANALYSE')} retries. Unresolved issues: ${archReviewResult.riskNotes?.slice(0, 3).join('; ').slice(0, 200)}`);
    } else {
    const failedNotes = archReviewResult.riskNotes.slice(0, 3).join('; ');
    console.warn(`[Orchestrator] ⚠️  ${archDecision.reason}`);
    // Plan-A: Record retry in LoopGuard
    if (loopGuard) loopGuard.recordRetry('ARCHITECT', 'ANALYSE');

    if (this.stageCtx) {
      const existing = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
      this.stageCtx.set(WorkflowState.ARCHITECT, {
        ...existing,
        meta: { ...(existing.meta || {}), _archRollbackCount: rollbackCount + 1 },
      });
    }
    try {
      const coordinator = new RollbackCoordinator(this);
      const strategy = coordinator.analyseRollbackStrategy(
        WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes}`, 'ArchReview'
      );

      if (strategy.type === 'SUBTASK_RETRY' && strategy.cachedResults) {
        console.error(`[Orchestrator] 🎯 Defect C: Subtask-level retry for ARCHITECT. ${strategy.reason}`);

        const retryReviewer = new CodeReviewAgent(
          reviewLlmCall,
          {
            maxRounds: 2,
            verbose: true,
            outputDir: this._outputDir,
            investigationTools: this._buildInvestigationTools('Architecture'),
            checklist: ARCHITECTURE_CHECKLIST,
            reportFileName: 'architecture-review.md',
          }
        );
        const requirementPathRetry = path.join(this._outputDir, 'requirements.md');

        const retryNote = `\n\n---\n## ⚠️ Architecture Review Retry (Attempt ${rollbackCount + 1})\n\nPrevious review found these issues:\n${failedNotes}\n\nPlease address these concerns in a focused re-review.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReviewResult = await retryReviewer.review(outputPath, requirementPathRetry);

        const cachedCoverage = strategy.cachedResults.get('CoverageCheck');
        const retryGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryDecision = retryGate.evaluate(retryReviewResult, WorkflowState.ARCHITECT, rollbackCount + 1);

        if (retryDecision.pass) {
          console.error(`[Orchestrator] ✅ Subtask-level retry succeeded: ArchReview passed on retry.`);
          coordinator.cacheSubtaskResult(WorkflowState.ARCHITECT, 'ArchReview', retryReviewResult);

          if (this.stageCtx) {
            const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
            this.stageCtx.set(WorkflowState.ARCHITECT, {
              ...existingArch,
              summary: `Architecture review passed on subtask retry (attempt ${rollbackCount + 1}). Original issues: ${failedNotes.slice(0, 150)}`,
              keyDecisions: [`ArchReview subtask retry succeeded after ${retryReviewResult.rounds ?? 0} round(s)`],
              artifacts: [outputPath],
              risks: retryReviewResult.riskNotes ?? [],
              meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, subtaskRetry: true },
            });
          }
          const archOutputCtx = await storeArchitectContext(this, outputPath, retryReviewResult, cachedCoverage || coverageResult);
  this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, outputPath, {
            reviewRounds:   retryReviewResult.rounds ?? 0,
            failedItems:    retryReviewResult.failed ?? 0,
            riskNotes:      retryReviewResult.riskNotes ?? [],
            contextSummary: archOutputCtx.summary,
          });
          return outputPath;
        }

        console.error(`[Orchestrator] ⚠️  Subtask-level retry failed. Falling through to full-stage rollback.`);
        coordinator.invalidateSubtaskCache(WorkflowState.ARCHITECT);
      }

      // ── Full-stage rollback ──────────────────────────────────────────────
      await coordinator.rollback(WorkflowState.ARCHITECT, `Architecture review failed: ${failedNotes.slice(0, 200)}`);
      
      // Record rollback in handoff log
      if (this.handoffLog) {
        this.handoffLog.recordRollback('ARCHITECT', 'ANALYSE', `Architecture review failed: ${failedNotes.slice(0, 200)}`);
      }

      // ── RetryDivergenceGuard: build enhanced retry context ──────────────
      // Strategy 1 (Negative Prompt) + Strategy 2 (Creativity Directive)
      // extracts key decisions from previous output and injects "DO NOT REPEAT"
      // constraints + escalating creativity instructions.
      let previousArchOutput = '';
      try {
        const archPath = path.join(this._outputDir, 'architecture.md');
        if (fs.existsSync(archPath)) previousArchOutput = fs.readFileSync(archPath, 'utf-8');
      } catch (_) { /* non-fatal */ }

      const failureContext = await buildRetryContext({
        previousOutput: previousArchOutput,
        failureReason: failedNotes,
        retryCount: rollbackCount + 1,
        stageName: 'ARCHITECTURE',
      });
      const reanalysedPath = await _getRunAnalyst().call(this, failureContext);
      await this.stateMachine.transition(reanalysedPath, `ANALYSE → ARCHITECT (post-rollback retry ${rollbackCount + 1})`);
      console.error(`[Orchestrator] ✅ State machine advanced to ARCHITECT after post-rollback re-analysis.`);
      if (this.stageCtx) {
        const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
        this.stageCtx.set(WorkflowState.ARCHITECT, {
          ...existingArch,
          summary: `Architecture review failed (retry ${rollbackCount + 1}): ${failedNotes.slice(0, 200)}. Re-analysis triggered.`,
          keyDecisions: [`Rollback to ANALYSE triggered after ${archReviewResult.failed} high-severity issue(s)`],
          artifacts: [outputPath],
          risks: archReviewResult.riskNotes ?? [],
          meta: { ...(existingArch.meta || {}), _archRollbackCount: rollbackCount + 1, rollbackTriggered: true },
        });
      }
      // P1-3: Use unified StageResult type instead of ad-hoc { __alreadyTransitioned }
      const { StageResult } = require('./types');
      return StageResult.rolledBack(reanalysedPath);
    } catch (rollbackErr) {
      console.warn(`[Orchestrator] Rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
    }
    } // end Plan-A LoopGuard else block
  } else if (!archDecision.pass && archDecision.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  Rollback limit reached. Proceeding to CODE stage with ${archReviewResult.failed} unresolved issue(s).`);
  } else if (archDecision.pass && archReviewResult.failed > 0) {
    const lowSeverityNotes = archReviewResult.riskNotes
      .filter(n => !n.includes('(high)'))
      .slice(0, 3)
      .join('; ');
    this.stateMachine.recordRisk('low', `[ArchReview] ${archReviewResult.failed} low-severity issue(s) remain (no rollback): ${lowSeverityNotes}`);
    console.error(`[Orchestrator] ℹ️  ${archReviewResult.failed} minor architecture issue(s) remain (recorded as low-risk). Proceeding automatically.`);
  } else {
    console.error(`[Orchestrator] ℹ️  Architecture review: no issues. Proceeding automatically.`);
  }

  // ── EvoMap feedback loop ────────────────────────────────────────────────
  if (archDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: archInjectedExpIds,
      errorContext: (archReviewResult.riskNotes || []).join(' '),
      stageLabel: 'ARCHITECT',
    });
  }

  // ── Store ARCHITECT stage context ──────────────────────────────────────
  const archOutputCtx = await storeArchitectContext(this, outputPath, archReviewResult, coverageResult, { moduleSplitMeta: _moduleSplitMeta });

  this.bus.publish(AgentRole.ARCHITECT, AgentRole.PLANNER, outputPath, {
    reviewRounds:   archReviewResult.rounds ?? 0,
    failedItems:    archReviewResult.failed ?? 0,
    riskNotes:      archReviewResult.riskNotes ?? [],
    contextSummary: archOutputCtx.summary,
    moduleSplit:    !!_moduleSplitMeta,
    moduleCount:    _moduleSplitMeta?.moduleCount ?? 0,
  });

  let architectureGovernance = null;
  try {
    architectureGovernance = assessArchitectureGovernance({
      projectRoot: this._projectRoot || path.resolve(__dirname, '..', '..'),
      architecturePath: outputPath,
      reviewResult: archReviewResult,
      artifactContent: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '',
    });
  } catch (govErr) {
    console.warn(`[Orchestrator] ⚠️ Architecture governance assessment failed (non-fatal): ${govErr.message}`);
  }

  if (architectureGovernance && this.stageCtx) {
    const existingArch = this.stageCtx.get(WorkflowState.ARCHITECT) || {};
    this.stageCtx.set(WorkflowState.ARCHITECT, {
      ...existingArch,
      governance: architectureGovernance,
    });
  }

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  // ── RetryDivergenceGuard: Strategy 3 – Output Fingerprint comparison ──
  // When this is a retry (rollbackCount > 0), compare the new output with
  // the previous output to detect if the LLM produced near-identical content.
  // Uses EmbeddingService cosine similarity (zero LLM cost, ~50ms).
  const archRollbackCount = (this.stageCtx?.get(WorkflowState.ARCHITECT)?.meta?._archRollbackCount) || 0;
  if (archRollbackCount > 0 && this._embeddingService) {
    try {
      const currentOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      const prevSummary = this.stageCtx?.get(WorkflowState.ARCHITECT)?.meta?._previousOutputDigest || '';
      if (prevSummary && currentOutput) {
        const fpResult = await compareOutputFingerprint({
          embeddingService: this._embeddingService,
          previousOutput: prevSummary,
          currentOutput: currentOutput.slice(0, 500),
        });
        if (fpResult.isDuplicate) {
          this.stateMachine.recordRisk('medium', `[RetryDivergenceGuard] ${fpResult.message}`);
        } else if (fpResult.isWarning) {
          this.stateMachine.recordRisk('low', `[RetryDivergenceGuard] ${fpResult.message}`);
        }
      }
    } catch (_) { /* non-fatal: fingerprint comparison is supplementary */ }
  }
  // Store current output digest for next retry comparison
  if (this.stageCtx) {
    const existingMeta = this.stageCtx.get(WorkflowState.ARCHITECT)?.meta || {};
    const currentDigest = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8').slice(0, 500) : '';
    this.stageCtx.set(WorkflowState.ARCHITECT, {
      ...this.stageCtx.get(WorkflowState.ARCHITECT),
      meta: { ...existingMeta, _previousOutputDigest: currentDigest },
    });
  }

  // ── Metrics Quality Gate: validate ARCHITECT stage runtime metrics ──────
  runStageMetricsGate(this, {
    stageName: 'ARCHITECT',
    durationMs: Date.now() - _archStageStartTime,
    errorCount: (archReviewResult?.failed || 0),
    llmCalls: (this.obs && this.obs._llmCallCount) ? this.obs._llmCallCount : 0,
  });

  return outputPath;
}

module.exports = { _runArchitect };
