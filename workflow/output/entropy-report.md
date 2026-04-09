# Entropy GC Report

> Generated: 2026-04-02T12:48:15.550Z
> Files scanned: 368
> Violations: 86 total (29 high / 56 medium / 1 low)

---

## 🔴 High Severity (29)

### FILE_TOO_LARGE: `examples\demo-functionality-evaluation.js`
- **Detail**: 1115 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\agent-generator.js`
- **Detail**: 1376 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\agent-handoff-log.js`
- **Detail**: 981 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\code-graph-parsers.js`
- **Detail**: 946 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\context-loader.js`
- **Detail**: 1106 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\duplicate-pattern-detector.js`
- **Detail**: 927 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\execution-log-validator.js`
- **Detail**: 965 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\experience-store.js`
- **Detail**: 1010 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\integration-agent-fusion.test.js`
- **Detail**: 1138 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\integration-framework-fusion.test.js`
- **Detail**: 1144 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\mcp-server.js`
- **Detail**: 2015 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\memory-manager.js`
- **Detail**: 1030 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\orchestrator-teardown-impl.js`
- **Detail**: 1128 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\problem-abstraction-engine.js`
- **Detail**: 989 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\prompt-builder.js`
- **Detail**: 1110 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\skill-evolution.js`
- **Detail**: 1135 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\socratic-challenger.js`
- **Detail**: 1959 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\stage-tester.js`
- **Detail**: 962 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\hooks\adapters\lsp-adapter.js`
- **Detail**: 916 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\index.js`
- **Detail**: 1215 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\init-project.js`
- **Detail**: 998 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\unit.test.js`
- **Detail**: 2240 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tools\ide-workflow-bridge.js`
- **Detail**: 5480 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### HIGH_COMPLEXITY: `workflow\tools\ide-workflow-bridge.js`
- **Detail**: Cyclomatic complexity: 913 (threshold: 20)
- **Suggestion**: Split into smaller functions. Extract complex conditionals into named helpers.

### HIGH_COMPLEXITY: `workflow\core\socratic-challenger.js`
- **Detail**: Cyclomatic complexity: 359 (threshold: 20)
- **Suggestion**: Split into smaller functions. Extract complex conditionals into named helpers.

### HIGH_COMPLEXITY: `workflow\core\code-graph-parsers.js`
- **Detail**: Cyclomatic complexity: 323 (threshold: 20)
- **Suggestion**: Split into smaller functions. Extract complex conditionals into named helpers.

### HIGH_COMPLEXITY: `workflow\core\orchestrator-teardown-impl.js`
- **Detail**: Cyclomatic complexity: 323 (threshold: 20)
- **Suggestion**: Split into smaller functions. Extract complex conditionals into named helpers.

### HIGH_COMPLEXITY: `workflow\core\mcp-server.js`
- **Detail**: Cyclomatic complexity: 321 (threshold: 20)
- **Suggestion**: Split into smaller functions. Extract complex conditionals into named helpers.

### QUALITY_GATE_FAILED: `(project)`
- **Detail**: Quality gate FAILED: code_smells=4574, high_complexity_files=257
- **Suggestion**: Address the failing quality gate conditions before release.

## 🟡 Medium Severity (56)

### FILE_TOO_LARGE: `workflow\commands\commands-devtools-evolution.js`
- **Detail**: 747 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\commands\commands-workflow.js`
- **Detail**: 737 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\agent-feedback-system.js`
- **Detail**: 619 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\api-endpoint-extractor.js`
- **Detail**: 781 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\ast-transform-engine.js`
- **Detail**: 782 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\benchmark-runner.js`
- **Detail**: 789 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\code-generator-templates.js`
- **Detail**: 854 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\code-graph-builder.js`
- **Detail**: 710 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\code-graph-query.js`
- **Detail**: 697 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\code-review-agent.js`
- **Detail**: 887 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\consistency-validator.js`
- **Detail**: 694 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\deep-audit-checks.js`
- **Detail**: 838 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\event-journal.js`
- **Detail**: 608 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\evolution-loop.js`
- **Detail**: 852 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\experience-abstraction-mixin.js`
- **Detail**: 624 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\experience-distillation.js`
- **Detail**: 843 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\experience-evolution.js`
- **Detail**: 676 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\expert-knowledge-channel.js`
- **Detail**: 822 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\functionality-evaluator.js`
- **Detail**: 688 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\git-integration.js`
- **Detail**: 760 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\ide-detection.js`
- **Detail**: 668 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\integration-pipeline-flow.test.js`
- **Detail**: 831 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\knowledge-pipeline.js`
- **Detail**: 718 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\lsp-router.js`
- **Detail**: 881 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\mape-engine.js`
- **Detail**: 694 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\mape-executors.js`
- **Detail**: 764 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\observability-strategy.js`
- **Detail**: 602 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\observability.js`
- **Detail**: 821 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\orchestrator-run.js`
- **Detail**: 795 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\profiler-detection.js`
- **Detail**: 620 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\prompt-auto-optimizer.js`
- **Detail**: 676 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\prompt-pattern-library.js`
- **Detail**: 720 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\quality-gate.js`
- **Detail**: 753 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\rollback-coordinator.js`
- **Detail**: 630 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\semantic-compressor.js`
- **Detail**: 768 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\skill-discovery.js`
- **Detail**: 657 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\skill-enrichment.js`
- **Detail**: 602 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\skill-evolution-triggers.js`
- **Detail**: 682 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\smart-context-selector.js`
- **Detail**: 717 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\stage-context-store.js`
- **Detail**: 809 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\state-machine.js`
- **Detail**: 784 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\task-batcher.js`
- **Detail**: 632 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\test-case-executor.js`
- **Detail**: 864 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\test-case-generator.js`
- **Detail**: 632 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\token-budget.js`
- **Detail**: 696 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\core\unified-trace-collector.js`
- **Detail**: 809 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\gen-experiences.js`
- **Detail**: 659 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\hooks\adapters\code-quality-adapter.js`
- **Detail**: 644 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\dual-mode-e2e.test.js`
- **Detail**: 719 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\e2e.test.js`
- **Detail**: 601 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\integration.test.js`
- **Detail**: 614 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\smoke-runtime.test.js`
- **Detail**: 753 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tests\test-connectivity.js`
- **Detail**: 697 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\tools\generate-health-report.js`
- **Detail**: 819 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### FILE_TOO_LARGE: `workflow\workflow.config.js`
- **Detail**: 799 lines (limit: 600)
- **Suggestion**: Split into smaller modules. Consider extracting helpers or sub-components.

### CODE_SMELL_DENSITY: `(project-wide)`
- **Detail**: 4574 code smell(s) detected
- **Suggestion**: Schedule a cleanup sprint to reduce code smell density.

## 🟢 Low Severity (1)

- `docs\architecture.md`: Last modified 14 days ago (threshold: 14 days)

---

## Next Steps

1. Address all **high** severity violations before the next release.
2. Schedule **medium** violations for the next sprint.
3. **Low** violations can be batched into a periodic cleanup PR.

> Run `/wf gc` to trigger another scan after fixes.