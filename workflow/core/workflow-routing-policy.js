'use strict';

const WF_PIPELINE_STAGES = ['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST'];
const WF_PIPELINE_LABEL = WF_PIPELINE_STAGES.join(' → ');

const WF_ROUTING_POLICY = Object.freeze({
  alwaysRunFullWorkflow: true,
  triageAdvisoryOnly: true,
  complexityBypassDisabled: true,
  initStateGuardEnabled: true,
  stalenessWarningEnabled: true,
});

const WF_DEFAULT_BEHAVIOUR_LINES = Object.freeze([
  `/wf <requirement> ALWAYS runs the FULL sequential pipeline: ${WF_PIPELINE_LABEL}`,
  `All /wf commands trigger complete workflow execution (no complexity restrictions)`,
  `RequestTriage is advisory-only for /wf routing (never skip pipeline by complexity)`,
]);

const WF_ROUTING_HINT = 'All /wf commands run the full workflow pipeline. No complexity restrictions.';

module.exports = {
  WF_PIPELINE_STAGES,
  WF_PIPELINE_LABEL,
  WF_ROUTING_POLICY,
  WF_DEFAULT_BEHAVIOUR_LINES,
  WF_ROUTING_HINT,
};