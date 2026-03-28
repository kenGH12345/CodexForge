# WorkFlowAgent ADR-37 合规性分析报告

**分析师**: Andrej Karpathy  
**日期**: 2026-03-27  
**分析范围**: 图片所示的 5 个能力模块

---

## 执行摘要

| 能力维度 | ADR-37 合规状态 | 说明 |
|---------|---------------|------|
| **Semantic Search** | ✅ 符合 | IDE `codebase_search` 优先，CodeGraph 保底 |
| **Regex Search** | ✅ 符合 | `grep_search` (ripgrep) 完全依赖，无需自建 |
| **Symbol Lookup** | ✅ 符合 | `view_code_item` 优先，CodeGraph regex 保底 |
| **LSP (Go to Def)** | ⚠️ 需改进 | 有 IDE 优先检测，但 `LSPAdapter` 自建备用仍需增强 |
| **Call Hierarchy** | ❌ 不符合 | CodeGraph regex 模拟，无 IDE tool 优先调用 |

---

## 详细分析

### 1️⃣ Semantic Search ✅ 符合

**图表显示**:
- Cursor: Turbopuffer向量
- VS Code Copilot: FAISS向量
- Claude Code: 内置语义
- **WorkFlowAgent: CodeGraph (TF-IDF)**

**实际实现**:
```javascript
// core/ide-detection.js
const IDE_CAPABILITIES = {
  vscode: {
    codebaseSearch: true,   // ✅ IDE 原生
    // ...
  }
};

// core/code-graph.js
console.log(`[CodeGraph] 🏠 IDE semantic search available — CodeGraph operates in fallback mode`);
```

**ADR-37 实践**:
1. **IDE 优先**: Agent 在 Prompt 中被明确告知优先使用 `codebase_search`
2. **自建保底**: CodeGraph.search() 使用 TF-IDF，在 IDE 不可用时工作
3. **智能降级**: `smart-context-selector.js` 自动降低 CodeGraph 优先级

**结论**: ✅ **完全符合** ADR-37

---

### 2️⃣ Regex Search ✅ 符合

**图表显示**:
- 所有 IDE: ripgrep
- **WorkFlowAgent: ripgrep**

**实际实现**:
```javascript
// 完全依赖 IDE 工具，无自建实现
// Agent 直接使用 grep_search (ripgrep backend)
```

**结论**: ✅ **无需自建**，完全依赖 IDE，符合 ADR-37 最佳实践

---

### 3️⃣ Symbol Lookup ✅ 符合

**图表显示**:
- 所有 IDE: `view_code_item`
- **WorkFlowAgent: `view_code_item`**

**实际实现**:
```javascript
// core/code-graph-query.js
_shouldUseIDE() {
  return this._ideDetection.isInsideIDE && this._ideDetection.capabilities.viewCodeItem;
}

async _querySymbolWithIDEFirst(symbolName, fileHint) {
  // P1: Attempt IDE Symbol Lookup first
  if (this._shouldUseIDE()) {
    const result = await querySymbolWithIDE(symbolName, fileHint, {
      timeout: this._ideSymbolTimeout,
      allowFallback: true,
    });
    if (result.success) return result;
  }
  // P2: Fallback to local regex-based implementation
  return this._querySymbolLocal(symbolName, fileHint);
}
```

**结论**: ✅ **完全符合** ADR-37: `view_code_item` → 失败 → CodeGraph regex 解析

---

### 4️⃣ LSP (Go to Definition / Find References) ⚠️ 部分符合，需增强

**图表显示**:
- Cursor/VS Code: IDE原生
- Claude Code: Tool模拟
- **WorkFlowAgent: `LSPAdapter`** ⚠️

**实际实现 - IDE 优先检测**:
```javascript
// hooks/adapters/lsp-adapter.js
async connect() {
  // ── IDE-First: Skip self-spawned LSP when IDE already provides one ────
  if (shouldSkipLSPAdapter()) {
    console.log(`[LSPAdapter] 🏠 IDE environment detected – skipping self-spawned LSP.`);
    console.log(`[LSPAdapter]    Agent should use IDE tools: view_code_item, codebase_search, grep_search.`);
    this._skippedForIDE = true;
    return; // Do NOT spawn – IDE's LSP is superior
  }
  // ... spawn LSP server
}
```

**问题**: 
1. `LSPAdapter.connect()` 会跳过自启动，**但没有将操作委托给 IDE 的等效工具**
2. `gotoDefinition()` API 存在，但当在 IDE 中运行时，**没有路由到 IDE 的等效功能**
3. 依赖 Agent 自行判断使用 IDE tool，而非强制路由

**期望行为**:
```javascript
// 应类似 Symbol Lookup 的实现
gotoDefinition(file, line, col) {
  if (shouldUseIDELSP()) {
    // 使用 IDE 内置能力 (e.g., view_code_item, trigger IDE command)
    return callIDEGotoDefinition(file, line, col);
  }
  // 自建 LSP 作为保底
  return this._spawnedLSP.gotoDefinition(file, line, col);
}
```

**当前行为**: Agent 需要手动选择使用哪个工具

**结论**: ⚠️ **部分符合** - 有跳过逻辑，但缺乏统一路由层

---

### 5️⃣ Call Hierarchy ❌ 不符合

**图表显示**:
- Cursor/VS Code: IDE原生
- Claude Code: ❌ 不支持
- **WorkFlowAgent: CodeGraph模拟** ⚠️

