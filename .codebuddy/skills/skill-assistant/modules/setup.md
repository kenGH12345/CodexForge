# 首次使用引导

当 `config/sources.yaml` 中 `preferences.setup_completed` 为 `false` 时，用户首次触发搜索/推荐/安装意图会被拦截到此流程。

引导完成后将 `setup_completed` 设为 `true`，后续不再触发。
用户说"重新配置搜索偏好"/"reconfigure"/"重置设置"可随时重新进入。

---

## 触发条件

读取 `config/sources.yaml`，检查 `preferences.setup_completed`：
- `false` 或字段不存在 → 进入引导流程
- `true` → 跳过，正常路由到目标模块

---

## Step 1：搜索源选择（平台 + 仓库一步完成）

先向用户介绍所有可选搜索源，**不做环境检测**，让用户基于需求做选择。

```markdown
## 👋 欢迎使用 Skill Assistant！

首次使用需要配置搜索源。以下是所有可用的搜索渠道：

### 平台型技能市场

| # | 平台 | 规模 | 能力 | 前置条件 |
|---|------|------|------|---------|
| 1 | **skills.sh** | 91K+ Skills | Vercel 出品，按安装量排序，沙盒执行 | 有 Node 用 CLI，无 Node 自动降级 curl |
| 2 | **SkillsMP** | 700K+ Skills | GitHub 全量聚合，Stars 排序，语义搜索 | API Key（免费申请） |
| 3 | **ClawHub** | 13K+ Skills | OpenClaw 官方注册表，Verified 审核，语义搜索 | Node ≥ 22 + `clawhub` CLI |
| 4 | **SkillHub** | 与 ClawHub 同源 | ClawHub 国内加速镜像，中英双语，下载更快捷 | `skillhub` CLI（无 Node 版本要求） |
| 5 | **Knot**（腾讯） | 企业级 | CodeBuddy 生态，官方认证，安全扫描 | API Token（内网获取） |

> **ClawHub vs SkillHub**（二选一）：
> - **ClawHub**：OpenClaw 官方 CLI，功能最完整（语义搜索、Verified 标识、直接安装），但需要 Node ≥ 22。
> - **SkillHub**：ClawHub 的国内镜像，数据完全同步（13K+ Skills），国内 CDN 加速下载更快，无 Node 版本要求，安装更便捷。
> - 两者数据同源，选一个即可。Node ≥ 22 的用户推荐 ClawHub，否则推荐 SkillHub。

### GitHub 优质技能仓库

| # | 仓库 | Stars | 说明 |
|---|------|-------|------|
| 6 | **anthropics/skills** | 108K | Anthropic 官方出品，SKILL.md 规范标杆 |
| 7 | **VoltAgent/awesome-openclaw-skills** | 43.5K | 社区策展 5.4K+ 精选，分类详细 |
| 8 | **ComposioHQ/awesome-claude-skills** | 4.7K | 500+ SaaS 应用集成（Slack/Notion/Gmail 等） |
| 9 | **obra/superpowers** | — | 编码代理完整工作流：TDD、调试、代码审查等 14 个核心 Skills |

请输入你想启用的编号（如 `1,4,5,6,7,8,9`），或输入 `全选` 启用所有渠道（推荐，ClawHub/SkillHub 默认选 SkillHub）。
💡 输入 `+owner/repo` 可添加自定义仓库（如团队私有仓库）。
💡 后续环境不满足的平台会引导安装或提供替代方案。
```

等待用户输入。如果用户输入"全选"，启用所有渠道（ClawHub/SkillHub 默认选 SkillHub）。如果用户同时选了 ClawHub 和 SkillHub，提示二选一。
如有自定义仓库 `+owner/repo`，验证可达：

```bash
gh api repos/{owner}/{repo} --jq '.full_name' 2>/dev/null
```

记录选择结果，进入 Step 2。

---

## Step 2：逐平台环境检查 + 安装引导

对用户选择的每个平台，**按顺序**检查前置条件。不满足时引导安装，用户也可以在此步放弃该平台。

### 2.1 ClawHub — Node.js ≥ 22 检查

**仅当用户选择了 ClawHub（#3）时执行。**

