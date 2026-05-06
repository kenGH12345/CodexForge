---
name: concurrency-patterns
version: 1.0.0
description: 并发与并行模式决策框架。在设计异步架构、处理竞态条件、选择同步原语、评估并行策略时加载，提供 async 决策方法、锁模式、Actor 模型和背压策略。
domains: ["concurrency", "parallelism", "async", "performance", "bp"]
---

# 并发与并行模式

> **使用场景**：设计异步架构、处理竞态条件、选择同步原语、评估并行策略、解决死锁问题时加载本 skill

## 第一性原理

> **并发的本质**：通过将任务分解为可独立执行的单元来提升系统吞吐量，核心挑战不是"如何同时执行"，而是"如何安全地共享状态"。

---

## Async vs Sync 决策框架

### 何时使用异步

| 场景 | 推荐 | 理由 |
|------|------|------|
| I/O 操作（网络、磁盘、数据库） | **异步** | 线程不阻塞，可处理其他请求 |
| CPU 密集型计算 | **同步/多进程** | 异步不会加速 CPU 计算 |
| 用户等待的响应 | **同步** | 用户需要即时结果 |
| 长时间后台任务 | **异步 + 队列** | 不阻塞主流程 |
| 多个独立 I/O 可并行 | **异步并发** | 同时发起，等待全部完成 |

### 并发模型选择

| 模型 | 特点 | 适用 | 代表 |
|------|------|------|------|
| **多线程** | 共享内存，OS 调度 | CPU 密集型 | Java, C++ |
| **异步 I/O** | 单线程事件循环 | I/O 密集型 | Node.js, Python asyncio |
| **多进程** | 隔离内存，无共享 | CPU 密集型 + 隔离需求 | Python multiprocessing |
| **Actor 模型** | 消息传递，无共享 | 高并发分布式 | Akka, Erlang |
| **CSP** | 通道通信 | 结构化并发 | Go |

### 决策矩阵

```
任务类型？
    ├── CPU 密集型 → 多线程/多进程
    │       └── 需要共享状态？
    │               ├── 是 → 多线程 + 锁
    │               └── 否 → 多进程（隔离更安全）
    └── I/O 密集型 → 异步 I/O
            └── 可独立执行的请求数量？
                    ├── 大量 → 事件循环（async/await）
                    └── 少量 → 线程池
```

---

## 竞态条件识别与修复

### 常见竞态条件模式

| 模式 | 症状 | 根本原因 |
|------|------|---------|
| **读-改-写** | 计数器丢失更新 | 读取和写入不是原子操作 |
| **检查-然后-行动** | 双重初始化 | 检查条件和执行操作之间有时间窗口 |
| **发布-订阅** | 订阅者错过早期事件 | 订阅发生在发布之后 |

### 修复策略

| 策略 | 实现 | 适用 |
|------|------|------|
| **原子操作** | CAS（Compare-And-Swap） | 简单计数器、标志位 |
| **互斥锁** | Mutex / Lock | 临界区代码块 |
| **信号量** | Semaphore | 资源池访问控制 |
| **读写锁** | RWLock | 读多写少场景 |
| **不可变数据** | 复制-on-write | 共享读取，独立修改 |
| **线程本地存储** | TLS | 每个线程独立数据 |

### 检测方法

```
1. 代码审查：寻找"先读后写"或"先检查再执行"模式
2. 静态分析：使用 ThreadSanitizer / Helgrind 等工具
3. 压力测试：高并发下观察是否出现不一致结果
4. 日志分析：追踪同一资源的并发访问序列
```

---

## 锁原语选择指南

### 锁类型对比

