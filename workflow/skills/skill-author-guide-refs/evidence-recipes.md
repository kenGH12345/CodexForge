# 证据提取配方 (Evidence Recipes)

> 本文件是 `skill-author-guide.md` 的附属资料。
> 作用：把 `code-graph.json` / `business-logic.json` / `api-endpoints.json` 的原始 JSON 转换为你能直接用于写 SKILL.md 的可操作信号。

## 前置：关键 Schema 速查

### code-graph.json 字段映射（v2 path-dictionary 格式）

| 字段 | 类型 | 说明 |
|---|---|---|
| `filePaths` | `string[]` | 文件路径数组，其他字段通过 index 引用 |
| `symbols` | `Symbol[]` | 所有符号 |
| `symbols[i].n` | `string` | 符号名（name） |
| `symbols[i].k` | `string` | 类型：`class`/`function`/`method`/`var`/... |
| `symbols[i].f` | `number` | **filePaths 的索引**（不是路径字符串） |
| `symbols[i].l` | `number` | 行号 |
| `symbols[i].s` | `string` | signature（可选） |
| `symbols[i].w` | `number` | weight（0-1，中心度 + 复用度综合） |
| `callEdges` | `Record<string, string[]>` | `"fileIdx::symbolName" → ["fileIdx::calleeName", ...]` |
| `hotspots` | `Hotspot[]` | 高频被引用符号，含 `cb`（call-back count）或 `refs` 字段 |
| `reusableSymbols` | `ReusableSym[]` | 官方认证的高复用工具符号（比 hotspots 更精选） |
| `categoryStats` | `Record<string, number>` | 符号类型分布统计 |
| `modules` | `Record<string, ModuleInfo>` | 模块级聚合信息 |

**关键认知**：`symbols[i].f` 是索引，要拿路径必须 `codeGraph.filePaths[sym.f]`。新手常错。

---

## 配方 1：从 code-graph.json 抽取

### 1.1 取 Top-20 hotspots（按调用频次）

```js
// IDE Agent 可以直接理解这段逻辑，不需要真执行
const cg = JSON.parse(codeGraphRaw);
const top20 = (cg.hotspots || [])
  .sort((a, b) => (b.cb || b.refs || 0) - (a.cb || a.refs || 0))
  .slice(0, 20)
  .map(h => ({
    name: h.n,
    kind: h.k,
    file: cg.filePaths[h.f] || 'unknown',
    line: h.l,
    callCount: h.cb || h.refs || 0
  }));
```

### 1.2 取 reusableSymbols（首选）

```js
// 这是"官方认证"的高价值工具符号，比 hotspots 更精选
const reusable = cg.reusableSymbols || [];
// 如果为空，再降级到 hotspots
const effectiveReusable = reusable.length >= 10 ? reusable : top20;
```

### 1.3 聚合跨模块 callEdges（用于 §M-2 修改影响半径）

```js
function inferModule(filePath) {
  const parts = filePath.split(/[\\/]/);
  if (parts[0] === 'src' || parts[0] === 'workflow') return parts[1] || 'root';
  return parts[0] || 'root';
}

const moduleEdges = new Map(); // "fromModule → toModule" : count

for (const [callerKey, callees] of Object.entries(cg.callEdges || {})) {
  const [fileIdx] = callerKey.split('::');
  const callerFile = cg.filePaths[+fileIdx];
  if (!callerFile) continue;
  const fromModule = inferModule(callerFile);

  for (const calleeKey of callees) {
    const [cFileIdx] = calleeKey.split('::');
    const calleeFile = cg.filePaths[+cFileIdx];
    if (!calleeFile) continue;
    const toModule = inferModule(calleeFile);
    if (fromModule === toModule) continue; // 只关心跨模块

    const pair = `${fromModule} → ${toModule}`;
    moduleEdges.set(pair, (moduleEdges.get(pair) || 0) + 1);
  }
}

const topCrossModuleCalls = [...moduleEdges.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);
```

### 1.4 按顶层目录分组 filePaths（用于 §3 模块管理）

```js
const byModule = {};
for (const fp of cg.filePaths) {
  const mod = inferModule(fp);
  byModule[mod] = (byModule[mod] || 0) + 1;
}
const moduleSizes = Object.entries(byModule).sort((a, b) => b[1] - a[1]);
// → [['Scripts', 4000], ['Editor', 800], ...]
```

### 1.5 检测 callEdges 数据充分性（DP-3 降级判断）

```js
const totalCallEdges = Object.values(cg.callEdges || {})
  .reduce((sum, arr) => sum + arr.length, 0);

const shouldDegrade = totalCallEdges < 50;
// 如果 shouldDegrade === true，§M-2 必须走降级路径
```

