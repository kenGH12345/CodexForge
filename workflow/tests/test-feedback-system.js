/**
 * Test: Agent Feedback System & Enhanced Tracing
 */

'use strict';

const { AgentFeedbackSystem } = require('../core/agent-feedback-system');
const { ExecutionGraph } = require('../core/agent-handoff-log');
const path = require('path');

const TEST_OUTPUT_DIR = path.join(__dirname, '..', '..', 'output', 'test-feedback');

async function testExecutionGraph() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Testing ExecutionGraph Critical Path Analysis');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const graph = new ExecutionGraph();

  const stages = [
    { agentId: 'INIT', durationMs: 2300, input: { size: 100 }, output: { size: 500 } },
    { agentId: 'ANALYST', durationMs: 45200, input: { size: 2000 }, output: { size: 8000 } },
    { agentId: 'ARCHITECT', durationMs: 72000, input: { size: 10000 }, output: { size: 12000 } },
    { agentId: 'PLANNER', durationMs: 58400, input: { size: 12000 }, output: { size: 15000 } },
    { agentId: 'DEVELOPER', durationMs: 135000, input: { size: 15000 }, output: { size: 25000 } },
    { agentId: 'TESTER', durationMs: 18700, input: { size: 25000 }, output: { size: 6000 } },
  ];

  stages.forEach(s => graph.addNode({
    agentId: s.agentId,
    input: s.input,
    output: s.output,
    performance: { duration: s.durationMs },
  }));

  for (let i = 0; i < stages.length - 1; i++) {
    graph.addEdge(stages[i].agentId, stages[i + 1].agentId, 'artifact');
  }

  const criticalPath = graph.findCriticalPath();
  console.log('✅ Critical Path Found:');
  console.log(`   Total Duration: ${(criticalPath.totalDuration / 1000).toFixed(1)}s`);
  criticalPath.nodes.forEach((n, i) => {
    const emoji = n.impact > 0.3 ? '🔴' : n.impact > 0.15 ? '🟡' : '🟢';
    console.log(`   ${i + 1}. ${emoji} ${n.id}: ${(n.durationMs / 1000).toFixed(1)}s (${(n.impact * 100).toFixed(1)}%)`);
  });

  const bottlenecks = graph.findBottlenecks(0.15);
  console.log('\n✅ Bottlenecks:');
  bottlenecks.forEach(b => console.log(`   • ${b.stage}: ${(b.impact * 100).toFixed(1)}% impact`));

  console.log('\n✅ Mermaid Diagram:');
  console.log(graph.toMermaid().split('\n').slice(0, 8).join('\n'));

  return true;
}

async function testAgentFeedbackSystem() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('Testing Agent Feedback System');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const feedbackSystem = new AgentFeedbackSystem({
    outputDir: TEST_OUTPUT_DIR,
    sessionId: 'test-session-001',
    verbose: false,
  });

  console.log('1. Collecting feedback...');
  feedbackSystem.collectFeedback('TESTER', 'DEVELOPER', {
    type: 'quality',
    score: 0.85,
    issues: [{ type: 'missing_tests', message: 'Edge cases needed', severity: 'medium' }],
    comments: 'Good implementation overall.',
  });

  feedbackSystem.collectFeedback('TESTER', 'DEVELOPER', {
    type: 'quality',
    score: 0.60,
    issues: [
      { type: 'missing_tests', message: 'Critical path not tested', severity: 'high' },
    ],
    comments: 'Significant coverage gaps.',
  });

  console.log('2. Generating report...');
  const report = feedbackSystem.generatePerformanceReport('DEVELOPER');
  console.log(`   Overall Score: ${(report.overallScore * 100).toFixed(1)}%`);
  console.log(`   Category: ${report.category.label}`);
  console.log(`   Feedback Count: ${report.feedbackCount}`);

  const reportPath = feedbackSystem.saveFeedbackReport();
  console.log(`\n✅ Report saved to: ${reportPath}`);

  return true;
}

async function runTests() {
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║   AGENT FEEDBACK SYSTEM & ENHANCED TRACING TESTS             ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  let passed = 0;
  let failed = 0;

  try {
    await testExecutionGraph();
    passed++;
  } catch (err) {
    console.error('❌ ExecutionGraph failed:', err.message);
    failed++;
  }

  try {
    await testAgentFeedbackSystem();
    passed++;
  } catch (err) {
    console.error('❌ AgentFeedbackSystem failed:', err.message);
    failed++;
  }

  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║                         TEST SUMMARY                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`\n   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);

  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };