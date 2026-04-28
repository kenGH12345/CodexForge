# P0 维度详细 Rubric

> 本文件是 `skill-author-guide.md` 的附属资料。
> 包含 14 个 P0 业务维度 + 3 个 P0 元维度，共 17 节 rubric。
> 每节统一 4 段式：📋 调研配方 / ✅ 最低证据 / 📐 输出 Schema / ❌ 反模式
>
> **⚠️ 象限归属**：每节标题末的 `[D1]/[D2]/[D3]/[D4]` 徽章代表该维度所属的象限。
> 四维定义详见 `dimension-framework.md`：
> - **D1 结构**（静态·内部）：代码如何组织 — 目录/模块/类/可复用符号
> - **D2 行为**（动态·内部）：运行时发生什么 — 入口/流程/状态/日志
> - **D3 通讯**（动态·边界）：组件间如何交换数据 — 事件/网络/数据流/模块间调用
> - **D4 契约**（静态·边界）：组件间约定 — 接口/协议/DTO/错误码

## 目录索引

- [§1 项目概览](#1-项目概览) — 综合
- [§2 项目流程与生命周期 \[D2\]](#2-项目流程与生命周期-d2)
- [§3 模块管理 \[D1\]](#3-模块管理-d1)
- [§4 设计模式 \[D2\]](#4-设计模式-d2)
- [§5 架构框架 MVC/分层 \[D1\]](#5-架构框架-mvc分层-d1)
- [§6 事件系统 \[D3\]](#6-事件系统-d3)
- [§7 状态管理 \[D2\]](#7-状态管理-d2)
- [§8 配置与数据驱动 \[D4\]](#8-配置与数据驱动-d4)
- [§9 持久化与存档 \[D4\]](#9-持久化与存档-d4)
- [§10 网络通信 \[D3\]](#10-网络通信-d3)
- [§11 日志系统 \[D2\]](#11-日志系统-d2)
- [§12 公共组件与工具库 \[D1\]](#12-公共组件与工具库-d1)
- [§13 MVC 数据流与绑定 \[D3\]](#13-mvc-数据流与绑定-d3) ✨ **新增**
- [§14 模块间通讯契约 \[D3\]](#14-模块间通讯契约-d3) ✨ **新增**
- [§15 协议与契约定义 \[D4\]](#15-协议与契约定义-d4) ✨ **新增**
- [§M-1 错误处理与容错策略 \[D4\]](#m-1-错误处理与容错策略-d4)
- [§M-2 修改影响半径速查表 \[D3\]](#m-2-修改影响半径速查表-d3-带降级规则)
- [§M-3 新人 Onboarding 路径 \[元\]](#m-3-新人-onboarding-路径-元)

---

## §1 项目概览

### 📋 调研配方
- 从 `codeGraph.filePaths[]` 统计：总文件数 / 按扩展名分组（`.cs`/`.py`/`.ts` 等）推断主语言
- 从 `codeGraph.symbols[]` 统计：总符号数 / `k` 字段分布（class/function/method 比例）推断范式
- 从 `codeGraph.filePaths[]` 取顶层目录名列表（`new Set(paths.map(p => p.split('/')[0]))`）
- `codebase_search`: "project entry point" / "main function" / "启动入口"
- `read_file package.json`（JS 项目）/ `*.csproj`（.NET）/ `pyproject.toml`（Python）判断技术栈

### ✅ 最低证据
- 真实文件路径：≥ 3 个（入口文件 / 主配置 / 顶层目录结构）
- 代码片段：≥ 1 段（10-30 行的入口 main 或等价物）
- 数字佐证：总文件数 + 总符号数 + 顶层模块数

### 📐 输出 Schema
该节必须回答：
1. 项目类型是什么？（游戏/后端/CLI 工具/桌面应用...）
2. 主要技术栈是什么？（语言 + 运行时 + 关键框架）
3. 规模如何？（文件数/符号数/估算代码行数）
4. 目录顶层结构是怎样的？（配树状图 + 每个目录一句话职责）
5. 最核心的 3 个模块是？

### ❌ 反模式
- 只写"本项目是一个软件项目"这种无信息量描述
- 目录树写了但不解释每层职责
- 数字完全不给（说明没读 code-graph）

---

## §2 项目流程与生命周期 [D2]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找名字包含 `main` / `start` / `init` / `bootstrap` / `run` 的 function/method
- 从 `business-logic.json` 的 `entryPoints[]` 读（若存在）
- `codebase_search`: "application startup" / "initialization sequence" / "主循环" / "game loop"
- `grep_search`: `^function\s+(main|start|init|bootstrap)\b` 或 `void\s+(Main|Start|Awake|OnEnable)\b`
- 从 `codeGraph.callEdges{}` 追 main/start 调用的前 3 层

### ✅ 最低证据
- 真实文件路径：≥ 3 个（入口 / 主循环 / 关闭/销毁逻辑）
- 代码片段：≥ 1 段（启动或主循环的核心代码，10-30 行）
- 数字佐证：入口函数被调用次数（`callEdges` 反向查）或 hotspots 里的 `cb` 值

### 📐 输出 Schema
1. 程序怎么启动的？（入口文件 + 关键初始化步骤列表）
2. 启动后的"主循环"是什么？（游戏的 FixedUpdate/Update；后端的 request loop；CLI 的 argv 处理）
3. 程序怎么结束的？（析构/shutdown/signal handler）
4. 一次典型请求/一帧的完整调用链是？（至少 5 步）
5. 如何扩展"启动流程"？（添加一个新的启动步骤该放哪里、改哪些文件）

### ❌ 反模式
- 只写"项目有一个入口函数"但不指路径
- 主流程描述停留在一句话（应列出至少 5 步）
- 不说明"如何扩展"（§3 Schema 问题 5 缺失）

---

## §3 模块管理 [D1]

### 📋 调研配方
- 从 `codeGraph.filePaths[]` 分组：按前 2 级目录（`workflow/core/*` → `workflow/core`）
- 每个模块统计：symbol 数 / hotspot 数 / 外部被调用次数
- 从 `codeGraph.callEdges{}` 聚合跨模块调用：`{fromModule → toModule: callCount}`
- `codebase_search`: "module registration" / "plugin loader" / "模块加载"
- `grep_search`: `import\s+.*from\s+['"]\.\.?/` 找相对 import 链

### ✅ 最低证据
- 真实文件路径：≥ 5 个（覆盖至少 3 个不同模块）
- 代码片段：≥ 1 段（模块注册/加载代码）
- 数字佐证：≥ 3 个模块的符号数 + 至少 1 对跨模块调用 callCount

### 📐 输出 Schema
1. 项目被划分为哪几个顶层模块？（列表 + 每个的一句话职责）
2. 模块之间的依赖关系是？（用表格或 mermaid 图展示 Top-5 依赖）
3. 模块是怎么加载的？（自动扫描/显式注册/DI 容器）
4. 模块间通信的主要方式是？（直接调用/事件/消息队列）
5. 如何新增一个模块？（step-by-step）

### ❌ 反模式
- 只列目录名不说职责
- 模块依赖图用文字描述但无实际 callCount 支持
- 说"模块间通过接口通信"但不给任何接口文件路径

---

## §4 设计模式 [D2]

### 📋 调研配方
- 从 `codeGraph.hotspots[]` 过滤名字含模式关键词的 Top-20：Factory / Builder / Observer / Registry / Singleton / Adapter / Proxy / Command / Strategy / State / Pipeline / Decorator / Facade
- **关键**：模式名只是线索，必须 read_file 看真实代码才能确认
- `codebase_search`: "event bus implementation" / "factory pattern" / "state machine"
- `grep_search`: `class\s+\w*(Factory|Builder|Registry|Adapter|Strategy|Observer|Singleton)` 配合 `extends|implements`
- 交叉验证：某个类名有 `Factory` 但实际是数据结构 → 不算模式

### ✅ 最低证据（每个模式）
- 真实文件路径：≥ 3 个（同一模式的不同实例）
- 代码片段：≥ 1 段（展示模式的核心 API 或调用点）
- 数字佐证：该模式在 codebase 中出现的实例数量

### 📐 输出 Schema
该节必须列出 **≥ 3 个** 项目实际使用的设计模式。对每个模式回答：
1. 模式名称 + 项目中的主要实例文件
2. 为什么选这个模式？（结合项目领域解释）
3. 展示一段使用该模式的真实代码
4. 使用时的约定（如：必须 extends 某基类？必须配合某注册器？）
5. 常见错误用法

### ❌ 反模式
- "本项目使用了 MVC 模式" 但不给 Controller/Model/View 任何文件路径
- 模式名甩锅，不解释为什么用它（§4.2 缺失）
- 把标准库自带的组件（如 Node.js EventEmitter）当作项目自创的模式

---

## §5 架构框架 MVC/分层 [D1]

### 📋 调研配方
- 从 `codeGraph.filePaths[]` 找分层关键词目录：`controllers/` `services/` `models/` `views/` `handlers/` `routes/` `layers/` `domain/` `infra/` `ui/`
- 从 `codeGraph.symbols[]` 找后缀模式：`*Controller` `*Service` `*Repository` `*Handler` `*UseCase`
- 从 `codeGraph.callEdges{}` 验证层间调用方向（是否只从上层调下层，无反向）
- `codebase_search`: "layered architecture" / "clean architecture" / "domain driven design"
- 读 2-3 个 Controller 和 Service 文件，对比代码风格是否一致

### ✅ 最低证据
- 真实文件路径：≥ 3 个（每层至少 1 个代表文件）
- 代码片段：≥ 1 段（层间调用/依赖注入代码）
- 数字佐证：每层的文件数 + 层间调用的主要方向

### 📐 输出 Schema
1. 项目使用哪种架构风格？（MVC / Clean / 六边形 / 贫血 / 无分层...）
2. 每层的名字和职责？
3. 数据流方向图（mermaid）：用户请求 → 穿过哪几层 → 到达持久层？
4. 层间依赖方向：是否严格单向？有无反向依赖（code smell）？
5. 跨层调用的约定：DTO / entity / 直接传原始参数？
6. 如何添加一个新功能（按层拆分步骤）？

### ❌ 反模式
- 列了分层但无数据流图
- 声称"严格分层"但不给证据（应引用 callEdges 验证）
- 不说明 DTO/entity 约定

---

## §6 事件系统 [D3]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`EventBus` / `EventEmitter` / `emit` / `publish` / `subscribe` / `dispatch` / `on[A-Z]` / `Listen*`
- 从 `codeGraph.symbols[]` 找枚举/常量：名字含 `Event`/`Message`/`Topic` 的类或常量文件
- `codebase_search`: "event bus" / "publish subscribe" / "消息总线"
- `grep_search`: `\.emit\(` / `\.on\(` / `dispatch\(` / `subscribe\(`
- 从 `codeGraph.callEdges{}` 找 emit 被谁调用、on 被谁注册

### ✅ 最低证据
- 真实文件路径：≥ 3 个（事件总线实现 / 事件枚举 / 典型订阅点）
- 代码片段：≥ 1 段（事件注册 + 触发的典型代码）
- 数字佐证：≥ 3 个具体事件名称（不是"还有很多"）

### 📐 输出 Schema
1. 项目有统一的事件系统吗？（是/否/多套共存）
2. 事件总线实现在哪个文件？API 是？
3. 事件命名约定是？（枚举/字符串常量/字符串字面量）
4. 列出 ≥ 5 个项目核心事件（名字 + 触发者 + 典型订阅方）
5. 一个完整的事件链示例（事件 X → 订阅者 A → 衍生事件 Y → 订阅者 B）
6. 如何添加一个新事件？（完整 step-by-step）
7. 常见坑：重复订阅 / 事件泄漏 / 异步序列错误

### ❌ 反模式
- 说"有事件系统"但不给实现文件
- 列不出具体事件名
- 不说"如何添加新事件"

---

## §7 状态管理 [D2]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`*State` `*Store` `*Context` `*Reducer` `StateMachine` `FSM`
- 找全局单例：`k === 'class'` 且名字含 `Manager`/`Singleton`/`Global` 的 hotspot
- `codebase_search`: "state machine" / "global state" / "redux store" / "状态机"
- `grep_search`: `class\s+\w*StateMachine` / `enum\s+\w*State`
- 读 2-3 个状态相关文件，分清"领域模型状态"和"UI 状态"

### ✅ 最低证据
- 真实文件路径：≥ 3 个（状态定义 / 状态机 / 状态使用方）
- 代码片段：≥ 1 段（状态变更的典型代码）
- 数字佐证：状态机状态数 / 全局状态对象数量

### 📐 输出 Schema
1. 项目有哪几类状态？（全局 / 会话 / 组件本地 / 领域对象）
2. 全局状态存放在哪里？由谁管理？
3. 若有状态机：列出主状态机的状态清单 + 迁移图
4. 状态变更的主要方式是？（直接赋值 / action+reducer / setState）
5. 如何添加一个新状态字段？
6. 常见坑：状态漂移、竞态、忘记重置

### ❌ 反模式
- 把"全局变量"说成"状态管理"而不说明约定
- 状态机列了但无迁移图
- 不区分领域状态和 UI 状态

---

## §8 配置与数据驱动 [D4]

### 📋 调研配方
- 从 `codeGraph.filePaths[]` 找：`*.json` / `*.yaml` / `*.toml` / `*.ini` / `config/` / `configs/` / `constants/`
- 从 `codeGraph.symbols[]` 找名字含 `Config` / `Constant` / `Settings` 的类/模块
- `codebase_search`: "load config" / "environment variable" / "配置加载"
- `grep_search`: `process\.env\.` / `Environment\.GetEnvironmentVariable` / `os\.getenv`
- 读 1-2 个核心配置文件 + 配置加载器源码

### ✅ 最低证据
- 真实文件路径：≥ 3 个（配置文件样本 / 配置加载器 / 常量定义）
- 代码片段：≥ 1 段（配置加载逻辑）
- 数字佐证：配置文件数量 / 环境变量数量

### 📐 输出 Schema
1. 配置文件的物理位置和格式？
2. 配置加载的时机？（启动时一次性 / 按需 / 热更新）
3. 环境差异怎么处理？（dev/staging/prod 如何区分）
4. 项目常量定义在哪里？（文件 + 命名约定）
5. 如何添加一个新配置项？完整步骤
6. 常见坑：配置默认值缺失 / 环境变量类型错 / 配置修改未热更

### ❌ 反模式
- 只说"配置在 config/ 目录"但不列典型配置项
- 不说环境差异处理
- 不给"添加新配置"步骤

---

## §9 持久化与存档 [D4]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`save` / `load` / `serialize` / `deserialize` / `Persist*` / `Storage*` / `*Repository`
- 从 `codeGraph.filePaths[]` 找：`db/` / `storage/` / `persistence/` / `migrations/`
- `codebase_search`: "save to disk" / "serialize state" / "database migration" / "存档系统"
- `grep_search`: `JSON\.stringify` / `BinaryFormatter` / `protobuf` / `pickle\.dump`
- 若有 db schema 文件（`schema.sql` / `prisma.schema`）直接读

### ✅ 最低证据
- 真实文件路径：≥ 3 个（序列化入口 / 存储实现 / 数据结构定义）
- 代码片段：≥ 1 段（save/load 核心代码）
- 数字佐证：数据表数量 / 存档字段数量 / 版本号

### 📐 输出 Schema
1. 项目持久化了哪些数据？（用户数据/游戏存档/缓存/日志）
2. 使用什么存储后端？（SQLite/Redis/文件/云端）
3. 序列化格式是？（JSON/二进制/protobuf）
4. 版本兼容策略：老存档怎么迁移？
5. 如何添加一个新的持久化字段？
6. 常见坑：存档损坏 / 版本不兼容 / 序列化循环引用

### ❌ 反模式
- 只列存储后端但不说序列化格式
- 不说版本迁移（这是最容易踩的坑）
- 不给"添加新字段"步骤

---

## §10 网络通信 [D3]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`*Client` / `*Request` / `*Response` / `fetch` / `http` / `Socket` / `*Api`
- 从 `api-endpoints.json` 读路由列表（如存在）
- 从 `package.json` / 依赖清单找网络库（axios / okhttp / reqwest）
- `codebase_search`: "http request" / "websocket handler" / "rpc client"
- `grep_search`: `axios\.` / `fetch\(` / `new WebSocket\(` / `HttpClient`

### ✅ 最低证据
- 真实文件路径：≥ 3 个（客户端封装 / 一个典型 API 调用 / 错误重连逻辑）
- 代码片段：≥ 1 段（请求发起 + 响应处理的完整代码）
- 数字佐证：API 端点数 / 主要协议（REST/GraphQL/WebSocket/自定义二进制）

### 📐 输出 Schema
1. 项目使用什么网络协议？（HTTP/WebSocket/TCP/UDP/自定义）
2. 网络库是什么？封装在哪里？
3. 错误重连/超时策略？
4. 认证方式？（Bearer token / cookie / 自定义 header）
5. 序列化格式？（JSON/protobuf/msgpack）
6. 如何添加一个新 API？完整步骤
7. 常见坑：重连风暴 / 超时设置不当 / 认证过期未刷新

### ❌ 反模式
- 说"项目调用 HTTP API"但不给封装文件
- 不说错误处理策略
- 不给"添加新 API"步骤

---

## §11 日志系统 [D2]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`Logger` / `log` / `*Log*`
- 从 `package.json` / 依赖清单找日志库（winston / pino / log4j / logrus / spdlog）
- `codebase_search`: "logger initialization" / "log format" / "日志系统"
- `grep_search`: `logger\.(info|debug|error|warn)\(` / `console\.log\(`
- 若没找到专用 logger，统计 `console.log`/`print` 调用数量

### ✅ 最低证据
- 真实文件路径：≥ 3 个（logger 入口 / logger 配置 / 典型使用点）
- 代码片段：≥ 1 段（logger 初始化或带上下文的 log 调用）
- 数字佐证：主 logger 实例位置 / 日志等级数

### 📐 输出 Schema
1. 项目使用什么日志库？
2. 日志格式约定？（单行 JSON / 人类可读 / 结构化字段）
3. 日志等级划分和使用规范？（什么情况用 info/warn/error/debug）
4. 日志输出目的地？（stdout / 文件 / 远程收集）
5. 敏感字段脱敏策略？
6. 如何添加带上下文的日志？
7. 常见坑：高频 log 影响性能 / 日志格式不统一 / 敏感信息泄漏

### ❌ 反模式
- 只说"项目有日志"但不指库
- 不给日志等级规范
- 不提敏感字段脱敏

---

## §12 公共组件与工具库 [D1]

### 📋 调研配方
- **直接使用 `codeGraph.reusableSymbols[]`**：这是官方认证的高频复用符号
- 若 reusableSymbols 为空或太少：从 `codeGraph.hotspots[]` 按 `cb` 排序取 Top-30，过滤通用名
- 从 `codeGraph.filePaths[]` 找 `utils/` / `helpers/` / `common/` / `shared/` 目录
- 每个候选符号 read_file 查看 signature 和实际实现（`codeGraph.symbols[i].s` 字段）
- `codebase_search`: "utility functions" / "shared helpers"

### ✅ 最低证据
- 真实文件路径：≥ 5 个（覆盖 ≥ 10 个 reusable symbols）
- 代码片段：≥ 3 段（每段展示 1 个核心工具函数的签名 + 典型调用）
- 数字佐证：每个列出的符号的 refs/cb 值（证明确实高频）

### 📐 输出 Schema
列出 **≥ 10 个** 核心可复用组件。对每个回答：
1. 符号名 + 所在文件:行号
2. signature（完整函数/类签名）
3. 一句话说明用途
4. 典型使用示例（3-10 行代码）
5. 注意事项或陷阱（如有）

总体再回答：
- 这些工具的总体设计哲学？（纯函数 / 单例服务 / 可组合）
- 如何决定"应该写工具 vs 应该写业务代码"？

### ❌ 反模式
- 只列名字不给 signature
- 没有使用示例
- 列了不高频的符号（无 refs 数字证明）
- 忽略 reusableSymbols 字段，自己瞎猜

---

---

## §13 MVC 数据流与绑定 [D3]

> **象限归属**：D3 通讯·进程内数据流（详见 `dimension-framework.md` §4.1 D3-b）
> **本节解答**：数据层 ↔ 视图层如何绑定？数据改变如何驱动视图刷新？

### 🚦 跳过条件（必须显式声明）

若项目满足以下任一条件，可在 SKILL.md 中用一句话跳过本节，但**必须说明理由**：
- 纯 CLI 工具或纯后端服务，无独立视图层
- 单文件脚本或工具库

❌ 不允许静默省略；✅ 合法跳过示例："§13 不适用：本项目为纯 HTTP API 后端服务，无客户端视图层。"

### 📋 调研配方

- 命名扫描：`grep -r "Model\|ViewModel\|observable\|reactive"` 定位数据绑定集群
- `codebase_search`: "data binding" / "property changed" / "数据绑定" / "响应式"
- 识别响应式框架：
  - **自研**：`*Model*.addXxxListener` / `ModelsBinder` / `SyncProcess`
  - **前端**：Vuex/Pinia state + mutations / Redux reducers / MobX observable / RxJS Subject
  - **游戏**：自研 Model-View 监听 / UniRx / ReactiveX
- 从 `callEdges` 抽取：`addModelListener` / `observe` / `subscribe` / `PropertyChanged` 的调用者集群
- `read_file` 核心数据层类的实现（如 `CommonModel.cs` / `store/index.ts`）深读生命周期

### ✅ 最低证据

- 真实文件路径：≥ 3 个（数据层入口 / 视图绑定基类 / 具体业务场景实例）
- 代码片段：≥ 1 段完整的"数据变 → 视图更"示例（≥ 20 行）
- 生命周期表：≥ 2 种绑定时机（如 alive/active、mounted/beforeDestroy、Start/Destroy）

### 📐 输出 Schema

该节必须回答：
1. 数据层入口类是什么？（`CommonModel` / `Store` / `Vuex store`）
2. 视图层绑定基类是什么？（`ModelViewBehaviour` / `Vue component` / `connect(mapStateToProps)`）
3. 数据变更的事件类型有哪些？（Add/Update/Remove/Clear/BatchXxx）
4. 绑定的生命周期管理规则？（绑定何时建立、何时解除？）
5. 提供一个"数据改变 → 视图刷新"的完整代码示例（从触发到显示）
6. 有哪些**反模式**（新人常写错的数据流方向，如直接改视图跳过 Model）

### ❌ 反模式

- "数据层和视图层解耦" —— 没说怎么解耦
- "视图会自动响应数据变化" —— 没说响应机制的类型和实现
- 只写 Model 层不写 View 层（半条数据流）
- 代码示例用伪代码而不用项目真实代码

### 📐 跨项目类型示例

| 项目类型 | §13 具体化 |
|---|---|
| 游戏（Unity） | CommonModel (MonoBehaviour) + ModelListener 事件 + ModelViewBehaviour.Bind |
| 前端 SPA (Vue) | Pinia store + `storeToRefs` + `watch` + v-model 双向绑定 |
| 前端 SPA (React) | Redux store + useSelector + useDispatch + 组件重渲染 |
| 桌面 (WPF/WinUI) | INotifyPropertyChanged + Binding + XAML DataContext |

---

## §14 模块间通讯契约 [D3]

> **象限归属**：D3 通讯·模块间调用方式（详见 `dimension-framework.md` §4.1 D3-a）
> **本节解答**：A 模块要用 B 模块的功能时，用哪种通讯手段？选型依据是什么？

### 🚦 跳过条件（必须显式声明）

- 单模块项目（所有代码在一个文件夹下）
- 极简脚本（< 500 行代码）

合法跳过示例："§14 不适用：本项目仅含一个主模块，无跨模块通讯需求。"

### 📋 调研配方

- 从 `code-graph.json.callEdges` 聚合跨模块调用：
  ```js
  // 按模块前缀分组聚合 callEdges
  const modEdges = new Map();
  for (const [caller, callees] of Object.entries(cg.callEdges)) {
    const fromMod = getModule(cg.filePaths[caller.split('::')[0]]);
    for (const ce of callees) {
      const toMod = getModule(cg.filePaths[ce.split('::')[0]]);
      if (fromMod !== toMod) {
        modEdges.set(fromMod+'->'+toMod, (modEdges.get(fromMod+'->'+toMod)||0)+1);
      }
    }
  }
  ```
- 通讯手段识别（按 callee 符号命名）：
  - **直接调用**：`XxxSystem.Method()` / `module.Function()` 类名+方法
  - **事件**：callee 含 `Fire` / `Emit` / `Publish` / `Dispatch`
  - **单例**：callee 前缀 `Singleton<T>.Instance` / `XxxSys.I` / `Manager.Instance`
  - **DI 注入**：构造函数参数 / `@Inject` / `Autowired`
  - **回调/Promise**：`await` / `.then()` / `callback` 参数
  - **全局总线**：`MessageCenter` / `EventBus.send`
- 命名模式扫描："Controller" / "Bridge" / "Facade" 等中介类

### ✅ 最低证据

- 跨模块 callEdges Top-10（`fromMod -> toMod (callCount)`）
- 至少 3 种项目实际使用的通讯手段 + 各自代表文件路径
- 通讯选型决策表（≥ 3 行）
- 至少 1 条"禁止/推荐"规则（如"UI 禁止直接调 Net，必须走 Controller"）

### 📐 输出 Schema

该节必须回答：
1. 项目有多少个主要模块？（引用 §3 模块管理）
2. 跨模块调用 Top-10 是什么？每条边的含义？
3. 项目中**实际在用**的通讯手段清单（按使用频率排序）
4. 通讯选型决策表（什么场景用什么手段）：
   | 场景 | 推荐手段 | 理由 | 示例位置 |
   |---|---|---|---|
   | 业务逻辑调用纯工具 | 直接调用 | 简单、无状态 | ... |
   | 跨层解耦（UI → Business） | 事件总线 | 松耦合、易替换 | ... |
   | 全局状态访问 | 单例 | 避免传递 | ... |
5. 跨模块调用的规则与约束（什么被禁止，为什么）
6. 有没有可观测的**反模式**（例如循环依赖、跨层穿透）

### ❌ 反模式

- "模块间通过事件解耦" —— 没说哪些事件、几种事件类型
- 只列跨模块边数字不解释通讯手段
- 决策表只写推荐不写理由
- 与 §M-2 修改影响半径内容完全重复（本节侧重**选型**，M-2 侧重**影响范围**）

### 📐 与 §M-2 的区分

- **§14（本节）**：讲"**如何**通讯" — 用哪种手段？为什么？
- **§M-2 修改影响半径**：讲"**改了会影响谁**" — 具体修改传染范围

---

## §15 协议与契约定义 [D4]

> **象限归属**：D4 契约·协议契约（详见 `dimension-framework.md` §5.1 D4-c）
> **本节解答**：与外部世界（服务器/其他进程/脚本引擎）交换数据的格式契约是什么？

### 🚦 跳过条件（必须显式声明）

- 纯本地工具/脚本，无外部数据交换
- 仅使用标准 HTTP + 无自定义 schema 的项目

合法跳过示例："§15 不适用：本项目为纯本地 CLI 工具，无跨进程协议。"

### 📋 调研配方

- 命名模式扫描：
  - `grep -r -l "Proto\|Protocol\|Packet\|Msg\|DTO\|Request\|Response"` 按文件名
  - `*.proto` / `*.thrift` / `*.fbs` / `*.graphql` / `openapi.yaml` / `swagger.json` 按扩展名
- 按文件大小 Top-5 排序，检查是否含 "auto-generated" 头部（协议代码生成产物通常极大）
- 识别工具链：
  - **ProtoBuf**：`protoc` / `.proto` / `google.protobuf.Message`
  - **Thrift**：`.thrift` / `TBase`
  - **FlatBuffers**：`.fbs`
  - **腾讯 TDR**：`cs_proto.cs` / `TdrMetaDef` / `tdr_metalib`
  - **REST/OpenAPI**：`swagger.json` / `openapi.yaml` / `@Api` / `@ApiModel`
  - **GraphQL**：`.graphql` / `typeDefs` / `resolvers`
  - **自研二进制**：`BinaryReader` / `BinaryWriter` / custom codec
- DTO 集群识别：纯字段无逻辑的类（通过 AST 或 categoryStats）

### ✅ 最低证据

- 协议文件清单（≥ 1 条或显式跳过）
- 工具链说明（协议 IDL → 代码生成 → 使用的完整链路）
- 至少 1 段编解码示例代码
- 版本兼容策略文字描述（新增字段/废弃字段规则）

### 📐 输出 Schema

该节必须回答：
1. 项目是否有正式协议定义？在哪里？（文件路径 + 大小）
2. 使用的协议工具链是什么？（手写 / ProtoBuf / TDR / OpenAPI 等）
3. 协议从定义到代码使用的完整链路（IDL → 生成代码 → 注册 → 编解码）
4. 消息类型有哪些？枚举清单（如 `ESendMsgType: Normal/Reliable/Unreliable/...`）
5. 版本兼容策略：
   - 新增字段如何处理？（默认值？Optional？）
   - 废弃字段如何处理？（保留位占？重命名？）
   - 客户端/服务器版本不匹配时的行为？
6. 序列化/反序列化的性能约束（如是否禁止在主线程做、最大消息大小）
7. 安全相关约定（加密？签名？CRC？）

### ❌ 反模式

- "用 JSON 传输" —— 没说 schema 在哪定义
- "有协议定义" —— 没列出文件
- 只写编码不写解码
- 跳过版本兼容策略（最容易被忽视但线上问题最多的地方）

### 📐 跨项目类型示例

| 项目类型 | §15 具体化 |
|---|---|
| 游戏（腾讯系） | TDR `cs_proto.cs` + `TDRHelper` 编解码 + 版本字段 |
| Web 后端 (REST) | OpenAPI yaml + 代码生成 + HTTP + JSON + 状态码 |
| Web 后端 (gRPC) | `.proto` + protoc-gen-go + gRPC + 二进制 |
| 前端 SPA | OpenAPI client 生成 / tRPC type-safe / GraphQL codegen |
| 桌面 / IPC | COM interface / DBus / MessagePack + Named Pipe |

---

## §M-1 错误处理与容错策略 [D4]

### 📋 调研配方
- 从 `codeGraph.symbols[]` 找：`*Error` / `*Exception` / `handle*` / `catch*` / `try*`
- `codebase_search`: "error handling" / "exception" / "错误处理"
- `grep_search`: `try\s*\{` / `catch\s*\(` / `throw\s+new` / `panic\!` / `Result<`
- 读 3-5 个 core 层文件，观察是否统一使用某种错误传递方式

### ✅ 最低证据
- 真实文件路径：≥ 3 个（错误类定义 / 典型 try-catch / 错误传播出口）
- 代码片段：≥ 1 段（典型错误处理代码）
- 数字佐证：自定义错误类数量 / 主要错误类型枚举

### 📐 输出 Schema
1. 项目的错误处理哲学是？（抛异常 / 返回错误码 / Result/Option / 混用）
2. 自定义错误类有哪些？（列出 Top-5）
3. 错误如何传播到顶层？（middleware / global handler / 每层 try-catch）
4. 错误日志和用户提示的分离策略？
5. 哪些错误是可恢复的？怎么恢复？
6. 添加新错误类型的步骤？
7. 常见坑：吞异常 / 错误信息泄漏 / 异步 Promise 无 catch

### ❌ 反模式
- 只写"注意错误处理"不给具体策略
- 不列自定义错误类
- 不说错误 vs 日志 vs 用户提示的边界

---

## §M-2 修改影响半径速查表 [D3] (带降级规则)

### 📋 调研配方
- **主路径**：从 `codeGraph.callEdges{}` 反向聚合，每个模块被哪些模块调用
- 计算：`impactedBy[module] = Σ callCount of edges ending in this module`
- 取 Top-10 模块，每个列出"改它的话需要额外检查的 Top-3 下游模块"
- 交叉验证：用 IDE 的 `find_references` 对几个 hotspot 符号做真实的引用查询

### ⚠️ 降级规则（callEdges 数据不足时）

**触发条件**：当 `codeGraph.callEdges` 总条目数 `< 50` 时（说明 call graph 构建不完整，通常因 AST 解析失败/语言支持弱）。

**降级策略**：放弃基于 callEdges 的精确耦合度量，改为**基于 filePaths 的目录级定性描述**：
1. 统计每个顶层模块的文件数作为"体量指标"
2. 基于目录命名推测粗粒度依赖（如 `service/` 依赖 `model/`）
3. 明确在产出内容开头声明："⚠️ 本章节基于目录结构推断，callEdges 数据不足（实际 X 条 < 50 阈值），精确耦合关系请结合 IDE find_references 手工验证"
4. 不给具体 callCount 数字，改用"高/中/低"定性档位

**判断代码示例**：
```js
const totalCallEdges = Object.values(codeGraph.callEdges || {}).reduce((s, arr) => s + arr.length, 0);
const useDegraded = totalCallEdges < 50;
```

### ✅ 最低证据
- **主路径**：覆盖 ≥ 5 个模块的影响半径 + 每个的 callCount 数字
- **降级路径**：覆盖 ≥ 5 个模块 + 目录体量统计 + 手工验证提示

### 📐 输出 Schema
列表格：

| 修改的模块 | 必须检查的下游模块 | 典型影响点 | 风险等级 |
|---|---|---|---|
| ... | ... | ... | P0/P1/P2 |

外加：
1. 全项目最危险的 Top-3 "高耦合"模块是？
2. 建议的回归测试策略（改 A 模块时至少跑哪几个测试集）？

### ❌ 反模式
- 表格只有模块名列没有数字（除非走降级路径）
- 降级走了但不声明降级原因
- 没给"风险等级"

---

## §M-3 新人 Onboarding 路径 [元]

### 📋 调研配方
- 综合前面所有维度，选出"最基础的 5-7 个文件"
- 优先选：入口文件 → 主流程 → 1 个典型模块实现 → 公共组件 → 1 个测试样本
- 从 `codeGraph.reusableSymbols[]` Top-5 的文件不能错过（新人肯定会遇到）
- 从 §5 分层结构挑每层 1 个代表文件

### ✅ 最低证据
- 列出的每个推荐文件都必须在前面其他章节被引用过（交叉验证）
- 阅读顺序有明确理由

### 📐 输出 Schema
1. 前 1 天应读的 3 个文件（理解项目做什么）
2. 前 3 天应读的 5 个文件（理解项目怎么运转）
3. 第 1 周应读的 7-10 个文件（有能力独立修小 bug）
4. 配套实践：每个阶段建议做的小练习（例如：D1 跑通本地启动；D3 改一行 log 观察输出；D7 修一个 typo 的 PR）
5. 常见"入门陷阱"：新人前 3 天最容易误解的 3 件事

### ❌ 反模式
- 文件列表过长（超过 15 个说明没筛选）
- 没有阅读顺序
- 不给"实践建议"（只列书单不给作业等于没教）

---

## 总体使用提醒

> **本 rubric 是"合格线"而非"满分标准"**。
> 若某维度项目真的不存在（例如纯 CLI 工具确实没事件系统），
> 按主文件 §1.5 规则用一句话说明即可，**不要硬凑内容**。
>
> 写完一节立即用 §2 rubric 自评，低于 2 分的节回炉重写。
