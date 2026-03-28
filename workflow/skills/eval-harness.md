---
name: eval-harness
version: 1.0.0
type: meta-skill
domains: [evaluation, testing, quality-assurance, benchmark]
dependencies: [workflow-orchestration]
load_level: task
max_tokens: 1200
triggers:
  keywords: [evaluation, eval, benchmark, metrics, quality gate, regression, pass rate]
  roles: [qa, architect, system-agent]
description: "Evaluation framework for measuring agent capabilities, tracking regressions, and ensuring quality through eval-driven development"
---

# Skill: eval-harness

> **Type**: Meta Skill
> **Version**: 1.0.0
> **Description**: Evaluation framework for measuring agent capabilities, tracking regressions, and ensuring quality through eval-driven development
> **Domains**: evaluation, testing, quality-assurance, benchmark

---

## Rules

### R1: Define Evals BEFORE Implementation (MANDATORY)
- **Success Criteria First**: Define what success looks like before coding
- **Measurable Outcomes**: Evals must have pass/fail criteria
- **Specific Scenarios**: Each eval tests specific capability or scenario
- **Regression Prevention**: Include existing behavior preservation tests

### R2: Multiple Grader Types
- **Code Graders**: Deterministic checks (grep, test execution, lint)
- **Model Graders**: LLM-as-judge for qualitative assessment
- **Human Graders**: Manual review for ambiguous or critical cases
- **Metric Graders**: Performance, coverage, complexity measures

### R3: Pass@K Metrics
- **pass@1**: First-attempt success rate (direct reliability)
- **pass@3**: Success within 3 attempts (practical reliability)
- **pass^k**: All k attempts succeed (stability test)
- Target: pass@3 >= 90% for capability evals, pass^3 = 100% for regressions

### R4: Regression Tracking
- **Baseline Comparison**: Compare against previous runs
- **Drift Detection**: Monitor for quality degradation
- **Cost Monitoring**: Track token usage and latency
- **Flaky Test Management**: Identify and fix unreliable evals

---

## SOP (Standard Operating Procedure)

### Phase 1: Eval Definition (Before Coding)
1. **Identify What to Test**: Capabilities, features, quality attributes
2. **Define Success Criteria**: 
   - Expected behavior
   - Output format
   - Performance thresholds
3. **Design Eval Cases**:
   - Input scenario
   - Expected output/behavior
   - Grader method (code/rule/model/human)
4. **Set Pass Criteria**: pass@k targets, metrics thresholds
5. **Create Eval Specification**: Document eval in structured format

### Phase 2: Implementation
1. **Implement Feature**: Build feature according to requirements
2. **Run Evals Continuously**: Check against evalspec during development
3. **Iterate**: Fix issues until evals pass
4. **Measure**: Collect pass rates, metrics, costs

### Phase 3: Validation
1. **Run Complete Eval Suite**: All capability + regression evals
2. **Check Pass Rates**: Verify pass@k targets met
3. **Analyze Failures**: Understand why failures occurred
4. **Fix or Adjust**: Fix issues or adjust evals if too strict

### Phase 4: Reporting
1. **Generate Report**: Summary of eval results
2. **Compare to Baseline**: Show improvement/regression
3. **Document Learnings**: What worked, what didn't
4. **Archive Results**: Store for future comparison

---

## Checklist

### Eval Design
- [ ] Success criteria defined before implementation
- [ ] Eval covers specific capability or scenario
- [ ] Multiple grader types appropriate for eval type
- [ ] Pass/fail criteria are objective and measurable
- [ ] Regression tests included for existing behavior
- [ ] Edge cases covered

### Eval Execution
- [ ] All evals run successfully (no infrastructure failures)
- [ ] pass@k metrics calculated correctly
- [ ] Baseline comparison performed
- [ ] Cost and latency tracked
- [ ] Failures analyzed and categorized

### Quality Thresholds
- [ ] pass@3 >= 90% for capability evals (or justified otherwise)
- [ ] pass^3 = 100% for regression evals
- [ ] No significant latency regression
- [ ] No excessive token cost increase
- [ ] No flaky evals

### Reporting
- [ ] Results documented
- [ ] Trend analysis included
- [ ] Actionable insights identified
- [ ] Comparison to previous runs
- [ ] Recommendations for improvement

---

## Best Practices

### 1. Eval-Driven Development (EDD)
Treat evals as unit tests for AI behavior:
- Define expected behavior first
- Implement to make evals pass
- Regressions caught immediately
- Quality is measurable

### 2. Balanced Eval Suite
- **Capability Evals**: Test new abilities
- **Regression Evals**: Ensure existing behavior preserved
- **Edge Case Evals**: Test boundary conditions
- **Performance Evals**: Measure efficiency

### 3. Automated Grading
- Prefer code/rule graders (deterministic)
- Use model graders only when necessary
- Human graders for critical/ambiguous cases
- Document grader decision criteria

### 4. Trend Monitoring
- Track pass rates over time
- Monitor cost and latency trends
- Identify drift early
- Celebrate improvements

### 5. Continuous Improvement
- Review and improve evals regularly
- Remove or fix flaky evals
- Add new evals for emerging capabilities
- Learn from failures

---

## Anti-Patterns

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Evals defined after implementation | Define evals before coding (EDD) |
| Overfitting prompts to eval examples | General patterns that work broadly |
| Measuring only happy paths | Include edge cases and error paths |
| Ignoring cost/latency for pass rates | Balance quality with resource usage |
| Flaky evals in release gates | Fix or remove unreliable evals |
| No baseline comparison | Always compare to previous performance |
| Manual-only evaluation | Automated evals for objective criteria |

---

## Context Hints

- **Evals are executable specifications**: They define what correct behavior means
- **Quality is measurable**: Use metrics to track improvement over time
- **Regression detection is critical**: Protect existing capabilities while adding new ones
- **Cost matters**: Optimize for both quality and efficiency

---

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-26 | Initial creation based on ECC eval-harness, adapted for WorkFlowAgent quality assurance |
