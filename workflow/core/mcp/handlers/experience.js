/**
 * MCP Handlers - Experience Store Tools
 * Extracted from mcp-server.js (Step 2 Refactoring)
 *
 * Handlers: workflow_experience_search, workflow_experience_context,
 *           workflow_experience_record, workflow_experience_evolve
 */

'use strict';

function createExperienceHandlers(server) {
  return {
    async _handleExperienceSearch(args) {
      const { query } = args;
      const projectPath = args.projectPath || server._projectRoot;
      const limit = args.limit || 10;

      if (!query) {
        return server._toolResponse('Error: query is required', true);
      }

      try {
const { runExperienceSearch } = require('../../../tools/ide-workflow-bridge');
        const result = await runExperienceSearch({ projectRoot: projectPath, query, skill: args.skill, tags: args.tags, limit });

        if (result.success) {
          const experiences = result.experiences || [];
          if (experiences.length === 0) {
            return server._toolResponse(`🔍 **No Experiences Found**\n\nQuery: "${query}"`);
          }

          return server._toolResponse(
            `📚 **Experience Search Results** (${experiences.length})\n\n**Query**: "${query}"\n\n` +
            experiences.map((exp, i) =>
              `**${i + 1}. ${exp.title}**\n- Skill: ${exp.skill || 'none'}\n` +
              `- Tags: ${(exp.tags || []).join(', ') || 'none'}\n` +
              `- Relevance: ${(exp.relevanceScore * 100).toFixed(0)}%\n` +
              `- Content: ${(exp.content || '').slice(0, 200)}...`
            ).join('\n\n')
          );
        }
        return server._toolResponse(`❌ **Search Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Search Error**: ${err.message}`, true);
      }
    },

    async _handleExperienceContext(args) {
      const { skill } = args;
      const projectPath = args.projectPath || server._projectRoot;
      const limit = args.limit || 5;

      if (!skill) {
        return server._toolResponse('Error: skill is required', true);
      }

      try {
const { runExperienceContext } = require('../../../tools/ide-workflow-bridge');
        const result = await runExperienceContext({ projectRoot: projectPath, skill, limit });

        if (result.success) {
          return server._toolResponse(
            `📖 **Experience Context for "${result.skill}"**\n\n` +
            `**Statistics**: ${result.contextStats?.totalExperiences || 0} experiences, ` +
            `${result.contextStats?.totalTokens || 0} tokens\n\n${result.contextBlock}`
          );
        }
        return server._toolResponse(`❌ **Context Load Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Context Error**: ${err.message}`, true);
      }
    },

    async _handleExperienceRecord(args) {
      const { title, content, skill } = args;
      const projectPath = args.projectPath || server._projectRoot;

      if (!title || !content || !skill) {
        return server._toolResponse('Error: title, content, and skill are required', true);
      }

      try {
const { runExperienceRecord } = require('../../../tools/ide-workflow-bridge');
        const result = await runExperienceRecord({
          projectRoot: projectPath, title, content, skill,
          tags: args.tags, outcome: args.outcome || 'success',
        });

        if (result.success) {
          return server._toolResponse(
            `✅ **Experience Recorded**\n\n**ID**: ${result.experienceId}\n` +
            `**Title**: ${result.title}\n**Skill**: ${result.skill}\n` +
            `**Content Hash**: ${result.contentHash}`
          );
        }
        return server._toolResponse(`❌ **Recording Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Recording Error**: ${err.message}`, true);
      }
    },

    async _handleExperienceEvolve(args) {
      const projectPath = args.projectPath || server._projectRoot;
      const dryRun = args.dryRun || false;

      try {
const { runExperienceEvolve } = require('../../../tools/ide-workflow-bridge');
        const result = await runExperienceEvolve({ projectRoot: projectPath, dryRun });

        if (result.success) {
          const consolidation = result.consolidation || {};
          return server._toolResponse(
            `✅ **Experience Evolution Complete**\n\n**Mode**: ${dryRun ? 'Dry Run' : 'Applied'}\n` +
            `**Candidates**: ${consolidation.candidates || 0}\n` +
            `**Consolidated**: ${consolidation.consolidatedSets || 0} sets\n` +
            `**Distilled**: ${result.distillation?.distilledExperiences || 0}\n` +
            `**Archived**: ${result.distillation?.archivedExperiences || 0}\n` +
            `**New Skills**: ${result.consolidation?.newSkills?.length || 0}`
          );
        }
        return server._toolResponse(`❌ **Evolution Failed**\n\n${result.error}`, true);
      } catch (err) {
        return server._toolResponse(`❌ **Evolution Error**: ${err.message}`, true);
      }
    },
  };
}

module.exports = { createExperienceHandlers };
