/**
 * Tester Context Builder
 *
 * Extracted from orchestrator-stage-helpers.js to decompose the 1,800+ line
 * monolith into testable, focused modules (each < 400 lines).
 *
 * This module owns:
 *   - buildTesterUpstreamCtx() — cross-stage context for TESTER
 *   - buildTesterContextBlock() — full context block assembly for TesterAgent
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { ComplaintTarget } = require('./complaint-wall');
const { WorkflowState } = require('./types');
const { buildJsonBlockInstruction } = require('./agent-output-schema');

const {
  BLOCK_PRIORITY,
  _applyTokenBudget,
  externalExperienceFallback,
} = require('./context-budget-manager');

const { _getContextProfile } = require('./context-helpers');

// ─── Cross-stage context injection ───────────────────────────────────────────

/**
 * Builds the upstream cross-stage context string for TESTER stage.
 * Defect D fix: uses getRelevant() for dynamic context selection.
 *
 * @param {Orchestrator} orch
 * @param {string} [taskHints]
 * @returns {string}
 */
function buildTesterUpstreamCtx(orch, taskHints = '') {
  if (!orch.stageCtx) return '';
  const ctx = orch.stageCtx.getRelevant(WorkflowState.TEST, {
    taskHints,
    maxChars: 2000,
    excludeStages: [WorkflowState.TEST],
  });
  if (ctx) {
    console.log(`[Orchestrator] 🔗 Cross-stage context injected into TesterAgent (${ctx.length} chars, dynamic selection). Upstream: ${orch.stageCtx.getLogLine()}`);
  }
  return ctx;
}

// ─── Full context block assembly ─────────────────────────────────────────────

/**
 * Assembles the full context string for TesterAgent:
 *   AGENTS.md + upstream ctx + experience + complaints + real execution results
 *   + parallel MCP adapter data (test best practices, CI status, test infra)
 *
 * @param {Orchestrator} orch
 * @param {string} upstreamCtx
 * @param {object|null} tcExecutionReport
 * @returns {Promise<string>}
 */
