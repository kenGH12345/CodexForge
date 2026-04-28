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

## 使用提醒

1. **以上 JS 是伪代码**：IDE Agent 不需要真执行，只需理解语义并在心里（或临时脚本）做等价抽取
2. **配方是起点不是终点**：机械套用配方会产出"好看但无用"的内容；关键是基于抽到的信号做解释和推理
3. **遇到空数据**：`callEdges` 为空 → 走降级；`reusableSymbols` 为空 → 用 Top-20 hotspots；`business-logic.json` 缺失 → 自己从 symbols 找入口
4. **遇到异常 schema**：不同版本的 code-graph 可能字段略有差异，核心字段 `filePaths`/`symbols`/`callEdges`/`hotspots` 必然存在；其他字段可选
