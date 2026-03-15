<div align="center">

# 🤖 WorkFlowAgent

**An AI-native multi-agent workflow engine for automated software development**

**面向自动化软件开发的 AI 原生多智能体工作流引擎**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kenGH12345/WorkFlowAgent/pulls)

**[English](#english-version)** · **[中文](#chinese-version)**

</div>

---

<a name="english-version"></a>

## 🇬🇧 English

### What is WorkFlowAgent?

WorkFlowAgent is a **portable, LLM-agnostic multi-agent workflow engine** that turns a single natural-language requirement into production-ready code through a structured pipeline of specialised AI agents.

Unlike monolithic AI coding assistants, WorkFlowAgent enforces **strict role boundaries** between agents, uses a **file-reference communication protocol** to eliminate token waste, and ships with a **one-command project initialiser** that auto-detects your tech stack.

```
User Requirement
      │
      ▼
┌───────────┐   ┌─────────────┐   ┌─────────────┐   ┌──────────┐
│  Analyst  │──▶│  Architect  │──▶│  Developer  │──▶│  Tester  │
│   Agent   │   │    Agent    │   │    Agent    │   │  Agent   │
└───────────┘   └─────────────┘   └─────────────┘   └──────────┘
      │               │                 │                 │
 requirement.md  architecture.md    code.diff       test-report.md
      └───────────────┴─────────────────┴─────────────────┘
                                  │
                            manifest.json
                         (checkpoint resume)
```

---

### ✨ Core Features

| Feature | Description |
|---|---|
| 🧩 **Multi-Agent Pipeline** | Analyst → Architect → Developer → Tester, each with strict role boundaries |
| 📁 **File-Reference Protocol** | Agents communicate via file paths only — zero raw-content token waste |
| ♻️ **Checkpoint Resume** | Every state persists to `manifest.json`; interrupted runs resume automatically |
| 🔍 **Socratic Decision Engine** | Structured multiple-choice checkpoints replace free-form review prompts |
| 🧠 **KV-Cache Optimised Prompts** | Fixed prefix + dynamic suffix maximises LLM cache hit rate |
| 📦 **Thin / Thick Tools** | Auto-selects summarised tools for large monorepos (≥500 files) |
| 🌿 **Git PR Automation** | Auto-creates feature branches, commits artifacts, and opens GitHub PRs |
| 🏖️ **Dry-Run / Sandbox Mode** | Preview all file changes before applying them to the real filesystem |
| 🔌 **MCP Integration** | Plug in TAPD, CI systems, or any external tool via the MCP adapter layer |
| 🚀 **One-Command Init** | Auto-detects tech stack and bootstraps the full workflow in one command |
| 📚 **Experience Store** | Accumulates project-specific knowledge across sessions |
| 🎯 **Skill Evolution** | Domain skill files grow richer as the agent learns from each task |

---

### 🆚 Comparison with Similar Frameworks

| | WorkFlowAgent | AutoGen | CrewAI | Devin / SWE-agent | Cursor / Copilot |
|---|:---:|:---:|:---:|:---:|:---:|
| **Primary focus** | Structured software dev pipeline | General multi-agent conversations | Role-based task crews | Autonomous coding agent | IDE code completion |
| **Agent roles** | Fixed pipeline (Analyst→Architect→Dev→Test) | Flexible, user-defined | Flexible, user-defined | Single agent loop | Single assistant |
| **Communication** | File-reference protocol | In-memory message passing | In-memory message passing | Tool calls + scratchpad | Context window |
| **Token efficiency** | ✅ KV-cache + thin/thick tools | ❌ Full message history | ❌ Full message history | ❌ Long scratchpad | ✅ IDE context trimming |
| **Checkpoint / resume** | ✅ `manifest.json` per stage | ❌ | ❌ | ❌ | N/A |
| **LLM agnostic** | ✅ Bring your own `llmCall` | ✅ | ✅ | ❌ Proprietary | ❌ Proprietary |
| **Git PR automation** | ✅ Built-in | ❌ | ❌ | ✅ | ❌ |
| **Dry-run / sandbox** | ✅ Full file-write interception | ❌ | ❌ | ❌ | ❌ |
| **Tech-stack auto-detect** | ✅ One-command init | ❌ Manual config | ❌ Manual config | N/A | ✅ IDE-native |
| **Portability** | ✅ Copy one folder anywhere | ❌ Framework dependency | ❌ Framework dependency | ❌ Cloud service | ❌ IDE plugin |
| **Self-hosted** | ✅ Fully local | ✅ | ✅ | ❌ | ❌ |
| **Experience accumulation** | ✅ Per-project store | ❌ | ❌ | ❌ | ❌ |

**Where WorkFlowAgent shines 🌟**

- **Token cost control** — File-reference protocol + KV-cache prompts make it significantly cheaper on large codebases.
- **Reproducibility** — Deterministic `INIT → ANALYSE → ARCHITECT → CODE → TEST` pipeline with auditable decision logs.
- **Zero lock-in** — No cloud dependency, no proprietary API. Plug in any LLM with a single async function.
- **Portability** — Self-contained folder. Drop it into any project and run one command.

**Trade-offs ⚖️**

- **Fixed pipeline topology** — If you need dynamic agent graphs (agents spawning sub-agents), AutoGen or LangGraph offer more flexibility.
- **No built-in UI** — CLI/library only. Devin and Cursor provide polished GUIs.
- **Requires Node.js ≥ 16** — Python-first teams may prefer AutoGen or CrewAI.

---

### 🚀 Quick Start

**Prerequisites:** Node.js ≥ 16 · Git · [GitHub CLI](https://cli.github.com) `gh` (optional)

```bash
# 1. Clone & install
git clone https://github.com/kenGH12345/WorkFlowAgent.git
cd WorkFlowAgent/workflow && npm install

# 2. Initialise for your project (auto-detects tech stack)
node workflow/init-project.js

# 3. Run a workflow
```

```javascript
const { Orchestrator } = require('./workflow');

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: async (prompt) => {
    // Plug in any LLM: OpenAI, Claude, Gemini, Ollama…
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] }),
    });
    return (await res.json()).choices[0].message.content;
  },
  projectRoot: '/path/to/your/project',
  git: { enabled: true, autoPush: true },
  dryRun: false,
});

await orchestrator.run('Build a REST API for user management with CRUD operations');
```

---

### 📁 Project Structure

```
WorkFlowAgent/
├── workflow/                  # The portable workflow engine
│   ├── index.js               # Orchestrator entry point
│   ├── package.json
│   ├── workflow.config.js     # Project-specific configuration
│   ├── init-project.js        # One-command project initialiser
│   ├── agents/                # Specialist agents
│   │   ├── analyst-agent.js
│   │   ├── architect-agent.js
│   │   ├── developer-agent.js
│   │   └── tester-agent.js
│   ├── core/                  # Core services
│   │   ├── state-machine.js   # Workflow state + manifest checkpoint
│   │   ├── git-integration.js # Branch / commit / PR automation
│   │   ├── sandbox.js         # Dry-run file-write interception
│   │   ├── prompt-builder.js  # KV-cache optimised prompt assembly
│   │   ├── experience-store.js
│   │   └── skill-evolution.js
│   ├── commands/              # Slash command dispatcher
│   ├── hooks/                 # Lifecycle hooks & MCP adapters
│   ├── tools/                 # Thin / thick tool adapters
│   └── tests/                 # Unit + E2E test suite
└── AGENTS.md                  # AI agent entry point index
```

---

### 🤝 Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feat/amazing-feature`
3. Commit your changes: `git commit -m 'feat: add amazing feature'`
4. Push and open a Pull Request

---

<a name="chinese-version"></a>

## 🇨🇳 中文文档

### 项目简介

WorkFlowAgent 是一个**可移植、与 LLM 无关的多智能体工作流引擎**，通过结构化的专业 AI 智能体流水线，将一句自然语言需求转化为可直接投入生产的代码。

与单体式 AI 编程助手不同，WorkFlowAgent 在各智能体之间强制执行**严格的角色边界**，使用**文件引用通信协议**消除 Token 浪费，并内置**一键项目初始化器**，可自动检测技术栈。

```
用户需求
  │
  ▼
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  分析师  │──▶│  架构师  │──▶│  开发者  │──▶│  测试员  │
│  Agent   │   │  Agent   │   │  Agent   │   │  Agent   │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
      │              │               │               │
 需求文档.md    架构设计.md       代码变更集       测试报告.md
      └──────────────┴───────────────┴───────────────┘
                              │
                        manifest.json
                        （断点续跑）
```

---

### ✨ 核心特性

| 特性 | 说明 |
|---|---|
| 🧩 **多智能体流水线** | 分析师 → 架构师 → 开发者 → 测试员，各角色边界严格隔离 |
| 📁 **文件引用协议** | 智能体间仅传递文件路径，彻底消除原始内容的 Token 浪费 |
| ♻️ **断点续跑** | 每次状态转换均持久化到 `manifest.json`，中断后自动恢复 |
| 🔍 **苏格拉底决策引擎** | 结构化多选检查点替代自由格式的审查提示 |
| 🧠 **KV 缓存优化提示词** | 固定前缀 + 动态后缀结构，最大化 LLM 缓存命中率 |
| 📦 **精简/完整工具自适应** | 大型 Monorepo（≥500 文件）自动切换摘要工具，降低 Token 消耗 |
| 🌿 **Git PR 自动化** | 自动创建功能分支、提交产物并发起 GitHub PR |
| 🏖️ **沙盒/预演模式** | 在真实写入前预览所有文件变更 |
| 🔌 **MCP 集成** | 通过 MCP 适配层接入 TAPD、CI 系统或任意外部工具 |
| 🚀 **一键初始化** | 自动检测技术栈，一条命令完成全套工作流配置 |
| 📚 **经验积累库** | 跨会话积累项目专属知识，越用越聪明 |
| 🎯 **技能进化** | 领域技能文件随每次任务完成而持续丰富 |

---

### 🆚 与同类框架对比

| | WorkFlowAgent | AutoGen | CrewAI | Devin / SWE-agent | Cursor / Copilot |
|---|:---:|:---:|:---:|:---:|:---:|
| **核心定位** | 结构化软件开发流水线 | 通用多智能体对话 | 角色制任务团队 | 自主编程 Agent | IDE 代码补全 |
| **智能体角色** | 固定流水线（分析→架构→开发→测试） | 灵活自定义 | 灵活自定义 | 单 Agent 循环 | 单助手 |
| **通信方式** | 文件引用协议 | 内存消息传递 | 内存消息传递 | 工具调用+草稿本 | 上下文窗口 |
| **Token 效率** | ✅ KV 缓存 + 精简工具 | ❌ 完整消息历史 | ❌ 完整消息历史 | ❌ 超长草稿本 | ✅ IDE 上下文裁剪 |
| **断点续跑** | ✅ 每阶段 `manifest.json` | ❌ | ❌ | ❌ | N/A |
| **LLM 无关** | ✅ 自带 `llmCall` 接口 | ✅ | ✅ | ❌ 专有 | ❌ 专有 |
| **Git PR 自动化** | ✅ 内置 | ❌ | ❌ | ✅ | ❌ |
| **沙盒/预演** | ✅ 完整文件写入拦截 | ❌ | ❌ | ❌ | ❌ |
| **技术栈自动检测** | ✅ 一键初始化 | ❌ 手动配置 | ❌ 手动配置 | N/A | ✅ IDE 原生 |
| **可移植性** | ✅ 复制一个文件夹即可 | ❌ 框架依赖 | ❌ 框架依赖 | ❌ 云服务 | ❌ IDE 插件 |
| **本地自托管** | ✅ 完全本地 | ✅ | ✅ | ❌ | ❌ |
| **经验积累** | ✅ 项目专属经验库 | ❌ | ❌ | ❌ | ❌ |

**优势亮点 🌟**

- **Token 成本控制** — 文件引用协议 + KV 缓存提示词结构，在大型代码库上运行成本显著低于同类框架。
- **可复现性** — 确定性的 `初始化 → 分析 → 架构 → 编码 → 测试` 流水线，每个决策均记录在 `docs/decision-log.md`。
- **零锁定** — 无云依赖，无专有 API，只需提供一个异步函数即可接入任意 LLM。
- **可移植性** — 整个工作流是一个自包含文件夹，拷贝到任意项目，一条命令启动。

**权衡取舍 ⚖️**

- **流水线拓扑固定** — 如需动态 Agent 图（Agent 动态生成子 Agent），AutoGen 或 LangGraph 更灵活。
- **无内置 UI** — 仅提供 CLI/库形式，Devin 和 Cursor 提供精美 GUI。
- **依赖 Node.js ≥ 16** — Python 优先的团队可能更倾向于 AutoGen 或 CrewAI。

---

### � 快速开始

**前置条件：** Node.js ≥ 16 · Git · [GitHub CLI](https://cli.github.com) `gh`（可选）

```bash
# 1. 克隆并安装依赖
git clone https://github.com/kenGH12345/WorkFlowAgent.git
cd WorkFlowAgent/workflow && npm install

# 2. 初始化到你的项目（自动检测技术栈）
node workflow/init-project.js
```

```javascript
// 3. 运行工作流
const { Orchestrator } = require('./workflow');

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: async (prompt) => {
    // 接入任意 LLM：OpenAI、Claude、Gemini、本地 Ollama…
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] }),
    });
    return (await res.json()).choices[0].message.content;
  },
  projectRoot: '/path/to/your/project',
  git: { enabled: true, autoPush: true },  // 可选：自动发起 PR
  dryRun: false,                            // 设为 true 可预览变更
});

await orchestrator.run('为用户管理构建一个包含 CRUD 操作的 REST API');
```

---

### ⚙️ 配置说明

`workflow.config.js` 由 `init-project.js` 自动生成，可按需定制：

```javascript
module.exports = {
  projectName: 'MyProject',
  techStack: 'TypeScript / Node.js',
  sourceExtensions: ['.ts', '.tsx'],
  ignoreDirs: ['node_modules', '.git', 'dist'],
  git: {
    enabled: true,
    baseBranch: 'main',
    autoPush: true,
    draft: false,
    labels: ['ai-generated'],
  },
  sandbox: {
    dryRun: false,
  },
};
```

---

### 🧪 运行测试

```bash
cd workflow
npm test            # 运行全部测试
npm run test:unit   # 仅单元测试
npm run test:e2e    # 仅端到端测试
```

---

### 📦 迁移到其他项目

```bash
# 1. 复制 workflow 文件夹
cp -r WorkFlowAgent/workflow /path/to/your-project/

# 2. 安装依赖
cd /path/to/your-project/workflow && npm install

# 3. 一键初始化（自动检测技术栈）
node workflow/init-project.js
```

---

### 🤝 参与贡献

欢迎提交 Pull Request！重大变更请先开 Issue 讨论。

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/amazing-feature`
3. 提交变更：`git commit -m 'feat: add amazing feature'`
4. 推送并发起 Pull Request

---

## 📄 License

[MIT](LICENSE) © 2026 WorkFlowAgent Contributors
