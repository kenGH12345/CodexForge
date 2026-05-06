/**
 * Skill Discovery — Auto-discover project conventions from code artifacts
 *
 * Solves the cold-start problem: when an Agent enters a new project with zero
 * experience records and no project-specific skills, it has no knowledge of
 * the project's conventions, patterns, or toolchain.
 *
 * Architecture:
 *   1. Rule Scanner (zero LLM calls): scans well-known config files
 *      (AGENTS.md, .eslintrc, package.json, tsconfig.json, Makefile, etc.)
 *      and extracts structured convention signals.
 *   2. LLM Refiner (1 LLM call, ~2000 tokens): consolidates extracted signals
 *      into a coherent project-standards skill document.
 *   3. Skill Registration: registers the generated skill via SkillEvolutionEngine
 *      so it participates in the normal skill lifecycle (injection, evolution, QualityGate).
 *
 * Storage: project-specific skills are stored in <projectRoot>/.workflow/skills/
 * (NOT in workflow/skills/) to maintain workflow generality. The SkillEvolutionEngine
 * registry records the custom filePath, and ContextLoader resolves it via registry
 * fallback when the skill is not found in the standard skillsDir.
 *
 * Trigger: runs once during _initWorkflow() when no project-specific standards
 * skill exists yet (cold-start detection).
 *
 * Design principles:
 *   - ADR-37 IDE-First: no external model dependencies; uses the existing llmCall
 *   - Zero new dependencies: only Node.js built-ins (fs, path)
 *   - Non-fatal: all errors are caught and logged; never blocks workflow init
 *   - Idempotent: skips if standards skill already exists with real content
 *
 * @module workflow/core/skill-discovery
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');
const UnifiedSkillComposer = require('./unified-skill-composer');

// ─── Scanner Definitions ──────────────────────────────────────────────────────

/**
 * Each scanner targets a specific config file / artifact and extracts
 * structured convention signals. Scanners are pure functions with zero
 * side effects — they read files and return data.
 *
 * @typedef {object} ConventionSignal
 * @property {string} source   - Which file/artifact produced this signal
 * @property {string} category - 'coding-style' | 'naming' | 'structure' | 'toolchain' | 'testing' | 'git' | 'general'
 * @property {string} signal   - Human-readable convention description
 */

