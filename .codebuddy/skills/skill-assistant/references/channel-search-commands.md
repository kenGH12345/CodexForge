# 渠道搜索命令模板

搜索模块 Step 2 使用此文件。**搜索时无需加载此文件**——命令已内化为 Agent 执行行为。
仅在需要查阅具体 API 端点、请求体格式、响应字段时按需加载对应渠道章节。

---

## 平台型搜索

### skills.sh

```bash
# 宽路：核心词，limit=30，按安装量排序
curl -s "https://skills.sh/api/search?q={核心词}&limit=30" \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
skills = sorted(data.get('skills', []), key=lambda x: x.get('installs', 0), reverse=True)
for s in skills[:30]:
    print(f\"{s['source']}@{s['skillId']}  {s['installs']:,} installs\")
"

# 窄路：精确词，5 条
npx skills find "{核心词+限定词}"
```

> 宽路用 curl API（CLI 硬编码 limit=10 + Top 6），窄路用 CLI 即可。无 Node 时窄路也用 curl API（`limit=5`）。

### SkillHub / ClawHub

```bash
# 宽路：核心词，取前 20
skillhub search "{核心词}" | head -60

# 窄路：精确词，取前 5
skillhub search "{核心词+限定词}" | head -15
```

### SkillsMP（REST API）

```bash
# 宽路：核心词，20 条
curl -s "https://skillsmp.com/api/v1/skills/search?q={核心词}&sortBy=stars&limit=20" \
  -H "Authorization: Bearer ${SKILLSMP_API_KEY}"

# 窄路：精确词，5 条
curl -s "https://skillsmp.com/api/v1/skills/search?q={精确词}&sortBy=stars&limit=5" \
  -H "Authorization: Bearer ${SKILLSMP_API_KEY}"
```

返回 JSON：`stars`（源仓库 Stars）、`author`、`description`、`githubUrl`、`skillUrl`、`updatedAt`。

**无 Key** — 跳过 SkillsMP，搜索结束后提示配置。

### Knot

> ⚠️ **Knot API 强制约束**：
> 1. **必须用 POST 方法**：GET 请求返回 405 Method Not Allowed
> 2. **参数必须通过 JSON body 传递**（`-d '{...}'`）：URL query params（`?keyword=xxx`）虽然不报错，但**只返回近期上架的 Skill 子集**（ID ≥ 13000），丢失所有早期高质量 Skill（如 ID=786 的 8,791 下载量 Skill）
> 3. **`order_by` 必填**：不传时按上传时间倒序，高下载量结果被淹没
>
> **正确格式**：`curl -sk URL -X POST -H "..." -d '{"keyword":"...","page_num":1,"page_size":30,"order_by":"download_count"}'`
> **错误格式**：~~`curl -sk "URL?keyword=xxx&page_size=30" -X POST -H "..."`~~（URL query params 返回不完整数据）

**认证方式（二选一）**：

| 方式 | 适用场景 | 配置 |
|------|---------|------|
| 静态 Token | 开发者手动申请 | `x-knot-api-token` header |
| JWT 换 Token | CLI 自动化 | `KNOT_JWT_TOKEN` + `KNOT_USERNAME` → `get_config` → `knot_api_token` |

```bash
# 方式 A：静态 Token（优先）
KNOT_HEADERS="-H 'x-knot-api-token: ${KNOT_API_TOKEN}' -H 'Content-Type: application/json'"

# 方式 B：JWT 换 Token
if [ -n "${KNOT_JWT_TOKEN}" ] && [ -z "${KNOT_API_TOKEN}" ]; then
  KNOT_API_TOKEN=$(curl -sk "https://knot.woa.com/apigw/api/v1/mcpport/get_config" \
    -H "X-Username: ${KNOT_USERNAME}" \
    -d "{\"jwt_token\": \"${KNOT_JWT_TOKEN}\", \"for_knot_api_token\": true}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['knot_api_token'])")
fi
```

> ⚠️ `.woa.com` 为腾讯内网，可能需 `-k` 跳过 SSL。

**category 过滤**：

| category 值 | 含义 | 适用场景 |
|-------------|------|---------|
| `""` (空) | 全部 | 默认宽路 |
| `official` | 官方认证 | 高信任优先 |
| `managed` | 我管理的 | 用户自己的 |
| `starred` | 已收藏 | 收藏列表 |
| `security` | 已安全认证 | 安全优先 |
| `usable` | 可用 | 管理视角 |

**标签工作流**：

```bash
# 列标签
curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get_skill_tags" \
  -H "x-knot-api-token: ${KNOT_API_TOKEN}" -H "Content-Type: application/json" -d '{}'

# 按标签过滤
curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get" \
  -H "x-knot-api-token: ${KNOT_API_TOKEN}" -H "Content-Type: application/json" \
  -d '{"keyword": "{关键词}", "tag_ids": ["{tag_id_1}"]}'
```

**完整搜索请求体**：

