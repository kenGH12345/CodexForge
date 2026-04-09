/**
 * Prompt Pattern Library – Reusable, cross-platform prompt patterns
 *
 * Implements structured prompt engineering patterns with platform-specific
 * adaptations. Designed for integration with PromptBuilder and PromptSlotManager.
 *
 * Patterns included:
 *   - chain-of-thought (CoT)
 *   - react (Reasoning + Acting)
 *   - tool-use
 *   - structured-output
 *   - few-shot
 *   - self-consistency
 *   - verification-loop
 *
 * Platform adapters: Claude, GPT, Gemini, Cursor, Windsurf, Generic
 */

'use strict';

const { LLM } = require('../core/constants');

// ─── Pattern Definitions ─────────────────────────────────────────────────────

/**
 * Core pattern templates with platform-agnostic structure.
 * Each pattern defines:
 *   - name: Pattern identifier
 *   - description: Human-readable purpose
 *   - template: Function that returns the pattern string
 *   - parameters: Configurable pattern parameters
 *   - platforms: Platform-specific adaptations
 */
const PATTERNS = {
  /**
   * Chain of Thought: Step-by-step reasoning before conclusion
   */
  'chain-of-thought': {
    name: 'Chain of Thought',
    description: 'Step-by-step reasoning before final answer',
    category: 'reasoning',
    parameters: {
      reasoningSteps: { type: 'number', default: 3, min: 2, max: 10 },
      showIntermediates: { type: 'boolean', default: true },
    },
    template(params) {
      const { reasoningSteps = 3, showIntermediates = true } = params;
      return {
        prefix: `## Reasoning Process

Work through this problem in ${reasoningSteps} explicit steps.
${showIntermediates ? 'Show your intermediate reasoning for each step.' : 'Reason internally, then present the conclusion.'}

Structure your response as:`,
        structure: Array.from({ length: reasoningSteps }, (_, i) =>
          `Step ${i + 1}: [Your reasoning here]`
        ).join('\n') + '\n\nConclusion: [Final answer based on the reasoning]',
        suffix: 'Remember: quality of reasoning matters more than speed.',
      };
    },
    platforms: {
      claude: {
        enhancements: ['Use <thinking> tags for intermediate steps'],
        template(params) {
          const base = this.template(params);
          base.structure = base.structure.replace(
            'Step',
            '<thinking>\nStep'
          ) + '\n</thinking>';
          return base;
        },
      },
      openai: {
        enhancements: ['Compatible with o1 reasoning models'],
      },
    },
  },

  /**
   * ReAct: Reasoning and Acting pattern
   */
  'react': {
    name: 'ReAct (Reason + Act)',
    description: 'Interleave reasoning with tool use',
    category: 'reasoning',
    parameters: {
      maxIterations: { type: 'number', default: 5, min: 1, max: 20 },
      toolsAvailable: { type: 'array', default: [] },
    },
    template(params) {
      const { maxIterations = 5, toolsAvailable = [] } = params;
      const toolList = toolsAvailable.length > 0
        ? `Available Tools: ${toolsAvailable.join(', ')}`
        : 'Use available tools as needed';

      return {
        prefix: `## ReAct Pattern

You are in a reasoning-acting loop. You may invoke tools, observe results, and continue reasoning.
Maximum iterations: ${maxIterations}
${toolList}`,
        structure: `Thought: [Your reasoning about what to do]
Action: [Tool name and parameters]
Observation: [Result from the tool]
...
(Repeat Thought-Action-Observation as needed)

Final Answer: [Your conclusion]`,
        suffix: 'Stop when you have sufficient information to answer.',
      };
    },
    platforms: {
      claude: {
        enhancements: ['Native tool use integration'],
      },
      cursor: {
        enhancements: ['IDE tool integration'],
      },
    },
  },

  /**
   * Tool Use: Structured tool invocation
   */
  'tool-use': {
    name: 'Tool Use',
    description: 'Clear tool invocation format',
    category: 'interaction',
    parameters: {
      invokeOnce: { type: 'boolean', default: false },
      validateParams: { type: 'boolean', default: true },
    },
    template(params) {
      const { invokeOnce = false, validateParams = true } = params;
      return {
        prefix: `## Tool Invocation${invokeOnce ? ' (Single Use)' : ''}

When you need to use a tool, format your request exactly as:`,
        structure: `<tool_call>
<name>tool_name</name>
<parameters>
{
  "param1": "value1",
  "param2": "value2"
}
</parameters>
</tool_call>${validateParams ? '\n\nBefore invoking, verify all required parameters are present.' : ''}`,
        suffix: 'Wait for the tool result before continuing.',
      };
    },
    platforms: {
      claude: {
        enhancements: ['Uses native XML tool format'],
      },
      openai: {
        template(params) {
          const base = this.template(params);
          base.structure = `<function_calls>
<invoke name="tool_name">
<parameter name="param1">value1</parameter>
<parameter name="param2">value2</parameter>
</invoke>
</function_calls>`;
          return base;
        },
      },
    },
  },

  /**
   * Structured Output: Enforce JSON/schema compliance
   */
  'structured-output': {
    name: 'Structured Output',
    description: 'Enforce specific output format',
    category: 'format',
    parameters: {
      format: { type: 'enum', values: ['json', 'markdown', 'xml'], default: 'json' },
      schema: { type: 'object', default: null },
      strict: { type: 'boolean', default: true },
    },
    template(params) {
      const { format = 'json', schema = null, strict = true } = params;
      const schemaHint = schema
        ? `\n\nRequired Schema:\n\`\`\`${format}\n${JSON.stringify(schema, null, 2)}\n\`\`\``
        : '';

      const strictInstruction = strict
        ? '\n\nCRITICAL: Your output MUST be valid parseable ' + format.toUpperCase() + '. No extra text before or after.'
        : '';

      return {
        prefix: `## Output Format: ${format.toUpperCase()}${strictInstruction}`,
        structure: `Provide your response in ${format.toUpperCase()} format.${schemaHint}`,
        suffix: 'Double-check syntax before outputting.',
      };
    },
    platforms: {
      openai: {
        enhancements: ['Compatible with JSON mode / Structured Outputs API'],
      },
      claude: {
        enhancements: ['Wrap in <output> tags for clarity'],
      },
    },
  },

  /**
   * Few-Shot: In-context learning with examples
   */
  'few-shot': {
    name: 'Few-Shot Learning',
    description: 'Provide examples for better performance',
    category: 'learning',
    parameters: {
      examples: { type: 'array', default: [] },
      exampleCount: { type: 'number', default: 3, min: 1, max: 10 },
    },
    template(params) {
      const { examples = [], exampleCount = 3 } = params;
      const selectedExamples = examples.slice(0, exampleCount);

      const exampleBlock = selectedExamples.length > 0
        ? '\n\n### Examples\n\n' + selectedExamples.map((ex, i) =>
            `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}`
          ).join('\n\n')
        : '';

      return {
        prefix: `## Few-Shot Learning${exampleBlock}`,
        structure: 'Now apply the same pattern to the new input below.',
        suffix: 'Follow the demonstrated pattern closely.',
      };
    },
    platforms: {
      generic: {
        enhancements: ['Works across all platforms'],
      },
    },
  },

  /**
   * Self-Consistency: Generate multiple answers, select best
   */
  'self-consistency': {
    name: 'Self-Consistency',
    description: 'Generate multiple solutions and select best',
    category: 'reasoning',
    parameters: {
      samples: { type: 'number', default: 3, min: 2, max: 5 },
      selectionCriteria: { type: 'string', default: 'accuracy and completeness' },
    },
    template(params) {
      const { samples = 3, selectionCriteria = 'accuracy and completeness' } = params;
      return {
        prefix: `## Self-Consistency Pattern

Generate ${samples} different approaches to this problem.`,
        structure: Array.from({ length: samples }, (_, i) =>
          `Approach ${i + 1}:\n[Your solution here]`
        ).join('\n\n---\n\n') + `\n\n### Selection\nBased on ${selectionCriteria}, the best approach is: [Your choice]`,
        suffix: 'Diversity in approaches leads to better solutions.',
      };
    },
    platforms: {
      generic: {
        note: 'May require multiple LLM calls in practice',
      },
    },
  },

  /**
   * Verification Loop: Check and correct own work
   */
  'verification-loop': {
    name: 'Verification Loop',
    description: 'Self-check for errors before finalizing',
    category: 'quality',
    parameters: {
      checks: { type: 'array', default: ['syntax', 'logic', 'completeness'] },
    },
    template(params) {
      const { checks = ['syntax', 'logic', 'completeness'] } = params;
      return {
        prefix: `## Verification Loop

Before finalizing your answer, verify:`,
        structure: checks.map(check =>
          `- [ ] **${check.charAt(0).toUpperCase() + check.slice(1)}**: [Your verification]`
        ).join('\n') + '\n\n### Corrections\n[Fix any issues found]\n\n### Final Answer\n[Your verified and corrected output]',
        suffix: 'Double-checking prevents simple mistakes.',
      };
    },
    platforms: {
      generic: {
        enhancements: ['Universal quality improvement'],
      },
    },
  },

  /**
   * Session Checkpoint: Long-running agent orientation
   */
  'session-checkpoint': {
    name: 'Session Checkpoint',
    description: 'Re-orient agent at session start',
    category: 'workflow',
    parameters: {
      steps: { type: 'array', default: [] },
    },
    template(params) {
      const defaultSteps = [
        'Confirm working directory location',
        'Review progress/manifest files',
        'Check recent git history',
        'Verify environment health',
        'Select ONE task to work on',
      ];
      const steps = params.steps?.length > 0 ? params.steps : defaultSteps;

      return {
        prefix: '## Session Start Checklist (MANDATORY)',
        structure: steps.map((step, i) =>
          `Step ${i + 1} – ${step}`
        ).join('\n') + '\n\n⚠️ Work on ONE task at a time. Do not start a second task until the first is complete.',
        suffix: '',
      };
    },
    platforms: {
      generic: {
        note: 'Essential for long-running agent workflows',
      },
    },
  },
};

