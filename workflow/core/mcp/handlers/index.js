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
const { createContextHandlers } = require('./context');
const { createTestingHandlers } = require('./testing');

function createAllHandlers(server) {
  const workflow = createWorkflowHandlers(server);
  const skill = createSkillHandlers(server);
  const experience = createExperienceHandlers(server);
  const quality = createQualityHandlers(server);
  const context = createContextHandlers(server);
  const testing = createTestingHandlers(server);

  return {
    _handleWorkflowTriage: workflow._handleWorkflowTriage.bind(workflow),
    _handleWorkflowRun: workflow._handleWorkflowRun.bind(workflow),
    _handleWorkflowInit: workflow._handleWorkflowInit.bind(workflow),
    _handleWorkflowStatus: workflow._handleWorkflowStatus.bind(workflow),

    _handleSkillDiscover: skill._handleSkillDiscover.bind(skill),
    _handleSkillEvolve: skill._handleSkillEvolve.bind(skill),
    _handleSkillUpdate: skill._handleSkillUpdate.bind(skill),
    _handleSkillRefineCheck: skill._handleSkillRefineCheck.bind(skill),

    _handleExperienceSearch: experience._handleExperienceSearch.bind(experience),
    _handleExperienceContext: experience._handleExperienceContext.bind(experience),
    _handleExperienceRecord: experience._handleExperienceRecord.bind(experience),
    _handleExperienceEvolve: experience._handleExperienceEvolve.bind(experience),

    _handleQualityCheck: quality._handleQualityCheck.bind(quality),
    _handleQualityGate: quality._handleQualityGate.bind(quality),
    _handleDeepAudit: quality._handleDeepAudit.bind(quality),
    _handleRollbackCheck: quality._handleRollbackCheck.bind(quality),

    _handleContext: context._handleContext.bind(context),
    _handleBuildAgentPrompt: context._handleBuildAgentPrompt.bind(context),

    _handleTestExecute: testing._handleTestExecute.bind(testing),
    _handleStalenessCheck: testing._handleStalenessCheck.bind(testing),
    _handleQualityGateValidateStage: testing._handleQualityGateValidateStage.bind(testing),
    _handleQualityGateDiagnostics: testing._handleQualityGateDiagnostics.bind(testing),
  };
}

module.exports = { createAllHandlers };
