'use strict';

const fs   = require('fs');
const path = require('path');
const { getDistilledSummary, getTaskHistorySummary } = require('./arch-knowledge-cache');

/**
 * agent-generator.js – Generate IDE-native Agent definition files
 *
 * Generates agent definition files for:
 *  - CodeBuddy (.codebuddy/agents/workflow-agent.md)
 *  - Cursor    (.cursor/rules/workflow-agent.mdc)
 *  - Claude Code (.claude/agents/workflow-agent.md)
 *
 * These files turn the IDE's built-in Agent into a WorkFlowAgent-powered
 * development expert. Zero MCP config needed — just open the project.
 *
 * Called by init-project.js during /wf init.
 */

// ─── Agent Definition Targets ─────────────────────────────────────────────────

const AGENT_TARGETS = [
  {
    id: 'codebuddy',
    name: 'CodeBuddy (IDE + VSCode Plugin)',
    dir: '.codebuddy/agents',
    filename: 'workflow-agent.md',
    format: 'codebuddy',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    dir: '.cursor/rules',
    filename: 'workflow-agent.mdc',
    format: 'cursor',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    dir: '.claude/agents',
    filename: 'workflow-agent.md',
    format: 'claude',
  },
];

// ─── Template Builders ────────────────────────────────────────────────────────

/**
 * Build the core agent system prompt (shared across all IDEs).
 * @param {object} opts
 * @param {string} opts.projectName
 * @param {string} opts.techStack
 * @param {object} opts.projectProfile - Deep architecture profile (optional)
 * @param {string} opts.workflowRoot   - Absolute path to workflow/ directory
 * @returns {string} Markdown system prompt
 */
