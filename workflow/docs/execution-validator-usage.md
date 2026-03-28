# Execution Log Validator 使用指南

## 概述

Execution Log Validator（执行日志验证器）是 WorkFlowAgent 的新组件，用于将 `/wf` 产生的执行日志与**标准执行流程**进行对比，检查输出内容完整性，评估执行是否正常。

## 核心功能

1. **标准流程模板定义** (`STANDARD_EXECUTION_FLOW`)
   - ANALYSE → ARCHITECT → PLAN → CODE → TEST
   - 每个阶段定义了必需的产出物和结构

2. **执行日志解析** (`ExecutionLogParser`)
   - 自动扫描 output 目录
   - 解析各阶段产物状态

3. **内容验证** (`ExecutionValidator`)
   - 检查必需产物是否存在
   - 验证内容结构完整性
   - 评估格式合规性

4. **质量评估** (`ExecutionLogValidator`)
   - 生成质量评分 (0-100)
   - 提供改进建议
   - 输出详细报告

## 快速开始

### 命令行使用

```bash
# 基本验证
/validate-execution

# 详细模式
/validate-execution --verbose

# 严格模式
/validate-execution --strict

# 指定输出目录
/validate-execution --output-dir ./my-output

# 生成基线用于后续比较
/validate-execution --generate-baseline

# 与基线比较
/validate-execution --compare-baseline execution-baseline.json
```

### 程序化使用

```javascript
const { ExecutionLogValidator } = require('./workflow/core/execution-log-validator');

const validator = new ExecutionLogValidator({
  outputDir: './output',
  verbose: true,
  strictMode: false,
});

async function runValidation() {
  const result = await validator.validate();

  console.log('Validation Score:', result.report.summary.score);
  console.log('Status:', result.report.summary.status);

  // 访问详细报告
  console.log('Stage Validations:', result.report.stageValidations);
  console.log('Recommendations:', result.report.recommendations);
}

runValidation();
```

## 标准执行流程模板

执行验证器使用预定义的模板来验证各阶段产出：

### Stage 1: ANALYSE
- **必需产物**: `requirement.md`
- **可选产物**: `requirement.zh.md`
- **最少章节**: 3
- **必需章节**:
  - 需求/Requirements
  - 范围/Scope

### Stage 2: ARCHITECT
- **必需产物**: `architecture.md`
- **可选产物**: `architecture.zh.md`
- **最少章节**: 4
- **必需章节**:
  - 架构/Architecture
  - 组件/Components
  - 技术栈/Tech Stack
  - 数据流/Data Flow

### Stage 3: PLAN
- **必需产物**: `execution-plan.md`
- **可选产物**: `execution-plan.zh.md`
- **最少章节**: 3
- **必需章节**:
  - 任务/Tasks
  - 阶段/Phases
  - 依赖/Dependencies

### Stage 4: CODE
- **必需产物**: `code.diff`
- **最少章节**: 1
- **格式**: Unified diff

### Stage 5: TEST
- **必需产物**: `test-report.md`
- **可选产物**: `test-report.zh.md`
- **最少章节**: 2
- **必需章节**:
  - 测试结果/Test Results
  - 通过/失败统计

## 评分标准

每个阶段的评分维度：

| 检查项 | 分值 | 说明 |
|--------|------|------|
| Required Artifact Exists | 20分 | 必需产物是否存在 |
| Content Length | 15分 | 内容长度是否在预期范围内 |
| Section Count | 15分 | 章节数量是否达标 |
| Required Sections | 25分 | 必需章节是否完整 |
| JSON Metadata | 10分 | JSON 元数据是否正确 |
| Optional Artifacts | 5分 | 可选产物是否存在 |

## 集成到工作流

### 1. Orchestrator 自动集成

```javascript
const { withExecutionValidation } = require('./workflow/core/execution-validator-integration');

class MyOrchestrator extends withExecutionValidation(BaseOrchestrator) {
  constructor(options) {
    super({
      ...options,
      executionValidator: true,
      executionValidatorOptions: {
        strictMode: false,
        verbose: true,
      },
    });
  }

  async finalize() {
    // 工作流完成后自动验证
    await this.validateExecution();

    // 获取验证指标用于 QualityGate
    const metrics = this.getExecutionValidationMetrics();
    console.log('Execution Score:', metrics.executionScore);
  }
}
```

### 2. QualityGate 集成

```javascript
const { createExecutionValidationGates } = require('./workflow/core/execution-validator-integration');

const executionGates = createExecutionValidationGates({
  minExecutionScore: 70,
  maxFailedStages: 0,
  minIntegrityScore: 80,
});

// 合并到现有 QualityGate 配置
const qualityGates = {
  ...DEFAULT_QUALITY_GATES,
  ...executionGates,
};
```

### 3. DeepAudit 集成

```javascript
const { createExecutionValidationDimension } = require('./workflow/core/execution-validator-integration');

const executionDimension = createExecutionValidationDimension();

// 在 DeepAudit 中注册
const dimensions = [
  AuditCategory.LOGIC,
  AuditCategory.CONFIG,
  // ... other dimensions
  executionDimension.name, // 'execution-validation'
];

deepAuditOrchestrator.run({ dimensions });
```

