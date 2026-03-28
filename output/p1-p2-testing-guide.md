# P1/P2 实施测试验证指南

**验证日期**: 2026-03-27  
**验证目标**: 确认 P1 (Call Hierarchy IDE 路由) 和 P2 (LSP 统一路由层) 正确实施

---

## 1. 快速验证清单

### 1.1 文件存在性检查

```bash
# 检查新文件是否创建
✅ workflow/core/lsp-router.js           (28.5 KB, 862 行)

# 检查修改文件是否正确
✅ workflow/core/code-graph-query.js     (集成 LSPRouter)
✅ workflow/core/business-logic-extractor.js (使用 LSPRouter)
✅ workflow/AGENTS.md                    (更新文档)
```

### 1.2 集成检查

在 `workflow/core/code-graph-query.js` 中搜索：
```javascript
// 应包含以下引用
const { getLSPRouter } = require('./lsp-router');
await this.codeGraph.getCallGraph(symbolName, { async: true });
```

在 `workflow/core/business-logic-extractor.js` 中搜索：
```javascript
// 应包含以下引用
const { getLSPRouter } = require('./lsp-router');
const router = getLSPRouter();
router.setCodeGraph(this.codeGraph);
```

---

## 2. 功能测试

### 2.1 LSPRouter 基本功能测试

```javascript
// 测试文件: test-lsp-router.js
const { getLSPRouter, resetLSPRouter } = require('./workflow/core/lsp-router');
const { CodeGraph } = require('./workflow/core/code-graph');

async function testLSPRouter() {
  resetLSPRouter();
  const router = getLSPRouter();
  
  // 设置 CodeGraph
  const codeGraph = new CodeGraph();
  router.setCodeGraph(codeGraph);
  
  // 测试路由决策
  const stats = router.getStats();
  console.log('IDE Detection:', stats.ideCapabilities);
  
  // 测试 Call Hierarchy (需要实际项目和符号)
  const result = await router.getCallHierarchy('main', 'both');
  console.log('Call Hierarchy Result:', {
    success: result.success,
    source: result.source,
    isAccurate: result.isAccurate,
    incomingCount: result.incoming?.length,
    outgoingCount: result.outgoing?.length,
  });
}

testLSPRouter().catch(console.error);
```

**预期输出** (IDE 环境如 Cursor/VS Code):
```
IDE Detection: { goToDefinition: true, findReferences: true, callHierarchy: true }
Call Hierarchy Result: {
  success: true,
  source: 'lsp',        // 或 'ide' 取决于实现
  isAccurate: true,
  incomingCount: 5,
  outgoingCount: 8
}
```

**预期输出** (Claude Code):
```
IDE Detection: { goToDefinition: false, ...notes: 'No LSP, use MCP LSP servers' }
Call Hierarchy Result: {
  success: true,
  source: 'regex',
  isAccurate: false,
  incomingCount: 3,
  outgoingCount: 5
}
```

---

### 2.2 CodeGraph 异步 Call Graph 测试

```javascript
// 测试文件: test-codegraph-async.js
const { CodeGraph } = require('./workflow/core/code-graph');

async function testAsyncCallGraph() {
  const graph = new CodeGraph();
  await graph.loadProject('./src');
  
  // 测试异步调用 (启用 P1/P2)
  const result = await graph.getCallGraph('myFunction', {
    async: true,
    direction: 'both',
  });
  
  console.log('Call Graph (Async):', {
    calls: result.calls?.length,
    calledBy: result.calledBy?.length,
    source: result._source,
    isAccurate: result._isAccurate,
  });
  
  // 测试同步调用 (向后兼容)
  const syncResult = graph.getCallGraph('myFunction');
  console.log('Call Graph (Sync):', {
    calls: syncResult.calls?.length,
    calledBy: syncResult.calledBy?.length,
  });
}

testAsyncCallGraph().catch(console.error);
```

**预期输出**:
```
Call Graph (Async): {
  calls: 8,
  calledBy: 5,
  source: 'lsp',
  isAccurate: true
}
Call Graph (Sync): {
  calls: 8,
  calledBy: 5
}
```

---

### 2.3 BusinessLogicExtractor 集成测试

```javascript
// 测试文件: test-business-logic.js
const { BusinessLogicExtractor } = require('./workflow/core/business-logic-extractor');
const { CodeGraph } = require('./workflow/core/code-graph');

async function testBusinessLogic() {
  const codeGraph = new CodeGraph();
  const extractor = new BusinessLogicExtractor({
    codeGraph,
    logger: console,
  });
  
  const result = await extractor.extract('./src', {
    maxFiles: 50,
  });
  
  console.log('Extraction Metrics:', result.metrics);
  console.log('LSP Enhanced:', result.metrics.lspEnhanced);
  console.log('Regex Fallback:', result.metrics.regexFallback);
}

testBusinessLogic().catch(console.error);
```

**预期输出** (有 LSP):
```
Extraction Metrics: {
  filesAnalyzed: 25,
  symbolsFound: 150,
  callRelations: 320,
  lspEnhanced: 42,
  regexFallback: 8
}
LSP Enhanced: 42
Regex Fallback: 8
```

---

## 3. 各 IDE 环境测试

### 3.1 Cursor IDE 测试

在 Cursor 中打开 WorkFlowAgent 项目，运行：

