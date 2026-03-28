/**
 * Experience Types & Categories – Shared constants for the experience system
 *
 * Extracted to avoid circular dependencies between experience-store.js,
 * experience-query.js, experience-evolution.js, and experience-transfer.js.
 */

'use strict';

// ─── Experience Types ─────────────────────────────────────────────────────────

const ExperienceType = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
};

// ─── Experience Categories ────────────────────────────────────────────────────

const ExperienceCategory = {
  // ── Original categories ──
  MODULE_USAGE:      'module_usage',
  FRAMEWORK_LIMIT:   'framework_limit',
  STABLE_PATTERN:    'stable_pattern',
  PITFALL:           'pitfall',
  PERFORMANCE:       'performance',
  DEBUG_TECHNIQUE:   'debug_technique',
  ARCHITECTURE:      'architecture',
  ENGINE_API:        'engine_api',
  // ── Extended categories for code scanning ──
  UTILITY_CLASS:     'utility_class',
  INTERFACE_DEF:     'interface_def',
  COMPONENT:         'component',
  WORKFLOW_PROCESS:  'workflow_process',
  FRAMEWORK_MODULE:  'framework_module',
  DATA_STRUCTURE:    'data_structure',
  PROCEDURE:         'procedure',
  NETWORK_PROTOCOL:  'network_protocol',
  CONFIG_SYSTEM:     'config_system',
  OBJECT_POOL:       'object_pool',
  EVENT_SYSTEM:      'event_system',
  RESOURCE_LOAD:     'resource_load',
  UI_PATTERN:        'ui_pattern',
  SOUND_SYSTEM:      'sound_system',
  ENTITY_SYSTEM:     'entity_system',
  LUA_PATTERN:       'lua_pattern',
  CSHARP_PATTERN:    'csharp_pattern',
  // ── P1 Code Snippets: category for reusable code patterns ──
  CODE_SNIPPET:      'code_snippet',
  // ── P3 Problem Abstraction: category for detected fix patterns ──
  PROBLEM_PATTERN:   'problem_pattern',
};

// ─── Universal (Project-Agnostic) Categories ──────────────────────────────────

const UNIVERSAL_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
  ExperienceCategory.INTERFACE_DEF,
  ExperienceCategory.DATA_STRUCTURE,
]);

// ─── Category Specificity Classification (for adaptive evolution threshold) ──

const GENERIC_CATEGORIES = new Set([
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.ARCHITECTURE,
  ExperienceCategory.PITFALL,
  ExperienceCategory.WORKFLOW_PROCESS,
  ExperienceCategory.CODE_SNIPPET,
]);

const FRAMEWORK_CATEGORIES = new Set([
  ExperienceCategory.FRAMEWORK_LIMIT,
  ExperienceCategory.FRAMEWORK_MODULE,
  ExperienceCategory.ENGINE_API,
  ExperienceCategory.MODULE_USAGE,
]);

// ─── Knowledge Layers (ADR-43) ─────────────────────────────────────────────

/**
 * Knowledge Layer Classification
 *
 * Inspired by the insight that knowledge has different ownership and maintenance patterns:
 * - PLATFORM: Component/platform knowledge (maintained by platform teams, not local experiences)
 * - DOMAIN: Business domain knowledge (maintained by domain experts, may be project-specific)
 * - PRACTICE: Practical experience knowledge (captured from real sessions, most valuable)
 *
 * This stratification prevents the experience store from being flooded with:
 * - Framework documentation (belongs in PLATFORM layer)
 * - API references (belongs in PLATFORM layer)
 * - Business rules (belongs in DOMAIN layer)
 *
 * And focuses on capturing:
 * - Pitfalls encountered (PRACTICE layer)
 * - Debug techniques discovered (PRACTICE layer)
 * - Workarounds found (PRACTICE layer)
 */
const KnowledgeLayer = {
  /** Component/platform knowledge: frameworks, libraries, APIs, tools */
  PLATFORM: 'platform',
  /** Business domain knowledge: rules, workflows, project-specific patterns */
  DOMAIN: 'domain',
  /** Practical experience: pitfalls, debug techniques, workarounds */
  PRACTICE: 'practice',
};

