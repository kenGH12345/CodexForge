---
name: dimension-framework
version: 1.0
purpose: 四维推导框架——项目专家 skill 的完备性推导规则
triggers:
  keywords: [gen-skill, 维度推导, 四维框架, D1, D2, D3, D4, 结构维, 行为维, 通讯维, 契约维, 完备性, 盲区检测]
  roles: [skill-author]
layer: meta
---

# 四维推导框架（Dimension Framework）

> 这份文档定义了 **D1~D4 四维正交坐标系**，作为 skill-author-guide 的核心推导规则。
> 它回答一个根本问题：**"一个项目专家 skill 应该包含哪些维度的知识？"** —— 用完备性证明代替经验列举。

---

## § 0. 这份文档是什么

### 定位

**这不是维度清单**（清单在 `p0-dimensions.md`），而是**维度清单的生成规则**。任何项目，沿 D1/D2/D3/D4 四个正交维度逐项推导，即可穷举该项目的所有专家知识。

### 为什么读这份文档

读完 skill-author-guide 主文件后，如果你产生以下任一疑问，说明必须读这份：

- "如何确认我的 SKILL.md 没有遗漏关键知识维度？"
- "为什么 14 个维度能代表一个项目的全部？"
- "遇到一个奇怪的项目（例如纯库、纯 CLI），哪些维度可以跳过？"
- "我看到一堆代码，不知道该归到哪一节怎么办？"

### 阅读顺序

```
skill-author-guide.md (主文件) → [本文档] → p0-dimensions.md (详细 rubric) → examples.md (对比示例)
```

---

## § 1. 四维坐标系总览

### 核心公式

```
  任何项目知识 = f(D1 结构, D2 行为, D3 通讯, D4 契约)
```

四维由 **2 个正交轴** 穷举生成：

```
              【静态编译时 vs 动态运行时】
                         │
         ┌───────────────┼───────────────┐
         │               │               │
  静态·内部:          静态·边界:
  🏗️ D1 结构维       📜 D4 契约维
  ──────────────────────────────────── 【内部单组件 vs 边界跨组件】
  动态·内部:          动态·边界:
  ⚙️ D2 行为维       🔄 D3 通讯维
```

### 一句话定义

| 维度 | 核心问题 | 典型证据 |
|---|---|---|
| **🏗️ D1 结构维**（Structure） | 代码如何组织？ | 目录树、模块清单、类层次、可复用符号 |
| **⚙️ D2 行为维**（Behavior） | 运行时发生什么？ | 入口函数、调用链、状态转移、事件流 |
| **🔄 D3 通讯维**（Communication） | 组件之间如何交换数据？ | 跨模块调用、事件总线、网络通讯、数据绑定 |
| **📜 D4 契约维**（Contract） | 组件之间约定是什么？ | 接口定义、协议格式、DTO schema、错误码 |

### 代表章节（与 p0-dimensions.md 映射）

```
D1 结构 (3): §2 模块管理 / §4 架构框架 / §11 公共组件
D2 行为 (4): §1 流程 / §3 设计模式 / §6 状态管理 / §10 日志系统
D3 通讯 (5): §5 事件系统 / §9 网络通信 / §12 MVC 数据流 ✨ / §13 模块间通讯 ✨ / M-2 修改影响半径
D4 契约 (4): §7 配置 / §8 持久化 / §14 协议契约 ✨ / M-1 错误处理
元维度 (1): M-3 Onboarding 路径
```

✨ = 新增 3 节，正好补齐 D3/D4 历史盲区。

---

## § 2. D1 结构维（Structure）详解

### 核心问题

- 代码按什么哲学组织到目录、模块、类、函数？
- 哪些元素是核心骨架，哪些是可复用工具？

### 证据来源

| 数据 | 来源 |
|---|---|
| 目录/文件树 | `output/code-graph.json` → `filePaths[]` |
| 符号分类统计 | `output/code-graph.json` → `categoryStats` |
| 热点符号 | `output/code-graph.json` → `hotspots[]`（Top-N，按引用数/调用数） |
| 可复用符号 | `output/code-graph.json` → `reusableSymbols[]` |
| 跨模块关系（结构视角） | `output/code-graph.json` → 按 filePath 前缀分组聚合 |

### 子项推导规则

对每个项目，按以下清单逐项检查，有则成节：

