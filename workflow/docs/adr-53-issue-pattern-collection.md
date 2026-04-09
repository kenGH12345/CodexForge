# ADR-53: Issue Pattern Collection for Self-Evolution

## Status
ACCEPTED

## Context

在历史问题（019d438be012733e8306383d5e7df366, 019d43900208733e83064a9a8ae755ea）中发现：
1. 测试发现问题但不修复
2. 功能模块路由不通的问题没有收集机制
3. 功能游离于主流程之外的问题没有记录
4. 自我进化链路断裂：发现问题 → 测试报告 → 但不记录到经验库

**根本问题**：
- 测试框架只报告失败，不记录到经验库
- 问题模式无法被SkillEvolution学习
- 相同问题重复出现

## Decision

创建 **IssuePatternCollector** 并集成到测试框架，实现问题自动收集：

### 1. 问题类型分类

```javascript
const IssueType = {
  MODULE_ROUTE_BROKEN: 'module-route-broken',         // 模块路由不通
  FEATURE_ORPHANED: 'feature-orphaned',               // 功能游离于主流程
  TEST_FAILURE_UNTRACKED: 'test-failure-untracked',   // 测试失败未记录
  ARTIFACT_MISSING: 'artifact-missing',               // 运行时产物缺失
  DOWNSTREAM_CONSUME_FAIL: 'downstream-consume-fail', // 下游消费失败
  FORMAT_MISMATCH: 'format-mismatch',                 // 格式不匹配
};
```

### 2. 严重程度分级

```javascript
const IssueSeverity = {
  CRITICAL: 'critical',   // 阻塞性问题，流程无法继续
  HIGH: 'high',           // 严重问题，影响核心功能
  MEDIUM: 'medium',       // 一般问题，影响次要功能
  LOW: 'low',             // 轻微问题，不影响功能
};
```

### 3. 集成到测试框架

修改 `smoke-runtime.test.js`：
- 初始化 `IssuePatternCollector`
- 在 `recordFailure()` 中自动记录问题
- 测试结束时输出问题摘要

### 4. 自我进化闭环

```
发现问题 → IssuePatternCollector.recordIssue() 
         → ExperienceStore.record() 
         → SkillEvolution 学习 
         → 自动生成 Skill 或改进提示
```

## Consequences

### Positive
- ✅ 问题自动记录到经验库
- ✅ 问题类型和严重程度自动分类
- ✅ 支持SkillEvolution自动学习
- ✅ 测试结束时输出问题摘要
- ✅ 历史问题可追溯

### Negative
- 需要维护问题类型分类逻辑
- 经验库文件会增长

### Mitigation
- 定期清理过期经验
- 问题分类逻辑可扩展

## Implementation

### Files Created
- `workflow/core/issue-pattern-collector.js` - 问题模式收集器

### Files Modified
- `workflow/tests/smoke-runtime.test.js` - 集成IssuePatternCollector
- `workflow/output/mock-requirement.md` - 修复格式，添加User Stories章节

### Usage Example

```javascript
// 在测试框架中使用
const collector = new IssuePatternCollector(experienceStore);

// 记录模块路由不通
collector.recordModuleRouteBroken({
  module: 'CoverageChecker',
  caller: 'ArchitectAgent',
  expectedRoute: 'archStage.run() → coverageChecker.check()',
  actualBehavior: 'CoverageChecker never called',
});

// 记录产物缺失
collector.recordArtifactMissing({
  artifact: 'requirement.md',
  expectedPath: '/output/requirement.md',
  stage: 'ANALYSE',
});

// 生成摘要
const summary = collector.generateSummary();
```

## Related
- ADR-52: Independent Evaluator
- ADR-37: IDE-First Principle
- Experience Store System
- SkillEvolutionEngine

## History
- 2026-03-31: Initial creation
