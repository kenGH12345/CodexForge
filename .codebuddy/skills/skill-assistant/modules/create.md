# 创建模块

引导用户创建高质量 Agent Skill，遵循渐进式披露原则和 200 行规则。

> 本模块不直接写 Skill，而是提供创建指南和质量约束，由用户（或其他 Agent）执行具体创建。

---

## 核心原则

### 200 行规则

SKILL.md 正文必须控制在 **200 行以内**（不含 frontmatter）。超过时拆分到 `references/`。

- 严格目标：200 行
- 可接受上限：500 行（性能开始下降）
- 每个 references/ 文件也建议 < 200 行

### 三层加载系统

| 层级 | 加载时机 | 内容 | Token 预算 |
|------|---------|------|-----------|
| 元数据 | Agent 启动时（始终在 context） | `name` + `description` | ~100 词 |
| SKILL.md 正文 | Skill 触发时 | 核心指令和流程 | < 200 行 |
| 捆绑资源 | Agent 按需加载 | references/ + scripts/ + assets/ | 无限制 |

85% 的初始 context 开销可通过此分层消除。

### 自由度设定

根据任务的脆弱性和变异性选择合适的指令精度：

| 自由度 | 适用场景 | 指令形式 |
|--------|---------|---------|
| **高** | 多种方法均可、依赖上下文判断 | 文本指令 + 启发式 |
| **中** | 存在最佳实践、允许部分变化 | 伪代码/带参数脚本 |
| **低** | 操作脆弱、一致性关键 | 确定性脚本，参数极少 |

---

## 创建流程

### Step 1：快速脚手架

```bash
npx skills init {skill-name}
```

或手动创建目录结构：

```
{skill-name}/
├── SKILL.md              # 必须，< 200 行
├── references/            # 可选，按需加载的详细文档
├── scripts/               # 可选，确定性逻辑
└── assets/                # 可选，输出模板（不加载到 context）
```

### Step 2：编写 SKILL.md

**YAML Frontmatter**（必须）：

```yaml
---
name: skill-name          # 小写连字符，与目录名一致
description: >            # 第三人称，包含"做什么"和"何时用"
  Processes PDF files and extracts text.
  Use when working with PDF files or document extraction.
---
```

**正文结构**（推荐顺序）：

1. 一句话说明 Skill 的用途
2. 何时使用（触发条件）
3. 核心工作流（步骤）
4. 参考链接（指向 references/）

**写作原则**：
- 祈使句/不定式开头（"Extract text..."，不是"You should extract..."）
- 默认假设 Agent 已经很聪明，只写它不知道的
- 每段信息自检：删掉后 Agent 表现是否下降？不下降 → 删掉
- 不放时效性信息（日期、版本号会过时）
- 术语一致（选一个词用到底，不要 API endpoint / URL / route 混用）

### Step 3：拆分到 references/

正文超 200 行时，按以下策略拆分：

| 内容类型 | 放在 | 理由 |
|---------|------|------|
| 核心流程、触发条件 | SKILL.md | 每次触发都需要 |
| 详细规则、参数表、示例 | references/ | 按需加载 |
| 确定性逻辑（正则、计算） | scripts/ | 不消耗 Token |
| 输出模板 | assets/ | 仅生成输出时读取 |

**引用深度限制**：references/ 文件只从 SKILL.md 直接链接，不嵌套引用（SKILL.md → ref.md ✅，ref.md → detail.md ❌）。

### Step 4：命名

推荐**动名词形式**（gerund）：

- `processing-pdfs`、`analyzing-spreadsheets`、`managing-databases`

也可接受：
- 名词短语：`pdf-processing`
- 动作导向：`process-pdfs`

避免：`helper`、`utils`、`tools`（过于模糊）

### Step 5：编写 description

description 决定 Agent 何时激活此 Skill，是最重要的元数据：

- **第三人称**（"Processes…" 不是 "I can help you…"）
- **包含关键词**（用户可能怎么描述这个需求）
- **包含触发场景**（"Use when…"）

```yaml
# ✅ 好
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.

# ❌ 差
description: Helps with documents
```

### Step 6：验证

创建完成后建议：

1. **自检清单**（见 [references/create-best-practices.md](../references/create-best-practices.md)）
2. **质检模块**：输入"检查这个 skill 质量"触发 [modules/inspect.md](inspect.md) 的 8 维度评分
3. **多模型测试**：Skill 是模型的附加层，不同模型效果可能不同

---

## Eval 驱动开发

**先写测试，再写 Skill**，确保解决真实问题而非想象问题：

1. **无 Skill 基线**：在没有 Skill 的情况下执行代表性任务，记录失败点
2. **创建 Eval**：设计 3 个场景测试这些失败点
3. **最小 Skill**：只写刚好通过 Eval 的内容
4. **迭代**：执行 Eval → 对比基线 → 微调

### 迭代模式

用 Agent A 写 Skill，用 Agent B 测试：

```
Agent A（创作者）── 创建/改进 Skill ──► SKILL.md
                                          │
Agent B（测试者）── 使用 Skill 执行任务 ──► 反馈问题
                                          │
Agent A ── 根据反馈改进 ──────────────────►
```

---

## 反馈循环模式

复杂任务中嵌入验证-修复循环：

```
执行步骤 → 运行验证脚本 → 有错误？→ 修复 → 重新验证 → 通过后继续
```

将此模式写入 Skill 可显著提升输出质量。
