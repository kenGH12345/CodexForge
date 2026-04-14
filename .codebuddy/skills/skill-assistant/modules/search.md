# 搜索模块

多源分类搜索 Skill：本地索引 → 平台型技能市场 + GitHub 优质仓库 → 通用搜索 → 去重比较推荐。

> 评分映射表/输出模板/渠道命令等**固定规则**已拆到 `references/` 按需加载，搜索时只需读本文件。
> 配置读取：只需读 sources.yaml 的 `preferences:` 段（~60 行）和 `settings:` 段（~10 行），无需加载全文。

> **源分类**（详见 [config/sources.yaml](../config/sources.yaml)）：
>
> | 类别 | 定位 | 代表 |
> |------|------|------|
> | **平台型技能市场** | 收录第三方来源的 Skill，提供独有质量信号 | skills.sh、SkillsMP、ClawHub、Knot、SkillHub |
> | **GitHub 优质仓库** | 高质量 Skill 源码或策展索引 | anthropics/skills、awesome-openclaw、awesome-claude-skills、obra/superpowers |
> | **通用搜索** | 兜底，覆盖所有 GitHub 公开仓库 | GitHub code search |

## 核心规则

- **全阶段执行**：不因前一阶段有结果就跳过后续，确保覆盖面
- **去重比较**：同一 GitHub 仓库出现在多个源时，合并展示并标注各源质量信号，给出比较建议
- **按来源分区输出**：平台型 / GitHub 仓库 / 通用搜索各自成区，无结果的分区用斜体标注
- **关键词三原则**：简单核心词优先、先粗后细、多意图必须拆分（详见 [references/search-templates.md](../references/search-templates.md)）
- **已安装标记**：搜索前扫描已安装目录 + 读取 `_skill_meta.json`，结果中已安装的标注 `✅ 已安装`
- **标签过滤**：用户输入含 `#tag` 格式时（如 `#azure #testing`），按标签匹配
- **名称验证**：搜索返回结果后，读取 description 验证与用户需求是否匹配，标注不过滤
- **静默执行**：搜索命令由 Agent 执行，不向用户展示原始命令
- 源优先级和启用状态读取 [config/sources.yaml](../config/sources.yaml) 的 `preferences:` 段，未配置时用内置默认值
- **用户偏好**：`search_strategy`、`dedup_strategy`、`prefer_channels` 优先于默认行为

---

## 第 0 步：扫描已安装 Skill + 语义索引

搜索前先获取已安装列表（覆盖项目级 + 全局级所有路径），用于后续标记、去重和已安装能力对比：

```bash
echo "=== project .cursor ===" && ls -1 .cursor/skills/ 2>/dev/null
echo "=== project .agents ===" && ls -1 .agents/skills/ 2>/dev/null
echo "=== global ~/.cursor ===" && ls -1 ~/.cursor/skills/ 2>/dev/null
echo "=== global ~/.agents ===" && ls -1 ~/.agents/skills/ 2>/dev/null
```

### 已安装 Skill 语义匹配

扫描到已安装 Skill 后，读取其 SKILL.md 的 `description` 和 `tags`，构建**语义匹配信号**用于 Step 5b 的「已安装 Skill 能力对比」：

```bash
for skill_dir in .cursor/skills/*/; do
  head -10 "$skill_dir/SKILL.md" 2>/dev/null
done
```

匹配方式采用**混合评分**（Hybrid Score）：

| 评分维度 | 权重 | 说明 |
|---------|------|------|
| **关键词匹配** (BM25) | 50% | 搜索关键词在已安装 Skill 的 description/tags 中的出现频率 |
| **语义相似度** | 50% | 搜索需求与已安装 Skill 描述的概念相似度（由 Agent 判断） |

**置信度分级**（替代二元匹配/不匹配）：