// ─── Platform Adapters ───────────────────────────────────────────────────────

/**
 * Platform-specific adaptations and optimizations.
 */
const PLATFORM_ADAPTERS = {
  claude: {
    name: 'Anthropic Claude',
    features: ['tool_use', 'extended_thinking', 'long_context'],
    preferences: {
      format: 'xml',
      thinkingTags: true,
      toolFormat: 'native_xml',
    },
    adaptations: {
      'chain-of-thought': (pattern) => {
        pattern.structure = pattern.structure.replace(
          /Step \d+: /g,
          '<thinking>\n$&'
        );
        pattern.suffix += '\n\nWrap detailed reasoning in <thinking> tags.';
        return pattern;
      },
    },
  },

  openai: {
    name: 'OpenAI GPT',
    features: ['json_mode', 'function_calling', 'structured_outputs'],
    preferences: {
      format: 'json',
      thinkingTags: false,
      toolFormat: 'openai_functions',
    },
    adaptations: {
      'structured-output': (pattern, params) => {
        if (params.strict) {
          pattern.suffix += '\n\nEnable JSON mode for guaranteed valid output.';
        }
        return pattern;
      },
    },
  },

  gemini: {
    name: 'Google Gemini',
    features: ['long_context', 'multimodal'],
    preferences: {
      format: 'markdown',
      thinkingTags: false,
      toolFormat: 'function_declaration',
    },
  },

  cursor: {
    name: 'Cursor IDE',
    features: ['ide_integration', 'code_awareness'],
    preferences: {
      format: 'markdown',
      useIDETools: true,
    },
    adaptations: {
      'tool-use': (pattern) => {
        pattern.prefix += '\n\nPrefer IDE-native tools (codebase_search, grep_search, view_code_item) when available.';
        return pattern;
      },
    },
  },

  windsurf: {
    name: 'Windsurf IDE',
    features: ['ide_integration', 'agent_mode'],
    preferences: {
      format: 'markdown',
      useIDETools: true,
    },
  },

  generic: {
    name: 'Generic/Universal',
    features: [],
    preferences: {
      format: 'markdown',
      compatibility: 'maximum',
    },
  },
};

