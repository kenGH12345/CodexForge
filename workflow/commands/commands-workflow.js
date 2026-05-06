/**
 * Workflow Commands – Core workflow lifecycle commands.
 *
 * Commands:
 *   /ask-workflow-agent  – Start or resume a workflow (sequential)
 *   /wf                  – Smart workflow entry (supports --auto, --sequential, --parallel, init)
 *   /wf-tasks            – Run a goal via parallel task-based execution
 *   /workflow-status     – Show current workflow state
 *   /workflow-reset      – Delete manifest and start fresh
 *   /workflow-artifacts  – List all produced artifacts
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, getDefaultOutputDir } = require('../core/constants');
const { displayModeBanner, getIDEDetectionResult, isFullIDEAgentMode } = require('../core/ide-detection');
const { isIDEAgentMode } = require('../core/agent-handoff-log');
const { enforceRuntimePolicy } = require('../core/runtime-policy-enforcer');
const { enforceRequirementBudget } = require('../core/context-budget-policy');
const {
  WF_PIPELINE_LABEL,
  WF_DEFAULT_BEHAVIOUR_LINES,
  WF_ROUTING_HINT,
} = require('../core/workflow-routing-policy');

/**
 * Registers workflow commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerWorkflowCommands(registerCommand) {

  registerCommand(
    'ask-workflow-agent',
    'Start or resume a multi-agent workflow with the given requirement',
    async (args, context) => {
      if (!args) {
        return `Usage: /ask-workflow-agent <your requirement>\nExample: /ask-workflow-agent Build a REST API for user management`;
      }
      if (!context.orchestrator) {
        return `[Error] No orchestrator in context. Cannot start workflow.`;
      }
      console.log(`[ask-workflow-agent] Starting workflow with requirement: "${args}"`);
      await context.orchestrator.run(args);
      return `✅ Workflow started. Requirement: "${args}"`;
    }
  );

  // Alias: /wf → /ask-workflow-agent，支持 init / 初始化工作流 子命令
  registerCommand(
    'wf',
    'Smart workflow entry: defaults to full sequential pipeline. Supports --auto, --sequential, --parallel [--concurrency <n>], and "init" sub-command.',
    async (args, context) => {
      if (!args) {
        return [
          `Usage:`,
          `  /wf <requirement>                         – Run full sequential pipeline (default)`,
          `  /wf <requirement> --auto                  – Smart auto-dispatch (LLM decides seq vs parallel)`,
          `  /wf <requirement> --sequential            – Force sequential mode (same as default)`,
          `  /wf <requirement> --parallel              – Force parallel (LLM decomposes tasks)`,
          `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
          `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
          `  /wf 初始化工作流 [--path <dir>]           – Same as above (Chinese alias)`,
          `  /wf analyze [--no-lsp] [--max-files <N>]  – Re-analyze project architecture (standalone)`,
          `  /wf explore [--no-lsp] [--max-files <N>]  – Read-only exploration agent (no file writes)`,
          `  /wf diagnose                              – Diagnose IDE Agent capabilities and show flow logs`,
          ``,
          `Default behaviour:`,
          ...WF_DEFAULT_BEHAVIOUR_LINES.map(line => `  • ${line}`),
          `  • Use --auto to let the LLM decide whether to run sequentially or in parallel`,
          `  • Use --parallel to force parallel task-based execution`,
          ``,
          `Examples:`,
          `  /wf Build a REST API for user management`,
          `  /wf Build a user module and a payment module --auto`,
          `  /wf Refactor the auth service --parallel`,
          `  /wf init`,
          `  /wf init --path D:\\MyProject`,
          `  /wf analyze`,
          `  /wf analyze --no-lsp`,
          `  /wf analyze --max-files 200`,
          `  /wf explore --no-lsp`,
          `  /wf diagnose                              – Check if IDE Agent mode has full capabilities`,
        ].join('\n');
      }

      // ── Analyze / Explore sub-commands ─────────────────────────────────────
      const trimmedArgs = args.trim();
      const isAnalyzeCmd = /^analyze(\s|$)/i.test(trimmedArgs);
      const isExploreCmd = /^explore(\s|$)/i.test(trimmedArgs);

      if (isAnalyzeCmd || isExploreCmd) {
        const { dispatch } = require('./command-router');
        if (isExploreCmd) {
          const exploreArgs = trimmedArgs.replace(/^explore\s*/i, '').trim();
          const injected = `--explore ${exploreArgs}`.trim();
          return dispatch(`/analyze ${injected}`, context);
        }

        // Delegate to the /analyze command, stripping the 'analyze' prefix
        const analyzeArgs = trimmedArgs.replace(/^analyze\s*/i, '').trim();
        return dispatch(`/analyze ${analyzeArgs}`, context);
      }

      // ── Diagnose sub-command ──────────────────────────────────────────────
      const isDiagnoseCmd = /^diagnose(\s|$)/i.test(trimmedArgs);

      if (isDiagnoseCmd) {
        const { detectIDEEnvironment, displayModeBanner, isFullIDEAgentMode } = require('../core/ide-detection');
        const detection = detectIDEEnvironment();

        // Analyze project flow logs if available
        const projectRoot = context.orchestrator?.projectRoot || process.cwd();
        const dotWorkflowDir = path.join(projectRoot, '.workflow');
        const logsDir = path.join(dotWorkflowDir, 'logs');

        let flowLogAnalysis = '';
        if (fs.existsSync(logsDir)) {
          const logFiles = fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.json') || f.endsWith('.log'))
            .map(f => ({ name: f, path: path.join(logsDir, f), stat: fs.statSync(path.join(logsDir, f)) }))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);

          if (logFiles.length > 0) {
            flowLogAnalysis = `\n### 📋 Recent Flow Logs\n`;
            logFiles.slice(0, 5).forEach((f, i) => {
              flowLogAnalysis += `| ${i + 1} | ${f.name} | ${Math.round(f.stat.size / 1024)}KB | ${f.stat.mtime.toISOString().slice(0, 19)} |\n`;
            });
          }
        }

        // Check project initialization status
        const isInitialized = fs.existsSync(path.join(projectRoot, 'AGENTS.md'));
        const { resolveCodeGraphPath } = require('../core/code-graph-layered-reader');
        const hasCodeGraph = resolveCodeGraphPath(projectRoot).exists;

        // Generate capability matrix
        const caps = detection.capabilities;
        const allCapabilities = [
          ['codebaseSearch', '代码语义搜索'],
          ['grepSearch', '精确文本搜索'],
          ['viewCodeItem', '符号级代码查看'],
          ['readFile', '文件读取'],
          ['listDir', '目录列表'],
          ['builtinLSP', '内置 LSP'],
          ['callHierarchy', '调用层次'],
          ['findReferences', '查找引用'],
          ['goToDefinition', '跳转到定义'],
          ['typeInference', '类型推断'],
          ['terminal', '终端执行'],
          ['editFile', '文件编辑'],
        ];

        const enabledCaps = allCapabilities.filter(([key]) => caps[key]);
        const disabledCaps = allCapabilities.filter(([key]) => !caps[key]);

        const output = [
          `## 🔍 WorkFlowAgent IDE Agent Diagnostic Report`,
          ``,
          `> Generated at: ${new Date().toISOString()}`,
          `> Project: ${projectRoot}`,
          ``,
          `### 🎯 Runtime Mode`,
          ``,
          `| Attribute | Value |`,
          `|-----------|-------|`,
          `| **IDE Detected** | ${detection.isInsideIDE ? '✅ Yes' : '❌ No'} |`,
          `| **IDE Name** | ${detection.ideName || 'N/A'} |`,
          `| **IDE Key** | ${detection.ideKey || 'standalone'} |`,
          `| **Full IDE Agent Mode** | ${isFullIDEAgentMode() ? '✅ Yes (Full Capability)' : '⚠️ Limited Mode'} |`,
          `| **Project Initialized** | ${isInitialized ? '✅ Yes' : '❌ No'} |`,
          `| **Code Graph Built** | ${hasCodeGraph ? '✅ Yes' : '❌ No'} |`,
          ``,
          `### ⚡ IDE Capability Matrix`,
          ``,
          `**✅ Enabled (${enabledCaps.length}/${allCapabilities.length}):**`,
          ...enabledCaps.map(([key, desc]) => `| ${desc} | \`${key}\` | ✅ |`),
          ``,
          ...(disabledCaps.length > 0 ? [
            `**❌ Disabled (${disabledCaps.length}/${allCapabilities.length}):**`,
            ...disabledCaps.map(([key, desc]) => `| ${desc} | \`${key}\` | ❌ |`),
          ] : []),
          ``,
          `### 🏠 IDE Agent Mode Confidence`,
          ``,
          isFullIDEAgentMode()
            ? `🟢 **FULL MODE**: All IDE capabilities are available. Using IDE native tools as primary source.`
            : `🟡 **LIMITED MODE**: Some IDE capabilities are unavailable. Self-built modules (CodeGraph, LSPAdapter) will serve as primary source.`,
          ``,
          `### 📝 Detection Signals`,
          ``,
          detection.matchedSignals.length > 0
            ? detection.matchedSignals.map(s => `- ${s}`).join('\n')
            : '- No IDE signals detected (running in standalone mode)',
          ``,
          ...(flowLogAnalysis ? [flowLogAnalysis] : []),
          ``,
          `### 💡 Recommendations`,
          ``,
          isFullIDEAgentMode()
            ? [
                `- ✅ IDE Agent mode is fully operational`,
                `- 🎯 IDE native tools will be used as primary source`,
                `- 📊 Self-built modules (CodeGraph, LSPAdapter) serve as fallback/cache`,
                `- 🔄 Dual-mode parity is maintained`,
              ].join('\n')
            : [
                `- ⚠️ Limited IDE capabilities detected`,
                `- 🔄 Self-built modules will be primary source`,
                `- 💡 Consider using a full IDE (Cursor, VS Code, CodeBuddy) for better experience`,
              ].join('\n'),
          ``,
        ].join('\n');

        // Display mode banner
        displayModeBanner();

        return output;
      }

      // ── Init sub-command ──────────────────────────────────────────────────
      const isInitCmd = /^(init|初始化工作流)(\s|$)/i.test(trimmedArgs);

      if (isInitCmd) {
        // Extract optional --path argument
        const pathMatch = trimmedArgs.match(/--path\s+(\S+)/);
        const dryRun    = trimmedArgs.includes('--dry-run');
        const validate  = trimmedArgs.includes('--validate');

        // Resolve the target project root:
        //   1. Explicit --path takes priority
        //   2. orchestrator.projectRoot (when running inside a workflow session)
        //   3. No fallback – require the user to specify --path explicitly
        const targetRoot = pathMatch
          ? path.resolve(pathMatch[1])
          : (context.orchestrator?.projectRoot || null);

        if (!targetRoot) {
          return [
            `❌ Cannot determine target project root.`,
            ``,
            `No --path argument provided and no active orchestrator session.`,
            `Please specify the project path explicitly:`,
            ``,
            `  /wf init --path <project-directory>`,
            ``,
            `Example:`,
            `  /wf init --path D:\\MyProject`,
          ].join('\n');
        }

        const { spawn } = require('child_process');
        const scriptPath = path.join(__dirname, '..', 'init-project.js');

        if (!fs.existsSync(scriptPath)) {
          return `❌ init-project.js not found at: ${scriptPath}`;
        }

        // Always pass --path explicitly to ensure init-project.js uses the
        // correct projectRoot (not its own cwd, which could be the workflow/ dir).
        const spawnArgs = [scriptPath, '--path', targetRoot];
        if (dryRun)     spawnArgs.push('--dry-run');
        if (validate)   spawnArgs.push('--validate');

        console.log(`[wf init] Running: node ${scriptPath} ${spawnArgs.slice(1).join(' ')}`);

        // ─── Streaming execution with real-time progress ────────────────────
        // Instead of buffering all output and returning at the end, we stream
        // progress in real-time to avoid the "stuck" feeling in IDE Agent mode.
        return new Promise((resolve) => {
          const MAX_OUTPUT_CAPACITY = 5000; // Keep last N chars to prevent memory bloat
          let outputBuffer = '';
          let hasResolved = false;

          const child = spawn(process.execPath, spawnArgs, {
            cwd: targetRoot,
            timeout: 300000, // 5 min timeout for large projects
          });

          // Real-time progress streaming function
          const streamProgress = (data, type = 'info') => {
            const chunk = data.toString();
            // Add to rolling buffer (keep only last N chars)
            outputBuffer = (outputBuffer + chunk).slice(-MAX_OUTPUT_CAPACITY);

            // Parse and display key milestones for better UX
            const lines = chunk.split('\n').filter(line => line.trim());
            for (const line of lines) {
              // Detect step progress patterns like "[1/10]", "✅", "📋", etc.
              if (line.match(/^\[\d+\/\d+\]/)) {
                console.log(`\n  ${line}`); // Step markers get newline for visibility
              } else if (line.match(/^[✅❌⚠️📋🔍🔗]/)) {
                console.log(`  ${line}`);   // Status emojis get indentation
              } else if (line.includes('error') || line.includes('Error') || type === 'error') {
                console.error(`    ⚠️  ${line}`);
              }
              // Other output streams silently to buffer
            }
          };

          child.stdout.on('data', (d) => streamProgress(d, 'info'));
          child.stderr.on('data', (d) => streamProgress(d, 'error'));

          child.on('close', (code) => {
            if (hasResolved) return;
            hasResolved = true;

            const status = code === 0 ? '✅' : '❌';
            const summary = code === 0
              ? `Workflow initialisation complete!`
              : `Workflow initialisation failed (exit ${code})`;

            // Return structured result with truncated output
            resolve([
              `${status} ${summary}`,
              '',
              '<details>',
              '<summary>📋 Click to view full output</summary>',
              '',
              '```',
              outputBuffer.slice(-3000), // Last 3000 chars
              '```',
              '</details>',
            ].join('\n'));
          });

          child.on('error', (err) => {
            if (hasResolved) return;
            hasResolved = true;
            resolve(`❌ Failed to run init-project.js: ${err.message}`);
          });

          // Safety timeout handler
          setTimeout(() => {
            if (!hasResolved) {
              hasResolved = true;
              child.kill('SIGTERM');
              resolve('⚠️ Workflow initialisation timed out after 5 minutes.');
            }
          }, 300000);
        });
      }

      // ── Normal workflow start (auto-dispatch) ────────────────────────────
      if (!context.orchestrator) {
        return `[Error] No orchestrator in context. Cannot start workflow.`;
      }

      // ── RequestTriage: InitStateGuard + StalenessDetector (ADR-XX: 移除复杂度限制) ─────
      // 用户要求：凡是 /wf 命令都启用工作流，不要因为"简单任务"而阻止执行
      // 保留：InitStateGuard（项目初始化检查）、StalenessDetector（artifact 过期检测）
      // 移除：复杂度评估的限制（不再因为 score < 15 而建议 IDE 直接处理）
      try {
        const { RequestTriage } = require('../core/request-triage');
        const triage = new RequestTriage();
        const projectRoot = context.orchestrator?.projectRoot || process.cwd();
        const triageResult = triage.triage(trimmedArgs, { projectRoot });

        // InitStateGuard: block if project not initialized
        if (triageResult.requiresInit) {
          return [
            `❌ **Project Not Initialized**`,
            ``,
            triageResult.initState.reason,
            ``,
            `Please run \`/wf init\` or \`/wf init --path <project-dir>\` first.`,
          ].join('\n');
        }

        // StalenessDetector: warn if artifacts are outdated (non-blocking)
        if (triageResult.staleness && triageResult.staleness.isStale) {
          for (const w of triageResult.staleness.warnings) {
            console.log(`[wf] ${w.message}`);
          }
        }

        // Log triage result for debugging (but don't block execution)
        console.log(`[wf] RequestTriage: score=${triageResult.score}, suggestion=${triageResult.suggestion}, signals=[${triageResult.matchedRules.map(r => r.tag).join(',')}]`);
        console.log(`[wf] 🚀 Proceeding with full workflow (${WF_PIPELINE_LABEL}) (ADR-XX: 复杂度限制已移除)`);

        // ── ADR-43 Extension: Capture experience for all tasks ────
        // 既然所有 /wf 都执行工作流，那么所有信号都值得记录
        if (triageResult.experienceHook) {
          setImmediate(async () => {
            try {
              const { runIdeExperienceHook } = require('../core/ide-experience-hook');
              const hookResult = await runIdeExperienceHook({
                requirement: triageResult.experienceHook.sessionContext.requirement,
                score: triageResult.score,
                matchedTags: triageResult.experienceHook.sessionContext.matchedTags,
                experienceStore: context.orchestrator?.experienceStore,
              });
              if (hookResult.captured) {
                console.log(`[wf] Experience Hook: captured experience ${hookResult.expId}`);
              }
            } catch (hookErr) {
              console.warn(`[wf] Experience Hook failed (non-fatal): ${hookErr.message}`);
            }
          });
        }
      } catch (triageErr) {
        // Triage failure is non-fatal — continue with workflow
        console.warn(`[wf] RequestTriage failed (non-fatal): ${triageErr.message}`);
      }

      // ── Runtime Policy + Context Budget Guard ─────────────────────────────
      const policyCheck = enforceRuntimePolicy(trimmedArgs, { config: context.orchestrator?._config || {} });
      if (!policyCheck.ok) {
        return [
          `❌ Runtime policy blocked request.`,
          ...policyCheck.violations.map(v => `- ${v}`),
        ].join('\n');
      }

      const budgetCheck = enforceRequirementBudget(trimmedArgs, context.orchestrator?._config || {});
      const effectiveArgs = budgetCheck.requirement;
      if (budgetCheck.truncated) {
        console.warn(`[wf] Requirement truncated by budget policy (${trimmedArgs.length} -> ${effectiveArgs.length})`);
      }

      // ── Input length guard ────────────────────────────────────────────────
      // Prevent excessively long requirements from blowing up the LLM token budget.
      // 8000 chars ≈ ~2000 tokens, which is a reasonable upper bound for a requirement.
      const MAX_REQUIREMENT_CHARS = 8000;
      if (effectiveArgs.length > MAX_REQUIREMENT_CHARS) {
        return [
          `❌ Requirement too long (${effectiveArgs.length} chars, max ${MAX_REQUIREMENT_CHARS}).`,
          ``,
          `Please shorten your requirement to under ${MAX_REQUIREMENT_CHARS} characters.`,
          `Tip: Focus on the core feature. Detailed specs can go in AGENTS.md or a separate file.`,
        ].join('\n');
      }

      // ── Debug: log raw args for diagnosing @ file reference format ──────
      console.log(`[wf] Raw args received from IDE:\n---\n${args}\n---`);
      console.log(`[wf] Args length: ${args.length} chars`);

      // Support --parallel / --auto flags to control execution mode
      // --sequential is accepted but redundant (sequential is the default).
      const forceParallel   = trimmedArgs.includes('--parallel');
      const forceAuto       = trimmedArgs.includes('--auto');
      const concurrencyMatch = trimmedArgs.match(/--concurrency\s+(\d+)/);
      const concurrency = concurrencyMatch ? parseInt(concurrencyMatch[1], 10) : 3;

      // Strip mode flags from the requirement text
      const requirement = effectiveArgs
        .replace(/--sequential/g, '')
        .replace(/--parallel/g, '')
        .replace(/--auto/g, '')
        .replace(/--force/g, '')
        .replace(/--concurrency\s+\d+/g, '')
        .trim();

      if (!requirement) {
        return [
          `Usage:`,
          `  /wf <your requirement>                    – Run full sequential pipeline (default)`,
          `  /wf <requirement> --auto                  – Smart auto-dispatch (LLM decides)`,
          `  /wf <requirement> --sequential            – Force sequential mode (same as default)`,
          `  /wf <requirement> --parallel              – Force parallel mode (LLM decomposes tasks)`,
          `  /wf <requirement> --parallel --concurrency <n>  – Parallel with custom concurrency`,
          `  /wf init [--path <dir>]                   – Initialise the workflow for a project`,
          `  /wf analyze [--no-lsp] [--max-files <N>]  – Re-analyze project architecture`,
          ``,
          `💡 ${WF_ROUTING_HINT}`, 
          ``,
          `Examples:`,
          `  /wf Build a REST API for user management`,
          `  /wf Build a user module and a payment module --auto`,
          `  /wf Refactor the auth service --parallel`,
          `  /wf analyze`,
          `  /wf analyze --no-lsp`,
        ].join('\n');
      }

      if (forceParallel) {
        // Force parallel: use runAuto but hint the LLM to prefer parallel decomposition
        console.log(`[wf] Force parallel mode. Auto-decomposing: "${requirement}"`);
        await context.orchestrator.runAuto(requirement, concurrency);
        
        // IDE Agent mode: capture visual output for LLM reply
        const vizOutput = context.orchestrator.handoffLog?.hasOutput() 
          ? context.orchestrator.handoffLog.flushOutput() 
          : '';
        
        return [
          vizOutput,
          `✅ Workflow complete (parallel). Requirement: "${requirement}"`,
        ].filter(Boolean).join('\n');
      }

      if (forceAuto) {
        // Explicit auto-dispatch: LLM decides sequential vs parallel
        console.log(`[wf] Auto-dispatch mode. Analysing requirement: "${requirement}"`);
        await context.orchestrator.runAuto(requirement, concurrency);
        
        // IDE Agent mode: capture visual output for LLM reply
        const vizOutput = context.orchestrator.handoffLog?.hasOutput() 
          ? context.orchestrator.handoffLog.flushOutput() 
          : '';
        
        return [
          vizOutput,
          `✅ Workflow complete (auto). Requirement: "${requirement}"`,
        ].filter(Boolean).join('\n');
      }

      // Default: full sequential pipeline (ANALYSE → ARCHITECT → PLAN → CODE → TEST)
      // This is the most predictable and reliable mode – always produces
      // requirement.md, architecture.md, code diff, and test report.
      console.log(`[wf] Sequential mode (default). Starting full pipeline: "${requirement}"`);
      await context.orchestrator.run(requirement);
      
      // IDE Agent mode: capture visual output for LLM reply
      const vizOutput = context.orchestrator.handoffLog?.hasOutput() 
        ? context.orchestrator.handoffLog.flushOutput() 
        : '';
      
      return [
        vizOutput,
        `✅ Workflow complete (sequential). Requirement: "${requirement}"`,
      ].filter(Boolean).join('\n');
    }
  );

  // ─── /wf-tasks ────────────────────────────────────────────────────────────────
  // Triggers runTaskBased() from the command line.
  //
  // Syntax:
  //   /wf-tasks <goal> --tasks "<title1>|<title2>[dep:<title1>]|<title3>[dep:<title1>,<title2>]" [--concurrency <n>]
  //
  // Task format (pipe-separated):
  //   <title>                          – no dependencies
  //   <title>[dep:<dep1>,<dep2>]       – depends on tasks with those titles
  //
  // Example:
  //   /wf-tasks Refactor user module --tasks "Analyse existing structure|Design new interface[dep:Analyse existing structure]|Implement UserService[dep:Design new interface]|Write unit tests[dep:Implement UserService]" --concurrency 2
  registerCommand(
    'wf-tasks',
    'Run a goal using parallel task-based execution. Usage: /wf-tasks <goal> --tasks "<t1>|<t2>[dep:<t1>]|..." [--concurrency <n>]',
    async (args, context) => {
      if (!args || !args.includes('--tasks')) {
        return [
          `Usage:`,
          `  /wf-tasks <goal> --tasks "<tasks>" [--concurrency <n>]`,
          ``,
          `Task format (pipe-separated, each task optionally has [dep:...]):`,
          `  <title>                         – no dependencies`,
          `  <title>[dep:<dep1>,<dep2>]      – depends on other task titles`,
          ``,
          `Examples:`,
          `  /wf-tasks "Refactor user module" --tasks "Analyse structure|Design interface[dep:Analyse structure]|Implement service[dep:Design interface]|Write tests[dep:Implement service]"`,
          `  /wf-tasks "Build REST API" --tasks "Design schema|Implement endpoints[dep:Design schema]|Write tests[dep:Implement endpoints]" --concurrency 2`,
        ].join('\n');
      }

      if (!context.orchestrator) {
        return `[Error] No orchestrator in context. Cannot start task-based workflow.`;
      }

      // ── Parse --tasks ──────────────────────────────────────────────────────
      // R4-4 audit: the original regex /--tasks\s+"([^"]+)"/ would truncate if any
      // task title contained a literal " character. Improved to also match single-quoted
      // tasks string as an alternative, and greedily match to the LAST quote.
      const tasksMatch = args.match(/--tasks\s+"([^"]+)"/) || args.match(/--tasks\s+'([^']+)'/);
      if (!tasksMatch) {
        return `❌ Could not parse --tasks. Make sure to wrap the task list in double quotes.\n\nExample: --tasks "Task A|Task B[dep:Task A]|Task C[dep:Task A,Task B]"`;
      }

      // ── Parse --concurrency ────────────────────────────────────────────────
      const concurrencyMatch = args.match(/--concurrency\s+(\d+)/);
      const concurrency = concurrencyMatch ? parseInt(concurrencyMatch[1], 10) : 3;

      // ── Parse goal (everything before the first --flag) ────────────────────
      const goal = args.replace(/--tasks\s+"[^"]+"/, '').replace(/--concurrency\s+\d+/, '').trim();
      if (!goal) {
        return `❌ Missing goal. Provide a goal description before the --tasks flag.\n\nExample: /wf-tasks "Refactor user module" --tasks "..."`;
      }

      // ── Build taskDefs from pipe-separated task string ─────────────────────
      // Format: "Title A|Title B[dep:Title A]|Title C[dep:Title A,Title B]"
      const rawTasks = tasksMatch[1].split('|').map(s => s.trim()).filter(Boolean);
      if (rawTasks.length === 0) {
        return `❌ No tasks found in --tasks value. Use pipe (|) to separate tasks.`;
      }

      // Build a title → id map first (id = task-1, task-2, ...)
      const titleToId = {};
      rawTasks.forEach((raw, i) => {
        const title = raw.replace(/\[dep:[^\]]*\]/g, '').trim();
        titleToId[title] = `task-${i + 1}`;
      });

      const taskDefs = rawTasks.map((raw, i) => {
        // Extract optional [dep:...] block
        const depMatch = raw.match(/\[dep:([^\]]+)\]/);
        const title = raw.replace(/\[dep:[^\]]*\]/g, '').trim();
        const id = `task-${i + 1}`;

        let deps = [];
        if (depMatch) {
          deps = depMatch[1].split(',').map(d => {
            const depTitle = d.trim();
            const depId = titleToId[depTitle];
            if (!depId) {
              console.warn(`[wf-tasks] Warning: dependency "${depTitle}" not found in task list. Skipping.`);
            }
            return depId;
          }).filter(Boolean);
        }

        return { id, title, deps };
      });

      // ── Summary before execution ───────────────────────────────────────────
      const taskSummary = taskDefs.map((t, i) =>
        `  ${i + 1}. [${t.id}] ${t.title}${t.deps.length ? ` (deps: ${t.deps.join(', ')})` : ''}`
      ).join('\n');

      console.log(`[wf-tasks] Starting task-based workflow:`);
      console.log(`  Goal: "${goal}"`);
      console.log(`  Tasks (${taskDefs.length}):\n${taskSummary}`);
      console.log(`  Concurrency: ${concurrency}`);

      await context.orchestrator.runTaskBased(goal, {
        taskDefs,
        maxWorkers: concurrency,
        source: 'wf-tasks',
      });

      return [
        `✅ Task-based workflow complete.`,
        ``,
        `**Goal**: ${goal}`,
        `**Tasks**: ${taskDefs.length} | **Concurrency**: ${concurrency}`,
        ``,
        taskDefs.map((t, i) => `${i + 1}. ${t.title}${t.deps.length ? ` ← ${t.deps.join(', ')}` : ''}`).join('\n'),
      ].join('\n');
    }
  );

  registerCommand(
    'workflow-status',
    'Show the current state of the workflow',
    async (_args, context) => {
      if (!fs.existsSync(PATHS.MANIFEST)) {
        return `No active workflow found. Start one with: /ask-workflow-agent <requirement>`;
      }
      const manifest = JSON.parse(fs.readFileSync(PATHS.MANIFEST, 'utf-8'));
      const lines = [
        `## Workflow Status`,
        `- **Project ID**: ${manifest.projectId}`,
        `- **Current State**: ${manifest.currentState}`,
        `- **Created**: ${manifest.createdAt}`,
        `- **Last Updated**: ${manifest.updatedAt}`,
        `- **History**: ${manifest.history.length} transitions`,
        ``,
        `### Artifacts`,
        ...Object.entries(manifest.artifacts).map(([k, v]) => `- ${k}: ${v || '_not yet produced_'}`),
        ``,
        `### Risks`,
        manifest.risks.length === 0
          ? '- No risks recorded'
          : manifest.risks.map(r => `- [${r.level.toUpperCase()}] ${r.message}`).join('\n'),
      ];
      return lines.join('\n');
    }
  );

  registerCommand(
    'workflow-reset',
    'Delete the current manifest and start fresh',
    async (_args, _context) => {
      if (fs.existsSync(PATHS.MANIFEST)) {
        fs.unlinkSync(PATHS.MANIFEST);
        return `✅ Workflow reset. manifest.json deleted. Run /ask-workflow-agent to start a new workflow.`;
      }
      return `No manifest.json found. Nothing to reset.`;
    }
  );

  registerCommand(
    'workflow-artifacts',
    'List all artifact files produced by the current workflow',
    async (_args, _context) => {
      const _outDir = _context.orchestrator?._outputDir || getDefaultOutputDir();
      if (!fs.existsSync(_outDir)) {
        return `No output directory found. No artifacts produced yet.`;
      }
      const files = fs.readdirSync(_outDir);
      if (files.length === 0) {
        return `Output directory is empty. No artifacts produced yet.`;
      }
      const lines = [`## Workflow Artifacts (${files.length} files)\n`];
      for (const file of files) {
        const fullPath = path.join(_outDir, file);
        const stat = fs.statSync(fullPath);
        lines.push(`- **${file}** (${stat.size} bytes, modified: ${stat.mtime.toISOString()})`);
      }
      return lines.join('\n');
    }
  );

  // ───────────────────────────────────────────────────────────────────────────
  // ADR-37: IDE Mode Display Command
  // ───────────────────────────────────────────────────────────────────────────

  registerCommand(
    'wf-mode',
    'Display current WorkFlowAgent running mode (IDE detection status). Usage: /wf-mode [--json]',
    async (args) => {
      const showJson = (args || '').includes('--json');

      if (showJson) {
        // JSON output for programmatic use
        const detection = getIDEDetectionResult();
        return JSON.stringify({
          isInsideIDE: detection.isInsideIDE,
          isFullIDEAgentMode: isFullIDEAgentMode(),
          ideName: detection.ideName,
          ideKey: detection.ideKey,
          capabilities: detection.capabilities,
          matchedSignals: detection.matchedSignals,
          summary: detection.summary,
        }, null, 2);
      }

      // Visual banner output - displayModeBanner() already prints to console
      displayModeBanner({ showCapabilities: true, compact: false });
      return ''; // Return empty string since banner is already printed
    }
  );

}

module.exports = { registerWorkflowCommands };