```bash
node --version 2>/dev/null || echo "NOT_INSTALLED"
```

**场景 A：Node 未安装 或 Node < 22**

```markdown
ClawHub CLI 需要 Node ≥ 22，当前 {未安装 / 版本 v{version}}。

| # | 选项 | 说明 |
|---|------|------|
| 1 | **改用 SkillHub**（推荐） | ClawHub 的国内镜像，数据同源，下载更快，无 Node 版本要求 |
| 2 | **安装/升级 Node** | 安装最新稳定版 Node，然后使用 ClawHub CLI |
| 3 | **放弃** | 不使用 ClawHub / SkillHub |
```

- 选 1 → 禁用 ClawHub，转入 2.2 安装 SkillHub CLI
- 选 2 → 安装/升级 Node：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install --lts && nvm use --lts && node --version
```

安装成功后继续安装 ClawHub CLI：`npm i -g clawhub`

验证：

```bash
clawhub --version
```

- 选 3 → 禁用 ClawHub，跳过

**场景 B：Node ≥ 22**

直接检查 ClawHub CLI：

```bash
clawhub --version 2>/dev/null || echo "NOT_INSTALLED"
```

未安装则执行：`npm i -g clawhub`

### 2.2 SkillHub — CLI 安装

**仅当用户选择了 SkillHub（#4）或从 ClawHub 转换到 SkillHub 时执行。**

```bash
skillhub --version 2>/dev/null || echo "NOT_INSTALLED"
```

未安装则执行：

```bash
curl -fsSL https://skillhub.cn/install/install.sh | bash
```

安装完成后，修复 PATH（根据用户 shell）：

```bash
CURRENT_SHELL=$(basename "$SHELL")
if [ "$CURRENT_SHELL" = "zsh" ]; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
else
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
fi
skillhub --version
```

验证成功后继续。

### 2.3 skills.sh — Node.js 检查

**仅当用户选择了 skills.sh（#1）时执行。**

```bash
node --version 2>/dev/null || echo "NOT_INSTALLED"
```

**只检查 Node 是否存在**，不强制版本：

| Node 状态 | 处理 |
|-----------|------|
| 已安装（任意版本） | ✅ 使用 `npx skills find` CLI 搜索 |
| 未安装 | 降级为 `curl -s "https://skills.sh/api/search?q={query}"` API 搜索 |

告知用户当前状态：

```markdown
### skills.sh 环境检测

{已检测到 Node v{version}，将使用 CLI 搜索。}
{未检测到 Node，将自动降级为 curl API 搜索（理论上不会有任何影响，功能完全等价）。}
```

然后询问下载通知偏好：

```markdown
### 下载行为通知

skills.sh 支持在你安装 Skill 时通知平台记录下载行为。
这有助于 skills.sh 优化推荐排序（按安装量排序），让更多人发现好用的 Skill。

**不会上传任何个人信息**，仅通知"某个 Skill 被下载了一次"。

