# Prompt Pattern Library 使用指南

## 概述

Prompt Pattern Library (P2) 是一个跨平台、可复用的提示词模式库，集成了业界验证的提示工程最佳实践。

## 已实现的 Pattern

| Pattern | 描述 | 适用场景 | 默认启用 |
|---------|------|----------|----------|
| `chain-of-thought` | 逐步推理 | 分析、设计 | Analyst, Architect |
| `react` | 推理+行动循环 | 复杂任务 | - |
| `tool-use` | 结构化工具调用 | 需要工具 | Coder, Tester |
| `structured-output` | 强制格式输出 | 所有代码任务 | 全部 |
| `few-shot` | 上下文学习 | 格式固定任务 | - |
| `self-consistency` | 多方案自一致 | 复杂决策 | - |
| `verification-loop` | 自检纠错 | 代码生成 | Dev, Coder |
| `session-checkpoint` | 会话检查点 | 长任务 | Dev, Coder, Tester |

## Agent 默认 Patterns

```javascript
const ROLE_PATTERNS = {
  analyst:      ['chain-of-thought', 'structured-output'],
  architect:    ['chain-of-thought', 'analytical', 'verification-loop'],
  developer:    ['session-checkpoint', 'structured-output', 'verification-loop'],
  tester:       ['structured-output', 'tool-use', 'session-checkpoint'],
  'coding-agent': ['session-checkpoint', 'tool-use', 'structured-output', 'verification-loop'],
  pm:          ['chain-of-thought', 'structured-output'],
};
```

## 使用方式

### 1. 使用默认 Patterns

```javascript
const { buildAgentPrompt } = require('./workflow/core/prompt-builder');

// 自动应用 developer 的默认 patterns
const { prompt, meta } = buildAgentPrompt(
  'developer',
  'Implement a REST API endpoint for user authentication',
  ['./docs/api-spec.md']
);
```

### 2. 显式指定 Patterns

```javascript
const { prompt, meta } = buildAgentPrompt(
  'custom-agent',
  'Complex analysis task',
  [],
  {
    patterns: ['chain-of-thought', 'self-consistency', 'structured-output'],
    patternParams: {
      'chain-of-thought': { reasoningSteps: 5 },
      'self-consistency': { samples: 3 },
    }
  }
);
```

### 3. 禁用 Patterns

```javascript
const { prompt, meta } = buildAgentPrompt(
  'developer',
  'Simple task',
  [],
  { usePatterns: false }  // 跳过 pattern 应用
);
```

### 4. 直接使用 Pattern Library

```javascript
const { PromptPatternLibrary, createWorkflowPatternLibrary } = require('./workflow/core/prompt-pattern-library');

const library = createWorkflowPatternLibrary();

// 获取单个 pattern
const cotPattern = library.getPattern('chain-of-thought', { reasoningSteps: 4 }, 'claude');

// 组合多个 patterns
const composed = library.compose(
  ['session-checkpoint', 'tool-use', 'verification-loop'],
  { /* shared params */ },
  'cursor'
);

// 智能推荐 patterns
const recommended = library.recommendPatterns(
  'Analyze and refactor this codebase',
  { hasTools: true, examples: [] }
);
// returns: ['chain-of-thought', 'tool-use', 'structured-output']
```

## 平台适配

Pattern Library 自动检测平台并应用相应适配：

```javascript
// 自动检测 (按优先级)
1. Cursor IDE → 'cursor'
2. Windsurf IDE → 'windsurf'
3. ANTHROPIC_API_KEY → 'claude'
4. OPENAI_API_KEY → 'openai'
5. GOOGLE_API_KEY → 'gemini'
6. 默认 → 'generic'
```

## A/B 测试集成

Pattern Library 与 PromptSlotManager 无缝配合：

```javascript
const { buildAgentPrompt, getPatternLibrary } = require('./workflow/core/prompt-builder');

// 在不同的 workflow 版本中测试不同 patterns
const variantA = buildAgentPrompt('developer', task, [], {
  patterns: ['chain-of-thought', 'verification-loop']
});

const variantB = buildAgentPrompt('developer', task, [], {
  patterns: ['react', 'verification-loop']
});

// 记录 pattern 性能
const library = getPatternLibrary();
library.recordOutcome('verification-loop', {
  success: taskCompleted,
  latency: responseTime
});
```

## 添加自定义 Pattern

```javascript
const { PromptPatternLibrary } = require('./workflow/core/prompt-pattern-library');

const library = new PromptPatternLibrary();

// 注册自定义 pattern
library.registerPattern('my-pattern', {
  name: 'My Custom Pattern',
  description: 'Description of what this pattern does',
  category: 'custom',
  parameters: {
    param1: { type: 'string', default: 'default_value' },
    param2: { type: 'number', default: 3 },
  },
  template(params) {
    return {
      prefix: '## My Pattern\n\nCustom instructions...',
      structure: `Using ${params.param1}...`,
      suffix: 'Remember to...',
    };
  },
});
```

## 性能指标

启用 Pattern Library 后，PromptBuilder 会自动记录：

```
[PromptBuilder] Patterns applied in 12ms
```

可以通过 `library.getMetrics(patternName)` 查询各 pattern 的使用统计。

## 最佳实践

1. **保持默认**: 大多数情况下，使用 role 默认 patterns 即可获得良好效果
2. **针对性优化**: 对特定任务类型，显式指定更精确的 patterns
3. **A/B 测试**: 使用 PromptSlotManager 验证 pattern 组合的有效性
4. **平台感知**: 依赖于自动平台检测，让 Pattern Library 选择最优格式
5. **监控指标**: 关注 pattern 应用时间和效果，持续优化

## 与 Output Styles 的关系

```javascript
// Output Styles 和 Patterns 可以叠加使用
const { prompt } = buildAgentPrompt(
  'developer',
  task,
  [],
  {
    outputStyle: 'structured',  // 输出格式
    patterns: ['verification-loop'],  // 推理模式
  }
);
```

- **Output Style**: 控制输出格式和详细程度
- **Pattern**: 控制推理过程和方法论

两者互补，共同提升 Agent 性能。