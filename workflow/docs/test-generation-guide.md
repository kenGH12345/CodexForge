# 测试用例自动生成 - 使用指南

## 功能概览

WorkFlowAgent 现在支持两种测试用例生成模式：

| 模式 | 输入 | 输出 | 适用场景 |
|------|------|------|----------|
| **基础模式** | requirements.md | test-cases.md (简单表格) | 新项目/需求驱动开发 |
| **高级模式** | code.diff (+ requirements.md) | test-cases-detailed.md (完整文档) | 代码改动/回归测试 |

## 高级模式的特点

**生成的文档包含：**
1. Feature Scope Analysis - 功能范围说明
2. Detailed Test Cases - 详细测试用例（含步骤、预期结果）
3. Boundary & Edge Cases - 边界条件分析
4. Test Data Sets - 测试数据集（具体值）
5. Coverage Matrix - 覆盖率矩阵
6. Execution Instructions - 执行指令
7. Machine-Readable JSON - 机器可读的 JSON 格式

## 配置方法

### 1. 修改 workflow.config.js

```javascript
module.exports = {
  // ... 现有配置
  
  // 测试用例生成配置
  testGeneration: {
    // 'basic' - 基于需求生成（默认）
    // 'advanced' - 基于代码改动生成详细测试文档
    mode: 'advanced',
    
    // 高级模式专属配置
    advanced: {
      includeBoundaries: true,  // 包含边界用例分析
      includeTestData: true,    // 包含具体测试数据
      maxFeatures: 20,          // 最多分析的功能数
    },
  },
  
  // ... 其他配置
};
```

### 2. 确保 code.diff 存在

高级模式需要 `output/code.diff` 文件。通常是 Developer Agent 自动生成的。如果你手动测试，可以创建：

```bash
# 生成 code.diff
git diff HEAD~1 > output/code.diff
```

### 3. 运行测试阶段

```bash
node workflow/orchestrator.js --stage test
```

## 工作流程

### 完整流程图

```
┌────────────────────────────────────────────────────────────────┐
│                     Developer Agent                            │
│                    (代码开发阶段)                              │
├────────────────────────────────────────────────────────────────┤
│ 1. 开发功能代码                                                │
│ 2. 生成 output/code.diff (通过 git diff)                      │
│ 3. 输出到 output/ 目录                                         │
└──────────────────────┬─────────────────────────────────────────┘
                       │
                       ▼ (自动触发)
┌────────────────────────────────────────────────────────────────┐
│                  TestCaseGenerator                             │
│                    (测试准备阶段)                              │
├────────────────────────────────────────────────────────────────┤
│ 如果 mode='advanced':                                          │
│   1. 读取 code.diff                                            │
│   2. 分析代码改动，识别:                                       │
│      - 新功能 (New Features)                                   │
│      - 修改的功能 (Modified)                                   │
│      - 删除的功能 (Removed)                                    │
│   3. 对每个功能生成:                                           │
│      - 测试步骤 (原子级别)                                     │
│      - 预期结果 (可测量)                                       │
│      - 边界用例 (Min/Max/Null/Empty)                           │
│      - 测试数据 (具体 JSON 值)                                 │
│      - 代码引用 (文件:行号)                                    │
│   4. 输出 output/test-cases-detailed.md                       │
└──────────────────────┬─────────────────────────────────────────┘
                       │
                       ▼ (自动触发)
┌────────────────────────────────────────────────────────────────┐
│                      Tester Agent                              │
│                    (测试执行阶段)                              │
├────────────────────────────────────────────────────────────────┤
│ 1. 读取 test-cases-detailed.md (优先) 或 test-cases.md        │
│ 2. 按文档中的 Section 2 (Detailed Test Cases) 执行测试         │
│ 3. 验证 Section 3 (Boundary Cases) 中的边界条件                │
│ 4. 使用 Section 4 (Test Data Sets) 中的具体测试数据            │
│ 5. 生成 output/test-report.md                                  │
│    - 包含每个 test case 的执行结果 (PASS/FAIL/BLOCKED)         │
│    - 引用代码位置 (Section 2 中的 code_reference)             │
└────────────────────────────────────────────────────────────────┘
```

## 生成的文档示例

### test-cases-detailed.md 结构

```markdown
# Detailed Test Case Document

## Section 1: Feature Scope Analysis
### 1.1 New Features
| Feature ID | Description | Files | Functions |
|------------|-------------|-------|-----------|
| FEAT-001 | 添加用户登录 | auth.js | login(), validateUser() |

### 1.2 Modified Features
...

## Section 2: Detailed Test Cases
### Feature: [FEAT-001]
#### Test Case: TC_FEAT001_001
| Field | Value |
|-------|-------|
| Test ID | TC_FEAT001_001 |
| Title | 验证登录成功 |
| Steps | 1. 调用 login(email, password) ... |
| Expected | 返回 { success: true, token: "xyz" } |
| Test Data | `{ "email": "test@example.com", "password": "Pass123!" }` |
| Code Ref | auth.js:45-67 |

## Section 3: Boundary & Edge Cases
| Feature | Input | Boundary | Value | Expected |
|---------|-------|----------|-------|----------|
| FEAT-001 | password | Min (8) | "Pass12!" | Accept |
| FEAT-001 | password | Min-1 | "Pass12" | Reject |

## Section 4: Test Data Sets
| ID | Description | Data |
|----|-------------|------|
| VALID-001 | 标准用户 | `{ "email": "...", ... }` |
| INVALID-001 | 无效密码 | `{ "password": "" }` |

## Section 7: Machine-Readable JSON
```json
[
  {
    "case_id": "TC_FEAT001_001",
    "feature_id": "FEAT-001",
    "title": "...",
    "steps": [...],
    "expected": "...",
    "test_data": {...}
  }
]
```
```

