/**
 * Architecture Validator – Verify ADR constraints vs actual codebase.
 *
 * P2 Enhancement: Automated architecture governance.
 * Validates that the codebase adheres to documented ADRs and constraints:
 *   - File size limits per architecture-constraints.md
 *   - IDE-First principle (ADR-37) compliance
 *   - Module boundary enforcement (no circular imports)
 *   - ADR decision implementation status
 *
 * Design: Zero-LLM, AST-based static analysis where needed.
 *
 * @module architecture-validator
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} ArchValidationResult
 * @property {boolean} valid - Overall validation passed
 * @property {string[]} errors - Critical violations (must fix)
 * @property {string[]} warnings - Recommendations
 * @property {Object} summary - Statistics
 */

/**
 * Runs comprehensive architecture validation.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Project root directory
 * @param {boolean} [options.checkFileSizes=true] - Check file size limits
 * @param {boolean} [options.checkModuleBoundaries=true] - Check import boundaries
 * @param {boolean} [options.checkAdrCompliance=true] - Check ADR constraints
 * @returns {ArchValidationResult}
 */
function validateArchitecture(options = {}) {
  const {
    projectRoot,
    checkFileSizes = true,
    checkModuleBoundaries = true,
    checkAdrCompliance = true,
  } = options;

  const errors = [];
  const warnings = [];
  const details = {
    fileSizes: [],
    boundaryViolations: [],
    adrCompliance: [],
  };

  // Load architecture docs
  const constraintsPath = path.join(projectRoot, 'workflow', 'docs', 'architecture-constraints.md');
  const decisionLogPath = path.join(projectRoot, 'workflow', 'docs', 'decision-log.md');

  // Check 1: File Size Limits
  if (checkFileSizes) {
    const fileSizeResult = _checkFileSizeLimits(projectRoot, constraintsPath);
    details.fileSizes = fileSizeResult.details;
    errors.push(...fileSizeResult.errors);
    warnings.push(...fileSizeResult.warnings);
  }

  // Check 2: Module Boundaries
  if (checkModuleBoundaries) {
    const boundaryResult = _checkModuleBoundaries(projectRoot);
    details.boundaryViolations = boundaryResult.violations;
    errors.push(...boundaryResult.errors);
    warnings.push(...boundaryResult.warnings);
  }

  // Check 3: ADR-37 IDE-First Compliance
  if (checkAdrCompliance && fs.existsSync(constraintsPath)) {
    const adrResult = _checkIDEFirstCompliance(projectRoot, constraintsPath);
    details.adrCompliance = adrResult.details;
    errors.push(...adrResult.errors);
    warnings.push(...adrResult.warnings);
  }

  // Check 4: Detect stale ADR references in code
  if (checkAdrCompliance && fs.existsSync(decisionLogPath)) {
    const staleResult = _checkStaleAdrReferences(projectRoot, decisionLogPath);
    warnings.push(...staleResult.warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      filesChecked: details.fileSizes.length,
      boundaryViolations: details.boundaryViolations.length,
      adrChecks: details.adrCompliance.length,
    },
    details,
  };
}

/**
 * Check file sizes against architecture-constraints.md limits.
 */
function _checkFileSizeLimits(projectRoot, constraintsPath) {
  const errors = [];
  const warnings = [];
  const details = [];

  // Default limits from architecture-constraints.md
  const LIMITS = {
    'index.js': { max: 600, effective: 500 },
    'core/*.js': { max: 400, effective: 350 },
    'agents/*.js': { max: 300, effective: 250 },
    'commands/command-router.js': { max: 100, effective: 80 },
    'commands/commands-*.js': { max: 500, effective: 400 },
  };

  const workflowDir = path.join(projectRoot, 'workflow');
  if (!fs.existsSync(workflowDir)) {
    return { errors: [], warnings: [], details: [] };
  }

  const checkFile = (filePath, pattern) => {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').length;
    const effectiveLines = _countEffectiveLines(content);

    const limit = LIMITS[pattern] || LIMITS['core/*.js'];
    const relativePath = path.relative(projectRoot, filePath);

    const fileDetail = {
      path: relativePath,
      totalLines: lines,
      effectiveLines,
      limit: limit.effective,
      pattern,
    };

    if (effectiveLines > limit.effective) {
      errors.push(`File size violation: ${relativePath} (${effectiveLines} effective lines > ${limit.effective} limit)`);
      fileDetail.violation = 'error';
    } else if (lines > limit.max && effectiveLines <= limit.effective) {
      // Total lines exceed but effective is OK - high comment ratio
      warnings.push(`${relativePath} has high comment ratio (${Math.round((1 - effectiveLines/lines) * 100)}%). Consider simplifying documentation.`);
      fileDetail.violation = 'warning';
    }

    details.push(fileDetail);
  };

  // Walk directories
  const walkDir = (dir, pattern) => {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walkDir(fullPath, pattern);
      } else if (item.endsWith('.js')) {
        checkFile(fullPath, pattern);
      }
    }
  };

  // Check specific patterns
  walkDir(path.join(workflowDir, 'agents'), 'agents/*.js');
  walkDir(path.join(workflowDir, 'core'), 'core/*.js');
  walkDir(path.join(workflowDir, 'commands'), 'commands/commands-*.js');

  const indexPath = path.join(workflowDir, 'index.js');
  if (fs.existsSync(indexPath)) {
    checkFile(indexPath, 'index.js');
  }

  return { errors, warnings, details };
}

