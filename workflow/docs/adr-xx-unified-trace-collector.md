# ADR-XX: Unified Trace Collector for Health Monitoring

## Status
Accepted

## Context

WorkFlowAgent 的日志系统存在以下问题：

### 问题 1：健康度观测困难
需要跨多个日志文件才能了解系统运行状态：
- Stage 执行耗时分散在各处
- 输入/输出 artifact 缺乏统一追踪
- 缺少完整性验证机制

### 问题 2：日志职责不清晰
功能日志与观测日志混在一起，导致：
- 功能模块耦合（如 evolution-log.json 需要独立运作）
- 观测数据被稀释
- 测试验证困难

## Decision

创建 `UnifiedTraceCollector` 模块，**仅用于系统健康度观测**。

### 核心原则

> **职责边界**：统一日志只关注健康度观测，不影响其他功能模块的独立日志。

### 日志职责划分

| 日志文件 | 职责 | 是否独立 |
|---------|------|---------|
| `workflow-trace.jsonl` | 系统健康度观测（Stage生命周期、错误、耗时） | ✅ 新增 |
| `evolution-log.json` | 进化信号收集与质量分析 | ✅ 保持独立 |
| `agent-handoff-log.json` | Agent 交接流程追踪 | ✅ 保持独立 |
| `communication-log.json` | Agent 通信详情 | ✅ 保持独立 |
| `agent-feedback-history.jsonl` | Agent 反馈历史 | ✅ 保持独立 |

### 统一事件格式
```json
{
  "ts": "2026-03-31T15:49:14.336Z",
  "session": "20260331154914-1936b563",
  "seq": 1,
  "event": "stage_start",
  "stage": "ANALYSE",
  "data": { ... }
}
```

### 事件类型（仅健康度观测）

| 事件类型 | 说明 |
|---------|------|
| `workflow_start` | 工作流开始 |
| `workflow_end` | 工作流结束 |
| `stage_start` | Stage 开始（含输入 artifact） |
| `stage_end` | Stage 结束（含输出 artifact、耗时） |
| `socratic_challenge` | 苏格拉底提问结果（置信度） |
| `test_result` | 测试结果 |
| `error` | 错误事件 |

### 不包含的事件

以下事件**不属于健康度观测**，保持独立日志：
- ❌ `evolution_signal` - 进化信号（保留在 evolution-log.json）
- ❌ `experience_recorded` - 经验记录（保留在 ExperienceStore）
- ❌ `agent_handoff` - Agent 交接（保留在 agent-handoff-log.json）
- ❌ `agent_feedback` - Agent 反馈（保留在 agent-feedback-history.jsonl）

### 内容捕获
- 自动捕获 artifact 内容和 SHA256 哈希
- 支持内容长度限制（默认 5000 字符）

### 完整性验证
```javascript
const verification = collector.verifyCompleteness(['ANALYSE', 'ARCHITECT', 'PLAN', 'CODE', 'TEST']);
// { passed: true, missing: [], found: [...] }
```

## Implementation

### 新增模块
- `core/unified-trace-collector.js` - 统一健康度观测收集器

### 修改模块
- `core/orchestrator-run.js` - 集成 UnifiedTraceCollector（仅 Stage 生命周期）

### 使用方式
```javascript
const traceCollector = new UnifiedTraceCollector({
  outputDir: './output',
  sessionId: 'run-123',
  captureArtifactContent: true,
});
traceCollector.start();

// 记录健康度相关事件
traceCollector.recordWorkflowStart({ requirement: '...' });
traceCollector.recordStageStart('ANALYSE', { inputArtifactPath: null });
traceCollector.recordStageEnd('ANALYSE', { 
  success: true, 
  outputArtifactPath: 'output/requirement.md',
  duration: 1000 
});
traceCollector.recordSocraticChallenge('ANALYSE', { questions, blindSpots, confidence });
traceCollector.recordWorkflowEnd({ success: true });

traceCollector.end();
```

## Consequences

### 正向
1. **职责单一**：只关注健康度观测，不影响功能模块
2. **格式统一**：JSONL 格式，易于解析
3. **完整性验证**：提供 API 验证关键事件是否完整触发
4. **测试友好**：测试脚本只需读取一个文件即可验证执行过程

### 不影响
- `evolution-log.json` 正常运行（EvolutionLoop 独立写入）
- `agent-handoff-log.json` 正常运行（AgentHandoffLog 独立写入）
- 其他功能模块的日志独立运作

## Related
- ADR-55: 十维度苏格拉底提问框架
- EvolutionLoop 打点日志机制（独立）
- Orchestrator 顺序执行模式

## References
- `workflow/core/unified-trace-collector.js`
- `workflow/core/orchestrator-run.js`
- `output/workflow-trace.jsonl` (运行时产物)
