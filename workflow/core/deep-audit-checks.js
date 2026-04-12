/**
 * Deep Audit Dimension Checks
 *
 * Extracted from deep-audit-orchestrator.js for maintainability (ADR-41).
 * Contains all 7 audit dimension check functions and helper utilities.
 *
 * @module workflow/core/deep-audit-checks
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Finds hardcoded values matching a regex pattern across core modules.
 */
function findHardcodedValues(name, regex) {
  const coreDir = __dirname;
  const locations = [];
  const uniqueValues = new Set();

  const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
  for (const f of jsFiles) {
    const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
    let match;
    const localRegex = new RegExp(regex.source, regex.flags);
    while ((match = localRegex.exec(content)) !== null) {
      const value = match[1];
      uniqueValues.add(value);
      locations.push({ file: `core/${f}`, value, line: content.substring(0, match.index).split('\n').length });
    }
  }

  return { uniqueValues, locations };
}

/**
 * Counts pattern matches across core modules.
 */
function countPattern(regex) {
  const coreDir = __dirname;
  const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
  let total = 0;
  const fileMap = new Map();

  for (const f of jsFiles) {
    const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
    const localRegex = new RegExp(regex.source, regex.flags);
    const matches = content.match(localRegex);
    if (matches) {
      total += matches.length;
      fileMap.set(f, matches.length);
    }
  }

  const topFiles = [...fileMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file: `core/${file}`, count }));

  return { total, topFiles };
}

/**
 * Finds files matching a glob pattern.
 */
function findMatchingFiles(pattern) {
  const workflowDir = path.join(__dirname, '..');
  const results = [];

  if (pattern.includes('*')) {
    const [dir, glob] = pattern.split('/');
    const dirPath = path.join(workflowDir, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      const ext = glob.replace('*', '');
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith(ext));
      for (const f of files) {
        results.push(path.join(dirPath, f));
      }
    }
  } else if (pattern.includes('/')) {
    const filePath = path.join(workflowDir, pattern);
    if (fs.existsSync(filePath)) results.push(filePath);
  } else {
    const filePath = path.join(workflowDir, pattern);
    if (fs.existsSync(filePath)) results.push(filePath);
  }

  return results;
}

/**
 * Counts lines in a file.
 */
function countFileLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').length;
  } catch (_) {
    return 0;
  }
}

// ─── Dimension Checks ─────────────────────────────────────────────────────────

/**
 * Creates dimension check functions with injected dependencies.
 *
 * @param {object} deps - Dependencies
 * @param {function} deps.addFinding - Function to add a finding
 * @param {function} deps.log - Logging function
 * @param {object} deps.orch - Orchestrator instance
 * @param {string} deps.outputDir - Output directory path
 * @param {object} deps.AuditSeverity - Severity enum
 * @param {object} deps.AuditCategory - Category enum
 * @param {object} deps.effectiveLinesCounter - Effective lines counter module
 * @returns {object} Check functions
 */
