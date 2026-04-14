---
name: skill-assistant
version: 1.3.0
description: >
  一站式 Agent Skill 助手：搜索、推荐、安装、创建、质量检查、诊断优化，全生命周期管理。
  整合 5 大平台型技能市场 + GitHub 优质仓库，三引擎安全扫描，跨源去重比较 + 融合推荐，8 维度质检，三维效能诊断。
  Use when：用户提到任何 Skill 平台（skills.sh / Knot / SkillHub / ClawHub / SkillsMP），
  或想对 Agent Skill 进行生命周期操作（发现、评估、获取、创作、审查、优化），
  或不确定是否有现成 Skill 能解决当前问题时。
  触发词：找 skill、搜索 skill、推荐 skill、安装 skill、检查 skill 质量、诊断 skill、
  优化 skill、skill 评分、skill 体检、有没有 skill、有什么好用的 skill、
  推荐适合我的 skill、skill 安全检查、skill 重构、更新 skill、热门 skill、
  最受欢迎的 skill、创建 skill、写 skill、收藏 skill、相似 skill、
  重新配置搜索偏好、reconfigure、配置 skill 源、
  update skills、popular skills、create skill、star skill、
  开启更新检查、关闭更新检查、修改更新频率、检查 skill-assistant 更新。
tags: [skill, search, recommend, install, create, quality, diagnose, security, meta-skill, self-update]
---

# Skill 助手

搜索 · 推荐 · 安装 · 创建 · 检查 · 诊断 — 全生命周期一站式管理。

```
┌─────────┐     ┌──────────────┐     ┌──────────────────────┐
│ 用户意图 │ ──→ │ ⛔ 前置检查   │ ──→ │ 意图路由（6 模块）    │
└─────────┘     │ 1. 首次引导   │     │                      │
                │ 2. 更新检查   │     │ 搜索 → modules/search │
                └──────────────┘     │ 推荐 → modules/recommend│
                                     │ 安装 → modules/install │
       ┌─ config/sources.yaml        │ 创建 → modules/create  │
       │   (偏好 + 凭证)             │ 质检 → modules/inspect │
       │                             │ 诊断 → modules/diagnose│
       ├─ references/ (按需加载)     └──────────────────────┘
       └─ scripts/   (CPU 密集)
```

### 典型交互

> **用户**：帮我找一个生成 PPT 的 skill
> → 前置检查通过 → 四级关键词生成 → 5 渠道宽窄双路并行搜索 → 去重归一化 → 展示 Top 5（按来源分区 + 推荐指数）→ 编号菜单（安装/详情/收藏/重搜）→ 用户选择安装 → 三引擎安全扫描 → 完成

> **用户**：推荐适合我的 skill
> → 扫描已安装 Skill + README + 项目特征 → 用户画像 → 识别能力缺口 → 个性化推荐 2-5 条（标注互补关系）

### 不在范围内

- 非 Agent Skill 的通用包管理（npm / pip / brew 等）
- IDE 插件/扩展的搜索与安装
- 已安装 Skill 的代码级修改（诊断模块只交付建议和重构后的文件，不自动覆盖原文件）

## ⛔ 前置检查（任何操作前必须执行，不可跳过）

读取本 Skill 后，在执行任何用户意图之前，**严格按以下顺序**完成前置检查。
**跳过任何步骤 = 流程错误**。无论用户意图多么明确、多么具体，都必须先通过全部前置检查。

> ⚠️ 跳过前置检查是最常见的执行错误。直接搜索/安装将因缺少 API Token、未选择搜索源等问题导致失败，浪费用户时间。

### 步骤 1：首次使用拦截

**立即**读取 `config/sources.yaml` 的 `preferences.setup_completed` 字段：

- `false` 或不存在 → **停止。不执行任何后续操作。** 转入 [modules/setup.md](modules/setup.md) 完成 4 步引导，完成后回到步骤 2
- `true` → 继续步骤 2

### 步骤 2：自身更新检查

检查 `config/sources.yaml` 中 `preferences.self_update`：

