---
name: self-refinement
version: 2.0.0
description: 将纠错经验沉淀为持久化�?Rules/Skills 更新，构建反馈闭环。当被用户纠正且错误具有模式性时自动触发，或通过 /reflect 命令手动触发回顾�?---

# 经验沉淀 (Self-Refinement)

## 核心定位
<!-- PURPOSE: Defines the skill's core mission: converting unstructured error experiences into structured persistent context (Rules/Skills) to prevent cross-session repetition. -->

**从错误中构建反馈闭环**：将非结构化的错误经验转化为结构化的持久化上下文（Rules/Skills），防止同类错误在新会话中重复发生�?
> 原理：LLM 没有跨会话的持久记忆——会�?A 中被纠正的错误，在会�?B 中会以相同概率再次发生。唯一的解法是将错误经验外化为持久化的上下文�?
---

## 触发模式
<!-- PURPOSE: Defines when self-refinement activates: automatic (after user correction) vs manual (/reflect command). -->

### 模式一：自动触�?
**触发条件**：AI 在协作过程中被用户纠正（用户否定�?AI 的输出并给出了正确方向）�?
**行为**�?1. **先完成当前纠�?*——不打断用户当前的任务流
2. 纠正完成后，**在回复末�?*简要评估是否需要沉淀经验
3. 如果需要，输出轻量建议（不超过 3 条）

**输出格式**�?```
---
💡 **经验沉淀建议**

刚才的纠正揭示了一个可沉淀的模式：

- **错误模式**：[简�?AI 犯的错]
- **根因**：[规范缺失 / 知识缺失 / 流程遗漏 / 模式错误]
- **建议**：[更新 Rule/Skill 的具体操作]

是否需要我执行？（回复"沉淀"执行，或忽略继续当前工作�?```

**设计原则**�?- **不打�?*：建议附在回复末尾，不影响正常工作流
- **轻量�?*：仅简述，不展开长篇分析
- **建议优先**：不自主执行，等用户确认

### 模式二：手动触发�?reflect�?
**触发条件**：用户通过 `/reflect` Command 主动发起�?
**行为**�?1. 回顾当前对话历史
2. 识别所有被纠正的错误模�?3. 对每个错误执行完整的诊断闭环
4. 输出结构化的沉淀建议

---

## 核心闭环
<!-- PURPOSE: The 6-step refinement loop: identify error �?diagnose root cause �?search existing knowledge �?generate suggestions �?user confirmation �?execute updates. -->

无论自动还是手动触发，共享同一个核心流程：

### Step 1: 识别错误模式

回顾对话�?AI 被纠正的场景，提取：
- **错误输出**：AI 说了什�?做了什�?- **正确方向**：用户期望什�?- **差距**：AI 为什么偏�?
### Step 2: 诊断根因

| 根因类别 | 定义 | 典型表现 |
|----------|------|----------|
| **规范缺失** | 现有 Rules/Skills 中没有覆盖该场景 | AI 不知道项目的特定约定 |
| **知识缺失** | AI 缺少项目特定的领域知�?| AI 对某个模块的行为/限制不了�?|
| **流程遗漏** | Workflow Skill 中缺少关键步骤或检查点 | AI 跳过了应有的验证步骤 |
| **模式错误** | AI 应用了错误的思维模式 | AI 用类比代替第一性原理推�?|

### Step 3: 检索现有知�?
搜索现有 Skills �?Rules�?- 是否已有相关规则？→ 需�?*补充/修改**
- 完全没有相关规则？→ 需�?*新建**

### Step 4: 生成建议

每条建议包含�?
```markdown
### 建议 N: [简短标题]

- **根因**：[规范缺失 / 知识缺失 / 流程遗漏 / 模式错误]
- **目标文件**：`[Rules/Skills 文件路径]`
- **操作**：[新建 / �?X 位置添加 / 修改 Y 内容]
- **具体内容**�?  ```
  [要添加或修改的具体文本]
  ```
```

**建议数量**：≤ 3 条。多�?3 条时，按影响范围排序�?Top 3�?
### Step 5: 用户确认

```
以上是本次经验沉淀建议，请选择�?- **全部执行** �?我将依次执行所有建�?- **选择执行** �?告诉我执行哪几条（如"执行 1 �?3"�?- **跳过** �?不执行任何建�?```

### Step 6: 执行更新

用户确认后，使用 `replace_in_file` �?`write_to_file` 执行对应�?Rules/Skills 更新�?
---

