
<![CDATA[<div align="center">

# 🤖 WorkFlowAgent

**An AI-native multi-agent workflow engine for automated software development**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D16.0.0-brightgreen)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/kenGH12345/WorkFlowAgent/pulls)

[English](#english) · [快速开始](#quick-start) · [与同类框架对比](#comparison)

</div>

---

## What is WorkFlowAgent?

WorkFlowAgent is a **portable, LLM-agnostic multi-agent workflow engine** that turns a single natural-language requirement into production-ready code through a structured pipeline of specialised AI agents.

Unlike monolithic AI coding assistants, WorkFlowAgent enforces **strict role boundaries** between agents (Analyst → Architect → Developer → Tester), uses a **file-reference communication protocol** to eliminate token waste, and ships with a **one-command project initialiser** that auto-detects your tech stack.

```
User Requirement
      │
      ▼
┌─────────────┐    ┌──────────────┐    ┌───────────────┐    ┌────────────┐
│  Analyst    │───▶│  Architect   │───▶│  Developer    │───▶│  Tester    │
│  Agent      │    │  Agent       │    │  Agent        │    │  Agent     │
│             │    │              │    │               │    │            │
│ requirement │    │architecture  │    │  code.diff    │    │test-report │
│    .md      │    │    .md       │    │               │    │    .md     │
└─────────────┘    └──────────────┘    └───────────────┘    └────────────┘
      │                  │                    │                    │
      └──────────────────┴────────────────────┴────────────────────┘
                                    │
                              manifest.json
                           (checkpoint resume)
```

---

## ✨ Core Features

| Feature | Description |
|---------|-------------|
| 🧩 **Multi-Agent Pipeline** | Analyst → Architect → Developer → Tester, each with strict role boundaries |
| 📁 **File-Reference Protocol** | Agents communicate via file paths only — zero raw-content token waste |
| ♻️ **Checkpoint Resume** | Every state transition persists to `manifest.json`; interrupted runs resume automatically |
| 🔍 **Socratic Decision Engine** | Structured multiple-choice checkpoints replace free-form review prompts |
| 🧠 **KV-Cache Optimised Prompts** | Fixed prefix + dynamic suffix structure maximises LLM cache hit rate |
| 📦 **Thin / Thick Tools** | Auto-selects summarised tools for large monorepos (≥500 files) to cut token cost |
| 🌿 **Git PR Automation** | Auto-creates feature branches, commits artifacts, and opens GitHub / GitLab PRs |
| 🏖️ **Dry-Run / Sandbox Mode** | Preview all file changes before applying them to the real filesystem |
| 🔌 **MCP Integration** | Plug in TAPD, CI systems, or any external tool via the MCP adapter layer |
| 🚀 **One-Command Init** | Auto-detects tech stack and bootstraps the full workflow in a single command |
| 📚 **Experience Store** | Accumulates project-specific knowledge across sessions for smarter suggestions |
| 🎯 **Skill Evolution** | Domain skill files grow richer as the agent learns from each completed task |

---

## <a name="comparison"></a> 🆚 Comparison with Similar Frameworks

> How does WorkFlowAgent compare to other popular AI agent / coding-assistant frameworks?

| | **WorkFlowAgent** | **AutoGen** | **CrewAI** | **Devin / SWE-agent** | **Cursor / Copilot** |
|---|---|---|---|---|---|
| **Primary focus** | Structured software dev pipeline | General multi-agent conversations | Role-based task crews | Autonomous coding agent | IDE-integrated code completion |
| **Agent roles** | Fixed pipeline (Analyst→Architect→Dev→Test) | Flexible, user-defined | Flexible, user-defined | Single agent loop | Single assistant |
| **Communication** | File-reference protocol (zero raw content) | In-memory message passing | In-memory message passing | Tool calls + scratchpad | Context window |
| **Token efficiency** | ✅ KV-cache optimised, thin/thick tool selection | ❌ Full message history | ❌ Full message history | ❌ Long scratchpad | ✅ IDE context trimming |
| **Checkpoint / resume** | ✅ `manifest.json` per stage | ❌ | ❌ | ❌ | N/A |
| **LLM agnostic** | ✅ Bring your own `llmCall` function | ✅ | ✅ | ❌ (proprietary) | ❌ (proprietary) |
| **Git PR automation** | ✅ Built-in (GitHub CLI / GitLab CLI) | ❌ | ❌ | ✅ | ❌ |
| **Dry-run / sandbox** | ✅ Full file-write interception | ❌ | ❌ | ❌ | ❌ |
| **Tech-stack auto-detect** | ✅ One-command init | ❌ Manual config | ❌ Manual config | N/A | ✅ IDE-native |
| **Portability** | ✅ Copy one folder to any project | ❌ Framework dependency | ❌ Framework dependency | ❌ Cloud service | ❌ IDE plugin |
| **Self-hosted** | ✅ Fully local | ✅ | ✅ | ❌ | ❌ |
| **Experience accumulation** | ✅ Per-project experience store | ❌ | ❌ | ❌ | ❌ |

### Where WorkFlowAgent shines 🌟

- **Token cost control** — The file-reference protocol and KV-cache prompt structure make it significantly cheaper to run on large codebases compared to frameworks that pass full content between agents.
- **Reproducibility** — The deterministic `INIT → ANALYSE → ARCHITECT → CODE → TEST` pipeline produces consistent, auditable outputs. Every decision is logged in `docs/decision-log.md`.
- **Zero lock-in** — No cloud dependency, no proprietary API. Plug in any LLM by providing a single async function.
- **Portability** — The entire workflow is a self-contained folder. Drop it into any project and run one command.

### Where WorkFlowAgent has trade-offs ⚖️

- **Less flexible agent topology** — The pipeline is intentionally fixed. If you need dynamic agent graphs (e.g., agents spawning sub-agents on the fly), AutoGen or LangGraph offer more flexibility.
- **No built-in UI** — WorkFlowAgent is a Node.js library / CLI tool. Devin and Cursor provide polished GUIs.
- **Requires Node.js ≥ 16** — Python-first teams may prefer AutoGen or CrewAI.

---

## <a name="quick-start"></a> 🚀 Quick Start

### Prerequisites

- Node.js ≥ 16
- Git (optional, for PR automation)
- [GitHub CLI](https://cli.github.com) `gh` (optional, for auto PR creation)

### 1. Clone & install

```bash
git clone https://github.com/kenGH12345/WorkFlowAgent.git
cd WorkFlowAgent/workflow
npm install
```

### 2. Initialise for your project

```bash
# Copy the workflow/ folder into your project, then:
node workflow/init-project.js
```

The initialiser auto-detects your tech stack (Unity/C#, Go, TypeScript, Python, Java, …) and generates a ready-to-use `workflow.config.js`.

### 3. Run a workflow

```javascript
const { Orchestrator } = require('./workflow');

const orchestrator = new Orchestrator({
  projectId: 'my-project-001',
  llmCall: async (prompt) => {
    // Plug in any LLM: OpenAI, Claude, Gemini, local Ollama, …
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }] }),
    });
    return (await res.json()).choices[0].message.content;
  },
  projectRoot: '/path/to/your/project',
  git: { enabled: true, autoPush: true },   // optional: auto PR
  dryRun: false,                             // set true to preview changes
});

await orchestrator.run('Build a REST API for user management with CRUD operations');
```

### 4. Use slash commands

```javascript
const { dispatch } = require('./workflow/commands/command-router');

await dispatch('/ask-workflow-agent Build a todo app', { orchestrator });
await dispatch('/workflow-status', {});
await dispatch('/workflow-artifacts', {});
```

---

## 📁 Project Structure

```
WorkFlowAgent/
├── workflow/                    # ← The portable workflow engine
│   ├── index.js                 # Orchestrator entry point
│   ├── package.json
│   ├── workflow.config.js       # Project-specific configuration
│   ├── init-project.js          # One-command project initialiser
│   ├── gen-agents.js            # AGENTS.md generator
│   ├── setup-git.js             # Git + GitHub CLI setup wizard
│   ├── agents/                  # Specialist agents
│   │   ├── analyst-agent.js
│   │   ├── architect-agent.js
│   │   ├── developer-agent.js
│   │   └── tester-agent.js
│   ├── core/                    # Core services
│   │   ├── state-machine.js     # Workflow state + manifest checkpoint
│   │   ├── git-integration.js   # Branch / commit / PR automation
│   │   ├── sandbox.js           # Dry-run file-write interception
│   │   ├── prompt-builder.js    # KV-cache optimised prompt assembly
│   │   ├── experience-store.js  # Per-project experience accumulation
│   │   ├── skill-evolution.js   # Domain skill knowledge growth
│   │   └── …
│   ├── commands/                # Slash command dispatcher
│   ├── hooks/                   # Lifecycle hooks & MCP adapters
│   ├── skills/                  # Domain skill knowledge files
│   ├── tools/                   # Thin / thick tool adapters
│   ├── output/                  # All agent artifacts land here
│   └── tests/                   # Unit + E2E test suite
└── AGENTS.md                    # AI agent entry point index
```

---

## ⚙️ Configuration

`workflow.config.js` is auto-generated by `init-project.js` and can be customised:

```javascript
module.exports = {
  projectName: 'MyProject',
  techStack: 'TypeScript / Node.js',
  sourceExtensions: ['.ts', '.tsx'],
  ignoreDirs: ['node_modules', '.git', 'dist'],
  builtinSkills: [
    { name: 'workflow-orchestration', description: 'Multi-agent workflow SOP', domains: ['workflow'] },
    { name: 'code-review', description: 'Code review best practices', domains: ['quality'] },
  ],
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

## 🔌 MCP Integration

Connect external tools (TAPD, CI systems, etc.) via the MCP adapter layer:

```javascript
const { MCPRegistry, TAPDAdapter, DevToolsAdapter } = require('./workflow/hooks/mcp-adapter');

const registry = new MCPRegistry();
registry.register(new TAPDAdapter({ workspaceId: 'your-workspace', accessToken: 'token' }));
registry.register(new DevToolsAdapter({ ciApiBase: 'https://ci.example.com' }));
await registry.connectAll();
```

---

## 🧪 Running Tests

```bash
cd workflow
npm test          # run all tests
npm run test:unit # unit tests only
npm run test:e2e  # end-to-end tests only
```

---

## 📦 Migrating to Another Project

The workflow engine is fully decoupled from any specific project. To use it in a new codebase:

```bash
# 1. Copy the workflow folder
cp -r WorkFlowAgent/workflow /path/to/your-project/

# 2. Install dependencies
cd /path/to/your-project/workflow && npm install

# 3. One-command init (auto-detects tech stack)
node workflow/init-project.js
```

See [`workflow/README.md`](workflow/README.md) for the full migration guide, CLI options, and customisation examples.

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

[MIT](LICENSE) © 2026 WorkFlowAgent Contributors
]]>