1. **顶层目录结构**：项目根下的主要目录各自职责（必有）
2. **分层划分**：是否有 entry / core / orchestration / utility / test 等分层（多数项目有）
3. **模块清单**：Top-N 模块、每模块文件数与热度（必有）
4. **类层次结构**：是否有显著的继承树、抽象基类（按语言差异）
5. **可复用符号集群**：被大量引用的工具类/函数（必有）
6. **目录与模块命名约定**：PascalCase / kebab-case / 复数单数规则

### 反模式

- ❌ "本项目采用分层架构" —— 没说哪几层
- ❌ "有 300 个文件" —— 没说按什么组织
- ❌ 把所有文件列出来 —— 没抽象

### 跨项目类型映射示例

| 项目类型 | D1 具体化 |
|---|---|
| 游戏项目 | Assets/Scripts 分 Core/UICtrl/Systems/Framework/XLuaWork |
| Web 后端 | controllers/services/models/middleware/utils |
| 前端 SPA | components/pages/store/hooks/utils |
| CLI 工具 | cmd/internal/pkg（Go 惯例）；src/cli/core（Node 惯例） |

---

## § 3. D2 行为维（Behavior）详解

### 核心问题

- 系统启动发生什么？主循环做什么？一次典型操作如何贯穿代码？
- 有哪些关键状态？状态如何迁移？

### 证据来源

| 数据 | 来源 |
|---|---|
| 入口函数 | `output/business-logic.json` → `entryPoints` |
| 调用链 | `output/code-graph.json` → `callEdges{}` |
| 业务流程 | `output/business-logic.json` → `businessFlows` |
| 核心服务 | `output/business-logic.json` → `coreServices` |
| 设计模式识别 | 符号命名：Factory / Observer / Strategy / Command 等 |
| 生命周期钩子 | 命名：OnStart / Awake / Init / Dispose / Destroy |

### 子项推导规则

1. **项目生命周期**：启动流程 → 主循环 → 关闭清理
2. **设计模式**：项目中显著使用的模式（有源码位置和实例）
3. **状态管理**：全局/模块/UI 状态的存储方式和转移规则
4. **日志可观测性**：日志级别、格式、输出通道
5. **资源管理**（游戏/移动端）：加载/释放/引用计数
6. **并发/异步模型**：线程 / 协程 / Promise / Task 的选型

### 反模式

- ❌ "本项目使用 Observer 模式" —— 没说在哪几个文件、为什么
- ❌ "启动时会初始化各个模块" —— 没说初始化顺序

### 跨项目类型映射示例

| 项目类型 | D2 具体化 |
|---|---|
| 游戏 | GameRoot.Awake → 子系统 Init → 主循环 Update |
| Web 后端 | app.listen → 中间件链 → handler → 数据库 |
| 前端 SPA | createApp → router.beforeEach → 组件挂载 |
| CLI | main → 参数解析 → 命令分发 → 业务执行 |

---

## § 4. D3 通讯维（Communication）详解

### 核心问题

- A 模块要用 B 的功能时用什么方式？
- 进程内如何传递数据？跨设备如何协议交换？

### ⚠️ 为什么最容易被忽视

D3 的证据**没有物理中心**：它分散在多个文件里——"调用方 + 被调方 + 中间件"。不像 D1（目录可见）、D2（调用链可见），D3 需要**聚合多个文件的边关系**才能看到全貌。

因此 **Agent 必须主动用跨模块 callEdges + 命名模式识别** 来发现 D3 证据，否则就会漏写。

### 证据来源

| 数据 | 来源 |
|---|---|
| 跨模块调用 Top-N | `output/code-graph.json` → `callEdges{}` 按模块分组统计 |
| 事件总线识别 | 命名：Fire / Emit / Publish / On + Listener / Subscribe |
| DI 容器识别 | 命名：Container / Provider / Register / Resolve / Inject |
| 单例访问模式 | `Singleton<T>.Instance` / `XxxSys.I` / `getInstance()` |
| 网络通讯类 | 命名：Network / Connection / Socket / Http / gRPC |
| MVVM/数据绑定 | 命名：*Model*.addXxxListener / PropertyChanged / observe / ModelBinder |
| 协程/Promise 通讯 | `await` / `.then()` / `StartCoroutine` / `yield return` |

### 子项推导规则

D3 分 **3 个子类**，各自必查：

#### D3-a 进程内通讯（模块间）

1. 跨模块 callEdges Top-10（按 callCount 排序）
2. 通讯手段分类：直接调用 / 事件 / 单例 / DI / 回调 / Promise
3. 推荐/禁止规则（如"UI 禁止直接调 Net，必须走 Controller"）
4. 选型决策表

#### D3-b 进程内数据流（MVC/MVVM/Flux）