## 分级自主权机�?(Tiered Autonomy)
<!-- PURPOSE: Risk-tiered autonomy: LOW (auto-execute appends to safe sections), MEDIUM (suggest + confirm), HIGH (must confirm for new files/global changes). -->

> P1 Enhancement: 并非所有经验沉淀操作的风险等级相同。低风险操作应自动执行以提高效率，高风险操作仍需人工确认�?
### 自主权等级定�?
| 等级 | 操作类型 | 行为 | 示例 |
|------|---------|------|------|
| 🟢 **LOW** (自动执行) | �?*已有** Skill �?Best Practices / Anti-Patterns 追加经验 | 自动执行，在回复末尾告知用户已沉淀 | 追加一�?Best Practice �?`code-review.md` |
| 🟡 **MEDIUM** (建议+确认) | 修改已有 Rule/Skill 的核心内容（Rules、SOP、Checklist�?| 提出具体建议，等待用户确�?| 修改 `troubleshooting.md` �?SOP 步骤 |
| 🔴 **HIGH** (必须确认) | 创建新的 Skill 文件 / 修改全局 standards | 详述方案，必须等用户确认后才执行 | 创建新的 `k8s-ops.md` skill |

### LOW 级操作自动执行条�?
以下条件**必须全部满足**才会自动执行�?
1. **目标 Skill 已存�?*：不新建文件
2. **追加操作**：不修改已有内容，只在现�?section 末尾追加
3. **目标 Section 安全**：仅�?"Best Practices"�?Anti-Patterns"�?Context Hints" 三个 section
4. **来源可靠**：经�?hitCount �?阈值（通过 `_computeEvolutionThreshold` 验证�?5. **去重通过**：通过 `evolve()` 内置�?Capsule Inheritance 去重

### LOW 级操作的输出格式

自动执行后，在回复末尾添加一行简短通知�?
```
�?经验已自动沉淀：[简述内容] �?[目标 Skill] v[新版本]
```

### MEDIUM/HIGH 级操作的输出格式

沿用原有�?"💡 经验沉淀建议" 格式（见上方 Step 4-5）�?
---

## 强制规则
<!-- PURPOSE: Hard rules governing self-refinement behavior: don't interrupt, lightweight suggestions, user confirmation required for MEDIUM/HIGH. -->

| 规则 | 说明 |
|------|------|
| **分级自主�?* | LOW 级操作可自动执行，MEDIUM 建议后确认，HIGH 必须详述方案后确�?|
| **建议优先** | 对于 MEDIUM/HIGH 级操作，不自主执行任�?Rules/Skills 修改，必须经用户确认 |
| **不打�?* | 自动触发时，建议附在回复末尾，不打断当前工作�?|
| **轻量�?* | 自动触发时，建议控制�?3 条以内，每条不超�?5 �?|
| **可追�?* | 每条建议明确标注根因类别、目标文件和自主权等�?|
| **不重�?* | 执行前检索现�?Rules/Skills，避免重复添加相似规则（Capsule Inheritance 去重�?|
| **自动沉淀透明** | LOW 级自动操作必须在回复末尾告知用户，不得静默执�?|

---

## Rules
<!-- PURPOSE: Prescriptive constraints for self-refinement behavior. -->

1. **Never modify Rules or SOP sections without user confirmation** �?LOW-tier auto-execution is limited to Best Practices, Anti-Patterns, and Context Hints. Modifying Rules, SOP, or Checklist sections is MEDIUM risk and requires explicit user approval.

2. **Always cite the specific error instance** �?Every refinement suggestion must reference the exact conversation turn where the error occurred. Vague references like "earlier in the conversation" are not acceptable.

3. **Limit suggestions to 3 per trigger** �?Information overload reduces adoption. If more than 3 refinements are identified, rank by impact and present only the top 3. Mention that additional suggestions are available on request.

4. **Deduplication is mandatory before execution** �?Before adding any new entry to a Skill, search existing entries in the target section for semantic overlap. Use title-level matching and content similarity. Duplicate entries erode trust and bloat context.

5. **Preserve existing content structure** �?When appending to a section, match the existing formatting (numbered list vs bullets, bold title pattern, level of detail). Inconsistent formatting within a section signals poor curation quality.

6. **Tag every refinement with source provenance** �?Each appended entry must include a source tag (e.g., `[Source: user correction, session 2026-03-19]`) in the Evolution History. This enables auditing and rollback.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for executing self-refinement. -->

1. **Phase 1: Error Detection** �?Monitor for user corrections (explicit disagreement, redo requests, "no, do X instead"). Classify the correction: is it a one-off preference or a pattern-level issue? Only pattern-level issues proceed to Phase 2.