// ─── Pattern Library Class ───────────────────────────────────────────────────

class PromptPatternLibrary {
  constructor(opts = {}) {
    this._patterns = new Map(Object.entries(PATTERNS));
    this._adapters = new Map(Object.entries(PLATFORM_ADAPTERS));
    this._defaultPlatform = opts.defaultPlatform || 'generic';
    this._defaultParams = opts.defaultParams || {};
    this._performanceMetrics = new Map();
  }

  /**
   * Get a pattern with platform-specific adaptations.
   *
   * @param {string} patternName - Pattern identifier
   * @param {object} [params] - Pattern parameters
   * @param {string} [platform] - Target platform
   * @returns {PatternResult|null}
   */
  getPattern(patternName, params = {}, platform = null) {
    const pattern = this._patterns.get(patternName);
    if (!pattern) {
      console.warn(`[PatternLibrary] Unknown pattern: "${patternName}"`);
      return null;
    }

    // Merge default + provided params
    const mergedParams = { ...this._getDefaultParams(patternName), ...params };
    const targetPlatform = platform || this._defaultPlatform;

    // Generate base pattern
    let result = pattern.template(mergedParams);

    // Apply platform adaptations
    const adapter = this._adapters.get(targetPlatform);
    if (adapter && adapter.adaptations && adapter.adaptations[patternName]) {
      result = adapter.adaptations[patternName](result, mergedParams);
    }

    // Apply pattern metadata
    result._meta = {
      patternName,
      platform: targetPlatform,
      category: pattern.category,
      timestamp: new Date().toISOString(),
    };

    return result;
  }