```javascript
const { getLSPRouter } = require('./workflow/core/lsp-router');
const router = getLSPRouter();

console.log('Stats:', router.getStats());
// 应显示: isInsideIDE: true, ideCapabilities.callHierarchy: true

const result = await router.getCallHierarchy('extract', 'both');
console.log('Result:', result);
// 应显示: source: 'lsp' 或 'ide', isAccurate: true
```

### 3.2 VS Code + Copilot Agent 模式测试

在 VS Code 中启用 Agent 模式，运行相同测试。

预期: `source: 'lsp'`, `isAccurate: true`

### 3.3 Claude Code 测试

在 Claude Code 中运行：

```javascript
const { getLSPRouter } = require('./workflow/core/lsp-router');
const router = getLSPRouter();

console.log('Stats:', router.getStats());
// 应显示: isInsideIDE: true
// ideCapabilities.callHierarchy: false
// notes: 提示连接 MCP LSP servers

const result = await router.getCallHierarchy('extract', 'both');
console.log('Result:', result);
// 应显示: source: 'regex', isAccurate: false
```

---

## 4. 边界情况测试

### 4.1 LSPAdapter 未连接

```javascript
// 模拟 LSPAdapter 未连接
const { getLSPRouter, resetLSPRouter } = require('./workflow/core/lsp-router');
resetLSPRouter();
const router = getLSPRouter();
// 不设置 LSPAdapter

const result = await router.getCallHierarchy('unknownSymbol', 'both');
// 应正确降级到 regex fallback，不抛异常
console.log('Fallback Result:', result.source); // 'regex'
```

### 4.2 CodeGraph 未设置

```javascript
const { getLSPRouter, resetLSPRouter } = require('./workflow/core/lsp-router');
resetLSPRouter();
const router = getLSPRouter();
// 不设置 CodeGraph

const result = await router.getCallHierarchy('anySymbol', 'both');
// 应返回失败但不崩溃
console.log('Result:', result.success); // false
console.log('Error:', result.error); // 'No CodeGraph available'
```

### 4.3 超时处理

```javascript
const router = getLSPRouter({ timeout: 100 }); // 100ms 超时

const result = await router.getCallHierarchy('slowFunction', 'both');
// 应超时后正确降级
```

---

## 5. 性能基准测试

```javascript
const { performance } = require('perf_hooks');
const { getLSPRouter } = require('./workflow/core/lsp-router');

async function benchmark() {
  const router = getLSPRouter();
  
  // 测试 10 次 Call Hierarchy 查询
  const times = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await router.getCallHierarchy('extract', 'incoming');
    times.push(performance.now() - start);
  }
  
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`Average Call Hierarchy query time: ${avg.toFixed(2)}ms`);
  
  // IDE 环境应 < 500ms
  // Regex fallback 应 < 100ms (更快但不够准确)
}

benchmark();
```

---

## 6. 回归测试

确保以下现有功能继续工作：

```bash
# 1. 原同步 getCallGraph 调用
node -e "
const { CodeGraph } = require('./workflow/core/code-graph');
const g = new CodeGraph();
g.loadSync('./src');
const result = g.getCallGraph('main');
console.log('Sync call OK:', result.calls !== undefined);
"

# 2. BusinessLogicExtractor 原有流程
node -e "
const { BusinessLogicExtractor } = require('./workflow/core/business-logic-extractor');
const be = new BusinessLogicExtractor({});
console.log('BLE instantiate OK');
"

# 3. LSPAdapter 原有功能
node -e "
const { LSPAdapter } = require('./workflow/hooks/adapters/lsp-adapter');
console.log('LSPAdapter import OK');
"
```

---

## 7. 测试结果记录模板

| 测试项 | 环境 | 结果 | 备注 |
|-------|------|------|------|
| LSPRouter 基本功能 | Cursor | ✅/❌ | |
| LSPRouter 基本功能 | VS Code | ✅/❌ | |
| LSPRouter 基本功能 | Claude Code | ✅/❌ | |
| Async Call Graph | Cursor | ✅/❌ | |
| Async Call Graph | Standalone | ✅/❌ | |
| Sync Call Graph (向后兼容) | 任意 | ✅/❌ | |
| BLE LSP 增强 | Cursor | ✅/❌ | |
| BLE Regex 回退 | Claude Code | ✅/❌ | |
| LSPAdapter 降级 | 无 LSP | ✅/❌ | |
| 超时处理 | 任意 | ✅/❌ | |
| 性能基准 | 任意 | ✅/❌ | 平均响应时间: ___ms |

---

## 8. 常见问题排查

### Q: `getCallGraph` 返回的 `_source` 是 'regex' 而不是 'lsp'
**排查**:
1. 检查 `router.getStats().lspAdapterConnected` 是否为 true
2. 检查 LSPAdapter 的 `serverCapabilities.callHierarchyProvider` 是否为 true
3. 检查 symbol 是否能被正确定位（文件/行号）

### Q: BusinessLogicExtractor 的 `lspEnhanced` 计数为 0
**排查**:
1. 确认热点符号数量 > 0 (`hotspotSymbols.length`)
2. 检查异步调用是否正确 `await` 了
3. 查看控制台日志中 LSPRouter 的路由决策

### Q: Claude Code 中提示 "No LSP" 但未建议 MCP
**排查**:
1. 检查 `ide-detection.js` 中的 `generateIDEToolGuidance()` 是否包含 notes
2. 确保 `capabilities.notes` 字段已设置

---

**验证完成日期**: _______________  
**验证者**: _______________  
**全部通过**: ✅ / ⚠️ / ❌