2. **Phase 2: Root Cause Diagnosis** �?Apply the 4-category root cause framework (规范缺失 / 知识缺失 / 流程遗漏 / 模式错误). Map the root cause to a specific Skill file and section. If no existing Skill covers this domain, mark as HIGH-risk (new Skill creation).

3. **Phase 3: Knowledge Search** �?Search existing Skills for related entries. Check: (a) is there already a rule that should have prevented this error? (b) is the existing rule ambiguous or incomplete? (c) is this a completely new knowledge gap?

4. **Phase 4: Suggestion Generation** �?Draft the specific text to be added/modified. Include: target file path, target section, operation (append/modify), and exact content. Apply tiered autonomy classification (LOW/MEDIUM/HIGH).

5. **Phase 5: Execution** �?For LOW-risk: auto-execute and notify. For MEDIUM/HIGH: present suggestion with "execute/skip" option. After execution, update Evolution History with version bump and change description.

## Checklist
<!-- PURPOSE: Verification checklist after completing a self-refinement cycle. -->

### Quality
- [ ] Each suggestion has a clear root cause category (not "general improvement")
- [ ] Each suggestion references a specific conversation turn or error instance
- [ ] Content is specific and actionable (not vague platitudes)
- [ ] No duplicate entries created in target Skill

### Process
- [ ] Tiered autonomy correctly classified (LOW/MEDIUM/HIGH)
- [ ] User confirmation obtained for MEDIUM/HIGH operations
- [ ] Evolution History updated with version bump and change summary
- [ ] Source provenance tagged

### Impact
- [ ] The added content would have prevented the original error if it existed beforehand
- [ ] No unintended side effects on other Skill sections

## Best Practices
<!-- PURPOSE: Recommended patterns for effective self-refinement. -->

1. **Batch related refinements into a single version bump** �?If one error reveals 3 related gaps in the same Skill, combine them into one version update rather than 3 separate bumps. This keeps Evolution History clean and atomic.

2. **Prefer strengthening existing rules over adding new ones** �?If an existing rule was "almost right" but too vague, refine it rather than adding a parallel rule. Duplicate rules with slightly different wording create confusion.

3. **Use concrete examples from the actual error** �?Abstract rules are hard to follow. Include a simplified version of the actual mistake as a "Bad example" and the correction as a "Good example". Real examples are more memorable than hypothetical ones.

4. **Review refinements after 1 week** �?Schedule a `/reflect` session to review recent refinements. Some may have been too reactive (based on a one-off situation) and should be softened or removed.

## Gotchas
<!-- PURPOSE: Environment-specific traps for self-refinement. -->

1. **LLM context window limits refinement search scope** �?In long conversations (100+ turns), the LLM may not "see" early corrections when running `/reflect`. Workaround: use explicit conversation bookmarks or run `/reflect` every 30 turns.

2. **Concurrent editing of Skill files** �?If multiple IDE instances or agents are running simultaneously, two may try to modify the same Skill file. The last writer wins, potentially losing the first writer's changes. Workaround: use atomic write (tmp + rename) pattern, which is already implemented in the evolve pipeline.

3. **YAML frontmatter version must match Evolution History** �?If the `version` field in frontmatter says `1.2.0` but Evolution History shows the latest as `v1.1.0`, the skill-loader may behave unpredictably. Always update both atomically.

## Context Hints
<!-- PURPOSE: Background knowledge for self-refinement decision-making. -->

1. **The 80/20 rule applies to error patterns** �?80% of repeated errors come from 20% of knowledge gaps. Focus refinement on the most frequently triggered error patterns rather than trying to capture every edge case.

2. **Self-refinement is a form of continual learning** �?Unlike model fine-tuning, self-refinement operates on the prompt/context layer. It's cheaper, faster, and reversible. But it has a ceiling: once context grows too large, it starts hurting performance. Regularly prune low-value entries.

3. **User corrections have implicit priority** �?If a user explicitly corrects the AI, the correction has higher authority than any existing Skill content. When in doubt, the user's stated preference wins over documented best practices.

---

## 参考资�?
- [典型沉淀场景示例](reference/refinement-examples.md)

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-03-17 | Initial creation with core loop, tiered autonomy, trigger modes |
| v2.0.0 | 2026-03-19 | Skill-enrich-all: added 7 standard sections (Rules, SOP, Checklist, Best Practices, Gotchas, Context Hints) |
| v2.1.0 | 2026-03-26 | Integrated continuous-learning: consolidated session analysis patterns and quality rating framework; continuous-learning.md removed as functionality fully covered |
