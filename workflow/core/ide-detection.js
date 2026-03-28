/**
 * IDE Detection – Detects whether WorkFlowAgent is running inside an IDE.
 *
 * When WorkFlowAgent runs inside an IDE (Cursor, VS Code + Copilot, Claude Code, CodeBuddy),
 * the AI Agent already has access to powerful built-in tools:
 *   - codebase_search (semantic/vector search)
 *   - grep_search     (ripgrep-powered exact text search)
 *   - view_code_item  (symbol-level code viewing)
 *   - read_file       (file reading)
 *   - list_dir        (directory listing)
 *   - IDE's built-in LSP (gotoDefinition, findReferences, hover, callHierarchy, etc.)
 *
 * These capabilities overlap with self-built modules (CodeGraph, LSPAdapter).
 * This module detects the IDE environment so that:
 *   1. LSPAdapter can be skipped (IDE already runs a language server)
 *   2. Prompt instructions can guide Agents to use IDE tools first
 *   3. CodeGraph serves as a cache/fallback rather than the primary search engine
 *   4. Business logic extraction can leverage IDE's Call Hierarchy (ADR-37)
 *
 * Detection signals:
 *   - Environment variables set by IDE processes
 *   - Process tree inspection (parent process names)
 *   - Well-known file/socket indicators
 *
 * Architecture principle: IDE capabilities first, self-built as fallback.
 */

'use strict';

// ─── IDE Environment Signatures ───────────────────────────────────────────────

/**
 * Known IDE environment variable signatures.
 * Each IDE sets specific env vars when running extensions or integrated terminals.
 */
