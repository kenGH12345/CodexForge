# ADR-37 / Claude Code 能力标注修复总结

**修复日期**: 2026-03-27  
**执行人**: Andrej Karpathy  
**相关内存**: [[memory:yoe1evyh]] ADR-37 IDE-First 原则

---

## 问题背景

原能力对比图表中对 Claude Code 的标注：

| 能力 | Claude Code (原标注) | 状态 |
|-----|---------------------|------|
| LSP (Go to Def) | ⚠️ Tool模拟 | 需澄清 |
| Call Hierarchy | ❌ 不支持 | 准确 |

用户要求修复这两个点，因为它们可能是误解或需要更精确的标注。

---

## 调研发现

### Claude Code 的架构本质

Claude Code 是一个 **CLI 终端工具**，不是传统 IDE：

| 特性 | Cursor/VS Code | Claude Code |
|-----|---------------|-------------|
| **类型** | 完整 IDE | CLI Agent |
| **LSP 客户端** | ✅ 内置 | ❌ 无 |
| **导航工具** | `view_code_item` (LSP-based) | `Read` + `Grep` (text-based) |
| **Call Hierarchy** | ✅ IDE原生 | ❌ 不支持 |
| **Type Inference** | ✅ LSP hover | ❌ 不支持 |

### 修正后的标注

| 能力 | Claude Code (修正后) | 说明 |
|-----|---------------------|------|
| LSP (Go to Def) | ⚠️ **无LSP，Grep模拟** | CLI 无编译器级别的 go-to-def |
| Call Hierarchy | ❌ **不支持** | 准确，无需修改 |

---

## 代码修复

### 1. 修复 `core/ide-detection.js` - Claude Code 能力配置

**修改前** (第76-95行):
```javascript
claudeCode: {
  capabilities: {
    viewCodeItem: true,     // ❌ 错误 - Claude Code 没有此工具
    builtinLSP: false,      // ✅ 正确
    callHierarchy: false,   // ✅ 正确
    findReferences: true,   // ⚠️ 通过 grep 模拟
    goToDefinition: true,   // ⚠️ 通过 grep 模拟
  }
}
```

**修改后**:
```javascript
claudeCode: {
  capabilities: {
    viewCodeItem: false,    // ✅ 修正 - 无此工具
    builtinLSP: false,      // ✅ 正确
    callHierarchy: false,   // ✅ 正确
    findReferences: true,   // ✅ 通过 grep_search 模拟
    goToDefinition: true,   // ✅ 通过 grep_search + Read 模拟
  },
  notes: [
    'Claude Code is a CLI agent (not IDE), no LSP support',
    'Code navigation via text search (grep) not compiler-accurate',
    'Consider connecting MCP LSP servers for IDE-like features',
  ],
}
```

### 2. 增强 `generateIDEToolGuidance()` - IDE 指导生成

新增功能：
- 区分 **Full IDE** (Cursor, VS Code) vs **CLI Tools** (Claude Code)
- 为 CLI Tools 添加 **⚠️ 警告提示**
- 为 Claude Code 添加 **Call Hierarchy 限制说明**
- 建议 **MCP LSP Servers** 作为替代方案

**新增提示示例**:
```markdown
## ⌨️ Tool Guidance (Claude Code detected)

> You are running inside **Claude Code**. Prefer CLI tools over injected context...

⚠️ **Note**: Claude Code is a CLI agent (not a full IDE). It lacks compiler-accurate
   LSP features like `view_code_item`, call hierarchy, and type inference.
   Consider connecting MCP LSP servers for enhanced IDE capabilities.

### Tool Priority (Built-in first, self-built fallback)

| Need | ✅ Prefer | 🔄 Fallback |
|------|-----------|-------------|
| Symbol lookup | `Read` + `Grep` | CodeGraph.querySymbol() |
| Go to definition | `Grep` + `Read` | CodeGraph + LSPAdapter |
| Call Hierarchy | ❌ Not available | CodeGraph.getCallGraph() |
```

---

## 对 WorkFlowAgent 的影响

### 之前的行为

当 Agent 在 Claude Code 中运行时：
1. Prompt 错误地提示 "使用 `view_code_item`"
2. Agent 尝试调用不存在的工具 → 失败
3. 退回到 CodeGraph，但没有明确的降级指导

### 修复后的行为

1. Prompt **正确提示** "使用 `Read` + `Grep`"
2. Agent **明确知道** 没有 LSP/Call Hierarchy
3. 提供 **MCP 建议** - "连接 LSP server 获得 IDE 能力"

---

## 建议的修复方案（与之前 P1/P2/P3 对比）

| 原P级 | 原修复项 | 新理解 | 建议调整 |
|------|---------|-------|---------|
| P1 | Call Hierarchy IDE 路由 | 对 Claude Code **无效**（无 LSP） | 保留给 Cursor/VS Code，为 CC 提供 CodeGraph fallback |
| P2 | LSP 统一路由层 | 对 Claude Code **需特殊处理** | 增加分支：IF CC THEN 建议使用 MCP |
| P3 | 文档更新 | 需包含 Claude Code 特殊性 | 已在 `generateIDEToolGuidance` 自动完成 |
| 新增 | Claude Code MCP 推荐 | 新需求 | 在 detection 中增加 notes 字段 |

---

## 修正后的完整能力表

| 能力维度 | Cursor | VS Code Copilot | Claude Code | WorkFlowAgent | ADR-37 |
|---------|--------|-----------------|-------------|---------------|--------|
| **Semantic Search** | ✅ Turbopuffer | ✅ FAISS | ✅ 内置索引 | ✅ `codebase_search`/CodeGraph | ✅ |
| **Regex Search** | ✅ ripgrep | ✅ ripgrep | ✅ ripgrep | ✅ `grep_search` | ✅ |
| **Symbol Lookup** | ✅ `view_code_item` | ✅ `view_code_item` | ⚠️ `Read`+Grep | ✅ `view_code_item`/CodeGraph | ✅ |
| **LSP Go to Def** | ✅ IDE原生 | ✅ IDE原生 | ⚠️ **无LSP,Grep模拟** | ⚠️ 需增强路由 | ❌ |
| **Call Hierarchy** | ✅ IDE原生 | ✅ IDE原生 | ❌ **不支持** | ⚠️ CodeGraph模拟 | ❌ |
| **Type Inference** | ✅ IDE原生 | ✅ IDE原生 | ❌ **不支持** | ⚠️ LSPAdapter | ⚠️ |

---

## 文件修改清单

| 文件 | 修改类型 | 说明 |
|-----|---------|------|
| `workflow/core/ide-detection.js` | 修正 + 增强 | 修正 CC 能力配置，增强指导生成函数 |

---

## Key Takeaways

1. **Claude Code 不是 IDE** - 它是 CLI Agent，不应期待它有 IDE 原生工具
2. **MCP 是关键** - Claude Code 通过 MCP 连接 LSP servers 获得 IDE 能力
3. **WorkFlowAgent 需要区分处理** - 对 CC 提供 "无 LSP" 的 fallback 策略
4. **标注需精确** - "⚠️ Tool模拟" 应明确为 "⚠️ 无LSP，Grep模拟"

---

**修复完成** ✅  
**下一步**: 根据此报告调整 P1/P2/P3 的实施策略，针对 Claude Code 的特殊性提供专门的适配层。