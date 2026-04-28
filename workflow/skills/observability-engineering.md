---
name: observability-engineering
version: 1.0.0
description: 系统可观测性与诊断决策框架。在 TEST 阶段失败、生产环境问题排查、系统健康评估时加载，提供信号解读、根因定位和健康度量方法。
domains: ["observability", "monitoring", "debugging", "diagnostics", "bp"]
---

# 可观测性工程

> **使用场景**：系统异常排查、性能退化诊断、健康状况评估、监控体系设计时加载本 skill

## 第一性原理

> **可观测性的本质**：通过系统的外部输出（metrics、logs、traces）推断内部状态，从而在没有调试器的情况下理解系统行为。

---

## 三大信号体系

可观测性建立在三大支柱上：

| 信号 | 回答的问题 | 典型工具 | 时间粒度 |
|------|-----------|---------|---------|
| **Metrics（指标）** | 系统的宏观状态是什么？ | Prometheus, Grafana, CloudWatch | 秒/分钟级聚合 |
| **Logs（日志）** | 具体发生了什么？ | ELK, Loki, Splunk | 事件级精确 |
| **Traces（追踪）** | 请求走过了哪些路径？ | Jaeger, Zipkin, X-Ray | 请求级全链路 |

**核心原则**：
> 没有单一信号能回答所有问题。Metrics 告诉你"有问题"，Traces 告诉你"问题在哪里"，Logs 告诉你"为什么"。

---

## RED 方法：服务健康速查

RED 方法是评估服务健康的黄金标准：

| 字母 | 指标 | 意义 | 异常信号 |
|------|------|------|---------|
| **R**ate | 请求率 | 流量大小 | 突然下降 = 上游故障；突然飙升 = 攻击/重试风暴 |
| **E**rror | 错误率 | 失败比例 | 错误率上升 = 代码缺陷/依赖故障/资源耗尽 |
| **D**uration | 延迟 | 响应时间 | p99 飙升 = 资源竞争/依赖变慢/算法退化 |

**诊断矩阵**：

| Rate | Error | Duration | 可能原因 | 排查方向 |
|------|-------|----------|---------|---------|
| 正常 | 上升 | 正常 | 输入数据异常/权限错误 | 检查请求参数、auth 状态 |
| 正常 | 上升 | 上升 | 依赖服务故障/超时 | 检查下游依赖健康状态 |
| 下降 | 上升 | 上升 | 系统资源耗尽/崩溃 | 检查 CPU、内存、连接池 |
| 飙升 | 正常 | 上升 | 重试风暴/环路调用 | 检查重试策略、调用链路 |
| 下降 | 正常 | 正常 | 上游流量减少 | 检查负载均衡、网关状态 |

---

## 四大黄金信号（Google SRE）

在 RED 基础上扩展的完整监控框架：

| 信号 | 监控什么 | 告警阈值建议 |
|------|---------|-------------|
| **Latency（延迟）** | 请求处理时间 | p50 基线 + 30%，或 p99 > SLA |
| **Traffic（流量）** | 请求量/流量大小 | 同比/环比偏离 > 20% |
| **Errors（错误）** | 错误率 | > 0.1%（核心业务），> 1%（非核心） |
| **Saturation（饱和度）** | 资源使用率 | CPU > 70%，内存 > 80%，队列深度 > 100 |

> **关键 insight**：Saturation 是最容易被忽略的指标。系统在崩溃前通常有 saturation 预警，但如果没有监控，你只能看到崩溃后的 Error 和 Duration 飙升。

---

## 根因定位方法论

### 分层排查法

从上到下逐层缩小范围：

```
Layer 1: 客户端/入口层 — 请求是否到达了系统？
    ↓
Layer 2: 网关/负载均衡层 — 流量是否正确路由？
    ↓
Layer 3: 应用服务层 — 业务逻辑是否正常执行？
    ↓
Layer 4: 依赖服务层 — 外部 API/数据库/缓存是否正常？
    ↓
Layer 5: 基础设施层 — CPU/内存/网络/磁盘是否正常？
```

**每一层的检查清单**：

| 层级 | 检查项 | 关键指标/日志 |
|------|--------|-------------|
| 客户端 | 请求是否真的发出了？DNS 解析正常？ | 浏览器 DevTools、curl |
| 网关 | 路由规则匹配？限流触发？证书过期？ | 网关 access log、error log |
| 应用 | 抛异常？死锁？线程池耗尽？ | 应用 error log、thread dump |
| 依赖 | 数据库连接超时？缓存击穿？API 降级？ | 依赖调用 metrics、timeout log |
| 基础设施 | CPU steal？OOM？磁盘满？网络分区？ | node_exporter、系统日志 |

