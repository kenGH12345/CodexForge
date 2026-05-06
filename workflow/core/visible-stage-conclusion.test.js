'use strict';

const assert = require('assert');
const { __testHooks } = require('../tools/ide-workflow-bridge');

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

test('builds user-visible stage conclusion before next stage', () => {
  const conclusion = __testHooks._buildVisibleStageConclusion({
    stage: 'ANALYSE',
    stageNumber: 1,
    totalStages: 7,
    summary: '定位 stage-complete 只要求继续执行，未要求输出阶段结论',
    outputArtifact: 'output/analysis.md',
    outputExists: true,
    outputSize: ' (1234 bytes)',
    metricsLine: '  metrics  : ✅ PASSED (errors:0 duration:n/a llmCalls:n/a)',
    nextStage: 'ARCHITECT',
    remainingStages: ['ARCHITECT', 'PLAN'],
  });

  assert(conclusion.includes('✅ Stage 1/7 ANALYSE done'));
  assert(conclusion.includes('结论：定位 stage-complete'));
  assert(conclusion.includes('产物：output/analysis.md (1234 bytes)'));
  assert(conclusion.includes('metrics  : ✅ PASSED'));
  assert(conclusion.includes('下一步：ARCHITECT'));
});

test('builds workflow-complete visible conclusion', () => {
  const conclusion = __testHooks._buildVisibleStageConclusion({
    stage: 'DEPLOY',
    stageNumber: 7,
    totalStages: 7,
    summary: 'ready to merge',
    outputArtifact: 'output/deploy-output.md',
    outputExists: true,
    workflowComplete: true,
  });

  assert(conclusion.includes('✅ Stage 7/7 DEPLOY done — workflow complete'));
  assert(conclusion.includes('下一步：输出最终总结 / session-summary'));
});

if (process.exitCode) process.exit(process.exitCode);
