/**
 * Stage Runner: PLAN
 *
 * Implements the PLAN pipeline stage – an independent execution planning stage
 * inserted between ARCHITECT and CODE.
 *
 * Responsibilities:
 *   - Read architecture.md from upstream (ARCHITECT stage output)
 *   - Inject upstream cross-stage context + experience context
 *   - Execute PlannerAgent to generate execution-plan.md
 *   - SocraticEngine user approval checkpoint
 *   - Store PLAN stage context for downstream consumption
 *   - Bus publish (PLAN → DEVELOPER)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { DECISION_QUESTIONS } = require('./socratic-engine');
const { translateMdFile } = require('./i18n-translator');
const {
  storePlannerContext,
} = require('./orchestrator-stage-helpers');
const { runEvoMapFeedback, recordSelfReport, runStageMetricsGate } = require('./stage-runner-utils');

/**
 * Builds upstream context for the Planner from previous stages.
 *
 * @param {Orchestrator} orch
 * @returns {string} Context block string
 */
function buildPlannerUpstreamCtx(orch) {
  const parts = [];

    // Inject ANALYSE stage context
  if (orch.stageCtx) {
    const analyseCtx = orch.stageCtx.get(WorkflowState.ANALYSE);
    if (analyseCtx) {
      parts.push(`## Upstream: ANALYSE Stage Summary`);
      parts.push(`Summary: ${analyseCtx.summary || 'N/A'}`);
      if (analyseCtx.keyDecisions && analyseCtx.keyDecisions.length > 0) {
        parts.push(`Key Decisions:\n${analyseCtx.keyDecisions.map(d => `- ${d}`).join('\n')}`);
      }
      if (analyseCtx.risks && analyseCtx.risks.length > 0) {
        parts.push(`Risks:\n${analyseCtx.risks.slice(0, 5).map(r => `- ${r}`).join('\n')}`);
      }

      // P1-ModuleMap: Inject Module Map for task decomposition alignment
      const moduleMap = analyseCtx.meta?.moduleMap;
      if (moduleMap && Array.isArray(moduleMap.modules) && moduleMap.modules.length > 0) {
        parts.push(`\n**Functional Module Map** (${moduleMap.modules.length} module(s)):`);
        for (const m of moduleMap.modules) {
          const deps = (m.dependencies || []).join(', ') || 'none';
          parts.push(`- **${m.id}** (${m.name}): ${m.description} [complexity: ${m.complexity}, isolatable: ${m.isolatable ? 'yes' : 'no'}, deps: ${deps}]`);
        }
        if (moduleMap.crossCuttingConcerns && moduleMap.crossCuttingConcerns.length > 0) {
          parts.push(`- Cross-cutting concerns: ${moduleMap.crossCuttingConcerns.join(', ')}`);
        }
        parts.push(`> **Planning hint:** Align task grouping with module boundaries. Isolatable modules can be planned as parallel work streams.`);
      }
    }

    // Inject ARCHITECT stage context
    const archCtx = orch.stageCtx.get(WorkflowState.ARCHITECT);
    if (archCtx) {
      parts.push(`\n## Upstream: ARCHITECT Stage Summary`);
      parts.push(`Summary: ${archCtx.summary || 'N/A'}`);
      if (archCtx.keyDecisions && archCtx.keyDecisions.length > 0) {
        parts.push(`Key Decisions:\n${archCtx.keyDecisions.map(d => `- ${d}`).join('\n')}`);
      }
      if (archCtx.risks && archCtx.risks.length > 0) {
        parts.push(`Risks:\n${archCtx.risks.slice(0, 5).map(r => `- ${r}`).join('\n')}`);
      }
      if (archCtx.correctionHistory && archCtx.correctionHistory.length > 0) {
        parts.push(`Correction History: ${archCtx.correctionHistory.length} round(s) of self-correction`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Builds the full experience + upstream context block for the Planner.
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @returns {Promise<string>} Context block with experience and upstream info
 */
async function buildPlannerContextBlock(orch, upstreamCtx) {
  let expContext = '';
  const _injectedExpIds = [];

  // Inject relevant experiences from ExperienceStore
  // P1 fix: Use getContextBlockWithIds() for keyword-scored + LLM-expanded retrieval,
  // consistent with architect/developer/tester context builders.
  if (orch.experienceStore && typeof orch.experienceStore.getContextBlockWithIds === 'function') {
    try {
      const maxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
      const { block: expBlock, ids: expIds } = await orch.experienceStore.getContextBlockWithIds(
        'execution-planning',
        orch._currentRequirement || '',
        maxExpInjected,
      );
      if (expBlock && expBlock.trim().length > 0) {
        expContext += expBlock;
      }
      if (expIds && expIds.length > 0) {
        _injectedExpIds.push(...expIds);
      }
    } catch (_) { /* non-fatal */ }
  }

  // Inject upstream context
  if (upstreamCtx) {
    expContext += `\n${upstreamCtx}`;
  }

  // Inject complaint context
  // Fix: ComplaintWall has no .query() method. Use getOpenComplaints() and filter by targetType.
  if (orch.complaintWall && typeof orch.complaintWall.getOpenComplaints === 'function') {
    try {
      const allOpen = orch.complaintWall.getOpenComplaints();
      const planComplaints = allOpen.filter(c => c.targetType === 'workflow');
      if (planComplaints.length > 0) {
        expContext += `\n## ⚠️ Open Complaints (from ComplaintWall)\n`;
        for (const c of planComplaints.slice(0, 3)) {
          expContext += `- [${c.severity}] ${c.description.slice(0, 150)}\n`;
        }
      }
    } catch (_) { /* non-fatal */ }
  }

  // L3: Inject structured session memory (cross-session continuity, low token cost)
  try {
    const { TaskHistory } = require('./task-history');
    const taskHistory = new TaskHistory();
    const sessionMemoryBlock = taskHistory.getSessionMemoryBlock(3);
    if (sessionMemoryBlock) {
      expContext += `\n${sessionMemoryBlock}`;
      console.error(`[Orchestrator] 🧠 Session Memory injected for PlannerAgent (${sessionMemoryBlock.length} chars)`);
    }
  } catch (memErr) {
    if (process.env.DEBUG) {
      console.warn(`[Orchestrator] Session memory injection failed for PLAN (non-fatal): ${memErr.message}`);
    }
  }

  // A-3 Architecture Fix: Return proper struct instead of setting expando on string.
  // Previously `result._injectedExpIds = _injectedExpIds` was set on a primitive string,
  // which silently fails (primitive strings cannot hold expando properties).
  return { content: expContext || '', injectedExpIds: _injectedExpIds };
}

/**
 * Runs the PLAN stage: execution planning, task decomposition, and dependency ordering.
 *
 * P1-2 fix: @this annotation for IDE IntelliSense and safe refactoring.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {Promise<string>} Path to the generated execution-plan.md
 */
async function _runPlanner() {
  const planStageStartTime = Date.now();
  
  // Print stage header via handoffLog if available
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('PLAN', 'PlannerAgent');
  } else {
console.error(`\n[Orchestrator] Stage: PLAN (PlannerAgent — Frederick Brooks Project Management)`);
  }
  const inputPath = this.bus.consume(AgentRole.PLANNER);
  console.error(`[Orchestrator] 📥 PLAN upstream input: ${inputPath ? path.basename(inputPath) : '(none)'}`);

  // ── Build upstream context ──────────────────────────────────────────────
  const upstreamCtx = buildPlannerUpstreamCtx(this);
  if (upstreamCtx) {
    const ctxLines = upstreamCtx.split('\n').filter(l => l.trim()).length;
    console.error(`[Orchestrator] 🔗 PLAN upstream context: ${ctxLines} line(s) from ANALYSE + ARCHITECT stages`);
  } else {
    console.error(`[Orchestrator] ⚠️  PLAN upstream context: empty (no prior stage context available)`);
  }

  // ── Build experience + context block ────────────────────────────────────
  // A-3 fix: buildPlannerContextBlock now returns { content, injectedExpIds } struct
  const planContextResult = await buildPlannerContextBlock(this, upstreamCtx);
  const planExpContent = planContextResult.content;
  const planInjectedExpIds = planContextResult.injectedExpIds || [];
  if (planExpContent) {
    const injectedExpCount = planInjectedExpIds.length;
    this.obs.recordExpUsage({ injected: injectedExpCount });
    console.error(`[Orchestrator] 📚 PLAN experience injection: ${injectedExpCount} experience(s) from ExperienceStore`);
    if (injectedExpCount > 0) {
      console.error(`[Orchestrator]    Experience IDs: [${planInjectedExpIds.slice(0, 5).join(', ')}${injectedExpCount > 5 ? '...' : ''}]`);
    }
  } else {
    console.error(`[Orchestrator] 📚 PLAN experience injection: none (ExperienceStore empty or no matches)`);
  }

  // ── Execute PlannerAgent ───────────────────────────────────────────────
  console.error(`[Orchestrator] 🚀 Executing PlannerAgent (generating execution-plan.md)...`);
  const plannerStartTime = Date.now();
const outputPath = await this.agents[AgentRole.PLANNER].run(inputPath, null, planExpContent, this.handoffLog);
  const plannerDuration = ((Date.now() - plannerStartTime) / 1000).toFixed(1);
  console.error(`[Orchestrator] ✅ PlannerAgent completed in ${plannerDuration}s → ${outputPath ? path.basename(outputPath) : '(no output)'}`);

  // ── Agent Self-Report: extract self-report from PLANNER output ──
  if (outputPath && fs.existsSync(outputPath)) {
    try {
      const planOutput = fs.readFileSync(outputPath, 'utf-8');
      recordSelfReport('PLAN', planOutput, { agentRole: AgentRole.PLANNER });
    } catch (_) { /* non-fatal */ }
  }

  // ── SocraticEngine: User approval of execution plan ────────────────────
  try {
    // Define the plan approval question inline (no need to add to socratic-engine.js constants
    // since it's only used here; can be extracted later if needed)
    const planApprovalQuestion = {
      id: 'PLAN_APPROVAL',
      question: '执行计划已生成。请审查计划后做出决定：',
      options: [
        { label: '✅ 批准执行计划，继续到 CODE 阶段', value: 'approve' },
        { label: '❌ 拒绝执行计划，终止工作流', value: 'reject' },
        { label: '⚠️ 有保留地批准，继续但记录风险', value: 'approve_with_reservations' },
      ],
      defaultIndex: 0,
    };

    const planDecision = this.socratic.askAsync(planApprovalQuestion, 0);
    if (planDecision.optionIndex === 1) {
      const abortMsg = '[SocraticEngine] User rejected execution plan. Workflow aborted by user decision.';
      this.stateMachine.recordRisk('high', abortMsg);
      throw new Error(abortMsg);
    } else if (planDecision.optionIndex === 2) {
      this.stateMachine.recordRisk('medium', '[SocraticEngine] User approved execution plan with reservations. Proceeding to CODE stage.');
      console.error(`[Orchestrator] ⚠️  Execution plan approved with reservations. Proceeding.`);
    } else {
      console.error(`[Orchestrator] ✅ Execution plan approved by user. Proceeding to CODE stage.`);
    }
  } catch (err) {
    if (err.message.includes('User rejected execution plan')) throw err;
    this.stateMachine.recordRisk('low', `[SocraticEngine] Plan approval skipped (engine unavailable): ${err.message}`);
    console.warn(`[Orchestrator] ⚠️  SocraticEngine plan approval skipped – proceeding automatically. Reason: ${err.message}`);
  }

  // ── EvoMap feedback loop (P1 fix: PLAN stage was missing this) ─────────
  // When the execution plan is approved, we close the learning loop by:
  // 1. Computing which injected experiences matched the plan content
  // 2. Marking matched experiences as effective (incrementing hitCount)
  // 3. Triggering skill evolution for high-usage experiences
  // This enables the PLAN stage to learn from successful execution plans.
  try {
    // Read plan content for experience matching
    let planContent = '';
    if (outputPath && fs.existsSync(outputPath)) {
      planContent = fs.readFileSync(outputPath, 'utf-8');
    }
    await runEvoMapFeedback(this, {
      injectedExpIds: planInjectedExpIds,
      errorContext: planContent, // Use plan content as context for matching
      stageLabel: 'PLAN',
    });
  } catch (evoErr) {
    console.warn(`[Orchestrator] ⚠️  EvoMap feedback failed for PLAN stage (non-fatal): ${evoErr.message}`);
  }

  // ── Metrics Quality Gate: validate PLAN stage runtime metrics ──────────
  // Non-blocking: records threshold violations as risks, does not abort pipeline.
  runStageMetricsGate(this, {
    stageName: 'PLAN',
    durationMs: Date.now() - planStageStartTime,
    errorCount: 0,
    llmCalls: (this.obs && this.obs._llmCallCount) ? this.obs._llmCallCount : 0,
  });

  // ── Store PLAN stage context ──────────────────────────────────────────
  const planOutputCtx = await storePlannerContext(this, outputPath);

  // ── Log plan artifact stats ───────────────────────────────────────────
  if (planOutputCtx.taskCount > 0) {
    console.error(`[Orchestrator] 📋 Execution plan breakdown: ${planOutputCtx.taskCount} task(s), ${planOutputCtx.keyDecisions.length} key decision(s)`);
  }
  if (planOutputCtx.summary) {
    console.error(`[Orchestrator] 📝 Plan summary: ${planOutputCtx.summary.slice(0, 150)}${planOutputCtx.summary.length > 150 ? '...' : ''}`);
  }

  // ── Read plan content for detailed logging ─────────────────────────────
  try {
    if (outputPath && fs.existsSync(outputPath)) {
      const planContent = fs.readFileSync(outputPath, 'utf-8');
      const planLines = planContent.split('\n').length;
      const planSize = Buffer.byteLength(planContent, 'utf-8');

      // Extract phase info
      const phaseMatches = planContent.match(/###?\s*Phase\s+\d+/gi) || [];
      // Extract dependency info
      const depMatches = planContent.match(/depend[s]?\s*(?:on)?\s*[:=]\s*\[?T-\d+/gi) || [];

      console.error(`[Orchestrator] 📊 Plan stats: ${planLines} lines, ${(planSize / 1024).toFixed(1)} KB, ${phaseMatches.length} phase(s), ${depMatches.length} dependency link(s)`);
    }
  } catch (_) { /* non-fatal logging */ }

  // ── Bus publish: PLAN → DEVELOPER ─────────────────────────────────────
  // The developer receives both the architecture doc AND the execution plan.
  // The architecture doc is passed via the bus from ARCHITECT→PLAN→DEVELOPER chain.
  // The execution plan path is stored in context for the developer to reference.
  const busMeta = {
    executionPlanPath: outputPath,
    contextSummary: planOutputCtx.summary,
    taskCount: planOutputCtx.taskCount || 0,
  };
  this.bus.publish(AgentRole.PLANNER, AgentRole.DEVELOPER, inputPath, busMeta);
  console.error(`[Orchestrator] 📤 Bus: PLANNER → DEVELOPER (architecture.md + execution-plan, ${busMeta.taskCount} task(s))`);

  // ── Translate to Chinese ──────────────────────────────────────────────
  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  const totalDuration = ((Date.now() - planStageStartTime) / 1000).toFixed(1);
  console.error(`[Orchestrator] ✅ PLAN stage completed in ${totalDuration}s (PlannerAgent: ${plannerDuration}s, overhead: ${(totalDuration - plannerDuration).toFixed(1)}s)`);

  return outputPath;
}

module.exports = { _runPlanner, buildPlannerUpstreamCtx, buildPlannerContextBlock };
