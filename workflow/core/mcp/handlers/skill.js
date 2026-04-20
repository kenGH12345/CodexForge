/**
 * MCP Handlers - Skill Management Tools
 * Extracted from mcp-server.js (Step 2 Refactoring)
 *
 * Handlers: workflow_skill_discover, workflow_skill_evolve,
 *           workflow_skill_update, workflow_skill_refine_check
 */

'use strict';

function createSkillHandlers(server) {
  return {
    async _handleSkillDiscover(args) {
      const projectPath = args.projectPath || server._projectRoot;
      try {
const { runSkillDiscover } = require('../../../tools/ide-workflow-bridge');
        const result = await runSkillDiscover({ projectRoot: projectPath });

        if (result.success) {
          return server._toolResponse(
            `✅ **Skill Discovery Complete**\n\n**Discovered**: ${result.discoveredCount} convention(s)\n` +
            `**Project**: ${result.projectRoot}\n\n` +
            `${result.discoveredSkills?.map(s => `- ${s}`).join('\n') || 'No new skills discovered'}`
          );
        }
        return server._toolResponse(`❌ **Discovery Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Discovery Error**: ${err.message}`, true);
      }
    },

    async _handleSkillEvolve(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const skillName = args.skillName;

      try {
const { runSkillEvolve } = require('../../../tools/ide-workflow-bridge');
        const result = await runSkillEvolve({ projectRoot: projectPath, skillName });

        if (result.success) {
          return server._toolResponse(
            `✅ **Skill Evolution Complete**\n\n**Skills Evolved**: ${result.evolvedSkills?.length || 0}\n` +
            `**New Experiences**: ${result.newExperienceCount || 0}\n\n` +
            `${result.evolvedSkills?.map(s => `- ${s.name}: ${s.experienceCount} experiences consolidated`).join('\n') || 'No skills evolved'}`
          );
        }
        return server._toolResponse(`❌ **Evolution Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Evolution Error**: ${err.message}`, true);
      }
    },

    async _handleSkillUpdate(args) {
      const { skillName, section, content } = args;
      const projectPath = args.projectPath || server._projectRoot;

      if (!skillName || !section || !content) {
        return server._toolResponse('Error: skillName, section, and content are required', true);
      }

      try {
const { runSkillUpdate } = require('../../../tools/ide-workflow-bridge');
        const result = await runSkillUpdate({ projectRoot: projectPath, skillName, section, content });

        if (result.success) {
          return server._toolResponse(
            `✅ **Skill Updated**\n\n**Skill**: ${result.skillName}\n` +
            `**Section**: ${result.section}\n**New Version**: ${result.newVersion}`
          );
        }
        return server._toolResponse(`❌ **Update Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Update Error**: ${err.message}`, true);
      }
    },

    async _handleSkillRefineCheck(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const threshold = args.threshold || 5;

      try {
const { runSkillRefineCheck } = require('../../../tools/ide-workflow-bridge');
        const bridgeArgs = { projectRoot: projectPath, threshold };
        if (server._llmCall) bridgeArgs.llmCall = server._llmCall;

        const result = await runSkillRefineCheck(bridgeArgs);

        if (result.success) {
          const data = result.data || {};
          const allCandidates = [
            ...(data.candidates?.needsRefine || []),
            ...(data.candidates?.needsFix || []),
            ...(data.candidates?.stale || []),
            ...(data.candidates?.hollow || []),
          ];

          if (allCandidates.length === 0) {
            return server._toolResponse(`✅ **No Skills Need Refinement**\n\nAll skills are within healthy thresholds.`);
          }

          let response = `📋 **Skills Needing Refinement** (${allCandidates.length})\n\n`;
          response += allCandidates.map(c => `- **${c.name}**: ${c.reason}`).join('\n');

          if (data.llmAutoRefined && data.llmAutoRefined > 0) {
            response += `\n\n🤖 **LLM Auto-Refinement**: ${data.llmAutoRefined} skill(s) refined`;
          }

          return server._toolResponse(response);
        }
        return server._toolResponse(`❌ **Check Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Check Error**: ${err.message}`, true);
      }
    },
  };
}

module.exports = { createSkillHandlers };
