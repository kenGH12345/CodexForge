# 诊断模块

基于 Prompt 效能模型 + 知识增量分析对已有 Skill 进行诊断与重构。

> **核心理念**：Skill 是 LLM 的运行时上下文注入。评估 Skill 不看结构是否"干净"，而看注入后 LLM 的任务完成质量是否提升。每个 Token 都参与 LLM 每一步推理的注意力计算。
>

---

## Skill 类型谱系

诊断前必须先识别目标 Skill 的类型——不同类型适用不同诊断权重：

| 类型 | 特征 | 核心价值在 | 示例 |
|------|------|-----------|------|
| **执行型** | 输入 → 确定性操作 → 输出 | Script | pdf-editor, image-rotator |
| **流程型** | 多步骤、有分支的工作流 | Script + Prompt | deploy-tool, ci-pipeline |
| **规范型** | 标准、约束、质量要求 | Prompt + Reference | code-style, brand-guide |
| **认知型** | 设计哲学、领域知识 | Prompt | skill-creator, architecture-guide |

从左到右，Prompt 中的内容从"可下沉的逻辑"过渡为"不可替代的知识注入"。

---

## 三维诊断框架

### 1. 指令 (Directive) — 权重 40%

驱动 LLM 做对事的 Token。三种来源：

| 来源 | 机制 | 示例 |
|------|------|------|
| **激活** (Activate) | 触发 LLM 已有但默认不用的能力 | "使用祈使句"——LLM 会，但不提醒就不做 |
| **注入** (Inject) | 注入训练数据中不存在的知识 | 公司内部 API Schema、私有业务规则 |
| **锚定** (Anchor) | 在长上下文中维持注意力焦点 | 核心原则的反复呼应 |

**缺指令 = Skill 加载后 LLM 行为几乎没变化。这是最严重的问题。**

### 2. 约束 (Constraint) — 权重 30%

防止 LLM 犯错的 Token。检查要点：常见错误/反模式禁止、边界条件覆盖、渐进式披露（发现层/激活层/执行层内容是否各归其位）。

**缺约束 = LLM 会犯 Skill 设计者已知但未声明的错误。**

### 3. 冗余 (Redundancy) — 权重 30%

对任务无贡献的 Token（类似死代码）。使用**知识三分法**精确分类每段内容：

| 类别 | 定义 | 处理 |
|------|------|------|
| **Expert（专家知识）** | LLM 真的不知道的领域知识 | 必须保留——Skill 的核心价值 |
| **Activation（激活知识）** | LLM 知道但可能想不到的 | 简短保留——起提醒作用 |
| **Redundant（冗余知识）** | LLM 肯定知道的基础内容 | 应删除——浪费上下文窗口 |

**冗余的典型来源**：
- 角色扮演（"你是一个专业的..."）
- 与 scripts/ 重复的逻辑
- LLM 已具备的常识和标准教程
- SKILL.md 与 references/ 的内容重叠
- 行业标准术语的定义