### 5 Whys 在可观测性中的应用

> 不要停在症状层面，追问到根本原因。

**示例**：
1. **Why** 服务返回 500？→ 数据库连接超时
2. **Why** 数据库连接超时？→ 连接池耗尽
3. **Why** 连接池耗尽？→ 某个查询没有释放连接
4. **Why** 查询没有释放连接？→ 异常路径缺少 finally 块
5. **Why** 异常路径缺少 finally？→ 代码 review 缺少资源安全检查

**根因**：代码 review 流程缺陷 → 修复：在 CI 中添加资源安全检查规则

---

## 日志策略

### 日志级别使用规范

| 级别 | 使用场景 | 生产环境是否开启 |
|------|---------|----------------|
| **DEBUG** | 开发调试细节 | 否（除非针对性排查） |
| **INFO** | 正常业务流程标记 | 是（采样） |
| **WARN** | 非致命异常、值得关注的事件 | 是 |
| **ERROR** | 请求失败、数据不一致、关键异常 | 是 |
| **FATAL** | 系统无法继续运行 | 是 + 立即告警 |

### 结构化日志规范

```json
{
  "timestamp": "2026-04-27T08:15:00Z",
  "level": "ERROR",
  "service": "order-service",
  "trace_id": "abc123",
  "span_id": "def456",
  "message": "Payment processing failed",
  "error": {
    "type": "TimeoutError",
    "message": "payment-gateway timeout after 5000ms",
    "stack": "..."
  },
  "context": {
    "order_id": "ORD-789",
    "user_id": "USR-456",
    "amount": 99.99
  }
}
```

**规则**：日志必须包含 `trace_id`，便于跨服务串联。

---

## Tracing 最佳实践

### 何时创建 Span

| 场景 | 是否创建 Span | 理由 |
|------|-------------|------|
| 跨服务调用 | ✅ 必须 | 追踪请求链路 |
| 数据库查询 | ✅ 建议 | 识别慢查询 |
| 缓存访问 | ✅ 建议 | 识别缓存命中率问题 |
| 纯内存计算 | ❌ 不需要 | 开销大于收益 |
| 日志记录 | ❌ 不需要 | 用日志关联即可 |

### Trace 采样策略

| 策略 | 适用场景 | 配置 |
|------|---------|------|
| **头部采样** | 开发/测试环境 | 100% 采样 |
| **概率采样** | 高流量生产环境 | 1% - 10% 采样 |
| **尾部采样**** | 异常追踪 | 错误请求 100% 采样 |

> **尾部采样（Tail-based Sampling）** 是最有价值的策略：保留所有错误/慢请求的 trace，丢弃正常请求的 trace。

---

## 反模式

| 反模式 | 症状 | 修复 |
|--------|------|------|
| **监控一切** | 海量低价值指标，告警疲劳 | 聚焦 RED + 业务核心指标 |
| **日志即调试器** | 到处打 log，生产环境 DEBUG | 用 metrics 发现问题，用 trace 定位，用 log 确认 |
| **静态阈值告警** | 夜间流量低时误告警 | 使用动态基线/同比环比告警 |
| **无上下文日志** | "Error occurred" — 无法定位 | 每条日志包含 trace_id + 业务上下文 |
| **事后监控** | 上线后才加监控 | 监控即代码，随功能一起上线 |

---

## Rules

1. **Every production service must expose a /health endpoint** — 返回依赖状态（数据库、缓存、外部 API），不是简单的 "OK"。调用方根据返回值做降级决策。

2. **Alert on symptoms, not causes** — 告警应基于用户可见的症状（Error Rate > 1%, p99 Latency > 500ms），而非原因（CPU > 80%）。原因是诊断信息，不是告警条件。

3. **Dashboards must answer a specific question** — 不要创建"服务总览"这样的万能 dashboard。每个 dashboard 只回答一个具体问题："支付服务健康吗？"、"最近部署导致退化了吗？"

4. **Logs without trace_id are useless in distributed systems** — 分布式系统中，没有 trace_id 的日志是信息孤岛。必须确保所有日志包含 trace_id。

5. **Test your alerts — if it didn't page in the last 3 months, it's probably broken** — 定期（每月）触发测试告警，验证告警链路（检测 → 通知 → 响应）是否正常工作。

