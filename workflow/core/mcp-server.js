/**
 * MCP Server – Model Context Protocol Server for WorkFlowAgent
 *
 * Exposes WorkFlowAgent capabilities as MCP tools that any IDE
 * (Cursor, VS Code, Claude Code, Windsurf, etc.) can call via
 * the standard MCP protocol over stdio transport.
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON)
 * Spec: https://modelcontextprotocol.io/specification
 *
 * Design:
 *   - Zero external dependencies (uses Node.js built-in readline + process.stdin/stdout)
 *   - Implements MCP initialize/initialized handshake
 *   - Exposes workflow tools: workflow_triage, workflow_run, workflow_init, workflow_status
 *   - RequestTriage auto-routes simple tasks back to IDE
 *   - Graceful shutdown on SIGTERM/SIGINT
 *
 * Usage:
 *   # Start as stdio MCP server (for IDE integration)
 *   node workflow/core/mcp-server.js --project-root /path/to/project
 *
 *   # Or via command:
 *   /serve-mcp [--project-root <dir>]
 *
 * MCP Client Config (e.g. claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "workflowagent": {
 *         "command": "node",
 *         "args": ["workflow/core/mcp-server.js", "--project-root", "/path/to/project"]
 *       }
 *     }
 *   }
 *
 * @module mcp-server
 */

'use strict';

const readline = require('readline');
const path = require('path');
const fs = require('fs');

// Handlers extracted in Step 2 refactoring
const { createAllHandlers } = require('./mcp/handlers');

// ─── MCP Protocol Constants ─────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'workflowagent';
const SERVER_VERSION = '1.0.0';

// ─── Tool Definitions ───────────────────────────────────────────────────────

/**
 * MCP tool definitions exposed to the IDE.
 * Each tool has a name, description, and inputSchema (JSON Schema).
 *
 * ADR-XX Dual Mode Synchronization: All capabilities must exist in both
 * Node Orchestrator (CLI) and IDE Agent (MCP) modes.
 */
const TOOL_REGISTRY = [
  // ─── Core Workflow Tools ─────────────────────────────────────────────────
  {
    name: 'workflow_triage',
    handler: '_handleWorkflowTriage',
    description: 'Evaluate a requirement\'s complexity and get routing recommendation. Returns whether to use IDE directly, lightweight workflow, or full pipeline. Zero LLM cost — pure rule engine.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement text to evaluate for complexity routing',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_run',
    handler: '_handleWorkflowRun',
    description: 'Execute the full WorkFlowAgent pipeline for a requirement. Automatically triages complexity first — if the task is too simple, returns a suggestion to handle it directly in IDE. Use --force to bypass triage.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement to implement',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'sequential', 'parallel'],
          description: 'Execution mode. auto=LLM decides, sequential=full pipeline, parallel=task decomposition. Default: auto.',
        },
        force: {
          type: 'boolean',
          description: 'Skip complexity triage and force workflow execution. Default: false.',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_init',
    handler: '_handleWorkflowInit',
    description: 'Initialize WorkFlowAgent for a project. Detects tech stack, generates config, builds CodeGraph, creates project profile. Must run before workflow_run on new projects.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root directory. Defaults to the configured project root.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview what would be done without making changes. Default: false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_status',
    handler: '_handleWorkflowStatus',
    description: 'Get the current workflow status, including init state, staleness warnings, and active workflow progress.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ─── Skill Management Tools ──────────────────────────────────────────────
  {
    name: 'workflow_skill_discover',
    handler: '_handleSkillDiscover',
    description: 'Auto-discover project conventions from package.json, CI configs, linters, etc. Creates skill entries for tech stack specific patterns. Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root directory',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_skill_evolve',
    handler: '_handleSkillEvolve',
    description: 'Trigger skill evolution for existing skills. Consolidates experience entries into skill rules. Zero LLM cost for basic evolution; LLM-Lite for refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Specific skill to evolve (optional, evolves all if omitted)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_skill_update',
    handler: '_handleSkillUpdate',
    description: 'Directly update skill content with new rules or checklists. For manual skill curation.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Name of the skill to update',
        },
        section: {
          type: 'string',
          enum: ['rules', 'best_practices', 'anti_patterns', 'checklist'],
          description: 'Section to append content to',
        },
        content: {
          type: 'string',
          description: 'Content to append to the section',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['skillName', 'section', 'content'],
    },
  },
  {
    name: 'workflow_skill_refine_check',
    handler: '_handleSkillRefineCheck',
    description: 'Identify skills that need refinement based on evolution count or staleness. Returns candidates for LLM refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: {
          type: 'number',
          description: 'Evolution count threshold (default: 5)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },

  // ─── Experience Store Tools ─────────────────────────────────────────────
  {
    name: 'workflow_experience_search',
    handler: '_handleExperienceSearch',
    description: 'Search ExperienceStore by keyword, skill, or tags. Returns relevant experiences for context injection.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or phrase',
        },
        skill: {
          type: 'string',
          description: 'Filter by specific skill name',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'workflow_experience_context',
    handler: '_handleExperienceContext',
    description: 'Get formatted context block for a specific skill from ExperienceStore. Ready for prompt injection.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to get context for',
        },
        limit: {
          type: 'number',
          description: 'Max experiences to include (default: 5)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['skill'],
    },
  },
  {
    name: 'workflow_experience_record',
    handler: '_handleExperienceRecord',
    description: 'Record a new experience to ExperienceStore. Captures patterns, solutions, and outcomes for future reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Experience title',
        },
        content: {
          type: 'string',
          description: 'Experience content/description',
        },
        skill: {
          type: 'string',
          description: 'Associated skill name',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
        outcome: {
          type: 'string',
          enum: ['success', 'partial', 'failure'],
          description: 'Outcome of the experience',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['title', 'content', 'skill'],
    },
  },
  {
    name: 'workflow_experience_evolve',
    handler: '_handleExperienceEvolve',
    description: 'Trigger experience evolution: consolidation, distillation, and archival. Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview changes without applying',
        },
      },
      required: [],
    },
  },

  // ─── Context and Prompt Tools ────────────────────────────────────────────
  {
    name: 'workflow_context',
    handler: '_handleContext',
    description: 'Load context (skills, ADRs, docs) for a specific workflow stage. Returns formatted context block.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['INIT', 'ANALYSE', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'DEPLOY'],
          description: 'Workflow stage to load context for',
        },
        task: {
          type: 'string',
          description: 'Task description for skill matching',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage', 'task'],
    },
  },
  {
    name: 'workflow_build_agent_prompt',
    handler: '_handleBuildAgentPrompt',
    description: 'Build role-specific agent prompt with constraints and context for a workflow stage.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['INIT', 'ANALYSE', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'DEPLOY'],
          description: 'Workflow stage for the agent',
        },
        task: {
          type: 'string',
          description: 'Task description',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage', 'task'],
    },
  },

  // ─── Quality and Review Tools ────────────────────────────────────────────
  {
    name: 'workflow_quality_check',
    handler: '_handleQualityCheck',
    description: 'Run local QualityGate rule checks on modified or staged files. Returns violations and suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to check (uses staged files if omitted)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_quality_gate',
    handler: '_handleQualityGate',
    description: 'Run full QualityGate threshold validation across all dimensions for current state.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Specific stage to validate (optional)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_quality_gate_validate_stage',
    handler: '_handleQualityGateValidateStage',
    description: 'Validate a specific workflow stage against stage-specific quality gates. P0-Enhancement for early error detection.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST'],
          description: 'Stage identifier to validate',
        },
        errorCount: {
          type: 'number',
          description: 'Number of errors detected in the stage',
        },
        durationMs: {
          type: 'number',
          description: 'Stage execution duration in milliseconds',
        },
        llmCalls: {
          type: 'number',
          description: 'Number of LLM calls made during the stage',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage'],
    },
  },
  {
    name: 'workflow_quality_gate_diagnostics',
    handler: '_handleQualityGateDiagnostics',
    description: 'Export diagnostic history and statistics from QualityGate for analysis before switching from diagnostic to default mode.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        clear: {
          type: 'boolean',
          description: 'Clear diagnostic history after export (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_deep_audit',
    handler: '_handleDeepAudit',
    description: 'Run DeepAuditOrchestrator across all 7 dimensions (token, complexity, dependency, etc). Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output format (default: markdown)',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_rollback_check',
    handler: '_handleRollbackCheck',
    description: 'Validate stage output against downstream Agent input contracts. Detects breaking changes.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Stage to check rollback for',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage'],
    },
  },

  // ─── Testing Tools ───────────────────────────────────────────────────────
  {
    name: 'workflow_test_execute',
    handler: '_handleTestExecute',
    description: 'Execute project tests with auto-detection of test framework. Captures results for experience recording.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Test pattern/file to run',
        },
        watch: {
          type: 'boolean',
          description: 'Watch mode (default: false)',
        },
        testProfile: {
          type: 'string',
          enum: ['fast', 'full'],
          description: 'Test profile mode (fast: smoke+unit, full: smoke+unit+integration)',
        },
        testSuites: {
          type: 'string',
          description: 'Comma-separated test suites to run (e.g. smoke,unit)',
        },
        testFiles: {
          type: 'string',
          description: 'Comma-separated file tokens for targeted rerun',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },

  // ─── Staleness and Health Tools ──────────────────────────────────────────
  {
    name: 'workflow_staleness_check',
    handler: '_handleStalenessCheck',
    description: 'Check for stale artifacts (CodeGraph, project profile) that need refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
];

