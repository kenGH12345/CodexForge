'use strict';

const assert = require('assert');
const { renderRequiredSchemaPrompt } = require('./stage-context');
const { __testHooks } = require('../tools/ide-workflow-bridge');

const { ARTIFACT_SCHEMA } = __testHooks;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function assertIncludesAll(text, expected, label) {
  for (const item of expected) {
    assert(text.includes(item), `${label} should include: ${item}\nActual:\n${text}`);
  }
}

function rendered(stage) {
  const schema = ARTIFACT_SCHEMA[stage];
  assert(schema, `Missing ARTIFACT_SCHEMA for ${stage}`);
  const prompt = renderRequiredSchemaPrompt(stage, `output/${schema.file}`, schema);
  assert(prompt && typeof prompt === 'string', `${stage} prompt should be rendered`);
  return { schema, prompt };
}

const SNAPSHOTS = {
  ANALYSE: {
    promptIncludes: [
      '⚠️ ANALYSE output schema for output/analysis.md',
      'Required semantic slots:',
      '## 根因 / Root Cause',
      '## 修改范围 / Change Scope',
      '## 下游消费影响 / Downstream Consumers',
      '## 风险评估 / Risk Assessment',
      'Recommended sections: ## 受影响位置, ## 思考摘要',
      'Forbidden sections: ## User Stories, ## Functional Requirements, ## Non-Functional Requirements, ## Acceptance Criteria, ## Assumptions, ## Open Questions, ## Overview, ## Socratic Validation',
      'Evidence requirement: include concrete code/tool evidence matching at least 2 evidence pattern(s).',
      'Do not satisfy this with empty headings',
    ],
    requiredSlotIds: ['root_cause', 'change_scope', 'downstream_consumers', 'risk_assessment'],
    forbiddenSections: ['## User Stories', '## Functional Requirements', '## Acceptance Criteria', '## Socratic Validation'],
    evidenceMinMatches: 2,
  },
  ARCHITECT: {
    promptIncludes: [
      '⚠️ ARCHITECT output schema for output/architecture.md',
      'Required semantic slots:',
      '## Architecture Scorecard / 架构评分卡',
      '## Failure Model / 失败模型',
      '## Migration Safety Case / 迁移安全',
      '## Scenario Coverage / 场景覆盖',
      '## Consumer Adoption Design / 下游消费方案',
      'Evidence requirement: include concrete code/tool evidence matching at least 1 evidence pattern(s).',
      'Do not satisfy this with empty headings',
    ],
    requiredSlotIds: ['scorecard', 'failure_model', 'migration_safety', 'scenario_coverage', 'consumer_adoption_design'],
    forbiddenSections: [],
    evidenceMinMatches: 1,
  },
  PLAN: {
    promptIncludes: [
      '⚠️ PLAN output schema for output/execution-plan.md',
      'Required sections/patterns:',
      '## ',
      'Forbidden sections: ## User Stories, ## Functional Requirements, ## Non-Functional Requirements, ## Acceptance Criteria, ## Assumptions, ## Open Questions, ## Overview, # Requirement Analysis',
      'Evidence requirement: include concrete code/tool evidence matching at least 1 evidence pattern(s).',
      'Do not satisfy this with empty headings',
    ],
    requiredSlotIds: [],
    forbiddenSections: ['## User Stories', '## Functional Requirements', '## Acceptance Criteria', '# Requirement Analysis'],
    evidenceMinMatches: 1,
  },
  TEST: {
    promptIncludes: [
      '⚠️ TEST output schema for output/test-report.md',
      'Required sections/patterns:',
      '## ',
      'Evidence requirement: include concrete code/tool evidence matching at least 3 evidence pattern(s).',
      'Do not satisfy this with empty headings',
    ],
    requiredSlotIds: [],
    forbiddenSections: [],
    evidenceMinMatches: 3,
  },
};

for (const stage of ['ANALYSE', 'ARCHITECT', 'PLAN', 'TEST']) {
  test(`${stage}: rendered prompt matches schema snapshot`, () => {
    const { prompt } = rendered(stage);
    assertIncludesAll(prompt, SNAPSHOTS[stage].promptIncludes, stage);
  });

  test(`${stage}: requiredSlots snapshot matches ARTIFACT_SCHEMA`, () => {
    const { schema } = rendered(stage);
    const ids = (schema.requiredSlots || []).map(slot => slot.id);
    assert.deepStrictEqual(ids, SNAPSHOTS[stage].requiredSlotIds);
  });

  test(`${stage}: forbiddenSections snapshot matches ARTIFACT_SCHEMA`, () => {
    const { schema, prompt } = rendered(stage);
    const forbidden = schema.forbiddenSections || [];
    for (const expected of SNAPSHOTS[stage].forbiddenSections) {
      assert(forbidden.includes(expected), `${stage} schema should forbid ${expected}`);
      assert(prompt.includes(expected), `${stage} prompt should render forbidden section ${expected}`);
    }
    if (SNAPSHOTS[stage].forbiddenSections.length === 0) {
      assert(!prompt.includes('Forbidden sections:'), `${stage} prompt should not render empty forbidden section list`);
    }
  });

  test(`${stage}: evidence requirement snapshot matches ARTIFACT_SCHEMA`, () => {
    const { schema, prompt } = rendered(stage);
    assert.strictEqual(schema.evidenceMinMatches, SNAPSHOTS[stage].evidenceMinMatches);
    assert(prompt.includes(`at least ${schema.evidenceMinMatches} evidence pattern(s)`));
    assert(Array.isArray(schema.evidencePatterns) && schema.evidencePatterns.length >= schema.evidenceMinMatches);
  });
}

if (process.exitCode) process.exit(process.exitCode);