**判断是否需要检查**：
- `enabled: false` 或 `check_frequency: never` → **跳过**，直接路由
- `enabled: true` → 根据 `check_frequency` 和 `last_check_date` 判断：
  - `daily`：`last_check_date` 不是今天 → 执行检查
  - `weekly`：`last_check_date` 距今 ≥ 7 天 → 执行检查
  - 已检查过且未到期 → **跳过**，直接路由

**检查流程**（非阻塞，完成后继续执行用户原始意图）：

1. 获取最新版本信息（逐级降级，上一级失败才尝试下一级）：
   - **第 1 级**：使用 iWiki MCP（如已配置）或 WebFetch 访问更新日志 iwiki（`preferences.self_update.changelog_url`），提取最新版本号和更新内容
   - **第 2 级**（iwiki 获取失败：MCP 未配置 / 地址变更 / 网络问题）：使用 WebFetch 访问 Knot 详情页（`preferences.self_update.knot_url`），从页面提取版本和更新说明
   - **第 3 级**（Knot 页面也失败）：通过 Knot API 搜索并匹配 `id=15780`（⚠️ 必须用 POST + JSON body）：
     ```bash
     curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get" \
       -X POST -H "Content-Type: application/json" \
       -H "x-knot-api-token: ${KNOT_API_TOKEN}" \
       -d '{"keyword":"skill-assistant","category":"","page_num":1,"page_size":5,"order_by":"download_count"}'
     ```
2. 与当前版本（本文件 frontmatter `version`）对比
3. 更新 `last_check_date` 为今天日期（`YYYY-MM-DD`）
4. **有新版本时**，在执行用户原始意图**之前**，向用户展示：

```
📢 Skill Assistant 有新版本可用！

  当前版本：v{current_version}
  最新版本：v{latest_version}（{update_date} 更新）
  更新内容：{changelog_summary}

  Knot 地址：https://knot.woa.com/skills/detail/15780

  → [1] 立即更新（从 Knot 重新安装最新版）
    [2] 稍后再说（继续使用当前版本）
    [3] 修改检查频率（当前：{check_frequency}）
    [4] 关闭更新检查

  当前更新检查配置：✅ 已开启 | 频率：每{frequency_display} | 上次检查：{last_check_date}
```

5. **无新版本时**，静默继续（不打扰用户），直接路由到原始意图
6. 用户选择 [1] 时：通过 knot-cli + API 下载最新版本覆盖安装（需 knot-cli 已安装，参见 `modules/install.md` 方式 4 前置条件）
7. 用户选择 [3] 时：展示频率选项（daily / weekly / never），更新 `config/sources.yaml` 中 `self_update.check_frequency`
8. 用户选择 [4] 时：将 `self_update.enabled` 设为 `false`，提示用户可随时通过"开启更新检查"重新启用
9. 无论用户选择什么，完成后**继续执行原始意图**

**降级策略**：
- iwiki 不可用（MCP 未配置 / 地址变更 / 网络问题）→ 降级到 Knot API
- 全部失败 → 静默跳过，不影响正常功能
- 连续 3 次检查全部失败 → 自动暂停检查，下次用户主动触发时恢复

### 步骤 3：意图路由

根据用户输入分流到对应模块，**严禁跳模块混合执行**。