// ─── API Compatibility Layer ───────────────────────────────────────────────────────────────
// TOOLS exports pure schema array (backward compatible) — handler references stripped.
const TOOLS = TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));


// ─── MCPServer Class ────────────────────────────────────────────────────────

class MCPServer {
  /**
   * @param {object} opts
   * @param {string}   [opts.projectRoot]          - Project root directory
   * @param {Function} [opts.orchestratorFactory]   - (opts) => Orchestrator instance
   * @param {Function} [opts.llmCall]              - async (prompt) => string
   * @param {object}   [opts.IDE_TOOLS]            - IDE tool functions injection
   * @param {Function} [opts.IDE_TOOLS.codebaseSearch]  - IDE semantic search function
   * @param {Function} [opts.IDE_TOOLS.grepSearch]      - IDE text search function
   * @param {Function} [opts.IDE_TOOLS.viewCodeItem]    - IDE symbol lookup function
   * @param {Function} [opts.IDE_TOOLS.readFile]        - IDE file read function
   * @param {Function} [opts.IDE_TOOLS.listDir]          - IDE directory listing function
   * @param {Array}    [opts.toolsForAnalysis]     - Additional analysis tools for triage
   */
  constructor(opts = {}) {
    this._projectRoot = opts.projectRoot || process.cwd();
    this._orchestratorFactory = opts.orchestratorFactory || null;
    this._llmCall = opts.llmCall || null;
    this._initialized = false;
    this._rl = null;
    this._requestHandlers = new Map();
    this._notificationHandlers = new Map();
    this._currentWorkflow = null;

    // Lazy-load RequestTriage (avoid circular deps)
    this._triage = null;

    // ─── Tool Function Injection (IDE-First Alignment) ─────────────────────────
    // ADR-37: When running in IDE environment, MCP Server can receive IDE tool
    // functions to enable consistent tool usage across Node Orchestrator and
    // IDE Agent modes. These are injected during server initialization.
    this._toolFunctions = {
      // IDE-native tools (injected from host)
      codebaseSearch: opts.IDE_TOOLS?.codebaseSearch || null,
      grepSearch: opts.IDE_TOOLS?.grepSearch || null,
      viewCodeItem: opts.IDE_TOOLS?.viewCodeItem || null,
      readFile: opts.IDE_TOOLS?.readFile || null,
      listDir: opts.IDE_TOOLS?.listDir || null,

      // Additional analysis tools for hybrid mode
      toolsForAnalysis: opts.toolsForAnalysis || [],
    };

    // Verify tool injection status (for debugging)
    this._ideToolCount = Object.values(this._toolFunctions)
      .filter(v => typeof v === 'function').length;
    if (this._ideToolCount > 0) {
      this._log(`IDE tools injected: ${this._ideToolCount} tool(s) available`);
    }

    // Register MCP method handlers
    // Build tool handler routing map from registry (eliminates switch/case)
    this._toolHandlerMap = new Map(TOOL_REGISTRY.map(t => [t.name, t.handler]));

    // ─── Step 2 Refactoring: Mix in extracted handlers ──────────────────────────
    // Handlers are extracted to mcp/handlers/ for modularity
    this._externalHandlers = createAllHandlers(this);

    // Dev-time consistency check: ensure every registered tool has a handler method
    // (Either internal or from external handlers)
    if (process.env.NODE_ENV !== 'production') {
      for (const tool of TOOL_REGISTRY) {
        const hasInternal = typeof this[tool.handler] === 'function';
        const hasExternal = typeof this._externalHandlers[tool.handler] === 'function';
        if (!hasInternal && !hasExternal) {
          throw new Error(`[TOOL_REGISTRY] Handler "${tool.handler}" for tool "${tool.name}" not found`);
        }
      }
    }

    this._registerHandlers();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Starts the MCP server on stdio transport.
   * Reads JSON-RPC messages from stdin, writes responses to stdout.
   */
  start() {
    // All non-protocol output goes to stderr (MCP spec requirement)
    this._log('Starting MCP Server...');
    this._log(`Project root: ${this._projectRoot}`);

    this._rl = readline.createInterface({
      input: process.stdin,
      output: undefined, // We write to stdout manually
      terminal: false,
    });

    // Buffer for incomplete messages
    let buffer = '';

    process.stdin.on('data', (chunk) => {
      buffer += chunk.toString();

      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const message = JSON.parse(trimmed);
          this._handleMessage(message).catch(err => {
            this._log(`Error handling message: ${err.message}`);
          });
        } catch (parseErr) {
          this._log(`Failed to parse JSON-RPC message: ${parseErr.message}`);
          this._log(`Raw line: ${trimmed.slice(0, 200)}`);
        }
      }
    });