### 1.6 按关键词过滤模式实例（用于 §4 设计模式）

```js
const PATTERN_KEYWORDS = {
  Factory: /factory|builder|create[A-Z]/i,
  Observer: /observer|emitter|bus|dispatch|subscribe/i,
  Strategy: /strategy|policy|handler/i,
  Pipeline: /pipeline|chain|stage|step/i,
  Registry: /registry|repository|catalog/i,
};

function findPatternInstances(cg, patternName) {
  const regex = PATTERN_KEYWORDS[patternName];
  if (!regex) return [];
  return cg.symbols
    .filter(s => regex.test(s.n))
    .map(s => ({
      name: s.n,
      kind: s.k,
      file: cg.filePaths[s.f],
      line: s.l
    }));
}
```

**关键警告**：命名含关键词不代表真的是该模式。必须 read_file 验证。

---

## 配方 2：从 business-logic.json 抽取

### 2.1 取 entryPoints

```js
const bl = JSON.parse(businessLogicRaw);
const entryPoints = bl.entryPoints || [];
// 每个 entryPoint 典型结构：{ name, file, description, calledBy: [] }
```

用于 §2 项目流程：entryPoints 就是启动/主流程的直接入口。

### 2.2 取 businessFlows（若存在）

```js
const flows = bl.businessFlows || [];
// 用于 §4 设计模式 或 §6 事件系统 的链路示例
```

---

## 配方 3：从 api-endpoints.json 抽取

### 3.1 取 REST 路由清单

```js
const ae = JSON.parse(apiEndpointsRaw);
const routes = Array.isArray(ae) ? ae : (ae.endpoints || []);
// 每个 route 典型：{ method, path, handler, params, responseSchema }
```

用于 §10 网络通信 + §M-2 修改影响半径（API 改动涉及的 handler 文件）。

### 3.2 按资源聚合路由（用于体现领域模型）

```js
const byResource = {};
for (const r of routes) {
  const resource = (r.path || '').split('/')[1] || 'root';
  byResource[resource] = (byResource[resource] || 0) + 1;
}
```

---

## 配方 4：验证配方（反查 + 交叉验证）

### 4.1 符号名可能骗你 —— 必须 read_file 验证

```
场景：codeGraph.hotspots 里有个 "EventBus"，你想写"本项目用 Observer 模式"。

验证步骤：
1. read_file 该文件完整查看
2. 确认该类真的有 emit/on/subscribe 等 Observer 方法
3. grep_search 找调用方 (.emit(/.on() 次数 > 3 才算真模式
4. 否则 EventBus 可能只是个常量包装，不写模式证据
```

### 4.2 用 IDE 原生 find_references 比 callEdges 更准

```
callEdges 基于静态分析，可能漏掉动态调用（反射/回调/字符串引用）。
对关键符号（Top-3 hotspots）建议用 IDE 的 find_references 做二次验证。
尤其在 §M-2 修改影响半径，find_references 结果 > callEdges 时应以 find_references 为准。
```

### 4.3 判断模块边界是否真实

```
只看目录结构判断模块：不可靠（可能有循环依赖）。
交叉验证：
1. 统计 callEdges 矩阵，看每个模块到其他模块的调用是否单向
2. 若 A → B 且 B → A 调用都很高（> 100），说明 A/B 实际是一个逻辑模块被硬拆开
3. 在 SKILL.md §3 模块管理要指出这类"虚假边界"
```

### 4.4 快速取"入口文件"的综合配方

```js
// 候选入口 = business-logic.json entryPoints ∪ 名字匹配的 symbols
const candidates = new Set();

// 来源 1：business-logic
for (const ep of (bl.entryPoints || [])) {
  candidates.add(ep.file);
}

// 来源 2：符号名匹配
const ENTRY_NAMES = /^(main|Main|start|Start|run|Run|bootstrap|init|Awake|OnEnable)$/;
for (const s of cg.symbols) {
  if (ENTRY_NAMES.test(s.n) && (s.k === 'function' || s.k === 'method')) {
    candidates.add(cg.filePaths[s.f]);
  }
}

// 来源 3：顶层 package.json main / csproj 启动类
// (这两个需要额外 read_file)

const entryFiles = [...candidates];
```

---

## 配方 5：快速起手套餐（用在 §1 项目概览）

一次性拿到 6 个关键指标：

