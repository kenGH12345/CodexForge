'use strict';

const fs   = require('fs');
const path = require('path');
const { getDistilledSummary, getTaskHistorySummary } = require('./arch-knowledge-cache');
const { generateIDEToolGuidance } = require('./ide-detection');
const { SELF_REPORT_INSTRUCTION } = require('./agent-self-report');
const { WF_PIPELINE_LABEL, WF_ROUTING_HINT } = require('./workflow-routing-policy');

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

// ─── Prompt Version (bump this when _buildCorePrompt changes) ────────────────
// Used to detect stale agent files in already-initialised projects.
const PROMPT_VERSION = '2.15.0'; // 2.15.0: +comment-conciseness (CODE stage token efficiency, Coding Principle #10, STYLE-002 check)

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
    id: 'codebuddy-rule',
    name: 'CodeBuddy Rule (auto-loaded by Craft mode)',
    dir: '.codebuddy/rules',
    filename: 'workflow-trigger.mdc',
    format: 'codebuddy-rule',
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

  // ── Dynamic sections (same as buildAgentPrompt's Phase 5) ──────────────
  let ideToolGuidanceSection = '';
  try {
    const guidance = generateIDEToolGuidance();
    if (guidance) {
      ideToolGuidanceSection = `\n\n${guidance}\n\n> 💡 **Implementation Note**: \`CodeGraph.querySymbol()\` automatically uses IDE's \`view_code_item\` when available (ADR-37), falling back to regex parsing only on failure.`;
    }
  } catch (_) { /* Non-fatal */ }

  let runtimeEnvSection = '';
  try {
    const osType = process.platform;
    const shellHint = osType === 'win32' ? 'PowerShell' : (process.env.SHELL || '/bin/bash');
    const envLines = [
      `### Runtime Environment`,
      `- **OS**: ${osType === 'win32' ? 'Windows' : osType === 'darwin' ? 'macOS' : 'Linux'}`,
      `- **Shell**: ${shellHint}`,
    ];
    if (osType === 'win32') {
      envLines.push(
        `- **CRITICAL Shell Rules**:`,
        `  - Do NOT use \`&&\` to chain commands (PowerShell does not support it). Use \`;\` or separate commands.`,
        `  - Use \`Get-ChildItem\` instead of \`ls\`, \`Select-String\` instead of \`grep\`.`,
        `  - Use backslash \`\\\` for path separators, or forward slash \`/\` (both work in PowerShell).`,
        `  - Use \`$env:VAR\` instead of \`$VAR\` for environment variables.`,
      );
    }
    runtimeEnvSection = '\n\n' + envLines.join('\n');
  } catch (_) { /* Non-fatal */ }

  let selfReflectionSection = '';
  try {
    const { SelfReflectionEngine } = require('./self-reflection-engine');
    const reflectionEngine = new SelfReflectionEngine({
      outputDir: path.join(projectRoot, 'output'),
    });
    const summary = reflectionEngine.getReflectionSummary(1500);
    if (summary) {
      selfReflectionSection = `\n\n### Known Issues (Self-Reflection)\n${summary}`;
    }
  } catch (_) { /* Non-fatal: self-reflection is optional */ }

  let experienceSection = '';
  try {
    const expPath = path.join(projectRoot, '.workflow', 'experiences.json');
    if (fs.existsSync(expPath)) {
      const expData = JSON.parse(fs.readFileSync(expPath, 'utf-8'));
      const recentExps = (Array.isArray(expData) ? expData : (expData.experiences || []))
        .slice(-5)
        .filter(e => e && e.summary);
      if (recentExps.length > 0) {
        const expLines = ['### 📚 Recent Experience Records (auto-loaded)'];
        for (const exp of recentExps) {
          const icon = exp.type === 'POSITIVE' ? '✅' : exp.type === 'NEGATIVE' ? '⚠️' : '📝';
          expLines.push(`- ${icon} **${exp.category || 'general'}**: ${exp.summary}`);
          if (exp.lesson) expLines.push(`  → Lesson: ${exp.lesson}`);
        }
        experienceSection = '\n\n' + expLines.join('\n');
      }
    }
  } catch (_) { /* Non-fatal */ }

  // Delegate to template module for the actual prompt content
  const { buildAgentPromptTemplate } = require('./agent-prompt-template');
  return buildAgentPromptTemplate({
    WF_PIPELINE_LABEL,
    WF_ROUTING_HINT,
    SELF_REPORT_INSTRUCTION,
    projectName,
    techStack,
    frameworksLine,
    archPattern,
    workflowRoot,
    projectRoot,
    ideToolGuidanceSection,
    runtimeEnvSection,
    selfReflectionSection,
    experienceSection,
    distilledSummary: getDistilledSummary(projectRoot),
    taskHistorySummary: getTaskHistorySummary(projectRoot),
  });
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
description: "WorkFlowAgent — multi-agent development workflow expert. /wf always runs the full 7-stage pipeline (ANALYSE→ARCHITECT→PLAN→CODE→TEST), with RequestTriage used as advisory diagnostics only. Use this agent for non-trivial development work including new features, refactoring, architecture changes, and multi-file modifications."
model: inherit
tools: Read, Grep, Glob, Bash, Write, MultiEdit, WebFetch, CodeAnalysis
agentMode: manual
enabled: true
---

