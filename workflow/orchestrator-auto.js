/**
 * Orchestrator Auto-Dispatch – runAuto, decomposition parsing, failure recording
 *
 * Extracted from workflow/index.js (ADR-33 Phase 4) to reduce the main
 * Orchestrator class size. These methods are mixed into Orchestrator.prototype.
 *
 * @module orchestrator-auto
 */

'use strict';

const fs = require('fs');
const { PATHS } = require('./core/constants');

// ─── Auto-Dispatch Methods ──────────────────────────────────────────────────

/**
 * Smart entry point: automatically decides whether to run sequentially (run())
 * or in parallel task-based mode (runTaskBased()) based on LLM analysis.
 *
 * @param {string} rawRequirement - The user's raw requirement text
 * @param {number} [concurrency=3] - Max parallel workers
 */
async function runAuto(rawRequirement, concurrency = 3) {
  console.log(`\n[Orchestrator] 🤖 Auto-dispatch: analysing requirement for task decomposition...`);

  // Pre-load AGENTS.md for decomposition context
  let agentsMdForDecomposition = this._agentsMdContent;
  if (!agentsMdForDecomposition) {
    try {
      agentsMdForDecomposition = fs.existsSync(PATHS.AGENTS_MD)
        ? fs.readFileSync(PATHS.AGENTS_MD, 'utf-8')
        : '';
      if (agentsMdForDecomposition) {
        console.log(`[Orchestrator] 📋 AGENTS.md pre-loaded for task decomposition (${agentsMdForDecomposition.length} chars).`);
      }
    } catch (err) {
      console.warn(`[Orchestrator] ⚠️  Could not pre-load AGENTS.md for task decomposition: ${err.message}`);
      agentsMdForDecomposition = '';
    }
  }

  const decompositionPrompt = [
    `You are a **Task Decomposition Analyst**. Analyse the following software requirement and decide whether it should be executed as:`,
    `  A) A single sequential workflow (ANALYSE → ARCHITECT → PLAN → CODE → TEST)`,
    `  B) Multiple parallel tasks with dependencies`,
    ``,
    agentsMdForDecomposition
      ? `## Project Context (AGENTS.md)\n${agentsMdForDecomposition.slice(0, 3000)}${agentsMdForDecomposition.length > 3000 ? '\n... (truncated for decomposition)' : ''}`
      : '',
    agentsMdForDecomposition ? `` : '',
    `## Requirement`,
    rawRequirement,
    ``,
    `## Decision Rules`,
    `- Choose **sequential** if the requirement is a single cohesive feature that naturally flows through analysis → architecture → implementation → testing.`,
    `- Choose **parallel** if the requirement contains 2 or more clearly separable sub-features or modules that can be designed/implemented independently (e.g. "Build a user module AND a payment module AND an email service").`,
    `- Parallel tasks MUST have explicit dependency relationships (e.g. "implement X" depends on "design X interface").`,
    `- Minimum 3 tasks, maximum 12 tasks for parallel mode.`,
    ``,
    `## Output Format`,
    `Respond with EXACTLY one of the following formats (no extra text):`,
    ``,
    `**If sequential:**`,
    `SEQUENTIAL`,
    ``,
    `**If parallel:**`,
    `PARALLEL`,
    `TASKS:`,
    `- <task title> [deps: none]`,
    `- <task title> [deps: <dep title 1>, <dep title 2>]`,
    `- <task title> [deps: <dep title 1>]`,
    ``,
    `Rules for TASKS:`,
    `- Each line starts with "- "`,
    `- Title must be concise (≤60 chars)`,
    `- [deps: none] means no dependencies`,
    `- [deps: X, Y] means this task depends on tasks titled X and Y`,
    `- Dependency titles must exactly match a previous task title`,
    `- Tasks must be ordered so dependencies always appear before dependents`,
  ].join('\n');

  let decompositionResult = null;
  try {
    const DECOMPOSITION_TIMEOUT_MS = 30_000;
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LLM decomposition timed out after ${DECOMPOSITION_TIMEOUT_MS}ms`)), DECOMPOSITION_TIMEOUT_MS)
    );
    const llmResponse = await Promise.race([this._rawLlmCall(decompositionPrompt), timeoutPromise]);
    decompositionResult = this._parseDecompositionResponse(llmResponse, rawRequirement);
  } catch (err) {
    console.warn(`[Orchestrator] ⚠️  Task decomposition LLM call failed: ${err.message}. Falling back to sequential.`);
  }

  if (!decompositionResult || decompositionResult.mode === 'sequential') {
    console.log(`[Orchestrator] ▶️  Auto-dispatch → sequential mode (run())`);
    return this.run(rawRequirement);
  }

  const { taskDefs } = decompositionResult;

  // Self-validation
  const validationResult = this._validateDecomposition(taskDefs, rawRequirement);
  if (!validationResult.valid) {
    console.warn(`[Orchestrator] ⚠️  Task decomposition self-validation FAILED:`);
    for (const issue of validationResult.issues) {
      console.warn(`  • ${issue}`);
    }
    console.log(`[Orchestrator] ▶️  Falling back to sequential mode due to decomposition quality issues.`);
    if (this.stateMachine && this.stateMachine.manifest) {
      this.stateMachine.recordRisk('medium', `[DecompositionValidation] Parallel plan rejected: ${validationResult.issues.join('; ')}`);
    }
    return this.run(rawRequirement);
  }
  if (validationResult.warnings.length > 0) {
    console.log(`[Orchestrator] ⚠️  Decomposition validation warnings:`);
    for (const w of validationResult.warnings) {
      console.warn(`  • ${w}`);
      if (this.stateMachine && this.stateMachine.manifest) {
        this.stateMachine.recordRisk('low', `[DecompositionValidation] ${w}`);
      }
    }
  }
  console.log(`[Orchestrator] ✅ Task decomposition validated: ${taskDefs.length} tasks, coverage=${validationResult.coverageRate}%`);

  console.log(`[Orchestrator] ⚡ Auto-dispatch → parallel task-based mode (${taskDefs.length} tasks, concurrency=${concurrency})`);
  console.log(`[Orchestrator] 📋 Auto-generated task plan:`);
  for (const t of taskDefs) {
    const depStr = t.deps.length > 0 ? ` (deps: ${t.deps.join(', ')})` : '';
    console.log(`  [${t.id}] ${t.title}${depStr}`);
  }

  return this.runTaskBased(rawRequirement, taskDefs, concurrency);
}

/**
 * Parses the LLM decomposition response into a structured result.
 *
 * @param {string} llmResponse
 * @param {string} rawRequirement
 * @returns {{ mode: string, taskDefs?: object[] }}
 */
function _parseDecompositionResponse(llmResponse, rawRequirement) {
  if (!llmResponse || !llmResponse.trim()) {
    console.warn(`[Orchestrator] Empty decomposition response. Falling back to sequential.`);
    return { mode: 'sequential' };
  }

  const text = llmResponse.trim();

  if (/^SEQUENTIAL/m.test(text)) {
    console.log(`[Orchestrator] 📊 Decomposition result: SEQUENTIAL`);
    return { mode: 'sequential' };
  }

  if (!/^PARALLEL/m.test(text)) {
    console.warn(`[Orchestrator] Decomposition response did not contain SEQUENTIAL or PARALLEL. Falling back to sequential.`);
    console.warn(`[Orchestrator] Response preview: "${text.slice(0, 200)}"`);
    return { mode: 'sequential' };
  }

  const tasksBlockMatch = text.match(/^TASKS:\s*\n([\s\S]+)/m);
  if (!tasksBlockMatch) {
    console.warn(`[Orchestrator] PARALLEL declared but no TASKS: block found. Falling back to sequential.`);
    return { mode: 'sequential' };
  }

  const taskLines = tasksBlockMatch[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '));

  if (taskLines.length < 2) {
    console.warn(`[Orchestrator] PARALLEL mode requires ≥2 tasks, got ${taskLines.length}. Falling back to sequential.`);
    return { mode: 'sequential' };
  }

  if (taskLines.length > 12) {
    console.warn(`[Orchestrator] PARALLEL mode has ${taskLines.length} tasks (max 12). Truncating to 12.`);
    const keptTitles = new Set(
      taskLines.slice(0, 12).map(l => l.slice(2).replace(/\[deps:[^\]]*\]/i, '').trim())
    );
    const droppedTitles = new Set(
      taskLines.slice(12).map(l => l.slice(2).replace(/\[deps:[^\]]*\]/i, '').trim())
    );
    taskLines.splice(12);
    for (const line of taskLines) {
      const depsMatch = line.match(/\[deps:\s*([^\]]+)\]/i);
      if (depsMatch && depsMatch[1].trim().toLowerCase() !== 'none') {
        const depTitles = depsMatch[1].split(',').map(d => d.trim());
        for (const depTitle of depTitles) {
          if (droppedTitles.has(depTitle)) {
            console.warn(`[Orchestrator] ⚠️  P2-3: Task depends on truncated task "${depTitle}". Dependency will be dropped.`);
          }
        }
      }
    }
  }

  const titleToId = {};
  const parsedTasks = [];

  for (let i = 0; i < taskLines.length; i++) {
    const line = taskLines[i].slice(2).trim();
    const depsMatch = line.match(/\[deps:\s*([^\]]+)\]/i);
    const title = line.replace(/\[deps:[^\]]*\]/i, '').trim();
    const id = `task-${i + 1}`;

    if (!title) {
      console.warn(`[Orchestrator] Empty task title on line ${i + 1}. Skipping.`);
      continue;
    }

    titleToId[title] = id;
    parsedTasks.push({ id, title, rawDeps: depsMatch ? depsMatch[1] : 'none' });
  }

  if (parsedTasks.length < 2) {
    console.warn(`[Orchestrator] After parsing, only ${parsedTasks.length} valid task(s). Falling back to sequential.`);
    return { mode: 'sequential' };
  }

  const taskDefs = parsedTasks.map(t => {
    let deps = [];
    if (t.rawDeps && t.rawDeps.trim().toLowerCase() !== 'none') {
      deps = t.rawDeps.split(',').map(d => {
        const depTitle = d.trim();
        const depId = titleToId[depTitle];
        if (!depId) {
          console.warn(`[Orchestrator] Dependency "${depTitle}" not found in task list. Skipping.`);
        }
        return depId;
      }).filter(Boolean);
    }
    return { id: t.id, title: t.title, deps };
  });

  console.log(`[Orchestrator] 📊 Decomposition result: PARALLEL (${taskDefs.length} tasks)`);
  return { mode: 'parallel', taskDefs };
}

/**
 * Records a workflow failure as a NEGATIVE experience for self-evolution.
 *
 * @param {Error} err
 * @param {string} rawRequirement
 */
function _recordWorkflowFailureExperience(err, rawRequirement) {
  const currentState = this.stateMachine ? this.stateMachine.getState() : 'UNKNOWN';

  // 1. Record as NEGATIVE experience
  if (this.experienceStore && typeof this.experienceStore.recordWithContentCheck === 'function') {
    try {
      const { ContractViolationError } = require('./core/file-ref-bus');
      const isContractViolation = err instanceof ContractViolationError || err.name === 'ContractViolationError';

      const title = isContractViolation
        ? `Contract violation in ${currentState}: ${err.contractReason || err.message.slice(0, 80)}`
        : `Workflow failure in ${currentState}: ${err.message.slice(0, 80)}`;

      const content = isContractViolation
        ? [
            `**Stage**: ${currentState}`,
            `**Error**: ContractViolationError`,
            `**Sender**: ${err.senderRole || 'unknown'}`,
            `**Receiver**: ${err.receiverRole || 'unknown'}`,
            `**Tier**: ${err.tier || 'unknown'}`,
            `**Reason**: ${err.contractReason || err.message}`,
            `**File**: ${err.filePath || 'unknown'}`,
            `**Requirement excerpt**: ${(rawRequirement || '').slice(0, 200)}`,
            `> _Source: Workflow error catch block (auto-captured for self-evolution)_`,
          ].join('\n')
        : [
            `**Stage**: ${currentState}`,
            `**Error**: ${err.name || 'Error'}`,
            `**Message**: ${err.message}`,
            `**Requirement excerpt**: ${(rawRequirement || '').slice(0, 200)}`,
            `> _Source: Workflow error catch block (auto-captured for self-evolution)_`,
          ].join('\n');

      const tags = ['workflow-failure', 'auto-captured', `stage:${currentState.toLowerCase()}`];
      if (isContractViolation) {
        tags.push('contract-violation', `tier:${err.tier || 'unknown'}`);
      }

      this.experienceStore.recordWithContentCheck({
        type: 'negative',
        category: 'workflow_process',
        title,
        content,
        tags,
        ttlDays: 180,
      });

      console.log(`[Orchestrator] 📝 Workflow failure recorded to ExperienceStore for self-evolution.`);
    } catch (expErr) {
      console.warn(`[Orchestrator] ⚠️  Failed to record failure experience (non-fatal): ${expErr.message}`);
    }
  }

  // 2. Record as SelfReflection issue
  if (this._selfReflection && typeof this._selfReflection.recordIssue === 'function') {
    try {
      this._selfReflection.recordIssue({
        severity: 'high',
        title: `Workflow failure in ${currentState}: ${err.message.slice(0, 100)}`,
        description: `The workflow threw an unrecoverable error during the ${currentState} stage. ` +
          `Error: ${err.message}. ` +
          `This may indicate a systemic issue if it recurs across sessions.`,
        source: `orchestrator.run.catch`,
        patternKey: `workflow-failure:${currentState}:${err.name || 'Error'}`,
        rootCause: err.name === 'ContractViolationError'
          ? `Agent output failed content contract validation (tier: ${err.tier})`
          : null,
        suggestedFix: err.name === 'ContractViolationError'
          ? `Review the ${err.senderRole} Agent's prompt to ensure it produces output matching the ${err.receiverRole} contract.`
          : `Investigate the ${currentState} stage for the root cause of: ${err.message.slice(0, 100)}`,
      });

      console.log(`[Orchestrator] 🔍 Workflow failure recorded to SelfReflection for pattern detection.`);
    } catch (srErr) {
      console.warn(`[Orchestrator] ⚠️  Failed to record SelfReflection issue (non-fatal): ${srErr.message}`);
    }
  }
}

module.exports = {
  runAuto,
  _parseDecompositionResponse,
  _recordWorkflowFailureExperience,
};