| 混合得分 | 置信度 | 处理 |
|---------|--------|------|
| ≥ 0.7 | **高** — 功能高度重叠 | 已安装 Skill 大概率可满足需求，在 Step 5b 中重点对比 |
| 0.4-0.7 | **中** — 部分相关 | 已安装 Skill 覆盖部分能力，在 Step 5b 中标注差异 |
| < 0.4 | **低** — 关联弱 | 跳过对比，不在输出中展示 |

> **设计理念**（来自 fitcheck-skill-search）：混合评分兼顾精确性和召回率——避免关键词匹配但语义不相关，也避免语义相关但关键词不同。

## 第 0.5 步：API Key 可用性检查

搜索前检查需要认证的渠道是否已配置 API Key。

### Key 解析优先级

```
1. config/.credentials.yaml 凭证文件（持久化，跨会话生效，优先级最高）
2. sources.yaml 中的 auth.api_key 字段（兼容旧配置）
3. auth.env_var 指定的环境变量（会话级，进程结束即丢失）
4. 用户在当前对话中直接提供的 Key（临时，建议立即持久化）
```

检查流程：先读取凭证文件，再检查环境变量。

```bash
CRED_FILE="{SKILL_ASSISTANT_ROOT}/config/.credentials.yaml"

python3 -c "
import yaml, os
cred_file = os.path.expanduser('$CRED_FILE')
keys = {}
try:
    with open(cred_file) as f:
        creds = yaml.safe_load(f) or {}
    keys['skillsmp'] = creds.get('skillsmp', {}).get('api_key', '')
    keys['knot'] = creds.get('knot', {}).get('api_token', '')
except FileNotFoundError:
    pass

import os
if not keys.get('skillsmp'):
    keys['skillsmp'] = os.environ.get('SKILLSMP_API_KEY', '')
if not keys.get('knot'):
    keys['knot'] = os.environ.get('KNOT_API_TOKEN', '')

for name, val in keys.items():
    status = '✅ 已配置' if val else '❌ 未配置'
    print(f'{name}: {status}')
" 2>/dev/null
```

### 处理策略

| 情况 | 处理 |
|------|------|
| 凭证文件中有 Key | 直接使用（最安全、最可靠） |
| 凭证文件无，`auth.api_key` 非空 | 使用 sources.yaml 中的 Key |
| 前两者都无，环境变量已配置 | 使用环境变量中的 Key |
| 前三者都无，用户在对话中提供 | 使用并**立即写入凭证文件**持久化 |
| 均无 Key | **不阻断搜索**，该渠道跳过，搜索结束后提示配置 |

### API 请求失败处理

