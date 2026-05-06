/**
 * Memory Manager – Deep Context Memory Builder & Maintainer
 *
 * Responsibilities (Requirement 5):
 *  - Generate AGENTS.md: global project overview with dynamic content extraction
 *  - Maintain per-package context files for Monorepo sub-packages
 *  - Watch for code changes and auto-sync memory files
 *  - Apply differentiated strategy based on project scale
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, PROJECT_SCALE } = require('../core/constants');
const { getProjectStructure, selectToolStrategy, scanCodeSymbols } = require('../tools/thick-tools');
const { getConfig } = require('../core/config-loader');
const { buildSessionStartChecklist } = require('../core/prompt-builder');
const { renderCompactProfileSummary } = require('../core/project-profiler');
const { rebuildCache, getDistilledSummary } = require('../core/arch-knowledge-cache');

class MemoryManager {
  /**
   * @param {string} projectRoot - Root directory of the project to analyse
   */
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    this._watchHandles = [];
    // Load project config (workflow.config.js) for this projectRoot.
    // N46 fix: do NOT call clearConfigCache() here. N43 fix made getConfig(projectRoot)
    // bypass the module-level cache when projectRoot is provided, so clearConfigCache()
    // is redundant and harmful – it would wipe the cache entry written by Orchestrator
    // (or vice versa), breaking the "first caller writes, others reuse" invariant.
    this._config = getConfig(projectRoot);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Builds or refreshes the global AGENTS.md context file.
   * Strategy is chosen automatically based on project scale.
   *
   * @returns {string} Path to the written AGENTS.md
   */
  async buildGlobalContext() {
    const { strategy } = selectToolStrategy(this.projectRoot);
    console.log(`[MemoryManager] Building global context (strategy: ${strategy})...`);

    const { summary: structureSummary } = getProjectStructure(this.projectRoot, strategy === 'thick' ? 2 : 4);
    const packageList = this._detectPackages();

    const extensions = this._config.sourceExtensions || ['.js', '.ts', '.py', '.go', '.java', '.cs', '.lua', '.dart'];
    const ignoreDirs  = this._config.ignoreDirs
      || ['node_modules', '.git', 'dist', 'build', 'output'];

    const extLabel = extensions.join(', ');
    console.log(`[MemoryManager] Scanning ${extLabel} code symbols...`);
    const { summary: symbolsSummary } = scanCodeSymbols(this.projectRoot, {
      extensions,
      ignoreDirs,
      maxFiles: 80,
    });

    // P1 Enhancement: Gather dynamic project context
    console.log(`[MemoryManager] Extracting project context from source files...`);
    const projectContext = await this._extractProjectContext();

    const content = this._renderAgentsMd(structureSummary, packageList, strategy, symbolsSummary, projectContext);

    fs.writeFileSync(this.agentsMdPath, content, 'utf-8');
    console.log(`[MemoryManager] AGENTS.md written: ${this.agentsMdPath}`);

    // Trigger arch-knowledge-cache rebuild (incremental, dirty-flag based)
    try {
      rebuildCache(this.projectRoot, { projectProfile: this._config.projectProfile || null });
    } catch (err) {
      console.warn(`[MemoryManager] Could not rebuild arch-knowledge-cache: ${err.message}`);
    }

    return this.agentsMdPath;
  }

  /**
   * Builds per-package context files for each detected sub-package.
   * Used in Monorepo scenarios (Requirement 5.2).
   *
   * @returns {string[]} Paths to all written package context files
   */
  async buildPackageContexts() {
    const packages = this._detectPackages();
    if (packages.length === 0) {
      console.log(`[MemoryManager] No sub-packages detected. Skipping package context build.`);
      return [];
    }

    const writtenPaths = [];
    for (const pkg of packages) {
      const contextPath = await this._buildPackageContext(pkg);
      writtenPaths.push(contextPath);
    }
    console.log(`[MemoryManager] Built ${writtenPaths.length} package context files.`);
    return writtenPaths;
  }

  /**
   * Watches the project for file changes and auto-updates the relevant
   * memory files when changes are detected (Requirement 5.3).
   *
   * @param {number} [debounceMs=2000] - Debounce delay in milliseconds
   */
  startWatching(debounceMs = 2000) {
    console.log(`[MemoryManager] Starting file watcher on: ${this.projectRoot}`);
    let debounceTimer = null;

    const watcher = fs.watch(this.projectRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Ignore memory files themselves and common noise
      if (filename.includes('AGENTS.md') || filename.includes('node_modules') ||
          filename.includes('.git') || filename.includes('manifest.json') ||
          filename.includes('output')) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        console.log(`[MemoryManager] Change detected: ${filename}. Refreshing memory...`);
        await this._onFileChanged(filename);
      }, debounceMs);
    });

    // N69 fix: store debounceTimer reference alongside the watcher handle so
    // stopWatching() can clear it and prevent a pending timer from firing after
    // the watcher has been closed.
    this._watchHandles.push({ watcher, getTimer: () => debounceTimer, clearTimer: () => { clearTimeout(debounceTimer); debounceTimer = null; } });
    console.log(`[MemoryManager] Watcher active. Memory will auto-sync on changes.`);
  }

  /** Stops all active file watchers */
  stopWatching() {
    for (const handle of this._watchHandles) {
      // N69 fix: clear the debounce timer before closing the watcher so a pending
      // timer cannot fire _onFileChanged() after the watcher has been stopped.
      if (typeof handle.clearTimer === 'function') {
        handle.clearTimer();
        handle.watcher.close();
      } else {
        // Backward-compatible: plain watcher handle (no timer wrapper)
        handle.close();
      }
    }
    this._watchHandles = [];
    console.log(`[MemoryManager] File watchers stopped.`);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Detects sub-packages in the project.
   * Looks for directories containing a package.json (Monorepo pattern).
   *
   * @returns {Array<{name, dir, packageJsonPath}>}
   */
  _detectPackages() {
    const packages = [];
    const ignore = ['node_modules', '.git', 'dist', 'build'];

    try {
      const entries = fs.readdirSync(this.projectRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || ignore.includes(entry.name)) continue;
        const pkgJsonPath = path.join(this.projectRoot, entry.name, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          packages.push({
            name: pkgJson.name || entry.name,
            dir: path.join(this.projectRoot, entry.name),
            packageJsonPath: pkgJsonPath,
          });
        }
      }
    } catch (err) {
      console.warn(`[MemoryManager] Could not detect packages: ${err.message}`);
    }

    return packages;
  }

  /**
   * Extracts comprehensive project context from source files.
   * This includes README, API endpoints, code patterns, and documentation.
   *
   * @returns {object} Project context object
   */
  async _extractProjectContext() {
    const context = {
      projectOverview: null,
      techStackDetails: null,
      apiEndpoints: [],
      coreFeatures: [],
      documentationIndex: [],
      codeQualityObservations: [],
    };

    try {
      // 1. Extract project overview from README
      context.projectOverview = this._extractReadmeOverview();

      // 2. Extract tech stack details
      context.techStackDetails = this._extractTechStackDetails();

      // 3. Scan for API endpoints
      context.apiEndpoints = this._extractApiEndpoints();

      // 4. Extract core features from main entry points
      context.coreFeatures = this._extractCoreFeatures();

      // 5. Build documentation index
      context.documentationIndex = this._buildDocumentationIndex();

      // 6. Generate code quality observations
      context.codeQualityObservations = this._generateCodeQualityObservations();

    } catch (err) {
      console.warn(`[MemoryManager] Could not fully extract project context: ${err.message}`);
    }

    return context;
  }

  /**
   * Extracts project overview from README.md or similar files.
   *
   * @returns {object|null} Project overview data
   */
  _extractReadmeOverview() {
    const readmeCandidates = ['README.md', 'readme.md', 'Readme.md', 'README.MD'];
    let readmePath = null;

    for (const candidate of readmeCandidates) {
      const fullPath = path.join(this.projectRoot, candidate);
      if (fs.existsSync(fullPath)) {
        readmePath = fullPath;
        break;
      }
    }

    if (!readmePath) return null;

    try {
      const content = fs.readFileSync(readmePath, 'utf-8');
      const lines = content.split('\n');

      // Extract title (first h1)
      let title = null;
      let description = [];
      let foundDescription = false;

      for (let i = 0; i < lines.length && i < 50; i++) {
        const line = lines[i].trim();

        // Extract title from first h1
        if (!title && line.startsWith('# ')) {
          title = line.substring(2).trim();
          continue;
        }

        // Extract description (lines after title until next heading or blank block)
        if (title && !foundDescription) {
          if (line.startsWith('#') || line.startsWith('##')) {
            foundDescription = true;
            break;
          }
          if (line) {
            description.push(line);
          } else if (description.length > 0) {
            // Empty line after description starts
            foundDescription = true;
            break;
          }
        }
      }

      // Extract key features/badges section if present
      const keyFeatures = [];
      let inFeatureSection = false;
      for (const line of lines.slice(0, 100)) {
        if (line.match(/^##?\s*(Features|Key Features|核心功能)/i)) {
          inFeatureSection = true;
          continue;
        }
        if (inFeatureSection && line.startsWith('##')) {
          break;
        }
        if (inFeatureSection && line.trim().startsWith('-')) {
          keyFeatures.push(line.trim().substring(1).trim());
        }
      }

      return {
        title: title || path.basename(this.projectRoot),
        description: description.join(' ').trim() || 'Project description not available',
        filePath: readmePath,
        keyFeatures: keyFeatures.slice(0, 8),
      };
    } catch (err) {
      console.warn(`[MemoryManager] Could not read README: ${err.message}`);
      return null;
    }
  }

  /**
   * Extracts detailed tech stack information.
   *
   * @returns {object|null} Tech stack details
   */
  _extractTechStackDetails() {
    const techStack = {
      languages: [],
      frameworks: [],
      runtime: null,
      database: null,
      buildTools: [],
    };

    // Check for package.json (Node.js)
    const pkgJsonPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        techStack.runtime = 'Node.js';

        // Detect frameworks from dependencies
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const frameworkMap = {
          'express': 'Express.js',
          'fastify': 'Fastify',
          'koa': 'Koa',
          'nestjs': 'NestJS',
          'next': 'Next.js',
          'react': 'React',
          'vue': 'Vue.js',
          '@angular/core': 'Angular',
          'typescript': 'TypeScript',
          'langgraph': 'LangGraph',
          'langchain': 'LangChain',
        };

        for (const [dep, name] of Object.entries(frameworkMap)) {
          if (deps[dep]) {
            techStack.frameworks.push(name);
          }
        }

        // Check for build tools
        if (deps['webpack']) techStack.buildTools.push('Webpack');
        if (deps['vite']) techStack.buildTools.push('Vite');
        if (deps['rollup']) techStack.buildTools.push('Rollup');
        if (deps['esbuild']) techStack.buildTools.push('esbuild');
        if (deps['tsc'] || deps['typescript']) techStack.buildTools.push('TypeScript Compiler');
      } catch (err) {
        // Ignore
      }
    }

    // Check for requirements.txt or pyproject.toml (Python)
    if (fs.existsSync(path.join(this.projectRoot, 'requirements.txt')) ||
        fs.existsSync(path.join(this.projectRoot, 'pyproject.toml')) ||
        fs.existsSync(path.join(this.projectRoot, 'setup.py'))) {
      techStack.languages.push('Python');
      
      // Try to detect Python frameworks
      const reqPath = path.join(this.projectRoot, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        try {
          const reqContent = fs.readFileSync(reqPath, 'utf-8');
          const pythonFrameworks = {
            'fastapi': 'FastAPI',
            'flask': 'Flask',
            'django': 'Django',
            'langgraph': 'LangGraph',
            'langchain': 'LangChain',
            'uvicorn': 'Uvicorn',
          };
          for (const [pattern, name] of Object.entries(pythonFrameworks)) {
            if (reqContent.toLowerCase().includes(pattern)) {
              techStack.frameworks.push(name);
            }
          }
        } catch (err) {
          // Ignore
        }
      }
    }

    // Check for go.mod (Go)
    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) {
      techStack.languages.push('Go');
      techStack.runtime = 'Go Runtime';
    }

    // Check for Cargo.toml (Rust)
    if (fs.existsSync(path.join(this.projectRoot, 'Cargo.toml'))) {
      techStack.languages.push('Rust');
      techStack.runtime = 'Rust Runtime';
    }

    // Check for database files/config
    if (fs.existsSync(path.join(this.projectRoot, 'docker-compose.yml'))) {
      try {
        const dcContent = fs.readFileSync(path.join(this.projectRoot, 'docker-compose.yml'), 'utf-8');
        if (dcContent.includes('postgres')) techStack.database = 'PostgreSQL';
        else if (dcContent.includes('mysql')) techStack.database = 'MySQL';
        else if (dcContent.includes('mongodb')) techStack.database = 'MongoDB';
        else if (dcContent.includes('redis')) techStack.database = 'Redis';
      } catch (err) {
        // Ignore
      }
    }

    // Clean up duplicates
    techStack.frameworks = [...new Set(techStack.frameworks)];
    techStack.languages = [...new Set(techStack.languages)];

    return Object.keys(techStack).some(k => 
      Array.isArray(techStack[k]) ? techStack[k].length > 0 : techStack[k]
    ) ? techStack : null;
  }

  /**
   * Extracts API endpoint definitions from source code.
   *
   * @returns {Array} List of API endpoints
   */
  _extractApiEndpoints() {
    const endpoints = [];
    const scannedFiles = new Set();

    // Patterns for different frameworks
    const patterns = [
      // FastAPI / Flask (Python)
      {
        regex: /@(?:app|router)\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]\s*(?:,\s*[^)]*)?\)/gi,
        framework: 'FastAPI/Flask',
        language: 'Python',
      },
      // Express.js (JavaScript/TypeScript)
      {
        regex: /(?:app|router)\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/gi,
        framework: 'Express.js',
        language: 'JavaScript/TypeScript',
      },
      // NestJS (TypeScript)
      {
        regex: /@(?:Get|Post|Put|Delete|Patch)\(['"]?([^'"]*)['"]?\)/gi,
        framework: 'NestJS',
        language: 'TypeScript',
      },
    ];

    // Scan main files
    const scanDirs = ['src', 'app', 'api', 'routes', 'controllers'];
    const extensions = ['.py', '.js', '.ts'];

    for (const dir of scanDirs) {
      const dirPath = path.join(this.projectRoot, dir);
      if (!fs.existsSync(dirPath)) continue;

      try {
        const files = this._walkDir(dirPath, extensions, 3);
        for (const file of files.slice(0, 20)) { // Limit to 20 files
          if (scannedFiles.has(file)) continue;
          scannedFiles.add(file);

          try {
            const content = fs.readFileSync(file, 'utf-8');
            const relPath = path.relative(this.projectRoot, file);

            for (const pattern of patterns) {
              let match;
              while ((match = pattern.regex.exec(content)) !== null) {
                endpoints.push({
                  method: match[1]?.toUpperCase() || 'GET',
                  path: match[2] || '/',
                  file: relPath,
                  framework: pattern.framework,
                });
              }
              pattern.regex.lastIndex = 0; // Reset regex
            }
          } catch (fileErr) {
            // Ignore file read errors
          }
        }
      } catch (dirErr) {
        // Ignore directory errors
      }
    }

    return endpoints.slice(0, 15); // Limit to 15 endpoints
  }

  /**
   * Extracts core features from main entry points.
   *
   * @returns {Array} List of core features
   */
  _extractCoreFeatures() {
    const features = [];
    const mainFiles = ['main.py', 'index.js', 'app.js', 'server.js', 'src/main.py', 'src/main.js', 'src/index.ts'];

    for (const mainFile of mainFiles) {
      const filePath = path.join(this.projectRoot, mainFile);
      if (!fs.existsSync(filePath)) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').slice(0, 100);

        // Look for docstrings, comments describing features
        let inDocstring = false;
        let docstringContent = [];

        for (const line of lines) {
          const trimmed = line.trim();

          // Python docstrings
          if (trimmed.startsWith('"""') || trimmed.startsWith("''")) {
            if (!inDocstring) {
              inDocstring = true;
              docstringContent.push(trimmed.replace(/^"""|^'''|"""$|'''$/g, ''));
            } else {
              docstringContent.push(trimmed.replace(/^"""|^'''|"""$|'''$/g, ''));
              break;
            }
          } else if (inDocstring) {
            docstringContent.push(trimmed);
          }
        }

        if (docstringContent.length > 0) {
          const description = docstringContent.join(' ').trim();
          if (description.length > 10) {
            features.push({
              source: mainFile,
              description: description.substring(0, 200),
            });
          }
        }
      } catch (err) {
        // Ignore
      }
    }

    return features.slice(0, 5);
  }

  /**
   * Builds an index of available documentation.
   *
   * @returns {Array} List of documentation files
   */
  _buildDocumentationIndex() {
    const docs = [];
    const docPaths = ['docs', 'doc', 'documentation', '.github'];
    const docExtensions = ['.md', '.MD', '.mdx'];

    for (const docDir of docPaths) {
      const dirPath = path.join(this.projectRoot, docDir);
      if (!fs.existsSync(dirPath)) continue;

      try {
        const files = this._walkDir(dirPath, docExtensions, 2);
        for (const file of files.slice(0, 10)) {
          const relPath = path.relative(this.projectRoot, file);
          const name = path.basename(file, path.extname(file));
          docs.push({
            name: name.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            path: relPath,
          });
        }
      } catch (err) {
        // Ignore
      }
    }

    return docs;
  }

  /**
   * Generates code quality observations based on project analysis.
   *
   * @returns {Array} List of observations
   */
  _generateCodeQualityObservations() {
    const observations = [];

    // Check for common quality indicators
    const checks = [
      {
        name: 'ESLint/Prettier config',
        files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.prettierrc', '.prettierrc.json'],
        message: 'Code linting/formatting configured',
      },
      {
        name: 'TypeScript configuration',
        files: ['tsconfig.json'],
        message: 'TypeScript project with type safety',
      },
      {
        name: 'Testing setup',
        files: ['jest.config.js', 'vitest.config.js', 'pytest.ini', 'setupTests.js'],
        message: 'Testing framework configured',
      },
      {
        name: 'CI/CD configuration',
        files: ['.github/workflows', '.gitlab-ci.yml', 'Jenkinsfile'],
        message: 'CI/CD pipeline configured',
      },
      {
        name: 'Docker configuration',
        files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
        message: 'Containerization configured',
      },
    ];

    for (const check of checks) {
      const exists = check.files.some(f => {
        const fullPath = path.join(this.projectRoot, f);
        return fs.existsSync(fullPath);
      });

      if (exists) {
        observations.push({
          type: 'positive',
          message: check.message,
        });
      }
    }

    // Check for potential issues
    const srcDir = path.join(this.projectRoot, 'src');
    if (!fs.existsSync(srcDir)) {
      observations.push({
        type: 'note',
        message: 'No `src/` directory found — code organization may be flat',
      });
    }

    // Check for duplicate patterns from projectProfile if available
    const profile = this._config.projectProfile;
    if (profile && profile.duplicates && profile.duplicates.length > 0) {
      observations.push({
        type: 'improvement',
        message: `${profile.duplicates.length} duplicate code patterns detected — consider refactoring`,
      });
    }

    return observations.slice(0, 8);
  }

  /**
   * Recursively walks a directory and returns files with specified extensions.
   *
   * @param {string} dir - Directory to walk
   * @param {Array} extensions - File extensions to include
   * @param {number} maxDepth - Maximum recursion depth
   * @param {number} [currentDepth=0] - Current depth
   * @returns {Array} List of file paths
   */
  _walkDir(dir, extensions, maxDepth, currentDepth = 0) {
    if (currentDepth > maxDepth) return [];

    const files = [];
    const ignoreDirs = ['node_modules', '.git', '__pycache__', '.venv', 'venv', '.env'];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!ignoreDirs.includes(entry.name)) {
            files.push(...this._walkDir(fullPath, extensions, maxDepth, currentDepth + 1));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (err) {
      // Ignore directory errors
    }

    return files;
  }

  /**
   * Builds a context file for a single sub-package.
   *
   * @param {{ name, dir, packageJsonPath }} pkg
   * @returns {string} Path to the written context file
   */
  async _buildPackageContext(pkg) {
    const { summary } = getProjectStructure(pkg.dir, 3);
    const pkgJson = JSON.parse(fs.readFileSync(pkg.packageJsonPath, 'utf-8'));

    const content = [
      `# Package Context: ${pkg.name}`,
      ``,
      `> Auto-generated by MemoryManager. Last updated: ${new Date().toISOString()}`,
      ``,
      `## Package Info`,
      `- **Name**: ${pkgJson.name || 'unknown'}`,
      `- **Version**: ${pkgJson.version || 'unknown'}`,
      `- **Description**: ${pkgJson.description || 'N/A'}`,
      `- **Main**: ${pkgJson.main || 'N/A'}`,
      ``,
      `## Directory Structure`,
      '```',
      summary,
      '```',
      ``,
      `## Dependencies`,
      _renderDeps(pkgJson.dependencies),
      ``,
      `## Dev Dependencies`,
      _renderDeps(pkgJson.devDependencies),
    ].join('\n');

    const contextPath = path.join(pkg.dir, 'AGENTS.md');
    fs.writeFileSync(contextPath, content, 'utf-8');
    console.log(`[MemoryManager] Package context written: ${contextPath}`);
    return contextPath;
  }

  /**
   * Renders the global AGENTS.md content with dynamic project context.
   */
  _renderAgentsMd(structureSummary, packages, strategy, symbolsSummary = '', projectContext = null) {
    return [
      '# AGENTS.md – WorkFlowAgent Entry Rules',
      '',
      `> Auto-generated by WorkFlowAgent. Last updated: ${new Date().toISOString()}`,
      `> Strategy: **${strategy}** (${strategy === 'thick' ? 'large Monorepo' : 'small single repo'})`,
      '',
      '## Purpose',
      'This file is intentionally compact. It keeps only entry hard rules and pointers to the active workflow spec/digest layers.',
      '',
      '## Source-of-Truth References',
      '| Need | Reference |',
      '|---|---|',
      '| Runtime workflow enforcement | `workflow/tools/ide-workflow-bridge.js` |',
      '| Active workflow SOP/spec | `workflow/skills/workflow-orchestration.md` |',
      '| Stage digest index | `output/context-digests/index.json` |',
      '| Architecture cold-start summary | `output/arch-knowledge-cache.json` / `arch-cache --action summary` |',
      '| Full audit artifacts | `output/analysis.md`, `output/architecture.md`, `output/execution-plan.md`, `output/code.diff`, `output/test-report.md`, `output/review-output.md`, `output/deploy-output.md` |',
      '',
      '## Hard Entry Rules',
      '1. For any `/wf` message, output `> 🔄 启用wf工作流` as the first visible line.',
      '2. Immediately call `input-received` before reading, searching, editing, or answering.',
      '3. Then call `workflow-stage` for the current stage before doing stage work.',
      '4. Finish every stage with `stage-complete` and follow `MANDATORY_NEXT_ACTION` until workflow completion.',
      '5. Active stage sequence: `ANALYSE -> ARCHITECT -> PLAN -> DEVELOP -> TEST -> REVIEW -> DEPLOY`.',
      '6. Use digest-first context: read `output/context-digests/index.json` and relevant digests before full artifacts.',
      '7. Full artifacts are fallback/audit sources. Read them only when digest is missing, stale, insufficient, or precise evidence is required.',
      '8. Prefer IDE-native tools for reading/searching/editing. Do not write files with Bash redirection or shell text manipulation.',
      '9. Do not delete `.codebuddy/`; it stores project-related data, not temporary cache.',
      '',
      '## Minimal Commands',
      '```bash',
      'node workflow/tools/ide-workflow-bridge.js input-received --user-input "<exact /wf message>" --input-type "requirement" --decision "走完整工作流" --project-root .',
      'node workflow/tools/ide-workflow-bridge.js workflow-stage --stage <STAGE> --requirement "<requirement>" --project-root . --stage-input "<context refs>"',
      'node workflow/tools/ide-workflow-bridge.js stage-complete --stage <STAGE> --project-root . --summary "<summary>" --stage-output "<artifact path>"',
      '```',
      '',
      '## Non-/wf Sessions',
      '- Use `output/context-digests/index.json` and `arch-cache --action summary` for compact context.',
      '- Read source files directly only when needed for implementation or evidence.',
      '- Keep changes scoped and report modified files explicitly.',
    ].join('\n');
  }

  /**
   * Renders the full 7-stage workflow protocol for AGENTS.md.
   *
   * Plan A: This replaces the old "run command" approach with the complete
   * stage-by-stage protocol that includes Anti-Skip Guard, Socratic Challenge,
   * RETRY_STAGE, Evidence Gate, MANDATORY_NEXT_ACTION, and Lightweight Artifact Rule.
   *
   * Previously this protocol only existed in WorkFlowAgent's hand-maintained AGENTS.md.
   * Now all projects initialized via init-project.js get the same protocol.
   *
   * @returns {string[]} Array of lines to join into AGENTS.md
   */
  _renderWorkflowProtocol() {
    // Calculate absolute bridge path so commands work from ANY project directory,
    // not just the WorkFlowAgent directory itself.
    const wfRoot = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
    const bridgePath = `${wfRoot}/workflow/tools/ide-workflow-bridge.js`;

    return [
`### /wf <requirement> Workflow Execution`,
``,
`When the user sends \`/wf <requirement>\` (not "init"), execute the following **exact sequence**. Every step is MANDATORY. Skipping any step is a P0 failure.`,
``,
`> 🚫 **ABSOLUTE PROHIBITION – No Direct Execution**:`,
`> When the user sends \`/wf <requirement>\`, you are **STRICTLY FORBIDDEN** from directly implementing the requirement without going through the 7-stage workflow.`,
`> This applies regardless of how simple the task appears. "Simple" is not a valid reason to skip the workflow.`,
`> ❌ DO NOT read files and make edits directly.`,
`> ❌ DO NOT reason about the solution and output code without running \`workflow-stage\`.`,
`> ❌ DO NOT treat \`/wf\` as a regular coding request.`,
`> ✅ The ONLY valid response to \`/wf <requirement>\` is to execute STEP 0 → STEP 1~7 → STEP FINAL.`,
`> Violation of this rule is a **P0 failure** — equivalent to corrupting the workflow state.`,
``,
`> ⚠️ **ABSOLUTE RULE – No Subjective Classification**:`,
`> Every \`/wf\` message is a requirement. No exceptions. No "discussion-only" classification.`,
`> Complexity does NOT matter. A one-line change still requires the full 7-stage workflow.`,
``,
`> ⚠️ **CRITICAL - Execution Mode (ADR-37 IDE-First)**:`,
`> IDE Agent IS the orchestrator. Use IDE-native tools directly. **NEVER** run \`ide-workflow-bridge.js run\`.`,
``,
`---`,
``,
`> ⛔ **ACTIVATION TRIGGER — FIRES ON EVERY /wf MESSAGE (READ THIS FIRST)**:`,
`> This trigger fires BEFORE any thinking, reading, or responding.`,
`> When you receive a message starting with \`/wf\`, execute these two actions IMMEDIATELY:`,
`>`,
`> **ACTION 1** — Output this exact text as your very first line:`,
`> \`\`\``,
`> > 🔄 启用wf工作流`,
`> \`\`\``,
`>`,
`> **ACTION 2** — Call terminal immediately (before ANY other tool call):`,
`> \`\`\`bash`,
`> node ${bridgePath} input-received \\`,
`>   --user-input "<exact /wf message text>" \\`,
`>   --input-type "requirement" \\`,
`>   --decision "走完整工作流" \\`,
`>   --session <SESSION_ID> \\`,
`>   --project-root .`,
`> \`\`\``,
`>`,
`> ❌ NO EXCEPTIONS. Not for questions. Not for "simple" tasks. Not for research requests.`,
`> ❌ DO NOT think first. DO NOT read files first. DO NOT answer first.`,
`> ✅ ACTION 1 + ACTION 2 are UNCONDITIONAL. Execute them, then proceed to STEP 1.`,
`>`,
`> ℹ️ **Claude Code users**: \`wf-hook.sh\` auto-executes ACTION 2 at the Shell layer before LLM processing.`,
`> You will see \`[AUTO-LOGGED by wf-hook.sh]\` in your context — this means ACTION 2 is already done.`,
`> In that case, skip ACTION 2 and go directly to STEP 1 (workflow-stage).`,
``,
`---`,
``,
`#### 🔴 STEP 0 — Output \`> 🔄 启用wf工作流\`, call \`input-received\`, then proceed immediately to STEP 1.`,
``,
`> ⚠️ **MANDATORY — Log Every /wf Input (P0)**:`,
`> Before doing ANYTHING else, you MUST call \`input-received\` to log this message in \`workflow-progress.log\`.`,
`> This applies to ALL \`/wf\` messages — requirements, questions, research requests, complaints — NO EXCEPTIONS.`,
`> If you skip this call, the user has no way to know their message was received.`,
`>`,
`> \`\`\`bash`,
`> node ${bridgePath} input-received \\`,
`>   --user-input "<exact /wf message text>" \\`,
`>   --input-type "requirement|question|research|other" \\`,
`>   --decision "走完整工作流" \\`,
`>   --session <SESSION_ID> \\`,
`>   --project-root .`,
`> \`\`\``,
`>`,
`> - \`--input-type\` is a **log label only** — it does NOT affect execution path.`,
`> - ALL \`/wf\` messages MUST go through the full 7-stage workflow (STEP 1~7), regardless of \`--input-type\`.`,
`> - \`requirement\` / \`question\` / \`research\` / \`other\` are classification tags for the progress log, nothing more.`,
`>`,
`> ❌ DO NOT skip this call. ❌ DO NOT answer first and log later.`,
`> ✅ Log FIRST, then handle.`,
``,
`> ⛔ **ANTI-SKIP GUARD (MACHINE-ENFORCED — cannot be bypassed)**:`,
`> \`input-received\` returns \`MANDATORY_NEXT_ACTION.type = 'CALL_WORKFLOW_STAGE'\`.`,
`> This is backed by code-level enforcement in \`ide-workflow-bridge.js\`.`,
`> If you do NOT call \`workflow-stage\` next, any subsequent \`stage-complete\` call will be **HARD-REJECTED** with a fatal error.`,
`> ❌ Do NOT read files, search code, or edit anything before calling \`workflow-stage\`.`,
`> ❌ Do NOT treat \`MANDATORY_NEXT_ACTION\` as a suggestion — it is a machine-enforced gate.`,
`> ✅ \`workflow-stage\` is the door to each stage. You MUST open the door before entering.`,
``,
`> ℹ️ No manual session init needed. The first \`trace-append\` call automatically initializes the session.`,
``,
`---`,
``,
`#### 🔴 STEP 1~7 — Each Stage MUST follow this exact pattern (NO EXCEPTIONS):`,
``,
'```',
`[terminal] workflow-stage --stage <STAGE>   ← auto-writes stage_start trace (code-enforced)`,
`[IDE tools] do actual stage work (read_file, grep_search, edit_file, etc.)`,
`[terminal] stage-complete --stage <STAGE>   ← auto-writes stage_end trace + socratic (code-enforced)`,
'```',
``,
`> ✅ **Plan B (Code-Enforced Trace)**: Trace writing is guaranteed by code, NOT by LLM memory.`,
`> \`workflow-stage\` auto-writes \`stage_start\`. \`stage-complete\` auto-writes \`stage_end\` + triggers Socratic challenge.`,
`> ❌ You MUST NOT skip either command. The health report only updates when these commands run.`,
``,
`**Concrete commands for each stage:**`,
'```bash',
`# START of stage — workflow-stage auto-inits session on first call (no --session needed for ANALYSE)`,
`node ${bridgePath} workflow-stage \\`,
`  --stage <STAGE_NAME> \\`,
`  --session <SESSION_ID> \\`,
`  --requirement "<user requirement>" \\`,
`  --project-root . \\`,
`  --stage-input "<key files / context being analyzed>"`,
``,
`# → Returns data.sessionId — save this for subsequent stages`,
`# → Returns PROGRESS_DISPLAY (top-level field) with progressBanner`,
`#`,
`# ⛔ PROGRESS_DISPLAY RULE (P0 — NO EXCEPTIONS):`,
`#    workflow-stage returns PROGRESS_DISPLAY.progressBanner.`,
`#    You MUST output this banner verbatim as the FIRST line of your response.`,
`#    Format: ━━━ [N/7] 🔍 STAGE_NAME 阶段开始 ━━━ → 待执行: ...`,
`#    This is the ONLY way the user can see workflow progress (stderr is invisible to user).`,
`#    ❌ DO NOT skip this output. ❌ DO NOT paraphrase. Output the exact progressBanner string.`,
``,
`# END of stage — after ALL work for this stage is done:`,
`node ${bridgePath} stage-complete \\`,
`  --stage <STAGE_NAME> \\`,
`  --session <SESSION_ID> \\`,
`  --project-root . \\`,
`  --summary "<1-2 sentence summary of what was done>" \\`,
`  --stage-output "<key decisions / artifacts produced>"`,
``,
`# → Returns MANDATORY_NEXT_ACTION (top-level field, NOT inside data)`,
`# → MANDATORY_NEXT_ACTION.command = the exact command to start the next stage`,
`# → MANDATORY_NEXT_ACTION.instruction = ⛔ DO NOT STOP — execute immediately`,
`#`,
`# ⛔ RALPH LOOP RULE (P0 — NO EXCEPTIONS):`,
`#    stage-complete returns MANDATORY_NEXT_ACTION.`,
`#    This is the IDE-Agent equivalent of Claude Code's Stop Hook injection.`,
`#    When MANDATORY_NEXT_ACTION.type === 'STOP_HOOK_INJECT':`,
`#      → You CANNOT stop. You CANNOT output a summary and wait.`,
`#      → If MANDATORY_NEXT_ACTION.socraticInstruction is non-null:`,
`#        → FIRST: Output the Socratic three-part structure (苏格拉底追问 → 自答 → BLIND SPOT)`,
`#        → THEN: Execute MANDATORY_NEXT_ACTION.command IMMEDIATELY as the next terminal call.`,
`#      → If socraticInstruction is null: Execute MANDATORY_NEXT_ACTION.command IMMEDIATELY.`,
`#      → Only when type === 'WORKFLOW_COMPLETE' are all stages done.`,
`#`,
`# ⚠️ RETRY_STAGE RULE (P0 — NO EXCEPTIONS):`,
`#    When MANDATORY_NEXT_ACTION.type === 'RETRY_STAGE':`,
`#      → Socratic confidence was too low. You MUST redo the current stage.`,
`#      → Step 1: In your thinking, answer each question in MANDATORY_NEXT_ACTION.socraticQuestions`,
`#      → Step 2: Rewrite the stage artifact with concrete improvements (mark with [RETRY-N])`,
`#      → Step 3: Execute MANDATORY_NEXT_ACTION.command to restart the stage`,
`#      → DO NOT proceed to the next stage. DO NOT ignore this signal.`,
`#      → retryCount/maxRetry is shown — after maxRetry exhausted, system auto-proceeds to next stage.`,
`#`,
`# ⛔ FORCED_RETRY_GATE (MACHINE-ENFORCED — cannot be bypassed):`,
`#    stage-complete records the artifact hash when RETRY_STAGE is triggered.`,
`#    On the next stage-complete call, it compares the new artifact hash to the recorded one.`,
`#    If the hash is IDENTICAL → stage-complete returns error immediately (no Socratic eval runs).`,
`#    This is NOT a prompt rule — it is code-enforced. Cosmetic edits will NOT pass.`,
`#    To pass: make substantive improvements that change the artifact content meaningfully.`,
`#`,
`# 📝 MICRO-PLANNING PROTOCOL (ADR-48 — CODE stage only):`,
`#    During the DEVELOP stage, if you discover the execution plan is insufficient`,
`#    (unexpected dependency, missing file, scope change), you do NOT need to abort.`,
`#    Instead, emit deviation markers in your code output:`,
`#      [PLAN_DEVIATION] T-XX: <reason why the plan was insufficient>`,
`#      [SCOPE_CHANGE] T-XX: <what changed and why>`,
`#      [UNEXPECTED_DEPENDENCY] T-XX: <what dependency was discovered>`,
`#      [TASK_AMENDMENT] T-XX: <revised task description>`,
`#    The orchestrator will automatically detect these markers and append amendments`,
`#    to execution-plan.md — no full PLAN rollback needed.`,
`#    ⚠️ Cap: max 5 amendments per CODE run. If you exceed 5, the system flags for full re-plan.`,
`#    ⚠️ This is for LOCAL adjustments only. Architectural changes still require ARCHITECT rollback.`,
'```',
``,
`Replace \`<STAGE_NAME>\` with: \`ANALYSE\` | \`ARCHITECT\` | \`PLAN\` | \`DEVELOP\` | \`TEST\` | \`REVIEW\` | \`DEPLOY\``,
``,
`> 📐 **ANALYSE Stage — \`analysis.md\` Output Schema** (CRITICAL — write ONLY these sections):`,
`> \`\`\``,
`> ## 根因 / Root Cause       — What is the real problem? (1-3 paragraphs, evidence-backed)`,
`> ## 受影响位置               — Which files/modules/lines are affected? (table or list)`,
`> ## 修改范围                 — What needs to change? (table: file | location | change description)`,
`> ## 风险评估                 — What could go wrong? (list with severity: P0/P1/P2)`,
`> \`\`\``,
`> ❌ DO NOT write generic requirement templates: User Stories, Functional Requirements, Acceptance Criteria`,
`>    — \`analysis.md\` is for task-specific analysis, NOT a requirements document`,
`> ❌ DO NOT copy Socratic dimension definitions into \`analysis.md\``,
`>    — the 12 Socratic dimensions are an **internal thinking framework**, not output content`,
`> ✅ Socratic thinking MUST still happen internally — output only your **conclusions**, not the dimension list`,
`>`,
`> ⛔ **ADR-37 Evidence Gate (MACHINE-ENFORCED — cannot be bypassed)**:`,
`>    \`stage-complete\` mechanically verifies that \`analysis.md\` contains evidence of real IDE tool usage.`,
`>    An artifact written from LLM memory alone (no file paths, no line numbers, no code references) will be`,
`>    **HARD-REJECTED** with error \`[EVIDENCE_MISSING]\`.`,
`>    **MANDATORY before writing analysis.md**:`,
`>    1. Call \`codebase_search\` to find relevant code (semantic search)`,
`>    2. Call \`grep_search\` to locate specific patterns/functions`,
`>    3. Include REAL file paths (e.g. \`workflow/core/foo.js\`) in \`## 受影响位置\``,
`>    4. Include REAL line numbers or function names from search results in \`## 根因\``,
`>    This is NOT a prompt suggestion — it is code-enforced. Skipping IDE tools = stage-complete rejection.`,
``,
`> ✅ Each \`stage-complete\` call **immediately appends** to \`output/workflow-progress.log\` with stage result + metrics gate.`,
`> ✅ Socratic challenge is automatically triggered inside \`stage-complete\` — no separate call needed.`,
`> ❌ If you skip stage-complete, the progress log stays incomplete. This is a visible P0 failure.`,
`> ⛔ If MANDATORY_NEXT_ACTION.type === 'STOP_HOOK_INJECT', you MUST execute the next stage. No exceptions.`,
`> ⚠️ If MANDATORY_NEXT_ACTION.type === 'RETRY_STAGE', you MUST redo the current stage (answer socratic questions → rewrite artifact → re-run workflow-stage). No exceptions.`,
``,
`---`,
``,
`#### 📐 Lightweight Artifact Rule (Plan C — Anti-Hallucination)`,
``,
`> **Every stage MUST execute** (\`workflow-stage\` + \`stage-complete\` are both mandatory, no exceptions).`,
`> However, the **artifact content** may be minimal when the stage has no substantive work for the current task.`,
``,
`**When a stage has no substantive content** (e.g., ARCHITECT/PLAN for a config-only change, TEST for a doc fix):`,
`- ✅ Still call \`workflow-stage\` and \`stage-complete\` — the log chain MUST be complete`,
`- ✅ Write a **one-line minimal artifact**: \`> [LIGHTWEIGHT] This stage has no substantive content for the current task: <reason>\``,
`- ✅ Pass \`--summary "[LIGHTWEIGHT] <reason>"\` to \`stage-complete\``,
`- ❌ DO NOT fabricate tasks, components, or acceptance criteria to fill the artifact`,
`- ❌ DO NOT generate 3 tasks and 5 ACs for a typo fix — this is hallucination, not quality`,
``,
`**Key principle**: The goal is a **complete log chain with honest content**, not a padded log chain with hallucinated content.`,
``,
`---`,
``,
`#### 🔴 STEP FINAL — After all stages complete:`,
``,
'```bash',
`node ${bridgePath} session-summary --requirement "<user requirement>" --session <SESSION_ID> --project-root .`,
'```',
``,
`> 📋 Full execution evidence is in \`output/workflow-progress.log\` — each stage's start/complete/metrics are recorded there automatically.`,
``,
`---`,
``,
`> ⚠️ **IMPORTANT**: When executing \`/wf <requirement>\`, do NOT run the Session Start Checklist below.`,
`> Go directly into the STEP 0 → STEP 1~7 → STEP FINAL sequence above.`,
``,
`## 🤔 Socratic Challenge Protocol (AUTO-TRIGGERED by stage-complete)`,
``,
`> ✅ **Plan B**: Socratic challenge is automatically triggered inside \`stage-complete\`.`,
`> You do NOT need to call \`socratic-challenge\` separately — it runs as part of \`stage-complete\`.`,
``,
`> ⛔ **SOCRATIC OUTPUT RULE (P0 — NO EXCEPTIONS)**:`,
`>    \`stage-complete\` now returns \`MANDATORY_NEXT_ACTION.socraticQuestions[]\` and`,
`>    \`MANDATORY_NEXT_ACTION.socraticInstruction\` at the TOP LEVEL (same level as \`command\`).`,
`>    This is NOT optional information — it is part of the mandatory action.`,
`>    When \`MANDATORY_NEXT_ACTION.socraticInstruction\` is non-null:`,
`>      → You MUST output the Socratic three-part structure BEFORE executing the next stage command.`,
`>      → The three-part structure (苏格拉底追问 → 自答 → BLIND SPOT) is a PREREQUISITE for the next command.`,
`>      → Skipping it is equivalent to ignoring MANDATORY_NEXT_ACTION — a P0 violation.`,
``,
`### After stage-complete returns — Rewrite the questions (CRITICAL)`,
`\`MANDATORY_NEXT_ACTION.socraticQuestions[]\` are **template questions** — you MUST rewrite each question to be **highly specific** to:`,
`1. **The user's actual requirement** — reference specific terms, goals, constraints from the requirement`,
`2. **The current stage's artifact content** — reference actual section headings, decisions, code snippets, or gaps found in the artifact`,
`3. **The stage context** — what was just done, what was decided, what was skipped`,
``,
`**Rewrite rules**:`,
`- ❌ BAD: \`"你给出了结论但缺少推导依据。核心决策是如何从事实推导出来的？"\` (generic template)`,
`- ✅ GOOD: \`"你在需求分析中将问题定性为UI问题，但代码证据显示根因在后端——这个定性是否准确？"\` (specific to this run)`,
``,
`### Self-answer AND flag (MANDATORY — Three-Part Structure)`,
``,
`> ⚠️ **P0 RULE**: You MUST self-answer every Socratic question. Do NOT leave questions open for the user.`,
``,
`For EVERY rewritten question, output in this exact three-part structure:`,
``,
'```',
`苏格拉底追问（针对本次 <STAGE>）：`,
`1. <specific question referencing actual artifact content>`,
`2. <specific question about the fundamental gap or assumption>`,
``,
`**自答**：`,
`- 问题1：<direct answer — what the real issue is, with evidence from artifacts>`,
`- 问题2：<direct answer — if it's a genuine blind spot, say so explicitly>`,
``,
`**⚠️ [BLIND SPOT]**（如有）：<description of the fundamental flaw — not surface symptoms>`,
'```',
``,
`**First-Principles check** (MANDATORY for every stage):`,
`After self-answering, always ask: **"这个方案/结论的本质是什么？和业界最优解的真正差距在哪里？"**`,
`- If the answer reveals the solution is fundamentally limited → flag as \`⚠️ [BLIND SPOT]\` with the exact limitation`,
`- Do NOT hide limitations to make the solution look better`,
``,
`### Optional Post-Run Commands`,
``,
'```bash',
`node ${bridgePath} health-report --project-root .`,
`node ${bridgePath} session-summary --requirement "<the user's requirement text>" --project-root .`,
'```',
    ].join('\n');
  }

  /**
   * Renders dynamic content sections based on extracted project context.
   *
   * @param {object} ctx - Project context from _extractProjectContext()
   * @returns {object} Object with rendered sections
   */
  _renderDynamicSections(ctx) {
    const sections = {
      overview: '',
      techStack: '',
      apiEndpoints: '',
      docIndex: '',
      qualityObservations: '',
    };

    if (!ctx) return sections;

    // 1. Project Overview
    if (ctx.projectOverview) {
      const title = ctx.projectOverview.title || 'Project';
      const desc = ctx.projectOverview.description || '';
      sections.overview = [
        `## 🎯 Project Overview`,
        ``,
        `**${title}** – ${desc}`,
        ``,
        ctx.projectOverview.keyFeatures.length > 0
          ? `### Key Features\n\n${ctx.projectOverview.keyFeatures.map(f => `- ${f}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');
    } else {
      sections.overview = `## 🎯 Project Overview\n\nProject context will be populated automatically after code analysis.`;
    }

    // 2. Tech Stack Details
    if (ctx.techStackDetails) {
      const tech = ctx.techStackDetails;
      const lines = [`## 🏗️ Tech Stack`, ``];

      if (tech.languages.length > 0) {
        lines.push(`- **Languages**: ${tech.languages.join(', ')}`);
      }
      if (tech.frameworks.length > 0) {
        lines.push(`- **Frameworks**: ${tech.frameworks.join(', ')}`);
      }
      if (tech.runtime) {
        lines.push(`- **Runtime**: ${tech.runtime}`);
      }
      if (tech.database) {
        lines.push(`- **Database**: ${tech.database}`);
      }
      if (tech.buildTools.length > 0) {
        lines.push(`- **Build Tools**: ${tech.buildTools.join(', ')}`);
      }

      sections.techStack = lines.join('\n');
    } else {
      sections.techStack = `## 🏗️ Tech Stack\n\nDetected from project files during initialization.`;
    }

    // 3. API Endpoints
    if (ctx.apiEndpoints && ctx.apiEndpoints.length > 0) {
      const lines = [`## 🔌 API Endpoints`, ``];
      lines.push(`| Method | Path | File | Framework |`);
      lines.push(`|--------|------|------|-----------|`);

      for (const ep of ctx.apiEndpoints) {
        lines.push(`| ${ep.method} | \`${ep.path}\` | ${ep.file} | ${ep.framework} |`);
      }

      sections.apiEndpoints = lines.join('\n');
    }

    // 4. Documentation Index
    if (ctx.documentationIndex && ctx.documentationIndex.length > 0) {
      const lines = [`## 📚 Documentation Index`, ``];
      lines.push(`| Document | Path |`);
      lines.push(`|----------|------|`);

      for (const doc of ctx.documentationIndex) {
        lines.push(`| ${doc.name} | \`${doc.path}\` |`);
      }

      sections.docIndex = lines.join('\n');
    }

    // 5. Code Quality Observations
    if (ctx.codeQualityObservations && ctx.codeQualityObservations.length > 0) {
      const lines = [`## ⚠️ Code Quality Observations`, ``];

      for (const obs of ctx.codeQualityObservations) {
        const icon = obs.type === 'positive' ? '✅' : obs.type === 'improvement' ? '🔧' : 'ℹ️';
        lines.push(`${icon} ${obs.message}`);
      }

      sections.qualityObservations = lines.join('\n');
    }

    return sections;
  }

  /**
   * Called when a file change is detected.
   * Determines which memory files need updating.
   */
  async _onFileChanged(filename) {
    // Determine if the changed file belongs to a sub-package
    const packages = this._detectPackages();
    // N36 fix: normalise both sides to forward-slashes before comparing.
    // On Windows, fs.watch may return filenames with forward-slashes while
    // path.relative() returns back-slashes (or vice versa depending on Node version),
    // causing startsWith() to silently fail and package context to never update.
    const normFilename = filename.replace(/\\/g, '/');
    const affectedPkg = packages.find(pkg => {
      const relDir = path.relative(this.projectRoot, pkg.dir).replace(/\\/g, '/');
      return normFilename.startsWith(relDir + '/') || normFilename === relDir;
    });

    if (affectedPkg) {
      await this._buildPackageContext(affectedPkg);
    }
    // Always refresh global context
    await this.buildGlobalContext();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _renderDeps(deps) {
  if (!deps || Object.keys(deps).length === 0) return '_None_';
  return Object.entries(deps).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n');
}

module.exports = { MemoryManager };
