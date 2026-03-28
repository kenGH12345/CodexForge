## 📊 Business Logic Diagrams

> Generated: 2026-03-24
> View in VS Code, GitHub, or any Mermaid-compatible viewer

### 🚪 Entry Point Flow Diagram

> Shows business flows from entry points (max 5 flows, depth 4)

```mermaid
graph TD
  n_getPurposeMapForFile["getPurposeMapForFile"]:::controller

  n_computeThinness["computeThinness"]:::service

  n_validateConfig["validateConfig"]:::service

  n_readLines["readLines"]:::controller

  n_createAgentContract["createAgentContract"]:::controller

  n_getCurrentVersion["getCurrentVersion"]:::controller

  n_risks["risks"]:::core

  n_getCurrentVersion --> n_risks

  n_block["block"]:::core

  n_risks --> n_block

  n_Orchestrator["Orchestrator"]:::core

  n_block --> n_Orchestrator
  n_listMigrations["listMigrations"]:::controller


  n_listMigrations --> n_risks


  n_risks --> n_block


  n_block --> n_Orchestrator

  n_entry["entry"]:::core

  n_createAgentContract --> n_entry


  n_entry --> n_block


  n_block --> n_Orchestrator

  n_existing["existing"]:::core

  n_validateConfig --> n_existing

  n_high["high"]:::core

  n_existing --> n_high


  n_high --> n_block


  n_block --> n_Orchestrator


  n_readLines --> n_high


  n_high --> n_block


  n_block --> n_Orchestrator
  n_Orchestrator -.->|alt| n_existing
  n_Orchestrator -.->|alt| n_high
  n_Orchestrator -.->|alt| n_existing
  n_Orchestrator -.->|alt| n_high
  n_Orchestrator -.->|alt| n_existing
  n_Orchestrator -.->|alt| n_high

  classDef handler fill:#e1f5fe,stroke:#01579b,stroke-width:2px
  classDef controller fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
  classDef service fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
  classDef job fill:#fff3e0,stroke:#e65100,stroke-width:2px
  classDef core fill:#fce4ec,stroke:#880e4f,stroke-width:2px
  classDef util fill:#f5f5f5,stroke:#616161,stroke-width:1px
  classDef default fill:#ffffff,stroke:#333,stroke-width:1px
```

### 🏗️ Core Service Dependency Diagram

> Shows core services and their top callers (max 7 services)

```mermaid
graph LR
  n_Orchestrator["Orchestrator<br/>(718 refs)"]:::core
  n_workflow_agents_base_agent_js_["workflow/agents/base-agent.js::BaseAgent"]:::caller
  n_workflow_agents_base_agent_js_ --> n_Orchestrator
  n_workflow_agents_base_agent_js_["workflow/agents/base-agent.js::run"]:::caller
  n_workflow_agents_base_agent_js_ --> n_Orchestrator
  n_workflow_agents_base_agent_js_["workflow/agents/base-agent.js::buildPrompt"]:::caller
  n_workflow_agents_base_agent_js_ --> n_Orchestrator
  n_search["search<br/>(600 refs)"]:::core
  n_workflow_agents_analyst_agent_["workflow/agents/analyst-agent.js::extractAnchorFiles"]:::caller
  n_workflow_agents_analyst_agent_ --> n_search
  n_workflow_agents_analyst_agent_["workflow/agents/analyst-agent.js::anchorNames"]:::caller
  n_workflow_agents_analyst_agent_ --> n_search
  n_workflow_agents_analyst_agent_["workflow/agents/analyst-agent.js::AnalystAgent"]:::caller
  n_workflow_agents_analyst_agent_ --> n_search
  n_CodeGraph["CodeGraph<br/>(300 refs)"]:::core
  n_workflow_commands_commands_dev["workflow/commands/commands-devtools.js::registerDevToolsCommands"]:::caller
  n_workflow_commands_commands_dev --> n_CodeGraph
  n_workflow_commands_commands_dev["workflow/commands/commands-devtools.js::loadGraph"]:::caller
  n_workflow_commands_commands_dev --> n_CodeGraph
  n_workflow_commands_commands_dev["workflow/commands/commands-devtools.js::trendIcon"]:::caller
  n_workflow_commands_commands_dev --> n_CodeGraph
  n_Observability["Observability<br/>(227 refs)"]:::core
  n_workflow_commands_commands_dev --> n_Observability
  n_workflow_commands_commands_dev --> n_Observability
  n_workflow_commands_commands_dev --> n_Observability
  n_isolated["isolated<br/>(222 refs)"]:::core
  n_workflow_agents_tester_agent_j["workflow/agents/tester-agent.js::TesterAgent"]:::caller
  n_workflow_agents_tester_agent_j --> n_isolated
  n_workflow_agents_tester_agent_j["workflow/agents/tester-agent.js::constructor"]:::caller
  n_workflow_agents_tester_agent_j --> n_isolated
  n_workflow_agents_tester_agent_j["workflow/agents/tester-agent.js::buildPrompt"]:::caller
  n_workflow_agents_tester_agent_j --> n_isolated
  n_primary["primary<br/>(222 refs)"]:::core
  n_workflow_commands_commands_dev --> n_primary
  n_workflow_commands_commands_dev --> n_primary
  n_workflow_commands_commands_dev --> n_primary
  n_buildAgentPrompt["buildAgentPrompt<br/>(218 refs)"]:::core
  n_workflow_core_code_graph_js___["workflow/core/code-graph.js::_inferModuleDescription"]:::caller
  n_workflow_core_code_graph_js___ --> n_buildAgentPrompt
  n_workflow_core_code_graph_js__C["workflow/core/code-graph.js::CodeGraph"]:::caller
  n_workflow_core_code_graph_js__C --> n_buildAgentPrompt
  n_workflow_core_code_graph_js__b["workflow/core/code-graph.js::build"]:::caller
  n_workflow_core_code_graph_js__b --> n_buildAgentPrompt

  classDef core fill:#ffcdd2,stroke:#c62828,stroke-width:3px
  classDef caller fill:#c8e6c9,stroke:#2e7d32,stroke-width:1px
```