const SCANNERS = [

  // ── 1. AGENTS.md — project-level instructions ──────────────────────────────
  {
    id: 'agents-md',
    files: ['AGENTS.md', 'agents.md'],
    scan(content, _filePath) {
      const signals = [];
      // Extract lines containing strong directives (MUST, NEVER, ALWAYS, DO NOT)
      // Only capture lines that are list items or blockquotes (likely intentional rules)
      const rulePatterns = /^[\s>]*[-*]\s+.*\b(MUST(?:\s+NOT)?|NEVER|ALWAYS|DO NOT)\b.+/gm;
      let m;
      const seen = new Set();
      while ((m = rulePatterns.exec(content)) !== null) {
        const rule = m[0].replace(/^[\s>]*[-*]\s+/, '').trim();
        // Skip very short or very long matches (noise)
        if (rule.length < 15 || rule.length > 200) continue;
        // Deduplicate
        const key = rule.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({ source: 'AGENTS.md', category: 'general', signal: rule });
        if (signals.length >= 6) break; // Cap to avoid noise
      }
      // Extract project structure hints (code blocks with directory trees)
      if (/```[\s\S]*?├──[\s\S]*?```/.test(content)) {
        signals.push({ source: 'AGENTS.md', category: 'structure', signal: 'Project has documented directory structure in AGENTS.md' });
      }
      return signals;
    },
  },

  // ── 2. package.json — Node.js conventions ──────────────────────────────────
  {
    id: 'package-json',
    files: ['package.json'],
    scan(content, _filePath) {
      const signals = [];
      try {
        const pkg = JSON.parse(content);
        // Scripts reveal toolchain conventions
        if (pkg.scripts) {
          const scripts = Object.entries(pkg.scripts);
          for (const [name, cmd] of scripts.slice(0, 10)) {
            if (['test', 'lint', 'build', 'start', 'dev', 'format', 'typecheck'].includes(name)) {
              signals.push({ source: 'package.json', category: 'toolchain', signal: `npm script "${name}": ${cmd}` });
            }
          }
        }
        // Engine constraints
        if (pkg.engines) {
          for (const [engine, version] of Object.entries(pkg.engines)) {
            signals.push({ source: 'package.json', category: 'toolchain', signal: `Engine constraint: ${engine} ${version}` });
          }
        }
        // Type field
        if (pkg.type === 'module') {
          signals.push({ source: 'package.json', category: 'coding-style', signal: 'Project uses ES Modules (type: "module")' });
        }
      } catch { /* not valid JSON — skip */ }
      return signals;
    },
  },

  // ── 3. ESLint config — coding style ────────────────────────────────────────
  {
    id: 'eslint',
    files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'],
    scan(content, filePath) {
      const signals = [];
      const ext = path.extname(filePath);
      signals.push({ source: path.basename(filePath), category: 'coding-style', signal: `ESLint is configured (${path.basename(filePath)})` });
      // Detect popular presets
      const presets = ['airbnb', 'standard', 'google', 'prettier', 'eslint:recommended', 'plugin:react', 'plugin:vue', 'plugin:@typescript-eslint'];
      for (const preset of presets) {
        if (content.includes(preset)) {
          signals.push({ source: path.basename(filePath), category: 'coding-style', signal: `ESLint extends: ${preset}` });
        }
      }
      return signals;
    },
  },

  // ── 4. Prettier config — formatting ────────────────────────────────────────
  {
    id: 'prettier',
    files: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs'],
    scan(content, filePath) {
      const signals = [];
      signals.push({ source: path.basename(filePath), category: 'coding-style', signal: 'Prettier is configured for code formatting' });
      // Try to extract key settings
      try {
        const cfg = JSON.parse(content);
        if (cfg.semi !== undefined) signals.push({ source: 'prettier', category: 'coding-style', signal: `Semicolons: ${cfg.semi ? 'required' : 'omitted'}` });
        if (cfg.singleQuote !== undefined) signals.push({ source: 'prettier', category: 'coding-style', signal: `Quotes: ${cfg.singleQuote ? 'single' : 'double'}` });
        if (cfg.tabWidth) signals.push({ source: 'prettier', category: 'coding-style', signal: `Tab width: ${cfg.tabWidth}` });
        if (cfg.trailingComma) signals.push({ source: 'prettier', category: 'coding-style', signal: `Trailing commas: ${cfg.trailingComma}` });
      } catch { /* not JSON — might be JS/YAML, just note it exists */ }
      return signals;
    },
  },

  // ── 5. TypeScript config — type system ─────────────────────────────────────
  {
    id: 'tsconfig',
    files: ['tsconfig.json', 'tsconfig.base.json'],
    scan(content, _filePath) {
      const signals = [];
      try {
        // tsconfig may have comments — strip them for JSON.parse
        const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(stripped);
        const co = cfg.compilerOptions || {};
        if (co.strict) signals.push({ source: 'tsconfig.json', category: 'coding-style', signal: 'TypeScript strict mode enabled' });
        if (co.target) signals.push({ source: 'tsconfig.json', category: 'toolchain', signal: `TypeScript target: ${co.target}` });
        if (co.module) signals.push({ source: 'tsconfig.json', category: 'toolchain', signal: `TypeScript module system: ${co.module}` });
        if (co.paths) signals.push({ source: 'tsconfig.json', category: 'structure', signal: `TypeScript path aliases configured (${Object.keys(co.paths).length} aliases)` });
      } catch { /* parse error — skip */ }
      return signals;
    },
  },

  // ── 6. Docker / Containerization ───────────────────────────────────────────
  {
    id: 'docker',
    files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      signals.push({ source: name, category: 'toolchain', signal: `Docker is used (${name} present)` });
      // Extract base image from Dockerfile
      if (name === 'Dockerfile') {
        const fromMatch = content.match(/^FROM\s+(\S+)/mi);
        if (fromMatch) {
          signals.push({ source: 'Dockerfile', category: 'toolchain', signal: `Docker base image: ${fromMatch[1]}` });
        }
      }
      return signals;
    },
  },

  // ── 7. Makefile / build system ─────────────────────────────────────────────
  {
    id: 'makefile',
    files: ['Makefile', 'makefile'],
    scan(content, _filePath) {
      const signals = [];
      signals.push({ source: 'Makefile', category: 'toolchain', signal: 'Make is used as build system' });
      // Extract target names (lines matching "target:")
      const targets = [];
      const targetRe = /^([a-zA-Z_][\w-]*)\s*:/gm;
      let m;
      while ((m = targetRe.exec(content)) !== null && targets.length < 8) {
        if (!m[1].startsWith('.')) targets.push(m[1]);
      }
      if (targets.length > 0) {
        signals.push({ source: 'Makefile', category: 'toolchain', signal: `Make targets: ${targets.join(', ')}` });
      }
      return signals;
    },
  },

  // ── 8. Go module ───────────────────────────────────────────────────────────
  {
    id: 'go-mod',
    files: ['go.mod'],
    scan(content, _filePath) {
      const signals = [];
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      if (moduleMatch) {
        signals.push({ source: 'go.mod', category: 'structure', signal: `Go module: ${moduleMatch[1]}` });
      }
      const goMatch = content.match(/^go\s+(\S+)/m);
      if (goMatch) {
        signals.push({ source: 'go.mod', category: 'toolchain', signal: `Go version: ${goMatch[1]}` });
      }
      return signals;
    },
  },

  // ── 9. Rust Cargo ──────────────────────────────────────────────────────────
  {
    id: 'cargo',
    files: ['Cargo.toml'],
    scan(content, _filePath) {
      const signals = [];
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) {
        signals.push({ source: 'Cargo.toml', category: 'structure', signal: `Rust crate: ${nameMatch[1]}` });
      }
      const editionMatch = content.match(/^edition\s*=\s*"([^"]+)"/m);
      if (editionMatch) {
        signals.push({ source: 'Cargo.toml', category: 'toolchain', signal: `Rust edition: ${editionMatch[1]}` });
      }
      return signals;
    },
  },

  // ── 10. Git conventions ────────────────────────────────────────────────────
  {
    id: 'git-conventions',
    files: ['.commitlintrc', '.commitlintrc.json', '.commitlintrc.js', 'commitlint.config.js', '.husky/commit-msg'],
    scan(content, filePath) {
      const signals = [];
      signals.push({ source: path.basename(filePath), category: 'git', signal: 'Commit message linting is configured (conventional commits likely enforced)' });
      if (content.includes('conventional')) {
        signals.push({ source: path.basename(filePath), category: 'git', signal: 'Conventional Commits standard is enforced' });
      }
      return signals;
    },
  },

  // ── 11. CI/CD config ───────────────────────────────────────────────────────
  {
    id: 'ci',
    files: ['.github/workflows/ci.yml', '.github/workflows/ci.yaml', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      if (filePath.includes('.github')) {
        signals.push({ source: name, category: 'toolchain', signal: 'GitHub Actions CI/CD is configured' });
      } else if (filePath.includes('.gitlab')) {
        signals.push({ source: name, category: 'toolchain', signal: 'GitLab CI/CD is configured' });
      } else if (name === 'Jenkinsfile') {
        signals.push({ source: name, category: 'toolchain', signal: 'Jenkins CI/CD is configured' });
      }
      return signals;
    },
  },

  // ── 12. Testing config ─────────────────────────────────────────────────────
  {
    id: 'testing',
    files: ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js', 'pytest.ini', 'pyproject.toml', '.mocharc.yml', '.mocharc.json'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      if (name.startsWith('jest')) {
        signals.push({ source: name, category: 'testing', signal: 'Jest is the test framework' });
      } else if (name.startsWith('vitest')) {
        signals.push({ source: name, category: 'testing', signal: 'Vitest is the test framework' });
      } else if (name.startsWith('.mocharc')) {
        signals.push({ source: name, category: 'testing', signal: 'Mocha is the test framework' });
      } else if (name === 'pytest.ini' || (name === 'pyproject.toml' && content.includes('[tool.pytest'))) {
        signals.push({ source: name, category: 'testing', signal: 'Pytest is the test framework' });
      }
      return signals;
    },
  },
];

// ─── Core Discovery Logic ─────────────────────────────────────────────────────

/**
 * Runs all rule-based scanners against the project root.
 * Zero LLM calls — pure file I/O + regex.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {ConventionSignal[]} Array of discovered convention signals
 */
function scanProjectConventions(projectRoot) {
  const allSignals = [];

  for (const scanner of SCANNERS) {
    for (const relFile of scanner.files) {
      const fullPath = path.join(projectRoot, relFile);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.trim()) continue;
        const signals = scanner.scan(content, fullPath);
        allSignals.push(...signals);
      } catch {
        // Non-fatal: skip unreadable files
      }
    }
  }

  // ── Bonus: scan top-level directory structure ──────────────────────────────
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'output', '__pycache__', 'target', 'vendor'].includes(e.name))
      .map(e => e.name)
      .slice(0, 15);
    if (dirs.length > 0) {
      allSignals.push({
        source: 'directory-scan',
        category: 'structure',
        signal: `Top-level directories: ${dirs.join(', ')}`,
      });
    }
  } catch { /* non-fatal */ }

  // ── Deduplicate signals by content ─────────────────────────────────────────
  const seen = new Set();
  return allSignals.filter(s => {
    const key = `${s.category}:${s.signal.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Scans source code files for architecture and convention patterns.
 * Uses lightweight regex heuristics — no AST parsing, no dependencies.
 *
 * Design rationale: AST parsing would need external deps (babel, ts-parser)
 * and is overkill for signal extraction. Regex heuristics at 80%+ accuracy
 * with zero dependencies aligns with ADR-37 (IDE-First) and keeps startup fast.
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {number} [options.maxFiles=200]
 * @param {number} [options.maxDepth=4]
 * @param {number} [options.maxReadBytes=8000]
 * @returns {ConventionSignal[]}
 */
function scanSourceCodeSignals(projectRoot, options = {}) {
  const { scanSourceFiles } = require('./file-scanner');

  const sourceExts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rs', '.java', '.kt', '.scala', '.php', '.rb',
    '.cs', '.lua'];

  const files = scanSourceFiles(projectRoot, {
    extensions: sourceExts,
    ignoreDirs: ['node_modules', 'dist', 'build', 'output', '.next', '.nuxt',
      'coverage', '__tests__', '__pycache__', 'vendor', '.git', 'public', 'static'],
    maxFiles: options.maxFiles || 200,
    maxDepth: options.maxDepth || 4,
  });

  if (files.length === 0) return [];

  const stats = {
    filesScanned: files.length,
    languages: new Map(),
    topLevelDirs: new Set(),
    defaultExports: 0,
    namedExports: 0,
    classCount: 0,
    interfaceCount: 0,
    typeAliasCount: 0,
    enumCount: 0,
    asyncCount: 0,
    arrowFuncCount: 0,
    regularFuncCount: 0,
    tryCatchCount: 0,
    throwCount: 0,
    extendsCount: 0,
    implementsCount: 0,
    constCount: 0,
    asConstCount: 0,
    readonlyCount: 0,
    relativeImportCount: 0,
    aliasImportCount: 0,
    namingStyles: { camelCase: 0, PascalCase: 0, kebabCase: 0, snakeCase: 0, other: 0 },
    patternMarkers: {
      registry: 0,
      factory: 0,
      observer: 0,
      strategy: 0,
      singleton: 0,
      decorator: 0,
      middleware: 0,
      plugin: 0,
    },
    filePatterns: new Map(),
    importGraph: new Map(),
  };

  const MAX_READ = options.maxReadBytes || 8000;

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8').slice(0, MAX_READ);
    } catch { continue; }

    const rel = path.relative(projectRoot, filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const dirName = path.dirname(rel).split(path.sep)[0];

    stats.languages.set(ext, (stats.languages.get(ext) || 0) + 1);
    if (dirName && !dirName.startsWith('.')) stats.topLevelDirs.add(dirName);

    // File naming convention
    if (/^[a-z][a-zA-Z0-9]*$/.test(baseName)) stats.namingStyles.camelCase++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(baseName)) stats.namingStyles.PascalCase++;
    else if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(baseName)) stats.namingStyles.kebabCase++;
    else if (/^[a-z0-9]+(_[a-z0-9]+)*$/.test(baseName)) stats.namingStyles.snakeCase++;
    else stats.namingStyles.other++;

    // Export patterns
    const exportDefaultRe = /\bexport\s+default\b/g;
    const exportNamedRe = /\bexport\s+(?!default)(?:const|let|var|function|class|interface|type|enum|async\s+function)\b/g;
    stats.defaultExports += (content.match(exportDefaultRe) || []).length;
    stats.namedExports += (content.match(exportNamedRe) || []).length;

    // Type system patterns (TypeScript / Flow / Python type hints)
    stats.interfaceCount += (content.match(/\binterface\s+\w+/g) || []).length;
    stats.typeAliasCount += (content.match(/\btype\s+\w+\s*=/g) || []).length;
    stats.enumCount += (content.match(/\benum\s+\w+/g) || []).length;

    // Class patterns
    stats.classCount += (content.match(/\bclass\s+\w+/g) || []).length;
    stats.extendsCount += (content.match(/\bextends\s+\w+/g) || []).length;
    stats.implementsCount += (content.match(/\bimplements\s+[\w,\s]+/g) || []).length;

    // Function patterns
    stats.asyncCount += (content.match(/\basync\s+(?:function\s*\w*|\(|\w+\s*=>)/g) || []).length;
    stats.arrowFuncCount += (content.match(/\)\s*=>|\w+\s*=>/g) || []).length;
    stats.regularFuncCount += (content.match(/\bfunction\s+\w+\s*\(/g) || []).length;

    // Error handling
    stats.tryCatchCount += (content.match(/\btry\s*\{/g) || []).length;
    stats.throwCount += (content.match(/\bthrow\s+(?:new\s+)?\w+/g) || []).length;

    // Constants & immutability
    stats.constCount += (content.match(/\bconst\s+\w+/g) || []).length;
    stats.asConstCount += (content.match(/\bas\s+const\b/g) || []).length;
    stats.readonlyCount += (content.match(/\breadonly\b/g) || []).length;

    // Import style
    stats.relativeImportCount += (content.match(/^\s*import\s+.*?\s+from\s+['"]\.\.?\//gm) || []).length;
    stats.aliasImportCount += (content.match(/^\s*import\s+.*?\s+from\s+['"][^.']/gm) || []).length;

    // Build import graph: which files import/require which
    const fileImports = extractFileImports(content, rel);
    if (fileImports.length > 0) {
      stats.importGraph.set(rel, fileImports);
    }
    // Architecture pattern heuristics
    if (/\bregistry\b|\bRegistry\b/.test(content)) stats.patternMarkers.registry++;
    if (/\bfactory\b|\bFactory\b/.test(content)) stats.patternMarkers.factory++;
    if (/\bevent\s*\.\s*on\s*\(|\.addEventListener\(|\.on\s*\(|\.emit\s*\(/.test(content)) stats.patternMarkers.observer++;
    if (/\bstrategy\b|\bStrategy\b/.test(content)) stats.patternMarkers.strategy++;
    if (/\bsingleton\b|\bSingleton\b|new\s+\w+Engine\(\)|new\s+\w+Service\(\)/.test(content)) stats.patternMarkers.singleton++;
    if (/\bdecorator\b|\bDecorator\b|@\w+/.test(content)) stats.patternMarkers.decorator++;
    if (/\bmiddleware\b|\bMiddleware\b/.test(content)) stats.patternMarkers.middleware++;
    if (/\bplugin\b|\bPlugin\b/.test(content)) stats.patternMarkers.plugin++;

    // File-level pattern tags (e.g. "controller", "service", "model")
    const fileRole = detectFileRole(rel, content);
    if (fileRole) {
      stats.filePatterns.set(fileRole, (stats.filePatterns.get(fileRole) || 0) + 1);
    }
  }

  // Convert stats into ConventionSignal[]
  const signals = [];

  // 1. Language & scale
  const langEntries = Array.from(stats.languages.entries()).sort((a, b) => b[1] - a[1]);
  if (langEntries.length > 0) {
    signals.push({
      source: 'code-scan',
      category: 'toolchain',
      signal: `Primary languages: ${langEntries.map(([e, c]) => `${e.replace(/^\./, '')}(${c})`).join(', ')}`,
    });
  }

  // 2. Directory structure
  const dirs = Array.from(stats.topLevelDirs).sort();
  if (dirs.length > 0) {
    signals.push({
      source: 'code-scan',
      category: 'structure',
      signal: `Source directory organization: ${dirs.slice(0, 12).join('/, ')}${dirs.length > 12 ? '/ ...' : '/'}`,
    });
  }

  // 3. Export pattern
  const totalExports = stats.defaultExports + stats.namedExports;
  if (totalExports > 0) {
    const defaultRatio = Math.round((stats.defaultExports / totalExports) * 100);
    signals.push({
      source: 'code-scan',
      category: 'coding-style',
      signal: `Export pattern: ~${defaultRatio}% default exports, ~${100 - defaultRatio}% named exports (${totalExports} total)`,
    });
  }

  // 4. Type system
  const hasTypes = stats.interfaceCount > 0 || stats.typeAliasCount > 0 || stats.enumCount > 0;
  if (hasTypes) {
    signals.push({
      source: 'code-scan',
      category: 'coding-style',
      signal: `Type system usage: ${stats.interfaceCount} interfaces, ${stats.typeAliasCount} type aliases, ${stats.enumCount} enums`,
    });
  }

  // 5. Class architecture
  if (stats.classCount > 0) {
    signals.push({
      source: 'code-scan',
      category: 'architecture',
      signal: `Class-based architecture: ${stats.classCount} classes, ${stats.extendsCount} inheritance relationships, ${stats.implementsCount} interface implementations`,
    });
  }

  // 6. Async & function style
  if (stats.asyncCount > 0 || stats.arrowFuncCount > 0) {
    signals.push({
      source: 'code-scan',
      category: 'coding-style',
      signal: `Async/functional patterns: ${stats.asyncCount} async operations, ${stats.arrowFuncCount} arrow functions, ${stats.regularFuncCount} regular functions`,
    });
  }

  // 7. Error handling
  if (stats.tryCatchCount > 0 || stats.throwCount > 0) {
    signals.push({
      source: 'code-scan',
      category: 'coding-style',
      signal: `Error handling: ${stats.tryCatchCount} try/catch blocks, ${stats.throwCount} throw statements`,
    });
  }

  // 8. Naming conventions
  const namingTotal = Object.values(stats.namingStyles).reduce((a, b) => a + b, 0);
  if (namingTotal > 0) {
    const dominant = Object.entries(stats.namingStyles)
      .sort((a, b) => b[1] - a[1])[0];
    signals.push({
      source: 'code-scan',
      category: 'naming',
      signal: `File naming convention: dominant style is ${dominant[0]} (${Math.round((dominant[1] / namingTotal) * 100)}%)`,
    });
  }

  // 9. Immutability signals
  if (stats.asConstCount > 0 || stats.readonlyCount > 0) {
    signals.push({
      source: 'code-scan',
      category: 'coding-style',
      signal: `Immutability patterns: ${stats.asConstCount} \`as const\` assertions, ${stats.readonlyCount} readonly modifiers`,
    });
  }

  // 10. Import style
  const totalImports = stats.relativeImportCount + stats.aliasImportCount;
  if (totalImports > 0) {
    signals.push({
      source: 'code-scan',
      category: 'structure',
      signal: `Import style: ${stats.relativeImportCount} relative imports, ${stats.aliasImportCount} alias/absolute imports`,
    });
  }

  // 11. Detected architecture patterns
  const detectedPatterns = Object.entries(stats.patternMarkers)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (detectedPatterns.length > 0) {
    signals.push({
      source: 'code-scan',
      category: 'patterns',
      signal: `Detected architecture patterns: ${detectedPatterns.map(([p, c]) => `${p}(${c} files)`).join(', ')}`,
    });
  }

  // 12. File role distribution
  const roles = Array.from(stats.filePatterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (roles.length > 0) {
    signals.push({
      source: 'code-scan',
      category: 'structure',
      signal: `File role distribution: ${roles.map(([r, c]) => `${r}(${c})`).join(', ')}`,
    });
  }

  // 13. Import graph
  if (stats.importGraph.size > 0) {
    const totalImportEdges = Array.from(stats.importGraph.values())
      .reduce((sum, arr) => sum + arr.length, 0);
    const avgDepsPerFile = Math.round(totalImportEdges / stats.importGraph.size);
    signals.push({
      source: 'code-scan',
      category: 'dependencies',
      signal: `Import graph: ${stats.importGraph.size} files with imports, avg ${avgDepsPerFile} deps/file (${totalImportEdges} total edges)`,
      meta: { importGraph: Object.fromEntries(stats.importGraph) },
    });
  }

  return signals;

  /**
   * Extracts import/require paths from file content, excluding comments.
   * @param {string} content — file source
   * @param {string} currentFile — relative path of current file
   * @returns {string[]} list of import targets
   */
  function extractFileImports(content, currentFile) {
    let codeOnly = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '');

    const imports = [];
    const importReESM = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"];?/g;
    const importReCJS = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    let m;
    while ((m = importReESM.exec(codeOnly)) !== null) {
      const target = m[1];
      if (
        target.startsWith('.') &&
        !target.includes(currentFile.replace(/\\/g, '/'))
      ) {
        imports.push(target);
      }
    }
    while ((m = importReCJS.exec(codeOnly)) !== null) {
      const target = m[1];
      if (
        target.startsWith('.') &&
        !target.includes(currentFile.replace(/\\/g, '/'))
      ) {
        imports.push(target);
      }
    }

    return [...new Set(imports)];
  }

  /**
   * Detects the semantic role of a source file from path + content heuristics.
   */
  function detectFileRole(relativePath, content) {
    const lower = relativePath.toLowerCase();
    if (/test|spec|\.test\.|\.spec\./.test(lower)) return 'test';
    if (lower.includes('controller') || lower.includes('route')) return 'controller/route';
    if (lower.includes('service') || lower.includes('provider')) return 'service';
    if (lower.includes('model') || lower.includes('schema')) return 'model/schema';
    if (lower.includes('component') || lower.includes('widget')) return 'component';
    if (lower.includes('hook') || lower.includes('use')) return 'hook';
    if (lower.includes('util') || lower.includes('helper')) return 'utility';
    if (lower.includes('engine') || lower.includes('processor')) return 'engine/processor';
    if (lower.includes('interface') || lower.includes('type')) return 'type-definition';
    if (lower.includes('config') || lower.includes('setting')) return 'config';
    if (/\bclass\s+\w+Engine\b/.test(content)) return 'engine';
    if (/\binterface\s+I\w+\b/.test(content)) return 'interface';
    return null;
  }
}