```js
const metrics = {
  totalFiles: cg.filePaths.length,
  totalSymbols: cg.symbols.length,
  languageDist: {}, // 按扩展名分组
  topModules: [],   // Top-5 按文件数
  topHotspots: top20.slice(0, 10),
  totalCallEdges: Object.values(cg.callEdges || {}).reduce((s, a) => s + a.length, 0),
  degradeM2: null,  // 由 totalCallEdges < 50 决定
};

for (const fp of cg.filePaths) {
  const ext = fp.split('.').pop() || '?';
  metrics.languageDist[ext] = (metrics.languageDist[ext] || 0) + 1;
}

metrics.topModules = Object.entries(byModule)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5);

metrics.degradeM2 = metrics.totalCallEdges < 50;
```

这个 metrics 对象可以直接填到 §1 项目概览的表格里。

---

---

## 配方 6：按命名模式发现协议/消息文件 [D4-c] ✨

**目标**：在项目里定位所有协议定义文件、消息类、DTO 集群 — 用于 §15 协议契约章节。

**输入**：`code-graph.json.filePaths[]` + 文件大小元数据（可用 `fs.statSync`）

**步骤**：

```js
const fs = require('fs');
const path = require('path');

// 1. 按命名模式扫描
const cg = JSON.parse(fs.readFileSync('output/code-graph.json', 'utf-8'));
const protocolPatterns = /(?:Proto|Protocol|Msg|Message|Packet|Request|Response|DTO|Schema)/i;

const protocolFiles = cg.filePaths
  .filter(fp => protocolPatterns.test(fp))
  .map(fp => {
    let size = 0;
    try { size = fs.statSync(path.join(PROJECT_ROOT, fp)).size; } catch (_) {}
    return { fp, sizeKB: Math.round(size / 1024) };
  })
  .sort((a, b) => b.sizeKB - a.sizeKB);

console.log('Top-10 协议文件（按大小）:', protocolFiles.slice(0, 10));

// 2. 按文件大小 Top-5（即使命名不含 Proto 也要看）
const allFiles = cg.filePaths
  .map(fp => ({ fp, sizeKB: Math.round(fs.statSync(path.join(PROJECT_ROOT, fp)).size / 1024) }))
  .sort((a, b) => b.sizeKB - a.sizeKB);
console.log('Top-5 最大文件:', allFiles.slice(0, 5));
// ↑ 经常能发现自动生成的协议代码（WePop 案例中 cs_proto.cs 1.36 MB 排第 3）

// 3. 按外部工具链扩展名扫描
const idlFiles = cg.filePaths.filter(fp =>
  /\.(proto|thrift|fbs|graphql)$/.test(fp) ||
  /openapi\.(ya?ml|json)|swagger\./i.test(fp)
);
console.log('IDL/Schema 文件:', idlFiles);
```

**输出**：三组清单 — 按命名找到的 + 按大小发现的 + IDL 文件

**实战要点**：
- **1.36 MB 文件必查**：大概率是协议代码生成产物
- **合并三组清单**：有些项目既有 `.proto` 又有手写 `*Msg.cs`
- **跳过条件**：三组都为空 → 项目确实无外部协议，可在 §15 合法跳过

---

## 配方 7：按接口/抽象类密度发现契约集群 [D4-a] ✨

**目标**：定位"契约定义集群"（interface / abstract class 高密度目录），用于 §15 接口契约部分。

**输入**：`code-graph.json.symbols[]` + 各符号的 `k`（kind）/ `n`（name）/ `f`（filePath index）

**步骤**：

```js
const cg = JSON.parse(fs.readFileSync('output/code-graph.json', 'utf-8'));

// 1. 识别接口/抽象类符号
// 注：不同语言约定不同
//   C#: kind='interface' 或 name 以 I 开头的 class
//   TS/Java: kind='interface'
//   Python: class 继承 ABC
//   Go: interface 关键字
const contracts = cg.symbols.filter(s => {
  return s.k === 'interface' ||
         s.k === 'abstract' ||
         (s.k === 'class' && /^I[A-Z]/.test(s.n)) ||  // C# IXxx 约定
         (s.k === 'class' && /Abstract|Base/.test(s.n));
});

// 2. 按目录聚合密度
const dirDensity = new Map();
for (const c of contracts) {
  const dir = cg.filePaths[c.f].split('/').slice(0, 3).join('/');
  dirDensity.set(dir, (dirDensity.get(dir) || 0) + 1);
}

const topDirs = [...dirDensity.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);
console.log('契约密度 Top-10 目录:', topDirs);

// 3. 找出"契约清单"（每个接口名 + 文件 + 被实现次数）
const contractImplCount = new Map();
for (const c of contracts) {
  // 粗略：用名字前缀匹配所有 class 作为 "implements X" 的近似
  const implCount = cg.symbols.filter(s =>
    s.k === 'class' && s.n !== c.n && new RegExp(c.n.replace(/^I/, '')).test(s.n)
  ).length;
  contractImplCount.set(c.n, { file: cg.filePaths[c.f], implCount });
}
```