| 用户意图 | 路由模块 | 参考文件 |
|---------|---------|---------|
| "搜一个 xxx skill" / "find skill for xxx" | **搜索** | [modules/search.md](modules/search.md) |
| "推荐适合我的 skill" / "有什么好用的" | **推荐** | [modules/recommend.md](modules/recommend.md) |
| "安装 xxx" / "帮我装这个 skill" | **安装** | [modules/install.md](modules/install.md) |
| "创建 / 写一个 skill" / "create skill" | **创建** | [modules/create.md](modules/create.md) |
| "检查这个 skill 质量" / "skill 体检" | **质检** | [modules/inspect.md](modules/inspect.md) |
| "诊断 / 优化 / 重构这个 skill" | **诊断** | [modules/diagnose.md](modules/diagnose.md) |
| "推荐一个 xxx skill" | **搜索**（以 xxx 为关键词） | [modules/search.md](modules/search.md) |
| "热门 skill" / "最受欢迎的 skill" | **搜索**（Leaderboard 优先） | [modules/search.md](modules/search.md) |
| "更新 skill" / "检查 skill 新版本" | **安装**（更新流程） | [modules/install.md](modules/install.md) |
| "相似 skill" / "类似 xxx 的 skill" | **搜索**（相似搜索模式） | [modules/search.md](modules/search.md) |
| "收藏 / star 这个 skill" | **推荐**（收藏操作） | [modules/recommend.md](modules/recommend.md) |
| "重新配置搜索偏好" / "reconfigure" | **引导** | [modules/setup.md](modules/setup.md) |
| "开启/关闭更新检查" / "修改更新频率" | **自更新配置**（修改 `self_update`） | `config/sources.yaml` preferences |
| "检查 skill-assistant 更新" | **自更新检查**（立即执行） | 上方「自身更新检查」流程 |
| 搜索无结果时 | 自动降级到**推荐** + 引导**创建** | [modules/recommend.md](modules/recommend.md) |
| 安装前未扫描时 | 自动插入**安装**模块的安全扫描 | [modules/install.md](modules/install.md) |

**复合意图处理**：用户同时提到搜索+安装（"帮我找一个 xxx skill 并装上"），按顺序执行搜索 → 用户确认 → 安装。

**提案式交互**：每次搜索/推荐结果后，必须附带编号式下一步菜单（安装/详情/收藏/重搜）。

---

## 核心原则

### 安全第一

- 所有来源不明的 Skill 安装前必须经过三引擎安全扫描（脚本硬扫描 + skills.sh 三方审计 + AI 软判断）
- 渠道信任等级决定审查深度：高信任可快速通过，低信任必须完整扫描
- 发现 CRITICAL 风险立即中止，HIGH 风险由用户决定
- 检查访问 `MEMORY.md`、`USER.md`、`SOUL.md`、`IDENTITY.md` 等 AI Agent 敏感文件的行为

### 渠道可配置

源分为**平台型技能市场**和**GitHub 优质仓库**两大类，通过 [config/sources.yaml](config/sources.yaml) 统一配置：
- 平台型提供独有质量信号（安装量/评分/认证），仓库型靠 Stars/作者声誉/社区策展
- 用户可在 `preferences` 段自定义安装位置、搜索策略、偏好源、去重策略
- 每个源可独立设置优先级、信任等级、获取方式、启用/禁用
- 用户可添加自有源（公司内部 registry、私有 GitHub 组织等）

### 质量驱动

- 搜索关键词遵循三原则：简单核心词优先 / 先粗后细 / 多意图拆分（防止长查询导致低质量结果）
- 跨平台质量归一化：将各平台不同维度的指标（周安装量/Stars/排名/收录）映射为统一的推荐指数，混合排序
- 跨源去重比较：同一 Skill 出现在多个源时合并展示，功能相似的给出 A/B/融合建议
- 搜索结果必须经过名称验证 + 质量评估才能推荐（防止名不副实）
- 质检模块提供 8 维度 50+ 检查项量化评分（A-F 五级）
- 诊断模块基于"Prompt 效能模型"进行三维分析（指令 40% / 约束 30% / 冗余 30%）

### 渐进式披露（按需加载架构）

- 本文件只做路由和原则声明
- 每个模块的详细工作流在对应的 `modules/*.md` 中
- **搜索模块核心流程 ~420 行**（`modules/search.md`），固定规则拆到 `references/` 按需加载：
  - 评分映射表：`references/scoring-rules.md`
  - 渠道命令模板：`references/channel-search-commands.md`
  - 输出模板：`references/output-templates.md`
- **sources.yaml 选择性读取**：搜索时只读 `preferences:` + `settings:` 段（~70 行），无需加载全文 545 行
- 模板、规则库等低频参考在 `references/` 中
- 自动化逻辑在 `scripts/` 中