const IDE_SIGNATURES = {
  cursor: {
    name: 'Cursor',
    envVars: ['CURSOR_SESSION', 'CURSOR_TRACE_ID'],
    processNames: ['cursor', 'Cursor'],
    capabilities: {
      codebaseSearch: true,   // Semantic vector search (OpenAI embeddings + Turbopuffer)
      grepSearch: true,       // ripgrep-powered exact text search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,       // Full LSP via IDE (definition, references, hover, symbols)
      callHierarchy: true,    // Call Hierarchy (incoming/outgoing calls) - VS Code 1.16+
      findReferences: true,   // Find All References - LSP capability
      goToDefinition: true,   // Go to Definition - LSP capability
      typeInference: true,    // Type inference via hover - LSP capability
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  vscode: {
    name: 'VS Code',
    envVars: ['VSCODE_PID', 'VSCODE_CWD', 'VSCODE_IPC_HOOK', 'TERM_PROGRAM'],
    processNames: ['code', 'Code'],
    termProgramValue: 'vscode',
    capabilities: {
      codebaseSearch: true,   // Via Copilot or extensions
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,       // Full LSP via IDE
      callHierarchy: true,    // Call Hierarchy (incoming/outgoing calls) - VS Code 1.16+
      findReferences: true,   // Find All References - LSP capability
      goToDefinition: true,   // Go to Definition - LSP capability
      typeInference: true,    // Type inference via hover - LSP capability
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  claudeCode: {
    name: 'Claude Code',
    envVars: ['CLAUDE_CODE', 'ANTHROPIC_SESSION'],
    processNames: ['claude'],
    capabilities: {
      codebaseSearch: true,   // Built-in semantic search (vector-based)
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: false,    // ❌ No view_code_item tool (CLI tool, not IDE)
      readFile: true,         // Read tool (file reading)
      listDir: true,          // List tool (directory listing)
      builtinLSP: false,      // ❌ No LSP client (CLI tool, not IDE)
      callHierarchy: false,   // ❌ No Call Hierarchy (no LSP support)
      findReferences: true,   // ⚠️ Via grep_search (text search, not LSP)
      goToDefinition: true,   // ⚠️ Via grep_search + Read (text search, not actual LSP goto-def)
      typeInference: false,   // ❌ No type inference/hover (no LSP)
      terminal: true,         // Bash tool (terminal command execution)
      editFile: true,         // Edit tool (file editing)
    },
    notes: [
      'Claude Code is a CLI agent (not IDE), no LSP support',
      'Code navigation via text search (grep) not compiler-accurate',
      'Consider connecting MCP LSP servers for IDE-like features',
    ],
  },
  windsurf: {
    name: 'Windsurf',
    envVars: ['WINDSURF_SESSION'],
    processNames: ['windsurf', 'Windsurf'],
    capabilities: {
      codebaseSearch: true,
      grepSearch: true,
      viewCodeItem: true,
      readFile: true,
      listDir: true,
      builtinLSP: true,
      callHierarchy: true,    // Windsurf (VS Code fork) has Call Hierarchy
      findReferences: true,
      goToDefinition: true,
      typeInference: true,
      terminal: true,
      editFile: true,
    },
  },
  codeBuddy: {
    name: 'CodeBuddy',
    envVars: ['CODEBUDDY_API_KEY', 'CODEBUDDY_AUTH_TOKEN'],
    processNames: ['codebuddy', 'CodeBuddy'],
    capabilities: {
      codebaseSearch: true,   // Semantic search (built-in, VS Code fork)
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: true,       // Full LSP via IDE (VS Code fork, complete LSP support)
      callHierarchy: true,    // Call Hierarchy (VS Code fork, has this feature)
      findReferences: true,   // Find All References - LSP capability
      goToDefinition: true,   // Go to Definition - LSP capability
      typeInference: true,    // Type inference via hover - LSP capability
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
  rooCode: {
    name: 'Roo Code',
    envVars: ['ROO_CODE', 'ROO_API_KEY', 'VSCODE_PID'],
    processNames: ['roo', 'Roo'],
    capabilities: {
      codebaseSearch: true,   // Built-in semantic search
      grepSearch: true,       // ripgrep-powered search
      viewCodeItem: true,     // Symbol-level code viewer
      readFile: true,         // File reading
      listDir: true,          // Directory listing
      builtinLSP: false,      // No direct LSP (uses tools instead)
      callHierarchy: false,   // No direct Call Hierarchy
      findReferences: true,   // Via grep_search
      goToDefinition: true,   // Via view_code_item
      typeInference: false,   // No direct type inference
      terminal: true,         // Terminal command execution
      editFile: true,         // File editing
    },
  },
};

// ─── Detection Result Cache ───────────────────────────────────────────────────

/** @type {IDEDetectionResult|null} Cached detection result (per-process singleton) */
let _cachedResult = null;

// ─── Detection Logic ──────────────────────────────────────────────────────────

/**
 * Detects whether the current process is running inside an IDE.
 *
 * @param {object} [options]
 * @param {boolean} [options.forceRedetect=false] - Bypass cache and re-detect
 * @param {object}  [options.config]              - workflow.config.js contents (for forceStandalone/forceIDE)
 * @returns {IDEDetectionResult}
 */
function detectIDEEnvironment(options = {}) {
  if (_cachedResult && !options.forceRedetect) {
    return _cachedResult;
  }

  // ── Configuration overrides ──────────────────────────────────────────────
  // Support `ide.forceStandalone: true` from workflow.config.js
  // This is useful in CI/CD where VSCODE_PID may be inherited from the parent
  // process but no IDE tools are actually available.
  const ideConfig = (options.config && options.config.ide) || {};

  const result = {
    /** @type {boolean} True if running inside any known IDE */
    isInsideIDE: false,
    /** @type {string|null} IDE name (e.g. 'Cursor', 'VS Code', 'Claude Code') */
    ideName: null,
    /** @type {string|null} IDE key (e.g. 'cursor', 'vscode', 'claudeCode') */
    ideKey: null,
    /** @type {object} Available IDE capabilities */
    capabilities: {
      codebaseSearch: false,
      grepSearch: false,
      viewCodeItem: false,
      readFile: false,
      listDir: false,
      builtinLSP: false,
      callHierarchy: false,    // Call Hierarchy (incoming/outgoing calls)
      findReferences: false,   // Find All References
      goToDefinition: false,   // Go to Definition
      typeInference: false,    // Type inference via hover
      terminal: false,
      editFile: false,
    },
    /** @type {string[]} Detection signals that matched */
    matchedSignals: [],
    /** @type {string} Human-readable summary */
    summary: '',
  };

  const env = process.env;

  // ── forceStandalone: treat as non-IDE regardless of env vars ────────────
  if (ideConfig.forceStandalone) {
    result.summary = 'Running standalone (forced by ide.forceStandalone config)';
    _cachedResult = result;
    console.log(`[IDEDetection] 🖥️  ${result.summary}`);
    return result;
  }

  // ── forceIDE: override detection with a specific IDE identity ───────────
  if (ideConfig.forceIDE && IDE_SIGNATURES[ideConfig.forceIDE]) {
    const sig = IDE_SIGNATURES[ideConfig.forceIDE];
    result.isInsideIDE = true;
    result.ideName = sig.name;
    result.ideKey = ideConfig.forceIDE;
    result.capabilities = { ...sig.capabilities };
    result.matchedSignals = ['config:forceIDE'];
    result.summary = `Running as ${sig.name} (forced by ide.forceIDE config)`;
    _cachedResult = result;
    console.log(`[IDEDetection] 🏠 ${result.summary}`);
    return result;
  }

  for (const [ideKey, sig] of Object.entries(IDE_SIGNATURES)) {
    const signals = [];

    // Check environment variables
    for (const envVar of sig.envVars) {
      if (env[envVar]) {
        signals.push(`env:${envVar}=${env[envVar].slice(0, 20)}`);
      }
    }

    // Check TERM_PROGRAM for VS Code
    if (sig.termProgramValue && env.TERM_PROGRAM === sig.termProgramValue) {
      signals.push(`TERM_PROGRAM=${sig.termProgramValue}`);
    }

    // If any signal matched, we're inside this IDE
    if (signals.length > 0) {
      result.isInsideIDE = true;
      result.ideName = sig.name;
      result.ideKey = ideKey;
      result.capabilities = { ...sig.capabilities };
      result.matchedSignals = signals;
      result.summary = `Running inside ${sig.name} (detected via: ${signals.join(', ')})`;
      break;
    }
  }

  if (!result.isInsideIDE) {
    result.summary = 'Running standalone (no IDE detected)';
  }

  _cachedResult = result;

  // Log detection result
  if (result.isInsideIDE) {
    const caps = Object.entries(result.capabilities)
      .filter(([, v]) => v)
      .map(([k]) => k);
    console.log(`[IDEDetection] 🏠 ${result.summary}`);
    console.log(`[IDEDetection]    Available IDE capabilities: ${caps.join(', ')}`);
  } else {
    console.log(`[IDEDetection] 🖥️  ${result.summary}`);
  }

  return result;
}

/**
 * Returns whether the LSP adapter should be skipped because the IDE
 * already provides LSP capabilities.
 *
 * @returns {boolean} True if LSP adapter spawn should be skipped
 */
function shouldSkipLSPAdapter() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.builtinLSP;
}

/**
 * Returns whether CodeGraph search should defer to IDE's codebase_search.
 *
 * Note: CodeGraph is still valuable as a cache and for features the IDE doesn't
 * provide (hotspot analysis, module summary, reusable symbols digest).
 * This flag indicates that for raw search queries, the Agent should prefer
 * IDE's codebase_search tool over CodeGraph.search().
 *
 * @returns {boolean} True if IDE has semantic search capability
 */
function ideHasSemanticSearch() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.codebaseSearch;
}

/**
 * Returns whether the IDE has Call Hierarchy capability.
 * Call Hierarchy is a powerful LSP feature for tracing incoming/outgoing calls.
 *
 * When available, business logic extraction should prefer IDE's Call Hierarchy
 * over CodeGraph's call graph for maximum accuracy (ADR-37).
 *
 * @returns {boolean} True if IDE has Call Hierarchy capability
 */
function ideHasCallHierarchy() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.callHierarchy;
}

/**
 * Returns whether the IDE has Find References capability.
 * Find References is useful for identifying all usages of a symbol.
 *
 * @returns {boolean} True if IDE has Find References capability
 */
function ideHasFindReferences() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.findReferences;
}

/**
 * Returns whether the IDE has Go to Definition capability.
 *
 * @returns {boolean} True if IDE has Go to Definition capability
 */
function ideHasGoToDefinition() {
  const detection = detectIDEEnvironment();
  return detection.isInsideIDE && detection.capabilities.goToDefinition;
}

/**
 * Generates a prompt guidance block that instructs AI Agents to prefer
 * IDE tools over self-built modules when running inside an IDE.
 *
 * This block is injected into Agent prompts by the PromptBuilder.
 *
 * @returns {string|null} Markdown guidance block, or null if not inside an IDE
 */
function generateIDEToolGuidance() {
  const detection = detectIDEEnvironment();
  if (!detection.isInsideIDE) return null;

  // Special handling for CLI tools (Claude Code, Roo Code) vs full IDEs
  const isFullIDE = detection.capabilities.builtinLSP;
  const icon = isFullIDE ? '🏠' : '⌨️';
  const toolType = isFullIDE ? 'IDE-native tools' : 'CLI tools';

  const lines = [
    `## ${icon} Tool Guidance (${detection.ideName} detected)`,
    '',
    `> You are running inside **${detection.ideName}**. Prefer ${toolType} over injected context for maximum accuracy and speed.`,
    '',
  ];

  // Add warning for CLI tools without LSP support
  if (!isFullIDE && detection.ideKey === 'claudeCode') {
    lines.push('⚠️ **Note**: Claude Code is a CLI agent (not a full IDE). It lacks compiler-accurate');
    lines.push('   LSP features like `view_code_item`, call hierarchy, and type inference.');
    lines.push('   Consider connecting MCP LSP servers for enhanced IDE capabilities.');
    lines.push('');
  }

  lines.push('### Tool Priority (Built-in first, self-built fallback)');
  lines.push('');
  lines.push('| Need | ✅ Prefer (built-in) | 🔄 Fallback (self-built) |');
  lines.push('|------|---------------------|-------------------------|');

  if (detection.capabilities.codebaseSearch) {
    lines.push('| Semantic code search | `codebase_search` (vector/semantic) | CodeGraph.search() (TF-IDF) |');
  }
  if (detection.capabilities.grepSearch) {
    lines.push('| Exact text search | `grep_search` (ripgrep) | CodeGraph.search() (substring) |');
  }
  
  // Claude Code doesn't have view_code_item - use Read + grep instead
  if (detection.capabilities.viewCodeItem) {
    lines.push('| Symbol lookup | `view_code_item` (compiler-accurate) | CodeGraph.querySymbol() (regex) |');
  } else if (detection.ideKey === 'claudeCode') {
    lines.push('| Symbol lookup | `Read` + `Grep` (text search) | CodeGraph.querySymbol() (regex) |');
  }
  
  if (detection.capabilities.builtinLSP) {
    lines.push('| Go to definition | IDE built-in LSP | LSPAdapter (self-spawned) |');
    lines.push('| Find references | IDE built-in LSP | LSPAdapter (self-spawned) |');
    lines.push('| Type inference / hover | IDE built-in LSP (hover) | LSPAdapter.getHover() |');
  } else if (detection.ideKey === 'claudeCode') {
    lines.push('| Go to definition | `Grep` + `Read` (text search) | CodeGraph + LSPAdapter |');
    lines.push('| Find references | `Grep` (text search) | CodeGraph |');
    lines.push('| Type inference | ❌ Not available (consider MCP) | LSPAdapter.getHover() |');
  }
  
  if (detection.capabilities.callHierarchy) {
    lines.push('| Call Hierarchy | IDE built-in LSP (Call Hierarchy) | CodeGraph.getCallGraph() |');
  } else if (detection.ideKey === 'claudeCode') {
    lines.push('| Call Hierarchy | ❌ Not available | CodeGraph.getCallGraph() (approximate) |');
  }
  
  if (detection.capabilities.readFile) {
    lines.push('| Read file content | `read_file` (real-time) | ContextLoader cache (static snapshot) |');
  }

  lines.push('');
  lines.push('### When to Use Built-in Tools');
  lines.push('');
  lines.push('- **Searching code**: Use `codebase_search` for semantic queries ("where is authentication handled?")');
  lines.push('  and `grep_search` for exact matches ("find all uses of `validateToken`").');
  
  if (detection.capabilities.viewCodeItem) {
    lines.push('- **Understanding symbols**: Use `view_code_item` to read a class or function definition.');
  } else {
    lines.push('- **Understanding symbols**: Use `Read` file then search with `Grep` for symbols (no `view_code_item` available).');
  }
  
  if (detection.capabilities.builtinLSP) {
    lines.push('- **Type information**: Use IDE hover (LSP) to inspect types, signatures, and documentation of any symbol.');
  } else {
    lines.push('- **Type information**: ⚠️ Limited - Run LSPAdapter or connect MCP LSP server for type info.');
  }
  
  lines.push('- **Exploring structure**: Use `list_dir` to explore directory structure.');
  lines.push('');

  // Add Call Hierarchy guidance if available
  if (detection.capabilities.callHierarchy) {
    lines.push('### 🔄 Call Hierarchy for Business Logic Analysis');
    lines.push('');
    lines.push('When analyzing business logic flows, use IDE\'s **Call Hierarchy** feature:');
    lines.push('');
    lines.push('1. **Right-click** on any function → **Call Hierarchy**');
    lines.push('2. View **Incoming Calls** (who calls this function)');
    lines.push('3. View **Outgoing Calls** (what this function calls)');
    lines.push('4. **Recursively expand** to trace the full call chain');
    lines.push('');
    lines.push('This provides **compiler-accurate** call graph analysis, more precise than CodeGraph.');
    lines.push('');
  } else if (detection.ideKey === 'claudeCode') {
    lines.push('### 🔄 Call Hierarchy Limitation (Claude Code)');
    lines.push('');
    lines.push('⚠️ **Claude Code does not have Call Hierarchy**.');
    lines.push('');
    lines.push('For call graph analysis, use:');
    lines.push('- **CodeGraph.getCallGraph()** - Provides approximate call analysis via code parsing');
    lines.push('- **Connect MCP LSP server** - For compiler-accurate call hierarchy');
    lines.push('');
  }

  lines.push('### When to Use Self-Built Context (injected by workflow)');
  lines.push('');
  lines.push('- **Hotspot analysis**: Code Graph\'s hotspot/reusable symbols — IDE has no equivalent.');
  lines.push('- **Module summary**: Code Graph\'s module-level codebase overview — IDE has no equivalent.');
  lines.push('- **Skill/experience matching**: ContextLoader\'s domain skill injection — IDE has no equivalent.');
  lines.push('- **Project profiling**: ProjectProfiler\'s tech stack analysis — IDE has no equivalent.');
  lines.push('- **Architecture decisions**: Decision log (ADR) digest — IDE has no equivalent.');
  lines.push('- **Business logic patterns**: BusinessLogicExtractor\'s entry points/flows — IDE has no equivalent.');
  lines.push('');

  return lines.join('\n');
}
/**
 * Returns the cached detection result, or performs detection if not cached.
 * @returns {IDEDetectionResult}
 */
function getIDEDetectionResult() {
  return detectIDEEnvironment();
}

module.exports = {
  detectIDEEnvironment,
  shouldSkipLSPAdapter,
  ideHasSemanticSearch,
  ideHasCallHierarchy,
  ideHasFindReferences,
  ideHasGoToDefinition,
  generateIDEToolGuidance,
  getIDEDetectionResult,
  IDE_SIGNATURES,
};
