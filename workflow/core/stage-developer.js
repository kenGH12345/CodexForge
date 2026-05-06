/**
 * Stage Runner: DEVELOPER
 *
 * Extracted from orchestrator-stages.js (P0 decomposition – ADR-33).
 * Contains: _runDeveloper
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS, HOOK_EVENTS } = require('./constants');
const { AgentRole, WorkflowState } = require('./types');
const { ExperienceType, ExperienceCategory } = require('./experience-store');
const { CodeReviewAgent } = require('./code-review-agent');
const { RollbackCoordinator } = require('./rollback-coordinator');
const { QualityGate } = require('./quality-gate');
const { translateMdFile } = require('./i18n-translator');
const { runEvoMapFeedback, recordSelfReport, runStageMetricsGate } = require('./stage-runner-utils');
const { _recordPromptABOutcome } = require('./stage-analyst');
const {
  buildDeveloperUpstreamCtx,
  buildDeveloperContextBlock,
  storeCodeContext,
  codeQualityHelper,
} = require('./orchestrator-stage-helpers');
const { ContractViolationError } = require('./file-ref-bus');
const { buildRetryContext } = require('./retry-divergence-guard');
const { buildAgentPrompt } = require('./prompt-builder');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');
const { getStandardTools } = require('./agent-tools');

// ── ADR-48: Micro-Planning — local task amendment during CODE stage ──────────
// When the DeveloperAgent encounters plan deviations (unexpected dependencies,
// missing files, scope changes), it can locally amend individual tasks in
// execution-plan.md instead of triggering a full PLAN→CODE rollback.
const MICRO_PLAN_AMEND_MARKER = '<!-- MICRO-PLAN-AMEND -->';

// Forward reference: _runArchitect is needed for rollback. Lazy-loaded to avoid circular deps.
let _runArchitect = null;
function _getRunArchitect() {
  if (!_runArchitect) {
    _runArchitect = require('./stage-architect')._runArchitect;
  }
  return _runArchitect;
}

/**
 * ADR-48: Micro-Plan Amendment — locally revise a single task in execution-plan.md.
 *
 * When the DeveloperAgent's output indicates a plan deviation (e.g. unexpected
 * dependency discovered, file doesn't exist, scope change needed), this function
 * appends an amendment block to execution-plan.md rather than triggering a full
 * PLAN stage rollback.
 *
 * Amendment format:
 * ```
 * <!-- MICRO-PLAN-AMEND -->
 * ## Amendment #N (auto-generated during CODE stage)
 * - **Task**: T-XX
 * - **Reason**: <why the original plan was insufficient>
 * - **Original**: <original task description>
 * - **Amended**: <revised task description>
 * - **Impact**: <downstream tasks affected, if any>
 * ```
 *
 * @param {object} opts
 * @param {string} opts.executionPlanPath - Path to execution-plan.md
 * @param {string} opts.devOutput - DeveloperAgent's raw output text
 * @param {Array}  opts.structuredTasks - Structured task list from PLAN stage
 * @param {object} opts.orchestrator - Orchestrator instance (for logging/risks)
 * @returns {{ amended: boolean, amendCount: number, amendments: string[] }}
 */