**实际实现**:
```javascript
// core/code-graph-analysis.js
// CodeGraph 通过 regex 分析调用关系
_buildCalledByIndex() {
  // 从 _callEdges 构建反向索引
  // _callEdges 来自 regex 解析 (core/code-graph-builder.js 中通过分析函数名出现频次)
}

getHotspots({ topN = 20 }) {
  // 返回基于 calledBy count 的热点符号
  // 但这些数据来自 regex，可能有误报
}
```

**关键问题**:
1. ❌ **无 IDE Tool 优先调用** - Call Hierarchy 没有走 `view_code_item` 或 IDE 内置 LSP
2. ❌ **纯 regex 模拟** - CodeGraph.callEdges 是基于词频匹配，不是真正的调用图
3. ⚠️ **IDE 有能力但被绕过** - VS Code 1.16+ 原生支持 Call Hierarchy API

**期望实现**:
```javascript
// core/call-hierarchy-adapter.js (建议新增)
async getIncomingCalls(symbolId) {
  if (ideHasCallHierarchy()) {
    // 使用 IDE 的 Call Hierarchy Provider
    return await callIDECallHierarchy('incoming', symbolId);
  }
  // 保底: CodeGraph regex 近似
  return this._codeGraph.getIncomingCallsApprox(symbolId);
}
```

**VS Code 有**:
- `textDocument/prepareCallHierarchy`
- `callHierarchy/incomingCalls`
- `callHierarchy/outgoingCalls`

**结论**: ❌ **不符合** ADR-37 - 有 IDE 能力但没有优先使用

---

## 差距矩阵

| 能力 | IDE 原生 | Agent 当前行为 | 差距 | 优先级 |
|-----|---------|---------------|------|--------|
| Semantic Search | `codebase_search` | 文档提示优先使用 | ✅ 符合 | P3 |
| Regex Search | `grep_search` (ripgrep) | 直接使用 | ✅ 符合 | P3 |
| Symbol Lookup | `view_code_item` | `_querySymbolWithIDEFirst()` ✅ | ✅ 符合 | P3 |
| **Go to Definition** | IDE LSP | `LSPAdapter.gotoDefinition()` 自建 | ⚠️ 无路由层 | **P2** |
| **Find References** | IDE LSP | `LSPAdapter.findReferences()` 自建 | ⚠️ 无路由层 | **P2** |
| **Call Hierarchy** | IDE LSP / Call Hierarchy API | `CodeGraph._callEdges` regex | ❌ 完全自建 | **P1** |

---

## 建议行动清单

### P1: Call Hierarchy - 实现 IDE First

```javascript
// core/call-hierarchy-router.js (新增)
class CallHierarchyRouter {
  constructor(options = {}) {
    this._ideDetection = options.ideDetection || require('./ide-detection');
    this._codeGraph = options.codeGraph; // fallback
  }

  async getIncomingCalls(symbol) {
    if (this._shouldUseIDE()) {
      return await this._callIDE('incoming', symbol);
    }
    return this._codeGraph.getCallGraph(symbol).calledBy;
  }

  async getOutgoingCalls(symbol) {
    if (this._shouldUseIDE()) {
      return await this._callIDE('outgoing', symbol);
    }
    return this._codeGraph.getCallGraph(symbol).calls;
  }

  _shouldUseIDE() {
    const d = this._ideDetection.detectIDEEnvironment();
    return d.isInsideIDE && d.capabilities.callHierarchy;
  }
}
```

### P2: LSP 路由统一层

增强 `LSPAdapter` 或新增 `LSPRouter`:
- `gotoDefinition()` → 优先 `view_code_item` → fallback `LSPAdapter`
- `findReferences()` → 优先 `view_code_item` + `grep_search` → fallback `LSPAdapter`

### P3: Prompt 强化 (已完成)

已在 `prompt-builder.js` 中添加 IDE 工具指导，保持现状。

---

## 图表标注修正建议

当前图表:
```
Call Hierarchy | ✅ IDE原生 | ✅ IDE原生 | ❌ | ⚠️ CodeGraph模拟
```

应反映实际 ADR-37 状态:
```
Call Hierarchy | ✅ IDE原生 | ✅ IDE原生 | ❌ | ❌ CodeGraph模拟 (需增强)
                                                    ↑
                                                当前状态
```

或添加说明:
```
Call Hierarchy | ✅ IDE原生 | ✅ IDE原生 | ❌ | ⚠️ CodeGraph模拟 (无 IDE 优先路由)
```

---

## 总体评估

| 维度 | 评分 | 说明 |
|-----|------|------|
| **Semantic Search** | ✅ 100% | IDE 优先，自建保底 |
| **Regex Search** | ✅ 100% | 完全 IDE |
| **Symbol Lookup** | ✅ 100% | IDE 优先，自建保底 |
| **LSP (Go to Def)** | ⚠️ 60% | 有跳过逻辑，无强制路由 |
| **Call Hierarchy** | ❌ 20% | 纯自建，无 IDE 优先 |
| **综合 ADR-37 得分** | **76%** | 3/5 完全符合，2/5 需增强 |

**结论**: WorkFlowAgent 在核心查询能力（Semantic/Regex/Symbol）上 **已实现 ADR-37**，但在 **LSP 高级功能（Call Hierarchy）** 上仍需补全 IDE First 的路由机制。