6. **Correlation ID must propagate across all service boundaries** — trace_id / correlation_id 必须在所有边界传递：HTTP header、消息队列属性、gRPC metadata、数据库注释（如 MySQL 的 `/* trace_id=abc */`）。

## SOP

1. **Phase 1: Symptom Detection** — 收到告警或用户反馈。确认：影响范围（多少用户？哪些功能？）、开始时间、是否与部署/变更相关。

2. **Phase 2: Signal Gathering** — 查看 RED 指标：Rate 变化？Error 上升？Duration 飙升？哪个指标最先异常？（最先异常的往往是根因所在层）

3. **Phase 3: Layer Isolation** — 使用分层排查法，从上到下逐层验证。每层问：该层是否正常？如果是，问题在下一层。

4. **Phase 4: Root Cause Identification** — 定位到具体组件后，查看 traces 找到具体请求路径，查看 logs 找到具体错误。

5. **Phase 5: Fix Validation** — 修复后观察 RED 指标恢复正常。确认没有引入新问题。如果修复无效，返回 Phase 2。

6. **Phase 6: Post-Incident Review** — 记录事件时间线、根因、修复措施、预防措施。更新监控/告警以检测类似问题。

## Checklist

### 监控覆盖
- [ ] RED 指标暴露（Rate、Error、Duration）
- [ ] 关键依赖的健康检查（数据库、缓存、外部 API）
- [ ] 基础设施指标（CPU、内存、磁盘、网络）
- [ ] 业务核心指标（订单量、支付成功率等）

### 告警质量
- [ ] 告警基于症状而非原因
- [ ] 告警有明确的运行手册（Runbook）
- [ ] 告警阈值经过基线校准
- [ ] 告警链路定期测试

### 排查效率
- [ ] 所有服务日志包含 trace_id
- [ ] Trace 在跨服务边界正确传递
- [ ] Dashboard 按场景组织（而非按服务罗列）
- [ ] 关键路径有全链路追踪

## Best Practices

1. **Use "SLO-based alerting" instead of threshold alerting** — 定义服务的 SLO（如 "99.9% 的请求延迟 < 200ms"），当错误预算消耗速度超过允许范围时告警。这比静态阈值更能反映用户体验。

2. **Create a "metrics tree" for each critical user journey** — 为每个核心用户旅程（如下单流程）创建指标树：顶层是转化率，下层分解到每一步的耗时和错误率。快速定位哪一步出了问题。

3. **Log structured data, not strings** — `"User ${userId} placed order ${orderId}"` → `{event: "order_placed", userId: "...", orderId: "..."}`。结构化日志支持聚合查询和自动分析。

4. **Embrace "observability-driven development"** — 在写功能代码的同时写监控代码：功能上线时必须同时有对应的 metrics、logs、traces。和测试驱动开发一样，监控是功能的一部分。

## Gotchas

1. **Metric cardinality explosion** — 高 cardinality 标签（如 user_id、order_id）会导致时序数据库内存爆炸。限制标签 cardinality < 1000，高 cardinality 数据放到 logs/traces 中。

2. **Distributed trace gaps** — 如果一个服务没有接入 tracing，trace 在该点断裂。通常无法从 trace 中意识到"这里少了一段"。需要在架构文档中标注 tracing 覆盖范围。

3. **Clock skew breaks traces** — 跨服务器追踪依赖精确的时间戳。如果 NTP 不同步，trace 中的 span 顺序可能错乱。确保所有节点使用 NTP，容忍 < 10ms 的 skew。

4. **Sampling makes rare bugs invisible** — 概率采样可能导致罕见错误从未被采样到。对错误请求使用 100% 采样（tail-based），或对特定错误码强制采样。

## Context Hints

1. **"You can't monitor yourself out of a bad architecture"** — 可观测性是诊断工具，不是架构补救措施。如果系统本身就不可理解（spaghetti architecture），再多的监控也无法让你理解它。

2. **MTTR matters more than MTBF** — 平均修复时间（MTTR）比平均故障间隔（MTBF）更重要。系统总是会故障的，关键是多快能恢复。投资于可观测性和自动化修复，而非追求永不故障。

3. **Each layer of abstraction hides information** — 使用 serverless/PaaS 时，你失去了对基础设施的可见性。确保你监控的指标覆盖了你能看到的所有层次。

4. **Observability is a practice, not a tool** — 购买 Datadog/New Relic 不等于有可观测性。没有正确的埋点、合理的告警策略、训练有素的响应团队，工具只是昂贵的 dashboard。

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-27 | Initial creation — meta-cognitive skill for observability engineering |