1. 数据层入口（<DataStore> / Store / Vuex store）
2. 视图层绑定方式（data-binding / subscribe / selector）
3. 数据改变 → 视图刷新的完整代码示例
4. 绑定生命周期（alive / active / mounted / beforeDestroy）

#### D3-c 跨设备通讯（网络）

1. 传输协议（HTTP / WebSocket / 自定义 TCP）
2. 心跳与重连策略
3. 消息编解码（JSON / ProtoBuf / <IDLToolchain> / 自研）
4. 错误处理与安全边界

### 反模式

- ❌ "本项目用事件解耦模块" —— 没说事件类型、事件总线实现、事件流
- ❌ "数据改变时视图自动刷新" —— 没说绑定机制
- ❌ "通过网络同步数据" —— 没说协议、格式、时序

### 跨项目类型映射示例

| 项目类型 | D3 具体化 |
|---|---|
| 游戏 | D3-a: Systems ↔ UICtrl 跨 2928 次调用 / D3-b: <DataStore> 响应式 / D3-c: <SecureTransportProtocol> 网络库 + <IDLToolchain> 协议 |
| Web 后端 | D3-a: service 层互相调用 / D3-b: ORM 数据流 / D3-c: REST API + OpenAPI |
| 前端 SPA | D3-a: Pinia store / D3-b: props-down/emit-up + v-model / D3-c: axios + REST |
| CLI | D3-a: cmd 模块间函数调用 / D3-b/c 通常不适用 |

---

## § 5. D4 契约维（Contract）详解

### 核心问题

- 组件之间的**形式约定**是什么？（方法签名、数据结构、消息格式、错误码）
- 修改一个契约时，连带影响是什么？

### 如何发现"隐藏契约"

D4 证据的**高度抽象性**让 Agent 容易视而不见：`IEvent` 接口定义可能只有 3 行代码，但背后是几十个实现类。策略：

1. 按关键字搜：`interface` / `abstract class` / `protocol` / 按语言差异
2. 按大小扫：项目 Top-5 最大文件中有 `*Proto*` / `*Protocol*` / `*Msg*` → 基本是协议集中定义
3. 按密度扫：某目录下 `interface` 关键字密度异常高 → 契约集群
4. 按工具链：`.proto` / `.thrift` / `.fbs` / `.graphql` / `openapi.yaml` → 外部契约

### 证据来源

| 数据 | 来源 |
|---|---|
| 接口/抽象类定义 | 按关键字：interface / abstract / virtual |
| 协议定义文件 | 按命名：`*Proto*` / `*Protocol*` / `*Msg*` / `*Packet*` / `*Request*` |
| DTO / Model Schema | 纯字段无逻辑的类集群 |
| 错误码/异常体系 | 按命名：Error / Exception / ErrCode / Result |
| 配置契约 | `.json` / `.yaml` / `.toml` schema + 配置表字段定义 |
| 持久化契约 | DB schema / 序列化格式 / 存档格式版本号 |

### 子项推导规则

D4 分 **4 个子类**，各自必查：

#### D4-a 接口契约

1. 关键抽象接口/基类清单
2. 接口命名约定（IXxx / xxx-able / xxx-interface）
3. 接口稳定性规则（可增字段？可删方法？）

#### D4-b 数据契约（DTO/Model Schema）

1. Model 类集群及其字段
2. 数据验证策略（在哪一层校验？）
3. 数据版本迁移策略

#### D4-c 协议契约（跨进程/跨设备）

1. 协议文件清单 + 生成工具链（protoc / <IDLToolchain> / 自研）
2. 消息编解码流程
3. 版本兼容策略（新增字段默认值、废弃字段处理）

#### D4-d 错误契约

1. 异常/错误码体系（枚举清单）
2. 错误传播规则（抛异常 / 返回 Result monad / 回调）
3. 重试/降级策略

### 反模式

- ❌ "本项目使用 JSON 作为传输格式" —— 没说 schema 定义在哪
- ❌ "错误会被捕获" —— 没说错误码、传播路径、恢复策略
- ❌ "Model 是纯数据类" —— 没列出哪些字段

### 跨项目类型映射示例

| 项目类型 | D4 具体化 |
|---|---|
| 游戏 | D4-a: IEvent/ISys / D4-b: CommonModelData 体系 / D4-c: <IDLToolchain> <generated-proto> 1.36MB / D4-d: ErrCode 枚举 |
| Web 后端 | D4-a: Service interfaces / D4-b: ORM entities / D4-c: OpenAPI / D4-d: HTTP 状态码 + 自定义 errCode |
| 前端 SPA | D4-a: 组件 Props 类型 / D4-b: Store state 类型 / D4-c: API client types / D4-d: try-catch + toast |
| CLI | D4-a: 命令接口 / D4-b: 输入/输出 schema / D4-c: 通常 N/A / D4-d: exit code |

