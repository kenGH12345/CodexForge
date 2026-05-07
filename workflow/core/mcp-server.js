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
 * Usage:
 *   node workflow/core/mcp-server.js --project-root /path/to/project
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
const { TOOL_REGISTRY, TOOLS } = require('./mcp/tool-registry');
const { createAllHandlers } = require('./mcp/handlers');
const { checkBridgeParity, formatParityReport } = require('./mcp/bridge-parity');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'workflowagent';
const SERVER_VERSION = '1.0.0';

class MCPServer {
  constructor(opts = {}) {
    this._projectRoot = opts.projectRoot || process.cwd();
    this._orchestratorFactory = opts.orchestratorFactory || null;
    this._llmCall = opts.llmCall || null;
    this._initialized = false;
    this._rl = null;
    this._requestHandlers = new Map();
    this._notificationHandlers = new Map();
    this._currentWorkflow = null;
    this._triage = null;

    this._toolFunctions = {
      codebaseSearch: opts.IDE_TOOLS?.codebaseSearch || null,
      grepSearch: opts.IDE_TOOLS?.grepSearch || null,
      viewCodeItem: opts.IDE_TOOLS?.viewCodeItem || null,
      readFile: opts.IDE_TOOLS?.readFile || null,
      listDir: opts.IDE_TOOLS?.listDir || null,
      toolsForAnalysis: opts.toolsForAnalysis || [],
    };

    this._ideToolCount = Object.values(this._toolFunctions)
      .filter(v => typeof v === 'function').length;
    if (this._ideToolCount > 0) {
      this._log(`IDE tools injected: ${this._ideToolCount} tool(s) available`);
    }

    this._toolHandlerMap = new Map(TOOL_REGISTRY.map(t => [t.name, t.handler]));
    this._externalHandlers = createAllHandlers(this);

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

  start() {
    this._log('Starting MCP Server...');
    this._log(`Project root: ${this._projectRoot}`);

    this._rl = readline.createInterface({
      input: process.stdin,
      output: undefined,
      terminal: false,
    });

    let buffer = '';

    process.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

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
        }
      }
    });

    process.stdin.on('end', () => { this._log('stdin closed. Shutting down.'); process.exit(0); });
    process.on('SIGTERM', () => { this._log('SIGTERM received.'); process.exit(0); });
    process.on('SIGINT', () => { this._log('SIGINT received.'); process.exit(0); });

    this._log('MCP Server ready. Waiting for JSON-RPC messages on stdin...');
  }

  async _handleMessage(message) {
    if (message.id !== undefined && message.method) {
      return this._handleRequest(message);
    }
    if (message.method && message.id === undefined) {
      return this._handleNotification(message);
    }
  }

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

  async _handleNotification(notif) {
    const handler = this._notificationHandlers.get(notif.method);
    if (handler) {
      try { await handler(notif.params || {}); }
      catch (err) { this._log(`Notification handler error for ${notif.method}: ${err.message}`); }
    }
  }

  _registerHandlers() {
    this._requestHandlers.set('initialize', async (params) => {
      this._log(`Initialize request from: ${params.clientInfo?.name || 'unknown'} v${params.clientInfo?.version || '?'}`);
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    });

    this._notificationHandlers.set('notifications/initialized', async () => {
      this._initialized = true;
      this._log('MCP session initialized successfully.');
    });

    this._requestHandlers.set('tools/list', async () => ({ tools: TOOLS }));

    this._requestHandlers.set('tools/call', async (params) => {
      const { name, arguments: args } = params;
      const handlerName = this._toolHandlerMap.get(name);
      if (!handlerName) throw new Error(`Unknown tool: ${name}`);
      const handler = this._externalHandlers[handlerName] || this[handlerName];
      if (!handler) throw new Error(`Handler "${handlerName}" not found for tool "${name}"`);
      return handler.call(this, args);
    });

    this._requestHandlers.set('ping', async () => ({}));
  }

  _getTriage() {
    if (!this._triage) {
      const { RequestTriage } = require('./request-triage');
      this._triage = new RequestTriage();
    }
    return this._triage;
  }

  checkBridgeParity() {
    return checkBridgeParity(TOOLS, this._orchestratorFactory ? 'full' : 'triage-only', this._toolFunctions);
  }

  formatParityReport(report = null) {
    return formatParityReport(report, TOOLS, this._orchestratorFactory ? 'full' : 'triage-only', this._toolFunctions);
  }

  _toolResponse(text, isError = false) {
    return { content: [{ type: 'text', text }], isError };
  }

  _sendResult(id, result) {
    this._send({ jsonrpc: '2.0', id, result });
  }

  _sendError(id, code, message) {
    this._send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  _send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  _log(msg) {
    process.stderr.write(`[MCPServer] ${msg}\n`);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[i + 1]);
      i++;
    }
  }
  const server = new MCPServer({ projectRoot });
  server.start();
}

module.exports = { MCPServer, TOOLS, TOOL_REGISTRY, MCP_PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION };
