/**
 * PostCodeQualityGuard — 自动化 CODE 阶段阻塞质量门禁
 *
 * 4 维度 9 项检查, 零 LLM, 零新依赖。
 * 运行于 stage-complete --stage CODE 之后、TEST 之前。
 *
 * 检查维度:
 *   1. SYNTAX  — node -c 语法验证 (CRITICAL, 阻塞)
 *   2. RESOLVE — require() 目标存在性 (CRITICAL, 阻塞)
 *   3. DECLARE — 重复声明 + 格式问题 (HIGH, 阻塞)
 *   4. CONSUME — module.exports 消费者检查 (MEDIUM, 警告)
 *   5. FRAMEWORK — 文件大小 ADR-41 合规 (LOW, 警告)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { GateEngine } = require('./gate-engine');

// ─── Constants ───────────────────────────────────────────────────────────────

const PHASE = {
  SYNTAX:    'SYNTAX',
  RESOLVE:   'RESOLVE',
  DECLARE:   'DECLARE',
  CONSUME:   'CONSUME',
  FRAMEWORK: 'FRAMEWORK',
};

const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
};

const DEFAULT_CONFIG = {
  enabled: true,
  blockingPhases: ['SYNTAX', 'RESOLVE', 'DECLARE'],
  warnPhases: ['CONSUME', 'FRAMEWORK'],
  maxSyntaxErrors: 0,
  fileSizeLimit: 600,
  skipPatterns: ['*.test.js'],
  syntaxTimeoutMs: 5000,
};

// ─── Main Class ──────────────────────────────────────────────────────────────

class PostCodeQualityGuard {
  /**
   * @param {object} opts
   * @param {string}   opts.projectRoot   — 项目根目录
   * @param {string[]} opts.modifiedFiles — 修改的文件列表 (相对路径)
   * @param {object}   [opts.config]      — 覆盖默认配置
   * @param {boolean}  [opts.verbose]     — 详细输出
   */
  constructor({ projectRoot, modifiedFiles, config = {}, verbose = true }) {
    this._root = projectRoot;
    this._files = (modifiedFiles || []).filter(f => typeof f === 'string' && f.endsWith('.js'));
    this._cfg = { ...DEFAULT_CONFIG, ...config };
    this._verbose = verbose;
    this._findings = [];
    this._phaseResults = {};
  }

  /**
   * Runs all checks. Returns structured result.
   * @returns {Promise<PostCodeQualityResult>}
   */
  async run() {
    if (!this._cfg.enabled) {
      return { passed: true, phases: {}, summary: 'Guard disabled by config', blocked: false };
    }
    if (this._files.length === 0) {
      return { passed: true, phases: {}, summary: 'No modified JS files to check', blocked: false };
    }

    this._log(`\n╔══════════════════════════════════════════════════════════╗`);
    this._log(`║  🛡️  PostCodeQualityGuard — ${this._files.length} file(s) to check`.padEnd(62) + `║`);
    this._log(`╚══════════════════════════════════════════════════════════╝`);

    // Phase 1: Syntax (CRITICAL)
    if (this._shouldRun(PHASE.SYNTAX)) {
      this._phaseResults[PHASE.SYNTAX] = this._checkSyntax();
      this._reportPhase(this._phaseResults[PHASE.SYNTAX]);

      if (this._isBlocking(PHASE.SYNTAX) && this._phaseResults[PHASE.SYNTAX].blocked) {
        return this._buildResult(true, `SYNTAX phase failed: ${this._phaseResults[PHASE.SYNTAX].errorCount} error(s)`);
      }
    }

    // Phase 2: Module Resolution (CRITICAL)
    if (this._shouldRun(PHASE.RESOLVE)) {
      this._phaseResults[PHASE.RESOLVE] = this._checkModuleResolution();
      this._reportPhase(this._phaseResults[PHASE.RESOLVE]);

      if (this._isBlocking(PHASE.RESOLVE) && this._phaseResults[PHASE.RESOLVE].blocked) {
        return this._buildResult(true, `RESOLVE phase failed: ${this._phaseResults[PHASE.RESOLVE].errorCount} broken require(s)`);
      }
    }

    // Phase 3: Declaration Analysis (HIGH)
    if (this._shouldRun(PHASE.DECLARE)) {
      this._phaseResults[PHASE.DECLARE] = this._checkDeclarations();
      this._reportPhase(this._phaseResults[PHASE.DECLARE]);

      if (this._isBlocking(PHASE.DECLARE) && this._phaseResults[PHASE.DECLARE].blocked) {
        return this._buildResult(true, `DECLARE phase failed: ${this._phaseResults[PHASE.DECLARE].errorCount} issue(s)`);
      }
    }

    // Phase 4: Consumer Check (MEDIUM)
    if (this._shouldRun(PHASE.CONSUME)) {
      this._phaseResults[PHASE.CONSUME] = this._checkConsumers();
      this._reportPhase(this._phaseResults[PHASE.CONSUME]);
    }

    // Phase 5: Framework Compliance (LOW)
    if (this._shouldRun(PHASE.FRAMEWORK)) {
      this._phaseResults[PHASE.FRAMEWORK] = this._checkFramework();
      this._reportPhase(this._phaseResults[PHASE.FRAMEWORK]);
    }

    const totalErrors = Object.values(this._phaseResults).reduce((sum, p) => sum + (p.errorCount || 0), 0);
    const totalWarnings = Object.values(this._phaseResults).reduce((sum, p) => sum + (p.warningCount || 0), 0);

    this._log(`\n[PostCodeQualityGuard] ✅ All checks complete: ${totalErrors} error(s), ${totalWarnings} warning(s)`);

    return this._buildResult(false, `All blocking checks passed (${totalErrors} error(s), ${totalWarnings} warning(s))`);
  }

  // ─── Phase 1: Syntax Check ─────────────────────────────────────────────────
  _checkSyntax() {
    const findings = [];
    let errorCount = 0;
    const skipped = [];

    for (const file of this._files) {
      const fullPath = path.join(this._root, file);
      if (!fs.existsSync(fullPath)) { skipped.push(file); continue; }
      if (this._shouldSkip(file)) { skipped.push(file); continue; }

      try {
        execSync(`node -c "${fullPath}"`, {
          timeout: this._cfg.syntaxTimeoutMs,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
        });
      } catch (err) {
        errorCount++;
        const stderr = (err.stderr || '').toString();
        const lineMatch = stderr.match(/:(\d+)/);
        findings.push({
          file,
          severity: SEVERITY.CRITICAL,
          message: `Syntax error in ${file}`,
          detail: stderr.split('\n')[0],
          line: lineMatch ? parseInt(lineMatch[1]) : null,
          fix: `Fix the syntax error in ${file} at line ${lineMatch ? lineMatch[1] : '?'}`,
        });
      }
    }

    const synCheck = new GateEngine().checkSyntaxValidity(findings);
    return {
      phase: PHASE.SYNTAX,
      blocked: !synCheck.pass,
      errorCount,
      warningCount: 0,
      skippedFiles: skipped,
      findings,
    };
  }

  // ─── Phase 2: Module Resolution ─────────────────────────────────────────────
  _checkModuleResolution() {
    const findings = [];
    let errorCount = 0;

    for (const file of this._files) {
      const fullPath = path.join(this._root, file);
      if (!fs.existsSync(fullPath)) continue;
      if (this._shouldSkip(file)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      let match;

      while ((match = requireRegex.exec(content)) !== null) {
        const target = match[1];
        // Skip Node built-ins and absolute modules
        if (!target.startsWith('.') && !target.startsWith('/')) continue;

        const resolved = target.startsWith('.')
          ? path.resolve(path.dirname(fullPath), target)
          : path.join(this._root, target);

        // Try adding .js extension
        const candidates = [resolved, resolved + '.js'];
        const exists = candidates.some(c => fs.existsSync(c));

        if (!exists) {
          errorCount++;
          findings.push({
            file,
            severity: SEVERITY.CRITICAL,
            message: `Broken require: ${file} → ${target}`,
            detail: `require('${target}') resolves to "${resolved}" which does not exist`,
            line: content.substring(0, match.index).split('\n').length,
            fix: `Either restore ${target}, inline the code, or remove the require`,
          });
        }
      }
    }

    return {
      phase: PHASE.RESOLVE,
      blocked: errorCount > 0,
      errorCount,
      warningCount: 0,
      findings,
    };
  }

  // ─── Phase 3: Declaration Analysis ─────────────────────────────────────────
  _checkDeclarations() {
    const findings = [];
    let errorCount = 0;
    let warningCount = 0;

    for (const file of this._files) {
      const fullPath = path.join(this._root, file);
      if (!fs.existsSync(fullPath)) continue;
      if (this._shouldSkip(file)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Check 1: Duplicate const/let/function declarations (top-level only)
      // Only check declarations at column 0 (no indentation), which catches
      // merge errors like duplicate requires without false positives on nested scopes.
      const declared = new Map(); // name → { line, kind }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Only match top-level declarations (starts at column 0, no indentation)
        if (line.startsWith('const ') || line.startsWith('let ') || line.startsWith('var ')) {
          const match = line.match(/^(?:const|let|var)\s+(\w+)/);
          if (match) {
            const name = match[1];
            if (declared.has(name)) {
              const prev = declared.get(name);
              errorCount++;
              findings.push({
                file,
                severity: SEVERITY.HIGH,
                message: `Duplicate declaration: "${name}" declared at line ${i + 1} and line ${prev.line}`,
                detail: `Previously declared at line ${prev.line}`,
                line: i + 1,
                fix: `Remove one of the duplicate declarations for "${name}"`,
              });
            } else {
              declared.set(name, { line: i + 1, kind: 'variable' });
            }
          }
        }
        // Also catch top-level function declarations
        if (line.startsWith('function ')) {
          const funcMatch = line.match(/^function\s+(\w+)/);
          if (funcMatch) {
            const name = funcMatch[1];
            if (declared.has(name)) {
              const prev = declared.get(name);
              errorCount++;
              findings.push({
                file,
                severity: SEVERITY.HIGH,
                message: `Duplicate declaration: function "${name}" conflicts with declaration at line ${prev.line}`,
                detail: `Previously declared as ${prev.kind} at line ${prev.line}`,
                line: i + 1,
                fix: `Remove or rename one of the conflicting declarations for "${name}"`,
              });
            } else {
              declared.set(name, { line: i + 1, kind: 'function' });
            }
          }
        }
      }

      // Check 2: Merged require statements on same line
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Pattern: require(A);require(B) — no newline between requires
        if (line.includes('require(\'') && line.includes(');require(\'')) {
          warningCount++;
          findings.push({
            file,
            severity: SEVERITY.LOW,
            message: `Merged requires on line ${i + 1}`,
            detail: 'Multiple require() calls on the same line',
            line: i + 1,
            fix: 'Split require() calls onto separate lines',
          });
        }
      }
    }

    return {
      phase: PHASE.DECLARE,
      blocked: errorCount > 0,
      errorCount,
      warningCount,
      findings,
    };
  }

  // ─── Phase 4: Consumer Check ────────────────────────────────────────────────
  _checkConsumers() {
    const findings = [];
    let warningCount = 0;

    for (const file of this._files) {
      const fullPath = path.join(this._root, file);
      if (!fs.existsSync(fullPath)) continue;
      if (this._shouldSkip(file)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Find module.exports entries
      const exportsMatch = content.match(/module\.exports\s*=\s*\{([^}]*)\}/s);
      if (!exportsMatch) continue;

      const exportNames = exportsMatch[1]
        .split(',')
        .map(s => s.trim().split(':')[0].trim())
        .filter(Boolean);

      const fileName = path.basename(file);

      for (const name of exportNames) {
        // Search for references outside this file
        const grepResult = this._grepForSymbol(name, fileName);
        if (grepResult.found) {
          // Check if only self-reference
          const externalRefs = grepResult.files.filter(f => f !== file);
          if (externalRefs.length === 0) {
            warningCount++;
            findings.push({
              file,
              severity: SEVERITY.MEDIUM,
              message: `Orphaned export: "${name}" in ${fileName} has no external consumers`,
              detail: `"${name}" is exported but only referenced inside ${fileName}`,
              fix: `Either remove from module.exports or add a consumer`,
            });
          }
        }
      }
    }

    return {
      phase: PHASE.CONSUME,
      blocked: false, // Warning only
      errorCount: 0,
      warningCount,
      findings,
    };
  }

  // ─── Phase 5: Framework Compliance ──────────────────────────────────────────
  _checkFramework() {
    const findings = [];
    let warningCount = 0;

    for (const file of this._files) {
      const fullPath = path.join(this._root, file);
      if (!fs.existsSync(fullPath)) continue;
      if (this._shouldSkip(file)) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lineCount = content.split('\n').length;

      if (lineCount > this._cfg.fileSizeLimit) {
        warningCount++;
        findings.push({
          file,
          severity: SEVERITY.LOW,
          message: `File too large: ${file} has ${lineCount} lines (limit: ${this._cfg.fileSizeLimit})`,
          detail: `ADR-41: files should be under ${this._cfg.fileSizeLimit} effective lines`,
          fix: `Consider extracting sub-modules from ${file}`,
        });
      }
    }

    return {
      phase: PHASE.FRAMEWORK,
      blocked: false, // Warning only
      errorCount: 0,
      warningCount,
      findings,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _shouldRun(phase) { return true; }

  _isBlocking(phase) { return this._cfg.blockingPhases.includes(phase); }

  _shouldSkip(file) {
    const basename = path.basename(file);
    return this._cfg.skipPatterns.some(p => basename.endsWith(p.replace('*', '')));
  }

  _grepForSymbol(symbol, excludeFile) {
    const foundFiles = [];
    try {
      const result = execSync(`grep -rl "${symbol}" "${this._root}/workflow" 2>/dev/null || echo ""`, {
        encoding: 'utf-8', timeout: 3000,
      });
      foundFiles.push(...result.trim().split('\n').filter(Boolean));
    } catch (_) { /* non-fatal */ }
    return { found: foundFiles.length > 0, files: foundFiles };
  }

  _reportPhase(phaseResult) {
    const { phase, errorCount, warningCount, findings } = phaseResult;
    const icon = errorCount > 0 ? '❌' : (warningCount > 0 ? '⚠️' : '✅');
    this._log(`  ${icon} Phase ${phase}: ${errorCount} error(s), ${warningCount} warning(s)`);
    for (const f of findings.slice(0, 5)) {
      this._log(`    [${f.severity}] ${f.message}`);
    }
    if (findings.length > 5) {
      this._log(`    ... and ${findings.length - 5} more`);
    }
  }

  _buildResult(blocked, summary) {
    return {
      passed: !blocked,
      blocked,
      summary,
      phases: this._phaseResults,
      timestamp: new Date().toISOString(),
      filesChecked: this._files.length,
    };
  }

  _log(msg) { if (this._verbose) console.log(msg); }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  PostCodeQualityGuard,
  PHASE,
  SEVERITY,
  DEFAULT_CONFIG,
};
