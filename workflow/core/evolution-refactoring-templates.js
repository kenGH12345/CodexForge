/**
 * Evolution Refactoring Templates – Code transformation templates for detected patterns
 *
 * Extracted from evolution-recommender.js (ADR-33 Phase 4) to isolate the
 * large template data structures from the core recommendation logic.
 *
 * Each template provides:
 *   - description: What the refactoring does
 *   - beforeExample: Current problematic code pattern
 *   - afterExample: Refactored solution
 *   - implementationPlan: Step-by-step transformation instructions
 *   - filesToModify: List of files likely to need changes
 *   - effort: Estimated effort in hours
 *
 * @module evolution-refactoring-templates
 */

'use strict';

// ─── Code Refactoring Templates ─────────────────────────────────────────────

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

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  REFACTORING_TEMPLATES,
};