/**
 * Category → Layer mapping
 * Used to automatically classify experiences into layers.
 */
const CATEGORY_TO_LAYER = {
  // PLATFORM layer: framework/engine specific
  [ExperienceCategory.FRAMEWORK_LIMIT]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.FRAMEWORK_MODULE]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.ENGINE_API]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.MODULE_USAGE]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.UTILITY_CLASS]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.INTERFACE_DEF]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.COMPONENT]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.NETWORK_PROTOCOL]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.EVENT_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.RESOURCE_LOAD]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.UI_PATTERN]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.SOUND_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.ENTITY_SYSTEM]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.LUA_PATTERN]: KnowledgeLayer.PLATFORM,
  [ExperienceCategory.CSHARP_PATTERN]: KnowledgeLayer.PLATFORM,

  // DOMAIN layer: project/business specific
  [ExperienceCategory.WORKFLOW_PROCESS]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.CONFIG_SYSTEM]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.OBJECT_POOL]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.DATA_STRUCTURE]: KnowledgeLayer.DOMAIN,
  [ExperienceCategory.ARCHITECTURE]: KnowledgeLayer.DOMAIN,

  // PRACTICE layer: actionable experience
  [ExperienceCategory.PITFALL]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.DEBUG_TECHNIQUE]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.STABLE_PATTERN]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.PERFORMANCE]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.CODE_SNIPPET]: KnowledgeLayer.PRACTICE,
  [ExperienceCategory.PROCEDURE]: KnowledgeLayer.PRACTICE,
};

/**
 * Get the knowledge layer for a given category.
 * @param {string} category - ExperienceCategory value
 * @returns {string} KnowledgeLayer value
 */
function getLayerForCategory(category) {
  return CATEGORY_TO_LAYER[category] || KnowledgeLayer.PRACTICE;
}

/**
 * Categories that are preferred for experience capture.
 * Experiences in these categories are more likely to be actionable.
 */
const PREFERRED_CAPTURE_CATEGORIES = new Set([
  ExperienceCategory.PITFALL,
  ExperienceCategory.DEBUG_TECHNIQUE,
  ExperienceCategory.STABLE_PATTERN,
  ExperienceCategory.PERFORMANCE,
]);

// ─── Experience Source Type ───────────────────────────────────────────────

/**
 * Experience Source Type Classification
 *
 * Distinguishes where an experience originated:
 * - ARTICLE: Imported from authoritative sources (documentation, blog posts, tutorials)
 *   → Higher trust weight in conflict resolution
 * - CONVERSATION: Captured from AI-user dialogue sessions
 *   → Context-specific, may have caveats
 * - DISTILLED: Merged from multiple similar experiences
 *   → Synthesized knowledge, lower trust weight
 *
 * This classification enables:
 * 1. Source-aware conflict resolution: ARTICLE > CONVERSATION > DISTILLED
 * 2. User-facing source labels: [文章], [对话], [蒸馏]
 * 3. Trust score computation for ranking
 */
const SourceType = {
  /** Imported from articles, documentation, or authoritative sources */
  ARTICLE: 'article',
  /** Captured from AI-user conversation sessions */
  CONVERSATION: 'conversation',
  /** Synthesized from multiple similar experiences via distillation */
  DISTILLED: 'distilled',
};

/**
 * Default source type for new experiences.
 * Most experiences captured during workflow execution are from conversations.
 */
const DEFAULT_SOURCE_TYPE = SourceType.CONVERSATION;

/**
 * Source type trust weights for conflict resolution.
 * Higher weight = more authoritative = wins in conflicts.
 */
const SOURCE_TYPE_WEIGHTS = {
  [SourceType.ARTICLE]: 3.0,
  [SourceType.CONVERSATION]: 2.0,
  [SourceType.DISTILLED]: 1.0,
};

/**
 * Get the trust weight for a source type.
 * @param {string} sourceType - SourceType value
 * @returns {number} Trust weight (higher = more authoritative)
 */