---

## § 6. 双向映射表

### 正向映射：维度 → 章节

| 维度 | 象限 | p0-dimensions.md 对应章节 |
|---|---|---|
| 🏗️ D1 结构 | 静态·内部 | §2 模块管理 / §4 架构框架 / §11 公共组件 |
| ⚙️ D2 行为 | 动态·内部 | §1 项目流程 / §3 设计模式 / §6 状态管理 / §10 日志系统 |
| 🔄 D3 通讯 | 动态·边界 | §5 事件系统 / §9 网络通信 / §12 MVC 数据流 ✨ / §13 模块间通讯 ✨ / M-2 修改影响半径 |
| 📜 D4 契约 | 静态·边界 | §7 配置 / §8 持久化 / §14 协议契约 ✨ / M-1 错误处理 |

### 反向映射：章节 → 维度

| 章节 | 所属象限 |
|---|---|
| §1 项目流程 / §3 设计模式 / §6 状态 / §10 日志 | D2 行为 |
| §2 模块管理 / §4 架构框架 / §11 公共组件 | D1 结构 |
| §5 事件系统 / §9 网络通信 / §12 MVC ✨ / §13 模块间通讯 ✨ / M-2 影响半径 | D3 通讯 |
| §7 配置 / §8 持久化 / §14 协议 ✨ / M-1 错误处理 | D4 契约 |
| M-3 Onboarding | 元维度 |

### 使用说明

- **正向使用**：写 SKILL.md 时按象限平衡检查——是否每个象限都有内容？某象限是否严重缺失？
- **反向使用**：读某段源码不知道归到哪节时，先判断该证据属于哪个象限，再定位到对应章节

---

## § 7. 盲区检测清单（9 个横向追问）

写完 SKILL.md 后，**依次回答以下 9 个问题**，任何"No"都意味着有维度未覆盖：

### D1 结构维盲区

1. **我是否列出了项目所有一级目录及其职责？**（避免遗漏 "其实存在但不常去" 的目录，如 tools/ scripts/ docs/）
2. **我是否识别了可复用工具集群？**（避免让新人重复造轮子）
3. **我是否说明了"为什么分这些模块"？**（不只是列出 what，要有 why）

### D2 行为维盲区

4. **一个典型请求/操作/帧的完整路径我能画出来吗？**
5. **项目有哪些关键的"时序陷阱"？**（初始化顺序、依赖就绪、异步竞态）

### D3 通讯维盲区（← 本框架重点补齐）

6. **模块间通讯有几种手段？我有没有讲清楚选型？**（D3-a）
7. **数据如何从存储层流到视图层？绑定机制是什么？**（D3-b）
8. **跨进程/跨设备的通讯协议和编解码我写到了吗？**（D3-c）

### D4 契约维盲区（← 本框架重点补齐）

9. **项目有哪些正式契约（接口/协议/DTO/错误码）？改它们的规则是什么？**

### 使用规则

- 每个问题必须给出**明确答案 + 对应章节编号**（如"Q7: 本项目用 <DataStore> 响应式绑定，见 §12"）
- "本项目不适用"也是合法答案，但必须说明**为什么**（如"Q8: 本项目是纯 CLI，无跨设备通讯"）
- 若任一问题是"待补充"，不允许落盘 SKILL.md

---

## 附录：与 skill-author-guide 主文件的协作关系

```
skill-author-guide.md (主文件 320 行)
  ├── § 0 推导规则入口 → 指向本文档
  ├── § 1 强制前置动作
  │    └── § 1.2 按 D 维度抽 4 组数据 → 本文档 § 2~§ 5 定义数据来源
  ├── § 3 输出结构（17 节）→ 本文档 § 6 双向映射
  └── § 8 自检 9 问 → 本文档 § 7 盲区清单（同一清单）

p0-dimensions.md (维度详表 670 行)
  ├── 每节头部象限徽章 [D1/D2/D3/D4] → 本文档 § 1 坐标系
  ├── §12/§13/§14 新增 3 节 → 本文档 § 4 D3 + § 5 D4 扩展
  └── 每节 rubric → 本文档 § 2~§ 5 子项推导规则
```

本文档是**骨架**，p0-dimensions.md 是**肌肉**，examples.md 是**示范**。三者配合构成完整 meta-skill。
