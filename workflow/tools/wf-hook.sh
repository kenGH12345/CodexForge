#!/usr/bin/env bash
# wf-hook.sh — Claude Code UserPromptSubmit Hook for WorkFlowAgent
#
# Triggered by Claude Code BEFORE the LLM processes the user's message.
# Purpose: When user sends a /wf message, automatically:
#   1. Execute input-received (Shell-layer, 100% reliable, no LLM involvement)
#   2. Inject a confirmation text into the prompt (tells LLM: "already logged, go to workflow-stage")
#
# Industry reference: Claude Code UserPromptSubmit Hook
#   - stdin: JSON {"prompt": "<user message>", "session_id": "<id>"}
#   - stdout: text to inject into the LLM's context (appended to prompt)
#   - exit 0: allow the message to proceed
#   - exit 1: BLOCK the message (DO NOT use this — would break user experience)
#
# Cross-project usage:
#   This hook can be called from ANY project's .claude/settings.json.
#   WF_AGENT_ROOT = WorkFlowAgent installation directory (where bridge.js lives)
#   TARGET_PROJECT_ROOT = $PWD = the project currently open in Claude Code
#   These two are the SAME when called from WorkFlowAgent itself,
#   and DIFFERENT when called from another project.
#
# CRITICAL: Always exit 0. Never exit 1. Failures must be silent.

set -euo pipefail

# Read stdin JSON (Claude Code passes hook data via stdin)
HOOK_INPUT=$(cat)

# Extract prompt text using jq (fallback to empty string if jq not available)
if command -v jq &>/dev/null; then
  PROMPT=$(echo "$HOOK_INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")
  SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
else
  # Fallback: simple grep-based extraction (no jq dependency)
  PROMPT=$(echo "$HOOK_INPUT" | grep -o '"prompt":"[^"]*"' | sed 's/"prompt":"//;s/"//' 2>/dev/null || echo "")
  SESSION_ID=$(echo "$HOOK_INPUT" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"//' 2>/dev/null || echo "")
fi

# Check if this is a /wf message
if ! echo "$PROMPT" | grep -q '^/wf'; then
  # Not a /wf message — exit silently, no injection
  exit 0
fi

# Generate session ID if not provided
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="wf-$(date +%Y%m%d%H%M%S)-hook"
fi

# ─── Path Resolution ──────────────────────────────────────────────────────────
# WF_AGENT_ROOT: WorkFlowAgent installation directory (where bridge.js lives)
# This is always two levels up from this script's location (workflow/tools/ → root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WF_AGENT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# TARGET_PROJECT_ROOT: The project currently open in Claude Code
# Claude Code executes hooks with $PWD = the project's root directory.
# UserPromptSubmit stdin only provides "prompt" field (no "cwd" field).
# $PWD is the only reliable source for the target project directory.
TARGET_PROJECT_ROOT="$PWD"
# ─────────────────────────────────────────────────────────────────────────────

# Extract /wf message text (trim leading/trailing whitespace)
WF_INPUT=$(echo "$PROMPT" | sed 's/^[[:space:]]*//' | head -c 500)

# Execute input-received (Shell-layer enforcement — 100% trigger rate)
# This runs BEFORE the LLM processes the message, so it's guaranteed to execute.
# Errors are suppressed (non-fatal) — the user's message must always proceed.
# Note: bridge.js is located via WF_AGENT_ROOT; --project-root uses TARGET_PROJECT_ROOT
node "$WF_AGENT_ROOT/workflow/tools/ide-workflow-bridge.js" input-received \
  --user-input "$WF_INPUT" \
  --input-type "requirement" \
  --decision "走完整工作流" \
  --session "$SESSION_ID" \
  --project-root "$TARGET_PROJECT_ROOT" \
  2>/dev/null || true

# Inject confirmation text into LLM prompt
# This tells the LLM: "input-received already executed, your next step is workflow-stage"
# The LLM sees this as part of the conversation context.
# Note: --project-root . is correct here — IDE Agent terminal cwd IS the target project root
# Note: bridge.js path uses WF_AGENT_ROOT (absolute) so it works from any project directory
BRIDGE_PATH="$WF_AGENT_ROOT/workflow/tools/ide-workflow-bridge.js"
cat <<EOF

---
[AUTO-LOGGED by wf-hook.sh] /wf input received and logged to workflow-progress.log.
session=$SESSION_ID
MANDATORY NEXT ACTION: Your FIRST terminal call MUST be:
  node $BRIDGE_PATH workflow-stage --stage ANALYSE --session $SESSION_ID --project-root . --requirement "<your requirement here>"
DO NOT call input-received again (already done). DO NOT answer before calling workflow-stage.
---
EOF

exit 0