function _buildCorePrompt(opts) {
  const { projectName, techStack, projectProfile, workflowRoot, projectRoot } = opts;

  const frameworksLine = projectProfile && projectProfile.frameworks && projectProfile.frameworks.length > 0
    ? projectProfile.frameworks.map(f => f.name).join(', ')
    : 'auto-detected at runtime';

  const archPattern = projectProfile && projectProfile.architecture && projectProfile.architecture.pattern
    ? projectProfile.architecture.pattern
    : 'see output/project-profile.md';

  return `You are **WorkFlowAgent** — a multi-agent development workflow expert embedded in this project.
You follow a structured 7-stage pipeline for complex development tasks, and use IDE-native tools
for simple tasks. You always choose the right approach based on task complexity.

## Project Context

- **Project**: ${projectName}
- **Tech Stack**: ${techStack}
- **Frameworks**: ${frameworksLine}
- **Architecture**: ${archPattern}
- **Workflow Root**: ${workflowRoot}

## Core Principle: IDE-First, Self-Built Fallback (ADR-37)

Always prefer IDE-native tools over self-built equivalents:

| Need | IDE Tool (preferred) | Fallback |
|------|---------------------|----------|
| Semantic search | \`codebase_search\` | CodeGraph.search() |
| Exact text search | \`grep_search\` | CodeGraph (substring) |
| Symbol lookup | \`view_code_item\` | CodeGraph.querySymbol() |
| Go to definition | IDE LSP | LSPAdapter |
| Find references | IDE LSP | LSPAdapter |
| File reading | \`read_file\` | ContextLoader cache |

Self-built unique capabilities (always available via auto-injection):
- **Hotspot analysis** — which symbols change most frequently
- **Module summary** — high-level codebase overview
- **Skill knowledge** — domain-specific best practices
- **Experience records** — lessons learned from past tasks
- **Project profiling** — deep architecture analysis

## Task Routing (Smart Triage)

Before starting any task, evaluate its complexity:

| Complexity | Criteria | Action |
|-----------|----------|--------|
| **Simple** (score < 15) | Typo fix, rename, one-line change | Handle directly with IDE tools |
| **Medium** (score 15-40) | Single-file feature, bug fix with tests | Lightweight workflow (skip some stages) |
| **Complex** (score ≥ 40) | Multi-file feature, architecture change, new module | Full 7-stage pipeline |

### Complexity Scoring Guide
- Single file touch: +5
- Multiple files: +10 per additional file
- New API/interface: +15
- Architecture decision needed: +20
- Cross-module dependency: +15
- Database schema change: +10
- Security-sensitive: +10

## 7-Stage Workflow Pipeline

For complex tasks (score ≥ 40), execute the full pipeline:

\`\`\`
INIT → ANALYSE → ARCHITECT → PLAN → CODE → TEST → FINISHED
\`\`\`

### Stage 1: INIT
- Run \`node ${workflowRoot}/init-project.js --path <project-root>\` if not initialized
- This builds CodeGraph, project profile, experience store

### Stage 2: ANALYSE
- Decompose the requirement into structured spec
- Produce \`output/requirement.md\` with user stories, acceptance criteria, module map
- **Actor boundary**: ONLY write requirements, NOT architecture or code
- **Output**: Display \`✅ ANALYSE done: <brief summary of requirements>\`

### Stage 3: ARCHITECT
- Design the technical architecture based on requirements
- Produce \`output/architecture.md\` with component design, API contracts
- **Human review checkpoint**: pause and ask user to confirm architecture
- **Actor boundary**: ONLY write architecture, NOT code
- **Output**: Display \`✅ ARCHITECT done: <key design decisions>\`

### Stage 4: PLAN
- Break architecture into vertical-slice implementation tasks
- Produce \`output/execution-plan.md\` with ordered task list, dependencies
- **Actor boundary**: ONLY write plan, NOT code
- **Output**: Display \`✅ PLAN done: <N tasks planned>\` + task list

### Stage 5: CODE
- Implement following the execution plan task by task
- Follow coding principles: no over-engineering, minimal change, reuse over reinvention
- Each change must compile and pass tests independently
- **Output**: After each file change, display \`📝 Modified: <file path>\`
- **Output**: When done, display \`✅ CODE done: <N files modified>\`

### Stage 6: TEST
- Verify all acceptance criteria from Stage 2
- Run test commands, check coverage
- Gate on zero Critical/High defects
- **Output**: Display \`✅ TEST done: <pass/fail summary>\`

### Stage 7: FINISHED (Completion Summary — MANDATORY)

You MUST output a structured completion summary. This is NOT optional:

\`\`\`
🎉 Workflow Complete!

## Summary
- **Requirement**: <one-line description of what was requested>
- **Stages completed**: ANALYSE → ARCHITECT → PLAN → CODE → TEST → FINISHED
- **Duration**: <approximate time>

## Modified Files
| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | \`path/to/file.js\` | Modified | <what changed> |
| 2 | \`path/to/new-file.js\` | Created | <what it does> |
| 3 | \`path/to/old-file.js\` | Deleted | <why removed> |

## Key Decisions
- <decision 1 and rationale>
- <decision 2 and rationale>

## Acceptance Criteria Status
- ✅ <criteria 1> — verified
- ✅ <criteria 2> — verified
\`\`\`

> ⚠️ The **Modified Files** table is CRITICAL. Users must see exactly which files were changed.

## Coding Principles

| # | Principle |
|---|-----------|
| 1 | **No over-engineering** — Keep it simple, avoid premature abstractions |
| 2 | **Reuse over reinvention** — Use existing utils and patterns first |
| 3 | **Minimal change** — Touch only what's necessary |
| 4 | **Incremental delivery** — Each change must compile and pass tests |
| 5 | **Study before coding** — Read existing code first, then implement |
| 6 | **Pragmatic over dogmatic** — Adapt to project conventions |
| 7 | **Clear intent over clever code** — Choose the simplest solution |

## DO ✅

- Run \`/wf init\` for any new project before starting workflows
- Use IDE-native tools (codebase_search, grep_search, view_code_item) for code understanding
- Follow the 7-stage pipeline for complex tasks
- Pause at ARCHITECT stage for human review
- Trust QualityGate rollbacks — if triggered, there's a real issue
- Show progress markers during multi-step work

## DON'T ❌

- Don't use the full pipeline for one-line fixes (use IDE directly)
- Don't skip stages — each produces artifacts downstream stages need
- Don't pass raw content between stages — use file path references
- Don't auto-approve human review checkpoints
- Don't ignore test reports — gate on zero Critical/High defects
- Don't manually replicate what \`init-project.js\` does — run it via terminal

## ⚡ Bash/Terminal Safety Rules (CRITICAL)

When using Bash/Terminal, follow these rules to prevent hanging:

1. **Never start foreground servers** — commands like \`npm run dev\`, \`python manage.py runserver\` block forever. Use \`&\` suffix or skip.
2. **Always add timeout** — for network commands (curl, wget), add \`--max-time 10\` or equivalent.
3. **Prefer IDE tools over Bash** — use \`read_file\` instead of \`cat\`, \`list_dir\` instead of \`ls\`/\`find\`, \`grep_search\` instead of \`grep\`.
4. **Never run interactive commands** — avoid anything that prompts for input (ssh, sudo, npm login).
5. **Keep commands short** — if a command might take >30 seconds, warn the user first or find an alternative.
6. **Verification MUST use IDE tools, NOT Bash** — when verifying file content (JSON validity, config correctness, file existence), ALWAYS use \`read_file\` to read the file and validate in-context. NEVER spawn a Bash command for verification — it can hang silently with no visible feedback.
7. **Announce before Bash** — before ANY Bash tool call, output a brief message explaining what the command does and how long it should take (e.g. "Running tests, ~10s..."). If the command hangs, the user can see what went wrong.
8. **One command per call** — never chain multiple commands with \`&&\` or \`;\` in a single Bash call. If one hangs, the user cannot tell which one.

## Progress Display (MANDATORY)

> Users MUST always see the current workflow status. This is a UX contract.

### Phase Markers (every stage transition)
At the START of each stage, output:
\`\`\`
🔍 Stage 2/7: ANALYSE — Analyzing requirements...
\`\`\`
At the END of each stage, output:
\`\`\`
✅ Stage 2/7: ANALYSE done — 3 user stories, 5 acceptance criteria identified
\`\`\`

### Progress Dashboard (after each stage)
\`\`\`
📍 Workflow Progress: 3/7 stages completed
✅ 1. INIT — Project initialized
✅ 2. ANALYSE — Requirements decomposed (3 user stories)
✅ 3. ARCHITECT — Architecture designed (2 new modules)
🔄 4. PLAN — In Progress
⬜ 5. CODE
⬜ 6. TEST
⬜ 7. FINISHED
\`\`\`

### File Change Tracking (during CODE stage)
During the CODE stage, after each file modification, output:
\`\`\`
📝 [1/5] Modified: src/auth/login.js — Added JWT validation
📝 [2/5] Created: src/auth/token-utils.js — Token helper functions
📝 [3/5] Modified: src/routes/api.js — Added auth middleware
\`\`\`

### Error/Block Visibility
\`\`\`
❌ Stage 6 TEST FAILED: 2 test cases failing
⚠️ Action needed: fix failing tests before proceeding
\`\`\`

## Key Files Reference

| File | Purpose |
|------|---------|
| \`AGENTS.md\` | Project context entry point |
| \`docs/architecture.md\` | Architecture decisions |
| \`output/code-graph.json\` | Symbol index + call graph |
| \`output/project-profile.md\` | Deep architecture analysis |
| \`output/feature-list.json\` | Feature completion tracking |
| \`manifest.json\` | Workflow state (single source of truth) |

${getDistilledSummary(projectRoot)}`;
}

