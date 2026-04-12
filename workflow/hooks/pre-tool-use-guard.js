#!/usr/bin/env node
/**
 * PreToolUse Guard Hook
 *
 * Registered in .claude/settings.json as a PreToolUse hook for Bash tool.
 * When Claude Code is about to execute a Bash command, this script runs first.
 *
 * Behavior:
 *   - If workflow-status.json has pendingRetry for the current stage:
 *     → Exit code 2: BLOCK the tool call
 *     → Print the socratic questions to stderr (Claude Code shows this to LLM)
 *   - Otherwise:
 *     → Exit code 0: Allow the tool call to proceed
 *
 * Why exit code 2 (not 1)?
 *   Claude Code PreToolUse: exit 0 = allow, exit 1 = warn but allow, exit 2 = block
 *   We need hard block, so exit 2.
 *
 * How Claude Code passes tool input:
 *   The hook receives tool_input as JSON on stdin.
 *   tool_input.command contains the bash command string.
 *
 * Reference: https://docs.anthropic.com/claude-code/hooks
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Read tool input from stdin ────────────────────────────────────────────────
let toolInput = {};
try {
  // Cross-platform stdin read (works on Windows, Linux, macOS)
  // Claude Code passes tool_input as JSON on stdin
  let stdinData = '';
  if (process.stdin.isTTY) {
    // No stdin piped — allow through (e.g. direct invocation for testing)
    process.exit(0);
  }
  // Read synchronously using fd 0
  const buf = Buffer.alloc(65536);
  let bytesRead = 0;
  try {
    bytesRead = require('fs').readSync(0, buf, 0, buf.length, null);
  } catch {
    process.exit(0);
  }
  stdinData = buf.slice(0, bytesRead).toString('utf-8').trim();
  if (stdinData) {
    toolInput = JSON.parse(stdinData);
  }
} catch {
  // stdin not available or not JSON — allow through
  process.exit(0);
}

const bashCommand = toolInput.command || toolInput.tool_input?.command || '';

// ── Only intercept workflow-stage calls ──────────────────────────────────────
// We don't want to block ALL bash commands — only the ones that would skip
// the retry. Specifically: if pendingRetry exists, block any bash command
// that is NOT a workflow-stage call for the pending stage.
//
// Logic:
//   - If command contains "workflow-stage" AND matches the pending stage → ALLOW (this is the retry)
//   - If command contains "stage-complete" → BLOCK (trying to complete without retrying)
//   - If pendingRetry exists and command is anything else → BLOCK (trying to move on)
//   - If no pendingRetry → ALLOW

// ── Find workflow-status.json ─────────────────────────────────────────────────
// Try CWD first, then common locations
const candidatePaths = [
  path.join(process.cwd(), 'output', 'workflow-status.json'),
  path.join(process.cwd(), 'workflow', 'output', 'workflow-status.json'),
  path.join(process.cwd(), '..', 'output', 'workflow-status.json'),
];

let statusData = null;
let statusDataPath = null;
for (const p of candidatePaths) {
  try {
    if (fs.existsSync(p)) {
      statusData = JSON.parse(fs.readFileSync(p, 'utf-8'));
      statusDataPath = p;
      break;
    }
  } catch { /* continue */ }
}