function _microPlanAmend({ executionPlanPath, devOutput, structuredTasks, orchestrator }) {
  const result = { amended: false, amendCount: 0, amendments: [] };

  if (!executionPlanPath || !devOutput || !structuredTasks || structuredTasks.length === 0) {
    return result;
  }

  // Detect plan deviation signals in DeveloperAgent output
  const deviationPatterns = [
    // Explicit deviation markers the DeveloperAgent may emit
    /\[PLAN[_-]?DEVIATION\]\s*(.+)/gi,
    /\[SCOPE[_-]?CHANGE\]\s*(.+)/gi,
    /\[UNEXPECTED[_-]?DEPENDENCY\]\s*(.+)/gi,
    /\[TASK[_-]?AMENDMENT\]\s*(.+)/gi,
    // Implicit signals: "the plan said X but I found Y"
    /(?:plan|architecture)\s+(?:said|specified|expected|assumed)\s+(.+?)(?:but|however|instead)\s+(.+)/gi,
    // Task skip signals
    /(?:skipping|skipped|deferring|deferred)\s+task\s+(T-\d+)\s*[:\-]?\s*(.+)/gi,
  ];

  const deviations = [];
  for (const pattern of deviationPatterns) {
    let match;
    while ((match = pattern.exec(devOutput)) !== null) {
      deviations.push({
        raw: match[0].trim(),
        detail: match[1] ? match[1].trim() : '',
        extra: match[2] ? match[2].trim() : '',
      });
    }
  }

  if (deviations.length === 0) {
    return result;
  }

  // Read current plan to count existing amendments
  let currentPlan = '';
  try {
    if (fs.existsSync(executionPlanPath)) {
      currentPlan = fs.readFileSync(executionPlanPath, 'utf-8');
    }
  } catch (_) { /* non-fatal */ }

  const existingAmendCount = (currentPlan.match(new RegExp(MICRO_PLAN_AMEND_MARKER, 'g')) || []).length;
  const maxAmendments = 5; // Safety cap: too many amendments → full re-plan needed

  if (existingAmendCount >= maxAmendments) {
    console.error(`[MicroPlan] ⚠️  Amendment cap reached (${maxAmendments}). Too many deviations suggest the plan needs full revision.`);
    if (orchestrator && orchestrator.stateMachine) {
      orchestrator.stateMachine.recordRisk('medium',
        `[MicroPlan] ${deviations.length} new deviation(s) detected but amendment cap (${maxAmendments}) reached. Consider re-planning.`);
    }
    return result;
  }

  // Build amendment blocks
  const amendmentBlocks = [];
  for (const dev of deviations.slice(0, maxAmendments - existingAmendCount)) {
    const amendNum = existingAmendCount + amendmentBlocks.length + 1;
    // Try to match deviation to a specific task
    const taskMatch = dev.raw.match(/T-\d+/i);
    const taskId = taskMatch ? taskMatch[0].toUpperCase() : 'UNMATCHED';
    const matchedTask = structuredTasks.find(t => t.id === taskId);

    const block = [
      '',
      MICRO_PLAN_AMEND_MARKER,
      `## Amendment #${amendNum} (auto-generated during CODE stage)`,
      `- **Task**: ${taskId}${matchedTask ? ` — ${matchedTask.title}` : ''}`,
      `- **Reason**: ${dev.detail || dev.raw}`,
      matchedTask ? `- **Original**: ${matchedTask.description || matchedTask.title}` : '',
      `- **Amended**: ${dev.extra || dev.detail || dev.raw}`,
      `- **Impact**: Downstream tasks may need adjustment`,
      `- **Timestamp**: ${new Date().toISOString()}`,
      '',
    ].filter(Boolean).join('\n');

    amendmentBlocks.push(block);
    result.amendments.push(`Amendment #${amendNum}: ${taskId} — ${dev.detail || dev.raw}`);
  }

  if (amendmentBlocks.length > 0) {
    try {
      fs.appendFileSync(executionPlanPath, '\n' + amendmentBlocks.join('\n'), 'utf-8');
      result.amended = true;
      result.amendCount = amendmentBlocks.length;
      console.error(`[MicroPlan] 📝 ${result.amendCount} amendment(s) appended to execution-plan.md (total: ${existingAmendCount + result.amendCount})`);

      if (orchestrator && orchestrator.stateMachine) {
        orchestrator.stateMachine.recordRisk('low',
          `[MicroPlan] ${result.amendCount} task amendment(s) applied during CODE stage: ${result.amendments.join('; ').slice(0, 200)}`);
      }
    } catch (writeErr) {
      console.warn(`[MicroPlan] ⚠️  Failed to write amendments (non-fatal): ${writeErr.message}`);
    }
  }

  return result;
}

/**
 * Runs the CODE stage: code generation, code review, quality gate, and rollback.
 *
 * P1-2 fix: @this annotation for IDE IntelliSense and safe refactoring.
 *
 * @this {import('./orchestrator').Orchestrator}
 * @returns {Promise<string>} Path to the generated code.diff
 */