### 4. SelfAudit 集成

```javascript
const { getExecutionValidationAuditQuestions } = require('./workflow/core/execution-validator-integration');

// 获取执行验证相关的审计问题
const validationResult = await validator.validate();
const questions = getExecutionValidationAuditQuestions(validationResult);

// 纳入自审计流程
for (const question of questions) {
  console.log(`[${question.id}] ${question.question}`);
  console.log(`Answer: ${question.answer}`);
}
```

## 验证报告结构

生成的验证报告包含以下部分：

### JSON 报告 (`execution-validation-report.json`)

```json
{
  "timestamp": "2026-03-25T17:xx:xx.xxxZ",
  "summary": {
    "status": "passed|passed_with_warnings|failed",
    "score": 85,
    "totalStages": 5,
    "completedStages": 5,
    "failedStages": 0,
    "warnings": 2
  },
  "stageValidations": {
    "ANALYSE": {
      "stage": "ANALYSE",
      "status": "passed",
      "score": 90,
      "maxScore": 100,
      "checks": [...],
      "warnings": [],
      "errors": []
    },
    // ... other stages
  },
  "flowValidation": {
    "status": "passed",
    "sequence": [...],
    "breaks": []
  },
  "integrityChecks": [
    {
      "name": "content_completeness",
      "passed": true,
      "score": 95
    }
  ],
  "recommendations": [
    {
      "priority": "high|medium|low",
      "type": "stage_failure|flow_break|missing_sections",
      "message": "...",
      "action": "..."
    }
  ]
}
```

### Markdown 报告 (`execution-validation-report.md`)

- 执行摘要
- 阶段详细验证结果
- 流程连续性检查
- 完整性检查
- 改进建议

## 命令参考

### `/validate-execution`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--output-dir` | string | `./output` | 指定输出目录 |
| `--strict` | boolean | false | 严格模式（更严格的检查） |
| `--verbose` | boolean | false | 详细输出 |
| `--generate-baseline` | boolean | false | 生成基线文件 |
| `--compare-baseline` | string | - | 与基线文件比较 |

## 故障排查

### 问题：验证失败 (所有阶段分数为 0)

**原因**: output 目录中缺少标准 workflow 执行产物

**解决**:
1. 确保已执行 `/wf` 命令完成标准工作流
2. 检查 output 目录路径是否正确
3. 确认产物文件命名符合标准（如 `requirement.md`）

### 问题："Missing required sections"

**原因**: 产物文件结构不符合标准模板

**解决**:
1. 检查文件是否包含必需章节（如 "需求"、"架构" 等）
2. 参考标准模板调整 AI 提示词
3. 使用 `--verbose` 查看具体缺少哪些章节

### 问题：JSON 元数据解析错误

**原因**: 产物文件顶部的 JSON 块格式错误

**解决**:
1. 确保 JSON 块使用正确的 markdown 代码块标记
2. 检查 JSON 语法有效性

## 最佳实践

1. **定期验证**: 在工作流关键节点运行验证
2. **设置基线**: 在稳定版本上生成基线，用于后续比较
3. **结合 QualityGate**: 将执行验证纳入质量门禁
4. **监控趋势**: 跟踪执行质量分数的变化趋势
5. **响应建议**: 根据验证建议持续改进工作流

## 扩展开发

### 自定义验证模板

```javascript
const { STANDARD_EXECUTION_FLOW } = require('./workflow/core/execution-log-validator');

// 扩展标准模板
STANDARD_EXECUTION_FLOW.MY_CUSTOM_STAGE = {
  requiredArtifacts: ['custom-output.md'],
  optionalArtifacts: ['custom-output.zh.md'],
  minContentSections: 2,
  requiredSections: [
    { pattern: /自定义章节/i, name: 'custom_section' },
  ],
  expectedMetrics: {
    minLines: 10,
    maxLines: 500,
    hasJsonMetadata: true,
  },
};
```

### 自定义检查规则

```javascript
const { ExecutionValidator } = require('./workflow/core/execution-log-validator');

class CustomValidator extends ExecutionValidator {
  _validateStage(stage, stageState, stageDef) {
    // 调用父类验证
    const validation = super._validateStage(stage, stageState, stageDef);

    // 添加自定义检查
    if (stage === 'ANALYSE') {
      const hasUserStories = this._checkUserStories(stageState);
      validation.checks.push({
        name: 'has_user_stories',
        passed: hasUserStories,
        points: hasUserStories ? 10 : 0,
      });
    }

    return validation;
  }
}
```

## 相关文档

- [`execution-log-validator.js`](../core/execution-log-validator.js) - 核心验证器实现
- [`execution-validator-integration.js`](../core/execution-validator-integration.js) - 系统集成层
- [`command-validate-execution.js`](../commands/command-validate-execution.js) - 命令行接口

## 更新日志

### 2026-03-25
- 初始版本发布
- 支持 5 阶段工作流验证
- 与 QualityGate、DeepAudit、SelfAudit 集成
- 提供命令行工具和程序化 API