```bash
# 宽路：核心词，page_size=30，order_by=download_count（必填！）
curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get" \
  -X POST -H "Content-Type: application/json" \
  -H "x-knot-api-token: ${KNOT_API_TOKEN}" \
  -d '{
    "keyword": "{核心词}",
    "category": "",
    "page_num": 1,
    "page_size": 30,
    "order_by": "download_count"
  }'

# 窄路：精确词，category=official，page_size=10
curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get" \
  -X POST -H "Content-Type: application/json" \
  -H "x-knot-api-token: ${KNOT_API_TOKEN}" \
  -d '{
    "keyword": "{精确词}",
    "category": "official",
    "page_num": 1,
    "page_size": 10,
    "order_by": "download_count"
  }'
```

> ⚠️ **`order_by: "download_count"` 必填**。不传时按上传时间倒序，高质量结果被淹没。

**响应字段**（`data.list[]`）：

| 字段 | 含义 | 用途 |
|------|------|------|
| `id` | Skill ID | 下载时传入 |
| `display_name` | 显示名 | 展示 |
| `skill_name` | 技术名 | 安装目录名 |
| `creator` | 作者 | 信任评估 |
| `description` | 描述 | 匹配度验证 |
| `type` | `official` / `custom` / `knot` | 权威评分 |
| `security_scan_status` | `passed` / `waiting` / 缺失 | 安全评分 |
| `download_count` | 下载量 | 热度评分 |
| `tags[].display_name` | 标签 | 分类匹配 |
| `updated_at` | 更新时间 | 鲜度评分 |

**`security_scan_status` 处理**：

| 状态 | 处理 |
|------|------|
| `passed` | 🛡️ 平台安全认证，权威 +0.5 |
| `waiting` | ⏳ 安全扫描中 |
| 缺失/其他 | ❓ 未经扫描，安装时必须本地扫描 |

**Knot 搜索策略**：

| 场景 | category | tag_ids | order_by |
|------|----------|---------|----------|
| 宽路默认 | `""` | 无 | `download_count` |
| 窄路精确 | `official` | 按需 | `download_count` |
| 标签搜索 | `""` | 用户指定 | `download_count` |
| 安全优先 | `security` | 无 | `download_count` |

**Knot 拆词降级**：复合关键词返回空时自动拆为单词分别搜索再合并。**无 Token** — 跳过。

---

## GitHub 优质仓库搜索

`gh search code` 跨仓库合并搜索（一条命令搜多仓库）：

```bash
# 模板 A：核心词搜 SKILL.md（跨所有优质仓库）
gh search code "{核心词}" \
  --repo anthropics/skills \
  --repo VoltAgent/awesome-openclaw-skills \
  --repo ComposioHQ/awesome-claude-skills \
  --repo obra/superpowers \
  --filename SKILL.md --limit 20 --json repository,path,textMatches

# 模板 B：精确词搜 SKILL.md
gh search code "{精确词}" \
  --repo anthropics/skills --repo VoltAgent/awesome-openclaw-skills \
  --repo ComposioHQ/awesome-claude-skills --repo obra/superpowers \
  --filename SKILL.md --limit 10 --json repository,path,textMatches

# 模板 C：核心词搜 README.md（策展合集）
gh search code "{核心词}" \
  --repo VoltAgent/awesome-openclaw-skills --repo ComposioHQ/awesome-claude-skills \
  --filename README.md --limit 10 --json repository,path,textMatches
```

> `anthropics/skills` 结果可直接信任（🏢 官方）。`ComposioHQ/awesome-claude-skills` 默认分支是 `master`。

**用户自定义仓库**（`sources.yaml` 中 `repos` 段新增的）追加到 `--repo` 参数。

**gh 不可用时降级**：

| 层级 | 方式 | 说明 |
|------|------|------|
| 优先 | 全网搜索 | `{核心词} SKILL.md site:github.com/{owner}/{repo}`，逐仓库 |
| 兜底 | `curl` raw.githubusercontent.com | 直接抓取 README.md 原始内容，文本匹配 |

---

## 全 GitHub 搜索

```bash
# 宽路：核心词搜所有公开 SKILL.md
gh search code "{核心词}" --filename SKILL.md --limit 20 --json repository,path,textMatches

# 窄路：精确词搜高 Stars 仓库
gh search repos "{精确词} skill" --sort stars --limit 5 --json fullName,stargazersCount,description,updatedAt
```

**可选：非 Skill 源**（用户需要时才搜索）：

```bash
gh search repos "{核心词}" --sort stars --limit 10 --json fullName,stargazersCount,description,updatedAt,language
```

非 Skill 源标注 `📦 非 Skill — 可转化`。

**gh 不可用降级**（全网搜索）：`WebSearch: "{核心词} SKILL.md site:github.com"`

---

## 搜索策略完整定义

用户在首次引导（setup.md）中选择策略，存入 `sources.yaml` 的 `preferences.search_strategy`。