| 锁类型 | 特点 | 适用场景 | 风险 |
|--------|------|---------|------|
| **Mutex** | 互斥，一次一个线程 | 短临界区 | 死锁、优先级反转 |
| **RWLock** | 读共享，写独占 | 读多写少（>10:1） | 写饥饿 |
| **SpinLock** | 自旋等待 | 极短临界区（< 1μs） | CPU 浪费 |
| **Semaphore** | 许可计数 | 资源池（连接池、线程池） | 信号量泄漏 |
| **ReentrantLock** | 可重入 | 递归调用 | 比 Mutex 开销大 |

### 锁粒度设计

| 粒度 | 并发度 | 复杂度 | 适用 |
|------|--------|--------|------|
| **粗粒度** | 低 | 低 | 简单场景，并发不高 |
| **细粒度** | 高 | 高 | 高并发，竞争大 |
| **无锁** | 最高 | 最高 | 极致性能，CAS 循环 |

**规则**：
- 优先粗粒度，仅在性能测试证明有瓶颈时才细化
- 锁的范围尽可能小（只保护必要的数据）
- 避免在持有锁的情况下调用外部代码（可能阻塞或死锁）

### 死锁预防

**死锁四条件**（Coffman 条件）：
1. 互斥（Mutual Exclusion）
2. 持有并等待（Hold and Wait）
3. 不可抢占（No Preemption）
4. 循环等待（Circular Wait）

**破坏策略**：
| 条件 | 破坏方法 |
|------|---------|
| 持有并等待 | 一次性申请所有资源，失败则释放已持有的 |
| 循环等待 | 全局资源排序，按顺序申请 |
| 不可抢占 | 设置超时，超时后释放并重试 |

### 锁顺序规则

```
全局锁顺序（按内存地址排序）：

lock(A) → lock(B) → lock(C)

任何线程获取多个锁时必须按此顺序。
违反此顺序 = 死锁风险。
```

---

## Actor 模型

### Actor 核心概念

Actor 是一种并发隔离边界：每个 Actor 拥有私有状态，通过邮箱串行处理不可变消息，外部只能发送消息而不能直接读取或修改其内部状态。

```
Actor = 私有状态 + 消息处理行为 + 串行邮箱 + 监督关系

- 私有状态：只在 Actor 内部读写，不跨线程共享
- 消息处理：一次处理一条消息，避免显式锁竞争
- 邮箱队列：吸收并发请求，通过顺序消费建立 happens-before
- 监督关系：父 Actor 负责子 Actor 的失败恢复策略
```

### 何时使用 Actor

| 条件 | 是否适用 |
|------|---------|
| 需要高并发且状态共享复杂 | ✅ 强烈推荐 |
| 分布式系统中需要位置透明 | ✅ 推荐 |
| 简单 CRUD 无复杂并发 | ❌ 过度设计 |
| 需要跨 Actor 事务 | ❌ Actor 不支持 ACID 跨 Actor |

### Actor 设计原则

1. **Actor 不共享状态** — 状态只能通过消息传递。违反此原则就退化为多线程编程。
2. **消息不可变** — 发送的消息应该是 immutable value。修改消息副本，不要共享引用。
3. **Actor 层级监督** — 子 Actor 失败由父 Actor 处理。设计监督策略：恢复、重启、停止、升级。

---

## 背压（Backpressure）

### 什么是背压

当生产者速度 > 消费者速度时，系统资源（内存、队列）会无限增长导致崩溃。背压是限制生产者速度的反馈机制。

### 背压策略

| 策略 | 实现 | 适用 |
|------|------|------|
| **丢弃** | 队列满时丢弃新数据 | 可容忍丢失（日志、监控） |
| **阻塞** | 生产者等待消费者 | 不能丢失数据 |
| **限速** | 令牌桶控制生产速率 | 生产者可控 |
| **动态批处理** | 消费者加速处理（合并处理） | 消费者可批处理 |
| **水平扩展** | 增加消费者实例 | 无状态消费者 |

### 背压信号传递

```
Producer ──数据──> Queue ──数据──> Consumer
         <──credit──        <──ack──

信用机制：Consumer 告知 Producer 还能接收多少数据
Producer 在 credit > 0 时才发送
```

