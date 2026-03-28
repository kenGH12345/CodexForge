/**
 * Thick Tools (Hooked) – Hook-enabled versions of all thick tools
 *
 * P1 Implementation: Automatic hook-triggering wrappers for all thick tools.
 * This module creates hooked versions of thick tools using withToolHooks(),
 * enabling automatic BEFORE/AFTER hook emission without changing call signatures.
 *
 * Usage:
 *   // Instead of: const tools = require('./thick-tools');
 *   // Use: const tools = require('./thick-tools-hooked');
 *
 *   // Or via thick-tools.js redirection (when toolHooks.enabled: true)
 *   const tools = require('./thick-tools'); // Returns hooked versions automatically
 *
 * For custom metadata, use withToolHooks directly:
 *   const { withToolHooks } = require('./tool-hook-executor');
 *   const customTool = withToolHooks(myTool, 'myTool', { category: 'analysis' });
 */

'use strict';

const { withToolHooks } = require('./tool-hook-executor');

// ─── Tool Metadata Registry ───────────────────────────────────────────────────

const TOOL_METADATA = {
  getUnfinishedChanges: {
    category: 'analysis',
    description: 'Scans directory for files modified after a given timestamp',
    useWhen: [
      'You need to detect recent changes in the project',
      'Resuming work after interruption',
      'Finding files that need review',
    ],
    doNotUseFor: [
      'Getting specific file contents (use readFile instead)',
      'Comparing file versions (use git diff)',
    ],
    estimatedCost: 'low',
  },
  getProjectStructure: {
    category: 'analysis',
    description: 'Returns a compact tree-style summary of the project structure',
    useWhen: [
      'You need a high-level overview of project layout',
      'Understanding project organization',
      'Finding where specific modules are located',
    ],
    doNotUseFor: [
      'Getting specific file contents',
      'Analyzing code dependencies (use codebase_search)',
      'Large monorepos with >1000 files (may be truncated)',
    ],
    estimatedCost: 'low',
  },
  selectToolStrategy: {
    category: 'decision',
    description: 'Analyzes project scale and recommends thick vs thin tool strategy',
    useWhen: [
      'Initializing agent for a new project',
      'Unsure whether to use thick or thin tools',
      'Token budget is a major concern',
    ],
    doNotUseFor: [
      'Already decided on tool strategy',
      'Quick one-off file reads',
    ],
    estimatedCost: 'low',
  },
  getCodebaseSummary: {
    category: 'analysis',
    description: 'Produces a high-level summary of the codebase',
    useWhen: [
      'Starting work on an unfamiliar codebase',
      'Need to understand overall architecture',
      'Preparing for code review',
    ],
    doNotUseFor: [
      'Finding specific functions (use codebase_search)',
      'Real-time code analysis',
    ],
    estimatedCost: 'high',
  },
  scanCodeSymbols: {
    category: 'analysis',
    description: 'Scans a directory and extracts key symbols (classes, functions)',
    useWhen: [
      'Need to understand API surface of a module',
      'Looking for specific function/class definitions',
      'Generating documentation',
    ],
    doNotUseFor: [
      'Full text search (use grep_search)',
      'Reading implementation details (use view_code_item)',
    ],
    estimatedCost: 'medium',
  },
  generateProjectContext: {
    category: 'context',
    description: 'Generates a comprehensive context document for LLM consumption',
    useWhen: [
      'Starting a complex multi-file task',
      'Need to provide extensive context to LLM',
      'Preparing for architecture discussion',
    ],
    doNotUseFor: [
      'Quick queries (use thin tools)',
      'Token-constrained scenarios',
    ],
    estimatedCost: 'high',
  },
};

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Create hooked versions of all thick tools
 * This factory function is called by thick-tools.js to avoid circular dependencies
 *
 * @param {object} originalTools - The original thick-tools module exports
 * @returns {object} Hooked versions of all tools with metadata
 */
function createHookedTools(originalTools) {
  const hookedTools = {};

  // Wrap all function exports with hooks
  for (const [toolName, toolFn] of Object.entries(originalTools)) {
    if (typeof toolFn === 'function') {
      const metadata = TOOL_METADATA[toolName] || {
        category: 'general',
        description: toolFn.description || toolName,
        estimatedCost: 'medium',
      };

      hookedTools[toolName] = withToolHooks(toolFn, toolName, metadata);
    }
  }

  // Preserve any non-function exports from the original module
  for (const [key, value] of Object.entries(originalTools)) {
    if (typeof value !== 'function' && !(key in hookedTools)) {
      hookedTools[key] = value;
    }
  }

  // Add metadata exports
  hookedTools.TOOL_METADATA = TOOL_METADATA;

  /**
   * Get metadata for a specific tool
   * @param {string} toolName
   * @returns {object|undefined}
   */
  hookedTools.getToolMetadata = (toolName) => TOOL_METADATA[toolName];

  /**
   * List all available tools with their metadata
   * @returns {Array<{name: string, metadata: object}>}
   */
  hookedTools.listTools = () => {
    return Object.entries(TOOL_METADATA).map(([name, metadata]) => ({
      name,
      ...metadata,
    }));
  };

  return hookedTools;
}

// ─── Default Export (for direct usage) ────────────────────────────────────────
// When required directly, returns a factory that needs to be called with originalTools
module.exports = { createHookedTools, TOOL_METADATA };
