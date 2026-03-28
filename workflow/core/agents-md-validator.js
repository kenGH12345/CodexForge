/**
 * AGENTS.md Validator – Synchronization verification for project knowledge.
 *
 * P2 Enhancement: Automated validation that AGENTS.md stays synchronized
 * with the actual codebase. Detects drift between documented and actual:
 *   - Agent roles and their implementations
 *   - Knowledge base document references
 *   - Architecture constraints
 *   - Directory structure
 *
 * Design: Zero-LLM, pure file-system analysis.
 * Usage: Run via `/agents-validate` command or auto-check on `/wf init`.
 *
 * @module agents-md-validator
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Validation result structure.
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Overall validation passed
 * @property {string[]} errors - Critical issues requiring action
 * @property {string[]} warnings - Non-critical inconsistencies
 * @property {Object[]} details - Detailed check results per category
 */

/**
 * Validates AGENTS.md consistency with the actual codebase.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Project root directory
 * @param {string} [options.agentsMdPath] - Path to AGENTS.md (default: `${projectRoot}/AGENTS.md`)
 * @returns {ValidationResult}
 */
function validateAgentsMd(options = {}) {
  const { projectRoot, agentsMdPath = path.join(projectRoot, 'AGENTS.md') } = options;

  const errors = [];
  const warnings = [];
  const details = [];

  // Check 1: AGENTS.md exists
  if (!fs.existsSync(agentsMdPath)) {
    errors.push(`AGENTS.md not found at ${agentsMdPath}`);
    return { valid: false, errors, warnings, details };
  }

  const agentsMdContent = fs.readFileSync(agentsMdPath, 'utf-8');

  // Check 2: Validate agent roles against actual agents/ directory
  const roleCheck = _validateAgentRoles(projectRoot, agentsMdContent);
  details.push({ check: 'agent_roles', ...roleCheck });
  errors.push(...roleCheck.errors);
  warnings.push(...roleCheck.warnings);

  // Check 3: Validate knowledge base document references
  const kbCheck = _validateKnowledgeBase(projectRoot, agentsMdContent);
  details.push({ check: 'knowledge_base', ...kbCheck });
  errors.push(...kbCheck.errors);
  warnings.push(...kbCheck.warnings);

  // Check 4: Validate directory structure references
  const dirCheck = _validateDirectoryStructure(projectRoot, agentsMdContent);
  details.push({ check: 'directory_structure', ...dirCheck });
  errors.push(...dirCheck.errors);
  warnings.push(...dirCheck.warnings);

  // Check 5: Validate architecture.md linkage
  const archCheck = _validateArchitectureLinkage(projectRoot, agentsMdContent);
  details.push({ check: 'architecture_linkage', ...archCheck });
  errors.push(...archCheck.errors);
  warnings.push(...archCheck.warnings);

  // Check 6: Validate AGENTS.md freshness
  const freshnessCheck = _validateFreshness(agentsMdPath, agentsMdContent);
  details.push({ check: 'freshness', ...freshnessCheck });
  warnings.push(...freshnessCheck.warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    details,
  };
}

/**
 * Validates that documented agent roles match actual implementations.
 */