// No status file or no pendingRetry → check activeWorkflow guard
if (!statusData || !statusData.pendingRetry) {
  // ── Guard 2: activeWorkflow enforcement (Hook Enhancement 1.1) ──────────
  // If a workflow is actively running, block non-workflow Bash commands
  // to prevent LLM from bypassing the workflow pipeline.
  //
  // Stage-aware policy:
  //   ANALYSE/ARCHITECT/PLAN (analysis stages) → strict: only workflow commands allowed
  //   DEVELOP/TEST/REVIEW/DEPLOY (execution stages) → relaxed: allow all commands
  //
  // Why relaxed for execution stages?
  //   DEVELOP needs `npm test`, `node xxx.js`, etc.
  //   TEST needs to run test suites.
  //   Blocking these would break normal workflow execution.
  const active = statusData?.activeWorkflow;
  if (active) {
    // Check TTL expiry
    const expired = active.ttlExpiry && new Date(active.ttlExpiry) < new Date();
    if (expired) {
      // TTL expired — clean up stale activeWorkflow + pendingRetry (mirrors IDE Bridge cleanup)
      try {
        delete statusData.activeWorkflow;
        if (statusData.pendingRetry) {
          delete statusData.pendingRetry;
        }
        const statusPath = statusDataPath || candidatePaths.find(p => fs.existsSync(p));
        if (statusPath) {
          fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2), 'utf-8');
          process.stderr.write(`[pre-tool-use-guard] 🧹 TTL expired for session=${active.session}. Cleaned up stale activeWorkflow.\n`);
        }
      } catch { /* non-fatal */ }
      process.exit(0);
    }
    const analysisStages = ['ANALYSE', 'ARCHITECT', 'PLAN'];
    const isAnalysisStage = analysisStages.includes(active.currentStage);

    if (isAnalysisStage) {
      // Strict mode: only allow workflow commands (ide-workflow-bridge.js)
      const isWorkflowCommand = bashCommand.includes('ide-workflow-bridge.js');
      if (!isWorkflowCommand) {
          process.stderr.write([
            ``,
            `╔══════════════════════════════════════════════════════════════╗`,
            `║  ⛔ WORKFLOW GUARD — NON-WORKFLOW COMMAND BLOCKED            ║`,
            `╠══════════════════════════════════════════════════════════════╣`,
            `║  Workflow is active (stage: ${active.currentStage.padEnd(10)})                    ║`,
            `║  During analysis stages, only workflow commands are allowed. ║`,
            `╚══════════════════════════════════════════════════════════════╝`,
            ``,
            `Session: ${active.session}`,
            `Current stage: ${active.currentStage} (analysis stage — strict mode)`,
            ``,
            `You MUST use workflow commands only:`,
            `  node workflow/tools/ide-workflow-bridge.js workflow-stage ...`,
            `  node workflow/tools/ide-workflow-bridge.js stage-complete ...`,
            ``,
            `Blocked command: ${bashCommand.slice(0, 120)}${bashCommand.length > 120 ? '...' : ''}`,
            ``,
          ].join('\n'));
          process.exit(2);
        }
      }
      // Execution stages (DEVELOP/TEST/REVIEW/DEPLOY): allow all commands
  }
  process.exit(0);
}

const pending = statusData.pendingRetry;
const pendingStage = pending.stage;

// ── Check if this command is the correct retry ────────────────────────────────
// Allow: workflow-stage command for the pending stage
const isWorkflowStageForPendingStage = bashCommand.includes('workflow-stage') &&
  bashCommand.includes(`--stage ${pendingStage}`);

if (isWorkflowStageForPendingStage) {
  // This is the correct retry command — allow it through
  process.exit(0);
}

// ── Block: pendingRetry exists and this is not the retry command ──────────────
const questions = pending.questions || [];
const blindSpots = pending.blindSpots || [];
const triggerReasons = pending.triggerReasons || [];
const confidence = pending.confidence != null ? Math.round(pending.confidence * 100) + '%' : 'N/A';

// Output to stderr — Claude Code shows this as the "reason for blocking"
process.stderr.write([
  ``,
  `╔══════════════════════════════════════════════════════════════╗`,
  `║  ⛔ WORKFLOW RETRY GUARD — TOOL CALL BLOCKED                 ║`,
  `╚══════════════════════════════════════════════════════════════╝`,
  ``,
  `Stage ${pendingStage} requires retry #${pending.retryCount}/${pending.maxRetry}.`,
  `Confidence was too low: ${confidence}`,
  ``,
  `You CANNOT proceed until you:`,
  `  1. Answer the Socratic questions below in your thinking`,
  `  2. Rewrite the ${pendingStage} artifact with improvements`,
  `  3. Run: node workflow/tools/ide-workflow-bridge.js workflow-stage --stage ${pendingStage} --session ${pending.session} --project-root .`,
  ``,
  ...(triggerReasons.length ? [
    `Trigger reasons:`,
    ...triggerReasons.map(r => `  • ${r}`),
    ``,
  ] : []),
  ...(questions.length ? [
    `Socratic questions you MUST answer:`,
    ...questions.map((q, i) => `  Q${i + 1}: ${q}`),
    ``,
  ] : []),
  ...(blindSpots.length ? [
    `Blind spots detected (root causes):`,
    ...blindSpots.map((b, i) => `  BS${i + 1}: ${b}`),
    ``,
  ] : []),
  `Blocked command was: ${bashCommand.slice(0, 120)}${bashCommand.length > 120 ? '...' : ''}`,
  ``,
].join('\n'));

// Exit code 2 = hard block in Claude Code PreToolUse
process.exit(2);
