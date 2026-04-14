# 搜索词模板

## 四级关键词生成策略

将用户需求通过四个层级逐步展开为多组搜索关键词，最大化召回率的同时控制噪声。

### Level 1：语义核心提取

从用户自然语言输入中提取**核心概念**（名词/动词），翻译为最短英文词：

```
用户: "自动生成 PPT"
  → 动作概念: generate / create / build
  → 对象概念: presentation / pptx / slides
```

- 中文需求一律翻译为英文
- 提取 2-4 个核心概念词，不保留修饰词（"自动"→ 无需保留）
- 识别领域专用缩写（PPT → pptx, K8s → kubernetes）

### Level 2：主关键词组（2-3 组窄路）

基于 Level 1 的核心概念，生成 **2-3 组**精确关键词。每组 2 个词，覆盖不同表达方式：

| 组别 | 构造规则 | 说明 |
|------|---------|------|
| **组 A**（精确匹配） | 对象 + 动作的最直接组合 | 最可能命中高安装量结果 |
| **组 B**（近义替代） | 换一种表达同一需求 | 覆盖不同命名风格 |
| **组 C**（相关概念） | 功能相关但表述不同的词 | 捕捉意外的好结果 |

### Level 3：宽路关键词（1 个最短核心词）

从 Level 1 中选**最通用的 1 个词**作为宽路关键词。目标是最大化召回。

### Level 4：缩写/别名扩展（仅在结果不足时触发）

当 Level 2-3 结果总数 < 5 时，追加搜索：
- 技术缩写（kubernetes ↔ k8s, presentation ↔ ppt）
- 工具名（slides → slidev, reveal.js）
- 长尾变体（deploy → deployment, deployer）

**Level 4 不默认执行**，仅作为结果不足时的补充。

---

## 关键词构造四原则

### 原则 1：简单核心词优先

> **`code review` 优于 `review my code for bugs`**

- 自然语言描述 → 提取 **1-2 个英文核心词**
- 禁止长句搜索（超过 3 个词就太长了）
- 中文需求一律翻译为**最短英文核心词**

| 搜索意图 | 用户输入 | ✅ 正确 | ❌ 错误 |
|---------|---------|---------|---------|
| 精确名称 | "找 find-skills 这个 skill" | `find-skills` | `find skills search discover` |
| 自然语言 | "自动生成饮食计划" | `meal plan` | `generate meal plan automatically` |
| 自然语言 | "帮我做 PR review" | `code review` | `help me review pull requests` |
| 领域关键词 | "react 测试" | `react testing` | `react testing framework jest` |

### 原则 2：先粗后细（宽路 → 窄路多组）

搜索时先用**宽泛词**取高安装量结果，再用**多组精确词**覆盖不同表达：

| 层级 | 策略 | 示例（用户要"自动生成 PPT"） | 搜索量 |
|------|------|------|------|
| Level 3（宽） | 最短核心词 | `presentation` | API limit=30 |
| Level 2 组 A（窄） | 精确匹配 | `pptx presentation` | limit=10 |
| Level 2 组 B（窄） | 近义替代 | `presentation builder` | limit=10 |
| Level 2 组 C（窄） | 相关概念 | `markdown slides` | limit=5 |

### 原则 3：多意图必须拆分

用户给出多个需求时，**拆分为独立搜索**，每个意图各自生成四级关键词：

| 意图 | Level 3 宽路 | Level 2 组 A | Level 2 组 B |
|------|-------------|-------------|-------------|
| 查找 skill | `skill` | `skill finder` | `skill search` |
| 审查 skill | `audit` | `skill audit` | `code review` |
| 创建 skill | `create` | `skill creator` | `skill builder` |

每个意图独立执行搜索，**禁止合并为长查询**。

### 原则 4：近义词覆盖不同命名风格

不同作者为相同功能的 Skill 使用不同命名。组 A/B/C 的近义词覆盖这种差异：

| 功能 | 命名风格 1 | 命名风格 2 | 命名风格 3 |
|------|-----------|-----------|-----------|
| 代码审查 | code-review | code-audit | PR-review |
| PPT 生成 | pptx-presentation | presentation-builder | markdown-slides |
| K8s 部署 | kubernetes-deploy | k8s-deployment | helm-chart |
| 数据库优化 | database-optimization | sql-performance | query-tuning |

---

## 完整示例

### 示例 1："代码审查"

```
Level 1 语义核心: code + review + audit + quality
Level 2 主关键词:
  组 A: "code review"        (精确匹配)
  组 B: "code audit"         (近义替代)
  组 C: "PR review"          (相关概念)
Level 3 宽路: "review"       (最短核心词)
Level 4 扩展: "pull request review", "lint"  (仅不足时)
```

