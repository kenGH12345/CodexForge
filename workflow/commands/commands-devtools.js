/**
 * DevTools Commands – Development, CI, analysis, and evolution tools.
 *
 * Refactored (ADR-33 Phase 3): Split into domain-specific sub-modules:
 *   - commands-devtools-infra.js      – /gc, /metrics, /ci, /report
 *   - commands-devtools-analysis.js   – /graph, /trends, /article-scout, /techradar
 *   - commands-devtools-skills.js     – /skill-enrich, /skill-enrich-all
 *   - commands-devtools-evolution.js  – /deep-audit, /evolve
 *
 * This file is a thin delegation layer that preserves the original API.
 *
 * @module workflow/commands/commands-devtools
 */

'use strict';

const { registerInfraCommands }     = require('./commands-devtools-infra');
const { registerAnalysisCommands }  = require('./commands-devtools-analysis');
const { registerSkillsCommands }    = require('./commands-devtools-skills');
const { registerEvolutionCommands } = require('./commands-devtools-evolution');

/**
 * Registers all devtools commands into the shared command registry.
 *
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerDevToolsCommands(registerCommand) {
  registerInfraCommands(registerCommand);
  registerAnalysisCommands(registerCommand);
  registerSkillsCommands(registerCommand);
  registerEvolutionCommands(registerCommand);
}

module.exports = { registerDevToolsCommands };