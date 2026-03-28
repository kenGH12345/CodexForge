/**
 * Core Module Functionality Contracts – Define expected behaviors for core modules
 *
 * This module defines functionality contracts for non-Agent core modules:
 *   - StateMachine: State transition management
 *   - ExperienceStore: Experience persistence and search
 *   - SelfReflectionEngine: Issue detection and recording
 *
 * @module CoreModuleFunctionalityContracts
 */

'use strict';

// ─── StateMachine Functionality Contract ──────────────────────────────────────

const STATE_MACHINE_FUNCTIONALITY = {
  module: 'StateMachine',
  version: '1.0',
  expectedBehavior: {
    description: 'Manage workflow state transitions and manifest persistence',
    input: 'State transition requests (transition, rollback, jumpTo)',
    output: 'Current state, manifest updates',
    sideEffects: ['Update output/manifest.json', 'Emit STATE_CHANGED event'],
    preconditions: ['Project ID is set', 'Manifest file path is valid'],
    postconditions: ['Manifest reflects current state', 'State is valid according to STATE_ORDER'],
  },
  validationRules: [
    { name: 'state-in-order', check: 'STATE_ORDER.includes(currentState)', errorMessage: 'Current state not in valid state order', severity: 'error' },
    { name: 'manifest-has-required-fields', check: 'manifest.projectId && manifest.state && manifest.history', errorMessage: 'Manifest missing required fields', severity: 'error' },
  ],
  testCases: [],
  metrics: {},
};

// ─── ExperienceStore Functionality Contract ────────────────────────────────────

const EXPERIENCE_STORE_FUNCTIONALITY = {
  module: 'ExperienceStore',
  version: '1.0',
  expectedBehavior: {
    description: 'Persist, search, and transfer experiences across projects',
    input: 'Experience objects to record, search queries',
    output: 'Search results, import/export data',
    sideEffects: ['Write to output/experiences.json', 'Update synonym table'],
    preconditions: ['Experiences file path is valid'],
    postconditions: ['Recorded experiences have id, title, pattern', 'Search returns relevant results'],
  },
  validationRules: [
    { name: 'experiences-have-ids', check: 'experiences.every(e => e.id && e.title)', errorMessage: 'Experiences missing id or title', severity: 'error' },
  ],
  testCases: [],
  metrics: {},
};

// ─── SelfReflectionEngine Functionality Contract ──────────────────────────────

const SELF_REFLECTION_FUNCTIONALITY = {
  module: 'SelfReflectionEngine',
  version: '1.0',
  expectedBehavior: {
    description: 'Detect issues, record reflections, and track resolution',
    input: 'Issue detection triggers, reflection records',
    output: 'Issue reports, resolution status',
    sideEffects: ['Write to output/reflections.json', 'Emit ISSUE_DETECTED event'],
    preconditions: [],
    postconditions: ['Recorded issues have type, severity, title', 'Duplicate issues are consolidated'],
  },
  validationRules: [
    { name: 'issues-have-required-fields', check: 'issues.every(i => i.type && i.severity && i.title)', errorMessage: 'Issues missing required fields', severity: 'error' },
  ],
  testCases: [],
  metrics: {},
};

// ─── Core Module Contracts Registry ───────────────────────────────────────────

const CORE_MODULE_CONTRACTS = {
  StateMachine: STATE_MACHINE_FUNCTIONALITY,
  ExperienceStore: EXPERIENCE_STORE_FUNCTIONALITY,
  SelfReflectionEngine: SELF_REFLECTION_FUNCTIONALITY,
};

module.exports = {
  STATE_MACHINE_FUNCTIONALITY,
  EXPERIENCE_STORE_FUNCTIONALITY,
  SELF_REFLECTION_FUNCTIONALITY,
  CORE_MODULE_CONTRACTS,
};