  /**
   * Build a complete prompt by composing multiple patterns.
   *
   * @param {string[]} patternNames - Patterns to compose
   * @param {object} [sharedParams] - Parameters shared across patterns
   * @param {string} [platform] - Target platform
   * @returns {string} Composed prompt
   */
  compose(patternNames, sharedParams = {}, platform = null) {
    const parts = [];
    const targetPlatform = platform || this._defaultPlatform;

    for (const name of patternNames) {
      const pattern = this.getPattern(name, sharedParams[name] || sharedParams, targetPlatform);
      if (pattern) {
        parts.push(this._renderPattern(pattern));
      }
    }

    return parts.join('\n\n---\n\n');
  }

  /**
   * Get pattern statistics for A/B testing integration.
   *
   * @param {string} patternName - Pattern to query
   * @returns {PatternMetrics|null}
   */
  getMetrics(patternName) {
    return this._performanceMetrics.get(patternName) || null;
  }

  /**
   * Record a pattern usage outcome for analytics.
   *
   * @param {string} patternName
   * @param {object} outcome
   */
  recordOutcome(patternName, outcome) {
    if (!this._performanceMetrics.has(patternName)) {
      this._performanceMetrics.set(patternName, {
        uses: 0,
        successes: 0,
        failures: 0,
        avgLatency: 0,
      });
    }

    const metrics = this._performanceMetrics.get(patternName);
    metrics.uses++;
    if (outcome.success) {
      metrics.successes++;
    } else {
      metrics.failures++;
    }
    if (outcome.latency) {
      metrics.avgLatency = (metrics.avgLatency * (metrics.uses - 1) + outcome.latency) / metrics.uses;
    }
  }

  /**
   * List available patterns by category.
   *
   * @returns {object} Patterns grouped by category
   */
  listPatterns() {
    const byCategory = {};
    for (const [name, pattern] of this._patterns) {
      if (!byCategory[pattern.category]) {
        byCategory[pattern.category] = [];
      }
      byCategory[pattern.category].push({
        name,
        description: pattern.description,
        parameters: pattern.parameters,
      });
    }
    return byCategory;
  }

  /**
   * List supported platforms.
   *
   * @returns {Array<PlatformInfo>}
   */
  listPlatforms() {
    return Array.from(this._adapters.entries()).map(([id, info]) => ({
      id,
      name: info.name,
      features: info.features,
    }));
  }

