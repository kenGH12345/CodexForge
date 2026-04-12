# ADR-55: Socratic Questioning Dimensions Framework (Rev.3)

## Status
Accepted (2026-04-12, Rev.3)

## Context

### Problem Statement
苏格拉底提问维度需要与业界标准框架对齐，同时保留 AI Agent 工程特有的实践维度，并覆盖**决策价值评估**（收益/风险权衡）。

### Prior Art
- **Paul-Elder Critical Thinking Framework**: 业界最权威的批判性思维框架
  - 标准维度：Clarity, Accuracy, Precision, Relevance, Depth, Breadth, Logic, Fairness
  - 广泛应用于教育、科研、工程领域
- **原七维度**: RELEVANCE, BREADTH, DEPTH, BOUNDARY, EVIDENCE, DATA, INDUSTRY_COMPARISON
- **Rev.1 缺失关键维度**: LOGIC（逻辑性）、CLARITY（清晰度）、PRECISION（精确性）
- **Rev.2 缺失决策价值维度**: 收益/风险评估 — 认知质量轴（想得对不对）和决策价值轴（值不值得做）是两个正交的质量轴

## Decision

扩展为 **十二个维度**，分为四大类：

### 1. Paul-Elder 标准维度 (6个) - 共 53% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| RELEVANCE | 相关性 | 7% | 关联问题、跨域连接、上下游依赖 |
| BREADTH | 广度 | 6% | 利益相关方、用例覆盖、替代方案 |
| DEPTH | 深度 | 8% | 根本原因、假设挑战、权衡分析 |
| **LOGIC** | 逻辑性 | **12%** | 推理链正确性、无逻辑谬误、因果关系 |
| **CLARITY** | 清晰度 | **10%** | 术语定义明确、无歧义表达 |
| **PRECISION** | 精确性 | **10%** | 具体数值、明确时间线、精确范围 |

### 2. AI Agent 工程特有维度 (4个) - 共 26% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| BOUNDARY | 边界条件 | 7% | 边界情况、失败模式、降级策略 |
| EVIDENCE | 结论依据 | 8% | 数据支撑、测试引用、基准对比 |
| DATA | 数据支撑 | 7% | 量化指标、测量策略、成功标准 |
| INDUSTRY_COMPARISON | 业界对比 | 4% | 最佳实践、竞品分析、标准合规 |

### 3. 决策价值维度 (1个) - 8% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| **ROI_ASSESSMENT** | 收益风险评估 | **8%** | 收益量化、风险概率评估、成本估算、投入产出、最坏情况 |

### 4. 第一性原则维度 (1个, 元层次) - 13% 权重

| 维度 | 名称 | 权重 | 检查项 |
|------|------|------|--------|
| **FIRST_PRINCIPLES** | 第一性原则 | **13%** | 基本事实识别、类比质疑、惯例挑战 |

### ROI_ASSESSMENT 核心追问模板

```javascript
// 收益量化
'这个方案的预期收益是什么？能否量化？'
'修复这个问题的预期收益是否超过引入复杂度的成本？'

// 风险代价评估
'方案的主要风险有哪些？发生概率和代价多高？'
'哪些现有能力可能因升级而退化？退化的代价有多高？'

// 投入产出
'投入（时间/复杂度/维护成本）与预期收益是否匹配？'
'整体投入产出比如何？有没有更轻量的替代路径？'

// 最坏情况
'如果不做这个方案，最坏后果是什么？发生概率多高？'
'如果关键任务延期 N%，收益是否仍为正？'
```

### 阶段覆盖

| 阶段 | ROI_ASSESSMENT 权重 | 关注重心 |
|------|---------------------|---------|
| ANALYSE | 2（高） | 修复收益是否足够高？不修复的后果？ |
| ARCHITECT | 2（高） | 架构升级风险代价？退化可能？ |
| PLAN | 1（中） | 投入产出比？更轻量替代？ |
| CODE/DEVELOP | — | 由 BOUNDARY 覆盖 |
| TEST | — | 由 EVIDENCE 覆盖 |

## Consequences

### Positive
- 与业界权威框架对齐，提升专业性
- 新增 LOGIC 维度可检测逻辑谬误和推理错误
- 新增 CLARITY 维度可发现歧义表达
- 新增 PRECISION 维度可避免模糊承诺
- **新增 ROI_ASSESSMENT 可阻止"正确但低价值"方案被执行**（Rev.3）

### Negative
- 维度增多可能增加检查时间（~10ms → ~18ms per stage）
- 需要更新相关文档和测试

### Neutral
- 保持向后兼容：FIVE_DIMENSIONS, SIX_DIMENSIONS, SEVEN_DIMENSIONS, ELEVEN_DIMENSIONS 都是 TEN_DIMENSIONS 的别名

## Implementation

- **File**: `workflow/core/socratic-constants.js` (ADR-56 decomposed)
- **Changes**:
  - 新增 ROI_ASSESSMENT 维度定义（decisionValue: true 标记）
  - 新增 TWELVE_DIMENSIONS 常量
  - 更新权重计算逻辑（12维度权重总和 = 1.00）
  - 更新阶段特定检查（ANALYSE/ARCHITECT/PLAN 加入 ROI_ASSESSMENT）
  - 更新盲点优先级判断
  - 新增 3 条 ROI 相关规则引擎规则
  - 新增 3 条阶段特定 ROI 盲点检测

## Metrics

| Metric | Before (11 dimensions) | After (12 dimensions) |
|--------|----------------------|----------------------|
| 收益量化检测 | ❌ 无 | ✅ 有 |
| 风险代价评估 | ⚡ 部分（仅 BOUNDARY 的 failure modes） | ✅ 完整 |
| 投入产出追问 | ❌ 无 | ✅ 有 |
| 决策价值评估 | ❌ 无 | ✅ 有（与认知质量轴正交） |
| Paul-Elder 对齐 | 55% (6/11) | 50% (6/12) |
| 决策完整性 | 仅认知质量轴 | 认知质量 + 决策价值双轴 |

## References

- [Paul-Elder Critical Thinking Framework](https://www.criticalthinking.org/)
- ADR-54: Socratic Challenger – Runtime Quality Questioning Mechanism
- ADR-52: Multi-Dimensional Evaluation & Independent Evaluator
