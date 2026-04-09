#!/usr/bin/env node
/**
 * Stop Guard Hook (Hook Enhancement 1.2)
 *
 * Registered in .claude/settings.json as a Stop hook.
 * When Claude Code's LLM is about to finish its response, this script runs.
 *
 * Behavior:
 *   - If workflow-status.json has activeWorkflow (not expired):
 *     → Exit code 1: BLOCK the stop
 *     → Print the next stage command to stderr (Claude Code re-injects as context)
 *   - Otherwise:
 *     → Exit code 0: Allow the stop
 *
 * Why exit code 1?
 *   Claude Code Stop hook: exit 0 = allow stop, non-zero = block stop.
 *   stderr output is injected back into the conversation as a user message.
 *
 * Industry reference:
 *   - ralph-loop: Uses Stop Hook to force Claude Code to continue iterating
 *   - WorkFlowAgent: Uses this to ensure all 7 stages complete before stopping
 *
 * Reference: https://docs.anthropic.com/claude-code/hooks
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── Find workflow-status.json ─────────────────────────────────────────────────
const candidatePaths = [
  path.join(process.cwd(), 'output', 'workflow-status.json'),
  path.join(process.cwd(), '..', 'output', 'workflow-status.json'),
];

let statusData = null;
for (const p of candidatePaths) {
  try {
    if (fs.existsSync(p)) {
      statusData = JSON.parse(fs.readFileSync(p, 'utf-8'));
      break;
    }
  } catch { /* continue */ }
}

// No status file or no activeWorkflow → allow stop
if (!statusData || !statusData.activeWorkflow) {
  process.exit(0);
}

const active = statusData.activeWorkflow;

// Check TTL expiry (2 hours default)
const expired = active.ttlExpiry && new Date(active.ttlExpiry) < new Date();
if (expired) {
  // Expired — allow stop, clean up stale state
  try {
    delete statusData.activeWorkflow;
    const statusPath = candidatePaths.find(p => fs.existsSync(p));
    if (statusPath) {
      fs.writeFileSync(statusPath, JSON.stringify(statusData, null, 2), 'utf-8');
    }
  } catch { /* non-fatal */ }
  process.exit(0);
}

// ── Workflow is active and not expired — block the stop ──────────────────────
const stageOrder = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
const completedStages = active.completedStages || [];
const currentStage = active.currentStage || 'UNKNOWN';
const remainingStages = stageOrder.filter(s => !completedStages.includes(s));
const nextStage = remainingStages[0] || currentStage;
const session = active.session || 'unknown';

// Determine the bridge.js path — try to find it relative to this script
const scriptDir = __dirname;
const bridgePath = path.join(scriptDir, '..', 'tools', 'ide-workflow-bridge.js');
const bridgePathResolved = fs.existsSync(bridgePath)
  ? bridgePath.replace(/\\/g, '/')
  : 'workflow/tools/ide-workflow-bridge.js';

// Output to stderr — Claude Code injects this back as context
process.stderr.write([
  ``,
  `╔══════════════════════════════════════════════════════════════╗`,
  `║  ⛔ WORKFLOW INCOMPLETE — CANNOT STOP                       ║`,
  `╠══════════════════════════════════════════════════════════════╣`,
  `║  Completed: ${completedStages.length}/7 stages                                    ║`,
  `║  Next: ${nextStage.padEnd(10)} (${stageOrder.indexOf(nextStage) + 1}/7)                                ║`,
  `║  Remaining: ${remainingStages.join(' → ').slice(0, 44).padEnd(44)} ║`,
  `╚══════════════════════════════════════════════════════════════╝`,
  ``,
  `You MUST continue the workflow. Execute this command NOW:`,
  `  node ${bridgePathResolved} workflow-stage --stage ${nextStage} --session ${session} --project-root . --requirement "${(active.requirement || '').slice(0, 100)}"`,
  ``,
  `DO NOT stop. DO NOT output a summary. Execute the command above.`,
  ``,
].join('\n'));

// Exit non-zero to block the stop
process.exit(1);