---

## 并行模式

### Fork-Join

```
        [Main]
          │
    ┌─────┼─────┐
    ▼     ▼     ▼
  [T1]  [T2]  [T3]
    │     │     │
    └─────┼─────┘
          ▼
       [Join]
```

**适用**：大数据处理、批量任务。所有子任务完成后汇总结果。

### Pipeline

```
[Stage 1] ──> [Stage 2] ──> [Stage 3] ──> [Stage 4]
读取文件      解析          转换          写入
```

**适用**：流式数据处理。每个阶段独立运行，通过队列连接。

### Map-Reduce

```
[Input] ──split──> [M1,M2,M3] ──shuffle──> [R1,R2] ──> [Output]
          Map阶段              Reduce阶段
```

**适用**：大规模分布式数据处理。

---

## 反模式

| 反模式 | 症状 | 修复 |
|--------|------|------|
| **全局锁** | 所有操作串行，无并发 | 拆分锁，按资源或区域分离 |
| **锁顺序不一致** | 偶发死锁，难以复现 | 定义全局锁顺序，代码审查 |
| **在锁中调用外部服务** | 外部服务延迟导致所有线程阻塞 | 外部调用放在锁外 |
| **忽略背压** | 内存无限增长，OOM | 实现队列上限 + 丢弃/阻塞策略 |
| **过度并行** | 上下文切换开销 > 并行收益 | 限制并发度 = CPU 核心数 × 1.5 |
| **共享可变状态** | 难以追踪的竞态条件 | 不可变数据 + 消息传递 |
| **线程泄漏** | 线程数持续增长，资源耗尽 | 使用线程池，设置最大值 |

---

## Rules

1. **Minimize shared mutable state** — 共享可变状态是并发 bug 的根源。优先使用不可变数据、消息传递或线程本地存储。

2. **Always define a global lock ordering** — 当需要获取多个锁时，必须按全局一致的顺序获取。违反此规则 = 死锁定时炸弹。

3. **Never call external services while holding a lock** — 外部服务的延迟是不可控的。在持有锁时调用外部服务会把整个系统的吞吐量降低到外部服务的最慢响应时间。

4. **Use async I/O for I/O-bound workloads** — I/O 密集型任务使用异步模型（async/await、事件循环）比多线程更高效，因为不需要为每个请求占用一个 OS 线程。

5. **Implement backpressure for all queue-based systems** — 任何有队列的系统都必须有背压机制。无背压的队列会在高负载下导致内存耗尽（OOM）。

6. **Prefer coarse-grained locking until profiling proves otherwise** — 细粒度锁增加复杂度和死锁风险。先用粗粒度锁，性能测试证明有瓶颈后再优化。

7. **All concurrent code must be tested under load** — 并发 bug 在单元测试中几乎不可见。必须使用压力测试（并发数 > 100）才能发现竞态条件。

## SOP

1. **Phase 1: Concurrency Requirement Analysis** — 分析任务的 I/O/CPU 比率、并发用户数、状态共享需求。

2. **Phase 2: Model Selection** — 选择并发模型：异步 I/O、多线程、多进程、Actor 或组合。

3. **Phase 3: Shared State Identification** — 识别所有共享可变状态。评估是否可以消除（不可变、消息传递、TLS）。

4. **Phase 4: Synchronization Design** — 为必须共享的状态选择同步机制：原子操作、锁、信号量或无锁数据结构。

5. **Phase 5: Lock Ordering Definition** — 定义全局锁获取顺序。在代码中注释每个多锁获取点的顺序依据。

6. **Phase 6: Backpressure Design** — 为有队列的系统设计背压策略。定义队列上限、满队列行为和恢复策略。

7. **Phase 7: Load Testing** — 使用压力测试工具模拟高并发场景（目标并发 > 预期峰值的 2 倍）。观察竞态条件和性能瓶颈。

