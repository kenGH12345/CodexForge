/**
 * MCP Handlers - Index / Router
 * Extracted from mcp-server.js (Step 2 Refactoring)
 *
 * Central entry point that composes all handler modules
 */

'use strict';

const { createWorkflowHandlers } = require('./workflow');
const { createSkillHandlers } = require('./skill');
const { createExperienceHandlers } = require('./experience');
const { createQualityHandlers } = require('./quality');

/**
 * Creates all MCP tool handlers bound to an MCPServer instance
 * @param {MCPServer} server - The MCP server instance
 * @returns {object} All handler methods keyed by method name
 */
function createAllHandlers(server) {
  const workflow = createWorkflowHandlers(server);
  const skill = createSkillHandlers(server);
  const experience = createExperienceHandlers(server);
  const quality = createQualityHandlers(server);

  return {
    // Workflow handlers
    _handleWorkflowTriage: workflow._handleWorkflowTriage.bind(workflow),
    _handleWorkflowRun: workflow._handleWorkflowRun.bind(workflow),
    _handleWorkflowInit: workflow._handleWorkflowInit.bind(workflow),
    _handleWorkflowStatus: workflow._handleWorkflowStatus.bind(workflow),

    // Skill handlers
    _handleSkillDiscover: skill._handleSkillDiscover.bind(skill),
    _handleSkillEvolve: skill._handleSkillEvolve.bind(skill),
    _handleSkillUpdate: skill._handleSkillUpdate.bind(skill),
    _handleSkillRefineCheck: skill._handleSkillRefineCheck.bind(skill),

    // Experience handlers
    _handleExperienceSearch: experience._handleExperienceSearch.bind(experience),
    _handleExperienceContext: experience._handleExperienceContext.bind(experience),
    _handleExperienceRecord: experience._handleExperienceRecord.bind(experience),
    _handleExperienceEvolve: experience._handleExperienceEvolve.bind(experience),

    // Quality handlers
    _handleQualityCheck: quality._handleQualityCheck.bind(quality),
    _handleQualityGate: quality._handleQualityGate.bind(quality),
    _handleDeepAudit: quality._handleDeepAudit.bind(quality),
    _handleRollbackCheck: quality._handleRollbackCheck.bind(quality),
    _handleQualityGateValidateStage: quality._handleQualityGateValidateStage.bind(quality),
    _handleQualityGateDiagnostics: quality._handleQualityGateDiagnostics.bind(quality),
  };
}

module.exports = { createAllHandlers };
