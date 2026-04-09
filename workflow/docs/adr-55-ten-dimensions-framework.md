# ADR-55: Socratic Questioning Ten Dimensions Framework

## Status
Accepted (2026-03-31)

## Context

### Problem Statement
苏格拉底提问维度需要与业界标准框架对齐，同时保留 AI Agent 工程特有的实践维度。

### Prior Art
- **Paul-Elder Critical Thinking Framework**: 业界最权威的批判性思维框架
  - 标准维度：Clarity, Accuracy, Precision, Relevance, Depth, Breadth, Logic, Fairness
  - 广泛应用于教育、科研、工程领域
- **原七维度**: RELEVANCE, BREADTH, DEPTH, BOUNDARY, EVIDENCE, DATA, INDUSTRY_COMPARISON
- **缺失关键维度**: LOGIC（逻辑性）、CLARITY（清晰度）、PRECISION（精确性）

## Decision

扩展为 **十个维度**，分为两大类：

### 1. Paul-Elder 标准维度 (6个) - 共 65% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| RELEVANCE | 相关性 | 8% | 关联问题、跨域连接、上下游依赖 |
| BREADTH | 广度 | 8% | 利益相关方、用例覆盖、替代方案 |
| DEPTH | 深度 | 10% | 根本原因、假设挑战、权衡分析 |
| **LOGIC** | 逻辑性 | **15%** | 推理链正确性、无逻辑谬误、因果关系 |
| **CLARITY** | 清晰度 | **12%** | 术语定义明确、无歧义表达 |
| **PRECISION** | 精确性 | **12%** | 具体数值、明确时间线、精确范围 |

### 2. AI Agent 工程特有维度 (4个) - 共 35% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| BOUNDARY | 边界条件 | 8% | 边界情况、失败模式、降级策略 |
| EVIDENCE | 结论依据 | 10% | 数据支撑、测试引用、基准对比 |
| DATA | 数据支撑 | 10% | 量化指标、测量策略、成功标准 |
| INDUSTRY_COMPARISON | 业界对比 | 7% | 最佳实践、竞品分析、标准合规 |

### 核心追问模板

```javascript
// LOGIC 维度追问
'你的推理过程是什么？每一步都站得住脚吗？'
'前提和结论之间是否有必然的因果关系？'
'是否存在逻辑谬误（如滑坡谬误、循环论证、稻草人）？'

// CLARITY 维度追问
'你说的"{term}"具体指什么？能给出明确定义吗？'
'这句话是否有歧义？能否换一种更清晰的表达？'

// PRECISION 维度追问
'你能给出具体的数值吗？而不是"很多"、"大约"？'
'时间线是什么？每个阶段的截止日期？'
```

## Consequences

### Positive
- 与业界权威框架对齐，提升专业性
- 新增 LOGIC 维度可检测逻辑谬误和推理错误
- 新增 CLARITY 维度可发现歧义表达
- 新增 PRECISION 维度可避免模糊承诺

### Negative
- 维度增多可能增加检查时间（~10ms → ~15ms per stage）
- 需要更新相关文档和测试

### Neutral
- 保持向后兼容：FIVE_DIMENSIONS, SIX_DIMENSIONS, SEVEN_DIMENSIONS 都是 TEN_DIMENSIONS 的别名

## Implementation

- **File**: `workflow/core/socratic-challenger.js`
- **Changes**:
  - 新增 TEN_DIMENSIONS 常量
  - 更新权重计算逻辑
  - 更新阶段特定检查（stageDimensionChecks）
  - 更新盲点优先级判断

## Metrics

| Metric | Before (7 dimensions) | After (10 dimensions) |
|--------|----------------------|----------------------|
| 逻辑谬误检测 | ❌ 无 | ✅ 有 |
| 歧义检测 | ⚡ 部分 | ✅ 完整 |
| 精确度验证 | ❌ 无 | ✅ 有 |
| Paul-Elder 对齐 | 43% (3/7) | 60% (6/10) |

## References

- [Paul-Elder Critical Thinking Framework](https://www.criticalthinking.org/)
- ADR-54: Socratic Challenger – Runtime Quality Questioning Mechanism
- ADR-52: Multi-Dimensional Evaluation & Independent Evaluator
