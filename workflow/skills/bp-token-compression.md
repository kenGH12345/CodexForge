---
name: bp-token-compression
version: 1.0.0
description: 输入 Token 压缩决策规则。当上下文接近预算限制、需要选择保留/丢弃/压缩哪些内容时加载。覆盖 L0-L3 四层压缩管线和降级策略。
---

# 输入 Token 压缩

> **触发场景**：上下文组装时需要决策——保留、丢弃还是压缩某块内容。

## 第一性原理
<!-- PURPOSE: The fundamental axiom. One sentence. -->

> **压缩的本质**：用最少的 token 保留决策必需的信息，丢弃不影响结论的冗余。

---

## 压缩决策树
<!-- PURPOSE: When to use which compressor. Agent follows this tree top-down. -->

```
内容类型？
├─ 结构化表格(Markdown table) → BlockCompressor (L0)
│   └─ 表格→JSON, ✅→P, ❌→F, 移除分隔符 → 60-65%缩减
├─ 自然语言(>2000字符 + cheapLLM可用) → SemanticCompressor + LLM摘要
│   └─ LLM摘要 > 启发式压缩，优先使用
├─ 自然语言(≤2000字符 或 无LLM) → SemanticCompressor 启发式
│   ├─ 冗余重复 → REDUNDANCY_REMOVAL
│   ├─ 长段落 → SENTENCE_SELECTION (TextRank)
│   ├─ 超长文档 → PARAGRAPH_SUMMARY
│   └─ 代码 → CODE_STRUCTURE (保留结构，移除注释)
└─ 代码结构说明 → HIERARCHICAL (概览+压缩细节)
```

---

## 阈值速查表
<!-- PURPOSE: All critical constants with source files for traceability. -->

| 常量 | 值 | 来源 |
|------|-----|------|
| MAX_INJECT_TOKENS | 2800 | context-loader-config.js |
| ENRICHMENT_BUDGET_CHARS | 14000 | enrichment-budget-guard.js |
| ENRICHMENT_COMPRESS_THRESHOLD | 3000 | enrichment-budget-guard.js |
| STAGE_TOKEN_BUDGET_CHARS | 60000 | token-budget.js |
| HALLUCINATION_RISK_THRESHOLD | 16000 tokens | constants.js |
| BlockCompressor minSize | 200 chars | block-compressor.js |
| SemanticCompressor minSize | 200 chars | semantic-compressor.js |
| LLM摘要触发 | >2000 chars + cheapLLM | semantic-compressor.js |

---

## 优先级规则
<!-- PURPOSE: What to keep vs drop when budget is tight. -->

**Enrichment 阶段优先级** (enrichment-budget-guard.js):
| 优先级 | 标签 | 值 |
|--------|------|----|
| 最高 | EXPERIENCE | 80 |
| 高 | ANCHOR_FILES | 75 |
| 中 | CODE_GRAPH_SEED | 60 |
| 中低 | WEB_SEARCH | 50 |
| 低 | SESSION_MEMORY | 40 |

**Stage 预算乘数** (token-budget.js):
| 阶段 | 乘数 | 有效预算 |
|------|------|---------|
| ANALYSE | 0.6 | 36K chars |
| ARCHITECT | 0.85 | 51K chars |
| PLAN | 0.5 | 30K chars |
| DEVELOPER | 1.0 | 60K chars |
| TESTER | 0.85 | 51K chars |

**降级关键区** (prompt-context-degradation.js):
- **永不丢弃**：ADR决策、错误/警告(⚠️🔴❌)、Known Issues、Requirements、Quality Gate
- **优先丢弃**：低优先级 enrichment (EXTERNAL_EXPERIENCE=30, SESSION_MEMORY=40)

---

## 反模式
<!-- PURPOSE: Common compression mistakes. -->

| # | 反模式 | 修正 |
|---|--------|------|
| 1 | 压缩代码逻辑（删除条件分支） | 只压缩注释和空行，保留全部逻辑 |
| 2 | 压缩错误信息（丢弃 stack trace） | 错误信息=关键区，永不压缩 |
| 3 | 多次压缩同一块（L0→L0.5→L1叠加） | 每块只压缩一次，在最早可压缩层执行 |
| 4 | 对 <200 字符的块启用压缩 | 低于 minSize 跳过，压缩收益 < 开销 |
| 5 | 压缩后不检查实际节省 | compressed.length < original.length - 50 时放弃压缩 |

---

## Gotchas
<!-- PURPOSE: Environment-specific traps. -->

1. **BlockCompressor 有 skipLabels 机制** — 某些标签的表格不需要压缩（如已压缩过的）。检查 `skipLabels` 配置再决定。
2. **SemanticCompressor 需要 setCheapLlmCall()** — 没有注入 cheap LLM 时，>2000 字符的自然语言只能用启发式，效果差 30-40%。
3. **双截断信号** — 如果 L2 dropped blocks AND L3 still exceeds threshold，说明上游注入了过多内容，需要在 L1 减少注入量而非在 L3 继续截断。
4. **Stage 乘数影响预算** — PLAN 阶段只有 30K chars，ANALYSE 只有 36K，不要在这些阶段请求大量 enrichment。

---

## Checklist
<!-- PURPOSE: Verification checklist for token compression decisions. -->

- [ ] 内容类型已识别（结构化/自然语言/代码）
- [ ] 使用了正确的压缩器（BlockCompressor vs SemanticCompressor）
- [ ] 压缩后的节省 >50 字符（否则放弃）
- [ ] 关键区内容未被压缩或丢弃
- [ ] 未对同一内容多次压缩
