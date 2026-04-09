# ADR-52: Multi-Dimensional Evaluation & Independent Evaluator

## Status
ACCEPTED (2026-03-31)

## Context

与 Anthropic 三智能体架构（Planner → Generator → Evaluator）对比分析后，发现 WorkFlowAgent 存在以下核心差距：

### 问题诊断

**问题1：运行时产物缺失**
- 实际工作流从未完整运行过
- 缺少文档和manifest验证机制
- 测试只检查代码存在性，不验证运行时产出

**问题2：闭环轮次限制过保守**
- `maxFixRounds = 2` 无法支撑"改到能过验收才算结束"的理念
- Anthropic 可迭代至第 10 轮，我们最多 2 轮就放弃

**问题3：评价维度缺失**
- 设计质量：无量化指标
- 原创性：无概念
- 工艺感：无概念
- 只有功能性评价，缺乏质量深度

**问题4：Evaluator 独立性不足**
- 存在"自己给自己打分"的隐性偏差
- 评价器与生成器共享上下文内存
- 缺乏独立的交叉验证机制

## Decision

### 1. 提升闭环轮次限制

**修改文件：**
- `workflow.config.js`: `maxFixRounds` 从 2 提升到 4
- `observability-strategy.js`: 默认值从 2 提升到 4，上限从 5 提升到 8

**理由：** 支撑"改到能过验收才算结束"的工程理念。自适应策略可根据历史失败率进一步调整轮次。

### 2. 引入多维度评价体系

**新增文件：**
- `evaluation-dimensions.js`: 四维度评价框架
  - 设计质量 (Design Quality) - 30% 权重
  - 原创性 (Originality) - 20% 权重
  - 工艺感 (Craftsmanship) - 25% 权重
  - 功能性 (Functionality) - 25% 权重

**量化指标：**
```javascript
DesignQuality: {
  consistency: '一致性评分',
  maintainability: '可维护性评分', 
  scalability: '可扩展性评分',
  readability: '可读性评分',
}
Originality: {
  innovation: '创新性评分',
  differentiation: '差异化评分',
}
Craftsmanship: {
  codeElegance: '代码优雅度',
  edgeCaseHandling: '边界处理',
  errorHandling: '错误处理',
}
Functionality: {
  requirementCoverage: '需求覆盖率',
  testPassRate: '测试通过率',
}
```

### 3. 建立 Independent Evaluator 机制

**新增文件：**
- `independent-evaluator.js`: 独立评价器

**核心设计原则：**
1. **切断上下文传递**：从磁盘读取产物，不使用内存传递
2. **无状态设计**：每次评价独立，不受历史上下文影响
3. **标准化输出**：JSON 格式输出，方便下游消费

**调用时机：**
- 在 `_finalizeWorkflow()` 中，执行验证之后调用
- 确保产物文件已写入磁盘后再评价

### 4. 创建运行时冒烟测试

**新增文件：**
- `smoke-runtime.test.js`: 六维度强制验证框架

**验证维度：**
1. 产物存在性：检查文件是否真实生成
2. 量化指标：验证内容质量达标
3. 下游消费：验证解析能力
4. 函数调用追踪：验证关键函数被调用
5. 模块路由：验证模块间通信
6. 端到端流水线：验证完整链路

## Consequences

### 正向
- 质量评价更全面，不再只看功能性
- 独立评价器避免了自我评分偏差
- 闭环轮次提升，支撑更高质量的交付
- 冒烟测试确保"流程真的通了"

### 负向
- LLM 调用次数可能增加（评价维度增多）
- 工作流运行时间可能延长（轮次增多）
- 评价报告文件增加

### 风险缓解
- 自适应策略可根据历史数据调整轮次
- 评价器可配置开关，按需启用
- 权重可配置，适应不同场景

## Implementation Timeline

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 | 创建 evaluation-dimensions.js | ✅ 完成 |
| Phase 2 | 创建 independent-evaluator.js | ✅ 完成 |
| Phase 3 | 修改闭环轮次配置 | ✅ 完成 |
| Phase 4 | 集成到 teardown 流程 | ✅ 完成 |
| Phase 5 | 创建冒烟测试框架 | ✅ 完成 |

## References

- Anthropic 三智能体架构分析
- `workflow.config.js`
- `observability-strategy.js`
- `evaluation-dimensions.js`
- `independent-evaluator.js`
- `smoke-runtime.test.js`