    process.stdin.on('end', () => {
      this._log('stdin closed. Shutting down.');
      process.exit(0);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => { this._log('SIGTERM received.'); process.exit(0); });
    process.on('SIGINT', () => { this._log('SIGINT received.'); process.exit(0); });

    this._log('MCP Server ready. Waiting for JSON-RPC messages on stdin...');
  }

  // ─── Message Handling ─────────────────────────────────────────────────

  /**
   * Routes an incoming JSON-RPC message to the appropriate handler.
   * @param {object} message
   */
  async _handleMessage(message) {
    // JSON-RPC 2.0 request (has id + method)
    if (message.id !== undefined && message.method) {
      return this._handleRequest(message);
    }

    // JSON-RPC 2.0 notification (has method but no id)
    if (message.method && message.id === undefined) {
      return this._handleNotification(message);
    }

    // Response (has id but no method) — ignore (we don't make outgoing requests)
    if (message.id !== undefined && !message.method) {
      return;
    }

    this._log(`Unknown message format: ${JSON.stringify(message).slice(0, 200)}`);
  }

  /**
   * Handles a JSON-RPC request (expects a response).
   * @param {object} req - { jsonrpc, id, method, params }
   */
  async _handleRequest(req) {
    const handler = this._requestHandlers.get(req.method);

    if (!handler) {
      this._sendError(req.id, -32601, `Method not found: ${req.method}`);
      return;
    }

    try {
      const result = await handler(req.params || {});
      this._sendResult(req.id, result);
    } catch (err) {
      this._log(`Handler error for ${req.method}: ${err.message}`);
      this._sendError(req.id, -32603, err.message);
    }
  }

  /**
   * Handles a JSON-RPC notification (no response expected).
   * @param {object} notif - { jsonrpc, method, params }
   */
  async _handleNotification(notif) {
    const handler = this._notificationHandlers.get(notif.method);
    if (handler) {
      try {
        await handler(notif.params || {});
      } catch (err) {
        this._log(`Notification handler error for ${notif.method}: ${err.message}`);
      }
    }
    // Notifications don't require a response per spec
  }

  // ─── MCP Protocol Handlers ────────────────────────────────────────────

  _registerHandlers() {
    // ── MCP Handshake ─────────────────────────────────────────────────────
    this._requestHandlers.set('initialize', async (params) => {
      this._log(`Initialize request from: ${params.clientInfo?.name || 'unknown'} v${params.clientInfo?.version || '?'}`);

      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          // No resources or prompts for now
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      };
    });

    this._notificationHandlers.set('notifications/initialized', async () => {
      this._initialized = true;
      this._log('MCP session initialized successfully.');
    });

    // ── Tool Listing ──────────────────────────────────────────────────────
    this._requestHandlers.set('tools/list', async () => {
      return { tools: TOOLS };
    });

    // ── Tool Execution ────────────────────────────────────────────────────
    this._requestHandlers.set('tools/call', async (params) => {
      const { name, arguments: args } = params;
      const handlerName = this._toolHandlerMap.get(name);
      if (!handlerName) throw new Error(`Unknown tool: ${name}`);
      // Step 2 Refactoring: Prefer external handlers, fallback to internal
      const handler = this._externalHandlers[handlerName] || this[handlerName];
      if (!handler) throw new Error(`Handler "${handlerName}" not found for tool "${name}"`);
      return handler.call(this, args);
    });