function _validateAgentRoles(projectRoot, content) {
  const errors = [];
  const warnings = [];

  const agentsDir = path.join(projectRoot, 'workflow', 'agents');

  // If workflow/agents doesn't exist (maybe project uses own structure), skip
  if (!fs.existsSync(agentsDir)) {
    return { valid: true, errors, warnings, info: 'No centralized agents directory found' };
  }

  // Parse documented roles from AGENTS.md
  const documentedRoles = [];
  const agentRolePattern = /\*\*(AnalystAgent|ArchitectAgent|DeveloperAgent|TesterAgent|PlannerAgent)\*\*/gi;
  let match;
  while ((match = agentRolePattern.exec(content)) !== null) {
    documentedRoles.push(match[1].toLowerCase().replace('agent', ''));
  }

  // Get actual agent files
  const actualAgents = fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('-agent.js'))
    .map(f => f.replace('-agent.js', ''));

  // Compare
  const missingDocs = actualAgents.filter(a => !documentedRoles.includes(a));
  const missingImpl = documentedRoles.filter(r => !actualAgents.includes(r));

  if (missingDocs.length > 0) {
    warnings.push(`Agents not documented in AGENTS.md: ${missingDocs.join(', ')}`);
  }

  if (missingImpl.length > 0) {
    warnings.push(`Documented agents not found: ${missingImpl.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    documented: documentedRoles,
    actual: actualAgents,
  };
}

/**
 * Validates knowledge base document references exist.
 */
function _validateKnowledgeBase(projectRoot, content) {
  const errors = [];
  const warnings = [];

  // Extract markdown file references like `docs/architecture.md` or `skills/*.md`
  const docPattern = /`([^`]+\.(md|mdc))`/g;
  const matches = [];
  let match;

  while ((match = docPattern.exec(content)) !== null) {
    matches.push(match[1]);
  }

  const checked = [];
  for (const docPath of matches) {
    // Resolve relative to project root
    const fullPath = path.join(projectRoot, docPath);
    const exists = fs.existsSync(fullPath);

    checked.push({ path: docPath, exists, fullPath });

    if (!exists) {
      errors.push(`Referenced document not found: ${docPath}`);
    }
  }

  // Special check: docs/architecture.md is highly recommended
  const archPath = path.join(projectRoot, 'docs', 'architecture.md');
  if (!content.includes('architecture.md')) {
    warnings.push('AGENTS.md should reference docs/architecture.md for architecture decisions');
  } else if (!fs.existsSync(archPath)) {
    errors.push('docs/architecture.md is referenced but does not exist');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    checked,
  };
}

/**
 * Validates directory structure documentation.
 */
function _validateDirectoryStructure(projectRoot, content) {
  const errors = [];
  const warnings = [];

  // Check if Directory Structure section exists
  if (!content.includes('## Directory Structure') && !content.includes('Directory Structure')) {
    warnings.push('AGENTS.md missing "Directory Structure" section');
    return { valid: true, errors, warnings };
  }

  // Check for placeholder - indicates initialization needed
  if (content.includes('{PASTE_YOUR_DIRECTORY_TREE_HERE}')) {
    warnings.push('Directory Structure section contains placeholder - needs actual tree');
  }

  // Extract tree entries and validate key directories exist
  const treePattern = /```[\s\S]*?```/g;
  const treeMatch = treePattern.exec(content);

  if (treeMatch) {
    const treeContent = treeMatch[0];
    const dirPattern = /[├└]──\s+(\w+)/g;
    const dirs = [];
    let dmatch;

    while ((dmatch = dirPattern.exec(treeContent)) !== null) {
      dirs.push(dmatch[1]);
    }

    // Check if at least some key directories exist
    const keyDirsChecked = dirs.slice(0, 5).map(dir => {
      const exists = fs.existsSync(path.join(projectRoot, dir));
      return { dir, exists };
    });

    const missingDirs = keyDirsChecked.filter(d => !d.exists);
    if (missingDirs.length > 0 && missingDirs.length === keyDirsChecked.length) {
      warnings.push('Directory structure may be outdated - documented directories not found');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validates linkage to architecture.md.
 */
function _validateArchitectureLinkage(projectRoot, content) {
  const errors = [];
  const warnings = [];

  const archPath = path.join(projectRoot, 'docs', 'architecture.md');

  if (!fs.existsSync(archPath)) {
    warnings.push('docs/architecture.md not found - project lacks architecture documentation');
    return { valid: true, errors, warnings };
  }

  const archContent = fs.readFileSync(archPath, 'utf-8');

  // Check if AGENTS.md mentions architecture constraints that are documented
  if (content.includes('Architecture Constraints') && !archContent.includes('Constraint')) {
    warnings.push('AGENTS.md mentions constraints but architecture.md has no constraint section');
  }

  // Check for ADR reference consistency
  const archAdrPattern = /ADR-\d+/gi;
  const agentsAdrPattern = /ADR-\d+/gi;

  const archAdrs = [...archContent.matchAll(archAdrPattern)].map(m => m[0]);
  const agentsAdrs = [...content.matchAll(agentsAdrPattern)].map(m => m[0]);

  const missingInAgents = archAdrs.filter(adr => !agentsAdrs.includes(adr));
  if (missingInAgents.length > 0) {
    // This is just a warning - AGENTS.md doesn't need to list all ADRs
    warnings.push(`architecture.md references ${missingInAgents.length} ADRs not mentioned in AGENTS.md`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    archAdrs: [...new Set(archAdrs)],
    agentsAdrs: [...new Set(agentsAdrs)],
  };
}

/**
 * Validates AGENTS.md freshness based on file modification time.
 */
function _validateFreshness(agentsMdPath, content) {
  const warnings = [];

  const stats = fs.statSync(agentsMdPath);
  const mtime = new Date(stats.mtime);
  const daysSinceUpdate = Math.floor((Date.now() - mtime.getTime()) / (1000 * 60 * 60 * 24));

  // Check last updated date in header vs file mtime
  const dateMatch = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/i);
  if (dateMatch) {
    const docDate = new Date(dateMatch[1]);
    const daysInDoc = Math.floor((Date.now() - docDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysInDoc > 30) {
      warnings.push(`AGENTS.md header date is ${daysInDoc} days old - may need refresh`);
    }
  } else {
    warnings.push('AGENTS.md missing "Last updated" date in header');
  }

  if (daysSinceUpdate > 30) {
    warnings.push(`AGENTS.md file hasn't been modified in ${daysSinceUpdate} days`);
  }

  return {
    valid: true,
    errors: [],
    warnings,
    daysSinceUpdate,
  };
}

/**
 * Auto-fixes common AGENTS.md issues.
 * @returns {Promise<Object>} Fix results
 */
async function autoFixAgentsMd(options = {}) {
  const { projectRoot, agentsMdPath = path.join(projectRoot, 'AGENTS.md') } = options;

  const fixes = [];
  const errors = [];

  if (!fs.existsSync(agentsMdPath)) {
    errors.push('AGENTS.md does not exist - cannot auto-fix');
    return { fixed: false, fixes, errors };
  }

  let content = fs.readFileSync(agentsMdPath, 'utf-8');
  let modified = false;

  // Fix 1: Update "Last updated" date
  const dateMatch = content.match(/(Last updated:\s*)\d{4}-\d{2}-\d{2}/i);
  const today = new Date().toISOString().split('T')[0];

  if (dateMatch) {
    content = content.replace(dateMatch[0], `${dateMatch[1]}${today}`);
    fixes.push('Updated "Last updated" date');
    modified = true;
  }

  // Fix 2: Update directory tree placeholder (warn only - requires manual review)
  if (content.includes('{PASTE_YOUR_DIRECTORY_TREE_HERE}')) {
    errors.push('Directory tree placeholder needs manual replacement');
  }

  if (modified) {
    fs.writeFileSync(agentsMdPath, content, 'utf-8');
  }

  return {
    fixed: errors.length === 0,
    fixes,
    errors,
  };
}

/**
 * Prints validation report to console.
 */
function printValidationReport(result) {
  console.log('\n' + '='.repeat(60));
  console.log('AGENTS.md Validation Report');
  console.log('='.repeat(60));

  console.log(`\nStatus: ${result.valid ? '✅ PASSED' : '❌ FAILED'}`);

  if (result.errors.length > 0) {
    console.log(`\n❌ Errors (${result.errors.length}):`);
    result.errors.forEach(e => console.log(`   • ${e}`));
  }

  if (result.warnings.length > 0) {
    console.log(`\n⚠️  Warnings (${result.warnings.length}):`);
    result.warnings.forEach(w => console.log(`   • ${w}`));
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('\n✅ All checks passed!');
  }

  console.log('\n' + '='.repeat(60));
}

// Module exports
module.exports = {
  validateAgentsMd,
  autoFixAgentsMd,
  printValidationReport,
};
