# Agent Feedback System & Enhanced Tracing Usage Guide

This document provides examples of how to use the new **Agent Feedback System** and **Enhanced Execution Tracing** features.

## Phase 1: Enhanced Tracing (Completed ✓)

The enhanced tracing adds critical path analysis and bottleneck identification to the existing handoff log.

### Basic Usage

```javascript
const { AgentHandoffLog, ExecutionGraph } = require('../core/agent-handoff-log');

// Initialize handoff log (done automatically by orchestrator)
const handoffLog = new AgentHandoffLog({
  outputDir: './output',
  sessionId: 'my-session-123',
  verbose: true,
});

// Record enhanced tracing data during handoff
function onAgentComplete(fromAgent, toAgent, input, output, durationMs) {
  const entry = handoffLog.complete(toAgent, true, {
    duration: durationMs,
    tokens: output.length / 4, // rough estimate
  });

  // Add enhanced tracing data
  handoffLog.recordEnhancedTracing(toAgent, 
    { content: input, schema: 'markdown' },
    { content: output }
  );
}

// After workflow completes, analyze the execution path
const analysis = handoffLog.analyzeExecutionPath();
console.log('Critical path:', analysis.criticalPath);
console.log('Bottlenecks:', analysis.bottlenecks);

// Print visual report
handoffLog.printCriticalPathAnalysis();

// Automatic: saved to output/execution-analysis.json
```

### Example Output

```
══════════════════════════════════════════════════════════════════════
           🔍 C R I T I C A L   P A T H   A N A L Y S I S
══════════════════════════════════════════════════════════════════════

  📊 Critical Path (5 stages, 4m 32s)
    1. 🟢 INIT         2.3s       (0.8%)
    2. 🟢 ANALYSE      45.2s      (16.6%)
    3. 🟡 ARCHITECT    1m 12s     (26.5%)
    4. 🟡 PLANNER      58.4s      (21.5%)
    5. 🔴 DEVELOPER    2m 15s     (49.6%)  <-- Bottleneck
    6. 🟢 TESTER       18.7s      (6.8%)

  ⚠️  Identified Bottlenecks:
     • DEVELOPER: 49.6% of total time
     • PLANNER: 21.5% of total time

  💡 Optimization Suggestions:
     🔴 DEVELOPER accounts for 49.6% of total time. Consider: 
        1) Parallel processing, 2) Model tier optimization, 
        3) Input size reduction (current: 15420 chars)
     🟡 PLANNER is a moderate bottleneck (21.5%). 
        Review prompt efficiency and model selection.
══════════════════════════════════════════════════════════════════════
```

### Execution Graph API

```javascript
const { ExecutionGraph } = require('../core/agent-handoff-log');

const graph = new ExecutionGraph();

// Add nodes (usually done automatically from handoff log)
graph.addNode({
  agentId: 'DEVELOPER',
  input: { size: 15000 },
  output: { size: 25000 },
  performance: { duration: 135000 }, // 2m 15s
});

// Add dependency edges
graph.addEdge('PLANNER', 'DEVELOPER', 'plan.md');
graph.addEdge('DEVELOPER', 'TESTER', 'code');

// Analyze
const criticalPath = graph.findCriticalPath();
const bottlenecks = graph.findBottlenecks(0.15); // threshold 15%

// Generate Mermaid diagram
const mermaid = graph.toMermaid();
console.log(mermaid);
```

---

## Phase 2: Agent Feedback System (Completed ✓)

The feedback system enables downstream agents to provide quality feedback to upstream agents, driving continuous improvement.

### Basic Feedback Collection

```javascript
const { AgentFeedbackSystem } = require('../core/agent-feedback-system');

// Initialize (done automatically by orchestrator)
const feedbackSystem = new AgentFeedbackSystem({
  outputDir: './output',
  sessionId: 'my-session-123',
  verbose: true,
});

// TESTER provides feedback to DEVELOPER
feedbackSystem.collectFeedback('TESTER', 'DEVELOPER', {
  type: 'quality',
  score: 0.75, // 75% quality
  artifactId: 'test-report.md',
  issues: [
    { type: 'missing_tests', message: 'Edge case coverage insufficient', severity: 'medium' },
    { type: 'syntax_error', message: 'Line 45: missing semicolon', severity: 'low' },
  ],
  comments: 'Good overall but needs more edge case testing.',
});

// Automatic: if score < 0.7, triggers improvement suggestions
// Output: 💡 Suggestions for DEVELOPER:
//        🔴 Address critical code quality issues
//        🟠 Consider prompt adjustment: Emphasize test completeness
```

