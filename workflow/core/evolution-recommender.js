/**
 * Evolution Recommender – Third layer of Problem Abstraction Engine
 *
 * Generates Architecture Decision Records (ADRs) for triggered patterns,
 * manages the architecture change queue, and provides concrete refactoring
 * suggestions.
 *
 * Phase 2 Implementation:
 *   1. ADR Proposal Generator – Creates ADR-XX documents for architecture changes
 *   2. Architecture Change Queue – Tracks pending evolution proposals
 *   3. Refactoring Advisor – Specific code transformation guidance
 *
 * Design principles:
 *   - ADR format follows project standards (ADR-XXX: Title)
 *   - Zero LLM calls for standard patterns (ADR-37 compliance)
 *   - Template-based code generation
 *   - Queue supports priority and status tracking
 *
 * @module evolution-recommender
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Code Refactoring Templates ─────────────────────────────────────────────

/**
 * Refactoring templates for detected patterns.
 * Each template provides:
 *   - description: What the refactoring does
 *   - beforeExample: Current problematic code pattern
 *   - afterExample: Refactored solution
 *   - steps: Step-by-step transformation instructions
 *   - files: List of files likely to need changes
 *   - effort: Estimated effort in hours
 */
const REFACTORING_TEMPLATES = {
  HARDCODED_CONFIG_ENTRY: {
    patternId: 'HARDCODED_CONFIG_ENTRY',
    refactoringName: 'Extract Provider Pattern',
    description: 'Replace hardcoded configuration lists with dynamic provider registration system',
    architecturalPattern: 'Provider Pattern',

    beforeExample: `// BEFORE: Hardcoded list in ide-detection.js
const IDE_SIGNATURES = {
  vscode: { name: 'VS Code', envVars: ['VSCODE'] },
  cursor: { name: 'Cursor', envVars: ['CURSOR'] },
  windsurf: { name: 'Windsurf', envVars: ['WINDSURF'] },
  // New IDEs require editing this file
};`,

    afterExample: `// AFTER: Dynamic provider registration
const ideProvider = require('./ide-provider');

// Register IDE providers dynamically
ideProvider.register('vscode', {
  name: 'VS Code',
  envVars: ['VSCODE'],
});

ideProvider.register('cursor', {
  name: 'Cursor',
  envVars: ['CURSOR'],
});

// Detection loop uses dynamic registry
function detectIDE() {
  for (const [key, config] of ideProvider.getAll()) {
    if (matchesEnv(config.envVars)) return config;
  }
}`,

    implementationPlan: [
      {
        step: 1,
        title: 'Create Provider Registry Module',
        description: 'Create new module to manage dynamic registrations',
        exampleFile: 'workflow/core/provider-registry.js',
        code: `class ProviderRegistry {
  constructor() {
    this.providers = new Map();
  }
  
  register(key, config) {
    this.providers.set(key, config);
  }
  
  get(key) {
    return this.providers.get(key);
  }
  
  getAll() {
    return this.providers.entries();
  }
  
  has(key) {
    return this.providers.has(key);
  }
}

module.exports = { ProviderRegistry };`,
      },
      {
        step: 2,
        title: 'Extract IDE Provider',
        description: 'Create IDE-specific provider using registry',
        exampleFile: 'workflow/core/ide-provider.js',
        code: `const { ProviderRegistry } = require('./provider-registry');

const ideProvider = new ProviderRegistry();

// Auto-load from config file if exists
function loadFromConfig(configPath) {
  if (require('fs').existsSync(configPath)) {
    const configs = require(configPath);
    Object.entries(configs).forEach(([key, config]) => {
      ideProvider.register(key, config);
    });
  }
}

module.exports = { ideProvider, loadFromConfig };`,
      },
      {
        step: 3,
        title: 'Migrate Existing Hardcoded Entries',
        description: 'Move existing hardcoded entries to config file or registration calls',
        exampleFile: 'config/ides.json',
        code: JSON.stringify({
          vscode: { name: 'VS Code', envVars: ['VSCODE'] },
          cursor: { name: 'Cursor', envVars: ['CURSOR'] },
          windsurf: { name: 'Windsurf', envVars: ['WINDSURF'] },
        }, null, 2),
      },
      {
        step: 4,
        title: 'Refactor Detection Logic',
        description: 'Update detection code to use provider',
        code: `// Replace direct object access with provider lookup
const { ideProvider } = require('./ide-provider');

// Old: IDE_SIGNATURES[ideKey]
// New: ideProvider.get(ideKey)`,
      },
    ],

    filesToModify: [
      'workflow/core/ide-detection.js',
      'workflow/core/provider-registry.js (create)',
      'workflow/core/ide-provider.js (create)',
      'config/ides.json (create)',
    ],

    effort: {
      estimatedHours: 4,
      complexity: 'medium',
      riskLevel: 'low',
    },

    benefits: [
      'New IDEs can be added without code changes',
      'Configuration externalized to JSON file',
      'Easier testing with mock providers',
      'Reduces merge conflicts on core files',
    ],
  },

  SIMILAR_CONDITIONALS: {
    patternId: 'SIMILAR_CONDITIONALS',
    refactoringName: 'Extract Strategy Pattern',
    description: 'Replace similar conditional branches with Strategy pattern implementation',
    architecturalPattern: 'Strategy Pattern',

    beforeExample: `// BEFORE: Similar conditionals
if (type === 'json') {
  return parseJson(content);
} else if (type === 'yaml') {
  return parseYaml(content);
} else if (type === 'xml') {
  return parseXml(content);
} else if (type === 'toml') {
  return parseToml(content);
}`,

    afterExample: `// AFTER: Strategy pattern
const parsers = new Map([
  ['json', parseJson],
  ['yaml', parseYaml],
  ['xml', parseXml],
  ['toml', parseToml],
]);

function parseContent(type, content) {
  const parser = parsers.get(type);
  if (!parser) throw new Error(\`Unknown type: \${type}\`);
  return parser(content);
}`,

    implementationPlan: [
      {
        step: 1,
        title: 'Analyze Dispatch Variable',
        description: 'Identify the variable used for type-based dispatch (e.g., type, format, mode)',
        code: `// Find this pattern in source:
if (type === 'json') { ... }  // type is dispatch variable
else if (type === 'yaml') { ... }

// Record all type values: ['json', 'yaml', 'xml', 'toml']`,
      },
      {
        step: 2,
        title: 'Generate Strategy Map Module',
        description: 'Create new module with Map-based strategy registry',
        exampleFile: 'workflow/strategies/parser-strategies.js',
        code: `const { StrategyRegistry } = require('./strategy-registry');

const parserStrategies = new StrategyRegistry('ParserStrategy');

// Register all strategies
parserStrategies.register('json', parseJson);
parserStrategies.register('yaml', parseYaml);
parserStrategies.register('xml', parseXml);
parserStrategies.register('toml', parseToml);

module.exports = { parserStrategies };`,
      },
      {
        step: 3,
        title: 'Generate Strategy Registry (if not exists)',
        description: 'Create generic StrategyRegistry base class',
        exampleFile: 'workflow/core/strategy-registry.js',
        code: `class StrategyRegistry {
  constructor(name) {
    this.name = name;
    this.strategies = new Map();
  }

  register(type, handler) {
    this.strategies.set(type, handler);
    return this;
  }

  execute(type, ...args) {
    const handler = this.strategies.get(type);
    if (!handler) {
      throw new Error(\`Unknown \${this.name}: \${type}\`);
    }
    return handler(...args);
  }

  get types() {
    return Array.from(this.strategies.keys());
  }
}

module.exports = { StrategyRegistry };`,
      },
      {
        step: 4,
        title: 'Replace Conditional Chain with Strategy Lookup',
        description: 'Use AST Transform Engine or regex to replace if-else chain',
        code: `// BEFORE (Original)
if (type === 'json') {
  return parseJson(content);
} else if (type === 'yaml') {
  return parseYaml(content);
} // ... etc

// AFTER (Auto-generated)
const { parserStrategies } = require('./strategies/parser-strategies');

return parserStrategies.execute(type, content);`,
      },
      {
        step: 5,
        title: 'Extract Individual Strategy Functions (Optional)',
        description: 'If strategies are large, extract to separate modules',
        exampleFile: 'workflow/strategies/handlers/parse-json.js',
        code: `function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new ParseError('Invalid JSON', { cause: err });
  }
}

module.exports = { parseJson };`,
      },
      {
        step: 6,
        title: 'Update Tests',
        description: 'Add tests for strategy lookup and individual strategies',
        code: `describe('Parser Strategies', () => {
  it('should parse JSON', () => {
    expect(parserStrategies.execute('json', '{"a":1}'))
      .toEqual({ a: 1 });
  });

  it('should throw on unknown type', () => {
    expect(() => parserStrategies.execute('unknown', ''))
      .toThrow('Unknown ParserStrategy: unknown');
  });
});`,
      },
    ],

    filesToModify: [
      'Original file with conditionals (refactor)',
      'workflow/core/strategy-registry.js (create)',
      'workflow/strategies/<domain>-strategies.js (create)',
      'workflow/strategies/handlers/*.js (optional, create)',
    ],

    effort: {
      estimatedHours: 6,
      complexity: 'medium',
      riskLevel: 'medium',
    },

    benefits: [
      'Easier to add new strategies without modifying existing code',
      'Strategies can be tested in isolation',
      'Eliminates duplicate conditional logic',
    ],
  },

  DUPLICATE_ERROR_HANDLING: {
    patternId: 'DUPLICATE_ERROR_HANDLING',
    refactoringName: 'Centralize Error Handling',
    description: 'Extract common error handling into centralized middleware or utility',
    architecturalPattern: 'Middleware / Centralized Handler',

    beforeExample: `// BEFORE: Repeated error handling in multiple locations
try {
  await operation1();
} catch (err) {
  console.error('Operation failed:', err.message);
  logger.log(err);
  notifyUser(err);
}

try {
  await operation2();
} catch (err) {
  console.error('Operation failed:', err.message);
  logger.log(err);
  notifyUser(err);
}`,

    afterExample: `// AFTER: Centralized error handler
const { withErrorHandling } = require('./error-handler');

const safeOperation1 = withErrorHandling(operation1);
const safeOperation2 = withErrorHandling(operation2);

await safeOperation1();
await safeOperation2();

// error-handler.js
function withErrorHandling(fn) {
  return async function(...args) {
    try {
      return await fn.apply(this, args);
    } catch (err) {
      handleError(err);
    }
  };
}`,

    implementationPlan: [
      {
        step: 1,
        title: 'Identify Common Error Handler Pattern',
        description: 'Use regex or AST detection to find repeated error handling blocks',
        code: `// Use code-checker.js to detect:
const checker = require('./code-checker');

// Find try-catch blocks with similar bodies
const results = checker.analyzeDirectory('./src', {
  patterns: ['TRY_CATCH_BLOCKS'],
});

// Look for blocks with same:
// - console.error() calls
// - logger.log() calls
// - notifyUser() calls`,
      },
      {
        step: 2,
        title: 'Generate Error Handler Module',
        description: 'Create centralized error handler with configurable behavior',
        exampleFile: 'workflow/core/error-handler.js',
        code: `const logger = require('../utils/logger');
const { metrics } = require('../utils/metrics');

/**
 * Configuration for error handling behavior.
 */
const defaultConfig = {
  logLevel: 'error',
  rethrow: true,
  notify: false,
  fallback: null,
};

/**
 * Centralized error handler function.
 *
 * @param {Error} err – The error object
 * @param {object} context – Error context (function name, args, etc.)
 * @param {object} config – Handler configuration
 */
function handleError(err, context = {}, config = {}) {
  const cfg = { ...defaultConfig, ...config };

  // Log error
  logger[cfg.logLevel](\`Error in \${context.functionName || 'anonymous'}: \${err.message}\`, {
    error: err.message,
    stack: err.stack,
    context,
  });

  // Record metrics
  metrics.increment('errors', {
    function: context.functionName,
    type: err.name,
  });

  // Notify if configured
  if (cfg.notify) {
    notifyError(err, context);
  }

  return cfg;
}

/**
 * Wrap async function with error handling.
 */
function withErrorHandling(fn, config = {}) {
  return async function(...args) {
    try {
      return await fn.apply(this, args);
    } catch (err) {
      handleError(err, { functionName: fn.name, args }, config);
      if (config.rethrow !== false) throw err;
      return config.fallback;
    }
  };
}

module.exports = { handleError, withErrorHandling };`,
      },
      {
        step: 3,
        title: 'Generate Wrapper Applications',
        description: 'Create wrapped versions of original functions',
        code: `// BEFORE: Repeated try-catch
async function operation1() {
  try {
    await riskyCall1();
  } catch (err) {
    console.error('Failed:', err);
    logger.log(err);
  }
}

// AFTER: Wrapped with error handler
const { withErrorHandling } = require('./error-handler');

const operation1 = withErrorHandling(
  async function operation1_impl() {
    await riskyCall1();
  },
  { rethrow: false }  // Config per function
);`,
      },
      {
        step: 4,
        title: 'Replace Original Try-Catch Blocks (AST Transform)',
        description: 'Use CENTRALIZE_ERROR_HANDLING transform from code-generator.js',
        code: `// Option 1: AST Transform (Recommended)
const CodeGenerator = require('./code-generator');
const generator = new CodeGenerator();

generator.transformFile('src/services/operations.js', {
  spec: 'CENTRALIZE_ERROR_HANDLING',
  options: {
    wrapperName: 'withErrorHandling',
    handlerPath: '../core/error-handler',
  },
});

// Option 2: Manual replacement for simple cases
// Replace each try-catch with wrapped call`,
      },
      {
        step: 5,
        title: 'Add Error Handler Tests',
        description: 'Verify error handling behavior is preserved',
        code: `const { handleError, withErrorHandling } = require('./error-handler');

describe('Error Handler', () => {
  it('should log and rethrow by default', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('test'));
    const wrapped = withErrorHandling(fn);

    await expect(wrapped()).rejects.toThrow('test');
    expect(logger.error).toHaveBeenCalled();
  });

  it('should return fallback when rethrow is false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('test'));
    const wrapped = withErrorHandling(fn, { rethrow: false, fallback: 'default' });

    const result = await wrapped();
    expect(result).toBe('default');
  });
});`,
      },
    ],

    filesToModify: [
      'Original files with duplicate error handling',
      'workflow/core/error-handler.js (create)',
    ],

    effort: {
      estimatedHours: 3,
      complexity: 'low',
      riskLevel: 'low',
    },

    benefits: [
      'Consistent error handling across application',
      'Single point for error logging/monitoring',
      'Reduced code duplication',
    ],
  },
};