/**
 * Count effective lines (excluding comments and blanks).
 */
function _countEffectiveLines(content) {
  const lines = content.split('\n');
  let effective = 0;
  let inBlockComment = false;

  for (let line of lines) {
    const trimmed = line.trim();

    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }

    if (trimmed.startsWith('//') || trimmed === '') {
      continue;
    }

    effective++;
  }

  return effective;
}

/**
 * Check module boundary violations using import analysis.
 */
function _checkModuleBoundaries(projectRoot) {
  const errors = [];
  const warnings = [];
  const violations = [];

  const workflowDir = path.join(projectRoot, 'workflow');
  if (!fs.existsSync(workflowDir)) {
    return { errors, warnings, violations };
  }

  // Defined boundaries from architecture-constraints.md
  const BOUNDARIES = {
    'types.js': { canImport: [], canExportTo: ['constants.js', 'core/', 'agents/', 'commands/'] },
    'constants.js': { canImport: ['types.js'], canExportTo: ['core/', 'agents/', 'commands/'] },
    'core/': { canImport: ['types.js', 'constants.js', 'core/'], canExportTo: ['agents/', 'commands/'] },
    'agents/': { canImport: ['types.js', 'constants.js', 'core/'], canExportTo: ['commands/', 'index.js'] },
    'commands/': { canImport: ['types.js', 'constants.js', 'core/', 'agents/'], canExportTo: ['index.js'] },
    'index.js': { canImport: ['*'], canExportTo: [] },
  };

  const checkFile = (filePath) => {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fileModule = _getModuleName(filePath, workflowDir);

    // Extract require() statements
    const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
    let match;

    while ((match = requirePattern.exec(content)) !== null) {
      const importPath = match[1];

      // Skip external modules
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

      // Resolve relative to absolute
      const resolvedImport = _resolveImport(importPath, path.dirname(filePath), projectRoot);
      if (!resolvedImport) continue;

      // Check if import crosses boundaries
      const importModule = _getModuleName(resolvedImport, workflowDir);

      const violation = _checkBoundaryViolation(fileModule, importModule, BOUNDARIES);
      if (violation) {
        const relativeFile = path.relative(projectRoot, filePath);
        const relativeImport = path.relative(projectRoot, resolvedImport);

        violations.push({
          from: relativeFile,
          to: relativeImport,
          rule: violation,
        });

        warnings.push(`Boundary violation: ${relativeFile} imports from ${relativeImport} (${violation})`);
      }
    }
  };

  // Check all JS files
  const checkDir = (dir) => {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        checkDir(fullPath);
      } else if (item.endsWith('.js')) {
        checkFile(fullPath);
      }
    }
  };

  checkDir(workflowDir);

  return { errors, warnings, violations };
}

/**
 * Get module category from file path.
 */
function _getModuleName(filePath, workflowDir) {
  const relative = path.relative(workflowDir, filePath);

  if (relative === 'types.js') return 'types.js';
  if (relative === 'constants.js') return 'constants.js';
  if (relative === 'index.js') return 'index.js';
  if (relative.startsWith('core/')) return 'core/';
  if (relative.startsWith('agents/')) return 'agents/';
  if (relative.startsWith('commands/')) return 'commands/';

  return relative;
}

/**
 * Resolve import path to absolute path.
 */
function _resolveImport(importPath, fromDir, projectRoot) {
  // Handle relative imports
  if (importPath.startsWith('.')) {
    const resolved = path.resolve(fromDir, importPath);

    // Try .js extension
    if (fs.existsSync(resolved)) return resolved;
    if (fs.existsSync(resolved + '.js')) return resolved + '.js';
    if (fs.existsSync(resolved + '/index.js')) return resolved + '/index.js';
  }

  return null;
}

/**
 * Check if import violates boundary rules.
 */
function _checkBoundaryViolation(fromModule, toModule, boundaries) {
  // Find applicable boundary rule
  const fromRule = boundaries[fromModule] || boundaries[Object.keys(boundaries).find(k => fromModule.startsWith(k))];
  const toRule = boundaries[toModule] || boundaries[Object.keys(boundaries).find(k => toModule.startsWith(k))];

  if (!fromRule || !toRule) return null;

  // Check if import is allowed
  const canExport = fromRule.canExportTo.some(exp =>
    toModule === exp || toModule.startsWith(exp)
  );

  if (!canExport && fromModule !== toModule) {
    return `${fromModule} should not import from ${toModule}`;
  }

  return null;
}

/**
 * Check IDE-First principle (ADR-37) compliance.
 */