是否允许在下载时通知 skills.sh？
| # | 选项 |
|---|------|
| 1 | **允许**（推荐，帮助社区优化推荐） |
| 2 | **不允许**（静默安装，不通知平台） |
```

将选择写入 `sources.yaml` 的 `preferences.notify_skills_sh_download` 字段（`true`/`false`）。

### 2.4 SkillsMP — API Key 配置

**仅当用户选择了 SkillsMP（#2）时执行。**

先检查凭证文件是否已有 Key：

```bash
CRED_FILE="{SKILL_ASSISTANT_ROOT}/config/.credentials.yaml"
EXISTING_KEY=$(python3 -c "
import yaml, sys
try:
    with open('$CRED_FILE') as f:
        creds = yaml.safe_load(f) or {}
    key = creds.get('skillsmp', {}).get('api_key', '')
    print(key if key else '')
except: print('')
" 2>/dev/null)
echo "${EXISTING_KEY:+已配置（凭证文件）}"
echo "${SKILLSMP_API_KEY:+已配置（环境变量）}"
```

**已有 Key**（凭证文件或环境变量）→ 验证后跳过。
**无 Key** → 引导：

```markdown
### 配置 SkillsMP API Key

1. 打开 [skillsmp.com/docs/api](https://skillsmp.com/docs/api)
2. 登录后点击 "Generate API Key"
3. 复制 Key（格式：`sk_live_skillsmp_xxx`，每日 500 次）

请粘贴你的 API Key，或输入"跳过"放弃该平台：
```

用户提供 Key 后验证：

```bash
curl -s "https://skillsmp.com/api/v1/skills/search?q=test&limit=1" \
  -H "Authorization: Bearer {KEY}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('skills') is not None else 'FAIL')"
```

- `OK` → ✅ **写入凭证文件**（持久化，跨会话生效）
- `FAIL` → ❌ 提示无效，可重试或跳过

**写入凭证文件**（⚠️ 必须执行此步，禁止仅 export 环境变量）：

```bash
python3 -c "
import yaml
cred_file = '{SKILL_ASSISTANT_ROOT}/config/.credentials.yaml'
with open(cred_file) as f:
    creds = yaml.safe_load(f) or {}
creds.setdefault('skillsmp', {})['api_key'] = '{KEY}'
with open(cred_file, 'w') as f:
    yaml.dump(creds, f, default_flow_style=False, allow_unicode=True)
print('✅ Key 已持久化到 config/.credentials.yaml')
"
```

### 2.5 Knot — API Token 配置

**仅当用户选择了 Knot（#5）时执行。**

先检查凭证文件是否已有 Token：

```bash
CRED_FILE="{SKILL_ASSISTANT_ROOT}/config/.credentials.yaml"
EXISTING_TOKEN=$(python3 -c "
import yaml
try:
    with open('$CRED_FILE') as f:
        creds = yaml.safe_load(f) or {}
    token = creds.get('knot', {}).get('api_token', '')
    print(token if token else '')
except: print('')
" 2>/dev/null)
echo "${EXISTING_TOKEN:+已配置（凭证文件）}"
echo "${KNOT_API_TOKEN:+已配置（环境变量）}"
```

**已有 Token** → 验证后跳过。
**无 Token** → 引导：

```markdown
### 配置 Knot API Token

1. 打开 [knot.woa.com/settings/token](https://knot.woa.com/settings/token)（需腾讯内网）
2. 登录后获取 32 位 API Token

请粘贴你的 API Token，或输入"跳过"放弃该平台：
```

用户提供 Token 后验证（**必须用 POST + JSON body**，GET 会返回 405）：

```bash
curl -sk "https://knot.woa.com/apigw/openapi/v1/skills/get" \
  -X POST -H "Content-Type: application/json" \
  -H "x-knot-api-token: {TOKEN}" \
  -d '{"keyword":"skill","category":"","page_num":1,"page_size":1,"order_by":"download_count"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('data',{}).get('list') is not None else 'FAIL')"
```

- `OK` → ✅ **写入凭证文件**（持久化，跨会话生效）
- `FAIL` → ❌ 提示无效，可重试或跳过

> ⚠️ Knot API **所有接口**均要求 POST 方法 + JSON body 传参。使用 GET 或 URL query params 会返回 405 或不完整数据。

验证通过后 **写入凭证文件**（同 2.4 流程）：

```bash
python3 -c "
import yaml
cred_file = '{SKILL_ASSISTANT_ROOT}/config/.credentials.yaml'
with open(cred_file) as f:
    creds = yaml.safe_load(f) or {}
creds.setdefault('knot', {})['api_token'] = '{TOKEN}'
with open(cred_file, 'w') as f:
    yaml.dump(creds, f, default_flow_style=False, allow_unicode=True)
print('✅ Token 已持久化到 config/.credentials.yaml')
"
```

**安装 knot-cli**（Knot Skill 下载依赖，一次性操作）：

```bash
# 探测 PATH + 常见安装路径
if command -v knot-cli &>/dev/null; then
  echo "✅ knot-cli 已安装：$(knot-cli -v 2>&1 | head -1)"
elif [ -x "$HOME/background_agent_cli/bin/knot-cli" ]; then
  echo "✅ knot-cli 已安装：$($HOME/background_agent_cli/bin/knot-cli -v 2>&1 | head -1)"
  echo "💡 提示：需将 $HOME/background_agent_cli/bin 加入 PATH"
else
  echo "❌ 需要安装 knot-cli"
fi
```

如未安装，引导用户执行：

```bash
curl -v -L 'https://mirrors.tencent.com/repository/generic/knot-cli/install.sh' \
  | bash -s -- --token {TOKEN} --origin knot --codebase --workspace {workspace}
```

| 参数 | 说明 |
|------|------|
| `--token` | 上一步已验证的 Knot API Token |
| `--workspace` | 当前项目路径（如 `/Users/xxx/projects/my-project`），可用 `--workspace "A;B"` 指定多个 |
| `--origin knot` | 标识来源（必填） |
| `--codebase` | 为该 workspace 启动 codebase（必填） |

安装完成后提示用户：

```markdown
✅ knot-cli 安装完成！

请执行以下任一操作使命令生效：
- 在当前终端执行 `source ~/.bashrc`
- 或新开一个终端

验证：执行 `knot-cli client-status` 应返回包含 `connection_uuid` 的 JSON。
```

> ⚠️ knot-cli 安装失败不影响 Knot 搜索功能，仅影响 Knot Skill 下载。

---

## Step 3：搜索策略选择

```markdown
## 🔍 搜索策略

选择你偏好的搜索方式：

| # | 策略 | 说明 | 适用场景 |
|---|------|------|---------|
| 1 | **快速** (`speed`) | 只搜 skills.sh + SkillHub，跳过全 GitHub，每渠道 Top 2 | 需求明确，想快速拿到结果 |
| 2 | **均衡** (`balanced`) ⭐ 推荐 | 搜所有已启用平台 + GitHub 仓库 + 全 GitHub，每渠道 Top 3 | 大多数场景 |
| 3 | **全面** (`thorough`) | 全部渠道 + 全网搜索补充 + 非 Skill 开源项目，每渠道 Top 5 | 想全面了解市面上有什么 |

请输入编号（`1` / `2` / `3`），推荐输入 `2`。
💡 后续可随时切换：说"切换为全面搜索"或编辑 `config/sources.yaml`。
💡 快速模式下结果不足 5 个时会自动升级为均衡模式重搜。
```

将选择写入 `sources.yaml` 的 `preferences.search_strategy` 字段。

---

## Step 4：配置摘要 + 写入

汇总用户所有选择，展示最终配置：

```markdown
## ✅ 配置完成！

### 已启用的搜索源

**平台型技能市场**：
| 平台 | 状态 | 搜索方式 |
|------|------|---------|
| skills.sh | ✅ 启用 | CLI / curl API |
| SkillsMP | ✅ 启用 | REST API（Key 已配置） |
| SkillHub | ✅ 启用 | CLI 已安装 |
| ClawHub | ⬜ 已替换为 SkillHub | — |
| Knot | ⬜ 已跳过（未配置 Token） | — |

**GitHub 优质仓库**：
| 仓库 | 状态 |
|------|------|
| anthropics/skills | ✅ 启用 |
| awesome-openclaw-skills | ✅ 启用 |
| awesome-claude-skills | ✅ 启用 |
| obra/superpowers | ✅ 启用 |

**搜索偏好**：
| 选项 | 值 |
|------|-----|
| 搜索策略 | ⭐ 均衡 (`balanced`) |
| skills.sh 下载通知 | ✅ 允许 / ⬜ 不允许 |

💡 随时可调整：说"重新配置搜索偏好"重新进入引导，或直接编辑 `config/sources.yaml`。
```

**写入 `config/sources.yaml`**：
- 更新各源的 `enabled` 字段（ClawHub/SkillHub 互斥，只启用一个）
- 更新各源的 `result_limit` 字段
- 写入 API Key 到 `auth.api_key`（如有）
- 写入 `preferences.search_strategy`（speed / balanced / thorough）
- 写入 `preferences.notify_skills_sh_download`（`true`/`false`）
- 添加用户自定义仓库到 `repos` 段（如有）
- **设置 `preferences.setup_completed: true`**

配置完成后，自动继续执行用户原始意图（搜索/推荐/安装）。
