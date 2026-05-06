#!/usr/bin/env node
/**
 * init-project.js – One-command project initialisation for the workflow
 *
 * Usage (from any project root):
 *   node workflow/init-project.js
 *   node workflow/init-project.js --path D:\MyProject
 *   node workflow/init-project.js --validate
 *
 * What it does (fully automatic):
 *  1. Detects workflow.config.js; if missing, auto-scans the project to infer
 *     the tech stack and generates the config file automatically
 *  2. Validates the config structure
 *  3. Builds AGENTS.md (global project context)
 *  4. Generates initial experience store from source files
 *  5. Registers all built-in skills
 *  6. Prints a summary of what was imported
 *
 * No manual steps required – just run once and the workflow is ready.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig, getConfigPath, clearConfigCache } = require('./core/config-loader');
const { MemoryManager } = require('./core/memory-manager');
const { SkillEvolutionEngine } = require('./core/skill-evolution');
const { TECH_PROFILES, detectTechStack } = require('./core/tech-profiles');
const { generateConfigFromProfile, _generateInitSh, _generateFeatureListTemplate, _runCliInit } = require('./core/project-generators');
const { _copyProjectTemplates } = require('./core/project-template');
const { ProjectProfiler } = require('./core/project-profiler');
const { generateIDEAgents } = require('./core/agent-generator');
const { LLMInjectionGateway } = require('./core/llm-injection-gateway');

// ─── CLI Args ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { path: null, validate: false, help: false, dryRun: false, linkTo: null, skill: true };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':     case '-h': args.help     = true; break;
      case '--validate': case '-v': args.validate = true; break;
      case '--dry-run':             args.dryRun   = true; break;
      case '--path':     case '-p': args.path = argv[++i]; break;
      case '--link-to':             args.linkTo = argv[++i]; break;
      case '--no-skill':            args.skill    = false; break;
    }
  }
  return args;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateConfig(config, configPath) {
  const errors = [];
  const warnings = [];

  // sourceExtensions and ignoreDirs are now auto-detected at runtime.
  // Only warn if they're explicitly set but look wrong.
  if (config.sourceExtensions && Array.isArray(config.sourceExtensions) && config.sourceExtensions.length === 0) {
    warnings.push('`sourceExtensions` is an empty array. Runtime auto-detection will provide defaults.');
  }
  if (!config.builtinSkills || !Array.isArray(config.builtinSkills)) {
    errors.push('`builtinSkills` must be an array');
  }

  // Warnings (informational)
  if (!config.projectName) {
    warnings.push('`projectName` is not set. Will be auto-detected from directory name.');
  }
  if (!config.techStack) {
    warnings.push('`techStack` is not set. Will be auto-detected from project files.');
  }
  if (!config.classificationRules || config.classificationRules.length === 0) {
    warnings.push('`classificationRules` is empty. Experience generation will use generic fallback rules.');
  }

  // Validate each rule
  if (Array.isArray(config.classificationRules)) {
    config.classificationRules.forEach((rule, i) => {
      if (!rule.ext) errors.push(`Rule[${i}]: missing \`ext\` field`);
      if (typeof rule.test !== 'function') errors.push(`Rule[${i}]: \`test\` must be a function`);
      if (!rule.result) errors.push(`Rule[${i}]: missing \`result\` field`);
    });
  }

  return { errors, warnings };
}

// ─── Experience Sync Helper ───────────────────────────────────────────────────

/**
 * Synchronizes expert experiences from the workflowSource to the target project.
 * This ensures projects using remote workflow reference get the source project's
 * high-quality expert knowledge, particularly for test-related experiences.
 *
 * @param {string} projectRoot    - Target project root (where to sync TO)
 * @param {string} workflowSource - Path to the workflow source directory
 * @returns {{ success: boolean, syncedCount: number, categories: string[], message: string }}
 */
async function _syncExpertExperiences(projectRoot, workflowSource) {
  const path = require('path');
  const fs = require('fs');
  const { ExperienceStore, ExperienceType } = require('./core/experience-store');

  // Resolve source experiences path (workflowSource usually points to workflow/ dir)
  // Try both patterns: workflowSource/.workflow/experiences.json OR workflowSource/../.workflow/experiences.json
  const possibleSourcePaths = [
    path.join(workflowSource, '.workflow', 'experiences.json'),
    path.join(workflowSource, '..', '.workflow', 'experiences.json'),
    path.join(path.resolve(workflowSource, '..'), '.workflow', 'experiences.json'),
  ];

  let sourceExpPath = null;
  for (const p of possibleSourcePaths) {
    if (fs.existsSync(p)) {
      sourceExpPath = p;
      break;
    }
  }

  if (!sourceExpPath) {
    return {
      success: false,
      syncedCount: 0,
      categories: [],
      message: 'No expert experiences found in workflowSource',
    };
  }

  // Load source experiences
  const sourceExps = JSON.parse(fs.readFileSync(sourceExpPath, 'utf-8'));
  const experiences = Array.isArray(sourceExps) ? sourceExps : (sourceExps.experiences || []);

  if (experiences.length === 0) {
    return {
      success: true,
      syncedCount: 0,
      categories: [],
      message: 'No experiences to sync (empty source store)',
    };
  }

  // Filter for high-value expert experiences (not auto-generated code descriptions)
  // Priority categories for cross-project knowledge transfer
  const valuableCategories = [
    'PITFALL',           // Issues to avoid
    'DEBUG_TECHNIQUE',   // Debugging approaches
    'STABLE_PATTERN',    // Proven patterns
    'CRITICAL_FIX',      // Critical fixes
    'LESSON_LEARNED',    // General lessons
    'QUALITY_PRACTICE',  // Quality practices
    'TEST_STRATEGY',     // Testing strategies
    'MODULE_USAGE',      // Framework usage patterns
    'FRAMEWORK_LIMIT',   // Framework limitations
  ];

  const expertExps = experiences.filter(exp => {
    // Must have content or title (real insights, not just code descriptions)
    const hasInsight = exp.content || exp.title;
    // Is in priority category or has high value markers
    const isValuableCategory = valuableCategories.includes(exp.category);
    const hasImportanceMarker = (exp.importance || 0) >= 3 || (exp.confidence || 0) >= 0.8;
    const isNegativeLesson = exp.type === ExperienceType.NEGATIVE;
    // Tag-based detection for test-related experiences
    const hasTestTag = exp.tags && exp.tags.some(t =>
      /test|testing|pytest|jest|unittest|quality|coverage/i.test(t)
    );

    return hasInsight && (isValuableCategory || hasImportanceMarker || isNegativeLesson || hasTestTag);
  });

  if (expertExps.length === 0) {
    return {
      success: true,
      syncedCount: 0,
      categories: [],
      message: 'No valuable expert experiences to sync',
    };
  }

  // Ensure target .workflow directory exists
  const targetDir = path.join(projectRoot, '.workflow');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Create target experience store
  const targetExpPath = path.join(targetDir, 'experiences.json');
  const store = new ExperienceStore(targetExpPath);

  // Load existing target experiences to avoid duplicates
  let existingTitles = new Set();
  try {
    const existingExps = store.getAllExperiences ? store.getAllExperiences() : [];
    for (const exp of existingExps) {
      existingTitles.add(exp.title);
    }
  } catch (_) {
    // Store doesn't exist yet, that's fine
  }

  // Sync expert experiences (adding source marker)
  let syncedCount = 0;
  const syncedCategories = new Set();

  for (const exp of expertExps) {
    // Skip duplicates based on title
    if (existingTitles.has(exp.title)) continue;

    // Mark as sourced from expert knowledge
    const enrichedExp = {
      ...exp,
      tags: [...(exp.tags || []), 'expert-sync', 'from-source-workflow'],
      metadata: {
        ...exp.metadata,
        syncSource: 'workflowSource',
        syncedAt: new Date().toISOString(),
      },
    };

    try {
      store.record(enrichedExp);
      syncedCount++;
      syncedCategories.add(exp.category);
    } catch (err) {
      // Skip if record fails (e.g., deduplication)
    }
  }

  // Save the store
  store.save();

  return {
    success: true,
    syncedCount,
    categories: Array.from(syncedCategories),
    message: `Synced ${syncedCount} expert experience(s) from workflow source`,
  };
}