**SKILL.md body Token > 6000 时，低频内容必须拆分到 references/**。

**关键区分**：看起来像冗余但实际在构建指令的 Token（如认知型 Skill 的背景知识注入），不是冗余。判断标准：删掉后 LLM 的任务表现是否下降？

**知识比例基准**：
- 优秀 Skill：Expert 70%+ / Activation < 20% / Redundant < 10%
- 合格 Skill：Expert 40-70% / Activation < 30% / Redundant < 30%
- 劣质 Skill：Expert < 40% / Redundant > 40%

### 效能分计算

```
效能分 = 指令评级 × 40 + 约束评级 × 30 + (1 - 冗余率) × 30
```

| 分数区间 | 等级 | 含义 |
|----------|------|------|
| 85-100 | A | 优秀 |
| 70-84 | B | 良好，可选择性优化 |
| 50-69 | C | 需要重构 |
| 30-49 | D | 急需重构 |
| 0-29 | F | 建议重写 |

---

## 交互流程（严禁跳步）

### Step 1：诊断报告

1. 运行结构探测脚本获取事实数据：
   ```bash
   python3 scripts/diagnose_skill.py <target-skill-directory>
   ```
   用户提供文本片段而非目录路径时，跳过脚本执行。

2. 阅读目标 Skill 完整内容，参阅 [references/diagnosis-calibration.md](../references/diagnosis-calibration.md) 中的评分校准表和 Token 分类示例，完成三维语义评估。

3. 输出诊断报告（模板见 [assets/diagnosis-report-template.md](../assets/diagnosis-report-template.md)），保存到 `.skill-doctor/{skill-name}/diagnosis-report.md`。报告须包含：
   - 知识比例分析：Expert / Activation / Redundant 各占百分比
   - 病症检测：对照常见病症库标注命中项
   - 三维评分：指令 / 约束 / 冗余 各维度评级

4. **帕累托收敛判定**：效能分 ≥ 80 且三个维度均不低于"中" → 已收敛。
   - 已收敛：输出帕累托分析，说明每个优化建议的代价，流程结束。
   - 未收敛：正常进入 Step 2。

5. **STOP**：等待用户确认。

### Step 2：逻辑蓝图

用户确认 Step 1 后：

1. 参照 [assets/logic-blueprint-template.md](../assets/logic-blueprint-template.md) 模板格式，输出重构蓝图。

2. 核心不是"把东西从 Prompt 移到 Script"，而是**让每个 Token 在最适合它的层工作**：
   - LLM 擅长 → Prompt（意图理解、知识框架、设计哲学）
   - CPU 擅长 → Script（确定性计算、格式转换、正则匹配）

3. **STOP**：等待用户确认。

### Step 3：最终交付

用户确认 Step 2 后，生成：
1. 优化后的 SKILL.md（指令和约束增强，冗余移除）
2. 脚本文件（`scripts/`）
3. 参考文档（`references/`，如需要）

---

## 常见病症库（9 种失败模式）

诊断时对照以下常见病症，快速定位问题根因：

| 病症 | 症状 | 根因 | 处方 |
|------|------|------|------|
| **教程病** | 解释 LLM 已知的基础概念 | 误把 Skill 当教学，Expert 知识 < 30% | 删除所有基础解释，只保留专家知识增量 |
| **堆砌病** | SKILL.md 800+ 行无拆分 | 缺乏渐进式披露设计 | body 保留路由和决策树（≤ 300 行），详情移入 references/ |
| **孤儿引用** | references/ 存在但从未被加载 | 缺加载触发器 | 在工作流决策点添加 "MANDATORY — READ ENTIRE FILE" |
| **清单流程** | Step 1/2/3 纯机械步骤 | 缺思维框架，只有操作没有思考 | 转化为 "Before doing X, ask yourself..." 框架 |
| **模糊警告** | "注意错误""小心边界" | 反模式不具体，缺踩坑经验 | 替换为具体 NEVER 列表 + WHY |
| **隐身病** | 内容好但从不被激活 | description 差，缺 WHEN 和关键词 | 重写 description：WHAT + WHEN + KEYWORDS |
| **错位触发** | "When to use" 写在 body | 误解三层加载系统 | 移到 description 中 |
| **过度工程** | README/CHANGELOG/CONTRIBUTING 齐全 | 把 Skill 当软件项目 | 删除所有 Agent 不需要的文件 |
| **自由度错配** | 创意任务用死板脚本 | 未校准任务风险 | 创意→原则框架，脆弱→精确脚本 |

---

## 诊断反模式

- **安全评分陷阱**：给所有 Skill 默认 60-70 分。应严格评分，敢于给高分或低分
- **误判知识注入**：把认知型 Skill 的背景知识当冗余删掉（用知识三分法区分 Expert vs Redundant）
- **越步执行**：在 Step 1 就给出具体重构代码
- **忽视重叠**：不检查 SKILL.md 与 references/ 的内容重复
- **单维偏见**：只关注冗余消减而忽略指令和约束
- **强行优化陷阱**：对已收敛的 Skill 仍进入 Step 2/3

**优化优先级**：指令不足 > 约束不足 > 冗余过多