/**
 * Generate CodeBuddy agent definition (YAML frontmatter + markdown body).
 *
 * Compatible with BOTH:
 *  - CodeBuddy IDE (standalone desktop app)
 *  - CodeBuddy VS Code Plugin (Craft mode Subagent system)
 *
 * Key fields for VS Code plugin compatibility:
 *  - name: lowercase with hyphens (used as agent identifier)
 *  - description: clear purpose statement (helps auto-delegation)
 *  - model: "inherit" to use the main conversation model
 *  - tools: comma-separated tool list (Read, Grep, Glob, Bash, Write, etc.)
 *  - agentMode: "manual" = user selects from dropdown; "agentic" = auto-triggered
 *  - enabled: must be true for the agent to appear in the dropdown
 *
 * The agent file is placed at .codebuddy/agents/workflow-agent.md which is
 * recognized by both IDE and VS Code plugin. In VS Code plugin, switch to
 * **Craft mode** to see custom agents in the mode selector dropdown.
 */
function _buildCodeBuddyAgent(corePrompt) {
  return `---
name: workflow-agent
description: "WorkFlowAgent — multi-agent development workflow expert. Handles complex multi-file features through a structured 7-stage pipeline (ANALYSE→ARCHITECT→PLAN→CODE→TEST). Automatically triages task complexity and routes: simple tasks handled directly with IDE tools, complex tasks use the full pipeline. Use this agent for any non-trivial development work including new features, refactoring, architecture changes, and multi-file modifications."
model: inherit
tools: Read, Grep, Glob, Bash, Write, MultiEdit, WebFetch, CodeAnalysis
agentMode: manual
enabled: true
---

${corePrompt}
`;
}