// ─── Long-running Agent Helpers ───────────────────────────────────────────────

/**
 * Generates an init.sh script tailored to the detected tech stack.
 * This script is run at the start of every Coding Agent session to:
 *  1. Start the development server
 *  2. Run a basic smoke test to verify the environment is healthy
 *
 * @param {object} config      - Workflow config
 * @param {string} projectRoot - Project root path
 * @returns {string} Shell script content
 */

// ─── Link-To: Generate cross-project IDE Agent config ───────────────────────

/**
 * Generates IDE Agent configuration files for a target project to use
 * this WorkFlowAgent installation. Minimal footprint — only creates:
 *   1. <target>/.claude/settings.json  — Claude Code Hook pointing to this WF installation
 *   2. Appends a minimal workflow trigger snippet to <target>/AGENTS.md
 *
 * @param {string} targetPath  - Absolute path to the target project
 * @param {string} wfAgentRoot - Absolute path to this WorkFlowAgent installation
 * @param {object} opts        - { dryRun: boolean }
 */
function runLinkTo(targetPath, wfAgentRoot, opts = {}) {
  const { dryRun = false } = opts;
  const targetRoot = path.resolve(targetPath);
  const wfRoot = path.resolve(wfAgentRoot);

  // Normalize to forward slashes for cross-platform compatibility in shell scripts
  const wfRootPosix = wfRoot.replace(/\\/g, '/');
  const bridgePath = `${wfRootPosix}/workflow/tools/ide-workflow-bridge.js`;
  const hookPath = `${wfRootPosix}/workflow/tools/wf-hook.sh`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  🔗 WorkFlowAgent Link-To`);
  console.log(`  Target Project : ${targetRoot}`);
  console.log(`  WF Agent Root  : ${wfRoot}`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Step 1: Generate .claude/settings.json ──────────────────────────────
  console.log(`[1/2] Generating .claude/settings.json (Claude Code Hook)...`);
  const claudeDir = path.join(targetRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  if (!dryRun) {
    if (fs.existsSync(settingsPath)) {
      console.log(`      ⏭️  .claude/settings.json already exists, skipping`);
      console.log(`      💡 To add hooks manually, add UserPromptSubmit, PreToolUse (Bash), and Stop hooks.`);
    } else {
      try {
        if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
        const preToolUseGuardPath = `${wfRootPosix}/workflow/hooks/pre-tool-use-guard.js`;
        const stopGuardPath = `${wfRootPosix}/workflow/hooks/stop-guard.js`;
        const settings = {
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: `bash ${hookPath}`,
                    timeout: 10000,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: `node ${preToolUseGuardPath}`,
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: `node ${stopGuardPath}`,
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
        };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        console.log(`      ✅ .claude/settings.json written to: ${settingsPath}`);
        console.log(`      📋 Registered hooks: UserPromptSubmit, PreToolUse (Bash), Stop`);
      } catch (err) {
        console.warn(`      ⚠️  .claude/settings.json generation warning: ${err.message}`);
      }
    }
  } else {
    console.log(`      [dry-run] Would write: ${settingsPath}`);
  }
  console.log('');

  // ── Step 2: Append workflow trigger snippet to AGENTS.md ─────────────────
  console.log(`[2/2] Appending workflow trigger snippet to AGENTS.md...`);
  const agentsPath = path.join(targetRoot, 'AGENTS.md');
  const wfMarker = '<!-- WorkFlowAgent trigger snippet — DO NOT REMOVE -->';

  const snippet = `
${wfMarker}
## WorkFlowAgent Integration

> This project is linked to WorkFlowAgent at: \`${wfRoot}\`
> Full workflow rules: \`@${wfRootPosix}/AGENTS.md\`

### /wf Command Trigger

When you receive a message starting with \`/wf\`, execute these two actions IMMEDIATELY:

**ACTION 1** — Output this exact text as your very first line:
\`\`\`
> 🔄 启用wf工作流
\`\`\`

**ACTION 2** — Call terminal immediately:
\`\`\`bash
node ${bridgePath} input-received \\
  --user-input "<exact /wf message text>" \\
  --input-type "requirement" \\
  --decision "走完整工作流" \\
  --session <SESSION_ID> \\
  --project-root .
\`\`\`

Then follow the full 7-stage workflow. For complete rules, read: \`@${wfRootPosix}/AGENTS.md\`

Each stage command uses the WorkFlowAgent bridge:
\`\`\`bash
# Start a stage
node ${bridgePath} workflow-stage --stage <STAGE> --session <SESSION_ID> --project-root . --requirement "<req>"
# Complete a stage
node ${bridgePath} stage-complete --stage <STAGE> --session <SESSION_ID> --project-root . --summary "<summary>"
\`\`\`
`;

  if (!dryRun) {
    try {
      const existingContent = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : '';
      if (existingContent.includes(wfMarker) || existingContent.includes('ide-workflow-bridge.js')) {
        console.log(`      ⏭️  AGENTS.md already contains workflow trigger snippet, skipping`);
      } else {
        fs.appendFileSync(agentsPath, snippet, 'utf-8');
        console.log(`      ✅ Workflow trigger snippet appended to: ${agentsPath}`);
      }
    } catch (err) {
      console.warn(`      ⚠️  AGENTS.md append warning: ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would append workflow trigger snippet to: ${agentsPath}`);
  }
  console.log('');

  console.log(`${'='.repeat(60)}`);
  console.log(`  ✅ Link-To complete!`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n  Next steps:`);
  console.log(`  1. Restart Claude Code in the target project to activate the hook`);
  console.log(`  2. Send a /wf message to verify the workflow triggers correctly`);
  console.log(`  3. For CodeBuddy/Cursor: the AGENTS.md snippet is already active\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── --link-to mode: lightweight cross-project setup ──────────────────────
  if (args.linkTo) {
    const wfAgentRoot = path.resolve(__dirname, '..');
    runLinkTo(args.linkTo, wfAgentRoot, { dryRun: args.dryRun });
    return;
  }

  if (args.help) {
    console.log(`
Usage: node workflow/init-project.js [options]

Options:
  --path, -p <dir>   Project root directory (default: cwd)
  --link-to <dir>    Link another project to use this WorkFlowAgent installation
                     (generates .claude/settings.json + AGENTS.md snippet)
  --validate, -v     Only validate config, do not run initialisation
  --dry-run          Show what would be done without writing any files
  --no-skill         Skip project-specific skill generation in Step 6.5
  --help, -h         Show this help

Examples:
  node workflow/init-project.js                        # Init current project (fully automatic + skill)
  node workflow/init-project.js --path D:\\MyProject   # Init a specific project
  node workflow/init-project.js --no-skill             # Init without auto-generating skill
  node workflow/init-project.js --validate             # Validate config only
  node workflow/init-project.js --link-to D:\\OtherProject  # Link another project

How it works:
  1. If workflow.config.js exists  → use it directly
  2. If not found                  → auto-detect tech stack, generate config, then init
  3. Skill generation uses code-graph file list — no re-scan, language-complete
  No manual steps required.
`);
    process.exit(0);
  }

  const projectRoot = args.path ? path.resolve(args.path) : process.cwd();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  🚀 Workflow Project Initialiser`);
  console.log(`  Project Root: ${projectRoot}`);
  console.log(`\n  📋 Starting 10-step initialization pipeline...`);
  console.log(`${'='.repeat(60)}\n`);

  // ── Auto-detect or load config ────────────────────────────────────────────
  clearConfigCache();
  let config = getConfig(projectRoot, true);
  let configPath = getConfigPath();

  if (configPath) {
    // Config already exists – use it
    console.log(`📋 Config file: ${configPath} (existing)`);

    // Auto-detect remote init: inject workflowSource if not already set
    // and workflow/ is not inside the target project
    if (!config.workflowSource) {
      const localWorkflow = path.join(projectRoot, 'workflow', 'init-project.js');
      const isRemoteInit = !fs.existsSync(localWorkflow) && projectRoot !== path.resolve(__dirname, '..');
      if (isRemoteInit) {
        config.workflowSource = path.resolve(__dirname, '..').replace(/\\/g, '/');
        console.log(`   🔗 Remote mode: workflowSource → ${config.workflowSource}`);
      }
    }

    // Always run tech stack detection to populate runtime fields
    // (projectName, techStack, sourceExtensions, ignoreDirs).
    // These are intentionally NOT stored in workflow.config.js — they are
    // auto-detected fresh every time to stay in sync with the actual project.
    if (!args.dryRun) {
      try {
        const { profile: detectedProfile, projectName: detectedName } = detectTechStack(projectRoot);
        if (detectedProfile && detectedProfile.id !== 'generic') {
          // Inject detected values into in-memory config (do NOT persist to file)
          if (!config.projectName)       config.projectName       = detectedName;
          if (!config.techStack)         config.techStack         = detectedProfile.techStack;
          if (!config.sourceExtensions || config.sourceExtensions.length === 0) {
            config.sourceExtensions = detectedProfile.extensions;
          }
          if (!config.ignoreDirs || config.ignoreDirs.length === 0) {
            config.ignoreDirs = detectedProfile.ignoreDirs;
          }
          console.log(`   🔍 Auto-detected: ${detectedProfile.name}`);
        }
      } catch (detectErr) {
        // Non-fatal: if re-detection fails, just proceed with existing config
        console.warn(`   ℹ️  Tech stack auto-detection skipped: ${detectErr.message}`);
      }
    }
  } else {
    // No config found – auto-detect tech stack and generate one
    console.log(`📋 No workflow.config.js found. Auto-detecting tech stack...\n`);

    const { profile, projectName } = detectTechStack(projectRoot);

    if (!profile) {
      console.warn(`   ⚠️  Could not detect tech stack. Generating a generic config.`);
    } else {
      console.log(`   🔍 Detected: ${profile.name}`);
    }

    if (!args.dryRun) {
      // Detect remote init: if workflow/ is not inside the target project,
      // auto-set workflowSource to point back to this workflow installation.
      const localWorkflow = path.join(projectRoot, 'workflow', 'init-project.js');
      const isRemoteInit = !fs.existsSync(localWorkflow) && projectRoot !== path.resolve(__dirname, '..');
      const workflowSource = isRemoteInit ? path.resolve(__dirname, '..') : null;

      if (workflowSource) {
        console.log(`   🔗 Remote mode: workflowSource → ${workflowSource}`);
      }

      const generatedPath = generateConfigFromProfile(
        projectRoot,
        profile || TECH_PROFILES[TECH_PROFILES.length - 1],  // fallback to last (js)
        projectName,
        { workflowSource }
      );
      console.log(`   ✅ Generated: ${generatedPath}\n`);

      // Reload config from the newly generated file
      clearConfigCache();
      config = getConfig(projectRoot, true);
      configPath = getConfigPath();
    } else {
      console.log(`   [dry-run] Would generate workflow.config.js for: ${profile ? profile.name : 'generic'}\n`);
    }
  }

  if (config.projectName) console.log(`   Project : ${config.projectName}`);
  if (config.techStack)   console.log(`   Stack   : ${config.techStack}`);
  console.log(`   Exts    : ${config.sourceExtensions.join(', ')}`);
  console.log(`   Rules   : ${config.classificationRules.length} classification rules`);
  console.log(`   Skills  : ${config.builtinSkills.length} built-in skills\n`);

  // ── Validate ───────────────────────────────────────────────────────────────
  const { errors, warnings } = validateConfig(config, configPath);

  if (warnings.length > 0) {
    console.log(`⚠️  Warnings (${warnings.length}):`);
    warnings.forEach(w => console.log(`   • ${w}`));
    console.log('');
  }

  if (errors.length > 0) {
    console.error(`❌ Config validation failed (${errors.length} error(s)):`);
    errors.forEach(e => console.error(`   • ${e}`));
    process.exit(1);
  }

  if (args.validate) {
    console.log(`✅ Config is valid.`);
    return;
  }

  // ── Step 0: Copy project-init-template files ──────────────────────────────
  console.log(`[1/10] Copying project knowledge templates...`);
  if (!args.dryRun) {
    _copyProjectTemplates(projectRoot, config);
  } else {
    console.log(`      [dry-run] Would copy project-init-template/ files to: ${projectRoot}\n`);
  }

  // ── Step 0.5: Run CLI init to scaffold project structure ─────────────────
  const detectedProfile = TECH_PROFILES.find(p => p.techStack === config.techStack);
  if (detectedProfile && detectedProfile.cliInitCommand) {
  console.log(`[1.5/10] Running CLI scaffolding for ${detectedProfile.name}...`);
    const cliResult = _runCliInit(projectRoot, detectedProfile, config.projectName || 'app', { dryRun: args.dryRun });
    console.log(`      Command: ${cliResult.command}`);
    if (cliResult.success) {
      console.log(`      ✅ CLI scaffolding complete`);
      if (cliResult.output) console.log(`      ${cliResult.output.split('\n')[0]}`);
    } else {
      console.warn(`      ⚠️  CLI scaffolding skipped: ${cliResult.error}`);
      console.warn(`      💡 You can run the command manually later: ${cliResult.command}`);
    }
    console.log('');
  }

  // ── Step 0.7: Run ProjectProfiler (deep architecture analysis) ────────────
  console.log(`[2/10] Running ProjectProfiler (deep architecture analysis)...`);
  if (!args.dryRun) {
    try {
      // P2-3: Pass user-defined custom detection rules if configured
      const customRules = config.customDetectionRules || {};
      const profiler = new ProjectProfiler(projectRoot, {
        ignoreDirs: config.ignoreDirs,
        customFrameworkRules: customRules.frameworks,
        customDataLayerRules: customRules.dataLayer,
        customTestRules:      customRules.testFrameworks,
      });

      // Attempt LSP-enhanced analysis first; fallback to baseline file-detection
      let projectProfile, profileMdPath;
      try {
        const lspConfig = (config.mcp && config.mcp.lsp && typeof config.mcp.lsp === 'object')
          ? config.mcp.lsp
          : {};
        const result = await profiler.analyzeWithLSP(undefined, lspConfig);
        projectProfile = result.profile;
        profileMdPath = result.mdPath;
      } catch (lspErr) {
        console.log(`      ℹ️  LSP enhancement not available (${lspErr.message}). Using baseline.`);
        const result = profiler.analyzeAndWrite();
        projectProfile = result.profile;
        profileMdPath = result.mdPath;
      }

      // Inject projectProfile into the running config so downstream steps can use it
      config.projectProfile = projectProfile;

      // Persist projectProfile into workflow.config.js so it survives across sessions
      try {
        const configFilePath = configPath || path.join(projectRoot, 'workflow.config.js');
        if (fs.existsSync(configFilePath)) {
          let configContent = fs.readFileSync(configFilePath, 'utf-8');
          // Replace the null placeholder with the actual profile data
          if (configContent.includes('projectProfile: null')) {
            const profileJson = JSON.stringify(projectProfile, null, 4)
              .split('\n').map((line, i) => i === 0 ? line : '  ' + line).join('\n');
            configContent = configContent.replace(
              'projectProfile: null,',
              `projectProfile: ${profileJson},`
            );
            fs.writeFileSync(configFilePath, configContent, 'utf-8');
            console.log(`      ✅ ProjectProfile persisted to workflow.config.js`);
          }
        }
      } catch (persistErr) {
        console.warn(`      ⚠️  Could not persist projectProfile to config: ${persistErr.message}`);
      }

      console.log(`      ✅ ProjectProfiler complete: ${profileMdPath}`);
      if (projectProfile.frameworks.length > 0) {
        console.log(`      📦 Frameworks: ${projectProfile.frameworks.map(f => f.name).join(', ')}`);
      }
      if (projectProfile.architecture.pattern) {
        console.log(`      🏗️  Architecture: ${projectProfile.architecture.pattern}`);
      }
      if (projectProfile.dataLayer.orm.length > 0) {
        console.log(`      💾 Data Layer: ${projectProfile.dataLayer.orm.join(', ')}`);
      }
      if (projectProfile.lspEnhanced) {
        console.log(`      🔬 LSP Enhanced: ${projectProfile.lspServerName} (${projectProfile.lspStats?.symbolsCollected || 0} symbols)`);
      }
    } catch (err) {
      console.warn(`      ⚠️  ProjectProfiler warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would run ProjectProfiler for: ${projectRoot}`);
  }
  console.log('');

  // ── Shared: Initialise LLM router for skill generation & auto-distillation ─
  let cheapLlmCall = null;
  const initLlmInjectionGateway = new LLMInjectionGateway({ outputDir: path.join(projectRoot, 'output') });
  try {
    const { LlmRouter } = require('./core/llm-router');
    // Only create cheapLlmCall if a real LLM is configured
    if (config && config.llm && config.llm.apiKey) {
      const defaultLlm = async (prompt) => {
        try {
          const apiKey = config.llm.apiKey;
          const model = config.llm.model || 'gpt-3.5-turbo';
          const axios = require('axios');
          const requestBody = initLlmInjectionGateway.prepare({
            callSite: 'workflow/init-project.js:defaultLlm.chatCompletions',
            role: 'init-project',
            stage: 'INIT',
            runtimePrompt: {
              model,
              messages: [
                { role: 'system', content: 'You are a technical documentation specialist.' },
                { role: 'user', content: prompt }
              ],
              max_tokens: 12000,
              temperature: 0.3
            },
            metadata: { category: 'external-provider-call', model },
          }).promptToSend;
          const response = await axios.post('https://api.openai.com/v1/chat/completions', requestBody, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 300000
          });
          return response.data.choices[0].message.content;
        } catch (e) {
          console.error('[InitProject] Default LLM call failed:', e.message);
          return '';
        }
      };
      const router = new LlmRouter(defaultLlm);
      cheapLlmCall = async (prompt) => {
        const result = await router.call('system', prompt);
        return typeof result === 'string' ? result : (result && result.content) || '';
      };
      console.error('[InitProject] LLM configured for skill generation');
    } else {
      console.error('[InitProject] No LLM configured (set workflow.config.js llm.apiKey for AI refinement); skill will be rule-based only');
    }
  } catch (err) {
    console.error(`[InitProject] LLM router unavailable: ${err.message}`);
  }

  // ── Step 1: Build AGENTS.md ────────────────────────────────────────────────
  console.log(`[3/10] Building AGENTS.md (global project context)...`);
  if (!args.dryRun) {
    try {
      const memory = new MemoryManager(projectRoot);
      await memory.buildGlobalContext();
      console.log(`      ✅ AGENTS.md written\n`);
    } catch (err) {
      console.warn(`      ⚠️  AGENTS.md build warning: ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would build AGENTS.md at: ${path.join(projectRoot, 'AGENTS.md')}\n`);
  }

  // ── Step 2a: Sync expert experiences from workflowSource (remote reference) ─
  // When using remote workflow reference, also sync the source project's expert knowledge
  if (config.workflowSource) {
    console.log(`[3.5/10] Syncing expert experiences from workflowSource...`);
    if (!args.dryRun) {
      try {
        const syncResult = await _syncExpertExperiences(projectRoot, config.workflowSource);
        if (syncResult.success) {
          console.log(`      ✅ Synced ${syncResult.syncedCount} expert experience(s)`);
          if (syncResult.categories.length > 0) {
            console.log(`         Categories: ${syncResult.categories.join(', ')}`);
          }
        } else {
          console.log(`      ℹ️  ${syncResult.message}`);
        }
      } catch (err) {
        console.warn(`      ⚠️  Expert experience sync warning (non-fatal): ${err.message}`);
      }
    } else {
      const sourceExpPath = path.join(config.workflowSource, '..', '.workflow', 'experiences.json');
      console.log(`      [dry-run] Would sync expert experiences from: ${sourceExpPath}`);
    }
    console.log('');
  }

  // ── Step 2b: Generate local experiences from source files ──────────────────
  console.log(`[4/10] Generating local experience store from source files...`);
  if (!args.dryRun) {
    try {
      // Dynamically require gen-experiences to avoid circular deps
      const genExpPath = path.join(__dirname, 'gen-experiences.js');
      // Run as child process to isolate argv
      const { execSync } = require('child_process');
      const extArg = config.sourceExtensions.join(',');
      const cmd = `node "${genExpPath}" --path "${projectRoot}" --ext "${extArg}" --output "${path.join(projectRoot, '.workflow', 'experiences.json')}"`;
      console.log(`      Running: ${cmd}`);
      execSync(cmd, { stdio: 'inherit' });
      console.log(`      ✅ Local experience store populated`);
    } catch (err) {
      console.warn(`      ⚠️  Local experience generation warning: ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would run: node gen-experiences.js --path "${projectRoot}" --ext "${config.sourceExtensions.join(',')}" --output "${path.join(projectRoot, '.workflow', 'experiences.json')}"`);
  }
  console.log('');

  // ── Step 3: Register built-in skills ──────────────────────────────────────
  console.log(`[4.5/10] Registering built-in skills...`);
  let skillEngine = null;
  if (!args.dryRun) {
    try {
      skillEngine = new SkillEvolutionEngine();
      let registered = 0;
      for (const skill of config.builtinSkills) {
        try {
          skillEngine.registerSkill(skill);
          registered++;
        } catch (err) {
          if (!err.message.includes('already registered') && !err.message.includes('already exists')) {
            console.warn(`      ⚠️  Skill "${skill.name}": ${err.message}`);
          }
        }
      }
      console.log(`      ✅ ${registered} skill(s) registered\n`);
    } catch (err) {
      console.warn(`      ⚠️  Skill registration warning: ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would register ${config.builtinSkills.length} skills:\n`);
    config.builtinSkills.forEach(s => console.log(`        • ${s.name}`));
    console.log('');
  }

  // ── Step 4: Generate init.sh (long-running agent pattern) ─────────────────
  console.log(`[5/10] Generating init.sh (dev server startup script)...`);
  const initShPath = path.join(projectRoot, 'init.sh');
  if (!args.dryRun) {
    if (fs.existsSync(initShPath)) {
      console.log(`      ⏭️  init.sh already exists, skipping\n`);
    } else {
      try {
        const initShContent = _generateInitSh(config, projectRoot);
        fs.writeFileSync(initShPath, initShContent, 'utf-8');
        // Make executable on Unix-like systems
        try { fs.chmodSync(initShPath, 0o755); } catch (_) {}
        console.log(`      ✅ init.sh written to: ${initShPath}\n`);
      } catch (err) {
        console.warn(`      ⚠️  init.sh generation warning: ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${initShPath}\n`);
  }

  // ── Step 5: Generate feature-list.json template ────────────────────────────
  console.log(`[5.5/10] Generating feature-list.json template...`);
  const outputDir = path.join(projectRoot, 'output');
  const featureListPath = path.join(outputDir, 'feature-list.json');
  if (!args.dryRun) {
    if (fs.existsSync(featureListPath)) {
      console.log(`      ⏭️  feature-list.json already exists, skipping\n`);
    } else {
      try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const featureListTemplate = _generateFeatureListTemplate(config);
        fs.writeFileSync(featureListPath, JSON.stringify(featureListTemplate, null, 2), 'utf-8');
        console.log(`      ✅ feature-list.json written to: ${featureListPath}`);
        console.log(`      ℹ️  Edit this file to add your project's features (all start with passes:false)\n`);
      } catch (err) {
        console.warn(`      ⚠️  feature-list.json generation warning: ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${featureListPath}\n`);
  }

  // ── Step 5.5: Generate IDE Agent definitions ────────────────────────────────
  console.log(`[5.6/10] Generating IDE Agent definitions (CodeBuddy, Cursor, Claude Code)...`);
  if (!args.dryRun) {
    try {
      const agentResult = generateIDEAgents(projectRoot, config, { dryRun: false, force: true });
      if (agentResult.generated.length > 0) {
        agentResult.generated.forEach(g => console.log(`      ✅ ${g}`));
      }
      if (agentResult.skipped.length > 0) {
        agentResult.skipped.forEach(s => console.log(`      ⏭️  ${s}`));
      }
      if (agentResult.errors.length > 0) {
        agentResult.errors.forEach(e => console.warn(`      ⚠️  ${e}`));
      }
    } catch (err) {
      console.warn(`      ⚠️  IDE Agent generation warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would generate IDE Agent definitions for: CodeBuddy, Cursor, Claude Code`);
  }
  console.log('');

  // ── Step 5.7: Generate .claude/settings.json (Claude Code Hook) ──────────
  console.log(`[5.7/10] Generating .claude/settings.json (Claude Code Hooks: UserPromptSubmit + PreToolUse + Stop)...`);
  const claudeDir = path.join(projectRoot, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!args.dryRun) {
    if (fs.existsSync(settingsPath)) {
      console.log(`      ⏭️  .claude/settings.json already exists, skipping\n`);
    } else {
      try {
        if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
        // Determine hook paths: use absolute paths to hook scripts
        const wfAgentRoot = path.resolve(__dirname, '..');
        const hookPath = path.join(wfAgentRoot, 'workflow', 'tools', 'wf-hook.sh').replace(/\\/g, '/');
        const preToolUseGuardPath = path.join(wfAgentRoot, 'workflow', 'hooks', 'pre-tool-use-guard.js').replace(/\\/g, '/');
        const stopGuardPath = path.join(wfAgentRoot, 'workflow', 'hooks', 'stop-guard.js').replace(/\\/g, '/');
        const settings = {
          hooks: {
            UserPromptSubmit: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: `bash ${hookPath}`,
                    timeout: 10000,
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  {
                    type: 'command',
                    command: `node ${preToolUseGuardPath}`,
                    timeout: 5000,
                  },
                ],
              },
            ],
            Stop: [
              {
                matcher: '',
                hooks: [
                  {
                    type: 'command',
                    command: `node ${stopGuardPath}`,
                    timeout: 5000,
                  },
                ],
              },
            ],
          },
        };
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        console.log(`      ✅ .claude/settings.json written to: ${settingsPath}\n`);
        console.log(`      📋 Registered hooks: UserPromptSubmit, PreToolUse (Bash), Stop\n`);
      } catch (err) {
        console.warn(`      ⚠️  .claude/settings.json generation warning (non-fatal): ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${settingsPath}\n`);
  }

  // ── Step 6: Build initial code graph ──────────────────────────────────────
  console.log(`[6/10] Building initial code graph (symbol index + call relationships)...`);

  // Phase 1 (T-3): Tree-sitter availability diagnostic
  let tsAvailable = false;
  try {
    const { testAvailability } = require('./core/ast-parsers/tree-sitter-adapter');
    tsAvailable = testAvailability();
    console.log(`      ${tsAvailable ? '✅' : '⚠️'}  AST parser: ${tsAvailable ? 'Tree-sitter active' : 'regex fallback (tree-sitter not installed)'}`);
  } catch (err) {
    console.log(`      ⚠️  AST parser: regex fallback (${err.message})`);
  }

  let codeGraphResult = null;
  let initialCodeGraph = null;
  if (!args.dryRun) {
    try {
      const { CodeGraph } = require('./core/code-graph');
      const outputDir = path.join(projectRoot, 'output');
      const cfg = config || {};
      // Do NOT pass extensions — let CodeGraph use its built-in default
      // which covers ALL supported languages (.js, .ts, .cs, .lua, .go, .py, .dart).
      // This ensures code-graph always scans all code files regardless of config.
      //
      // IMPORTANT: Always use projectRoot as the scan root, not any subdirectory.
      // This prevents the "path anchoring bug" where only a subdirectory gets scanned.
      console.log(`      📂 Scan root: ${projectRoot} (FULL project scan)`);
      if (cfg.codeGraph?.scopeDirs?.length > 0) {
        console.log(`      🔍 Scope limited to: ${cfg.codeGraph.scopeDirs.join(', ')}`);
      }
      const graph = new CodeGraph({
        projectRoot,
        outputDir,
        ignoreDirs:     cfg.ignoreDirs,
        scopeDirs:      cfg.codeGraph?.scopeDirs,
        writeLegacyGraph: cfg.codeGraph?.writeLegacyGraph === true,
      });
      codeGraphResult = await graph.build({ incremental: true, force: true });
      initialCodeGraph = graph;
      const ps = codeGraphResult.parserStats;
      if (ps && ps.astParsed > 0) {
        console.log(`      ✅ Code graph built: ${codeGraphResult.symbolCount} symbols, ${codeGraphResult.edgeCount} call edges, ${codeGraphResult.fileCount} files`);
        console.log(`      🌲 AST parsed: ${ps.astParsed} symbols (${ps.astCoveragePercent}% coverage)`);
      } else {
        console.log(`      ✅ Code graph built: ${codeGraphResult.symbolCount} symbols, ${codeGraphResult.edgeCount} call edges, ${codeGraphResult.fileCount} files`);
        console.log(`      ⚠️  AST parsing: 0 symbols — tree-sitter may not be active for this file set`);
      }
      console.log(`      📄 L1 Index: ${path.join(outputDir, 'code-graph-index.json')}`);
      console.log(`      📁 L2 Shards: ${path.join(outputDir, 'code-graph-shards')}`);
      if (cfg.codeGraph?.writeLegacyGraph === true || ['1', 'true'].includes(String(process.env.WF_CODE_GRAPH_LEGACY || '').toLowerCase())) {
        console.log(`      📄 L3 Legacy full graph: ${path.join(outputDir, 'code-graph.json')}`);
      } else {
        console.log(`      ⏭️  L3 Legacy full graph: disabled by default`);
      }
      console.log(`      📄 Summary: ${path.join(outputDir, 'code-graph.md')}\n`);
    } catch (err) {
      console.warn(`      ⚠️  Code graph generation warning (non-fatal): ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would build code graph for: ${projectRoot}\n`);
  }

  // ── Step 6.5: Generate project-specific skill ──────────────────────────────
  if (args.skill) {
    console.log(`[6.5/10] Generating project-specific skill...`);
    if (!args.dryRun) {
      try {
        const { generate } = require('./core/skill-generator-facade');
        const skillResult = await generate(projectRoot, {
          maxFiles: 1000,
          fileList: codeGraphResult?.fileList,
          force: false,
          skillEvolution: skillEngine,
          cheapLlmCall,
        });
        if (skillResult.error === 'SKILL_EXISTS') {
          console.log(`      ⏭️  Skill already exists, skipping (use --force to regenerate)\n`);
        } else if (skillResult.error) {
          console.warn(`      ⚠️  Skill generation warning: ${skillResult.error}\n`);
        } else {
          console.log(`      ✅ Skill generated: ${skillResult.skillName}`);
          console.log(`      📄 ${skillResult.skillPath}`);
          console.log(`      📊 ${skillResult.signalCount} signals, confidence: ${skillResult.confidenceSummary?.overall?.toFixed(2) || 'N/A'}\n`);

          // ── Skill Refinement Reminder ────────────────────────
          if (skillResult.wasFallback) {
            console.log('');
            console.log('      ┌─────────────────────────────────────────────────────────────────┐');
            console.log('      │  ⚠️  Skill generated as RULE-ONLY (no LLM configured)            │');
            console.log('      │                                                                 │');
            console.log('      │  To get AI-refined skill with architecture insights:            │');
            console.log('      │  1. Set llm.apiKey in workflow.config.js                        │');
            console.log('      │  2. Re-run: node workflow/init-project.js --path <dir>          │');
            console.log('      │                                                                 │');
            console.log('      │  Or manually refine: /wf skill-refine --skill-path <path>       │');
            console.log('      └─────────────────────────────────────────────────────────────────┘');
            console.log('');
          }
        }
      } catch (err) {
        console.warn(`      ⚠️  Skill generation warning (non-fatal): ${err.message}\n`);
      }
    } else {
      console.log(`      [dry-run] Would generate project skill for: ${projectRoot}\n`);
    }
  } else {
    console.log(`[6.5/10] ⏭️  Skill generation skipped (--no-skill)`);
    console.log(`         Re-run without --no-skill later, or call gen-skill manually\n`);
  }

  // ── Step 7: Extract business logic patterns ────────────────────────────────
  console.log(`[7/10] Extracting business logic patterns (entry points, flows, core services)...`);
  if (!args.dryRun) {
    try {
      const { CodeGraph } = require('./core/code-graph');
      const { BusinessLogicExtractor } = require('./core/business-logic-extractor');
      const { detectIDEEnvironment } = require('./core/ide-detection');
      const outputDir = path.join(projectRoot, 'output');
      const cfg = config || {};

      const graph = initialCodeGraph || new CodeGraph({
        projectRoot,
        outputDir,
        ignoreDirs:     cfg.ignoreDirs,
        scopeDirs:      cfg.codeGraph?.scopeDirs,
      });
      if (!initialCodeGraph) graph._loadFromDisk();

      // Detect IDE environment for IDE-First strategy
      const ideDetection = detectIDEEnvironment({ config: cfg });

      // Create extractor with IDE-First strategy
      const extractor = new BusinessLogicExtractor({
        codeGraph: graph,
        projectRoot,
        outputDir,
        ideDetection,
        useIDEFirst: true,  // Follow ADR-37
      });

      // Extract business logic patterns
      const extractResult = await extractor.extract(projectRoot, {
        maxFlows: 20,
        maxDepth: 5,
        minCalledBy: 3,
      });

      // Write output files
      const metrics = extractResult.metrics || {};
      const patterns = extractResult.patterns || {};
      try {
        const jsonPath = path.join(outputDir, 'business-logic.json');
        const mdPath = path.join(outputDir, 'business-logic.md');
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(jsonPath, JSON.stringify(extractResult, null, 2), 'utf-8');
        // Generate markdown summary
        const mdLines = [
          '# Business Logic Analysis',
          '',
          `> Auto-generated by BusinessLogicExtractor. Strategy: ${metrics.strategy || 'unknown'}`,
          '',
          `## Metrics`,
          '',
          `| Metric | Value |`,
          `|--------|-------|`,
          `| Files analyzed | ${metrics.filesAnalyzed || 0} |`,
          `| Symbols found | ${metrics.symbolsFound || 0} |`,
          `| Call relations | ${metrics.callRelations || 0} |`,
          `| Extraction time | ${metrics.extractionMs || 0}ms |`,
          '',
        ];
        if (patterns.entryPoints && patterns.entryPoints.length > 0) {
          mdLines.push(`## Entry Points (${patterns.entryPoints.length})`, '');
          for (const ep of patterns.entryPoints.slice(0, 20)) {
            mdLines.push(`- **${ep.name || ep.id}** (${ep.file || 'unknown'})`);
          }
          mdLines.push('');
        }
        fs.writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');
      } catch (writeErr) {
        console.warn(`      ⚠️  Could not write business logic output: ${writeErr.message}`);
      }

      console.log(`      ✅ Business logic extracted:`);
      console.log(`         • Files analyzed: ${metrics.filesAnalyzed || 0}`);
      console.log(`         • Symbols found: ${metrics.symbolsFound || 0}`);
      console.log(`         • Call relations: ${metrics.callRelations || 0}`);
      console.log(`         • Strategy: ${metrics.strategy || 'unknown'}`);
      console.log(`      📄 JSON: ${path.join(outputDir, 'business-logic.json')}`);
      console.log(`      📄 Summary: ${path.join(outputDir, 'business-logic.md')}\n`);
    } catch (err) {
      console.warn(`      ⚠️  Business logic extraction warning (non-fatal): ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would extract business logic patterns for: ${projectRoot}\n`);
  }

  // ── Step 8: Extract API endpoints ───────────────────────────────────────────
  console.log(`[8/10] Extracting API endpoints (REST routes, handlers, request/response)...`);
  if (!args.dryRun) {
    try {
      const { CodeGraph } = require('./core/code-graph');
      const { APIEndpointExtractor } = require('./core/api-endpoint-extractor');
      const { detectIDEEnvironment } = require('./core/ide-detection');
      const outputDir = path.join(projectRoot, 'output');
      const cfg = config || {};

      const graph = initialCodeGraph || new CodeGraph({
        projectRoot,
        outputDir,
        ignoreDirs:     cfg.ignoreDirs,
        scopeDirs:      cfg.codeGraph?.scopeDirs,
      });
      if (!initialCodeGraph) graph._loadFromDisk();

      // Detect IDE environment for IDE-First strategy
      const ideDetection = detectIDEEnvironment({ config: cfg });

      // Create extractor with IDE-First strategy
      const apiExtractor = new APIEndpointExtractor({
        codeGraph: graph,
        projectRoot,
        outputDir,
        ideDetection,
        useIDEFirst: true,  // Follow ADR-37
      });

      // Extract API endpoints
      const apiResult = await apiExtractor.extract({
        maxEndpoints: 50,
        writeOutput: true,
      });

      const apiStats = apiResult.stats || {};
      const httpMethods = apiStats.httpMethods || {};
      console.log(`      ✅ API endpoints extracted:`);
      console.log(`         • Endpoints: ${apiStats.totalEndpoints || 0}`);
      console.log(`         • By method: GET=${httpMethods.GET || 0}, POST=${httpMethods.POST || 0}, PUT=${httpMethods.PUT || 0}, DELETE=${httpMethods.DELETE || 0}`);
      console.log(`         • Strategy: ${apiStats.strategy || 'unknown'}`);
      console.log(`      📄 JSON: ${path.join(outputDir, 'api-endpoints.json')}`);
      console.log(`      📄 Summary: ${path.join(outputDir, 'api-endpoints.md')}\n`);
    } catch (err) {
      console.warn(`      ⚠️  API endpoint extraction warning (non-fatal): ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would extract API endpoints for: ${projectRoot}\n`);
  }

  // ── Step 9: Detect duplicate patterns ────────────────────────────────────────
  console.log(`[9/10] Detecting duplicate patterns (exact duplicates, similar functions)...`);
  if (!args.dryRun) {
    try {
      const { CodeGraph } = require('./core/code-graph');
      const { DuplicatePatternDetector } = require('./core/duplicate-pattern-detector');
      const { detectIDEEnvironment } = require('./core/ide-detection');
      const outputDir = path.join(projectRoot, 'output');
      const cfg = config || {};

      const graph = initialCodeGraph || new CodeGraph({
        projectRoot,
        outputDir,
        ignoreDirs:     cfg.ignoreDirs,
        scopeDirs:      cfg.codeGraph?.scopeDirs,
      });
      if (!initialCodeGraph) graph._loadFromDisk();

      // Detect IDE environment for IDE-First strategy
      const ideDetection = detectIDEEnvironment({ config: cfg });

      // Create detector with IDE-First strategy
      const dupDetector = new DuplicatePatternDetector({
        codeGraph: graph,
        projectRoot,
        outputDir,
        ideDetection,
        useIDEFirst: true,  // Follow ADR-37
      });

      // Detect duplicate patterns
      const dupResult = await dupDetector.detect({
        minBlockLines: 6,
        similarityThreshold: 0.7,
        writeOutput: true,
      });

      console.log(`      ✅ Duplicate patterns detected:`);
      console.log(`         • Exact duplicate groups: ${dupResult.stats.exactDuplicateGroups}`);
      console.log(`         • Similar function groups: ${dupResult.stats.similarFunctionGroups}`);
      console.log(`         • Duplicate blocks: ${dupResult.stats.duplicateBlockCount}`);
      console.log(`         • Duplication rate: ${dupResult.stats.duplicationRate}`);
      console.log(`         • Strategy: ${dupResult.stats.strategy}`);
      console.log(`      📄 JSON: ${path.join(outputDir, 'duplicate-patterns.json')}`);
      console.log(`      📄 Summary: ${path.join(outputDir, 'duplicate-patterns.md')}`);
      console.log(`      📄 Action Plan: ${path.join(outputDir, 'duplicate-patterns.md')}#action-plan`);
      if (dupResult.stats.exactDuplicateGroups > 0 || dupResult.stats.similarFunctionGroups > 0) {
        console.log(`      💡 Tip: Check the Action Plan section in duplicate-patterns.md for prioritized refactoring tasks`);
      }
      console.log('');
    } catch (err) {
      console.warn(`      ⚠️  Duplicate pattern detection warning (non-fatal): ${err.message}\n`);
    }
  } else {
    console.log(`      [dry-run] Would detect duplicate patterns for: ${projectRoot}\n`);
  }

  // ── Step 10: Initialize reflections.json seed file ──────────────────────────
  console.log(`[10/10] Initializing self-reflection store (reflections.json)...`);
  if (!args.dryRun) {
    const reflectionsPath = path.join(outputDir, 'reflections.json');
    if (fs.existsSync(reflectionsPath)) {
      console.log(`      ⏭️  reflections.json already exists, skipping\n`);
    } else {
      try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const seedData = {
          version: 1,
          updatedAt: new Date().toISOString(),
          reflections: [],
          patternFrequency: {},
          stats: { total: 0, open: 0, fixed: 0, deferred: 0, bySeverity: {}, recurringPatterns: 0 },
        };
        fs.writeFileSync(reflectionsPath, JSON.stringify(seedData, null, 2), 'utf-8');
        console.log(`      ✅ reflections.json seed file written to: ${reflectionsPath}`);
        console.log(`      ℹ️  Self-reflection data will accumulate as the workflow runs\n`);
      } catch (err) {
        console.warn(`      ⚠️  reflections.json generation warning (non-fatal): ${err.message}\n`);
      }
    }
  } else {
    console.log(`      [dry-run] Would generate: ${path.join(outputDir, 'reflections.json')}\n`);
  }

  // ── Step 10.2: Install Git pre-commit hooks for workflow enforcement ──────
  console.log(`[10.2/10] Installing Git pre-commit hooks (workflow enforcement)...`);
  if (!args.dryRun) {
    try {
      const { installHooks } = require('./tools/install-git-hooks');
      const hookResult = installHooks(projectRoot);
      if (hookResult.success) {
        console.log(`      ✅ Git hooks installed: ${path.basename(hookResult.hookPath)}`);
        console.log(`      🔒 Effect: Unmodified code cannot be committed (workflow enforced)`);
      } else {
        console.log(`      ⏭️  ${hookResult.reason || 'Git hooks installation skipped'}`);
      }
    } catch (err) {
      console.warn(`      ⚠️  Git hooks installation warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would install Git pre-commit hooks`);
  }
  console.log('');

  // ── Step 10.5: Auto-distill expert knowledge from analysis artifacts ──────
  console.log(`[10.5/10] Auto-distilling expert knowledge from analysis artifacts...`);
  if (!args.dryRun) {
    try {
      const { ExpertKnowledgeChannel, autoDistillExpertKnowledge } = require('./core/expert-knowledge-channel');

      // First, load any existing expert knowledge files
      const expertChannel = new ExpertKnowledgeChannel({ projectRoot });
      const loadResult = expertChannel.loadFromDirectory();
      if (loadResult.loaded > 0) {
        console.log(`      📚 Loaded ${loadResult.loaded} existing expert knowledge file(s)`);
      }

      // Then, attempt auto-distillation from analysis artifacts
      if (cheapLlmCall) {
        const distillResult = await autoDistillExpertKnowledge({
          projectRoot,
          cheapLlmCall,
        });
        if (distillResult.success) {
          console.log(`      ✅ Auto-distilled expert knowledge: ${distillResult.filePath}`);
        } else {
          console.log(`      ℹ️  Auto-distillation skipped: ${distillResult.error}`);
        }
      } else {
        console.log(`      ℹ️  Auto-distillation skipped: LLM not available (can be run later)`);
      }
    } catch (err) {
      console.warn(`      ⚠️  Expert knowledge step warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would auto-distill expert knowledge from analysis artifacts`);
  }
  console.log('');

  // ── Step 10.6: Generate Dev Map (project-level index) ───────────────────────
  console.log(`[10.6/10] Generating Dev Map (project-level index)...`);
  if (!args.dryRun) {
    try {
      const { DevMapGenerator } = require('./tools/dev-map-generator');
      const devMapGen = new DevMapGenerator(projectRoot);
      const devMapResult = await devMapGen.generate();
      if (devMapResult.generated) {
        console.log(`      ✅ Dev Map generated: ${devMapResult.path}`);
        console.log(`      ├── Sections: ${devMapResult.sections.join(', ')}`);
        console.log(`      └── Provides PM Agent with project capability overview`);
        console.log('');
        console.log(`      💡 Dev Map enables PM Agent to route tasks based on:`);
        console.log(`          • Project type (Node.js/Python/Java/Go)`);
        console.log(`          • Entry points (detected automatically)`);
        console.log(`          • Available scripts (build/test/lint)`);
      } else {
        console.log(`      ⚠️  Dev Map generation returned unexpected result`);
      }
    } catch (err) {
      console.warn(`      ⚠️  Dev Map generation warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would generate Dev Map for: ${projectRoot}`);
  }
  console.log('');

  // ── Step 10.7: Initialize Task Board for first session ──────────────────────
  console.log(`[10.7/10] Initializing Task Board (enhanced stage tracking)...`);
  if (!args.dryRun) {
    try {
      const { TaskBoard } = require('./tools/task-board');
      const taskBoard = new TaskBoard(projectRoot);
      const sessionId = `init-${Date.now()}`;
      const requirement = `Project initialization for ${config.projectName || path.basename(projectRoot)}`;
      const tbResult = taskBoard.init(sessionId, requirement);
      if (tbResult.sessionId) {
        console.log(`      ✅ Task Board initialized: ${sessionId}`);
        console.log(`      ├── Total stages: ${tbResult.stages.length}`);
        console.log(`      ├── Columns: backlog, in_progress, review, done`);
        console.log(`      └── Gates: PRE-DEVELOP, PRE-DEPLOY (hard constraints)`);
        console.log('');
        console.log(`      💡 First session created. When running /wf <requirement>:`);
        console.log(`          • PM Agent will use this board for progress tracking`);
        console.log(`          • Gate Controller will enforce stage transitions`);
        console.log(`          • View board: node workflow/tools/task-board.js status`);
      } else {
        console.log(`      ⚠️  Task Board initialization returned unexpected result`);
      }
    } catch (err) {
      console.warn(`      ⚠️  Task Board initialization warning (non-fatal): ${err.message}`);
    }
  } else {
    console.log(`      [dry-run] Would initialize Task Board for: ${projectRoot}`);
  }
  console.log('');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${'='.repeat(60)}`);
  console.log(`  ✅ Project initialisation complete!`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n  The workflow is now configured for: ${config.projectName || projectRoot}`);
  console.log(`  Project knowledge files:`);
  console.log(`    • AGENTS.md                  – Project context entry point (edit to fill details)`);
  console.log(`    • docs/architecture.md        – Architecture decisions & acceptance criteria`);
  console.log(`    • docs/init-checklist.md      – Onboarding checklist for reference`);
  console.log(`  Long-running agent files:`);
  console.log(`    • init.sh                    – Run at the start of every Coding Agent session`);
  console.log(`    • output/feature-list.json   – Track feature completion (all start passes:false)`);
  console.log(`  Code intelligence files:`);
  console.log(`    • output/code-graph-index.json      – L1 lightweight symbol/module index`);
  console.log(`    • output/code-graph-shards/         – L2 module shards for on-demand deep reads`);
  console.log(`    • output/code-graph.md              – Human-readable code graph summary`);
  console.log(`    • output/code-graph.json            – L3 legacy full graph, only when explicitly enabled`);
  console.log(`    • output/project-profile.md         – Deep architecture profile (frameworks, layers, data, infra)`);
  console.log(`    • output/business-logic.json – Extracted business logic patterns (entry points, flows)`);
  console.log(`    • output/business-logic.md   – Human-readable business logic summary`);
  console.log(`    • output/api-endpoints.json  – Extracted REST API endpoints (routes, handlers)`);
  console.log(`    • output/api-endpoints.md    – Human-readable API endpoint summary`);
  console.log(`    • output/duplicate-patterns.json – Detected duplicate code patterns (machine-readable)`);
  console.log(`    • output/duplicate-patterns.md   – Duplication analysis with 🎯 Action Plan`);
  console.log(`    • output/duplicate-patterns-diagrams.md – Visual duplication network (Mermaid)`);
  console.log(`    • output/reflections.json    – Self-reflection store (known issues, recurring problems)`);
  console.log(`  IDE Agent definitions:`);
  console.log(`    • .codebuddy/agents/workflow-agent.md  – CodeBuddy custom Agent (select in mode dropdown)`);
  console.log(`    • .cursor/rules/workflow-agent.mdc     – Cursor Agent rule`);
  console.log(`    • .claude/agents/workflow-agent.md     – Claude Code Agent`);
  console.log(`  Expert knowledge:`);
  console.log(`    • .workflow/experts/                   – Expert knowledge files (create .md files here)`);
  console.log(`    • .workflow/experts/auto-distilled.md  – Auto-distilled from code analysis (if LLM available)`);
  console.log(`    • .workflow/experiences.json           – Experience store (local + synced expert knowledge)`);
  if (config.workflowSource) {
    console.log(`      └─ 🔗 Remote experiences synced from: ${config.workflowSource}`);
  }
  console.log(`  Git hooks (enforcement):`);
  console.log(`    • .git/hooks/pre-commit                – Blocks commits without workflow completion`);
  console.log(`      🔒 Workflow enforced: All commits must have a valid session in workflow-progress.log`);
  console.log(`  You can now run: node workflow/index.js\n`);

  // ── O4: Optional Enhancement Detection ─────────────────────────────────────
  // Detect tree-sitter and embedding service availability, provide guidance.
  console.log(`  Optional enhancements:`);
  let treeSitterAvailable = false;
  try {
    const tsAdapter = require('./core/ast-parsers/tree-sitter-adapter');
    treeSitterAvailable = tsAdapter.testAvailability();
  } catch (_) { /* not installed */ }
  const ps = codeGraphResult?.parserStats;
  if (ps && ps.astCoveragePercent > 0) {
    console.log(`    ✅ tree-sitter: active — ${ps.astParsed}/${codeGraphResult?.symbolCount || '?'} symbols parsed via AST (${ps.astCoveragePercent}% coverage)`);
  } else if (treeSitterAvailable) {
    console.log(`    ✅ tree-sitter: installed (AST-level code parsing enabled)`);
  } else {
    console.log(`    💡 tree-sitter: not installed (using regex fallback for CodeGraph)`);
    console.log(`       Install for 3x better symbol extraction precision:`);
    console.log(`       npm install tree-sitter tree-sitter-javascript tree-sitter-typescript`);
  }

  let embeddingAvailable = false;
  try {
    require.resolve('@huggingface/transformers');
    embeddingAvailable = true;
  } catch (_) {
    try {
      require.resolve('@xenova/transformers');
      embeddingAvailable = true;
    } catch (_) { /* not installed */ }
  }
  if (embeddingAvailable) {
    console.log(`    ✅ embedding: installed (semantic skill matching enabled)`);
  } else {
    console.log(`    💡 embedding: not installed (using BM25 keyword matching for skills)`);
    console.log(`       Install for semantic skill ranking:`);
    console.log(`       npm install @huggingface/transformers`);
  }
  console.log('');
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