// ─── ADR Generator ──────────────────────────────────────────────────────────

/**
 * ADR Generator – Creates Architecture Decision Records from triggered patterns.
 *
 * Generates ADR documents following project standard format:
 *   ADR-XXX: Title
 *   Status: Proposed
 *   Context: Pattern detection evidence and rationale
 *   Decision: Specific architecture change
 *   Consequences: Impact analysis
 */
class ADRGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './docs/adr';
    this.nextAdrNumber = options.nextAdrNumber || this._detectNextAdrNumber();
    this.generatedADRs = [];
  }

  /**
   * Detect the next available ADR number from existing files.
   *
   * @private
   */
  _detectNextAdrNumber() {
    try {
      if (!fs.existsSync(this.outputDir)) return 1;

      const files = fs.readdirSync(this.outputDir);
      const numbers = files
        .filter(f => f.match(/^ADR-(\d+)/))
        .map(f => parseInt(f.match(/^ADR-(\d+)/)[1]));

      return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    } catch (err) {
      return 1;
    }
  }

  /**
   * Generate ADR for a triggered pattern.
   *
   * @param {TriggeredPattern} triggeredPattern
   * @param {PatternTrend} [trend]
   * @returns {ADRProposal}
   */
  generate(triggeredPattern, trend = null) {
    const template = REFACTORING_TEMPLATES[triggeredPattern.patternId];
    const adrNumber = this.nextAdrNumber++;

    const adr = {
      id: `ADR-${String(adrNumber).padStart(3, '0')}`,
      number: adrNumber,
      status: 'Proposed',
      title: this._generateTitle(triggeredPattern, template),
      context: this._generateContext(triggeredPattern, trend),
      decision: this._generateDecision(triggeredPattern, template),
      consequences: this._generateConsequences(triggeredPattern, template),
      generatedAt: new Date().toISOString(),
      metadata: {
        patternId: triggeredPattern.patternId,
        patternName: triggeredPattern.patternName,
        occurrenceCount: triggeredPattern.occurrenceCount,
        severity: triggeredPattern.severity,
        velocity: trend?.velocity || 0,
        confidence: triggeredPattern.confidence,
      },
    };

    this.generatedADRs.push(adr);
    return adr;
  }

  /**
   * Generate ADR title.
   *
   * @private
   */
  _generateTitle(triggeredPattern, template) {
    if (template) {
      return `Adopt ${template.architecturalPattern} to resolve ${triggeredPattern.patternName}`;
    }
    return `Address ${triggeredPattern.patternName} through architecture evolution`;
  }

  /**
   * Generate ADR context section.
   *
   * @private
   */
  _generateContext(triggeredPattern, trend) {
    const lines = [
      '## Context',
      '',
      `**Pattern Detected**: ${triggeredPattern.patternName}`,
      `**Pattern ID**: ${triggeredPattern.patternId}`,
      `**Occurrences**: ${triggeredPattern.occurrenceCount} (threshold: ${triggeredPattern.threshold})`,
      '',
      '### Evidence',
      '',
      `The pattern has been detected ${triggeredPattern.occurrenceCount} times across recent experience records.`,
      '',
    ];

    if (trend) {
      lines.push(
        '### Trend Analysis',
        '',
        `- **Velocity**: ${trend.velocity} occurrences/week`,
        `- **Growth Rate**: ${trend.growthRate}%`,
        `- **Trend Direction**: ${trend.trend}`,
        ''
      );
    }

    lines.push(
      '### Problem Statement',
      '',
      'The repeated occurrence of this pattern indicates a structural issue in the architecture.',
      'Without intervention, this pattern will continue to require similar fixes, increasing',
      'maintenance burden and architectural entropy.',
      ''
    );

    return lines.join('\n');
  }

  /**
   * Generate ADR decision section.
   *
   * @private
   */
  _generateDecision(triggeredPattern, template) {
    const lines = ['## Decision', ''];

    if (template) {
      lines.push(
        `**Decision**: ${template.refactoringName}`,
        '',
        '### Approach',
        '',
        template.description,
        '',
        '### Implementation Plan',
        ''
      );

      template.implementationPlan.forEach(step => {
        lines.push(
          `#### Step ${step.step}: ${step.title}`,
          '',
          step.description,
          ''
        );

        if (step.exampleFile) {
          lines.push(`**File**: \`${step.exampleFile}\``);
        }

        if (step.code) {
          lines.push('', '```javascript', step.code, '```', '');
        }
      });
    } else {
      lines.push(
        `**Decision**: ${triggeredPattern.recommendation}`,
        '',
        'Specific implementation details to be determined based on code analysis.',
        ''
      );
    }

    return lines.join('\n');
  }

  /**
   * Generate ADR consequences section.
   *
   * @private
   */
  _generateConsequences(triggeredPattern, template) {
    const lines = ['## Consequences', ''];

    // Positive consequences
    lines.push('### Positive', '');

    if (template?.benefits) {
      template.benefits.forEach(benefit => {
        lines.push(`- ${benefit}`);
      });
    } else {
      lines.push('- Reduces recurring maintenance tasks');
      lines.push('- Improves code maintainability');
      lines.push('- Reduces architectural entropy');
    }

    lines.push('');

    // Negative consequences / risks
    lines.push('### Risks', '');

    if (template?.effort) {
      lines.push(`- **Effort Required**: ~${template.effort.estimatedHours} hours`);
      lines.push(`- **Complexity**: ${template.effort.complexity}`);
      lines.push(`- **Implementation Risk**: ${template.effort.riskLevel}`);
    } else {
      lines.push('- Implementation effort required');
      lines.push('- Potential for regression during refactoring');
    }

    lines.push(
      '',
      '### Monitoring',
      '',
      'After implementation, the Problem Abstraction Engine will monitor for:',
      `- Reduction in ${triggeredPattern.patternName} occurrences`,
      '- Overall architecture entropy trends',
      ''
    );

    return lines.join('\n');
  }

  /**
   * Render ADR as markdown document.
   *
   * @param {ADRProposal} adr
   * @returns {string}
   */
  renderMarkdown(adr) {
    const lines = [
      `# ${adr.id}: ${adr.title}`,
      '',
      `**Status**: ${adr.status}`,
      `**Generated**: ${new Date(adr.generatedAt).toLocaleString()}`,
      '',
      `> **Triggered by**: ${adr.metadata.patternName}`,
      `> **Occurrences**: ${adr.metadata.occurrenceCount} | **Severity**: ${adr.metadata.severity}`,
      '',
      '---',
      '',
      adr.context,
      '',
      adr.decision,
      '',
      adr.consequences,
      '',
      '---',
      '',
      '*Generated by WorkFlowAgent Evolution Recommender*',
    ];

    return lines.join('\n');
  }

  /**
   * Save ADR to file.
   *
   * @param {ADRProposal} adr
   * @returns {string} File path
   */
  saveToFile(adr) {
    const filename = `${adr.id}-${adr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    const filepath = path.join(this.outputDir, filename);

    // Ensure directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const content = this.renderMarkdown(adr);
    fs.writeFileSync(filepath, content, 'utf-8');

    return filepath;
  }

  /**
   * Get all generated ADRs.
   *
   * @returns {ADRProposal[]}
   */
  getGeneratedADRs() {
    return [...this.generatedADRs];
  }
}

// ─── Architecture Change Queue ──────────────────────────────────────────────

/**
 * Architecture Change Queue – Tracks pending evolution proposals.
 *
 * Manages the lifecycle of detected patterns from trigger to implementation:
 *   - Queued → In Review → Approved → In Progress → Implemented
 *   - Supports priority levels (P0/P1/P2/P3)
 *   - Tracks implementation status
 *   - Integration with ProblemAbstractionEngine
 */
class ArchitectureChangeQueue {
  constructor(options = {}) {
    this.storePath = options.storePath || null;
    this.proposals = new Map();
    this.maxQueueSize = options.maxQueueSize || 100;
    this._load();
  }

  /**
   * Add a new proposal to the queue.
   *
   * @param {ADRProposal} adr
   * @param {object} options
   * @returns {ArchitectureProposal}
   */
  add(adr, options = {}) {
    const id = `${adr.id}-${Date.now()}`;

    const proposal = {
      id,
      adrId: adr.id,
      title: adr.title,
      status: options.status || 'queued',
      priority: this._determinePriority(adr),
      patternId: adr.metadata.patternId,
      patternName: adr.metadata.patternName,
      severity: adr.metadata.severity,
      createdAt: adr.generatedAt,
      updatedAt: adr.generatedAt,
      assignedTo: options.assignedTo || null,
      notes: options.notes || '',
      implementedAt: null,
    };

    // Prevent duplicate queue entries
    const existing = this._findByPattern(adr.metadata.patternId);
    if (existing) {
      // Update existing if new occurrence count is higher
      if (adr.metadata.occurrenceCount > existing.occurrenceCount) {
        existing.updatedAt = new Date().toISOString();
        this._save();
      }
      return existing;
    }

    this.proposals.set(id, proposal);
    this._trimIfNeeded();
    this._save();

    return proposal;
  }

  /**
   * Update proposal status.
   *
   * @param {string} id
   * @param {string} status - 'queued' | 'in-review' | 'approved' | 'in-progress' | 'implemented' | 'rejected'
   * @param {object} updates
   * @returns {ArchitectureProposal|null}
   */
  updateStatus(id, status, updates = {}) {
    const proposal = this.proposals.get(id);
    if (!proposal) return null;

    proposal.status = status;
    proposal.updatedAt = new Date().toISOString();

    if (status === 'implemented') {
      proposal.implementedAt = new Date().toISOString();
    }

    Object.assign(proposal, updates);
    this._save();

    return proposal;
  }

  /**
   * Get proposal by ID.
   *
   * @param {string} id
   * @returns {ArchitectureProposal|null}
   */
  get(id) {
    return this.proposals.get(id) || null;
  }

  /**
   * Get all proposals.
   *
   * @param {object} filters
   * @returns {ArchitectureProposal[]}
   */
  getAll(filters = {}) {
    let results = Array.from(this.proposals.values());

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        results = results.filter(p => filters.status.includes(p.status));
      } else {
        results = results.filter(p => p.status === filters.status);
      }
    }

    if (filters.priority) {
      if (Array.isArray(filters.priority)) {
        results = results.filter(p => filters.priority.includes(p.priority));
      } else {
        results = results.filter(p => p.priority === filters.priority);
      }
    }

    if (filters.patternId) {
      results = results.filter(p => p.patternId === filters.patternId);
    }

    // Sort by priority, then creation date
    const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
    results.sort((a, b) => {
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return results;
  }

  /**
   * Get queue statistics.
   *
   * @returns {object}
   */
  getStats() {
    const proposals = Array.from(this.proposals.values());

    return {
      total: proposals.length,
      byStatus: {
        queued: proposals.filter(p => p.status === 'queued').length,
        inReview: proposals.filter(p => p.status === 'in-review').length,
        approved: proposals.filter(p => p.status === 'approved').length,
        inProgress: proposals.filter(p => p.status === 'in-progress').length,
        implemented: proposals.filter(p => p.status === 'implemented').length,
        rejected: proposals.filter(p => p.status === 'rejected').length,
      },
      byPriority: {
        P0: proposals.filter(p => p.priority === 'P0').length,
        P1: proposals.filter(p => p.priority === 'P1').length,
        P2: proposals.filter(p => p.priority === 'P2').length,
        P3: proposals.filter(p => p.priority === 'P3').length,
      },
    };
  }

  /**
   * Get pending (non-implemented) proposals count.
   *
   * @returns {number}
   */
  getPendingCount() {
    return Array.from(this.proposals.values()).filter(
      p => !['implemented', 'rejected'].includes(p.status)
    ).length;
  }

  /**
   * Determine priority from ADR severity.
   *
   * @private
   */
  _determinePriority(adr) {
    const severityPriority = {
      critical: 'P0',
      high: 'P1',
      medium: 'P2',
      low: 'P3',
    };
    return severityPriority[adr.metadata.severity] || 'P2';
  }

  /**
   * Find existing proposal by pattern ID.
   *
   * @private
   */
  _findByPattern(patternId) {
    for (const proposal of this.proposals.values()) {
      if (proposal.patternId === patternId && proposal.status !== 'implemented') {
        return proposal;
      }
    }
    return null;
  }

  /**
   * Trim queue if exceeds max size.
   *
   * @private
   */
  _trimIfNeeded() {
    if (this.proposals.size <= this.maxQueueSize) return;

    // Remove oldest implemented/rejected proposals
    const entries = Array.from(this.proposals.entries());
    const removable = entries.filter(([, p]) => ['implemented', 'rejected'].includes(p.status));

    removable
      .sort(([, a], [, b]) => new Date(a.updatedAt) - new Date(b.updatedAt))
      .slice(0, removable.length - this.maxQueueSize + entries.length)
      .forEach(([id]) => this.proposals.delete(id));
  }

  /**
   * Load from disk.
   *
   * @private
   */
  _load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      if (data.proposals) {
        this.proposals = new Map(Object.entries(data.proposals));
      }
    } catch (err) {
      console.warn(`[ArchitectureChangeQueue] Could not load: ${err.message}`);
    }
  }

  /**
   * Save to disk.
   *
   * @private
   */
  _save() {
    if (!this.storePath) return;

    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const data = {
        proposals: Object.fromEntries(this.proposals),
        updatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[ArchitectureChangeQueue] Could not save: ${err.message}`);
    }
  }
}