### 静默执行

- 搜索/安装命令由 Agent 直接执行，不向用户展示原始命令
- 用编号式菜单和自然语言提案代替命令行展示

### 幂等性

- 除 `last_check_date` 写入外，所有读操作幂等——重复执行不产生副作用
- 搜索、质检、诊断报告阶段均为只读操作
- 安装操作通过 `--force` 参数控制覆盖行为，默认检测已安装不重复安装

### 常见错误（NEVER）

- **NEVER 跳过前置检查直接搜索/安装** — API Token 未加载会导致全部需认证渠道失败，浪费用户时间
- **NEVER 用 `npx skills add` 安装** — 侵入性强，会写 `skills-lock.json` + `~/.agents/`，统一用 `install_skill.sh`
- **NEVER 跳模块混合执行** — 模块间有数据依赖（如搜索结果 → 安装输入），混合执行破坏流程完整性
- **NEVER 在多平台搜索时只发窄路不发宽路** — 窄路用复合关键词在部分平台（特别是 Knot 中文平台）可能全部返空，宽路是召回率的基础保障
- **NEVER 对中文平台只用英文关键词** — Knot 等中文平台的内容以中文为主，纯英文复合词无法匹配，必须同时生成中文变体关键词
- **NEVER 在 Knot API 中用 URL query params 传参** — 虽然不报错，但只返回近期上架的子集（ID ≥ 13000），丢失所有早期高质量 Skill，必须用 POST + JSON body

---

## 模块概览

### 引导模块 — `modules/setup.md`

首次使用引导（`setup_completed: false` 时强制触发），4 步完成：
1. **搜索源选择**：平台 + GitHub 仓库一步完成（ClawHub/SkillHub 二选一，支持 `+owner/repo` 自定义）
2. **环境检查**：逐平台检测前置条件 + 安装引导 + API Key 持久化
3. **搜索策略选择**：speed（快速）/ balanced（均衡，推荐）/ thorough（全面）
4. **配置摘要**：汇总写入 sources.yaml
用户说"重新配置搜索偏好"可随时重新进入。

### 搜索模块 — `modules/search.md`

**宽窄双路搜索**：每个源同时发起宽路（1 核心词 → 30 条）+ 窄路（精确词 → 10 条），合并后筛选最匹配的结果。
**多路并行**：平台型 + GitHub 优质仓库（`gh` 跨仓库合并搜索，3 种关键词模板）+ 通用搜索，全部并行执行。
**三路搜索**：第 1 路多平台（skills.sh / SkillsMP / SkillHub / Knot）+ 第 2 路优质仓库（gh 跨仓库搜索）+ 第 3 路全 GitHub（可选返回非 Skill 源辅助转化）。
**跨源去重比较**：同源合并 + 相似 Skill 对比 + 融合推荐（使用 A / 使用 B / 融合 A+B）。
**跨平台质量归一化**：三维评分模型（热度 40% + 权威 35% + 鲜度 25%），统一推荐指数（0-5）。
**混合相关度评分**：关键词命中分（50%）+ 语义匹配分（50%），四级置信度标记（🎯 精确 / ✅ 高相关 / ⚠️ 待确认 / ❓ 弱相关）。
**已安装 Skill 语义索引**：搜索前读取已安装 Skill 的 description，混合评分判断功能重叠度，输出对比和决策建议。
含名称验证、`_skill_meta.json` 版本检测、多来源加分。

### 推荐模块 — `modules/recommend.md`

基于多信号用户画像的智能推荐：扫描已安装 Skill + 收藏列表 + 工作区特征 + README 业务定位 + AI 记忆/历史 → 角色快查表 → 识别缺口 → 个性化推荐。
**业务价值优先**：优先推荐能直接为业务创造价值的 Skill，而非只推荐研发基建类。
**互补关系说明**：每条推荐明确标注与已有 Skill 的互补/增强/延伸关系。
含收藏/Star 管理系统。

### 安装模块 — `modules/install.md`

