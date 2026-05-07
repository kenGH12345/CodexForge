'use strict';

function createContextHandlers(server) {
  return {
    async _handleContext(args) {
      const { stage, task } = args;
      const projectPath = args.projectPath || server._projectRoot;

      if (!stage || !task) {
        return server._toolResponse('Error: stage and task are required', true);
      }

      try {
        const { runContext } = require('../../tools/ide-workflow-bridge');
        const result = await runContext({ projectRoot: projectPath, stage, task });

        if (result.success) {
          return server._toolResponse(
            `🎯 **Context for ${stage} Stage**\n\n` +
            `**Task**: ${task}\n` +
            `**Matched Skills**: ${(result.matchedSkills || []).join(', ') || 'none'}\n` +
            `**Context Size**: ${result.contextLength} chars\n\n` +
            `${result.context}`
          );
        }
        return server._toolResponse(`❌ **Context Load Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Context Error**: ${err.message}`, true);
      }
    },

    async _handleBuildAgentPrompt(args) {
      const { stage, task } = args;
      const projectPath = args.projectPath || server._projectRoot;

      if (!stage || !task) {
        return server._toolResponse('Error: stage and task are required', true);
      }

      try {
        const { runBuildAgentPrompt } = require('../../tools/ide-workflow-bridge');
        const result = await runBuildAgentPrompt({ projectRoot: projectPath, stage, task });

        if (result.success) {
          return server._toolResponse(
            `🤖 **Agent Prompt for ${stage}**\n\n` +
            `**Role**: ${result.role}\n` +
            `**Constraints**: ${(result.constraints || []).length} items\n` +
            `**Context Skills**: ${(result.context?.matchedSkills || []).join(', ') || 'none'}\n\n` +
            `---\n\n${result.prompt}`
          );
        }
        return server._toolResponse(`❌ **Prompt Build Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Prompt Error**: ${err.message}`, true);
      }
    },
  };
}

module.exports = { createContextHandlers };