async function _runDeveloper() {
  const _devStageStartTime = Date.now();
  // Print stage header via handoffLog if available
  if (this.handoffLog) {
    this.handoffLog.printStageHeader('CODE', 'DeveloperAgent');
  } else {
    console.error(`\n[Orchestrator] Stage: CODE (DeveloperAgent)`);
  }  const inputPath = this.bus.consume(AgentRole.DEVELOPER);

  // ── Read execution plan from PLAN stage ────────────────────────────────
  // The PLAN stage publishes the architecture.md path as the main artifact
  // and stores the execution-plan.md path in metadata.
  const planMeta = this.bus.getMeta(AgentRole.DEVELOPER);
  let executionPlanContent = '';
  if (planMeta && planMeta.executionPlanPath) {
    try {
      if (fs.existsSync(planMeta.executionPlanPath)) {
        executionPlanContent = fs.readFileSync(planMeta.executionPlanPath, 'utf-8');
        console.error(`[Orchestrator] 📋 Execution plan loaded (${executionPlanContent.length} chars) from ${planMeta.executionPlanPath}`);
      }
    } catch (planErr) {
      console.warn(`[Orchestrator] ⚠️  Could not read execution plan (non-fatal): ${planErr.message}`);
    }
  }

  const upstreamCtxForDevStr = buildDeveloperUpstreamCtx(this);

  // P0-1 fix: buildDeveloperUpstreamCtx returns a primitive string.
  // Wrap in an object so we can attach executionPlanBlock without silent failure.
  // (Previously: `upstreamCtxForDev.executionPlanBlock = ...` silently failed on primitive string.)
  const upstreamCtxForDev = { text: upstreamCtxForDevStr, executionPlanBlock: '' };

  // ── Structured task injection (replaces raw 8000-char truncation) ───────
  // Prefer structured tasks[] from stageCtx.PLAN.meta (extracted from JSON block).
  // Fall back to raw markdown truncation only if structured data is unavailable.
  const planCtxMeta = this.stageCtx?.get(WorkflowState.PLAN)?.meta;
  const structuredTasks = planCtxMeta?.tasks;
  const structuredPhases = planCtxMeta?.phases;
  const adrTaskLinkage = planCtxMeta?.adrTaskLinkage;

  // Build a lookup: taskId → { reqId, adrId } for inline annotation
  const taskToLinkage = new Map();
  if (adrTaskLinkage && Array.isArray(adrTaskLinkage.links)) {
    for (const link of adrTaskLinkage.links) {
      for (const taskId of link.taskIds) {
        taskToLinkage.set(taskId, { reqId: link.reqId, adrId: link.adrId });
      }
    }
  }

  if (structuredTasks && structuredTasks.length > 0) {
    // Build a compact structured task list — DeveloperAgent can precisely locate each task
    const parts = ['\n## Execution Plan — Structured Task List (from PLAN stage JSON block)'];
    parts.push(`> Total: ${structuredTasks.length} task(s) across ${structuredPhases ? structuredPhases.length : '?'} phase(s). Implement ALL tasks unless instructed otherwise.`);
    parts.push('');

    // Emit phases as sections if available
    if (structuredPhases && structuredPhases.length > 0) {
      for (const phase of structuredPhases) {
        const phaseTasks = structuredTasks.filter(t =>
          phase.taskIds && phase.taskIds.includes(t.id)
        );
        if (phaseTasks.length === 0) continue;
        parts.push(`### Phase ${phase.id}: ${phase.name}`);
        for (const task of phaseTasks) {
          parts.push(`#### Task ${task.id}: ${task.title}`);
          if (task.moduleId) parts.push(`- **Module**: ${task.moduleId}`);
          if (task.description) parts.push(`- **Description**: ${task.description}`);
          if (task.files && task.files.length > 0) parts.push(`- **Files**: ${task.files.join(', ')}`);
          if (task.dependencies && task.dependencies.length > 0) parts.push(`- **Depends on**: ${task.dependencies.join(', ')}`);
          if (task.estimate) parts.push(`- **Estimate**: ${task.estimate}`);
          // ADR-Task Linkage: inject requirement traceability as implementation constraint
          const linkage = taskToLinkage.get(task.id);
          if (linkage) parts.push(`- **Implements**: Req \`${linkage.reqId}\` via ADR \`${linkage.adrId}\` — ensure implementation satisfies this requirement`);
          parts.push('');
        }
      }
      // Emit tasks not assigned to any phase
      const assignedTaskIds = new Set(structuredPhases.flatMap(p => p.taskIds || []));
      const unassignedTasks = structuredTasks.filter(t => !assignedTaskIds.has(t.id));
      if (unassignedTasks.length > 0) {
        parts.push('### Unphased Tasks');
        for (const task of unassignedTasks) {
          parts.push(`#### Task ${task.id}: ${task.title}`);
          if (task.moduleId) parts.push(`- **Module**: ${task.moduleId}`);
          if (task.description) parts.push(`- **Description**: ${task.description}`);
          if (task.files && task.files.length > 0) parts.push(`- **Files**: ${task.files.join(', ')}`);
          parts.push('');
        }
      }
    } else {
      // No phases: flat task list
      for (const task of structuredTasks) {
        parts.push(`#### Task ${task.id}: ${task.title}`);
        if (task.moduleId) parts.push(`- **Module**: ${task.moduleId}`);
        if (task.description) parts.push(`- **Description**: ${task.description}`);
        if (task.files && task.files.length > 0) parts.push(`- **Files**: ${task.files.join(', ')}`);
        if (task.dependencies && task.dependencies.length > 0) parts.push(`- **Depends on**: ${task.dependencies.join(', ')}`);
        // ADR-Task Linkage: inject requirement traceability as implementation constraint
        const linkage = taskToLinkage.get(task.id);
        if (linkage) parts.push(`- **Implements**: Req \`${linkage.reqId}\` via ADR \`${linkage.adrId}\` — ensure implementation satisfies this requirement`);
        parts.push('');
      }
    }

    upstreamCtxForDev.executionPlanBlock = parts.join('\n');
    console.error(`[Orchestrator] 📋 Structured task list injected into DeveloperAgent (${structuredTasks.length} tasks, ${upstreamCtxForDev.executionPlanBlock.length} chars — replaces raw 8000-char truncation).`);
  } else if (executionPlanContent) {
    // Fallback: raw markdown truncation (no structured JSON block available)
    upstreamCtxForDev.executionPlanBlock = `\n## Execution Plan (from PLAN stage)\n${executionPlanContent.slice(0, 8000)}${executionPlanContent.length > 8000 ? '\n... (truncated)' : ''}`;
    console.error(`[Orchestrator] 📋 Execution plan injected as raw text (${executionPlanContent.length} chars, structured tasks unavailable).`);
  }

  const archMeta = planMeta || this.bus.getMeta(AgentRole.DEVELOPER);
  if (archMeta && archMeta.reviewRounds > 0) {
    console.error(`[Orchestrator] ℹ️  Architecture was self-corrected in ${archMeta.reviewRounds} round(s) (${archMeta.failedItems} issue(s) fixed). Developer should review architecture.md carefully.`);
  }

  // A-3 fix: buildDeveloperContextBlock now returns { content, injectedExpIds } struct
  const devContextResult = await buildDeveloperContextBlock(this, upstreamCtxForDev);
  const devExpContext = devContextResult.content;
  const devInjectedExpIds = devContextResult.injectedExpIds || [];
  this.obs.recordExpUsage({ injected: devInjectedExpIds.length });

  // ── Optimization 1: Dynamic Tool Calling ──────────────────────────────────
  // Enable ReAct loop for DeveloperAgent to explore codebase dynamically
  this.agents[AgentRole.DEVELOPER].tools = getStandardTools(this);
  console.error(`[Orchestrator] 🛠️  Dynamic Tool Calling enabled for DEVELOPER stage.`);

let outputPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, devExpContext, this.handoffLog);

  // ── P0-FIX: Validate DEVELOPER output is not empty ───────────────────────
  // If the LLM wrote an empty file (0 bytes or only whitespace), the downstream
  // TESTER Agent will receive garbage input. Detect this early and retry once.
  if (outputPath && fs.existsSync(outputPath)) {
    const devOutputContent = fs.readFileSync(outputPath, 'utf-8').trim();
    if (devOutputContent.length === 0) {
      console.warn(`[Orchestrator] ⚠️  DEVELOPER produced an empty file. Retrying once with explicit hint...`);
      this.stateMachine.recordRisk('medium', '[DEVELOPER] First attempt produced empty output. Retrying.');
      const retryHint = `[IMPORTANT: Your previous code output was EMPTY. You MUST produce a complete code diff. Do not output an empty file.]`;
      const retryDevContext = devExpContext + '\n\n' + retryHint;
      const retryOutputPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, retryDevContext, this.handoffLog);
      if (retryOutputPath && fs.existsSync(retryOutputPath)) {
        const retryContent = fs.readFileSync(retryOutputPath, 'utf-8').trim();
        if (retryContent.length > 0) {
          console.error(`[Orchestrator] ✅ DEVELOPER retry succeeded (${retryContent.length} chars).`);
          outputPath = retryOutputPath;
        } else {
          throw new Error('[DEVELOPER] Agent produced empty output on both attempts. Cannot proceed.');
        }
      } else {
        throw new Error('[DEVELOPER] Agent produced no output on retry. Cannot proceed.');
      }
    }
  }

  // ── ADR-48: Micro-Plan Amendment — detect and record plan deviations ────────
  // After DeveloperAgent produces output, scan for deviation signals and locally
  // amend execution-plan.md instead of triggering a full PLAN rollback.
  if (outputPath && fs.existsSync(outputPath)) {
    try {
      const devOutputForAmend = fs.readFileSync(outputPath, 'utf-8');
      const planMetaForAmend = this.bus.getMeta(AgentRole.DEVELOPER);
      const planCtxForAmend = this.stageCtx?.get(WorkflowState.PLAN)?.meta;
      const tasksForAmend = planCtxForAmend?.tasks || [];
      const planPath = planMetaForAmend?.executionPlanPath;

      if (planPath && tasksForAmend.length > 0) {
        const amendResult = _microPlanAmend({
          executionPlanPath: planPath,
          devOutput: devOutputForAmend,
          structuredTasks: tasksForAmend,
          orchestrator: this,
        });

        if (amendResult.amended) {
          // Store amendment info in stageCtx for downstream visibility
          const existingCodeCtx = this.stageCtx?.get(WorkflowState.CODE) || {};
          this.stageCtx?.set(WorkflowState.CODE, {
            ...existingCodeCtx,
            meta: {
              ...(existingCodeCtx.meta || {}),
              microPlanAmendments: amendResult.amendments,
              microPlanAmendCount: amendResult.amendCount,
            },
          });
        }
      }
    } catch (amendErr) {
      console.warn(`[Orchestrator] ⚠️  Micro-plan amendment scan failed (non-fatal): ${amendErr.message}`);
    }
  }

  // ── Adapter Telemetry ─────────────────────────────────────────────────────────
  if (this._adapterTelemetry && outputPath && fs.existsSync(outputPath)) {
    try {
      const devOutput = fs.readFileSync(outputPath, 'utf-8');
      this._adapterTelemetry.scanReferences(devOutput, 'DEVELOPER');
      // ── Agent Self-Report: extract self-report from DEVELOPER output ──
      recordSelfReport('CODE', devOutput, { agentRole: AgentRole.DEVELOPER });
    } catch (_) { /* non-fatal */ }
  }
  // ── Code Quality injection ────────────────────────────────────────────────
  let codeQualityContext = '';
  try {
    const cqResult = await codeQualityHelper(this, {
      maxIssues: 15,
      label: 'Code Quality (CodeReview)',
    });
    if (cqResult && cqResult.block) {
      codeQualityContext = cqResult.block;
      if (cqResult.qualityGate && cqResult.qualityGate.status === 'ERROR') {
        this.stateMachine.recordRisk('medium',
          `[CodeQuality] Quality gate FAILED: ${(cqResult.qualityGate.conditions || []).filter(c => c.status !== 'OK').map(c => c.metric).join(', ')}`,
          false
        );
      }
    }
  } catch (err) {
    console.warn(`[Orchestrator] 📊 Code quality scan for CodeReview failed (non-fatal): ${err.message}`);
  }

  let qualityInjected = false;
  if (codeQualityContext && outputPath && fs.existsSync(outputPath)) {
    try {
      const CQ_SENTINEL_START = '# ── CQ_INJECT_9f3a7b2e_START ──';
      const CQ_SENTINEL_END   = '# ── CQ_INJECT_9f3a7b2e_END ──';
      const qualityHeader = `\n\n${CQ_SENTINEL_START}\n# Code Quality Metrics (auto-injected by CodeQuality MCP)\n# The following metrics are from real static analysis. Use them to\n# inform your review decisions, especially for PERF and STYLE items.\n# ${codeQualityContext.replace(/\n/g, '\n# ')}\n${CQ_SENTINEL_END}\n\n`;
      fs.appendFileSync(outputPath, qualityHeader, 'utf-8');
      qualityInjected = true;
    } catch (_) { /* non-fatal */ }
  }

  const requirementPath = path.join(this._outputDir, 'requirements.md');
  const reviewRiskProfile = (() => {
    const notes = (reviewResultLike => (reviewResultLike?.riskNotes || []).join(' '))({ riskNotes: [] });
    const diffText = outputPath && fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
    const corpus = `${notes}\n${diffText}`.toLowerCase();
    const score = (regex) => (regex.test(corpus) ? 0.75 : 0);
    return {
      security: score(/\b(auth|xss|csrf|inject|sql|secret|token|credential|vulnerab)\b/i),
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
        stage: 'CODE',  // T-U2: dynamic budget signal for reviewer sub-call
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
      callSite: 'workflow/core/stage-developer.js:reviewLlmCall',
      role: 'code-reviewer',
      stage: 'CODE',
      runtimePrompt: optimisedPrompt,
      candidatePrompt: optimisedPrompt,
      metadata: { category: 'raw-orchestrator-call' },
    }));
  };
  const reviewer = new CodeReviewAgent(
    reviewLlmCall,
    {
      maxRounds: 2,
      verbose: true,
      outputDir: this._outputDir,
      investigationTools: this._buildInvestigationTools('Code'),
    }
  );
  const reviewResult = await reviewer.review(outputPath, requirementPath);

  // Clean up injected quality context
  if (qualityInjected && outputPath && fs.existsSync(outputPath)) {
    try {
      let diffContent = fs.readFileSync(outputPath, 'utf-8');
      const qualityStart = diffContent.indexOf('\n\n# ── CQ_INJECT_9f3a7b2e_START ──');
      if (qualityStart !== -1) {
        diffContent = diffContent.slice(0, qualityStart);
        fs.writeFileSync(outputPath, diffContent, 'utf-8');
      }
    } catch (_) { /* non-fatal */ }
  }

  const codeSubtaskCoordinator = new RollbackCoordinator(this);
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeGeneration', { outputPath });
  codeSubtaskCoordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', reviewResult);

  // ── P0-2: Module Boundary Violation Check ─────────────────────────────────
  // After code generation, verify that the developer's file changes respect the
  // module boundaries defined in the Module Map. This is "Trust but Verify":
  // the developer was told to stay within boundaries, now we check compliance.
  try {
    const analyseCtx = this.stageCtx?.get(WorkflowState.ANALYSE);
    const planCtx = this.stageCtx?.get(WorkflowState.PLAN);
    const moduleMap = analyseCtx?.meta?.moduleMap;
    const moduleGrouping = planCtx?.meta?.moduleGrouping;

    if (moduleMap && Array.isArray(moduleMap.modules) && moduleMap.modules.length > 0 && outputPath && fs.existsSync(outputPath)) {
      // Parse the developer's output to extract files mentioned/changed
      const devOutput = fs.readFileSync(outputPath, 'utf-8');
      // Extract file paths from common diff patterns: +++ b/path, --- a/path, or explicit file references
      const filePatterns = [
        /^[+]{3}\s+b\/(.+)$/gm,    // unified diff: +++ b/path
        /^[-]{3}\s+a\/(.+)$/gm,    // unified diff: --- a/path
        /^\+\+\+\s+(.+)$/gm,       // other diff formats
      ];
      const mentionedFiles = new Set();
      for (const pattern of filePatterns) {
        let m;
        while ((m = pattern.exec(devOutput)) !== null) {
          const filePath = m[1].trim().replace(/\\/g, '/');
          if (filePath && filePath !== '/dev/null' && !filePath.startsWith('null')) {
            mentionedFiles.add(filePath);
          }
        }
      }

      if (mentionedFiles.size > 0) {
        // Determine which module(s) the current task belongs to
        // Use all module boundaries combined for a comprehensive check
        const allBoundaries = moduleMap.modules.flatMap(m => m.boundaries || []);
        if (allBoundaries.length > 0) {
          const boundaryCheck = QualityGate.checkModuleBoundaryViolation(
            [...mentionedFiles],
            { moduleId: 'all-modules', boundaries: allBoundaries }
          );
          if (!boundaryCheck.clean) {
            console.warn(`[Orchestrator] ⚠️  ${boundaryCheck.summary}`);
            this.stateMachine.recordRisk('low',
              `[ModuleBoundary] ${boundaryCheck.violations.length} file(s) modified outside defined module boundaries: ${boundaryCheck.violations.slice(0, 3).join(', ')}`,
              false
            );
          } else {
            console.error(`[Orchestrator] ✅ Module boundary check passed: ${boundaryCheck.summary}`);
          }
        }
      }
    }
  } catch (boundaryErr) {
    console.warn(`[Orchestrator] ⚠️  Module boundary check failed (non-fatal): ${boundaryErr.message}`);
  }

  // ── ADR-50: CodeGraph Patch Refresh after CODE stage ──────────────────────
  // After DeveloperAgent generates code, refresh CodeGraph with the changed files
  // so downstream stages (TEST, rollback retries) see up-to-date symbol data.
  // Only runs in Node Orchestrator mode — in IDE Agent mode, CodeGraph is fallback
  // and IDE native tools provide real-time code understanding (ADR-37).
  try {
    if (this.codeGraph && !this.codeGraph._ideSearchAvailable && outputPath && fs.existsSync(outputPath)) {
      const diffContent = fs.readFileSync(outputPath, 'utf-8');
      const patchFilePatterns = [
        /^[+]{3}\s+b\/(.+)$/gm,
        /^[-]{3}\s+a\/(.+)$/gm,
      ];
      const patchFiles = new Set();
      for (const pat of patchFilePatterns) {
        let m;
        while ((m = pat.exec(diffContent)) !== null) {
          const fp = m[1].trim().replace(/\\/g, '/');
          if (fp && fp !== '/dev/null' && !fp.startsWith('null')) {
            patchFiles.add(fp);
          }
        }
      }

      if (patchFiles.size > 0 && typeof this.codeGraph.build === 'function') {
        const patchResult = await this.codeGraph.build({
          patchFiles: [...patchFiles],
          writeOutput: true,
        });
        console.error(`[Orchestrator] 🔄 CodeGraph patched: ${patchResult.changedFiles} file(s) updated, ${patchResult.symbolCount} symbols total.`);
      }
    }
  } catch (cgPatchErr) {
    console.warn(`[Orchestrator] ⚠️  CodeGraph patch refresh failed (non-fatal): ${cgPatchErr.message}`);
  }

  for (const note of reviewResult.riskNotes) {
    const severity = note.includes('(high)') ? 'high' : 'medium';
    this.stateMachine.recordRisk(severity, note, false);
  }
  this.stateMachine.flushRisks();

  const codeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
  const codeRollbackCountForGate = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
  const codeDecision = codeGate.evaluate(reviewResult, WorkflowState.CODE, codeRollbackCountForGate);
  codeGate.recordExperience(codeDecision, WorkflowState.CODE, reviewResult, { skill: 'code-development', category: ExperienceCategory.STABLE_PATTERN });

  if (this.obs && this.obs._skillInjectedCounts && this.obs._skillInjectedCounts.size > 0) {
    const injectedNames = [...this.obs._skillInjectedCounts.keys()];
    const falsePositiveSignals = Math.max(0, Number(reviewResult?.failed || 0) - Number(reviewResult?.rounds || 0));
    this.obs.recordSkillGateOutcome(injectedNames, {
      passed: !!codeDecision.pass,
      falsePositiveSignals,
    });
  }

  _recordPromptABOutcome('developer', codeDecision.pass, reviewResult.rounds ?? 0);

  if (codeDecision.pass) {
    console.error(`[Orchestrator] ✅ Code review passed. Reason: ${codeDecision.reason}`);
  } else if (codeDecision.rollback) {
    // ── Rollback LoopGuard Check ───────────────────────────────────────────
    // Prevent infinite recursion: CODE → ARCHITECT → CODE → ARCHITECT...
    const loopGuard = this._loopGuard;
    const canRetryCodeToArch = loopGuard ? loopGuard.canRetry('CODE', 'ARCHITECT') : true;
    const codeToArchRetryCount = loopGuard ? loopGuard.getRetryCount('CODE', 'ARCHITECT') : 0;
    const maxCodeToArchRetries = (this.config?.maxRollbackPerStage?.developer ?? 2);

    if (!canRetryCodeToArch || codeToArchRetryCount >= maxCodeToArchRetries) {
      console.warn(`[Orchestrator] ⚠️  LoopGuard: CODE→ARCHITECT rollback blocked after ${codeToArchRetryCount} retries (max: ${maxCodeToArchRetries}). Proceeding with risks recorded.`);
      this.stateMachine.recordRisk('high', `[LoopGuard] CODE→ARCHITECT rollback limit exceeded. ${reviewResult.failed} high-severity issue(s) remain unresolved.`);
      // Fall through to treat as needsHumanReview
    } else {
      // Record retry attempt before proceeding
      if (loopGuard) loopGuard.recordRetry('CODE', 'ARCHITECT');

    console.warn(`[Orchestrator] ⚠️  ${reviewResult.failed} high-severity code issue(s) remain. Attempting rollback to ARCHITECT stage (retry ${codeToArchRetryCount + 1}/${maxCodeToArchRetries}).`);
    const failedNotes = reviewResult.riskNotes.slice(0, 3).join('; ');
    const failContent = `After ${reviewResult.rounds ?? 'N/A'} self-correction round(s), ${reviewResult.failed} high-severity issue(s) remained. Issues: ${failedNotes}`;
    // P1: Use recordWithContentCheck to avoid duplicate experience entries
    this.experienceStore.recordWithContentCheck({
      type: ExperienceType.NEGATIVE,
      category: ExperienceCategory.PITFALL,
      title: 'Code review: high-severity issues unresolved after self-correction',
      content: failContent,
      skill: 'code-development',
      tags: ['code-review', 'failed', 'pitfall'],
    });

    const codeRollbackCount = this._rollbackCounters?.get(WorkflowState.CODE) ?? 0;
    if (this._rollbackCounters) this._rollbackCounters.set(WorkflowState.CODE, codeRollbackCount + 1);
    if (this.stageCtx) {
      const existingCode = this.stageCtx.get(WorkflowState.CODE) || {};
      this.stageCtx.set(WorkflowState.CODE, {
        ...existingCode,
        meta: { ...(existingCode.meta || {}), _codeRollbackCount: codeRollbackCount + 1, rollbackToArchitect: true },
      });
    }
    try {
      const coordinator = new RollbackCoordinator(this);
      const codeStrategy = coordinator.analyseRollbackStrategy(
        WorkflowState.CODE, `Code review failed: ${failedNotes}`, 'CodeReview'
      );

      if (codeStrategy.type === 'SUBTASK_RETRY' && codeStrategy.cachedResults) {
        console.error(`[Orchestrator] 🎯 Defect C: Subtask-level retry for CODE. ${codeStrategy.reason}`);

        const retryCodeReviewer = new CodeReviewAgent(
          reviewLlmCall,
          {
            maxRounds: 2,
            verbose: true,
            outputDir: this._outputDir,
            investigationTools: this._buildInvestigationTools('Code'),
          }
        );
        const reqPath = path.join(this._outputDir, 'requirements.md');

        const retryNote = `\n\n// --- Code Review Retry (Attempt ${codeRollbackCount + 1}) ---\n// Previous review found these issues:\n// ${failedNotes.replace(/\n/g, '\n// ')}\n// Please address the above.`;
        fs.appendFileSync(outputPath, retryNote, 'utf-8');

        const retryReview = await retryCodeReviewer.review(outputPath, reqPath);

        const retryCodeGate = new QualityGate({ experienceStore: this.experienceStore, maxRollbacks: 1 });
        const retryCodeDecision = retryCodeGate.evaluate(retryReview, WorkflowState.CODE, codeRollbackCount + 1);

        if (retryCodeDecision.pass) {
          console.error(`[Orchestrator] ✅ Subtask-level retry succeeded: CodeReview passed on retry.`);
          coordinator.cacheSubtaskResult(WorkflowState.CODE, 'CodeReview', retryReview);

          const codeOutputCtx = await storeCodeContext(this, outputPath, retryReview);
          this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
            reviewRounds:   retryReview.rounds ?? 0,
            failedItems:    retryReview.failed ?? 0,
            riskNotes:      retryReview.riskNotes ?? [],
            contextSummary: codeOutputCtx.summary,
          });
          return outputPath;
        }

        console.error(`[Orchestrator] ⚠️  Subtask-level retry failed for CODE. Falling through to full-stage rollback.`);
        coordinator.invalidateSubtaskCache(WorkflowState.CODE);
      }

      // ── Full-stage rollback ──────────────────────────────────────────────
      await coordinator.rollback(WorkflowState.CODE, `Code review failed: ${failedNotes.slice(0, 200)}`);
      
      // Record rollback in handoff log
      if (this.handoffLog) {
        this.handoffLog.recordRollback('CODE', 'ARCHITECT', `Code review failed: ${failedNotes.slice(0, 200)}`);
      }

      const archOutputPath = path.join(this._outputDir, 'architecture.md');
      if (fs.existsSync(archOutputPath)) {
        // RetryDivergenceGuard: build enhanced failure note with Negative Prompt + Creativity Directive
        let previousCodeOutput = '';
        try {
          const codeDiffPath = path.join(this._outputDir, 'code.diff');
          if (fs.existsSync(codeDiffPath)) previousCodeOutput = fs.readFileSync(codeDiffPath, 'utf-8');
        } catch (_) { /* non-fatal */ }

        const retryContext = await buildRetryContext({
          previousOutput: previousCodeOutput,
          failureReason: failedNotes,
          retryCount: codeRollbackCount + 1,
          stageName: 'CODE',
        });
        const failureNote = `\n\n---\n${retryContext}\n\nPlease revise the architecture to address these code-level concerns before the developer retries.`;
        fs.appendFileSync(archOutputPath, failureNote, 'utf-8');
        this.bus.publish(AgentRole.ANALYST, AgentRole.ARCHITECT, archOutputPath, {
          codeReviewFailed: true,
          failedNotes,
          rollbackRetry: codeRollbackCount + 1,
        });
      }
      if (this.stageCtx) {
        const existingCodeCtx = this.stageCtx.get(WorkflowState.CODE) || {};
        this.stageCtx.set(WorkflowState.CODE, {
          ...existingCodeCtx,
          summary: `Code review failed (retry ${codeRollbackCount + 1}): ${failedNotes.slice(0, 200)}. Rollback to ARCHITECT triggered.`,
          keyDecisions: [`Rollback to ARCHITECT triggered after ${reviewResult.failed} high-severity issue(s)`],
          artifacts: [outputPath],
          risks: reviewResult.riskNotes ?? [],
          meta: { ...(existingCodeCtx.meta || {}), _codeRollbackCount: codeRollbackCount + 1, rollbackTriggered: true },
        });
      }
      const archStageLabel = 'CODE→ARCHITECT(rollback-retry)';
      this.obs.stageStart(archStageLabel);
      let archRetry;
      try {
        archRetry = await _getRunArchitect().call(this);
        this.obs.stageEnd(archStageLabel, 'ok');
      } catch (archErr) {
        this.obs.stageEnd(archStageLabel, 'error');
        this.obs.recordError(archStageLabel, archErr.message);
        await this.hooks.emit(HOOK_EVENTS.WORKFLOW_ERROR, { error: archErr, state: 'CODE→ARCHITECT(rollback)' }).catch(() => {});
        throw archErr;
      }
      // ── LoopGuard: Check if ARCHITECT returned rolledBack sentinel ────────
      // If ARCHITECT also rolled back (to ANALYSE), this creates a cascade.
      // Only handle if archRetry is a valid StageResult with rolledBack type.
      const { StageResult } = require('./types');
      if (StageResult.isRolledBack(archRetry)) {
        console.error(`[Orchestrator] ℹ️  ARCHITECT also rolled back (cascade). Propagating rollback sentinel.`);
        return archRetry; // Propagate the rollback sentinel up the call chain
      }
      // Normal completion: ARCHITECT succeeded, continue pipeline
      return archRetry;
    } catch (rollbackErr) {
      console.warn(`[Orchestrator] Code rollback failed (non-fatal): ${rollbackErr.message}. Proceeding with risks recorded.`);
      this.stateMachine.recordRisk('high', `[CodeReview] ${reviewResult.failed} high-severity issue(s) unresolved. Rollback failed: ${rollbackErr.message}`);
    }
    } // end LoopGuard else block - only executed if retry allowed
  } else if (codeDecision.needsHumanReview) {
    console.warn(`[Orchestrator] ⚠️  Code rollback limit reached (max 1). Proceeding to TEST with ${reviewResult.failed} unresolved issue(s).`);
    this.stateMachine.recordRisk('high', `[CodeReview] ${reviewResult.failed} high-severity issue(s) unresolved after rollback limit reached.`);
  } else {
    console.error(`[Orchestrator] ℹ️  ${reviewResult.failed} minor code issue(s) remain. Proceeding automatically.`);
  }

  // ── Early Entropy GC ─────────────────────────────────────────────────────
  try {
    console.error(`\n[Orchestrator] 🔍 Early entropy scan (post-CODE stage)...`);
    const earlyGcResult = await this.entropyGC.run();
    if (earlyGcResult.violations > 0) {
      const highCount = earlyGcResult.details?.high ?? 0;
      const gcMsg = `[EntropyGC/early] ${earlyGcResult.violations} violation(s) detected after CODE stage (${highCount} high). See output/entropy-report.md.`;
      console.warn(`[Orchestrator] ⚠️  ${gcMsg}`);
      if (highCount > 0) {
        this.stateMachine.recordRisk('high', gcMsg);
      }
    } else {
      console.error(`[Orchestrator] ✅ Early entropy scan: no violations found.`);
    }
  } catch (err) {
    console.warn(`[Orchestrator] Early EntropyGC scan failed (non-fatal): ${err.message}`);
  }

  // ── EvoMap feedback loop ────────────────────────────────────────────────
  if (codeDecision.pass) {
    await runEvoMapFeedback(this, {
      injectedExpIds: devInjectedExpIds,
      errorContext: (reviewResult.riskNotes || []).join(' '),
      stageLabel: 'CODE',
    });
  }

  const codeOutputCtx = await storeCodeContext(this, outputPath, reviewResult);

  // ── Publish with ContractViolationError retry ─────────────────────────────
  // If the DEVELOPER output fails the TESTER's content contract (e.g. too short,
  // not a valid diff), catch the error and retry the Agent once.
  try {
    this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, outputPath, {
      reviewRounds:   reviewResult.rounds ?? 0,
      failedItems:    reviewResult.failed ?? 0,
      riskNotes:      reviewResult.riskNotes ?? [],
      contextSummary: codeOutputCtx.summary,
    });
  } catch (pubErr) {
    if (pubErr instanceof ContractViolationError) {
      console.warn(`[Orchestrator] ⚠️  DEVELOPER output failed contract: ${pubErr.contractReason}. Retrying Agent once...`);
      this.stateMachine.recordRisk('medium', `[DEVELOPER] Output failed contract validation: ${pubErr.contractReason}. Retrying.`);
      const retryHint = `[IMPORTANT: Your previous code output failed quality validation: ${pubErr.contractReason}. Please produce a COMPLETE code diff with all required changes.]`;
      const retryDevCtx = devExpContext + '\n\n' + retryHint;
      const retryPath = await this.agents[AgentRole.DEVELOPER].run(inputPath, null, retryDevCtx, this.handoffLog);
      // Retry publish – if this also throws, let it propagate to the orchestrator
      this.bus.publish(AgentRole.DEVELOPER, AgentRole.TESTER, retryPath, {
        reviewRounds:   reviewResult.rounds ?? 0,
        failedItems:    reviewResult.failed ?? 0,
        riskNotes:      reviewResult.riskNotes ?? [],
        contextSummary: codeOutputCtx.summary,
        contractRetry:  true,
      });
      console.error(`[Orchestrator] ✅ DEVELOPER contract retry succeeded.`);
    } else {
      throw pubErr;
    }
  }

  translateMdFile(outputPath, this._rawLlmCall).catch(() => {});

  // ── Metrics Quality Gate: validate DEVELOP stage runtime metrics ──────
  runStageMetricsGate(this, {
    stageName: 'DEVELOP',
    durationMs: Date.now() - _devStageStartTime,
    errorCount: (reviewResult?.failed || 0),
    llmCalls: (this.obs && this.obs._llmCallCount) ? this.obs._llmCallCount : 0,
  });

  return outputPath;
}

module.exports = { _runDeveloper };