按 HTTP 状态码精确说明（302=内网拦截非 Token 无效，401=认证失败）。详细状态码表见 [references/channel-search-commands.md#api-请求失败处理](../references/channel-search-commands.md#api-请求失败处理)。

**用户临时提供 Key 时**：立即写入 `config/.credentials.yaml` 持久化，禁止仅 `export`。

**缺失 Key** — 不阻断搜索，跳过该渠道，搜索结束后统一提示配置（同一会话只提示一次）。提示模板见 [references/channel-search-commands.md#缺失-key-提示模板](../references/channel-search-commands.md#缺失-key-提示模板)。

## 第 1 步：理解需求

1. **领域**：React、测试、设计、部署、安全…
2. **具体任务**：写测试、生成 PPT、审查 PR…
3. **用途**：直接使用 or 参考学习
4. **标签**：用户提供 `#tag` 时优先按标签搜索

**精确名称信号**：用户说"这个 skill"、"叫 xxx 的"、提供了含连字符的名称 → 直接用名称搜索。

## 第 2 步：四级关键词 + 多路并行搜索

**核心策略**：通过四级关键词生成覆盖不同表达方式，每个搜索源发起宽路 + 多组窄路搜索，合并后通过漏斗式筛选输出精选结果。

### 2.1 四级关键词生成

详细规则见 [references/search-templates.md](../references/search-templates.md)，此处为执行摘要。

**生成流程**：

```
用户输入 → Level 1 语义核心提取（2-4 个概念词）
         → Level 2 主关键词组（2-3 组窄路，每组 2 词）
         → Level 3 宽路关键词（1 个最短核心词）
         → Level 4 扩展词（仅结果不足时触发）
```

| 层级 | 关键词规则 | 搜索量 | 目的 |
|------|-----------|--------|------|
| **Level 3 宽路** | 1 个最短核心词 | API limit=30 | 最大召回，撒大网 |
| **Level 2 组 A** | 精确匹配词组 | limit=10 | 命中高安装量结果 |
| **Level 2 组 B** | 近义替代词组 | limit=10 | 覆盖不同命名风格 |
| **Level 2 组 C** | 相关概念词组 | limit=5 | 捕捉意外好结果 |
| **Level 4 扩展** | 缩写/别名/工具名 | limit=5 | 仅 Level 2-3 总数 < 5 时触发 |

> **示例**：用户要"自动生成 PPT"
> - Level 1 核心：presentation + pptx + slides + generate
> - Level 2 组 A：`pptx presentation`（精确→命中 7,979 安装量头部 Skill）
> - Level 2 组 B：`presentation builder`（近义→命中 4,145 安装量 Skill）
> - Level 2 组 C：`markdown slides`（相关→命中专用 Skill）
> - Level 3 宽路：`presentation`（召回 30 条候选）
>
> **多意图场景**（用户要"查找、审查、创建 skill 的 skill"）：
> - 拆分为独立意图，每个意图各自生成四级关键词
> - **禁止合并为** `skill finder audit create` 这样的长查询

### 2.2 三路并行架构

所有搜索**同时发起**，不等前一个完成：

```
┌──────────────────── 并行执行 ─────────────────────┐
│                                                    │
│  ┌─ 第 1 路：多平台搜索 ───────────────────────┐  │
│  │  skills.sh / SkillHub / SkillsMP / Knot      │  │
│  │  ⚡ 各平台独立 CLI/API，无额外依赖           │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌─ 第 2 路：优质仓库搜索 ─────────────────────┐  │
│  │  gh search code 跨仓库合并搜索               │  │
│  │  ⚡ 强依赖 gh CLI，无 gh 降级为全网搜索      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌─ 第 3 路：全 GitHub 搜索 ───────────────────┐  │
│  │  gh search code 全公开仓库                   │  │
│  │  ⚡ 强依赖 gh CLI，无 gh 降级为全网搜索      │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
└────────────────────────────────────────────────────┘
         │
         ▼
   合并 → 去重 → 相关度评分 → 质量归一化 → 输出 Top N
```

**gh CLI 是第 2、3 路的核心依赖**。搜索前检查：

```bash
which gh && gh auth status
```

| gh 状态 | 处理 |
|---------|------|
| 已安装 + 已认证 | ✅ 正常执行第 2、3 路 |
| 已安装 + 未认证 | ⚠️ 提示 `gh auth login`，本次降级为全网搜索 |
| 未安装 | ⚠️ **强烈引导安装**（macOS: `brew install gh && gh auth login`），本次降级为全网搜索 |

### 2.3 平台型搜索（并行）

每个平台同时发起宽路和窄路搜索。各平台的命令模板、认证方式、响应字段见 [references/channel-search-commands.md](../references/channel-search-commands.md)。

> ⚠️ **MUST**：**每个已启用平台都必须同时执行宽路（Level 3）和窄路（Level 2）搜索**。只发窄路不发宽路是已知的搜索遗漏根因——窄路用复合关键词在部分平台可能全部返空，宽路是召回率的基础保障。

**执行摘要**：

| 平台 | 宽路（MUST） | 窄路 | 关键参数 | 无依赖时 |
|------|------|------|---------|---------|
| skills.sh | curl API, limit=30, 按 installs 排序 | CLI `npx skills find`, 5 条 | 无需认证 | curl 兜底 |
| SkillHub | `skillhub search`, 前 20 | `skillhub search`, 前 5 | 无需认证 | 跳过 |
| SkillsMP | REST API, limit=20, sortBy=stars | REST API, limit=5 | API Key | 跳过 |
| Knot | POST API, **page_size=30, order_by=download_count** | POST API, page_size=10, category=official | Token + 内网 | 跳过 |

> **Knot 关键点**：`order_by: "download_count"` 必填（不传则按上传时间倒序），复合关键词返回空时自动拆词，`#tag` 格式先调 `get_skill_tags` 匹配 ID。

### 2.3.1 中文平台关键词适配（MUST）

Knot 等中文平台的 Skill 名称和描述以中文为主。**纯英文复合关键词（如 `"skill search"`）在中文平台可能完全无法匹配**，导致高下载量的中文 Skill 被遗漏。

**强制规则**：
1. **Level 1 语义核心提取时，必须同时保留中英文词**。用户输入「帮我找能搜索 skill 的 skill」→ 核心词应为 `skill, search, 搜索, 查找`
2. **Level 3 宽路对 Knot 必须包含中文变体**。如用户输入含中文，英文宽路 `"skill"` 之外还应加中文宽路 `"搜索"` / `"推荐"` 等
3. **Level 2 窄路对 Knot 生成中英文双组**。英文 `"skill search"` + 中文 `"skill 搜索"`

| 用户输入语言 | 英文平台（skills.sh/GitHub） | 中文平台（Knot） |
|-------------|---------------------------|-----------------|
| 纯英文 | 英文关键词 | 英文关键词（Knot 也收录英文 Skill） |
| 含中文 | 提取英文等价词 | **中英文双语关键词（MUST）** |
| 纯中文 | 翻译为英文 | **原始中文 + 英文翻译** |

### 2.4-2.5 GitHub 搜索（并行）

命令模板见 [references/channel-search-commands.md#github-优质仓库搜索](../references/channel-search-commands.md#github-优质仓库搜索)。

**执行摘要**：
- **第 2 路**：`gh search code` 跨 4 仓库 × 3 模板（核心词 SKILL.md / 精确词 SKILL.md / 核心词 README.md）
- **第 3 路**：`gh search code` 全公开 SKILL.md + `gh search repos` 高 Stars
- **gh 不可用**：降级为全网搜索
- **`anthropics/skills` 结果可直接信任**（🏢 官方）

### 2.6 搜索策略与覆盖规则

读取 `preferences.search_strategy`（用户在首次引导中选择），决定搜索范围和深度：

| 策略 | 平台 | 仓库 | 全 GitHub | 关键词 | 每渠道 Top N |
|------|------|------|-----------|--------|:-----------:|
| **speed** | skills.sh + SkillHub | gh 模板 A | 跳过 | L3 + L2-A | 2 |
| **balanced**（默认） | 所有已启用 | gh 3 模板 | code + repos | L2 全部 + L3 | 3 |
| **thorough** | 所有平台 | 全模板 + curl README | 含非 Skill 源 | 全部 + L4 | 5 |

> speed 结果 < 5 时自动升级为 balanced；balanced 结果 < 5 时追加全网搜索；thorough 强制追加 2 条全网搜索。

策略完整定义见 [references/channel-search-commands.md#搜索策略完整定义](../references/channel-search-commands.md#搜索策略完整定义)。

### 2.7 漏斗式合并与筛选

所有平台和仓库的搜索结果通过三级漏斗筛选，从 100+ 条候选收敛到 5-10 条精选：

```
┌─ 搜索阶段（多搜）─────────────────────────────────────────┐
│  Level 3 宽路（各平台 limit=30）                           │
│  Level 2 窄路 A/B/C（各 limit=5-10）                      │
│  Level 4 扩展（仅不足时，limit=5）                         │
│  → 合计 100+ 条候选                                       │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌─ 漏斗 1：去重合并 ────────────┼─────────────────────────────┐
│  同 owner/repo + skill_name → 合并为一条，保留所有源信号     │
│  同名不同 repo → 各自保留，标注差异                         │
│  → 去重后约 40-60 条                                       │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌─ 漏斗 2：混合相关度评分 ──────┼─────────────────────────────┐
│  混合分 = 关键词命中(50%) + 语义匹配(50%)                  │
│  ≥4.5 🎯 精确匹配 | 3.0-4.4 ✅ 高相关                     │
│  1.5-2.9 ⚠️ 待确认 | <1.5 ❓ 弱相关                       │
│  → 按混合相关度排序，取 Top 15-20                          │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌─ 漏斗 3：质量归一化 + 精选 ───┼─────────────────────────────┐
│  推荐指数 = 热度×0.4 + 权威×0.35 + 鲜度×0.25               │
│  多来源加分（2 源+0.3，3+ 源+0.5）                         │
│  → 按 相关度 + 推荐指数 排序，取 Top 3-5 / 每渠道          │
└───────────────────────────────┬─────────────────────────────┘
                                │
                    最终输出 5-10 条精选 + 跨源比较
```

**去重规则**：
- 同一 `owner/repo + skill_name` 来自多个平台 → 合并为一条，标注所有来源（多源交叉 = 质量加分）
- 同名不同 repo → 各自保留，标注差异

**相关度评分（混合增强）**：

```
混合相关度 = 关键词命中分 × 0.5 + 语义匹配分 × 0.5
```

| 维度 | 评分规则 | 分值 |
|------|---------|------|
| **关键词命中**（50%） | 多组窄路同时命中（A+B 或 A+C） | +3 |
| | 单组窄路命中 | +2 |
| | 宽路命中 + description 含关键词 | +1 |
| | 仅宽路命中 description 不含关键词 | +0 |
| **语义匹配**（50%） | description 与用户需求**语义高度一致** | +3 |
| | description 与用户需求**部分相关** | +1.5 |
| | description 与用户需求**语义不相关** | +0 |

> **语义匹配判断**：由 Agent 阅读 description，判断与用户需求的概念相似度。不依赖关键词是否出现——如搜"数据可视化"，description 说"chart generation and dashboard building"语义高度一致，应给 +3。

**置信度标记**：🎯 ≥4.5 精确匹配 | ✅ 3.0-4.4 高相关 | ⚠️ 1.5-2.9 待确认 | ❓ <1.5 弱相关

**最终输出**：按 `混合相关度 + 推荐指数` 综合排序，每渠道取 Top 3-5 条。

## 第 3 步：名称验证（标注不过滤）

合并结果后，对每个 Skill **读取 description**，确认功能与用户需求的匹配度：

- description 完全匹配 → 正常展示
- description 部分匹配或不确定 → **展示，但标注 `⚠️ 待确认`**
- description 与需求完全无关 → **展示在末尾，标注 `❓ 可能不匹配`**
- description 不可读取时 → 正常展示

> **核心原则：标注而不过滤** — Agent 可能误判，由用户自行判断。

## 第 4 步：深度抓取（按需）

从 Step 2 结果中选择 1-3 个高价值但信息不足的 Skill，用 `curl` 抓取 raw.githubusercontent.com 上的 SKILL.md 补充详情：

优先顺序：含 SKILL.md 的仓库 > 高 Stars 仓库 > awesome- 合集。

**Skill 判断标准**（满足任一即为 Skill）：
- 仓库包含 SKILL.md 文件
- 路径含 `.cursor/skills/`、`.claude/skills/`、`.agents/skills/` 等目录结构
- 在 skills.sh 索引中
- README 明确说明是 "Agent Skill"

不满足以上条件的归类为"相关开源项目"。

## 第 5 步：跨平台质量归一化评估

**推荐指数** = 热度 × 0.4 + 权威 × 0.35 + 鲜度 × 0.25（每维 0-5 分）

各平台的热度/权威/鲜度归一化映射表见 [references/scoring-rules.md](../references/scoring-rules.md)。

**速查**：🔥🔥🔥 ≥4.0 强烈推荐 | 🔥🔥 3.0-3.9 推荐 | 🔥 2.0-2.9 可用 | <2.0 仅展示
**多来源加分**：2 渠道 +0.3 / 3+ 渠道 +0.5
**同分排序**：官方 > 精选 > 社区 → 安装量高 → 更新近

## 第 5b 步：去重与跨源比较

### 去重规则

当多个源返回同一 Skill 时，需合并去重：

**同源判定**（满足任一即为同一 Skill）：
- `source.repo` + `source.path` 完全相同
- skills.sh 的 `id` 格式为 `{owner}/{repo}@{skillId}`，与 GitHub 搜索结果的 `repo + path` 可直接匹配

**去重策略**：
1. 合并为一条，标注所有发现该 Skill 的渠道
2. 各渠道的质量信号全部保留展示
3. 按 `dedup_strategy.prefer_channels` 决定主展示渠道

### 跨源比较

功能相似但来源不同的 Skill，自动进行比较（模板见 [references/output-templates.md#跨源比较表](../references/output-templates.md#跨源比较表)）。

**相似判定**：同名不同仓库 / 描述高度相似（>70%）/ 同领域替代方案。
> 跨源比较表只做客观陈述，不给建议。建议统一在推荐方案中给出。

### 已安装 Skill 的 `_skill_meta.json` 检查

搜索结果中如果某个 Skill 已安装且有 `_skill_meta.json`：读取 `commitHash` → 与远程比对 → 有新版标注 `🔄 有更新`。

### 已安装 Skill 的能力对比与决策

Step 0 扫描到的已安装 Skill 中，如果有与搜索需求**功能重叠**的，必须对比并给出决策建议。对比表模板见 [references/output-templates.md#已安装-skill-对比表](../references/output-templates.md#已安装-skill-对比表)。

**决策逻辑**：

| 已安装 vs 搜索结果 | 推荐决策 |
|-------------------|---------|
| 已安装能力 ⊃ 搜索结果 | **无需安装**，提示已有更完整的本地方案 |
| 已安装能力 ≈ 搜索结果 | **吸收融合**，只取搜索结果的独有特性 |
| 已安装能力 ⊂ 搜索结果 | **替换**，搜索结果全面优于本地 |
| 功能正交 | **并行安装**，各司其职 |
| 本地无相关 | 跳过对比 |

> **原则**：不要忽视用户已安装的 Skill。如果已安装 Skill 已满足需求，应明确告知。

## 第 6 步：输出结果

输出模板（按来源分区、推荐方案四档、提案式交互菜单）见 [references/output-templates.md](../references/output-templates.md)。

**输出前校验**：每来源 Top 0-3 | 编号跨分区连续 | 每条含说明+超链接+热度+推荐指数 | 已去重 | 已安装标注 `✅ 已安装` | 名称验证标注

**必须包含**：
1. 输出头（搜索了 N 个渠道，找到 K 个资源）
2. 按来源分区展示（每区 Top 3，编号全局连续）
3. 跨源比较表（如有相似 Skill）
4. 已安装对比（如有功能重叠）
5. 推荐方案（精简/完整/增强/融合四档，含具体编号和理由）
6. 提案式交互菜单（安装/详情/融合/相似/收藏/重搜）

如果用户是为了**参考学习**，额外说明结构亮点和值得借鉴的写法。

---

## 相似 Skill 搜索

用户请求"相似 skill"或选择"搜索相似"时：

1. 读取目标 Skill 的 `description` 和 `tags`
2. 提取核心能力词作为新关键词
3. 重新执行第 2-5 步搜索
4. 输出时标注"相似度"（功能重叠/互补/替代）

---

## 搜索无结果时

全部渠道均无相关 Skill 时：

1. 自动切换到**智能推荐**模块（见 [modules/recommend.md](recommend.md)）
2. 引导用户创建 Skill（路由到 [modules/create.md](create.md)）：
   ```
   未找到 "{关键词}" 相关的 Skill。
   如果这是你经常做的工作，我可以帮你创建一个：
   → 输入"帮我创建一个 {关键词} skill"
   → 或手动执行 npx skills init my-{关键词}-skill
   ```
3. 建议浏览 https://skills.sh 或 awesome-openclaw-skills 合集手动查找