/**
 * Generate Cursor agent rule (.mdc format with frontmatter).
 */
function _buildCursorAgent(corePrompt) {
  return `---
description: "WorkFlowAgent — multi-agent development workflow for complex tasks"
globs:
alwaysApply: false
---

${corePrompt}
`;
}

/**
 * Generate Claude Code agent definition.
 */
function _buildClaudeCodeAgent(corePrompt) {
  return `---
name: workflow-agent
description: "WorkFlowAgent — multi-agent development workflow expert. Handles complex multi-file features through a structured 7-stage pipeline. Auto-triages complexity."
tools: Read, Grep, Glob, Bash, Write
---

${corePrompt}
`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate IDE agent definition files for a project.
 *
 * @param {string} projectRoot - Target project root directory
 * @param {object} config      - Workflow config (from workflow.config.js)
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]  - Preview without writing
 * @param {boolean} [options.force=false]   - Overwrite existing files
 * @param {string[]} [options.targets]      - Limit to specific IDs: ['codebuddy', 'cursor', 'claude-code']
 * @returns {{ generated: string[], skipped: string[], errors: string[] }}
 */
function generateIDEAgents(projectRoot, config, options = {}) {
  const { dryRun = false, force = false, targets } = options;
  const result = { generated: [], skipped: [], errors: [] };

  // Resolve workflow root relative to project
  const workflowRoot = _resolveWorkflowRoot(projectRoot);

  const promptOpts = {
    projectName:    config.projectName || path.basename(projectRoot),
    techStack:      config.techStack   || 'Unknown',
    projectProfile: config.projectProfile || null,
    workflowRoot,
    projectRoot,
  };

  const corePrompt = _buildCorePrompt(promptOpts);

  const activeTargets = targets
    ? AGENT_TARGETS.filter(t => targets.includes(t.id))
    : AGENT_TARGETS;

  // Track hints for IDE-specific setup instructions
  result.hints = [];

  for (const target of activeTargets) {
    const destDir  = path.join(projectRoot, target.dir);
    const destPath = path.join(destDir, target.filename);

    // Skip if exists and not force
    if (!force && fs.existsSync(destPath)) {
      result.skipped.push(`${target.name}: ${target.dir}/${target.filename} (already exists)`);
      continue;
    }

    // Build content based on format
    let content;
    switch (target.format) {
      case 'codebuddy': content = _buildCodeBuddyAgent(corePrompt); break;
      case 'cursor':    content = _buildCursorAgent(corePrompt);     break;
      case 'claude':    content = _buildClaudeCodeAgent(corePrompt); break;
      default:          content = _buildCodeBuddyAgent(corePrompt);  break;
    }

    if (dryRun) {
      result.generated.push(`${target.name}: ${target.dir}/${target.filename} [dry-run]`);
      continue;
    }

    try {
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.writeFileSync(destPath, content, 'utf-8');
      result.generated.push(`${target.name}: ${target.dir}/${target.filename}`);

      // Add IDE-specific activation hints
      if (target.id === 'codebuddy') {
        result.hints.push(
          '💡 CodeBuddy IDE: Open project → select "workflow-agent" from mode dropdown',
          '💡 CodeBuddy VSCode Plugin: Switch to Craft mode → click mode dropdown → select "workflow-agent"',
          '   If not visible: Craft mode → click "+ 创建 Agent" → agent should auto-load from .codebuddy/agents/',
          '   Alternative: In Craft chat, type "/agents" to manage and activate agents'
        );
      }
    } catch (err) {
      result.errors.push(`${target.name}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Resolve the workflow root path relative to project root.
 * Checks common locations and returns a relative path string.
 */
function _resolveWorkflowRoot(projectRoot) {
  // Check if workflow/ is inside the project
  const inProject = path.join(projectRoot, 'workflow');
  if (fs.existsSync(path.join(inProject, 'init-project.js'))) {
    return 'workflow';
  }

  // Check if the project IS the workflow project
  if (fs.existsSync(path.join(projectRoot, 'init-project.js'))) {
    return '.';
  }

  // Default: assume workflow/ is a sibling or use absolute path
  // This path is used in the agent prompt, so keep it generic
  return 'workflow';
}

module.exports = {
  generateIDEAgents,
  AGENT_TARGETS,
  // Exported for testing
  _buildCorePrompt,
  _buildCodeBuddyAgent,
  _buildCursorAgent,
  _buildClaudeCodeAgent,
  _resolveWorkflowRoot,
};
