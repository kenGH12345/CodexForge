'use strict';

const assert = require('assert');
const {
  buildRequiredObservation,
  renderRequiredSchemaPrompt,
} = require('./stage-context');

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

const analysisSchema = {
  file: 'analysis.md',
  requiredSections: ['## 根因', '## 修改范围', '## 风险评估'],
  recommendedSections: ['## 受影响位置'],
  requiredSlots: [
    { id: 'root_cause', description: 'Root cause analysis', minContentLines: 3 },
    { id: 'change_scope', description: 'Change scope', minContentLines: 3 },
    { id: 'downstream_consumers', description: 'Downstream consumers', minContentLines: 2 },
    { id: 'risk_assessment', description: 'Risk assessment', minContentLines: 2 },
  ],
  forbiddenSections: ['## User Stories'],
  evidenceMinMatches: 2,
};

const architectSchema = {
  file: 'architecture.md',
  requiredSlots: [
    { id: 'scorecard', description: 'Architecture Scorecard', minContentLines: 3 },
    { id: 'failure_model', description: 'Failure Model', minContentLines: 3 },
    { id: 'migration_safety', description: 'Migration Safety', minContentLines: 3 },
    { id: 'scenario_coverage', description: 'Scenario Coverage', minContentLines: 3 },
    { id: 'consumer_adoption_design', description: 'Consumer Adoption Design', minContentLines: 2 },
  ],
};

test('buildRequiredObservation describes required semantic slots, not only section headings', () => {
  const observation = buildRequiredObservation('ANALYSE', 'diagnose repeated analysis writes', {
    outputPath: 'output/analysis.md',
    requiredSchema: analysisSchema,
  });

  assert(observation.instruction.includes('root_cause'));
  assert(observation.instruction.includes('downstream_consumers'));
  assert(observation.instruction.includes('semantic slots'));
  assert(observation.schemaPrompt.includes('## 下游消费影响 / Downstream Consumers'));
});

test('renderRequiredSchemaPrompt renders ANALYSE quality guards from schema', () => {
  const prompt = renderRequiredSchemaPrompt('ANALYSE', 'output/analysis.md', analysisSchema);

  assert(prompt.includes('Required semantic slots'));
  assert(prompt.includes('## 根因 / Root Cause'));
  assert(prompt.includes('## 下游消费影响 / Downstream Consumers'));
  assert(prompt.includes('Forbidden sections: ## User Stories'));
  assert(prompt.includes('Evidence requirement'));
  assert(prompt.includes('Do not satisfy this with empty headings'));
});

test('renderRequiredSchemaPrompt renders ARCHITECT required slots without hand-written stage prompt', () => {
  const prompt = renderRequiredSchemaPrompt('ARCHITECT', 'output/architecture.md', architectSchema);

  assert(prompt.includes('## Architecture Scorecard / 架构评分卡'));
  assert(prompt.includes('## Failure Model / 失败模型'));
  assert(prompt.includes('## Migration Safety Case / 迁移安全'));
  assert(prompt.includes('## Scenario Coverage / 场景覆盖'));
  assert(prompt.includes('## Consumer Adoption Design / 下游消费方案'));
});

if (process.exitCode) process.exit(process.exitCode);