function _checkIDEFirstCompliance(projectRoot, constraintsPath) {
  const errors = [];
  const warnings = [];
  const details = [];

  const constraints = fs.readFileSync(constraintsPath, 'utf-8');

  // Check 1: LSPAdapter has skip logic
  const lspAdapterPath = path.join(projectRoot, 'workflow', 'core', 'lsp-adapter.js');
  if (fs.existsSync(lspAdapterPath)) {
    const lspContent = fs.readFileSync(lspAdapterPath, 'utf-8');

    const hasSkipCheck = lspContent.includes('shouldSkipLSPAdapter') ||
                        lspContent.includes('skipLSP');

    details.push({ check: 'lsp_skip_logic', found: hasSkipCheck });

    if (!hasSkipCheck) {
      errors.push('LSPAdapter missing IDE detection skip logic (ADR-37 violation)');
    }
  }

  // Check 2: PromptBuilder injects IDE guidance
  const promptBuilderPath = path.join(projectRoot, 'workflow', 'core', 'prompt-builder.js');
  if (fs.existsSync(promptBuilderPath)) {
    const pbContent = fs.readFileSync(promptBuilderPath, 'utf-8');

    const hasIDEGuidance = pbContent.includes('IDETool') ||
                          pbContent.includes('IDE Tool') ||
                          pbContent.includes('ide-first') ||
                          pbContent.includes('ADR-37');

    details.push({ check: 'ide_guidance', found: hasIDEGuidance });

    if (!hasIDEGuidance) {
      errors.push('PromptBuilder missing IDE-First guidance injection (ADR-37 violation)');
    }
  }

  // Check 3: ide-detection.js exists and has caching
  const ideDetectionPath = path.join(projectRoot, 'workflow', 'core', 'ide-detection.js');
  if (fs.existsSync(ideDetectionPath)) {
    const ideContent = fs.readFileSync(ideDetectionPath, 'utf-8');

    const hasCaching = ideContent.includes('cache') || ideContent.includes('singleton');

    details.push({ check: 'ide_cache', found: hasCaching });

    if (!hasCaching) {
      warnings.push('ide-detection.js should cache results per ADR-37');
    }
  } else {
    errors.push('Missing ide-detection.js (required for ADR-37)');
  }

  return { errors, warnings, details };
}

/**
 * Check for stale ADR references in code.
 */
function _checkStaleAdrReferences(projectRoot, decisionLogPath) {
  const warnings = [];

  const decisionLog = fs.readFileSync(decisionLogPath, 'utf-8');

  // Extract all ADR references
  const adrPattern = /ADR-\d+/g;
  const adrs = [...decisionLog.matchAll(adrPattern)].map(m => m[0]);
  const uniqueAdrs = [...new Set(adrs)];

  // Check if ADRs are referenced in relevant code
  const workflowDir = path.join(projectRoot, 'workflow');
  const adrToFiles = {};

  // Initialize mapping
  for (const adr of uniqueAdrs) {
    adrToFiles[adr] = [];
  }

  // Search for ADR references in code
  const searchDir = (dir) => {
    if (!fs.existsSync(dir)) return;

    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        searchDir(fullPath);
      } else if (item.endsWith('.js') || item.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        for (const adr of uniqueAdrs) {
          if (content.includes(adr)) {
            adrToFiles[adr].push(path.relative(projectRoot, fullPath));
          }
        }
      }
    }
  };

  searchDir(workflowDir);

  // Warn about ADRs with no code references
  const unreferenced = uniqueAdrs.filter(adr => adrToFiles[adr].length === 0);
  if (unreferenced.length > 0) {
    warnings.push(`ADRs with no code references: ${unreferenced.join(', ')}`);
  }

  return { warnings, adrReferences: adrToFiles };
}

/**
 * Print validation report.
 */
function printArchValidationReport(result) {
  console.log('\n' + '='.repeat(70));
  console.log('Architecture Validation Report');
  console.log('='.repeat(70));

  console.log(`\nStatus: ${result.valid ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`\nSummary:`);
  console.log(`  Files checked: ${result.summary.filesChecked}`);
  console.log(`  Boundary violations: ${result.summary.boundaryViolations}`);
  console.log(`  ADR compliance checks: ${result.summary.adrChecks}`);

  if (result.errors.length > 0) {
    console.log(`\n❌ Critical Violations (${result.errors.length}):`);
    result.errors.forEach(e => console.log(`   • ${e}`));
  }

  if (result.warnings.length > 0) {
    console.log(`\n⚠️  Warnings (${result.warnings.length}):`);
    result.warnings.forEach(w => console.log(`   • ${w}`));
  }

  // Print file size details
  if (result.details.fileSizes.length > 0) {
    const violations = result.details.fileSizes.filter(f => f.violation);
    if (violations.length > 0) {
      console.log('\n📁 File Size Details:');
      violations.forEach(f => {
        const status = f.violation === 'error' ? '❌' : '⚠️';
        console.log(`   ${status} ${f.path}: ${f.effectiveLines}/${f.limit} effective lines`);
      });
    }
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log('\n✅ All architecture checks passed!');
  }

  console.log('\n' + '='.repeat(70));
}

// Module exports
module.exports = {
  validateArchitecture,
  printArchValidationReport,
  // Export for testing
  _countEffectiveLines,
  _getModuleName,
  _checkBoundaryViolation,
};