  /**
   * Auto-select patterns based on task characteristics.
   *
   * @param {string} taskDescription
   * @param {object} [context]
   * @returns {string[]} Recommended pattern names
   */
  recommendPatterns(taskDescription, context = {}) {
    const recommendations = [];
    const task = taskDescription.toLowerCase();

    // Reasoning tasks
    if (task.includes('analyze') || task.includes('reason') || task.includes('think')) {
      recommendations.push('chain-of-thought');
    }

    // Tool use tasks
    if (task.includes('search') || task.includes('find') || task.includes('use tool')) {
      recommendations.push('tool-use');
      if (context.hasTools) {
        recommendations.push('react');
      }
    }

    // Code/structured tasks
    if (task.includes('code') || task.includes('implement') || task.includes('output')) {
      recommendations.push('structured-output');
      recommendations.push('verification-loop');
    }

    // Complex multi-step tasks
    if (task.includes('multiple') || task.includes('complex') || task.includes('design')) {
      recommendations.push('self-consistency');
    }

    // Learning tasks
    if (context.examples && context.examples.length > 0) {
      recommendations.push('few-shot');
    }

    // Session start
    if (task.includes('session') || task.includes('start') || task.includes('begin')) {
      recommendations.push('session-checkpoint');
    }

    return [...new Set(recommendations)]; // Deduplicate
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  _getDefaultParams(patternName) {
    const pattern = this._patterns.get(patternName);
    if (!pattern) return {};

    const defaults = {};
    for (const [key, config] of Object.entries(pattern.parameters || {})) {
      defaults[key] = config.default;
    }
    return { ...defaults, ...this._defaultParams };
  }

  _renderPattern(pattern) {
    const parts = [];
    if (pattern.prefix) parts.push(pattern.prefix);
    if (pattern.structure) parts.push(pattern.structure);
    if (pattern.suffix) parts.push(pattern.suffix);
    return parts.join('\n\n');
  }
}

// ─── Integration Helpers ─────────────────────────────────────────────────────

/**
 * Creates a PromptPatternLibrary pre-configured for WorkFlowAgent.
 *
 * @param {object} [opts]
 * @returns {PromptPatternLibrary}
 */
function createWorkflowPatternLibrary(opts = {}) {
  const platform = opts.platform || detectPlatform();

  return new PromptPatternLibrary({
    defaultPlatform: platform,
    defaultParams: {
      reasoningSteps: 3,
      maxIterations: 5,
      format: 'json',
      ...opts.defaultParams,
    },
  });
}

/**
 * Detect the current execution platform.
 *
 * @returns {string} Platform identifier
 */
function detectPlatform() {
  // Check for IDE detection
  try {
    const { getIDEDetectionResult } = require('./ide-detection');
    const ide = getIDEDetectionResult();
    if (ide.ideName?.toLowerCase().includes('cursor')) return 'cursor';
    if (ide.ideName?.toLowerCase().includes('windsurf')) return 'windsurf';
  } catch (_) { /* ignore */ }

  // Environment-based detection
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GOOGLE_API_KEY) return 'gemini';

  return 'generic';
}

// ─── Integration with PromptBuilder ──────────────────────────────────────────

/**
 * Generates an enhanced agent prompt using pattern library.
 * Intended to be called from PromptBuilder.buildAgentPrompt().
 *
 * @param {string} role - Agent role
 * @param {string} dynamicInput - Task input
 * @param {object} [options]
 * @returns {string} Enhanced prompt with patterns
 */
function enhancePromptWithPatterns(role, dynamicInput, options = {}) {
  const library = createWorkflowPatternLibrary(options);

  // Recommend patterns based on role and task
  const recommended = library.recommendPatterns(dynamicInput, {
    hasTools: true,
    ...options.context,
  });

  // Always include session-checkpoint for coding-agent
  if (role === 'coding-agent' && !recommended.includes('session-checkpoint')) {
    recommended.unshift('session-checkpoint');
  }

  // Compose patterns
  return library.compose(recommended, options.patternParams || {});
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  PromptPatternLibrary,
  PATTERNS,
  PLATFORM_ADAPTERS,
  createWorkflowPatternLibrary,
  detectPlatform,
  enhancePromptWithPatterns,
};