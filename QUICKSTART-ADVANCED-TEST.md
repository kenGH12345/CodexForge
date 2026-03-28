# 🚀 高级测试用例自动生成 - 快速开始

## 一句话描述

让 Tester Agent 根据代码改动，自动生成包含**功能范围、测试步骤、预期结果、边界用例**的详细测试文档，然后基于该文档进行测试。

## 三步启用

### 1. 修改配置 (30秒)

编辑 `workflow.config.js`:

```javascript
module.exports = {
  // ... 其他配置
  
  testGeneration: {
    mode: 'advanced',  // ← 改成 'advanced' 启用高级模式
  },
};
```

### 2. 确保有 code.diff

通常是 Developer Agent 自动生成。如果没有：

```bash
git diff HEAD~1 > output/code.diff
```

### 3. 运行测试阶段

```bash
node workflow/orchestrator.js --stage test
```

## 你会得到什么

生成的 `output/test-cases-detailed.md` 包含：

```markdown
## Section 1: Feature Scope Analysis  ← 功能范围说明
## Section 2: Detailed Test Cases     ← 详细测试步骤
## Section 3: Boundary & Edge Cases   ← 边界条件用例
## Section 4: Test Data Sets          ← 具体测试数据
## Section 5: Coverage Matrix         ← 覆盖率矩阵
## Section 6: Execution Instructions  ← 执行指令
## Section 7: Machine-Readable JSON   ← 机器可读格式
```

## 对比

| 特性 | 原有基础模式 | 新增高级模式 |
|------|-------------|-------------|
| 输入 | requirements | **code.diff** |
| 侧重点 | 需求覆盖 | **代码实际改动** |
| 测试步骤 | 概要 | **原子级别** |
| 测试数据 | 示例 | **具体值** |
| 边界用例 | 部分 | **系统性** |
| 代码引用 | ❌ | **文件:行号** ✅ |

## 查看完整文档

1. **[使用指南](workflow/docs/test-generation-guide.md)** - 完整使用说明
2. **[示例文档](workflow/docs/test-cases-detailed-example.md)** - 生成的文档示例
3. **[代码示例](workflow/examples/advanced-test-generation-example.js)** - 使用示例

## 核心代码变更

- ✅ `workflow/core/test-case-generator.js` - 新增 `generateAdvanced()` 方法
- ✅ `workflow/agents/tester-agent.js` - 支持读取详细测试文档
- ✅ `workflow/core/stage-tester.js` - 支持配置启用高级模式

## 技术要点

```
Developer Agent          TestCaseGenerator          TesterAgent
      │                   (Advanced Mode)                │
      │ 1. code.diff          │                          │
      │ ─────────────────────▶│                          │
      │                       │ 2. 分析改动              │
      │                       │    提取功能点            │
      │                       │ 3. 生成详细文档          │
      │                       │ ────────────────────────▶│
      │                       │    test-cases-detailed.md│ 4. 按文档执行测试
      │                       │                          │ 5. 生成 test-report.md
```

---

有任何问题？查看完整指南: `[workflow/docs/test-generation-guide.md](c:/workspace/WorkFlowAgent/workflow/docs/test-generation-guide.md)`