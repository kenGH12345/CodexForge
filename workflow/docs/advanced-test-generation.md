# 高级测试用例自动生成系统

## 概述

本系统增强了 WorkFlowAgent 的测试能力，让 Tester Agent 能够根据代码改动自动生成详细的测试用例文档，然后基于该文档进行测试。

## 工作流流程

```
Developer Agent          TestCaseGenerator          TesterAgent
      │                        │                        │
      │  1. 生成 code.diff     │                        │
      │───────────────────────▶│                        │
      │                        │  2. 分析 code.diff     │
      │                        │     提取功能点         │
      │                        │  3. 生成详细测试文档   │
      │                        │───────────────────────▶│
      │                        │                        │  4. 执行测试
      │                        │                        │  5. 生成报告
```

## 生成的测试文档结构

### output/test-cases-detailed.md

包含以下章节：

1. **Feature Scope Analysis** - 功能范围说明
2. **Detailed Test Cases** - 详细测试用例
3. **Boundary & Edge Case Analysis** - 边界用例
4. **Test Data Sets** - 测试数据集
5. **Coverage Matrix** - 覆盖率矩阵
6. **Execution Instructions** - 执行指令
7. **Machine-Readable Test Cases (JSON)** - 机器可读格式

## 使用方法

### 启用高级模式

```javascript
const { TestCaseGenerator } = require('./test-case-generator');

const tcGen = new TestCaseGenerator(llmCall, { verbose: true });

// 使用高级模式（基于代码改动生成）
const result = await tcGen.generateAdvanced();
console.log(`Generated ${result.caseCount} cases for ${result.features.length} features`);
```

### 解析生成的测试用例

```javascript
const testCases = tcGen.parseDetailedTestCases();
// Returns: Array of test case objects with case_id, steps, expected, etc.
```

## 测试文档示例

### 功能范围

```markdown
## 1.1 New Features Added
| Feature ID | Description | Files | Functions |
|------------|-------------|-------|-----------|
| FEAT-001 | 登录验证 | auth.js | validateUser() |
```

### 详细测试用例

```markdown
### Test Case: TC_FEAT001_001
| Field | Value |
|-------|-------|
| Title | 验证使用有效凭据登录 |
| Steps | 1. 调用 validateUser() <br> 2. 验证返回结果 |
| Expected | 返回 { success: true } |
| Test Data | { "email": "test@example.com" } |
```

### 边界用例

| Input | Boundary Type | Test Value | Expected |
|-------|---------------|------------|----------|
| password | Min (8) | "Pass12!" | Accept |
| password | Min-1 (7) | "Pass12" | Reject |

## 优势对比

| 维度 | 基础模式 | 高级模式 |
|------|----------|----------|
| 输入 | requirements.md | code.diff + requirements.md |
| 侧重点 | 需求覆盖 | 代码实际改动 |
| 测试步骤 | 概要 | 原子级别 |
| 测试数据 | 示例 | 具体值（含边界）|
| 代码引用 | 无 | 文件:行号 |

## 注意事项

1. Token 消耗：高级模式需要更多 tokens（约 2-3 倍）
2. 适用场景：适合代码改动明确的场景
3. 人机协作：复杂场景仍需人工补充