### 示例 2："自动生成 PPT"

```
Level 1 语义核心: presentation + pptx + slides + generate
Level 2 主关键词:
  组 A: "pptx presentation"   (精确匹配 → 命中 pptx-presentation-builder 7,979 安装)
  组 B: "presentation builder" (近义替代 → 命中 presentation-builder 4,145 安装)
  组 C: "markdown slides"     (相关概念 → 命中 markdown-slides 33 安装)
Level 3 宽路: "presentation"  (召回 30 条候选)
Level 4 扩展: "slidev", "ppt" (仅不足时)
```

### 示例 3："Kubernetes 部署"

```
Level 1 语义核心: kubernetes + deploy + orchestration
Level 2 主关键词:
  组 A: "kubernetes deploy"     (精确匹配)
  组 B: "k8s deployment"        (缩写变体)
  组 C: "helm chart"            (相关工具)
Level 3 宽路: "kubernetes"      (召回 30 条候选)
Level 4 扩展: "container orchestration"  (仅不足时)
```

### 示例 4："找 skill 管理工具"

```
Level 1 语义核心: skill + find + manage + search
Level 2 主关键词:
  组 A: "skill finder"         (精确匹配)
  组 B: "skill search"         (近义替代)
  组 C: "skill manager"        (相关概念)
Level 3 宽路: "skill"          (召回 30 条候选)
```

### 示例 5："数据库优化"

```
Level 1 语义核心: database + optimize + performance + query
Level 2 主关键词:
  组 A: "database optimization" (精确匹配)
  组 B: "sql performance"       (近义替代)
  组 C: "query tuning"          (相关概念)
Level 3 宽路: "database"        (召回 30 条候选)
Level 4 扩展: "postgres optimize", "mysql tuning"  (仅不足时)
```

---

## 精确名称信号

用户说"这个 skill"、"叫 xxx 的"、提供了含连字符的名称 → 直接用名称搜索，跳过四级生成。

## 标签搜索

用户输入含 `#tag` 时，提取标签作为关键词。标签可组合使用。Knot 渠道先调 `get_skill_tags` 匹配 tag ID，再传入 `tag_ids` 精确搜索。

## 知名来源优先检查

搜索结果中出现以下来源时，排序提权：

| 来源 | 说明 | 量级 |
|------|------|------|
| `vercel-labs/agent-skills` | Vercel 官方 | 10K-22K+/周 |
| `anthropics/skills` | Anthropic 官方 | 1K+/周 |
| `expo/skills` | Expo 官方 | 1K+/周 |
| `ComposioHQ/awesome-claude-skills` | 500+ 应用连接 | 高 Stars |

## GitHub 全网搜索降级词模板（4 路并行）

仅在 gh CLI 不可用时使用全网搜索降级（Agent 使用 `WebSearch` 工具执行）：

| 策略 | 搜索词模板 | 说明 |
|------|-----------|------|
| 精确搜 | `github {关键词} repository stars` | 找高星仓库 |
| 合集搜 | `github awesome-{关键词} OR awesome {关键词} list` | 找 awesome 合集 |
| 工具搜 | `github {工具名} {关键词} library collection` | 找工具生态 |
| Skill 搜 | `"{关键词}" "SKILL.md" site:github.com` | 找真正的 Skill 仓库 |

## 相似搜索词构造

用户请求"相似 skill"时，从目标 Skill 提取关键词重搜：

1. 读取目标 Skill 的 `description` 和 `tags`
2. 提取 2-3 个核心能力词
3. 按四级策略生成新关键词组执行搜索

| 场景 | 目标 Skill | Level 2 关键词组 |
|------|-----------|-----------------|
| "类似 pdf-editor 的" | desc: "Process PDF files" | A: `pdf processing`, B: `pdf editor`, C: `document converter` |
| "和 code-review 相似的" | tags: [review, quality, lint] | A: `code quality`, B: `code lint`, C: `static analysis` |

## 常见错误关键词纠正表

| ❌ 错误用法 | ✅ 正确用法 | 原因 |
|------------|-----------|------|
| `skill finder search discover install` | Level 2: `skill finder` + `skill search` | 应拆为多组，不堆砌 |
| `help me find and recommend skills` | Level 2: `skill finder` + `skill recommend` | 自然语言长句→拆分 |
| `security audit code review` | 拆为两个意图独立搜索 | 两个不同意图混在一起 |
| `generate meal plan automatically` | Level 2: `meal plan` + `meal generator` | 去掉多余的修饰动词 |
| `react testing framework jest` | Level 2: `react testing` + `react jest` | 工具名单独为一组 |