// ─── Refactoring Advisor ────────────────────────────────────────────────────

/**
 * Refactoring Advisor – Provides concrete code transformation guidance.
 *
 * Links triggered patterns to specific refactoring implementations.
 * Template-based suggestions with code examples.
 */
class RefactoringAdvisor {
  constructor() {
    this.templates = REFACTORING_TEMPLATES;
  }

  /**
   * Get refactoring guidance for a triggered pattern.
   *
   * @param {string} patternId
   * @returns {RefactoringGuide|null}
   */
  getRefactoringGuide(patternId) {
    const template = this.templates[patternId];
    if (!template) return null;

    return {
      patternId: template.patternId,
      name: template.refactoringName,
      description: template.description,
      architecturalPattern: template.architecturalPattern,
      beforeExample: template.beforeExample,
      afterExample: template.afterExample,
      implementationPlan: template.implementationPlan,
      filesToModify: template.filesToModify,
      effort: template.effort,
      benefits: template.benefits,
    };
  }

  /**
   * Check if template exists for pattern.
   *
   * @param {string} patternId
   * @returns {boolean}
   */
  hasTemplate(patternId) {
    return patternId in this.templates;
  }

  /**
   * Get all available templates.
   *
   * @returns {RefactoringGuide[]}
   */
  getAllTemplates() {
    return Object.values(this.templates).map(t => this.getRefactoringGuide(t.patternId));
  }