### speed（快速）

**适用场景**：用户已知需求明确，想尽快拿到前几个结果。

| 维度 | 行为 |
|------|------|
| 平台 | 仅 skills.sh + SkillHub（无需 API Key 的快速渠道） |
| 优质仓库 | gh 仅模板 A（核心词搜 SKILL.md） |
| 全 GitHub | 跳过 |
| 关键词层级 | Level 3 宽路 + Level 2 组 A（跳过组 B/C，不触发 Level 4） |
| 全网搜索 | 不触发 |
| 每渠道结果数 | Top 2 |
| 预计耗时 | 最短（2-3 个并行请求） |

### balanced（均衡）— 默认

**适用场景**：大多数搜索场景，覆盖与效率的平衡。

| 维度 | 行为 |
|------|------|
| 平台 | 所有已启用平台 |
| 优质仓库 | gh 跨仓库 3 模板（A/B/C） |
| 全 GitHub | gh search code + gh search repos |
| 关键词层级 | Level 2 全部（A/B/C） + Level 3 宽路（Level 4 仅结果 < 5 时触发） |
| 全网搜索 | 结果 < 5 时自动追加 |
| 每渠道结果数 | Top 3 |
| 预计耗时 | 中等（5-8 个并行请求） |

### thorough（全面）

**适用场景**：用户想全面了解市面上有什么，不怕耗时。

| 维度 | 行为 |
|------|------|
| 平台 | 所有平台（含已禁用的，标注为 _未启用_ 提示用户可开启） |
| 优质仓库 | 全模板 + curl README 补充 |
| 全 GitHub | 含非 Skill 源（标注"📦 可转化"） |
| 关键词层级 | 全部 Level（Level 4 扩展始终执行） |
| 全网搜索 | 强制追加 2 条 |
| 每渠道结果数 | Top 5 |
| 预计耗时 | 最长（10+ 个请求，含全网搜索） |

### 策略覆盖对照表

| 维度 | speed | balanced | thorough |
|------|:---:|:---:|:---:|
| 第 1 路（多平台） | skills.sh + SkillHub | 所有已启用 | 所有平台 |
| 第 2 路（优质仓库） | gh 模板 A | gh 3 模板 | 全模板 + curl README |
| 第 3 路（全 GitHub） | ❌ 跳过 | ✅ code + repos | ✅ 含非 Skill 源 |
| 全网搜索补充 | ❌ | 结果 < 5 | ✅ 强制 2 条 |
| 关键词层级 | L3 + L2-A | L2 全部 + L3 | 全部 + L4 |
| 每渠道 Top N | 2 | 3 | 5 |
| 结果稀缺（< 5）| 升级为 balanced | 追加全网搜索 | 已包含 |
| 无 gh CLI | ✅ 不受影响 | 降级全网搜索 | 降级全网搜索 |

> **结果稀缺自动升级**：speed 策略下总结果 < 5 时，自动升级为 balanced 重搜（不需要用户确认）。

**全网搜索补充查询模板**（仅 thorough 或结果稀缺时，Agent 使用 `WebSearch` 工具执行）：
1. `"{关键词} SKILL.md agent skill github"`
2. `"skills.sh {关键词} skill"`

---

## API 请求失败处理

Key 存在但 API 请求失败时，按 HTTP 状态码精确说明：

| HTTP 状态 | 含义 | 输出说明 | 处理 |
|-----------|------|---------|------|
| 200 | 成功 | — | 正常解析 |
| 302 | 重定向（SSO/VPN 拦截） | `渠道 X：HTTP 302 重定向。Token 已保存，需 VPN/内网。` | 跳过，标注网络原因 |
| 401/403 | 认证失败 | `渠道 X：Token 无效或已过期。` | 跳过，提示重配 |
| 404 | 端点不存在 | `渠道 X：API 端点不存在。` | 跳过 |
| 429 | 限流 | `渠道 X：请求频率超限。` | 跳过 |
| 500+ | 服务端错误 | `渠道 X：服务端异常（HTTP {code}）。` | 跳过 |
| 超时 | 不可达 | `渠道 X：连接超时。` | 跳过 |
| 空响应 | 空 | `渠道 X：返回空响应。` | 跳过 |

> 不要让用户误以为 Token 无效。302 重定向是典型的企业内网 SSO 拦截。

## 缺失 Key 提示模板

搜索结束后统一提示（不阻塞搜索，同一会话只提示一次）：

```markdown
---
💡 **部分渠道因缺少 API Key 未能搜索，配置后可获得更多结果：**

| 渠道 | 获取地址 | 说明 |
|------|---------|------|
| SkillsMP | [skillsmp.com/docs/api](https://skillsmp.com/docs/api) | 格式 sk_live_skillsmp_xxx |
| Knot | [knot.woa.com/settings/token](https://knot.woa.com/settings/token) | 32 位 Token |

直接告诉我你的 Key，我会自动验证并持久化保存。
---
```
