# ADR-54: Socratic Challenger – Runtime Quality Questioning Mechanism

## Status
Accepted (2026-03-31)

## Context

### Problem Statement
The WorkFlowAgent suffered from "false positive" syndrome:
1. Tests passed but outputs were empty placeholders
2. No mechanism to challenge stage outputs
3. No probing questions to surface hidden issues
4. Quality checks only verified file existence, not content quality

### Prior Art
- `ClarificationEngine` (ADR-41): Signal detection for self-correction, but only used in review/approval stages
- `IndependentEvaluator` (ADR-52): Post-workflow evaluation, but not integrated into stage pipeline
- Socratic questioning mentioned in `agent-generator.js:639` but only as prompt suggestion, not runtime enforcement

## Decision

Implement a **SocraticChallenger** module that runs after each stage execution:

### Core Components

1. **Signal Detection** (reuse ClarificationEngine patterns)
   - Ambiguity: Vague, unmeasurable terms
   - Assumption: Unverified premises
   - Risk: Unmitigated risks
   - Contradiction: Logically conflicting statements
   - Alternative: Multiple options without decision

2. **Quality Scoring** (multi-factor evaluation)
   - Length score (0-1): Content length ratio
   - Structure score (0-1): Headings, lists, code blocks
   - Signal penalty (0-1): Deduction for high/medium severity signals
   - Coverage score (0-1): Stage-relevant keyword presence

3. **Challenge Trigger**
   - Quality score < threshold OR high-severity signals > threshold
   - Generate Socratic questions (What → Why → How → What-if)
   - Retry loop with max retries per stage

4. **Execution Logging** (detailed checkpoints)
   - Stage start/end timestamps
   - Signal detection results
   - Quality score breakdown
   - Retry attempts

### Integration Point

```javascript
// In orchestrator-run.js
for (const stageName of stagesToRun) {
  const result = await runner.execute(context);
  
  // Challenge the output
  const challengeResult = await challenger.challenge(stageName, currentArtifact, {
    rawRequirement,
    retryCount,
  });
  
  if (!challengeResult.passed && challengeResult.shouldRetry) {
    // Retry the stage
  }
}
```

### Mock LLM Fix

Improved mock LLM to generate contract-compliant content instead of placeholder:
- Analyzes prompt type (requirement, architecture, plan, code, test)
- Returns structured output matching expected format
- Defensive handling for undefined/empty prompts

## Consequences

### Positive
- Proactive quality assurance at each stage
- Surface hidden issues before downstream stages
- Self-doubt mechanism prevents "false positive" syndrome
- Detailed execution logs for debugging

### Negative
- Additional LLM call per stage for semantic mode (optional)
- Slight overhead for signal detection (~5ms per stage)
- May trigger retries that extend workflow duration

### Neutral
- Requires configuration for thresholds and max retries
- Quality scores are heuristic-based, not absolute

## Implementation

- **File**: `workflow/core/socratic-challenger.js`
- **Integration**: `workflow/core/orchestrator-run.js`
- **Mock Fix**: `workflow/tools/ide-workflow-bridge.js`

## Metrics

| Metric | Before | After |
|--------|--------|-------|
| Quality detection | None | Signal + Score |
| Retry mechanism | None | Max 1 per stage |
| Execution logging | Minimal | Detailed checkpoints |
| Mock output | Placeholder | Contract-compliant |

## References

- ADR-41: Clarification Engine (signal detection patterns)
- ADR-52: Independent Evaluator (post-workflow evaluation)
- `clarification-signals.js`: Signal detection implementation