## 优势对比

### 基础模式 vs 高级模式

| 对比项 | 基础模式 | 高级模式 |
|--------|----------|----------|
| 输入 | requirements.md | code.diff + requirements.md |
| 生成时机 | Planning 阶段 | Developer 阶段后 |
| 用例来源 | 从需求推断 | 从代码实际改动提取 |
| 测试步骤 | 概要性描述 | 原子级别步骤 |
| 预期结果 | 一般性描述 | 精确的返回值/状态 |
| 测试数据 | 示例数据 | 具体 JSON 值 |
| 边界覆盖 | 粗略 | 系统性分析 (Min/Max/Null/Empty) |
| 代码引用 | 无 | 文件:行号 |
| 适用场景 | 新项目、全量测试 | 代码改动、回归测试 |
| Token 消耗 | 中等 | 高 (2-3x) |

### 何时使用哪种模式？

使用 **高级模式** 当：
- ✅ 进行代码改动回归测试
- ✅ 需要精确的测试数据
- ✅ 边界条件测试很重要
- ✅ 想要代码级别的引用验证

使用 **基础模式** 当：
- ✅ 早期需求分析阶段
- ✅ 没有 code.diff（新项目）
- ✅ 想要快速生成测试框架
- ✅ Token 预算有限

## 进阶用法

### 1. 解析 JSON 格式的测试用例

```javascript
const { TestCaseGenerator } = require('./workflow/core/test-case-generator');

const tcGen = new TestCaseGenerator(llmCall);

// 生成详细测试文档
await tcGen.generateAdvanced();

// 解析 JSON 测试用例用于自动化执行
const testCases = tcGen.parseDetailedTestCases();
// 返回:
// [
//   {
//     case_id: "TC_FEAT001_001",
//     feature_id: "FEAT-001",
//     title: "验证登录成功",
//     steps: [...],
//     expected: "...",
//     test_data: {...}
//   }
// ]
```

### 2. 与 CI/CD 集成

```yaml
# .github/workflows/test.yml
- name: Generate Test Cases
  run: |
    # 生成详细的测试文档
    node -e "
      const { TestCaseGenerator } = require('./workflow/core/test-case-generator');
      const tcGen = new TestCaseGenerator(async (prompt) => {
        // 调用你的 LLM
        return await callLLM(prompt);
      });
      await tcGen.generateAdvanced();
    "

- name: Run Tests Based on Generated Cases
  run: |
    # TesterAgent 会使用生成的测试文档
    node workflow/orchestrator.js --stage test
```

### 3. 混合模式

先运行基础模式进行需求覆盖，再运行高级模式进行代码改动验证：

```javascript
// 1. 基础模式 - 需求覆盖
config.testGeneration.mode = 'basic';
await orchestrator.run();

// 2. 高级模式 - 代码改动
const codeDiff = fs.readFileSync('output/code.diff');
if (codeDiff.length > 0) {
  config.testGeneration.mode = 'advanced';
  await orchestrator.run();
}
```

## 注意事项

### ⚠️ 重要提示

1. **Token 消耗**
   - 高级模式需要比基础模式多 **2-3 倍** 的 tokens
   - 大改动（>1000 行）可能需要分块处理

2. **code.diff 质量**
   - 生成的测试质量依赖于 code.diff 的清晰度
   - 确保 commit message 清晰描述改动意图
   - 避免将多个不相关功能混在一个 commit

3. **人机协作**
   - LLM 生成的测试用例可能有遗漏
   - Tester Agent 会进行探索性测试补充
   - 关键业务场景仍需人工评审

4. **测试数据安全**
   - 避免在 code.diff 中暴露敏感数据
   - 测试数据是生成的，不含真实用户数据
   - 生产数据不应出现在测试用例中

### 常见问题

**Q: 高级模式下 requirements.md 还有用吗？**
A: 有用！requirements.md 用于需求覆盖验证（Section 5: Coverage Matrix）。

**Q: 生成的测试用例可以直接运行吗？**
A: 需要 TestCaseExecutor 将 Section 7 的 JSON 转换为可执行脚本。

**Q: 如何查看生成的测试用例？**
A: 查看 `output/test-cases-detailed.md`，包含完整的结构化测试计划。

**Q: 可以修改生成的测试用例吗？**
A: 可以，但建议通过修改 source code 后重新生成，保持测试与代码同步。

## 参考资源

- 示例文档: `[workflow/docs/test-cases-detailed-example.md](c:/workspace/WorkFlowAgent/workflow/docs/test-cases-detailed-example.md)`
- 使用示例: `[workflow/examples/advanced-test-generation-example.js](c:/workspace/WorkFlowAgent/workflow/examples/advanced-test-generation-example.js)`
- 核心模块: `[workflow/core/test-case-generator.js](c:/workspace/WorkFlowAgent/workflow/core/test-case-generator.js)`