  /**
   * Generate implementation checklist.
   *
   * @param {string} patternId
   * @returns {string[]}
   */
  generateChecklist(patternId) {
    const guide = this.getRefactoringGuide(patternId);
    if (!guide) return [];

    const checklist = [];

    guide.implementationPlan.forEach(step => {
      checklist.push(`[ ] Step ${step.step}: ${step.title}`);
      if (step.exampleFile) {
        checklist.push(`    File: ${step.exampleFile}`);
      }
    });

    return checklist;
  }
}

// ─── Evolution Recommender Facade ───────────────────────────────────────────

/**
 * Evolution Recommender – Main facade for evolution recommendations.
 *
 * Integrates ADR generation, change queue management, and refactoring advice.
 */
class EvolutionRecommender {
  constructor(options = {}) {
    this.adrGenerator = new ADRGenerator(options.adr);
    this.changeQueue = new ArchitectureChangeQueue(options.queue);
    this.refactoringAdvisor = new RefactoringAdvisor();
    this.onProposalCreated = options.onProposalCreated || null;
  }

  /**
   * Process triggered pattern – full workflow.
   *
   * @param {TriggeredPattern} triggeredPattern
   * @param {PatternTrend} [trend]
   * @returns {EvolutionRecommendation}
   */
  processTriggeredPattern(triggeredPattern, trend = null) {
    // Generate ADR
    const adr = this.adrGenerator.generate(triggeredPattern, trend);

    // Add to change queue
    const proposal = this.changeQueue.add(adr, {
      notes: `Occurrence #: ${triggeredPattern.occurrenceCount}`,
    });

    // Get refactoring guide if available
    const refactoringGuide = this.refactoringAdvisor.getRefactoringGuide(triggeredPattern.patternId);

    // Notify callback if set
    if (this.onProposalCreated) {
      this.onProposalCreated({ adr, proposal, refactoringGuide });
    }

    return {
      adr,
      proposal,
      refactoringGuide,
      summary: {
        actionRequired: proposal.priority === 'P0' || proposal.priority === 'P1',
        estimatedEffort: refactoringGuide?.effort?.estimatedHours || 'unknown',
        hasDetailedPlan: !!refactoringGuide,
      },
    };
  }

  /**
   * Get pending architecture proposals.
   *
   * @returns {ArchitectureProposal[]}
   */
  getPendingProposals() {
    return this.changeQueue.getAll({
      status: ['queued', 'in-review', 'approved', 'in-progress'],
    });
  }

  /**
   * Get refactoring guidance for a pattern.
   *
   * @param {string} patternId
   * @returns {RefactoringGuide|null}
   */
  getRefactoringGuide(patternId) {
    return this.refactoringAdvisor.getRefactoringGuide(patternId);
  }

  /**
   * Save ADR to file.
   *
   * @param {string} adrId
   * @returns {string|null} File path
   */
  saveADRToFile(adrId) {
    const adr = this.adrGenerator.getGeneratedADRs().find(a => a.id === adrId);
    if (!adr) return null;
    return this.adrGenerator.saveToFile(adr);
  }

  /**
   * Get queue statistics.
   *
   * @returns {object}
   */
  getQueueStats() {
    return this.changeQueue.getStats();
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  // Core classes
  EvolutionRecommender,
  ADRGenerator,
  ArchitectureChangeQueue,
  RefactoringAdvisor,

  // Constants
  REFACTORING_TEMPLATES,

  // Factory
  createRecommender: (options) => new EvolutionRecommender(options),
};