${corePrompt}
`;
}

/**
 * Generate CodeBuddy Rule (.mdc format) — auto-loaded by Craft mode.
 *
 * Unlike .codebuddy/agents/ (which requires manual selection from the dropdown),
 * .codebuddy/rules/*.mdc files are AUTOMATICALLY injected into every Craft
 * conversation. This is the CodeBuddy equivalent of Cursor's .cursor/rules/.
 *
 * We generate a compact rule that:
 *  1. Recognises /wf commands and triggers the workflow
 *  2. Contains the full workflow execution protocol
 *  3. Does NOT duplicate the entire agent prompt (too large for a rule)
 */
function _buildCodeBuddyRule(corePrompt) {
  return `---
description: "WorkFlowAgent workflow trigger — recognises /wf commands and executes the 7-stage development pipeline"
globs:
alwaysApply: true
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
description: "WorkFlowAgent — multi-agent development workflow expert. /wf always runs the full 7-stage pipeline, and RequestTriage is advisory-only for diagnostics."
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

  // Resolve workflow root — supports remote reference via config.workflowSource
  const workflowRoot = _resolveWorkflowRoot(projectRoot, config);

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
      case 'codebuddy':      content = _buildCodeBuddyAgent(corePrompt); break;
      case 'codebuddy-rule': content = _buildCodeBuddyRule(corePrompt); break;
      case 'cursor':         content = _buildCursorAgent(corePrompt);     break;
      case 'claude':         content = _buildClaudeCodeAgent(corePrompt); break;
      default:               content = _buildCodeBuddyAgent(corePrompt);  break;
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
 * Resolve the workflow root path for use in IDE Agent prompts.
 *
 * Resolution order:
 *   1. config.workflowSource — explicit remote reference (absolute path to workflow/ dir)
 *   2. <projectRoot>/workflow/ — local copy inside the project
 *   3. <projectRoot> itself — when the project IS the workflow project
 *   4. Fallback: 'workflow' (legacy default)
 *
 * Remote Reference Mode:
 *   When workflowSource is set in workflow.config.js, the target project does NOT
 *   need a local copy of the workflow/ directory. All Bridge commands in the generated
 *   IDE Agent prompt will use the absolute path to the remote workflow installation.
 *   This eliminates version fragmentation and disk waste across multiple projects.
 *
 * @param {string} projectRoot - Target project root directory
 * @param {object} [config]    - Workflow config (may contain workflowSource)
 * @returns {string} Path string for use in IDE Agent prompt (relative or absolute)
 */
function _resolveWorkflowRoot(projectRoot, config) {
  // Priority 1: Explicit remote reference from config
  if (config && config.workflowSource) {
    const source = config.workflowSource;
    const resolved = path.isAbsolute(source) ? source : path.resolve(projectRoot, source);

    // Validate the remote path actually contains workflow files
    if (fs.existsSync(path.join(resolved, 'init-project.js')) ||
        fs.existsSync(path.join(resolved, 'tools', 'ide-workflow-bridge.js'))) {
      // Use forward slashes for cross-platform prompt compatibility
      return resolved.replace(/\\/g, '/');
    }

    // workflowSource points to the parent of workflow/ (e.g. the WorkFlowAgent project root)
    const nested = path.join(resolved, 'workflow');
    if (fs.existsSync(path.join(nested, 'init-project.js'))) {
      return nested.replace(/\\/g, '/');
    }

    // Config says workflowSource but path is invalid — warn and fall through
    console.warn(`[AgentGenerator] workflowSource path not found: ${resolved}. Falling back to local detection.`);
  }

  // Priority 2: workflow/ is inside the project (local copy)
  const inProject = path.join(projectRoot, 'workflow');
  if (fs.existsSync(path.join(inProject, 'init-project.js'))) {
    return 'workflow';
  }

  // Priority 3: the project IS the workflow project
  if (fs.existsSync(path.join(projectRoot, 'init-project.js'))) {
    return '.';
  }

  // Priority 4: fallback (legacy) — assume workflow/ exists locally
  return 'workflow';
}

module.exports = {
  generateIDEAgents,
  AGENT_TARGETS,
  PROMPT_VERSION,
  // Exported for testing
  _buildCorePrompt,
  _buildCodeBuddyAgent,
  _buildCodeBuddyRule,
  _buildCursorAgent,
  _buildClaudeCodeAgent,
  _resolveWorkflowRoot,
};