function createDimensionChecks({ addFinding, log, orch, outputDir, AuditSeverity, AuditCategory, effectiveLinesCounter, handoffLog }) {

  // ─── Dimension 1: Logic Consistency ───────────────────────────────────────

  async function checkLogicConsistency() {
    const label = AuditCategory.LOGIC;
    log(label, '🏁 Starting logic consistency checks across 4 dimensions...');

    // Record scan activity start
    let activityId = null;
    if (handoffLog) {
      activityId = handoffLog.startActivity('DeepAuditor', 'scan', 'logic-consistency', { target: 'core modules' });
    }

    const startTime = Date.now();
    let issuesFound = 0;

    try {
      // 1a. Check: maxRollbacks consistency across files
      log(label, '⏳ [1/4] Checking maxRollbacks consistency...');
      const rollbackValues = findHardcodedValues('maxRollbacks', /maxRollbacks\s*[:=]\s*(\d+)/g);
      if (rollbackValues.uniqueValues.size > 1) {
        addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: 'Inconsistent maxRollbacks values across modules',
          description: `maxRollbacks is hardcoded with different values: ${[...rollbackValues.uniqueValues].join(', ')}. Found in: ${rollbackValues.locations.map(l => l.file).join(', ')}`,
          suggestion: 'Extract maxRollbacks into constants.js or config-loader.js as a single source of truth.',
          locations: rollbackValues.locations,
        });
      }
      log(label, '✅ [1/4] maxRollbacks check complete');

      // 1b. Check: Token budget consistency
      log(label, '⏳ [2/4] Checking STAGE_TOKEN_BUDGET consistency...');
      const tokenBudgets = findHardcodedValues('STAGE_TOKEN_BUDGET', /STAGE_TOKEN_BUDGET[_A-Z]*\s*[:=]\s*(\d+)/g);
      if (tokenBudgets.uniqueValues.size > 1) {
        addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: 'Multiple STAGE_TOKEN_BUDGET variants with different values',
          description: `Found ${tokenBudgets.uniqueValues.size} different token budget values: ${[...tokenBudgets.uniqueValues].join(', ')}`,
          suggestion: 'Verify all token budget variants are intentional (per-stage budgets are expected).',
          locations: tokenBudgets.locations,
        });
      }
      log(label, '✅ [2/4] Token budget check complete');

      // 1c. Check: Duplicate error handling patterns
      log(label, '⏳ [3/4] Checking for silent catch blocks...');
      const silentCatches = countPattern(/catch\s*\([^)]*\)\s*\{\s*\/\*[^}]*\*\/\s*\}/g);
      if (silentCatches.total > 20) {
        addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: `${silentCatches.total} completely silent catch blocks`,
          description: 'Silent catch blocks (empty or comment-only) may hide important errors.',
          suggestion: 'Audit silent catch blocks. Ensure at minimum a console.warn for non-trivial operations.',
          locations: silentCatches.topFiles.map(f => ({ file: f.file, count: f.count })),
        });
      }
      log(label, `✅ [3/4] Silent catch check complete (${silentCatches.total} found)`);

      // 1d. Check: require() circular dependency risk
      log(label, '⏳ [4/4] Checking circular dependencies...');
      checkCircularRequires(log);
      log(label, '✅ [4/4] Circular dependency check complete');

      log(label, '🎉 All logic consistency checks complete');
    } catch (err) {
      log(label, `❌ Error: ${err.message}`);
    } finally {
      // Record scan activity end
      if (handoffLog && activityId) {
        const durationMs = Date.now() - startTime;
        handoffLog.endActivity(activityId, {
          durationMs,
          issuesFound,
          filesScanned: 4, // 4 sub-checks in this dimension
        }, true);
      }
    }
  }

  // ─── Dimension 2: Configuration Consistency ─────────────────────────────────

  async function checkConfigConsistency() {
    const label = AuditCategory.CONFIG;
    log(label, '🏁 Starting configuration consistency checks across 3 dimensions...');

    // Record scan activity start
    let activityId = null;
    if (handoffLog) {
      activityId = handoffLog.startActivity('DeepAuditor', 'scan', 'config-consistency', { target: 'PATHS & config files' });
    }

    const startTime = Date.now();

    try {
      const { PATHS } = require('./constants');

      // 2a. Check: All PATHS entries point to existing parent directories
      log(label, '⏳ [1/3] Checking PATHS directory consistency...');
      const pathKeys = Object.entries(PATHS);
      for (let i = 0; i < pathKeys.length; i++) {
        const [key, filePath] = pathKeys[i];
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir) && !dir.includes('output')) {
          addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: `PATHS.${key} parent directory does not exist`,
            description: `PATHS.${key} = "${filePath}" but parent directory "${dir}" does not exist.`,
            suggestion: 'Create the directory or update the PATHS constant.',
          });
        }
        if ((i + 1) % 5 === 0) {
          log(label, `📊 PATHS check ${i + 1}/${pathKeys.length}...`);
        }
      }
      log(label, '✅ [1/3] PATHS check complete');

      // 2b. Check: architecture-constraints.md file size limits
      log(label, '⏳ [2/3] Checking architecture-constraints.md file size limits...');
      const constraintsPath = path.join(__dirname, '..', 'docs', 'architecture-constraints.md');
      if (fs.existsSync(constraintsPath)) {
        const constraints = fs.readFileSync(constraintsPath, 'utf-8');
        const useEffectiveLines = effectiveLinesCounter !== null;

        const limitMatches = constraints.matchAll(/\|\s*`([^`]+)`[^|\r\n]*\|\s*(\d+)\s*lines/g);
        const matches = Array.from(limitMatches);
        log(label, `📊 Found ${matches.length} file pattern limit(s)`);

        let patternsChecked = 0;
        for (const match of matches) {
          patternsChecked++;
          const pattern = match[1];
          const legacyLimit = parseInt(match[2], 10);
          const files = findMatchingFiles(pattern);
          log(label, `📊 Pattern ${patternsChecked}/${matches.length}: "${pattern}" -> ${files.length} file(s)`);

          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            if ((i + 1) % 5 === 0) {
              log(label, `   ... checking file ${i + 1}/${files.length}`);
            }
            if (useEffectiveLines) {
              const check = effectiveLinesCounter.checkFileLimit(filePath);
              if (check.isViolation) {
                const realViolations = check.violations.filter(v => !v.includes('High comment ratio'));
                if (realViolations.length > 0) {
                  const severity = check.analysis.effectiveLines > check.tier.maxEffectiveLines * 1.5
                    ? AuditSeverity.HIGH : AuditSeverity.MEDIUM;

                  addFinding({
                    severity,
                    category: label,
                    title: `File exceeds effective line limit: ${path.basename(filePath)}`,
                    description: `${path.basename(filePath)} has ${check.analysis.effectiveLines} effective lines (total: ${check.analysis.totalLines}, comments: ${check.analysis.commentLines}, ratio: ${check.analysis.commentRatio}%).`,
                    suggestion: `Split into smaller modules. Extract helpers or sub-components.`,
                    locations: [{
                      file: path.relative(path.join(__dirname, '..'), filePath),
                      effectiveLines: check.analysis.effectiveLines,
                      totalLines: check.analysis.totalLines,
                      commentRatio: check.analysis.commentRatio,
                      tier: check.tier.name,
                      limit: check.tier.maxEffectiveLines,
                    }],
                  });
                }
              }
            } else {
              const lineCount = countFileLines(filePath);
              if (lineCount > legacyLimit) {
                addFinding({
                  severity: lineCount > legacyLimit * 1.5 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
                  category: label,
                  title: `File exceeds architecture constraint: ${path.basename(filePath)}`,
                  description: `${path.basename(filePath)} has ${lineCount} lines (limit: ${legacyLimit}).`,
                  suggestion: `Split into smaller modules. Extract helpers or sub-components.`,
                  locations: [{ file: path.relative(path.join(__dirname, '..'), filePath), lines: lineCount, limit: legacyLimit }],
                });
              }
            }
          }
        }
      } else {
        log(label, '⚠️ architecture-constraints.md not found, skipping file size checks');
      }
      log(label, '✅ [2/3] File size limit check complete');

      // 2c. Check: Module boundary violations
      log(label, '⏳ [3/3] Checking module boundary violations...');
      checkModuleBoundaryViolations();
      log(label, '✅ [3/3] Module boundary check complete');

      log(label, '🎉 Configuration consistency checks complete');
    } catch (err) {
      log(label, `❌ Error: ${err.message}`);
    } finally {
      // Record scan activity end
      if (handoffLog && activityId) {
        const durationMs = Date.now() - startTime;
        handoffLog.endActivity(activityId, {
          durationMs,
        }, true);
      }
    }
  }

  // ─── Dimension 3: Functional Gap Detection ──────────────────────────────
  async function checkFunctionalCompleteness() {
    const label = AuditCategory.FUNCTION;
    log(label, 'Checking functional completeness...');

    try {
      // 3a. Skill fill-rate analysis
      const skillsDir = path.join(__dirname, '..', 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        let hollow = 0;
        const hollowNames = [];
        for (const f of skillFiles) {
          const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
          // Skip template-type skills (they are meant to be filled by users)
          const isTemplate = content.match(/^type:\s*template/im);
          if (isTemplate) {
            continue;
          }
          const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
          let filled = 0;
          for (const sec of expectedSections) {
            const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
            const secMatch = content.match(secRegex);
            if (secMatch) {
              const secIdx = content.indexOf(secMatch[0]);
              const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 300);
              const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
              const words = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
              if (words >= 10) filled++;
            }
          }
          if (filled / expectedSections.length < 0.4) {
            hollow++;
            hollowNames.push(f.replace('.md', ''));
          }
        }
        if (hollow > 0) {
          addFinding({
            severity: hollow > skillFiles.length * 0.3 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
            category: label,
            title: `${hollow}/${skillFiles.length} skills have thin content (< 40% section fill-rate)`,
            description: `Hollow skills: [${hollowNames.slice(0, 8).join(', ')}${hollowNames.length > 8 ? `, +${hollowNames.length - 8} more` : ''}].`,
            suggestion: 'Run `/skill-enrich <name>` for each hollow skill, or batch enrich all.',
          });
        }
      }

      // 3b. Experience store coverage
      if (orch && orch.experienceStore) {
        const stats = orch.experienceStore.getStats();
        if (stats.total < 5) {
          addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: 'Experience store has very few entries',
            description: `Only ${stats.total} experience(s) recorded.`,
            suggestion: 'Run more workflow sessions to accumulate experiences.',
          });
        }
        if (stats.expired > stats.total * 0.3 && stats.expired > 3) {
          addFinding({
            severity: AuditSeverity.LOW,
            category: label,
            title: `${stats.expired} expired experience(s) in store`,
            description: `${stats.expired} of ${stats.total} experiences have expired.`,
            suggestion: 'Run `experienceStore.purgeExpired()` to clean up.',
          });
        }
      }

      // 3c. Complaint wall coverage
      // Fix: ComplaintWall has no .getAll() method. Access .complaints array directly.
      if (orch && orch.complaintWall) {
        try {
          const cw = orch.complaintWall;
          const complaints = cw.complaints || [];
          const unresolved = complaints.filter(c => c.status === 'open' || c.status === 'acknowledged');
          if (unresolved.length > 5) {
            addFinding({
              severity: unresolved.length > 10 ? AuditSeverity.HIGH : AuditSeverity.MEDIUM,
              category: label,
              title: `${unresolved.length} unresolved complaints in ComplaintWall`,
              description: `There are ${unresolved.length} open/acknowledged complaints.`,
              suggestion: 'Review unresolved complaints with `/complaints`.',
            });
          }
        } catch (err) {
          if (process.env.DEBUG) console.warn(`[DeepAudit] Failed to process complaints: ${err.message}`);
        }
      }

    } catch (err) {
      log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 4: Module Coupling Analysis ──────────────────────────────────

  async function checkModuleCoupling() {
    const label = AuditCategory.COUPLING;
    log(label, 'Checking module coupling...');

    try {
      if (!orch || !orch.codeGraph) {
        log(label, 'CodeGraph not available, skipping coupling analysis.');
        return;
      }

      const cg = orch.codeGraph;
      if (cg._symbols && cg._symbols.size === 0) {
      cg.ensureLoaded();
      }
      if (!cg._symbols || cg._symbols.size === 0) {
        log(label, 'Code graph has no symbols. Run a build first.');
        return;
      }

      // 4a. Hub analysis
      const hotspots = await cg.getHotspots({ topN: 30, includeOrphans: false });
      const hubs = hotspots.filter(h => h.category === 'hub');
      if (hubs.length > 5) {
        addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: `${hubs.length} hub symbols detected (high coupling risk)`,
          description: `Hubs have both high fan-in and fan-out: ${hubs.slice(0, 5).map(h => `${h.symbol.name}`).join(', ')}.`,
          suggestion: 'Consider splitting hub symbols into smaller focused functions.',
          locations: hubs.slice(0, 5).map(h => ({ file: h.symbol.file, symbol: h.symbol.name })),
        });
      }

      // 4b. Orphan detection
      const orphans = hotspots.filter(h => h.category === 'orphan');
      const realOrphans = orphans.filter(h => !h.symbol.file.includes('test') && !h.symbol.file.includes('spec'));
      if (realOrphans.length > 10) {
        addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: `${realOrphans.length} orphan symbols (potential dead code)`,
          description: `Symbols with 0 incoming refs AND 0 outgoing calls: ${realOrphans.slice(0, 5).map(h => h.symbol.name).join(', ')}...`,
          suggestion: 'Review orphan symbols. Remove truly unused code to reduce entropy.',
        });
      }

      // 4c. File-level coupling
      const importCounts = new Map();
      if (cg._importEdges) {
        for (const [file, imports] of cg._importEdges) {
          importCounts.set(file, (imports || []).length);
        }
      }
      const highImportFiles = [...importCounts.entries()]
        .filter(([, count]) => count > 10)
        .sort((a, b) => b[1] - a[1]);
      if (highImportFiles.length > 0) {
        addFinding({
          severity: AuditSeverity.MEDIUM,
          category: label,
          title: `${highImportFiles.length} file(s) with high import count (>10)`,
          description: `Files with many imports: ${highImportFiles.slice(0, 3).map(([f, c]) => `${f} (${c} imports)`).join(', ')}.`,
          suggestion: 'Consider splitting these files or introducing a facade/helper module.',
          locations: highImportFiles.slice(0, 5).map(([file, count]) => ({ file, imports: count })),
        });
      }

    } catch (err) {
      log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 5: Architecture Compliance ────────────────────────────────────

  async function checkArchitectureCompliance() {
    const label = AuditCategory.ARCHITECTURE;
    log(label, 'Checking architecture compliance...');

    try {
      // 5a. Dual-path unification
      const indexPath = path.join(__dirname, '..', 'index.js');
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const hasRun = /async\s+run\s*\(/.test(indexContent);
        const hasRunTaskBased = /async\s+runTaskBased\s*\(/.test(indexContent) || /async\s+runAuto\s*\(/.test(indexContent);
        if (hasRun && hasRunTaskBased) {
const sharedMethods = ['_initWorkflow', '_finalizeWorkflow', '_teardownPipeline'];
          for (const method of sharedMethods) {
            if (!indexContent.includes(method)) {
              addFinding({
                severity: AuditSeverity.HIGH,
                category: label,
                title: `Missing shared method: ${method}`,
                description: `Both run() and runTaskBased() paths should use ${method}() for unification.`,
                suggestion: `Implement ${method}() as required by architecture-constraints.md.`,
              });
            }
          }
        }
      }

      // 5b. Check output directory existence
      if (!fs.existsSync(outputDir)) {
        addFinding({
          severity: AuditSeverity.LOW,
          category: label,
          title: 'Output directory does not exist',
          description: `The output directory "${outputDir}" does not exist.`,
          suggestion: 'Ensure _initWorkflow() creates the output directory.',
        });
      }

      // 5c. Check naming conventions
      const agentsDir = path.join(__dirname, '..', 'agents');
      if (fs.existsSync(agentsDir)) {
        const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.js'));
        for (const f of agentFiles) {
          const content = fs.readFileSync(path.join(agentsDir, f), 'utf-8');
          const classMatch = content.match(/class\s+(\w+)/);
          if (classMatch && !classMatch[1].endsWith('Agent') && !f.includes('base') && !f.includes('helper')) {
            addFinding({
              severity: AuditSeverity.LOW,
              category: label,
              title: `Agent class naming violation: ${classMatch[1]} in ${f}`,
              description: `Class "${classMatch[1]}" in agents/ should follow the XxxAgent naming convention.`,
              suggestion: `Rename to ${classMatch[1]}Agent or move to core/ if it's a service.`,
            });
          }
        }
      }

    } catch (err) {
      log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 6: Performance / Efficiency ───────────────────────────────────

  async function checkPerformanceEfficiency() {
    const label = AuditCategory.PERFORMANCE;
    log(label, 'Checking performance efficiency...');

    try {
      // 6a. Leverage SelfReflection's existing health audit
      if (orch && orch._selfReflection) {
        const auditResult = await orch._selfReflection.auditHealth();
        if (auditResult.findings && auditResult.findings.length > 0) {
          for (const f of auditResult.findings) {
            addFinding({
              severity: f.severity || AuditSeverity.MEDIUM,
              category: label,
              title: `[SelfReflection] ${f.title}`,
              description: f.description,
              suggestion: f.suggestedFix || 'See self-reflection engine for details.',
              source: 'self-reflection-engine',
            });
          }
        }
      }

      // 6b. Leverage EntropyGC's existing scan
      const entropyReportPath = path.join(outputDir, 'entropy-report.json');
      if (fs.existsSync(entropyReportPath)) {
        try {
          const entropyReport = JSON.parse(fs.readFileSync(entropyReportPath, 'utf-8'));
          const highViolations = (entropyReport.violations || []).filter(v => v.severity === 'high');
          if (highViolations.length > 0) {
            addFinding({
              severity: AuditSeverity.HIGH,
              category: label,
              title: `${highViolations.length} high-severity entropy violation(s) from last scan`,
              description: `EntropyGC found: ${highViolations.slice(0, 3).map(v => `${v.type}: ${v.detail}`).join('; ')}`,
              suggestion: 'Run `/gc` and fix high-severity violations.',
              source: 'entropy-gc',
            });
          }
        } catch (err) {
          if (process.env.DEBUG) console.warn(`[DeepAudit] Failed to parse entropy report: ${err.message}`);
        }
      }

      // 6c. Check for large files
      const coreDir = __dirname;
      const coreFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
      for (const f of coreFiles) {
        const size = fs.statSync(path.join(coreDir, f)).size;
        if (size > 50000) {
          addFinding({
            severity: size > 80000 ? AuditSeverity.MEDIUM : AuditSeverity.LOW,
            category: label,
            title: `Large core module: ${f} (${(size / 1024).toFixed(0)}KB)`,
            description: `${f} is ${(size / 1024).toFixed(0)}KB. Large modules increase memory footprint.`,
            suggestion: 'Consider extracting helper functions into separate modules.',
            locations: [{ file: `core/${f}`, sizeKB: Math.round(size / 1024) }],
          });
        }
      }

    } catch (err) {
      log(label, `Error: ${err.message}`);
    }
  }

  // ─── Dimension 7: Knowledge Quality ──────────────────────────────────────────

  async function checkKnowledgeQuality() {
    const label = AuditCategory.KNOWLEDGE;
    log(label, 'Checking knowledge quality...');

    try {
      // 7a. Skill version consistency
      const skillsDir = path.join(__dirname, '..', 'skills');
      if (fs.existsSync(skillsDir)) {
        const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
        let noVersion = 0;
        for (const f of skillFiles) {
          const content = fs.readFileSync(path.join(skillsDir, f), 'utf-8');
          if (!content.match(/version:\s*[\d.]+/)) {
            noVersion++;
          }
        }
        if (noVersion > 0) {
          addFinding({
            severity: AuditSeverity.LOW,
            category: label,
            title: `${noVersion} skill file(s) missing version in frontmatter`,
            description: 'Skills without version tracking cannot be audited for staleness.',
            suggestion: 'Add `version: 1.0.0` to skill frontmatter.',
          });
        }
      }

      // 7b. Check for stale search knowledge entries
      const searchKnowledgePath = path.join(outputDir, 'analyse-search-knowledge.json');
      if (fs.existsSync(searchKnowledgePath)) {
        try {
          const entries = JSON.parse(fs.readFileSync(searchKnowledgePath, 'utf-8'));
          const staleThresholdMs = 90 * 24 * 60 * 60 * 1000;
          const staleEntries = entries.filter(e =>
            e.timestamp && (Date.now() - new Date(e.timestamp).getTime()) > staleThresholdMs
          );
          if (staleEntries.length > entries.length * 0.5 && staleEntries.length > 3) {
            addFinding({
              severity: AuditSeverity.LOW,
              category: label,
              title: `${staleEntries.length}/${entries.length} search knowledge entries are >90 days old`,
              description: 'Stale search knowledge may contain outdated technology references.',
              suggestion: 'Consider re-running ANALYSE with fresh searches.',
            });
          }
        } catch (err) {
          if (process.env.DEBUG) console.warn(`[DeepAudit] Failed to parse search knowledge: ${err.message}`);
        }
      }

      // 7c. Experience-to-Skill feedback loop health
      if (orch && orch.experienceStore) {
        const exps = orch.experienceStore.experiences || [];
        const negativeExps = exps.filter(e => e.type === 'negative' && !e.expiresAt);
        const evolvedCount = exps.filter(e => e.evolutionCount > 0).length;
        if (negativeExps.length > 5 && evolvedCount === 0) {
          addFinding({
            severity: AuditSeverity.MEDIUM,
            category: label,
            title: 'Negative experiences accumulating but no skill evolution triggered',
            description: `${negativeExps.length} negative experiences recorded but 0 have triggered skill evolution.`,
            suggestion: 'Check ExperienceEvolution hitCount thresholds and triggerEvolutions() invocation.',
          });
        }
      }

    } catch (err) {
      log(label, `Error: ${err.message}`);
    }
  }

  // ─── Internal Helpers ────────────────────────────────────────────────────────

  function checkCircularRequires(progress = null) {
    // Simplified circular dependency check with comment exclusion
    const coreDir = __dirname;
    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));
    const importGraph = new Map();
    const total = jsFiles.length;

    if (progress && total > 10) {
      progress(AuditCategory.LOGIC, `🔍 Scanning ${total} files for circular dependencies...`);
    }

    /**
     * Extract actual require() calls from code, excluding:
     * 1. Comments (// and /* ... *\/ and JSDoc)
     * 2. String literals
     * 3. Self-references (A.js requiring A.js via re-export facade)
     */
    function extractRequires(content, fileName) {
      // Remove comments first
      let codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, '')           // Remove /* */ comments
        .replace(/\/\/[^\r\n]*/g, '');               // Remove // comments

      // Also remove multi-line JSDoc comments that might span lines
      codeOnly = codeOnly.replace(/^\s*\*\s*.*$/gm, '');

      const imports = [];
      const requireRegex = /require\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g;
      let match;

      while ((match = requireRegex.exec(codeOnly)) !== null) {
        const required = match[1] + '.js';
        // Skip self-references (e.g., A.js re-exporting from A.js is NOT a cycle)
        // Also skip if the required file is the same as current file (facade pattern)
        if (required !== fileName && !fileName.includes(required.replace('.js', ''))) {
          imports.push(required);
        }
      }

      return imports;
    }

    for (let i = 0; i < jsFiles.length; i++) {
      const f = jsFiles[i];
      // Progress update every 10 files
      if (progress && total > 10 && (i + 1) % 10 === 0) {
        progress(AuditCategory.LOGIC, `📊 Scanned ${i + 1}/${total} files (${Math.round((i + 1) / total * 100)}%)...`);
      }
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      const imports = extractRequires(content, f);
      importGraph.set(f, imports);
    }

    if (progress && total > 10) {
      progress(AuditCategory.LOGIC, `✅ File scanning complete, checking ${importGraph.size} modules for cycles...`);
    }

    // Check for simple cycles (A → B → A), avoiding duplicates
    let cyclesFound = 0;
    const reportedCycles = new Set(); // Track reported cycles to avoid duplicates

    for (const [file, deps] of importGraph) {
      for (const dep of deps) {
        // Create a canonical cycle key (sorted to avoid A→B and B→A being separate)
        const cycleKey = [file, dep].sort().join('::');
        if (reportedCycles.has(cycleKey)) continue;

        const depDeps = importGraph.get(dep) || [];
        if (depDeps.includes(file)) {
          cyclesFound++;
          reportedCycles.add(cycleKey);
          addFinding({
            severity: AuditSeverity.MEDIUM,
            category: AuditCategory.LOGIC,
            title: `Circular require detected: ${file} ↔ ${dep}`,
            description: `Circular dependencies can cause initialization order issues.`,
            suggestion: 'Refactor to break the cycle. Consider using dependency injection or lazy loading.',
            locations: [{ file: `core/${file}` }, { file: `core/${dep}` }],
          });
        }
      }
    }

    if (progress && total > 10) {
      progress(AuditCategory.LOGIC, `📊 Completed: ${cyclesFound} circular dependencies found across ${total} files`);
    }
  }

  function checkModuleBoundaryViolations() {
    const coreDir = __dirname;
    const jsFiles = fs.readdirSync(coreDir).filter(f => f.endsWith('.js'));

    for (const f of jsFiles) {
      const content = fs.readFileSync(path.join(coreDir, f), 'utf-8');
      // Check for core/ importing from agents/ (boundary violation)
      const agentImports = content.match(/require\s*\(\s*['"]\.\.\/agents\/['"]/g) || [];
      if (agentImports.length > 0) {
        addFinding({
          severity: AuditSeverity.MEDIUM,
          category: AuditCategory.CONFIG,
          title: `Module boundary violation: ${f} imports from agents/`,
          description: `core/ modules should not import from agents/. This creates circular dependency risk.`,
          suggestion: 'Move shared code to core/ or use dependency injection.',
          locations: [{ file: `core/${f}` }],
        });
      }
    }
  }

  return {
    checkLogicConsistency,
    checkConfigConsistency,
    checkFunctionalCompleteness,
    checkModuleCoupling,
    checkArchitectureCompliance,
    checkPerformanceEfficiency,
    checkKnowledgeQuality,
  };
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  createDimensionChecks,
  findHardcodedValues,
  countPattern,
  findMatchingFiles,
  countFileLines,
};
