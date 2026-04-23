/**
 * MCP Handlers - Core Workflow Tools
 * Extracted from mcp-server.js (Step 2 Refactoring)
 *
 * Handlers: workflow_triage, workflow_run, workflow_init, workflow_status
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Creates workflow tool handlers bound to an MCPServer instance
 * @param {MCPServer} server - The MCP server instance
 * @returns {object} Handler methods
 */
function createWorkflowHandlers(server) {
  return {
    async _handleWorkflowTriage(args) {
      const { requirement } = args;
      if (!requirement) {
        return server._toolResponse('Error: requirement is required', true);
      }

      const triage = server._getTriage();
      const result = triage.triage(requirement, { projectRoot: server._projectRoot });
      const mcpResult = triage.formatMCPResponse(result);
      const displayText = triage.formatTriageResult(result);

      return server._toolResponse(
        `## Requirement Triage\n\n${displayText}\n\n\`\`\`json\n${JSON.stringify(mcpResult, null, 2)}\n\`\`\``
      );
    },

    async _handleWorkflowRun(args) {
      const { requirement, mode = 'auto', force = false } = args;
      if (!requirement) {
        return server._toolResponse('Error: requirement is required', true);
      }

      if (!force) {
        const triage = server._getTriage();
        const triageResult = triage.triage(requirement, { projectRoot: server._projectRoot });

        if (triageResult.requiresInit) {
          return server._toolResponse(
            `❌ **Project Not Initialized**\n\n${triageResult.initState.reason}\n\n` +
            `Please run \`workflow_init\` first:\n\`\`\`bash\n` +
            `node workflow/init-project.js --path ${server._projectRoot}\n\`\`\``, true
          );
        }

        if (!triageResult.shouldProceed) {
          const displayText = triage.formatTriageResult(triageResult);
          return server._toolResponse(
            `${displayText}\n\nTo force workflow execution, call \`workflow_run\` with \`force: true\`.`
          );
        }

        if (triageResult.staleness?.isStale) {
          const warnings = triageResult.staleness.warnings.map(w => w.message).join('\n');
          server._log(`Staleness warnings:\n${warnings}`);
        }
      }

      if (!server._orchestratorFactory) {
        return server._toolResponse(
          `⚠️ Workflow execution unavailable. Start server with LLM provider configured.`
        );
      }

      if (server._currentWorkflow) {
        return server._toolResponse(
          `⚠️ A workflow is already running: "${server._currentWorkflow.requirement}"`, true
        );
      }

      try {
        const orchestrator = server._orchestratorFactory({ projectRoot: server._projectRoot });
        server._currentWorkflow = { requirement, startTime: new Date().toISOString() };
        server._log(`Starting workflow: "${requirement}" (mode: ${mode})`);

        if (mode === 'parallel' || mode === 'auto') {
          await orchestrator.runAuto(requirement);
        } else {
          await orchestrator.run(requirement);
        }

        server._currentWorkflow = null;
        return server._toolResponse(
          `✅ **Workflow Complete**\n\n**Requirement**: ${requirement}\n**Mode**: ${mode}`
        );
      } catch (err) {
        server._currentWorkflow = null;
        return server._toolResponse(`❌ **Workflow Failed**\n\n**Error**: ${err.message}`, true);
      }
    },

    async _handleWorkflowInit(args) {
      const targetRoot = args.projectPath || server._projectRoot;
      const dryRun = args.dryRun || false;
      const scriptPath = path.join(__dirname, '..', '..', '..', 'init-project.js');

      if (!fs.existsSync(scriptPath)) {
        return server._toolResponse(`❌ init-project.js not found at: ${scriptPath}`, true);
      }

      try {
        const spawnArgs = [scriptPath, '--path', targetRoot];
        if (dryRun) spawnArgs.push('--dry-run');
        server._log(`Running: node ${spawnArgs.join(' ')}`);

        const output = await new Promise((resolve, reject) => {
          const chunks = [];
          const child = spawn(process.execPath, spawnArgs, { cwd: targetRoot, timeout: 120000 });
          child.stdout.on('data', d => chunks.push(d.toString()));
          child.stderr.on('data', d => chunks.push(d.toString()));
          child.on('close', code => {
            const result = chunks.join('');
            code === 0 ? resolve(result) : reject(new Error(`Init failed (exit ${code}):\n${result.slice(-500)}`));
          });
          child.on('error', reject);
        });

        return server._toolResponse(
          `✅ **Workflow Initialization Complete**\n\n\`\`\`\n${output.slice(-2000)}\n\`\`\``
        );
      } catch (err) {
        return server._toolResponse(`❌ **Initialization Failed**\n\n${err.message}`, true);
      }
    },

    async _handleWorkflowStatus() {
      const triage = server._getTriage();
      const initState = triage.checkInitState(server._projectRoot);
      const staleness = triage.checkStaleness(server._projectRoot);

      const lines = [
        `## WorkFlowAgent Status`, ``,
        `**Project Root**: ${server._projectRoot}`,
        `**MCP Server**: workflowagent v1.0.0`, ``,
        `### Initialization`,
        `- **Initialized**: ${initState.isInitialized ? '✅ Yes' : '❌ No'}`,
        `- **Fully Initialized**: ${initState.isFullyInitialized ? '✅ Yes' : '⚠️ Partial'}`,
      ];

      if (initState.details.hasConfig) {
        lines.push(`- **Config**: ✅ ${initState.details.configPath}`);
      } else {
        lines.push(`- **Config**: ❌ Not found`);
      }

      lines.push(
        `- **CodeGraph**: ${initState.details.hasCodeGraph ? '✅ Yes' : '❌ No'}`,
        `- **Project Profile**: ${initState.details.hasProjectProfile ? '✅ Yes' : '❌ No'}`,
        `- **AGENTS.md**: ${initState.details.hasAgentsMd ? '✅ Yes' : '❌ No'}`
      );

      if (staleness.isStale) {
        lines.push(``, `### ⚠️ Staleness Warnings`);
        staleness.warnings.forEach(w => lines.push(`- ${w.message}`));
      }

      if (server._currentWorkflow) {
        lines.push(
          ``, `### 🔄 Active Workflow`,
          `- **Requirement**: ${server._currentWorkflow.requirement}`,
          `- **Started**: ${server._currentWorkflow.startTime}`
        );
      }

      return server._toolResponse(lines.join('\n'));
    },
  };
}

module.exports = { createWorkflowHandlers };