### 📈 Call Graph Overview

> Shows top connected symbols (high in-degree = widely used)

```mermaid
graph TD
  subgraph Hub["🔄 Hub"]
    n_Orchestrator["Orchestrator<br/>(718)"]
    n_search["search<br/>(600)"]
  end
  subgraph Utility["🔧 Utility"]
    n_block["block<br/>(860)"]
    n_high["high<br/>(826)"]
    n_existing["existing<br/>(810)"]
    n_entry["entry<br/>(765)"]
  end
  n_getCurrentVersion --> n_risks
  n_risks --> n_block
  n_block --> n_Orchestrator
  n_listMigrations --> n_risks
  n_risks --> n_block
  n_block --> n_Orchestrator
  n_createAgentContract --> n_entry
  n_entry --> n_block
  n_block --> n_Orchestrator
  n_validateConfig --> n_existing
  n_existing --> n_high
  n_high --> n_block
  n_readLines --> n_high
  n_high --> n_block
  n_block --> n_Orchestrator
  n_parseArgs --> n_ExperienceStore
  n_ExperienceStore --> n_existing
  n_existing --> n_high
  n_parseArgs --> n_ExperienceStore
  n_ExperienceStore --> n_existing
  n_existing --> n_high
  n_parseArgs --> n_ExperienceStore
  n_ExperienceStore --> n_existing
  n_existing --> n_high
```

### 🔄 Top Business Flow Sequence

> Sequence diagram for: **getCurrentVersion**

```mermaid
sequenceDiagram
    autonumber
    participant n_getCurrentVersion as getCurrentVersion
    participant n_risks as risks
    participant n_block as block
    participant n_Orchestrator as Orchestrator
    n_getCurrentVersion->>n_risks: call
    n_risks->>n_block: call
    n_block->>n_Orchestrator: call
    n_Orchestrator-->>n_block: return
    n_block-->>n_risks: return
    n_risks-->>n_getCurrentVersion: return
```

> **Alternative paths:** 8 branches detected
> - `Orchestrator` → `existing` (depth: 2)
> - `Orchestrator` → `high` (depth: 2)
> - `block` → `search` (depth: 1)

### 📊 Data Flow Diagram

> Shows parameter/data flow between functions

```mermaid
graph LR
  n_getCurrentVersion["getCurrentVersion"]
  n_risks["risks"]
  n_getCurrentVersion -->|<325 callers>| n_risks
  n_block["block"]
  n_risks -->|<860 callers>| n_block
  n_Orchestrator["Orchestrator"]
  n_block -->|<718 callers>| n_Orchestrator
  n_listMigrations["listMigrations"]
  n_listMigrations -->|<325 callers>| n_risks
  n_createAgentContract["createAgentContract"]
  n_entry["entry"]
  n_createAgentContract -->|<765 callers>| n_entry
  n_entry -->|<860 callers>| n_block
  n_validateConfig["validateConfig"]
  n_existing["existing"]
  n_validateConfig -->|<810 callers>| n_existing
  n_high["high"]
  n_existing -->|<826 callers>| n_high
  n_high -->|<860 callers>| n_block
  n_Orchestrator -->|<860 callers>| n_block
  n_readLines["readLines"]
  n_readLines -->|<826 callers>| n_high
  n_parseArgs["parseArgs"]
  n_ExperienceStore["ExperienceStore"]
  n_parseArgs -->|<476 callers>| n_ExperienceStore
```

---

### 📌 How to View

1. **VS Code**: Install "Markdown Preview Mermaid Support" extension
2. **GitHub**: Diagrams render automatically in .md files
3. **Online**: Paste at [Mermaid Live Editor](https://mermaid.live/)
4. **Notion**: Use Mermaid code block