/**
 * Formats discovered signals into a structured summary for LLM refinement.
 *
 * @param {ConventionSignal[]} signals
 * @returns {string} Formatted summary text
 */
function formatSignalsForLLM(signals) {
  if (signals.length === 0) return '';

  // Group by category
  const grouped = {};
  for (const s of signals) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }

  const lines = ['# Discovered Project Conventions', ''];
  for (const [category, items] of Object.entries(grouped)) {
    lines.push(`## ${category}`);
    for (const item of items) {
      lines.push(`- [${item.source}] ${item.signal}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Builds the LLM prompt for refining raw signals into a standards skill.
 *
 * @param {string} signalsSummary - Output of formatSignalsForLLM()
 * @returns {string} LLM prompt
 */
function buildRefinementPrompt(signalsSummary) {
  return `You are a senior software engineer analyzing a project's conventions.

Below are raw convention signals extracted from the project's configuration files.
Your task: synthesize these into a concise, actionable "Project Standards" document.

${signalsSummary}

Output a Markdown document with EXACTLY these sections (keep each section concise, 3-8 bullet points max):

## Coding Standards
<!-- Language-specific coding rules enforced in this project -->

## Naming Conventions
<!-- File, variable, function, class naming patterns -->

## Directory Structure
<!-- Where different types of files live -->

## Toolchain
<!-- Build tools, linters, formatters, test frameworks, CI/CD -->

## Commit Conventions
<!-- Git commit message format, branch naming if detectable -->

Rules:
- Only include conventions you can CONFIDENTLY infer from the signals above
- Do NOT invent conventions that aren't supported by the signals
- Use imperative voice ("Use X", "Always Y", "Never Z")
- Keep total output under 1500 characters
- If a section has no signals, write "_No conventions detected._"`;
}

/**
 * Main entry point: discovers project conventions and generates a standards skill.
 *
 * @param {object} options
 * @param {string}   options.projectRoot     - Absolute path to project root
 * @param {object}   options.skillEvolution  - SkillEvolutionEngine instance
 * @param {Function} [options.llmCall]       - LLM call function (fallback; used when cheapLlmCall is not available)
 * @param {Function} [options.cheapLlmCall]  - Cheap LLM call function (preferred; GPT-4o-mini / Gemini Flash tier)
 * @param {boolean}  [options.force=false]   - Force re-discovery even if skill exists
 * @returns {Promise<{ discovered: boolean, signalCount: number, skillName: string|null, usedLLM: boolean }>}
 */
async function discoverProjectSkills({ projectRoot, skillEvolution, llmCall = null, cheapLlmCall = null, force = false, skillName = 'project-standards' }) {
  const SKILL_NAME = skillName;
  const result = { discovered: false, signalCount: 0, skillName: null, usedLLM: false };

  // ── Resolve project-local skill directory ──────────────────────────────────
  // Project-specific skills live in <projectRoot>/.workflow/skills/ to keep
  // the workflow/ directory generic and project-agnostic.
  const projectSkillsDir = path.join(projectRoot, '.workflow', 'skills');
  const projectSkillPath = path.join(projectSkillsDir, `${SKILL_NAME}.md`);

  // ── Guard: skip if skill already exists with real content ──────────────────
  if (!force) {
    // Check both registry and project-local file
    const existingPath = skillEvolution.registry.has(SKILL_NAME)
      ? skillEvolution.registry.get(SKILL_NAME).filePath
      : (fs.existsSync(projectSkillPath) ? projectSkillPath : null);

    if (existingPath && fs.existsSync(existingPath)) {
      const content = fs.readFileSync(existingPath, 'utf-8');
      // Check if it has real content (not just placeholder or mock)
      const realLines = content.split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---') && !l.startsWith('|') && !l.startsWith('<!--'))
        .filter(l => !l.includes('_No ') && !l.includes('defined yet'))
        .filter(l => l.trim().length > 3);
      const mockPatterns = [
        /\[Mock/i, /placeholder/i, /stub/i,
        /TODO[:\s]+generate/i, /configure\s+llmCall/i, /LLM_SKIPPED/i,
      ];
      const isMock = mockPatterns.some(p => p.test(content));
      if (realLines.length >= 10 && !isMock) {
        console.log(`[SkillDiscovery] ⏭️  Skill "${SKILL_NAME}" already exists with content (${realLines.length} lines). Skipping.`);
        return result;
      }
      if (isMock) {
        console.log(`[SkillDiscovery] ⚠️  Existing skill "${SKILL_NAME}" detected as mock/placeholder. Forcing regeneration.`);
      }
    }
  }

  // ── Step 1: Rule-based scanning (zero LLM calls) ──────────────────────────
  const signals = scanProjectConventions(projectRoot);
  result.signalCount = signals.length;

  if (signals.length === 0) {
    console.log(`[SkillDiscovery] ℹ️  No convention signals found in project. Skipping skill generation.`);
    return result;
  }

  console.log(`[SkillDiscovery] 🔍 Scanned project: ${signals.length} convention signal(s) from ${new Set(signals.map(s => s.source)).size} source(s).`);

  // ── Step 2: Generate skill content ─────────────────────────────────────────
  let skillContent;
  const signalsSummary = formatSignalsForLLM(signals);

  // Prefer cheapLlmCall (GPT-4o-mini tier, ~$0.002/call) over main llmCall (~$0.10/call)
  // for skill refinement. Falls back to llmCall if cheapLlmCall is not available.
  const effectiveLlmCall = (typeof cheapLlmCall === 'function') ? cheapLlmCall
    : (typeof llmCall === 'function') ? llmCall
    : null;
  const llmTier = (typeof cheapLlmCall === 'function') ? 'cheap' : 'main';

  if (effectiveLlmCall) {
    // LLM refinement path: 1 call, ~2000 tokens
    try {
      const prompt = buildRefinementPrompt(signalsSummary);
      const refined = await effectiveLlmCall(prepareGatewayPrompt({ _outputDir: path.join(projectRoot, 'output') }, {
        callSite: 'workflow/core/skill-discovery.js:discoverProjectStandards.refine',
        role: 'skill-discovery',
        stage: 'INIT',
        runtimePrompt: prompt,
        metadata: { category: 'injected-llm-call', signalCount: signals.length, llmTier },
      }));
      if (refined && refined.trim().length > 50) {
        skillContent = refined.trim();
        result.usedLLM = true;
        console.log(`[SkillDiscovery] 🤖 LLM refined ${signals.length} signals into standards skill (${skillContent.length} chars, tier: ${llmTier}).`);
      }
    } catch (err) {
      console.warn(`[SkillDiscovery] ⚠️  LLM refinement failed (falling back to rule-only): ${err.message}`);
    }
  }

  // Fallback: use raw signals as skill content (no LLM needed)
  if (!skillContent) {
    skillContent = _buildRuleOnlyContent(signals);
    console.log(`[SkillDiscovery] 📝 Generated rule-only standards skill (${skillContent.length} chars, no LLM used).`);
  }

  // ── Step 3: Write skill to project directory and register ──────────────────
  try {
    // Write skill file to <projectRoot>/.workflow/skills/ (NOT workflow/skills/)
    _writeDiscoveredSkill(projectSkillPath, skillContent, signals.length, result.usedLLM);

    // Generate unified project-knowledge.md (Conventions chapter only here)
    try {
      const knowledgePath = path.join(projectSkillsDir, `${SKILL_NAME}-knowledge.md`);
      const composer = new UnifiedSkillComposer(projectRoot, { tokenLimit: 1200 });
      const unified = composer.compose({
        conventions: skillContent,
        architecture: '',
        components: '',
        sources: ['skill-discovery']
      });
      fs.writeFileSync(knowledgePath, unified, 'utf-8');
      console.log(`[SkillDiscovery] ✅ Unified knowledge generated: ${knowledgePath}`);
    } catch (composeErr) {
      console.warn(`[SkillDiscovery] ⚠️  Unified knowledge generation skipped: ${composeErr.message}`);
    }

    // Register in SkillEvolutionEngine with custom filePath pointing to project dir
    skillEvolution.registerSkill({
      name: SKILL_NAME,
      description: 'Auto-discovered project conventions, coding standards, and toolchain configuration',
      domains: ['standards', 'conventions', 'project'],
      type: 'standards',
      loadLevel: 'project',
      maxTokens: 1200,
      triggers: {
        keywords: ['standard', 'convention', 'style', 'lint', 'format', 'naming', 'structure'],
        roles: ['analyst', 'architect', 'developer', 'reviewer'],
      },
      filePath: projectSkillPath,  // Custom path: project dir, not workflow/skills/
    });

    result.discovered = true;
    result.skillName = SKILL_NAME;
    console.log(`[SkillDiscovery] ✅ Project standards skill generated: ${projectSkillPath}`);
  } catch (err) {
    console.warn(`[SkillDiscovery] ⚠️  Skill registration failed (non-fatal): ${err.message}`);
  }

  return result;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Builds skill content from raw signals without LLM refinement.
 * Groups signals by category and formats as Markdown sections.
 *
 * @param {ConventionSignal[]} signals
 * @returns {string}
 */
function _buildRuleOnlyContent(signals) {
  const grouped = {};
  for (const s of signals) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }

  const categoryToSection = {
    'coding-style': 'Coding Standards',
    'naming': 'Naming Conventions',
    'structure': 'Directory Structure',
    'toolchain': 'Toolchain',
    'testing': 'Toolchain',
    'git': 'Commit Conventions',
    'general': 'Coding Standards',
  };

  const sections = {};
  for (const [category, items] of Object.entries(grouped)) {
    const sectionName = categoryToSection[category] || 'Coding Standards';
    if (!sections[sectionName]) sections[sectionName] = [];
    for (const item of items) {
      sections[sectionName].push(`- ${item.signal} _(from ${item.source})_`);
    }
  }

  const lines = [];
  const sectionOrder = ['Coding Standards', 'Naming Conventions', 'Directory Structure', 'Toolchain', 'Commit Conventions'];
  for (const name of sectionOrder) {
    lines.push(`## ${name}`);
    if (sections[name] && sections[name].length > 0) {
      lines.push(...sections[name]);
    } else {
      lines.push('_No conventions detected._');
    }
    lines.push('');
  }

  return `<!-- LLM_SKIPPED: rule-only fallback, no LLM refinement -->\n\n${lines.join('\n')}`;
}

/**
 * Writes the discovered skill content to disk, preserving YAML frontmatter.
 *
 * @param {string} filePath   - Skill file path
 * @param {string} content    - Skill body content (Markdown)
 * @param {number} signalCount - Number of signals discovered
 * @param {boolean} usedLLM   - Whether LLM refinement was used
 */
function _writeDiscoveredSkill(filePath, content, signalCount, usedLLM) {
  const frontmatter = [
    `---`,
    `name: project-standards`,
    `version: 1.0.0`,
    `type: standards`,
    `domains: [standards, conventions, project]`,
    `dependencies: []`,
    `load_level: project`,
    `max_tokens: 1200`,
    `triggers:`,
    `  keywords: [standard, convention, style, lint, format, naming, structure]`,
    `  roles: [analyst, architect, developer, reviewer]`,
    `description: "Auto-discovered project conventions, coding standards, and toolchain configuration"`,
    `auto_discovered: true`,
    `discovery_signals: ${signalCount}`,
    `discovery_method: ${usedLLM ? 'rule-scan+llm' : 'rule-scan-only'}`,
    `---`,
  ].join('\n');

  const fullContent = [
    frontmatter,
    ``,
    `# Skill: project-standards`,
    ``,
    `> **Version**: 1.0.0`,
    `> **Description**: Auto-discovered project conventions, coding standards, and toolchain configuration`,
    `> **Domains**: standards, conventions, project`,
    `> **Auto-discovered**: ✅ (${signalCount} signals, method: ${usedLLM ? 'rule-scan + LLM refinement' : 'rule-scan only'})`,
    ``,
    `---`,
    ``,
    content,
    ``,
    `## Evolution History`,
    ``,
    `| Version | Date | Change |`,
    `|---------|------|--------|`,
    `| v1.0.0 | ${new Date().toISOString().slice(0, 10)} | Auto-discovered from project config files |`,
  ].join('\n');

  // Atomic write
  const tmpPath = filePath + '.tmp';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmpPath, fullContent, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  scanProjectConventions,
  scanSourceCodeSignals,
  formatSignalsForLLM,
  discoverProjectSkills,
};
