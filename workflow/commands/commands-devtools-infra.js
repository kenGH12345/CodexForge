/**
 * DevTools Commands - Infrastructure & Monitoring (gc, metrics, ci, report)
 *
 * Split from commands-devtools.js for maintainability (ADR-33 Phase 3).
 *
 * @module workflow/commands/commands-devtools-infra
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../core/constants');

/**
 * Registers infra devtools commands.
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerInfraCommands(registerCommand) {
registerCommand(
  'gc',
  'Run entropy GC scan: detect architectural drift, oversized files, stale docs. [--path <dir>]',
  async (args, context) => {
    const { EntropyGC } = require('../core/entropy-gc');
    const { PATHS }     = require('../core/constants');

    // Allow --path override for scanning a different project root
    const pathMatch  = args.match(/--path\s+(\S+)/);
    const projectRoot = pathMatch
      ? path.resolve(pathMatch[1])
      : (context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..'));

    // Inherit config from orchestrator if available
    const cfg = context.orchestrator?._config || {};

    const gc = new EntropyGC({
      projectRoot,
      outputDir:  PATHS.OUTPUT_DIR,
      extensions: cfg.sourceExtensions,
      ignoreDirs: cfg.ignoreDirs,
      maxLines:   cfg.maxLines,
      docPaths:   cfg.docPaths || [],
    });

    try {
      const result = await gc.run();
      const icon   = result.violations === 0 ? '✅' : result.details?.high > 0 ? '🔴' : '🟡';
      return [
        `${icon} **Entropy GC Scan Complete**`,
        ``,
        `- Files scanned: **${result.filesScanned}**`,
        `- Violations: **${result.violations}** total`,
        `  - 🔴 High: ${result.details?.high || 0}`,
        `  - 🟡 Medium: ${result.details?.medium || 0}`,
        `  - 🟢 Low: ${result.details?.low || 0}`,
        ``,
        result.reportPath ? `📄 Full report: \`${result.reportPath}\`` : '',
        ``,
        result.violations > 0
          ? `> Run \`/gc\` again after fixing violations to verify clean state.`
          : `> Codebase is clean. No architectural drift detected.`,
      ].filter(l => l !== undefined).join('\n');
    } catch (err) {
      return `❌ Entropy GC failed: ${err.message}`;
    }
  }
);


registerCommand(
  'metrics',
  'Show the last workflow session metrics from output/run-metrics.json',
  async (_args, context) => {
    const { PATHS } = require('../core/constants');
    const metricsPath = path.join(PATHS.OUTPUT_DIR, 'run-metrics.json');

    if (!fs.existsSync(metricsPath)) {
      return `No metrics found. Run a workflow first to generate \`output/run-metrics.json\`.`;
    }

    let m;
    try {
      m = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    } catch (err) {
      return `❌ Failed to read metrics: ${err.message}`;
    }

    const lines = [
      `## 📊 Last Workflow Session Metrics`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Session | \`${m.sessionId}\` |`,
      `| Started | ${m.startedAt} |`,
      `| Duration | ${((m.totalDurationMs || 0) / 1000).toFixed(1)}s |`,
      `| LLM Calls | ${m.llm?.totalCalls || 0} |`,
      `| Tokens (est.) | ~${(m.llm?.totalTokensEst || 0).toLocaleString()} |`,
      `| Errors | ${m.errors?.count || 0} |`,
      ``,
    ];

    // Stage breakdown
    if (m.stages?.length > 0) {
      lines.push(`### Stage Timings`);
      lines.push(`| Stage | Duration | Status |`);
      lines.push(`|-------|----------|--------|`);
      for (const s of m.stages) {
        const dur  = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
        const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️';
        lines.push(`| ${s.name} | ${dur} | ${icon} ${s.status} |`);
      }
      lines.push(``);
    }

    // Test result
    if (m.testResult) {
      const t    = m.testResult;
      const icon = t.failed === 0 ? '✅' : '❌';
      lines.push(`### Test Results`);
      lines.push(`${icon} ${t.passed} passed / ${t.failed} failed / ${t.skipped} skipped (${t.rounds} round(s))`);
      lines.push(``);
    }

    // Entropy result
    if (m.entropyResult) {
      const e    = m.entropyResult;
      const icon = e.violations === 0 ? '✅' : '⚠️';
      lines.push(`### Entropy GC`);
      lines.push(`${icon} ${e.violations} violation(s) in ${e.filesScanned} files scanned`);
      lines.push(``);
    }

    return lines.join('\n');
  }
);


registerCommand(
  'ci',
  'Run local CI pipeline (lint + test + entropy) or poll remote CI status. [--wait] [--lint-only] [--poll]',
  async (args, context) => {
    const { CIIntegration } = require('../core/ci-integration');
    const cfg = context.orchestrator?._config || {};
    const projectRoot = context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..');

    const ci = new CIIntegration({
      projectRoot,
      lintCommand: cfg.lintCommand || null,
      testCommand: cfg.testCommand || null,
    });

    // --poll: check remote CI status
    if (args.includes('--poll')) {
      const wait   = args.includes('--wait');
      const result = await ci.poll({ wait });
      const icon   = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '🔄';
      return [
        `${icon} **CI Status [${result.provider || ci._provider}]**: ${result.status}`,
        ``,
        result.message,
        result.runUrl   ? `🔗 [View Run](${result.runUrl})` : '',
        result.commitSha ? `📌 Commit: \`${result.commitSha}\`` : '',
      ].filter(Boolean).join('\n');
    }

    // Default: run local pipeline
    const skipLint = args.includes('--skip-lint');
    const skipTest = args.includes('--skip-test');
    const result   = await ci.runLocalPipeline({ skipLint, skipTest });

    const icon = result.status === 'success' ? '✅' : '❌';
    const lines = [
      `${icon} **Local CI Pipeline**: ${result.status}`,
      ``,
      `| Step | Status | Duration | Output |`,
      `|------|--------|----------|--------|`,
    ];
    for (const s of result.steps) {
      const sIcon = s.passed ? '✅' : '❌';
      const dur   = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '–';
      lines.push(`| ${s.name} | ${sIcon} | ${dur} | ${(s.output || '').slice(0, 60).replace(/\n/g, ' ')} |`);
    }
    lines.push('');
    lines.push(result.message);
    return lines.join('\n');
  }
);


registerCommand(
  'report',
  'Generate an interactive HTML session report from the last workflow run',
  async (_args, _context) => {
    const { Observability } = require('../core/observability');
    const { PATHS }         = require('../core/constants');
    const metricsPath = path.join(PATHS.OUTPUT_DIR, 'run-metrics.json');

    if (!fs.existsSync(metricsPath)) {
      return `No metrics found. Run a workflow first to generate \`output/run-metrics.json\`.`;
    }

    let m;
    try {
      m = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    } catch (err) {
      return `❌ Failed to read metrics: ${err.message}`;
    }

    // Create a temporary Observability instance to generate the report
    const obs = new Observability(PATHS.OUTPUT_DIR, m.projectId || 'unknown');

    // Hydrate from saved metrics for HTML generation
    obs._sessionId  = m.sessionId;
    obs._startedAt  = new Date(m.startedAt).getTime();
    obs._testResult     = m.testResult;
    obs._entropyResult  = m.entropyResult;
    obs._ciResult       = m.ciResult;
    obs._codeGraphResult = m.codeGraphResult;
    obs._taskComplexity = m.taskComplexity;
    obs._clarificationQuality = m.clarificationQuality;

    // Reconstruct internal state for flush() to produce correct output
    for (const s of (m.stages || [])) {
      obs._stages.set(s.name, { start: new Date(m.startedAt).getTime(), end: new Date(m.startedAt).getTime() + (s.durationMs || 0), status: s.status, durationMs: s.durationMs });
    }
    for (const e of (m.errors?.details || [])) {
      obs._errors.push(e);
    }

    const reportPath = obs.generateHTMLReport({ metrics: m });
    return `## 📊 HTML Report Generated\n\nReport saved to: \`${reportPath}\`\n\nOpen in any browser to view the interactive session visualisation.`;
  }
);



registerCommand(
  'regenerate-agents',
  'Regenerate IDE Agent definition files (.codebuddy, .cursor, .claude) with the latest prompt template. [--path <dir>] [--target codebuddy|cursor|claude-code] [--workflow-source <dir>]',
  async (args, context) => {
    const { generateIDEAgents, PROMPT_VERSION } = require('../core/agent-generator');
    const { getConfig } = require('../core/config-loader');

    // Allow --path override
    const pathMatch   = args.match(/--path\s+(\S+)/);
    const projectRoot = pathMatch
      ? path.resolve(pathMatch[1])
      : (context.orchestrator?.projectRoot || path.resolve(__dirname, '..', '..'));

    // Allow --target filter
    const targetMatch = args.match(/--target\s+(\S+)/);
    const targets     = targetMatch ? [targetMatch[1]] : undefined;

    // Allow --workflow-source override (remote reference mode)
    const sourceMatch = args.match(/--workflow-source\s+(\S+)/);

    let config;
    try {
      config = getConfig(projectRoot);
    } catch (_) {
      config = { projectName: path.basename(projectRoot), techStack: 'Unknown' };
    }

    // CLI --workflow-source overrides config.workflowSource
    if (sourceMatch) {
      config.workflowSource = path.resolve(sourceMatch[1]);
    }

    try {
      const result = generateIDEAgents(projectRoot, config, {
        dryRun: false,
        force: true,   // Always overwrite — that's the whole point
        targets,
      });

      const lines = [
        `## 🔄 IDE Agent Files Regenerated (Prompt v${PROMPT_VERSION})`,
        ``,
      ];

      if (result.generated.length > 0) {
        lines.push(`### ✅ Generated`);
        result.generated.forEach(g => lines.push(`- ${g}`));
        lines.push('');
      }
      if (result.skipped.length > 0) {
        lines.push(`### ⏭️ Skipped`);
        result.skipped.forEach(s => lines.push(`- ${s}`));
        lines.push('');
      }
      if (result.errors.length > 0) {
        lines.push(`### ❌ Errors`);
        result.errors.forEach(e => lines.push(`- ${e}`));
        lines.push('');
      }

      lines.push(`> 💡 Restart your IDE or reload the project to pick up the updated agent definitions.`);

      if (result.hints && result.hints.length > 0) {
        lines.push('');
        result.hints.forEach(h => lines.push(h));
      }

      return lines.join('\n');
    } catch (err) {
      return `❌ Agent regeneration failed: ${err.message}`;
    }
  }
);



}

module.exports = { registerInfraCommands };