## Checklist

### 并发安全
- [ ] 所有共享可变状态已识别
- [ ] 同步机制已选择并实施
- [ ] 全局锁顺序已定义
- [ ] 锁的粒度适当（不过大也不过小）
- [ ] 外部调用不在锁内

### 竞态条件
- [ ] "读-改-写"模式已检查
- [ ] "检查-然后-行动"模式已检查
- [ ] 压力测试通过（并发 > 100）
- [ ] 静态分析工具已运行（ThreadSanitizer 等）

### 背压
- [ ] 所有队列有大小上限
- [ ] 队列满时的行为已定义（丢弃/阻塞/限速）
- [ ] 背压信号能传递到生产者
- [ ] OOM 风险已评估

### 死锁
- [ ] 多锁获取按全局顺序
- [ ] 锁有超时机制
- [ ] 死锁检测工具已配置

## Best Practices

1. **Use thread pools with bounded queues** — 无界队列隐藏了并发问题（任务堆积不会被发现）。有界队列 + 拒绝策略迫使你在设计阶段处理背压。

2. **Design for deterministic testing** — 并发 bug 难复现是因为执行顺序不确定。使用确定性调度器（如 Java 的 DeterministicTaskQueue）在测试中模拟各种交错执行顺序。

3. **Isolate side effects in concurrent code** — 并发代码中的副作用（I/O、状态修改）应该集中在尽可能小的代码区域。纯函数天然线程安全。

4. **Use structured concurrency** — 避免"启动后忘记"（fire-and-forget）的并发模式。每个并发任务都应该有明确的父任务、生命周期和取消机制。

5. **Monitor contention metrics** — 锁竞争程度是扩展性的关键指标。如果锁竞争 > 10%，是时候优化锁粒度或改用无锁结构。

6. **Document invariants that must hold across threads** — 明确注释哪些变量/条件在多线程环境下必须保持不变。这是审查并发代码时最重要的文档。

## Gotchas

1. **Double-checked locking is broken without memory barriers** — 双检锁（DCL）在没有正确内存屏障的语言/平台上会失效。使用语言提供的线程安全初始化方式（如 Java `volatile`, C++ `std::call_once`）。

2. **volatile != thread-safe** — `volatile` 只保证可见性，不保证原子性。`volatile` 的复合操作（i++）仍然不是线程安全的。

3. **Thread-local state leaks in thread pools** — 线程池复用线程，线程本地存储（TLS）中的数据不会被自动清理。使用线程池时必须在任务结束时清理 TLS。

4. **Amdahl's Law limits speedup** — 如果代码中有 10% 必须串行执行，无论多少核心，最大加速比也只有 10 倍。识别并最小化串行瓶颈。

5. **Context switch overhead at high concurrency** — 当并发线程数 > 2×CPU 核心数时，上下文切换开销可能超过并行收益。使用线程池限制并发度。

## Context Hints

1. **Concurrency bugs are Heisenbugs** — 并发 bug 在调试时往往消失（因为调试改变了时序）。不要依赖调试来发现并发问题，要依赖压力测试和静态分析。

2. **Shared nothing scales best** — Actor 模型的"不共享"哲学是扩展性的终极答案。如果可能，用消息传递替代共享状态。

3. **Your language's async model is a library, not magic** — async/await 只是语法糖，底层仍是事件循环/回调。理解底层机制才能写出高性能的异步代码。

4. **Parallelism is about performance, concurrency is about correctness** — 并行（parallelism）关注"同时执行以提升速度"，并发（concurrency）关注"多个执行单元安全地交互"。两者不同但相关。

5. **The best concurrent code is code that doesn't need concurrency** — 如果可以通过不可变数据、函数式编程或重新设计算法来消除并发需求，那比最优雅的锁策略更好。

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-27 | Initial creation — meta-cognitive skill for concurrency and parallelism patterns |