**输出**：契约目录清单 + 每接口的实现数

**实战要点**：
- **C# 项目**：看 `I*` 命名 + `abstract class *Base`
- **TS/Java**：`interface` 关键字更可靠
- **Go**：需要单独 AST parse（非 class-based）
- **高实现数 = 重要契约**：如果一个接口有 20 个实现，它就是系统关键 seam

---

## 配方 8：按模块边权推导通讯拓扑 [D3-a] ✨

**目标**：从 callEdges 聚合出"模块间通讯图"，识别每条边用的是什么通讯手段 — 用于 §14 模块间通讯章节。

**输入**：`code-graph.json.callEdges{}` + `code-graph.json.symbols[]`

**步骤**：

```js
const cg = JSON.parse(fs.readFileSync('output/code-graph.json', 'utf-8'));

// 1. 建立 symbol index -> module 的映射
function inferModule(fp) {
  const parts = fp.split(/[\\/]/);
  // 可按项目定制；以下为游戏项目示例
  if (parts[0] === 'Assets' && parts[1] === 'Scripts' && parts[2]) {
    return 'Scripts/' + parts[2];
  }
  return parts[0] || 'root';
}

// 2. 聚合跨模块 callEdges + 识别通讯手段
const modEdges = new Map();  // "fromMod -> toMod" => { count, patterns: Set }
for (const [caller, callees] of Object.entries(cg.callEdges || {})) {
  const [fIdx, _] = caller.split('::');
  const fromFp = cg.filePaths[+fIdx];
  if (!fromFp) continue;
  const fromMod = inferModule(fromFp);

  for (const ce of callees) {
    const [cfIdx, calleeName] = ce.split('::');
    const toFp = cg.filePaths[+cfIdx];
    if (!toFp) continue;
    const toMod = inferModule(toFp);
    if (fromMod === toMod) continue;

    const key = fromMod + ' -> ' + toMod;
    if (!modEdges.has(key)) modEdges.set(key, { count: 0, patterns: new Set() });
    const edge = modEdges.get(key);
    edge.count++;

    // 识别通讯手段（按 callee 名字）
    if (/Fire|Emit|Publish|Dispatch/.test(calleeName)) edge.patterns.add('event');
    else if (/\.Instance|getInstance|Singleton/.test(calleeName)) edge.patterns.add('singleton');
    else if (/Subscribe|addListener|On[A-Z]/.test(calleeName)) edge.patterns.add('callback');
    else if (/StartCoroutine|yield/.test(calleeName)) edge.patterns.add('coroutine');
    else if (/await|then|Promise/.test(calleeName)) edge.patterns.add('async');
    else edge.patterns.add('direct-call');
  }
}

// 3. 输出 Top-10 通讯边 + 手段
const top10 = [...modEdges.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 10)
  .map(([key, v]) => ({ edge: key, count: v.count, patterns: [...v.patterns] }));

console.log('模块通讯 Top-10:', top10);
```

**输出**：Top-10 模块间通讯边 + 每条边的通讯手段（直接调用/事件/单例/回调/协程/异步）

**实战要点**：
- **命名推断不完美**：`Fire` 可能是业务方法名（如 `FireCannon`），不要单一依据
- **交叉验证**：对 Top-5 的边，额外 `read_file` 几个真实调用点确认
- **总 callEdges < 50 时降级**：直接写"本项目模块通讯强度低，不展开通讯拓扑图"（对应 M-2 的降级规则）
- **模块命名规则要和 §3 模块管理一致**：否则输出的拓扑和 §3 模块清单对不上

---

## 使用提醒

1. **以上 JS 是伪代码**：IDE Agent 不需要真执行，只需理解语义并在心里（或临时脚本）做等价抽取
2. **配方是起点不是终点**：机械套用配方会产出"好看但无用"的内容；关键是基于抽到的信号做解释和推理
3. **遇到空数据**：`callEdges` 为空 → 走降级；`reusableSymbols` 为空 → 用 Top-20 hotspots；`business-logic.json` 缺失 → 自己从 symbols 找入口
4. **遇到异常 schema**：不同版本的 code-graph 可能字段略有差异，核心字段 `filePaths`/`symbols`/`callEdges`/`hotspots` 必然存在；其他字段可选