async function buildTesterContextBlock(orch, upstreamCtx, tcExecutionReport) {
  const agentsMd = orch._agentsMdContent || '';
  if (agentsMd) console.log(`[Orchestrator] 📋 AGENTS.md injected into TesterAgent context.`);

  const jsonInstruction = buildJsonBlockInstruction('tester');

  // P1 fix: Detect tech stack for fallback experience matching
  const techStack = orch._detectTechStackForPreheat ? orch._detectTechStackForPreheat() : [];
  const testMaxExpInjected = orch._adaptiveStrategy?.maxExpInjected ?? 5;
  const { block: expCtx, ids: injectedExpIds } = await orch.experienceStore.getContextBlockWithIds('test-report', orch._currentRequirement, testMaxExpInjected, { techStack });
  console.log(`[Orchestrator] 📚 Experience context injected for TesterAgent (${expCtx.length} chars, ${injectedExpIds.length} experience(s), limit=${testMaxExpInjected})`);

  const complaints = orch.complaintWall.getOpenComplaintsFor(ComplaintTarget.SKILL, 'test-report');
  const complaintBlock = complaints.length > 0
    ? `\n\n## Known Issues (Open Complaints)\n${complaints.map(c => `- [${c.severity}] ${c.description}`).join('\n')}`
    : '';
  if (complaints.length > 0) {
    console.log(`[Orchestrator] ⚠️  ${complaints.length} open complaint(s) injected into TesterAgent context.`);
  }

  // ── Smart Context Selection: classify and pre-filter ────────────────────
  const _testProfile = _getContextProfile(orch);

  // ── External Experience (cold-start fallback, not an adapter plugin) ────
  const testExternalExpBlock = await (async () => {
    if (injectedExpIds.length > 0) return '';
    return externalExperienceFallback(orch, 'test-report', orch._currentRequirement);
  })();

  // ── Plugin-driven adapter blocks ───────────────────────────────────────
  const pluginRegistry = orch._pluginRegistry || (orch.services && orch.services.has('pluginRegistry') ? orch.services.resolve('pluginRegistry') : null);
  let testPluginBlocks = [];
  if (pluginRegistry) {
    const pluginResult = await pluginRegistry.collectPluginBlocks(orch, 'TESTER', _testProfile, 20);
    testPluginBlocks = pluginResult.blocks;
    // P2 fix: Record Tool Search stats for observability
    if (orch.obs && typeof orch.obs.recordToolSearchStats === 'function') {
      orch.obs.recordToolSearchStats('TESTER', {
        totalPlugins: pluginResult.blocks.length + (pluginResult.skippedByKeyword?.length || 0),
        skippedByKeyword: pluginResult.skippedByKeyword || [],
        executedCount: pluginResult.blocks.filter(b => b.content && b.content.length > 0).length,
      });
    }
  }

  // L3: Structured session memory (cross-session continuity)
  let testerSessionMemoryCtx = '';
  try {
    const { TaskHistory } = require('./task-history');
    const taskHistory = new TaskHistory();
    testerSessionMemoryCtx = taskHistory.getSessionMemoryBlock(3);
    if (testerSessionMemoryCtx) {
      console.log(`[Orchestrator] 🧠 Session Memory injected for TesterAgent (${testerSessionMemoryCtx.length} chars)`);
    }
  } catch (memErr) {
    if (process.env.DEBUG) {
      console.warn(`[TesterContext] Session memory loading failed: ${memErr.message}`);
    }
  }

  // Real execution results block
  let realExecutionBlock = '';

  // ── ADR-Task Linkage: Requirement Coverage Check ───────────────────────
  // Extracted from stageCtx.PLAN.meta.adrTaskLinkage (populated by storePlannerContext).
  // Gives TesterAgent a structured requirement→ADR→task traceability map so it can
  // verify that every requirement has at least one corresponding implementation task.
  let reqCoverageBlock = '';
  if (orch.stageCtx) {
    try {
      const planCtx = orch.stageCtx.get(WorkflowState.PLAN);
      const adrTaskLinkage = planCtx?.meta?.adrTaskLinkage;
      if (adrTaskLinkage && Array.isArray(adrTaskLinkage.links) && adrTaskLinkage.links.length > 0) {
        const parts = ['\n\n## 🔗 Requirement Coverage Map (from PLAN stage — ADR-Task Linkage)'];
        parts.push('> **Coverage Check Instruction**: For EACH row below, verify that the listed task(s) have been implemented.');
        parts.push('> If any requirement has NO corresponding implementation evidence in the code diff, flag it as ❌ UNCOVERED.');
        parts.push('');
        parts.push('| Requirement | ADR | Tasks | Coverage Status |');
        parts.push('|-------------|-----|-------|----------------|');
        for (const link of adrTaskLinkage.links) {
          const taskList = link.taskIds.join(', ');
          parts.push(`| \`${link.reqId}\` | \`${link.adrId}\` | ${taskList} | ⬜ verify |`);
        }
        parts.push('');
        parts.push('> **Output requirement**: In your test report JSON block, include a `requirementCoverage` array:');
        parts.push('> `[{ "reqId": "REQ-1", "status": "covered"|"uncovered"|"partial", "evidence": "..." }]`');
        reqCoverageBlock = parts.join('\n');
        console.log(`[Orchestrator] 🔗 Requirement coverage map injected into TesterAgent (${adrTaskLinkage.links.length} req-ADR-task link(s), ${reqCoverageBlock.length} chars).`);
      }
    } catch (err) {
      if (process.env.DEBUG) console.warn(`[TesterContext] ADR-Task Linkage loading failed: ${err.message}`);
    }
  }

  // ── Execution Plan injection for test coverage traceability ────────────
  // Prefer structured tasks from stageCtx.PLAN.meta.tasks (populated by storePlannerContext).
  // This avoids regex-parsing the Markdown prose which is fragile to format changes
  // (e.g. Chinese headings like "#### 任务 T-001" would silently break the old regex).
  // Falls back to regex-based extraction only when structured data is unavailable.
  let testExecutionPlanBlock = '';
  if (orch.stageCtx) {
    const planCtx = orch.stageCtx.get(WorkflowState.PLAN);
    const structuredTasks = planCtx?.meta?.tasks;

    if (structuredTasks && Array.isArray(structuredTasks) && structuredTasks.length > 0) {
      // ── Path A: structured data from JSON block ────────────────────────
      const tasksWithAC = structuredTasks.filter(t => t.acceptanceCriteria && t.acceptanceCriteria.length > 0);
      const taskLines = structuredTasks.map(t => {
        const acLines = (t.acceptanceCriteria || []).length > 0
          ? `  Acceptance Criteria:\n${t.acceptanceCriteria.map(ac => `    - [ ] ${ac}`).join('\n')}`
          : `  Acceptance Criteria: (none specified)`;
        const filesLine = t.files && t.files.length > 0
          ? `  Files: ${t.files.join(', ')}`
          : '';
        return [`**${t.id}**: ${t.title}`, filesLine, acLines].filter(Boolean).join('\n');
      }).join('\n\n');

      testExecutionPlanBlock = `\n\n## 📋 Execution Plan Tasks (from Planner — structured JSON)
> Use these tasks and their acceptance criteria to verify test coverage.
> Each acceptance criterion is a testable assertion — verify it has corresponding test evidence.

${taskLines.slice(0, 4000)}${taskLines.length > 4000 ? '\n... (truncated)' : ''}`;
      console.log(`[Orchestrator] 📋 Structured tasks injected into TesterAgent (${structuredTasks.length} task(s), ${tasksWithAC.length} with AC, ${testExecutionPlanBlock.length} chars).`);

    } else if (planCtx && planCtx.artifacts && planCtx.artifacts.length > 0) {
      // ── Path B: fallback — regex parse Markdown prose ─────────────────
      // Used only when the Planner produced an old-format JSON block without
      // structured tasks (e.g. tasks field is a number, not an array).
      try {
        const planPath = planCtx.artifacts[0];
        if (fs.existsSync(planPath)) {
          const planContent = fs.readFileSync(planPath, 'utf-8');
          // Match both English "#### Task T-" and Chinese "#### 任务 T-" headings
          const taskPattern = /#### (?:Task |任务 )?T-[\s\S]*?(?=#### (?:Task |任务 )?T-|### \d|$)/g;
          const tasks = planContent.match(taskPattern) || [];
          if (tasks.length > 0) {
            const compactTasks = tasks.map(t => {
              const lines = t.split('\n');
              const relevant = lines.filter(l =>
                /^#### (?:Task |任务 )?T-/.test(l) ||
                /Acceptance Criteria|验收标准/i.test(l) ||
                /^\s*- \[/.test(l) ||
                /Files to create|需要创建|需要修改/i.test(l) ||
                /^\s*- /.test(l)
              );
              return relevant.join('\n');
            }).join('\n\n');
            testExecutionPlanBlock = `\n\n## 📋 Execution Plan Tasks (from Planner — Markdown fallback)
> Use these tasks and their acceptance criteria to verify test coverage.
> Each task's acceptance criteria should be treated as a testable assertion.

${compactTasks.slice(0, 4000)}${compactTasks.length > 4000 ? '\n... (truncated)' : ''}`;
            console.log(`[Orchestrator] 📋 Execution plan tasks injected into TesterAgent via Markdown fallback (${tasks.length} task(s), ${testExecutionPlanBlock.length} chars).`);
          }
        }
      } catch (planErr) {
        console.warn(`[Orchestrator] ⚠️  Could not inject execution plan into TesterAgent (non-fatal): ${planErr.message}`);
      }
    }
  }
  if (tcExecutionReport && !tcExecutionReport.skipped) {
    const manualCases = (tcExecutionReport.caseResults || []).filter(tc => tc._executionStatus === 'MANUAL_PENDING');
    const manualBlock = manualCases.length > 0
      ? `\n\n## 🖐️ Manual Test Cases (Cannot Be Automated)\n` +
        `> The following ${manualCases.length} case(s) require **human verification**.\n` +
        `> **TesterAgent instruction**: Include a "Manual Verification Checklist" section in your test report\n` +
        `> for each case below. Mark each as ✅ PASS, ❌ FAIL, or ⏳ PENDING based on manual review.\n\n` +
        manualCases.map((tc, i) =>
          `### ${i + 1}. ${tc.case_id}: ${tc.title || ''}\n` +
          (tc.precondition ? `- **Precondition**: ${tc.precondition}\n` : '') +
          (tc.steps && tc.steps.length > 0
            ? `- **Steps**:\n${tc.steps.map((s, j) => `  ${j + 1}. ${s}`).join('\n')}\n`
            : '') +
          (tc.expected ? `- **Expected**: ${tc.expected}\n` : '') +
          `- **Status**: 🖐️ MANUAL_PENDING – awaiting human tester confirmation`
        ).join('\n\n')
      : '';
    realExecutionBlock =
      `\n\n## ⚡ Real Test Execution Results (Pre-Run)\n` +
      `> The following results come from ACTUALLY RUNNING the generated test script.\n` +
      `> Use these as ground truth – do NOT contradict them in your report.\n\n` +
      `${tcExecutionReport.summaryMd}` +
      manualBlock;
    console.log(`[Orchestrator] ⚡ Real execution results injected into TesterAgent context (${tcExecutionReport.total} cases, ${manualCases.length} manual).`);
  }

  // ── Token Budget Guard (TESTER) ────────────────────────────────────────
  const testLabelledBlocks = [
    { label: 'JSON Instruction',      content: jsonInstruction,                                          priority: BLOCK_PRIORITY.JSON_INSTRUCTION, _order: 0 },
    { label: 'AGENTS.md',             content: agentsMd ? `## Project Context (AGENTS.md)\n${agentsMd}` : '', priority: BLOCK_PRIORITY.AGENTS_MD, _order: 1 },
    { label: 'Upstream Context',      content: upstreamCtx,                                              priority: BLOCK_PRIORITY.UPSTREAM_CTX, _order: 2 },
    { label: 'Execution Plan Tasks',  content: testExecutionPlanBlock,                                   priority: BLOCK_PRIORITY.UPSTREAM_CTX + 1, _order: 3 },
    { label: 'Req Coverage Map',      content: reqCoverageBlock,                                         priority: BLOCK_PRIORITY.UPSTREAM_CTX + 2, _order: 3.5 },
    { label: 'Experience',            content: expCtx,                                                   priority: BLOCK_PRIORITY.EXPERIENCE, _order: 4 },
    { label: 'External Experience',   content: testExternalExpBlock,                                     priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE, _order: 5 },
    { label: 'Session Memory',        content: testerSessionMemoryCtx,                                   priority: BLOCK_PRIORITY.EXTERNAL_EXPERIENCE - 1, _order: 5.5 },
    { label: 'Complaints',            content: complaintBlock,                                           priority: BLOCK_PRIORITY.COMPLAINTS, _order: 6 },
    { label: 'Real Execution',        content: realExecutionBlock,                                       priority: BLOCK_PRIORITY.REAL_EXECUTION, _order: 7 },
    // Dynamic adapter blocks from plugin registry (starts at _order: 20)
    ...testPluginBlocks,
  ];

  // ── Smart Context: apply priority adjustments before budget guard ──────
  const testAdjustedBlocks = _testProfile ? _testProfile.applyToBlocks(testLabelledBlocks) : testLabelledBlocks;

  // Pass telemetry to _applyTokenBudget for lifecycle tracking
  const testTelemetry = orch._adapterTelemetry || null;
    const { assembled: testAssembled, stats: testStats } = await _applyTokenBudget(testAdjustedBlocks, undefined, {
    telemetry: testTelemetry,
    stage: 'TESTER',
    profile: _testProfile || null,
  });
  if (testStats.dropped.length > 0 || testStats.truncated.length > 0) {
    console.log(`[Orchestrator] 📊 TESTER token budget: ${testStats.total} chars, dropped=[${testStats.dropped.join(',')}], truncated=[${testStats.truncated.join(',')}]`);
  }
  if (testStats.compressionSaved > 0) {
    console.log(`[Orchestrator] 🗜️  TESTER compression: saved ${testStats.compressionSaved} chars.`);
  }
  // P1 fix: Record ToolResultFilter stats for cross-session analysis
  if (orch.obs && testStats.preFilterSaved > 0) {
    orch.obs.recordToolResultFilterStats('TESTER', {
      preFilterSaved: testStats.preFilterSaved,
      filteredLabels: testStats.preFilterLabels || [],
    });
  }

  // A-3 Architecture Fix: Return a proper struct instead of new String() hack.
  // See architect-context-builder.js for the full rationale.
  return { content: testAssembled, injectedExpIds };
}

module.exports = {
  buildTesterUpstreamCtx,
  buildTesterContextBlock,
};