统一安装入口 + 安装位置智能感知（默认与 skill-assistant 同级，全局需明确 IDE）+ 三引擎安全审查（13 项脚本硬扫描 + skills.sh audit API 三方参考 + AI 权限/注入/匹配度软判断）。
`install_skill.sh` v2 含名称清理（sanitizeName）、路径安全校验（isPathSafe）、已安装覆盖检测（`--force`）。
安装后自动生成 `_skill_meta.json`（来源、版本、commitHash、folderHash、localHash、安全扫描结果），与平台自带的 `_meta.json` 共存不冲突。
更新检测双精度：folderHash（目录级 SHA）> commitHash（仓库级）。私有仓库自动跳过 telemetry。
skills.sh 统一用 `install_skill.sh` 安装（禁止 `npx skills add`）。含基于 `_skill_meta.json` 的更新检查和批量更新。

### 创建模块 — `modules/create.md`

Skill 创建全流程指南：200 行规则 → 三层加载系统 → 自由度设定 → 命名规范 → Eval 驱动开发。
含创建最佳实践 [references/create-best-practices.md](references/create-best-practices.md)。

### 质检模块 — `modules/inspect.md`

8 维度质量检查（对齐 OWASP LLM Top 10）：
D1 元数据 → D2 概述 → D3 流程 → D4 I/O → D5 风险分级 → D6 工程 → D7 可维护性 → D8 安全审计。
输出 A-F 评分 + 逐条改进建议。支持单文件和批量巡检。

### 诊断模块 — `modules/diagnose.md`

基于 Prompt 效能模型的三维诊断：
- **指令** (Directive, 40%)：驱动 LLM 做对事的 Token
- **约束** (Constraint, 30%)：防止 LLM 犯错的 Token
- **冗余** (Redundancy, 30%)：对任务无贡献的 Token

三步交互：诊断报告 → 逻辑蓝图 → 最终交付。含帕累托收敛判定，避免过度优化。

---

## 降级规则

| 异常情况 | 降级策略 |
|---------|---------|
| CLI 不可用（无 Node.js） | skills.sh 搜索降级为 curl API（同一端点），安装统一用 `install_skill.sh`（禁止 `npx skills add`），其余 CLI 渠道跳过并标注 |
| ClawHub 版本不兼容 | 跳过，标注不可用 |
| gh CLI 未安装或未认证 | **强烈引导安装 gh**；降级为全网搜索（精度显著降低） |
| GitHub 搜索全部无结果 | 扩展关键词（同义词），最多重试一次 |
| 深度抓取失败/超时 | 跳过，基于已有摘要分类 |
| 安全扫描脚本不可用 | 跳过硬扫描，仅执行 AI 软判断 |
| 全部搜索均无结果 | 自动切到智能推荐 + 引导创建模块；浏览 https://skills.sh |
| config/sources.yaml 不存在 | 使用内置默认渠道配置 |
| skills.sh API 超时 | CLI 和 API 是同一端点，一个超时另一个也不行；跳过 skills.sh，继续其他渠道 |
| 自定义渠道响应异常 | 跳过该渠道，标注原因，继续其他渠道 |

---

## 参考资料

- 渠道详情：[references/channels.md](references/channels.md)
- 安全规则（三引擎）：[references/security-rules.md](references/security-rules.md)
- 搜索词模板：[references/search-templates.md](references/search-templates.md)
- 推荐策略模板：[references/recommend-templates.md](references/recommend-templates.md)
- 质检维度详情：[references/quality-dimensions.md](references/quality-dimensions.md)
- 诊断校准参考：[references/diagnosis-calibration.md](references/diagnosis-calibration.md)
- 创建最佳实践：[references/create-best-practices.md](references/create-best-practices.md)
- 评分归一化映射表：[references/scoring-rules.md](references/scoring-rules.md)
- 渠道搜索命令模板：[references/channel-search-commands.md](references/channel-search-commands.md)
- 搜索输出模板：[references/output-templates.md](references/output-templates.md)
- 渠道配置：[config/sources.yaml](config/sources.yaml)
- 浏览所有 skills：https://skills.sh
