# Claude Code 能力实现方式修正报告

**调研日期**: 2026-03-27  
**调研方式**: 网络搜索 + 官方文档分析

---

## 原图表标注 vs 实际实现

### 1. LSP (Go to Definition)

| IDE | 原图表标注 | **实际调研结果** | 说明 |
|-----|-----------|-----------------|------|
| **Claude Code** | ⚠️ Tool模拟 | ⚠️ **Grep/File Read 模拟** | 准确标注，但需澄清 |

**Claude Code 实际情况**:
- Claude Code 是 **CLI 终端工具**，不是 IDE
- 没有传统 IDE 的 LSP 客户端架构
- **内置工具**：Read, View, Edit, Bash, Task, WebSearch, WebFetch 等
- Go to Definition 通过 **读取文件 + grep 搜索** 模拟实现
- 与 Cursor/VS Code 的 ⚠️ 含义**不同**：
  - Cursor: 有 LSP，但是通过 Tool API 封装
  - Claude Code: **没有 LSP**，纯文本操作模拟

**建议标注更新**:
```
Claude Code: ⚠️ 无LSP, Grep模拟
```

---

### 2. Call Hierarchy

| IDE | 原图表标注 | **实际调研结果** | 说明 |
|-----|-----------|-----------------|------|
| **Claude Code** | ❌ 不支持 | ❌ **不支持** | 标注准确 |

**Claude Code 实际情况**:
- 作为 CLI 工具，无 Call Hierarchy 功能
- 可通过 MCP 连接外部服务扩展
- 原生不支持任何调用关系分析

**标注无需更改** ✅

---

## 关键发现：Claude Code 的架构差异

### Claude Code vs 传统 IDE

| 特性 | Cursor / VS Code | Claude Code |
|-----|------------------|-------------|
| **架构** | 完整 IDE + LSP 客户端 | CLI 终端工具 |
| **LSP 支持** | ✅ 原生 | ❌ 无 |
| **代码导航** | view_code_item / LSP | Read file + grep |
| **Call Hierarchy** | ⚠️ IDE原生 | ❌ 无 |
| **扩展方式** | Extension API | MCP Servers |

**结论**: Claude Code 不应与 Cursor/VS Code 在 "LSP" 维度直接对比，因为：
n1. 它不是 IDE，而是 CLI agent
2. 它的 "IDE 能力" 是通过 **MCP** 连接外部工具获得的

---

## 修正后的完整对比表

| 能力维度 | Cursor | VS Code Copilot | Claude Code | WorkFlowAgent | ADR-37 符合度 |
|---------|--------|-----------------|-------------|---------------|---------------|
| **Semantic Search** | ✅ Turbopuffer向量 | ✅ FAISS向量 | ✅ 内置向量索引 | ✅ IDE `codebase_search` / CodeGraph保底 | ✅ 符合 |
| **Regex Search** | ✅ ripgrep | ✅ ripgrep | ✅ ripgrep | ✅ IDE `grep_search` | ✅ 符合 |
| **Symbol Lookup** | ✅ `view_code_item` | ✅ `view_code_item` | ⚠️ `Read`+grep模拟 | ✅ IDE `view_code_item` / CodeGraph保底 | ✅ 符合 |
| **LSP Go to Def** | ✅ IDE原生 | ✅ IDE原生 | ⚠️ **无LSP,Grep模拟** | ⚠️ 应IDE优先,需增强路由 | ❌ 需修复 |
| **Call Hierarchy** | ✅ IDE原生 | ✅ IDE原生 | ❌ 不支持 | ⚠️ CodeGraph模拟 | ❌ 需增强 |
| **Type Inference/Hover** | ✅ IDE原生 | ✅ IDE原生 | ❌ 不支持 | ⚠️ LSPAdapter | ⚠️ 部分符合 |

---

## 对 WorkFlowAgent 的启示

### 问题识别

当前 WorkFlowAgent 在 IDE Detection 中把 Claude Code 视为 "partial IDE":

```javascript
// core/ide-detection.js (当前)
claudeCode: {
  name: 'Claude Code (terminal)',
  isFullIDE: false,  // ✅ 正确
  capabilities: {
    viewCodeItem: false,  // ✅ 正确 - 没有 view_code_item
    goToDefinition: false, // ✅ 正确 - 无原生LSP
    findReferences: false,
    callHierarchy: false,  // ✅ 正确
    // ...
  }
}
```

**但存在一个问题**: 当 Agent 在 Claude Code 中运行时，它应该如何处理需要 LSP/Call Hierarchy 的请求？

### 建议的修复方案

#### 方案 A: 增强 IDE Detection（推荐 P1）

在 `ide-detection.js` 中增加 "capability gaps" 提示：

```javascript
// core/ide-detection.js
function getCapabilityGaps() {
  const detection = detectIDEEnvironment();
  const gaps = [];
  
  if (detection.name === 'Claude Code (terminal)') {
    gaps.push({
      capability: 'lspNavigation',
      severity: 'high',
      recommendation: 'Use MCP to connect external LSP server, or fallback to CodeGraph regex analysis',
      builtInAlternative: null
    });
    gaps.push({
      capability: 'callHierarchy',
      severity: 'medium',
      recommendation: 'Use CodeGraph.getCallGraph() for approximate call analysis',
      builtInAlternative: 'CodeGraph'
    });
  }
  
  return gaps;
}
```

#### 方案 B: 为 Claude Code 提供 MCP 推荐（推荐 P2）

当检测到 Claude Code 时，提示用户连接 MCP：

```javascript
// core/claude-code-adapter.js (建议新增)
const CLAUDE_CODE_MCP_RECOMMENDATIONS = {
  lsp: ['clangd', 'typescript-language-server', 'pyright'], // language-specific
  callHierarchy: 'Not available in Claude Code natively, recommend using CodeGraph',
  // ...
};
```

---

## 优先级矩阵更新

| 优先级 | 修复项 | 原估算 | 新估算 | 变更原因 |
|-------|-------|-------|-------|---------|
| **P1** | Call Hierarchy IDE 路由 | 4-6h | **8-12h** | 需区分 IDE vs CLI 环境处理策略 |
| **P2** | LSP 统一路由层 | 6-8h | **6-8h** | 估算准确，但需增加 Claude Code 分支 |
| **P3** | 文档更新 | 30min | **1h** | 需澄清 Claude Code 的特殊性 |
| **新增 P2** | Claude Code 适配层 | - | **4-6h** | 新增：检测 gaps 并提供 MCP 建议 |

---

## 总结

1. **原图表中 Claude Code 的标注基本准确**
   - LSP (Go to Def): ⚠️ 标注正确，但含义是 "无LSP，纯模拟"
   - Call Hierarchy: ❌ 标注正确，确实不支持

2. **WorkFlowAgent 需要特殊处理 Claude Code**
   - 不应期待它有 IDE 原生工具
   - 应提供 "capability gaps" 检测和 MCP 替代方案建议

3. **Claude Code 用户的最佳实践**
   - 连接 MCP LSP Servers 获得 IDE 能力
   - WorkFlowAgent 应检测到这一点并调整策略