function getSourceTypeWeight(sourceType) {
  return SOURCE_TYPE_WEIGHTS[sourceType] || SOURCE_TYPE_WEIGHTS[SourceType.CONVERSATION];
}

/**
 * Get a human-readable label for a source type.
 * @param {string} sourceType - SourceType value
 * @returns {string} Label for display
 */
function getSourceTypeLabel(sourceType) {
  const labels = {
    [SourceType.ARTICLE]: '文章',
    [SourceType.CONVERSATION]: '对话',
    [SourceType.DISTILLED]: '蒸馏',
  };
  return labels[sourceType] || '未知';
}

// ─── Experience Scope (ADR-43 Extension) ───────────────────────────────────

/**
 * Experience Scope Classification
 *
 * Critical insight: Experiences have different ownership and should be stored separately:
 * - WORKFLOW: WorkFlowAgent framework experiences (how to use /wf, best practices, pitfalls)
 *   → Stored in ~/.codexforge/workflow-experiences.json (global, shared across all projects)
 * - PROJECT: Project-specific experiences (business rules, tech choices, team conventions)
 *   → Stored in <project>/.workflow/experiences.json (can be version-controlled, shared with team)
 *
 * This separation prevents:
 * 1. Framework upgrades from polluting project experiences
 * 2. Project switches from overwriting workflow knowledge
 * 3. Team members from losing shared project knowledge
 *
 * Storage locations:
 *   WORKFLOW scope: ~/.codexforge/workflow-experiences.json
 *   PROJECT scope:  <project-root>/.workflow/experiences.json
 */
const ExperienceScope = {
  /** WorkFlowAgent framework experiences: global, shared across all projects */
  WORKFLOW: 'workflow',
  /** Project-specific experiences: version-controlled, shared with team */
  PROJECT: 'project',
};

/**
 * Default scope for new experiences.
 * Most experiences captured during workflow execution are PROJECT scope.
 */
const DEFAULT_SCOPE = ExperienceScope.PROJECT;

/**
 * Categories that typically belong to WORKFLOW scope.
 * These are framework-level patterns that apply to any project using WorkFlowAgent.
 */
const WORKFLOW_SCOPE_CATEGORIES = new Set([
  ExperienceCategory.WORKFLOW_PROCESS,
  // Note: Most other categories are context-dependent and default to PROJECT scope
]);

/**
 * Determine the appropriate scope for a given experience.
 * @param {object} exp - Experience object with category, content, etc.
 * @returns {string} ExperienceScope value
 */
function determineScope(exp) {
  // Explicit scope takes precedence
  if (exp.scope) {
    return exp.scope;
  }

  // WORKFLOW_PROCESS category → WORKFLOW scope
  if (WORKFLOW_SCOPE_CATEGORIES.has(exp.category)) {
    return ExperienceScope.WORKFLOW;
  }

  // Check content for workflow-related keywords
  const content = (exp.title + ' ' + exp.content).toLowerCase();
  const workflowKeywords = [
    '/wf', 'workflow', 'work flow', 'work-flow',
    'orchestrator', 'mape', 'agent flow',
    'skill file', 'skill directory', 'skills/',
    'experience store', 'complaint wall',
    'adr-', 'decision log',
  ];

  for (const keyword of workflowKeywords) {
    if (content.includes(keyword)) {
      return ExperienceScope.WORKFLOW;
    }
  }

  // Default to PROJECT scope
  return DEFAULT_SCOPE;
}

module.exports = {
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  GENERIC_CATEGORIES,
  FRAMEWORK_CATEGORIES,
  // ADR-43: Knowledge Layer
  KnowledgeLayer,
  CATEGORY_TO_LAYER,
  getLayerForCategory,
  PREFERRED_CAPTURE_CATEGORIES,
  // Experience Source Type
  SourceType,
  DEFAULT_SOURCE_TYPE,
  SOURCE_TYPE_WEIGHTS,
  getSourceTypeWeight,
  getSourceTypeLabel,
  // ADR-43 Extension: Experience Scope
  ExperienceScope,
  DEFAULT_SCOPE,
  WORKFLOW_SCOPE_CATEGORIES,
  determineScope,
};