### Quality Gate Failure Feedback

```javascript
// When QualityGate rejects DEVELOPER output
feedbackSystem.recordQualityGateFailure(
  'DEVELOPER',                      // failed agent
  'TEST',                           // stage
  'Test coverage below threshold',  // reason
  { coverage: 0.45, threshold: 0.8 } // context
);

// Automatically generates feedback to DEVELOPER
// Score: 0.3 (poor)
// Type: quality_gate_failure
```

### Performance Reports

```javascript
// Generate report for specific agent
const report = feedbackSystem.generatePerformanceReport('DEVELOPER');
console.log(report);

// Output:
// {
//   agent: 'DEVELOPER',
//   overallScore: 0.78,
//   category: { label: 'Good', icon: '👍' },
//   trend: 'improving',
//   trendChange: 0.12,
//   feedbackCount: 15,
//   distribution: { excellent: 3, good: 8, fair: 3, poor: 1 },
//   topIssues: [
//     ['missing_tests', 5],
//     ['syntax_error', 3],
//   ],
//   recommendations: ["Address recurring issue: missing_tests"],
// }

// Print summary for all agents
feedbackSystem.printFeedbackSummary();
```

### Using Feedback Helpers (Simplified API)

```javascript
const {
  submitCodeQualityFeedback,
  submitQualityGateFailure,
  analyzeTestResults,
} = require('../core/feedback-helpers');

// TESTER agent: After running tests
const testResults = {
  totalTests: 45,
  passedTests: 42,
  failedTests: 3,
  errors: [
    { message: 'Null pointer exception in edge case', type: 'runtime_error' },
  ],
  warnings: [
    { message: 'Test timeout on slow query', type: 'performance' },
  ],
};

const { score, issues, summary } = analyzeTestResults(testResults);
console.log(summary); // "42/45 tests passed. 1 errors, 1 warnings."

// Submit feedback automatically
submitCodeQualityFeedback({
  score,
  issues,
  comments: summary,
  artifactId: 'test-report.md',
});

// QualityGate: On failure
submitQualityGateFailure({
  stage: 'TEST',
  agent: 'DEVELOPER',
  reason: 'Coverage below threshold: 45% < 80%',
});
```

---

## Integration with Experience System

The feedback system is integrated with the ExperienceEventBus for real-time notifications:

```javascript
const { ExperienceEvents } = require('../core/experience-event-bus');

// Feedback events are automatically emitted
eventBus.on(ExperienceEvents.AGENT_FEEDBACK, ({ source, target, score, issues }) => {
  console.log(`[Feedback] ${source} → ${target}: ${score} (${issues} issues)`);
  
  // Trigger experience evolution for poor scores
  if (score < 0.5) {
    skillEvolution.triggerEvolution(target, 'quality_improvement');
  }
});
```

---

## Output Files

Both systems generate machine-readable reports:

| File | Description |
|------|-------------|
| `output/agent-handoff-log.json` | Complete handoff history |
| `output/agent-handoff-flow.mmd` | Mermaid flowchart |
| `output/execution-analysis.json` | Critical path + bottleneck analysis |
| `output/agent-feedback-history.jsonl` | Line-delimited feedback records |
| `output/agent-feedback-report.json` | Aggregated performance reports |

---

## Best Practices

1. **Feedback Timing**: Provide feedback immediately after validation completes
2. **Specific Issues**: Include concrete issue types and locations
3. **Balanced Scores**: Reserve scores < 0.5 for serious problems
4. **Actionable Comments**: Comments should suggest specific improvements
5. **Regular Review**: Check `agent-feedback-report.json` weekly for trends

---

## Migration from Previous Version

No migration needed! The enhancements are backward compatible:

- `AgentHandoffLog` API unchanged
- `ExecutionGraph` is additive (new export)
- `AgentFeedbackSystem` is new (optional to use)
- All existing code continues to work
