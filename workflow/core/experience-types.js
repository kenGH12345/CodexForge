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
]);

const FRAMEWORK_CATEGORIES = new Set([
  ExperienceCategory.FRAMEWORK_LIMIT,
  ExperienceCategory.FRAMEWORK_MODULE,
  ExperienceCategory.ENGINE_API,
  ExperienceCategory.MODULE_USAGE,
]);

module.exports = {
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  GENERIC_CATEGORIES,
  FRAMEWORK_CATEGORIES,
};