    // ── Ping ──────────────────────────────────────────────────────────────
    this._requestHandlers.set('ping', async () => {
      return {};
    });
  }

  // ─── Tool Implementations ─────────────────────────────────────────────

  /**
   * workflow_triage: Evaluate requirement complexity and return routing advice.
   */
  async _handleWorkflowTriage(args) {
    const { requirement } = args;
    if (!requirement) {
      return this._toolResponse('Error: requirement is required', true);
    }

    const triage = this._getTriage();
    const result = triage.triage(requirement, { projectRoot: this._projectRoot });
    const mcpResult = triage.formatMCPResponse(result);
    const displayText = triage.formatTriageResult(result);

    return this._toolResponse(
      `## Requirement Triage\n\n${displayText}\n\n\`\`\`json\n${JSON.stringify(mcpResult, null, 2)}\n\`\`\``
    );
  }

  /**
   * workflow_run: Execute workflow with auto-triage.
   */
  async _handleWorkflowRun(args) {
    const { requirement, mode = 'auto', force = false } = args;
    if (!requirement) {
      return this._toolResponse('Error: requirement is required', true);
    }

    // ── Step 1: Triage (unless --force) ──────────────────────────────────
    if (!force) {
      const triage = this._getTriage();
      const triageResult = triage.triage(requirement, { projectRoot: this._projectRoot });

      // Block if not initialized
      if (triageResult.requiresInit) {
        return this._toolResponse(
          `❌ **Project Not Initialized**\n\n` +
          `${triageResult.initState.reason}\n\n` +
          `Please run \`workflow_init\` first, or use the terminal:\n` +
          `\`\`\`bash\nnode workflow/init-project.js --path ${this._projectRoot}\n\`\`\``,
          true
        );
      }

      // Suggest IDE for simple tasks
      if (!triageResult.shouldProceed) {
        const displayText = triage.formatTriageResult(triageResult);

        // ── ADR-43 Extension: Lightweight Experience Hook for IDE-First mode ────
        // Even though we're routing to IDE, we still want to capture valuable signals.
        if (triageResult.experienceHook && triageResult.experienceHook.enabled) {
          setImmediate(async () => {
            try {
              const { runIdeExperienceHook } = require('./ide-experience-hook');
              // Note: MCP server may not have orchestrator, so experienceStore may be null
              const hookResult = await runIdeExperienceHook({
                requirement: triageResult.experienceHook.sessionContext.requirement,
                score: triageResult.score,
                matchedTags: triageResult.experienceHook.sessionContext.matchedTags,
                experienceStore: this._orchestratorFactory?.({ projectRoot: this._projectRoot })?.experienceStore,
              });
              if (hookResult.captured) {
                this._log(`IDE Experience Hook: captured experience ${hookResult.expId}`);
              }
            } catch (hookErr) {
              this._log(`IDE Experience Hook failed (non-fatal): ${hookErr.message}`);
            }
          });
        }

        return this._toolResponse(
          `${displayText}\n\n` +
          `To force workflow execution, call \`workflow_run\` with \`force: true\`.`
        );
      }

      // Include staleness warnings
      if (triageResult.staleness && triageResult.staleness.isStale) {
        const warnings = triageResult.staleness.warnings.map(w => w.message).join('\n');
        this._log(`Staleness warnings:\n${warnings}`);
      }
    }

    // ── Step 2: Execute workflow ──────────────────────────────────────────
    if (!this._orchestratorFactory) {
      return this._toolResponse(
        `⚠️ Workflow execution is not available in this MCP server configuration.\n\n` +
        `The MCP server was started without an LLM provider. To enable workflow execution:\n` +
        `1. Configure an LLM call function when starting the server\n` +
        `2. Or use the CLI directly: \`/wf ${requirement}\`\n\n` +
        `**Triage result is still valid** — use it to decide how to proceed in IDE.`
      );
    }

    // Check if a workflow is already running
    if (this._currentWorkflow) {
      return this._toolResponse(
        `⚠️ A workflow is already running.\n\n` +
        `Current: "${this._currentWorkflow.requirement}"\n` +
        `Started: ${this._currentWorkflow.startTime}\n\n` +
        `Wait for it to complete or restart the MCP server.`,
        true
      );
    }

    try {
      const orchestrator = this._orchestratorFactory({
        projectRoot: this._projectRoot,
      });

      this._currentWorkflow = {
        requirement,
        startTime: new Date().toISOString(),
      };

      this._log(`Starting workflow: "${requirement}" (mode: ${mode})`);

      if (mode === 'parallel') {
        await orchestrator.runAuto(requirement);
      } else if (mode === 'auto') {
        await orchestrator.runAuto(requirement);
      } else {
        await orchestrator.run(requirement);
      }

      this._currentWorkflow = null;

      return this._toolResponse(
        `✅ **Workflow Complete**\n\n` +
        `**Requirement**: ${requirement}\n` +
        `**Mode**: ${mode}\n\n` +
        `Artifacts have been produced in the workflow output directory.`
      );
    } catch (err) {
      this._currentWorkflow = null;
      return this._toolResponse(
        `❌ **Workflow Failed**\n\n` +
        `**Error**: ${err.message}\n` +
        `**Requirement**: ${requirement}`,
        true
      );
    }
  }

  /**
   * workflow_init: Initialize workflow for a project.
   */
  async _handleWorkflowInit(args) {
    const targetRoot = args.projectPath || this._projectRoot;
    const dryRun = args.dryRun || false;

    const scriptPath = path.join(__dirname, '..', 'init-project.js');
    if (!fs.existsSync(scriptPath)) {
      return this._toolResponse(`❌ init-project.js not found at: ${scriptPath}`, true);
    }

    try {
      const { spawn } = require('child_process');
      const spawnArgs = [scriptPath, '--path', targetRoot];
      if (dryRun) spawnArgs.push('--dry-run');

      this._log(`Running: node ${spawnArgs.join(' ')}`);

      const output = await new Promise((resolve, reject) => {
        const chunks = [];
        const child = spawn(process.execPath, spawnArgs, {
          cwd: targetRoot,
          timeout: 120000,
        });

        child.stdout.on('data', (d) => chunks.push(d.toString()));
        child.stderr.on('data', (d) => chunks.push(d.toString()));

        child.on('close', (code) => {
          const result = chunks.join('');
          if (code === 0) {
            resolve(result);
          } else {
            reject(new Error(`Init failed (exit ${code}):\n${result.slice(-500)}`));
          }
        });

        child.on('error', (err) => reject(err));
      });

      return this._toolResponse(
        `✅ **Workflow Initialization Complete**\n\n` +
        `\`\`\`\n${output.slice(-2000)}\n\`\`\``
      );
    } catch (err) {
      return this._toolResponse(`❌ **Initialization Failed**\n\n${err.message}`, true);
    }
  }

  /**
   * workflow_status: Get current workflow and project status.
   */
  async _handleWorkflowStatus() {
    const triage = this._getTriage();
    const initState = triage.checkInitState(this._projectRoot);
    const staleness = triage.checkStaleness(this._projectRoot);

    const lines = [
      `## WorkFlowAgent Status`,
      ``,
      `**Project Root**: ${this._projectRoot}`,
      `**MCP Server**: ${SERVER_NAME} v${SERVER_VERSION}`,
      ``,
      `### Initialization`,
      `- **Initialized**: ${initState.isInitialized ? '✅ Yes' : '❌ No'}`,
      `- **Fully Initialized**: ${initState.isFullyInitialized ? '✅ Yes' : '⚠️ Partial'}`,
    ];

    if (initState.details.hasConfig) {
      lines.push(`- **Config**: ✅ ${initState.details.configPath}`);
    } else {
      lines.push(`- **Config**: ❌ Not found`);
    }

    if (initState.details.hasCodeGraph) {
      lines.push(`- **CodeGraph**: ✅ ${initState.details.codeGraphPath}`);
    } else {
      lines.push(`- **CodeGraph**: ❌ Not built`);
    }

    lines.push(`- **Project Profile**: ${initState.details.hasProjectProfile ? '✅ Yes' : '❌ No'}`);
    lines.push(`- **AGENTS.md**: ${initState.details.hasAgentsMd ? '✅ Yes' : '❌ No'}`);

    if (staleness.isStale) {
      lines.push(``);
      lines.push(`### ⚠️ Staleness Warnings`);
      for (const w of staleness.warnings) {
        lines.push(`- ${w.message}`);
      }
    }

    if (this._currentWorkflow) {
      lines.push(``);
      lines.push(`### 🔄 Active Workflow`);
      lines.push(`- **Requirement**: ${this._currentWorkflow.requirement}`);
      lines.push(`- **Started**: ${this._currentWorkflow.startTime}`);
    }

    // Check for manifest
    const manifestPaths = [
      path.join(this._projectRoot, 'workflow', 'output', 'manifest.json'),
      path.join(this._projectRoot, 'workflow', 'manifest.json'),
    ];
    for (const mp of manifestPaths) {
      if (fs.existsSync(mp)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(mp, 'utf-8'));
          lines.push(``);
          lines.push(`### Last Workflow`);
          lines.push(`- **State**: ${manifest.currentState}`);
          lines.push(`- **Updated**: ${manifest.updatedAt}`);
          lines.push(`- **Transitions**: ${manifest.history?.length || 0}`);
        } catch (_) { /* ignore parse errors */ }
        break;
      }
    }

    return this._toolResponse(lines.join('\n'));
  }

  // ─── Skill Management Tool Handlers ─────────────────────────────────────

  /**
   * workflow_skill_discover: Auto-discover project conventions.
   */
  async _handleSkillDiscover(args) {
    const projectPath = args.projectPath || this._projectRoot;

    try {
      const { runSkillDiscover } = require('../tools/ide-workflow-bridge');
      const result = await runSkillDiscover({ projectRoot: projectPath });

      if (result.success) {
        return this._toolResponse(
          `✅ **Skill Discovery Complete**\n\n` +
          `**Discovered**: ${result.discoveredCount} convention(s)\n` +
          `**Project**: ${result.projectRoot}\n\n` +
          `${result.discoveredSkills?.map(s => `- ${s}`).join('\n') || 'No new skills discovered'}`
        );
      } else {
        return this._toolResponse(`❌ **Discovery Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Discovery Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_skill_evolve: Trigger skill evolution.
   */
  async _handleSkillEvolve(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const skillName = args.skillName;

    try {
      const { runSkillEvolve } = require('../tools/ide-workflow-bridge');
      const result = await runSkillEvolve({ projectRoot: projectPath, skillName });

      if (result.success) {
        return this._toolResponse(
          `✅ **Skill Evolution Complete**\n\n` +
          `**Skills Evolved**: ${result.evolvedSkills?.length || 0}\n` +
          `**New Experiences**: ${result.newExperienceCount || 0}\n\n` +
          `${result.evolvedSkills?.map(s => `- ${s.name}: ${s.experienceCount} experiences consolidated`).join('\n') || 'No skills evolved'}`
        );
      } else {
        return this._toolResponse(`❌ **Evolution Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Evolution Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_skill_update: Directly update skill content.
   */
  async _handleSkillUpdate(args) {
    const { skillName, section, content } = args;
    const projectPath = args.projectPath || this._projectRoot;

    if (!skillName || !section || !content) {
      return this._toolResponse('Error: skillName, section, and content are required', true);
    }

    try {
      const { runSkillUpdate } = require('../tools/ide-workflow-bridge');
      const result = await runSkillUpdate({
        projectRoot: projectPath,
        skillName,
        section,
        content,
      });

      if (result.success) {
        return this._toolResponse(
          `✅ **Skill Updated**\n\n` +
          `**Skill**: ${result.skillName}\n` +
          `**Section**: ${result.section}\n` +
          `**New Version**: ${result.newVersion}`
        );
      } else {
        return this._toolResponse(`❌ **Update Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Update Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_skill_refine_check: Identify skills needing refinement.
   * ADR-37: If llmCall available, auto-refines high-value candidates.
   */
  async _handleSkillRefineCheck(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const threshold = args.threshold || 5;

    try {
      const { runSkillRefineCheck } = require('../tools/ide-workflow-bridge');

      // Inject llmCall if available (ADR-37 LLM-Lite mode)
      const bridgeArgs = {
        projectRoot: projectPath,
        threshold,
      };

      if (this._llmCall) {
        bridgeArgs.llmCall = this._llmCall;
      }

      const result = await runSkillRefineCheck(bridgeArgs);

      if (result.success) {
        const data = result.data || {};
        const allCandidates = [
          ...(data.candidates?.needsRefine || []),
          ...(data.candidates?.needsFix || []),
          ...(data.candidates?.stale || []),
          ...(data.candidates?.hollow || []),
        ];

        if (allCandidates.length === 0) {
          return this._toolResponse(`✅ **No Skills Need Refinement**\n\nAll skills are within healthy thresholds.`);
        }

        let response = `📋 **Skills Needing Refinement** (${allCandidates.length})\n\n`;
        response += allCandidates.map(c =>
          `- **${c.name}**: ${c.reason}`
        ).join('\n');

        // Add LLM refinement results if available
        if (data.llmAutoRefined && data.llmAutoRefined > 0) {
          response += `\n\n🤖 **LLM Auto-Refinement**: ${data.llmAutoRefined} skill(s) automatically refined`;
          if (data.llmResults?.refined?.length > 0) {
            response += '\n' + data.llmResults.refined.map(r =>
              `  - ${r.name}: v${r.oldVersion} → v${r.newVersion}`
            ).join('\n');
          }
        } else if (this._llmCall) {
          response += '\n\n💡 LLM is available but no skills met the auto-refinement threshold.';
        } else {
          response += '\n\n💡 To enable automatic LLM refinement, start MCP server with LLM provider.';
        }

        return this._toolResponse(response);
      } else {
        return this._toolResponse(`❌ **Check Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Check Error**: ${err.message}`, true);
    }
  }

  // ─── Experience Store Tool Handlers ─────────────────────────────────────

  /**
   * workflow_experience_search: Search ExperienceStore.
   */
  async _handleExperienceSearch(args) {
    const { query } = args;
    const projectPath = args.projectPath || this._projectRoot;
    const limit = args.limit || 10;

    if (!query) {
      return this._toolResponse('Error: query is required', true);
    }

    try {
      const { runExperienceSearch } = require('../tools/ide-workflow-bridge');
      const result = await runExperienceSearch({
        projectRoot: projectPath,
        query,
        skill: args.skill,
        tags: args.tags,
        limit,
      });

      if (result.success) {
        const experiences = result.experiences || [];
        if (experiences.length === 0) {
          return this._toolResponse(`🔍 **No Experiences Found**\n\nQuery: "${query}"`);
        }

        return this._toolResponse(
          `📚 **Experience Search Results** (${experiences.length})\n\n` +
          `**Query**: "${query}"\n\n` +
          experiences.map((exp, i) =>
            `**${i + 1}. ${exp.title}**\n` +
            `- Skill: ${exp.skill || 'none'}\n` +
            `- Tags: ${(exp.tags || []).join(', ') || 'none'}\n` +
            `- Relevance: ${(exp.relevanceScore * 100).toFixed(0)}%\n` +
            `- Content: ${(exp.content || '').slice(0, 200)}...`
          ).join('\n\n')
        );
      } else {
        return this._toolResponse(`❌ **Search Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Search Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_experience_context: Get formatted context block for a skill.
   */
  async _handleExperienceContext(args) {
    const { skill } = args;
    const projectPath = args.projectPath || this._projectRoot;
    const limit = args.limit || 5;

    if (!skill) {
      return this._toolResponse('Error: skill is required', true);
    }

    try {
      const { runExperienceContext } = require('../tools/ide-workflow-bridge');
      const result = await runExperienceContext({
        projectRoot: projectPath,
        skill,
        limit,
      });

      if (result.success) {
        return this._toolResponse(
          `📖 **Experience Context for "${result.skill}"**\n\n` +
          `**Statistics**: ${result.contextStats?.totalExperiences || 0} experiences, ` +
          `${result.contextStats?.totalTokens || 0} tokens\n\n` +
          `${result.contextBlock}`
        );
      } else {
        return this._toolResponse(`❌ **Context Load Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Context Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_experience_record: Record a new experience.
   */
  async _handleExperienceRecord(args) {
    const { title, content, skill } = args;
    const projectPath = args.projectPath || this._projectRoot;

    if (!title || !content || !skill) {
      return this._toolResponse('Error: title, content, and skill are required', true);
    }

    try {
      const { runExperienceRecord } = require('../tools/ide-workflow-bridge');
      const result = await runExperienceRecord({
        projectRoot: projectPath,
        title,
        content,
        skill,
        tags: args.tags,
        outcome: args.outcome || 'success',
      });

      if (result.success) {
        return this._toolResponse(
          `✅ **Experience Recorded**\n\n` +
          `**ID**: ${result.experienceId}\n` +
          `**Title**: ${result.title}\n` +
          `**Skill**: ${result.skill}\n` +
          `**Content Hash**: ${result.contentHash}`
        );
      } else {
        return this._toolResponse(`❌ **Recording Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Recording Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_experience_evolve: Trigger experience evolution.
   */
  async _handleExperienceEvolve(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const dryRun = args.dryRun || false;

    try {
      const { runExperienceEvolve } = require('../tools/ide-workflow-bridge');
      const result = await runExperienceEvolve({ projectRoot: projectPath, dryRun });

      if (result.success) {
        const consolidation = result.consolidation || {};
        return this._toolResponse(
          `✅ **Experience Evolution Complete**\n\n` +
          `**Mode**: ${dryRun ? 'Dry Run' : 'Applied'}\n` +
          `**Candidates**: ${consolidation.candidates || 0}\n` +
          `**Consolidated**: ${consolidation.consolidatedSets || 0} sets\n` +
          `**Distilled**: ${result.distillation?.distilledExperiences || 0}\n` +
          `**Archived**: ${result.distillation?.archivedExperiences || 0}\n` +
          `**New Skills**: ${result.consolidation?.newSkills?.length || 0}`
        );
      } else {
        return this._toolResponse(`❌ **Evolution Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Evolution Error**: ${err.message}`, true);
    }
  }

  // ─── Context and Prompt Tool Handlers ───────────────────────────────────

  /**
   * workflow_context: Load context for a workflow stage.
   */
  async _handleContext(args) {
    const { stage, task } = args;
    const projectPath = args.projectPath || this._projectRoot;

    if (!stage || !task) {
      return this._toolResponse('Error: stage and task are required', true);
    }

    try {
      const { runContext } = require('../tools/ide-workflow-bridge');
      const result = await runContext({
        projectRoot: projectPath,
        stage,
        task,
      });

      if (result.success) {
        return this._toolResponse(
          `🎯 **Context for ${stage} Stage**\n\n` +
          `**Task**: ${task}\n` +
          `**Matched Skills**: ${(result.matchedSkills || []).join(', ') || 'none'}\n` +
          `**Context Size**: ${result.contextLength} chars\n\n` +
          `${result.context}`
        );
      } else {
        return this._toolResponse(`❌ **Context Load Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Context Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_build_agent_prompt: Build role-specific agent prompt.
   */
  async _handleBuildAgentPrompt(args) {
    const { stage, task } = args;
    const projectPath = args.projectPath || this._projectRoot;

    if (!stage || !task) {
      return this._toolResponse('Error: stage and task are required', true);
    }

    try {
      const { runBuildAgentPrompt } = require('../tools/ide-workflow-bridge');
      const result = await runBuildAgentPrompt({
        projectRoot: projectPath,
        stage,
        task,
      });

      if (result.success) {
        return this._toolResponse(
          `🤖 **Agent Prompt for ${stage}**\n\n` +
          `**Role**: ${result.role}\n` +
          `**Constraints**: ${(result.constraints || []).length} items\n` +
          `**Context Skills**: ${(result.context?.matchedSkills || []).join(', ') || 'none'}\n\n` +
          `---\n\n${result.prompt}`
        );
      } else {
        return this._toolResponse(`❌ **Prompt Build Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Prompt Error**: ${err.message}`, true);
    }
  }

  // ─── Quality and Review Tool Handlers ───────────────────────────────────

  /**
   * workflow_quality_check: Run rule-based quality checks.
   */
  async _handleQualityCheck(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const files = args.files;

    try {
      const { runQualityCheck } = require('../tools/ide-workflow-bridge');
      const result = await runQualityCheck({ projectRoot: projectPath, files });

      if (result.success) {
        const violations = result.violations || [];
        if (violations.length === 0) {
          return this._toolResponse(`✅ **Quality Check Passed**\n\nAll checks passed for ${(result.filesChecked || []).length} file(s).`);
        }

        return this._toolResponse(
          `⚠️ **Quality Check: ${violations.length} Violation(s)**\n\n` +
          `**Files Checked**: ${(result.filesChecked || []).join(', ') || 'N/A'}\n\n` +
          violations.map((v, i) =>
            `**${i + 1}. [${v.severity?.toUpperCase()}] ${v.rule}**\n` +
            `- File: ${v.file}\n` +
            `- Message: ${v.message}`
          ).join('\n\n')
        );
      } else {
        return this._toolResponse(`❌ **Quality Check Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Quality Check Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_quality_gate: Run full QualityGate validation.
   */
  async _handleQualityGate(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const stage = args.stage;

    try {
      const { runQualityGate } = require('../tools/ide-workflow-bridge');
      const result = await runQualityGate({ projectRoot: projectPath, stage });

      if (result.success) {
        const checks = result.checks || [];
        const failed = checks.filter(c => !c.passed);

        if (failed.length === 0) {
          return this._toolResponse(
            `✅ **Quality Gate Passed**\n\n` +
            `**Stage**: ${result.stage || 'N/A'}\n` +
            `**All ${checks.length} Checks**: PASSED`
          );
        }

        return this._toolResponse(
          `❌ **Quality Gate Failed** (${failed.length}/${checks.length})\n\n` +
          `**Stage**: ${result.stage || 'N/A'}\n\n` +
          failed.map(c =>
            `- **${c.name}**: ${c.message} (threshold: ${c.threshold}, actual: ${c.actual})`
          ).join('\n')
        );
      } else {
        return this._toolResponse(`❌ **Quality Gate Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Quality Gate Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_deep_audit: Run DeepAuditOrchestrator.
   */
  async _handleDeepAudit(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const format = args.format || 'markdown';

    try {
      const { runDeepAudit } = require('../tools/ide-workflow-bridge');
      const result = await runDeepAudit({ projectRoot: projectPath, format });

      if (result.success) {
        if (format === 'json') {
          return this._toolResponse(`\`\`\`json\n${JSON.stringify(result.dimensions, null, 2)}\n\`\`\``);
        }

        return this._toolResponse(
          `🔍 **Deep Audit Results**\n\n` +
          (result.summary ? `**Overall**: ${result.summary}\n\n` : '') +
          Object.entries(result.dimensions || {}).map(([dim, data]) => {
            const status = data.score >= 80 ? '✅' : data.score >= 60 ? '⚠️' : '❌';
            return `${status} **${dim}**: ${data.score}/100 (${data.status})`;
          }).join('\n')
        );
      } else {
        return this._toolResponse(`❌ **Audit Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Audit Error**: ${err.message}`, true);
    }
  }

  /**
   * workflow_rollback_check: Validate stage contracts.
   */
  async _handleRollbackCheck(args) {
    const { stage } = args;
    const projectPath = args.projectPath || this._projectRoot;

    if (!stage) {
      return this._toolResponse('Error: stage is required', true);
    }

    try {
      const { runRollbackCheck } = require('../tools/ide-workflow-bridge');
      const result = await runRollbackCheck({ projectRoot: projectPath, stage });

      if (result.success) {
        const blocking = result.contractViolations?.filter(v => v.severity === 'blocking') || [];
        const warnings = result.contractViolations?.filter(v => v.severity === 'warning') || [];

        if (blocking.length === 0 && warnings.length === 0) {
          return this._toolResponse(`✅ **Rollback Check Passed**\n\nStage ${stage} outputs are compatible with downstream inputs.`);
        }

        return this._toolResponse(
          `${blocking.length > 0 ? '❌' : '⚠️'} **Rollback Check Issues**\n\n` +
          `**Blocking**: ${blocking.length}\n` +
          `**Warnings**: ${warnings.length}\n\n` +
          blocking.map(v => `🚫 **${v.rule}**: ${v.message}`).join('\n') + '\n' +
          warnings.map(v => `⚠️ **${v.rule}**: ${v.message}`).join('\n')
        );
      } else {
        return this._toolResponse(`❌ **Rollback Check Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Rollback Check Error**: ${err.message}`, true);
    }
  }

  // ─── Testing Tool Handlers ──────────────────────────────────────────────

  /**
   * workflow_test_execute: Execute project tests.
   */
  async _handleTestExecute(args) {
    const projectPath = args.projectPath || this._projectRoot;
    const pattern = args.pattern;
    const watch = args.watch || false;
    const testProfile = args.testProfile;
    const testSuites = args.testSuites;
    const testFiles = args.testFiles;

    try {
      const { runTestExecute } = require('../tools/ide-workflow-bridge');
      const result = await runTestExecute({
        projectRoot: projectPath,
        pattern,
        watch,
        testProfile,
        testSuites,
        testFiles,
      });

      if (result.success) {
        return this._toolResponse(
          `🧪 **Test Execution Results**\n\n` +
          `**Framework**: ${result.framework || 'auto-detected'}\n` +
          `**Tests**: ${result.testCount || 'N/A'}\n` +
          `**Failures**: ${result.failures || 0}\n` +
          `**Duration**: ${result.duration || 'N/A'}\n\n` +
          (result.output ? `\`\`\`\n${result.output.slice(-2000)}\n\`\`\`` : '')
        );
      } else {
        return this._toolResponse(
          `❌ **Tests Failed**\n\n` +
          `**Exit Code**: ${result.exitCode}\n\n` +
          (result.output ? `\`\`\`\n${result.output.slice(-2000)}\n\`\`\`` : result.error),
          true
        );
      }
    } catch (err) {
      return this._toolResponse(`❌ **Test Execution Error**: ${err.message}`, true);
    }
  }

  // ─── Staleness and Health Tool Handlers ─────────────────────────────────

  /**
   * workflow_staleness_check: Check for stale artifacts.
   */
  async _handleStalenessCheck(args) {
    const projectPath = args.projectPath || this._projectRoot;

    try {
      const { runStalenessCheck } = require('../tools/ide-workflow-bridge');
      const result = await runStalenessCheck({ projectRoot: projectPath });

      if (result.success) {
        if (!result.isStale) {
          return this._toolResponse(`✅ **No Staleness Issues**\n\nAll artifacts are up to date.`);
        }

        return this._toolResponse(
          `⚠️ **Staleness Warnings** (${result.warnings?.length || 0})\n\n` +
          (result.warnings || []).map(w => `- **${w.type}**: ${w.message}`).join('\n') + '\n\n' +
          `Run \`workflow_init\` to refresh stale artifacts.`
        );
      } else {
        return this._toolResponse(`❌ **Staleness Check Failed**\n\n${result.error}`, true);
      }
    } catch (err) {
      return this._toolResponse(`❌ **Staleness Check Error**: ${err.message}`, true);
    }
  }

  // ─── Quality Gate Extended Handlers (P1 Sync) ────────────────────────────

  /**
   * workflow_quality_gate_validate_stage: Validate a specific stage against stage-specific gates.
   * P1-Enhancement: Bridge parity for stage-level quality validation.
   */
  async _handleQualityGateValidateStage(args) {
    const { stage } = args;
    if (!stage) {
      return this._toolResponse('Error: stage parameter is required', true);
    }

    const validStages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST'];
    if (!validStages.includes(stage)) {
      return this._toolResponse(
        `Error: Invalid stage "${stage}". Valid stages: ${validStages.join(', ')}`,
        true
      );
    }

    const targetRoot = args.projectPath || this._projectRoot;

    try {
      const { QualityGate } = require('./quality-gate');

      const metrics = {
        errors: { count: args.errorCount || 0 },
        totalDurationMs: args.durationMs || 0,
        llm: { totalCalls: args.llmCalls || 0 },
        projectRoot: targetRoot,
      };

      const gate = new QualityGate({
        recordIssue: (opts) => ({ ...opts, timestamp: new Date().toISOString() }),
      });

      const result = gate.validateStage(stage, metrics);

      const gateResults = result.gates.map(g =>
        `${g.passed ? '✅' : '❌'} **${g.name}**: ${g.message}`
      ).join('\n');

      return this._toolResponse(
        `## Quality Gate: Stage Validation (${stage})\n\n` +
        `**Overall**: ${result.passed ? '✅ PASSED' : '❌ FAILED'}\n` +
        `**Mode**: ${result.mode || 'default'}\n\n` +
        `**Gate Results**:\n${gateResults}\n\n` +
        `\`\`\`json\n${JSON.stringify({
          stage,
          passed: result.passed,
          mode: result.mode,
          gates: result.gates.map(g => ({
            name: g.name,
            passed: g.passed,
            actual: g.actual,
            threshold: g.threshold,
            message: g.message,
          })),
        }, null, 2)}\n\`\`\``
      );
    } catch (err) {
      return this._toolResponse(`Error: ${err.message}`, true);
    }
  }

  /**
   * workflow_quality_gate_diagnostics: Export diagnostic data from QualityGate.
   * P1-Enhancement: Bridge parity for diagnostics export.
   */
  async _handleQualityGateDiagnostics(args) {
    const targetRoot = args.projectPath || this._projectRoot;
    const clear = args.clear || false;

    try {
      const { QualityGate } = require('./quality-gate');

      const gate = new QualityGate({
        recordIssue: () => {},
      });

      const diagnostics = gate.exportDiagnostics ? gate.exportDiagnostics() : {
        mode: 'default',
        stats: { totalRuns: 0, passedRuns: 0, failedRuns: 0 },
        history: [],
        failureRate: 0,
      };

      // Clear history if requested
      if (clear && gate.clearDiagnosticHistory) {
        gate.clearDiagnosticHistory();
      }

      const summary = diagnostics.stats || {};
      const historyPreview = (diagnostics.history || []).slice(-5).map(h =>
        `- ${h.timestamp}: ${h.passed ? '✅' : '❌'} (${h.validationType})`
      ).join('\n') || 'No history available';

      return this._toolResponse(
        `## Quality Gate Diagnostics\n\n` +
        `**Mode**: ${diagnostics.mode || 'default'}\n` +
        `**Total Runs**: ${summary.totalRuns || 0}\n` +
        `**Passed**: ${summary.passedRuns || 0} | **Failed**: ${summary.failedRuns || 0}\n` +
        `**Failure Rate**: ${(diagnostics.failureRate * 100 || 0).toFixed(1)}%\n\n` +
        `**Recent History**:\n${historyPreview}\n\n` +
        `${clear ? '✅ History cleared\n\n' : ''}` +
        `\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``
      );
    } catch (err) {
      return this._toolResponse(`Error: ${err.message}`, true);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  /**
   * Lazy-loads RequestTriage to avoid circular dependencies.
   */
  _getTriage() {
    if (!this._triage) {
      const { RequestTriage } = require('./request-triage');
      this._triage = new RequestTriage();
    }
    return this._triage;
  }

  // ─── Bridge Command Parity Check ─────────────────────────────────────────

  /**
   * Validates that MCP tools are functionally equivalent to Bridge commands.
   * This implements ADR-XX "Dual Mode Synchronization" – all capabilities must
   * exist in both Node Orchestrator (CLI) and IDE Agent (Bridge) modes.
   *
   * Checks:
   *   - workflow_triage ↔ /wf (without auto-triage)
   *   - workflow_run ↔ /wf <requirement>
   *   - workflow_init ↔ /wf init
   *   - workflow_status ↔ /workflow-status
   *
   * @returns {object} Parity check report
   */
  checkBridgeParity() {
    const report = {
      timestamp: new Date().toISOString(),
      serverMode: this._orchestratorFactory ? 'full' : 'triage-only',
      toolCount: TOOLS.length,
      bridgeCommands: ['/wf', '/wf init', '/wf-tasks', '/workflow-status'],
      mcpTools: TOOLS.map(t => t.name),
      parityMap: {},
      issues: [],
    };

    // Tool-to-command mapping
    const MAPPINGS = [
      { tool: 'workflow_triage', command: '/wf', flags: [], notes: 'Auto-triage on workflow_run' },
      { tool: 'workflow_run', command: '/wf', flags: ['--parallel', '--auto', '--force'], notes: 'Full pipeline or parallel execution' },
      { tool: 'workflow_init', command: '/wf init', flags: ['--path', '--dry-run'], notes: 'Project initialization' },
      { tool: 'workflow_status', command: '/workflow-status', flags: [], notes: 'Status check' },
    ];

    for (const mapping of MAPPINGS) {
      const mcpTool = TOOLS.find(t => t.name === mapping.tool);
      report.parityMap[mapping.tool] = {
        exists: !!mcpTool,
        command: mapping.command,
        flags: mapping.flags,
        notes: mapping.notes,
      };

      if (!mcpTool) {
        report.issues.push(`Missing MCP tool: ${mapping.tool}`);
      }
    }

    // Check for missing Bridge command equivalents
    const missingBridge = [];
    for (const tool of TOOLS) {
      const hasBridge = MAPPINGS.some(m => m.tool === tool.name);
      if (!hasBridge) {
        missingBridge.push(tool.name);
      }
    }
    if (missingBridge.length > 0) {
      report.issues.push(`MCP tools without Bridge equivalents: ${missingBridge.join(', ')}`);
    }

    // IDE tool availability check (ADR-37)
    report.ideTools = {
      codebaseSearch: typeof this._toolFunctions.codebaseSearch === 'function',
      grepSearch: typeof this._toolFunctions.grepSearch === 'function',
      viewCodeItem: typeof this._toolFunctions.viewCodeItem === 'function',
      readFile: typeof this._toolFunctions.readFile === 'function',
      listDir: typeof this._toolFunctions.listDir === 'function',
      analysisTools: this._toolFunctions.toolsForAnalysis.length,
    };
    report.ideToolAvailable = Object.values(report.ideTools)
      .filter(v => typeof v === 'boolean' ? v : v > 0).length > 0;

    // Triage sync check
    report.triageSync = {
      sharesLogicWithBridge: true,
      routeToIDEEnabled: true,
      experienceHookEnabled: true,
      note: 'request-triage.js is shared between /wf command and workflow_triage tool',
    };

    return report;
  }

  /**
   * Returns a human-readable parity report.
   * @returns {string}
   */
  formatParityReport(report = null) {
    const r = report || this.checkBridgeParity();
    const lines = [
      `# Bridge-MCP Parity Report`,
      ``,
      `**Server Mode**: ${r.serverMode}`,
      `**Timestamp**: ${r.timestamp}`,
      ``,
      `## Tool Count`,
      `- MCP Tools: ${r.toolCount}`,
      `- Bridge Commands: ${r.bridgeCommands.length}`,
      ``,
      `## Parity Mapping`,
    ];

    for (const [tool, info] of Object.entries(r.parityMap)) {
      lines.push(`### ${tool}`);
      lines.push(`- Status: ${info.exists ? '✅ Mapped' : '❌ Missing'}`);
      lines.push(`- Bridge Command: \`${info.command}\``);
      if (info.flags.length > 0) {
        lines.push(`- Supported Flags: ${info.flags.map(f => `\`${f}\``).join(', ')}`);
      }
      lines.push(`- Notes: ${info.notes}`);
      lines.push('');
    }

    lines.push(`## IDE Tool Availability (ADR-37)`);
    for (const [tool, available] of Object.entries(r.ideTools)) {
      const status = typeof available === 'boolean'
        ? (available ? '✅' : '❌')
        : (available > 0 ? `✅ (${available})` : '❌');
      lines.push(`- ${tool}: ${status}`);
    }
    lines.push('');

    lines.push(`## Triage Synchronization`);
    lines.push(`- Shared Logic: ${r.triageSync.sharesLogicWithBridge ? '✅' : '❌'}`);
    lines.push(`- Route-to-IDE: ${r.triageSync.routeToIDEEnabled ? '✅' : '❌'}`);
    lines.push(`- Experience Hook: ${r.triageSync.experienceHookEnabled ? '✅' : '❌'}`);
    lines.push('');

    if (r.issues.length > 0) {
      lines.push(`## ⚠️ Issues Detected`);
      for (const issue of r.issues) {
        lines.push(`- ${issue}`);
      }
    } else {
      lines.push(`## ✅ No Issues`);
      lines.push(`Bridge-MCP parity is aligned.`);
    }

    return lines.join('\n');
  }

  /**
   * Creates an MCP tool response.
   * @param {string} text - Response text content
   * @param {boolean} [isError=false] - Whether this is an error response
   * @returns {object}
   */
  _toolResponse(text, isError = false) {
    return {
      content: [
        { type: 'text', text },
      ],
      isError,
    };
  }

  /**
   * Sends a JSON-RPC result response.
   * @param {number|string} id - Request ID
   * @param {object} result
   */
  _sendResult(id, result) {
    this._send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Sends a JSON-RPC error response.
   * @param {number|string} id - Request ID
   * @param {number} code - Error code
   * @param {string} message - Error message
   */
  _sendError(id, code, message) {
    this._send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  /**
   * Writes a JSON-RPC message to stdout.
   * @param {object} message
   */
  _send(message) {
    const json = JSON.stringify(message);
    process.stdout.write(json + '\n');
  }

  /**
   * Logs to stderr (MCP spec: stdout is reserved for protocol messages).
   * @param {string} msg
   */
  _log(msg) {
    process.stderr.write(`[MCPServer] ${msg}\n`);
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────

if (require.main === module) {
  // Parse CLI args
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[i + 1]);
      i++;
    }
  }

  // Start MCP server
  const server = new MCPServer({
    projectRoot,
    // orchestratorFactory and llmCall are not available in standalone CLI mode.
    // The server still provides triage, init, and status tools.
    // Full workflow execution requires the server to be started with an LLM provider.
  });

  server.start();
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = { MCPServer, TOOLS, TOOL_REGISTRY, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION };
