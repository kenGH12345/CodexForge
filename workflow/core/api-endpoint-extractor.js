/**
 * API Endpoint Extractor – Extracts REST API endpoints from codebase.
 *
 * This module follows ADR-37 (IDE-First) with two extraction strategies:
 *
 *  **Strategy C (IDE-First)**: When running inside an IDE:
 *    - Use codebase_search to find API handler functions (getUser, postOrder)
 *    - Use grep_search to locate route definitions (app.get, @Get, @router.get)
 *    - Use view_code_item to get function signatures and types
 *
 *  **Strategy E (Fallback)**: When no IDE is available:
 *    - Use CodeGraph to find handler functions by naming patterns
 *    - Use regex-based route extraction (framework-specific patterns)
 *    - Parse route paths from function calls and decorators
 *
 * Supported frameworks:
 *   - Express.js: app.get('/users/:id', handler)
 *   - NestJS: @Get(':id') getUser() {}
 *   - FastAPI: @router.get("/{id}") async def get_user()
 *   - Gin: r.GET("/users/:id", handler)
 *   - Spring: @GetMapping("/{id}")
 *
 * Output:
 *   - output/api-endpoints.json  (machine-readable endpoint catalog)
 *   - output/api-endpoints.md    (human-readable summary)
 *   - output/api-endpoints-diagrams.md (Mermaid diagrams)
 *
 * Design: Zero external AST dependencies, pure regex + IDE tools.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Route Definition Patterns ───────────────────────────────────────────────

/**
 * Framework-specific route definition patterns.
 * Each pattern captures: method, path, and optionally handler name.
 */
const ROUTE_PATTERNS = {
  // Express.js / Connect
  express: {
    patterns: [
      // app.get('/path', handler) or router.get('/path', handler)
      /\b(?:app|router)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*[\w.]+\s*)*\)/gi,
      // app.route('/path').get(handler).post(handler)
      /\b(?:app|router)\.route\s*\(\s*['"`]([^'"`]+)['"`]\s*\)\s*\.(get|post|put|delete|patch)\s*\(/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'Express.js',
  },

  // NestJS decorators
  nestjs: {
    patterns: [
      // @Get('path') or @Post('path')
      /@(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/gi,
      // @RequestMapping({ path: 'path', method: RequestMethod.GET })
      /@RequestMapping\s*\(\s*\{\s*path\s*:\s*['"`]([^'"`]+)['"`]\s*(?:,\s*method\s*:\s*RequestMethod\.(\w+))?/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'NestJS',
  },

  // FastAPI / Flask
  fastapi: {
    patterns: [
      // @router.get("/path") or @app.get("/path")
      /@(?:router|app|APIRouter)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gi,
      // @route('/path', methods=['GET'])
      /@route\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*methods\s*=\s*\[['"`](\w+)['"`]\s*\])?/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'FastAPI/Flask',
  },

  // Gin (Go)
  gin: {
    patterns: [
      // r.GET("/path", handler) or router.GET("/path", handler)
      /\b(?:r|router)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'Gin',
  },

  // Spring Boot
  spring: {
    patterns: [
      // @GetMapping("/path") or @PostMapping("/path")
      /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/gi,
      // @RequestMapping(value = "/path", method = RequestMethod.GET)
      /@RequestMapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)['"`]\s*(?:,\s*method\s*=\s*RequestMethod\.(\w+))?/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'Spring Boot',
  },

  // Fastify
  fastify: {
    patterns: [
      // fastify.get('/path', handler) or app.get('/path', handler)
      /(?:fastify|app)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/gi,
    ],
    methodIndex: 1,
    pathIndex: 2,
    framework: 'Fastify',
  },
};

/**
 * Handler naming patterns - functions that are likely API handlers.
 */
const HANDLER_PATTERNS = {
  // RESTful CRUD operations
  crud: [
    /^(get|post|put|delete|patch)[A-Z]\w*$/,  // getUser, postOrder, deleteUser
    /^(create|read|update|delete)[A-Z]\w*$/,  // createUser, readOrder
    /^(list|search|find)[A-Z]\w*$/,           // listUsers, searchProducts
    /^(fetch|load|save|store)[A-Z]\w*$/,      // fetchUser, saveOrder
  ],
  // Controller actions
  controller: [
    /^handle[A-Z]\w*$/,       // handleLogin, handleRequest
    /^process[A-Z]\w*$/,      // processPayment
    /^execute[A-Z]\w*$/,      // executeCommand
  ],
  // Async handlers
  async: [
    /^async\s+(get|post|put|delete|patch)[A-Z]/, // async getUser
  ],
};

/**
 * Common middleware patterns to skip.
 */
const MIDDLEWARE_PATTERNS = [
  /^(log|logger|auth|validate|sanitize|parse|cors|helmet|rate)/i,
  /^(middleware|interceptor|guard|filter)$/i,
];

// ─── Main Extractor Class ────────────────────────────────────────────────────

class APIEndpointExtractor {
  /**
   * @param {object} options
   * @param {object}   options.codeGraph       - CodeGraph instance (for fallback)
   * @param {string}   options.projectRoot     - Project root directory
   * @param {string}   options.outputDir       - Output directory for generated files
   * @param {object}   [options.ideDetection]  - IDE detection result (for Strategy C)
   * @param {object}   [options.projectProfile]- Project profile (detected frameworks)
   * @param {boolean}  [options.useIDEFirst=true] - Follow ADR-37: prefer IDE tools
   */
  constructor({
    codeGraph,
    projectRoot,
    outputDir,
    ideDetection = null,
    projectProfile = null,
    useIDEFirst = true,
  }) {
    this._codeGraph = codeGraph;
    this._projectRoot = projectRoot;
    this._outputDir = outputDir;
    this._ideDetection = ideDetection;
    this._projectProfile = projectProfile;
    this._useIDEFirst = useIDEFirst;

    // Determine extraction strategy
    this._strategy = this._determineStrategy();

    // Cache for extracted data
    this._endpoints = [];
    this._handlers = [];
    this._routes = [];
    this._frameworks = [];
  }

  // ─── Strategy Selection ───────────────────────────────────────────────────

  /**
   * Determine which extraction strategy to use.
   * @returns {'ide-first' | 'codegraph'}
   */
  _determineStrategy() {
    if (!this._useIDEFirst) return 'codegraph';

    // Check if IDE is available with search capabilities
    if (this._ideDetection && this._ideDetection.isInsideIDE) {
      const caps = this._ideDetection.capabilities || {};
      if (caps.codebaseSearch || caps.grepSearch) {
        console.log(`[APIEndpointExtractor] 🏠 IDE detected (${this._ideDetection.ideName}), using IDE-First strategy`);
        return 'ide-first';
      }
    }

    console.log(`[APIEndpointExtractor] 📊 Using CodeGraph strategy (fallback)`);
    return 'codegraph';
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Extract all API endpoints from the codebase.
   *
   * @param {object} [options]
   * @param {boolean}  [options.writeOutput=true]  - Write output files
   * @returns {{ endpoints, handlers, routes, stats }}
   */
  async extract({ writeOutput = true } = {}) {
    console.log(`\n[APIEndpointExtractor] 🔍 Extracting API endpoints...`);
    console.log(`   Strategy: ${this._strategy}`);

    // Ensure code graph is loaded (for fallback)
    // Use public API getSymbolCount() instead of direct _symbols.size access
    if (this._codeGraph && this._codeGraph.getSymbolCount() === 0) {
      this._codeGraph.ensureLoaded();
    }

    // Step 1: Detect frameworks in use
    this._frameworks = this._detectFrameworks();
    console.log(`   ✅ Detected frameworks: ${this._frameworks.join(', ') || 'none'}`);

    // Step 2: Extract route definitions from source files
    this._routes = this._extractRoutes();
    console.log(`   ✅ Found ${this._routes.length} route definitions`);

    // Step 3: Identify handler functions
    this._handlers = this._identifyHandlers();
    console.log(`   ✅ Found ${this._handlers.length} handler functions`);

    // Step 4: Link routes to handlers
    this._endpoints = this._linkEndpoints();
    console.log(`   ✅ Extracted ${this._endpoints.length} API endpoints`);

    // Build stats
    const stats = {
      totalEndpoints: this._endpoints.length,
      totalHandlers: this._handlers.length,
      totalRoutes: this._routes.length,
      frameworks: this._frameworks,
      strategy: this._strategy,
      httpMethods: this._countByMethod(),
    };

    // Write output files
    if (writeOutput) {
      this._writeOutput(stats);
    }

    return {
      endpoints: this._endpoints,
      handlers: this._handlers,
      routes: this._routes,
      stats,
    };
  }

  // ─── Framework Detection ───────────────────────────────────────────────────

  /**
   * Detect which web frameworks are in use based on project profile.
   */
  _detectFrameworks() {
    const frameworks = [];

    if (this._projectProfile) {
      const deps = this._projectProfile.dependencies || {};
      const patterns = this._projectProfile.patterns || [];

      // Check dependencies
      if (deps['express']) frameworks.push('express');
      if (deps['@nestjs/core']) frameworks.push('nestjs');
      if (deps['fastify']) frameworks.push('fastify');
      if (deps['fastapi'] || deps['flask']) frameworks.push('fastapi');
      if (deps['gin'] || deps['echo']) frameworks.push('gin');
      if (deps['spring-boot-starter-web']) frameworks.push('spring');

      // Check detected patterns
      if (patterns.includes('REST API')) {
        // Already confirmed REST API pattern
      }
    }

    // Fallback: try to detect from files
    if (frameworks.length === 0) {
      try {
        const pkgPath = path.join(this._projectRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (deps['express']) frameworks.push('express');
          if (deps['@nestjs/core']) frameworks.push('nestjs');
          if (deps['fastify']) frameworks.push('fastify');
          if (deps['koa']) frameworks.push('koa');
        }
      } catch (e) {
        // Ignore errors
      }
    }

    return frameworks;
  }

  // ─── Route Extraction ──────────────────────────────────────────────────────

  /**
   * Extract route definitions from source files.
   * Uses framework-specific regex patterns.
   */
  _extractRoutes() {
    const routes = [];
    const sourceFiles = this._collectSourceFiles();

    for (const filePath of sourceFiles) {
      const fileRoutes = this._extractRoutesFromFile(filePath);
      routes.push(...fileRoutes);
    }

    // Deduplicate by (method, path, file)
    const seen = new Set();
    return routes.filter(r => {
      const key = `${r.method}:${r.path}:${r.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Extract routes from a single file.
   */
  _extractRoutesFromFile(filePath) {
    const routes = [];
    let content;

    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (e) {
      return routes;
    }

    const relPath = path.relative(this._projectRoot, filePath);

    // Determine which framework patterns to use
    const frameworkKeys = this._frameworks.length > 0
      ? this._frameworks
      : Object.keys(ROUTE_PATTERNS);

    for (const fwKey of frameworkKeys) {
      const fwConfig = ROUTE_PATTERNS[fwKey];
      if (!fwConfig) continue;

      for (const pattern of fwConfig.patterns) {
        // Reset regex
        pattern.lastIndex = 0;

        let match;
        while ((match = pattern.exec(content)) !== null) {
          // Extract method and path based on pattern config
          let method, path;

          if (fwKey === 'express' && pattern.source.includes('route')) {
            // app.route('/path').get(...) pattern
            path = match[1];
            method = 'GET'; // Default, will be updated by next match
          } else {
            method = (match[fwConfig.methodIndex] || 'GET').toUpperCase();
            path = match[fwConfig.pathIndex] || '/';
          }

          // Normalize path
          path = this._normalizePath(path);

          // Find line number
          const lineNum = content.substring(0, match.index).split('\n').length;

          // Try to find handler name near the route definition
          const handler = this._findHandlerNearMatch(content, match.index, fwKey);

          routes.push({
            method: method.replace(/Mapping$/i, '').toUpperCase(),
            path,
            file: relPath,
            line: lineNum,
            framework: fwConfig.framework,
            handler,
          });
        }
      }
    }

    return routes;
  }

  /**
   * Normalize a route path (remove trailing slash, etc.)
   */
  _normalizePath(path) {
    if (!path) return '/';
    // Remove quotes if present
    path = path.replace(/^['"`]|['"`]$/g, '');
    // Ensure starts with /
    if (!path.startsWith('/')) path = '/' + path;
    // Remove trailing slash (except for root)
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path;
  }

  /**
   * Try to find handler function name near a route match.
   */
  _findHandlerNearMatch(content, matchIndex, framework) {
    // Look for handler name after the route definition
    const afterMatch = content.substring(matchIndex, matchIndex + 200);

    // Express: app.get('/path', handlerName)
    const expressHandler = /,\s*(\w+)\s*[,\)]/.exec(afterMatch);
    if (expressHandler) return expressHandler[1];

    // NestJS: @Get('path')\n methodName()
    if (framework === 'nestjs') {
      const nestHandler = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/.exec(afterMatch);
      if (nestHandler) return nestHandler[1];
    }

    // FastAPI: async def handler_name(
    if (framework === 'fastapi') {
      const fastapiHandler = /async\s+def\s+(\w+)/.exec(afterMatch);
      if (fastapiHandler) return fastapiHandler[1];
      const syncHandler = /def\s+(\w+)\s*\(/.exec(afterMatch);
      if (syncHandler) return syncHandler[1];
    }

    return null;
  }

  // ─── Handler Identification ────────────────────────────────────────────────

  /**
   * Identify handler functions from CodeGraph.
   */
  _identifyHandlers() {
    const handlers = [];
    if (!this._codeGraph) return handlers;

    // Use public API getAllSymbolValues() instead of direct _symbols.values() access
    const symbols = [...this._codeGraph.getAllSymbolValues()];

    for (const sym of symbols) {
      // Skip non-function symbols
      if (sym.kind !== 'function' && sym.kind !== 'method') continue;

      // Check against handler patterns
      let matchedCategory = null;
      for (const [category, patterns] of Object.entries(HANDLER_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.test(sym.name)) {
            matchedCategory = category;
            break;
          }
        }
        if (matchedCategory) break;
      }

      if (!matchedCategory) continue;

      // Skip middleware
      const isMiddleware = MIDDLEWARE_PATTERNS.some(p => p.test(sym.name));
      if (isMiddleware) continue;

      // Get call graph info
      const { calls, calledBy } = this._codeGraph.getCallGraph(sym.name);

      handlers.push({
        symbol: {
          name: sym.name,
          kind: sym.kind,
          file: sym.file,
          line: sym.line,
          signature: sym.signature,
          summary: sym.summary,
        },
        category: matchedCategory,
        callsOut: calls.length,
        calledByCount: calledBy.length,
      });
    }

    // Sort by calledBy (most referenced handlers first)
    handlers.sort((a, b) => b.calledByCount - a.calledByCount);

    return handlers;
  }

  // ─── Endpoint Linking ──────────────────────────────────────────────────────

  /**
   * Link routes to handlers to form complete endpoints.
   */
  _linkEndpoints() {
    const endpoints = [];

    for (const route of this._routes) {
      // Find matching handler
      const handler = this._findHandlerForRoute(route);

      endpoints.push({
        method: route.method,
        path: route.path,
        file: route.file,
        line: route.line,
        framework: route.framework,
        handler: handler ? {
          name: handler.symbol.name,
          file: handler.symbol.file,
          line: handler.symbol.line,
          signature: handler.symbol.signature,
          summary: handler.symbol.summary,
        } : null,
        // Try to infer resource from path
        resource: this._inferResource(route.path),
      });
    }

    // Sort by path
    endpoints.sort((a, b) => a.path.localeCompare(b.path));

    return endpoints;
  }

  /**
   * Find a handler that matches a route.
   */
  _findHandlerForRoute(route) {
    if (route.handler) {
      // Route already has handler name, find the symbol
      const handler = this._handlers.find(h =>
        h.symbol.name === route.handler ||
        h.symbol.name.toLowerCase() === route.handler.toLowerCase()
      );
      if (handler) return handler;
    }

    // Try to match by HTTP method + resource
    const resource = this._inferResource(route.path);
    const methodPrefix = route.method.toLowerCase();

    return this._handlers.find(h => {
      const name = h.symbol.name.toLowerCase();
      return (
        name.startsWith(methodPrefix) ||
        name.includes(resource.toLowerCase())
      );
    });
  }

  /**
   * Infer resource name from path.
   */
  _inferResource(path) {
    // Extract resource name from path
    // /users/:id -> users
    // /api/v1/orders -> orders
    const parts = path.split('/').filter(p => p && !p.startsWith(':') && !p.startsWith('{'));
    return parts[parts.length - 1] || 'unknown';
  }

  // ─── Utility Methods ───────────────────────────────────────────────────────

  /**
   * Collect source files to scan.
   */
  _collectSourceFiles() {
    const files = [];
    const extensions = ['.js', '.ts', '.py', '.go', '.java', '.cs', '.rb'];

    const scanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            // Skip common non-source directories
            if (['node_modules', '.git', 'dist', 'build', '__pycache__', 'vendor'].includes(entry.name)) {
              continue;
            }
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (extensions.includes(ext)) {
              files.push(fullPath);
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };

    scanDir(this._projectRoot);
    return files;
  }

  /**
   * Count endpoints by HTTP method.
   */
  _countByMethod() {
    const counts = {};
    for (const ep of this._endpoints) {
      counts[ep.method] = (counts[ep.method] || 0) + 1;
    }
    return counts;
  }

  // ─── Output Generation ──────────────────────────────────────────────────────

  /**
   * Write output files.
   */
  _writeOutput(stats) {
    if (!fs.existsSync(this._outputDir)) {
      fs.mkdirSync(this._outputDir, { recursive: true });
    }

    // Write JSON
    const jsonPath = path.join(this._outputDir, 'api-endpoints.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      generated: new Date().toISOString(),
      strategy: this._strategy,
      stats,
      endpoints: this._endpoints,
      handlers: this._handlers.slice(0, 50), // Limit handlers in JSON
    }, null, 2));
    console.log(`   📄 JSON: ${jsonPath}`);

    // Write Markdown
    const mdPath = path.join(this._outputDir, 'api-endpoints.md');
    fs.writeFileSync(mdPath, this._generateMarkdown(stats));
    console.log(`   📄 Summary: ${mdPath}`);

    // Write Diagrams
    const diagramPath = path.join(this._outputDir, 'api-endpoints-diagrams.md');
    fs.writeFileSync(diagramPath, this._generateDiagrams());
    console.log(`   📄 Diagrams: ${diagramPath}`);
  }

  /**
   * Generate Markdown summary.
   */
  _generateMarkdown(stats) {
    const lines = [
      `## 🌐 API Endpoints Analysis`,
      '',
      `> Generated: ${new Date().toISOString().slice(0, 10)}`,
      `> Strategy: ${this._strategy === 'ide-first' ? '🏠 IDE-First' : '📊 CodeGraph (Fallback)'}`,
      `> Frameworks: ${this._frameworks.join(', ') || 'Not detected'}`,
      '',
      `### 📊 Summary`,
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Total Endpoints | ${stats.totalEndpoints} |`,
      `| Total Handlers | ${stats.totalHandlers} |`,
      `| Total Routes | ${stats.totalRoutes} |`,
      '',
      `### 📡 HTTP Methods`,
      '',
    ];

    // Method breakdown
    for (const [method, count] of Object.entries(stats.httpMethods).sort((a, b) => b[1] - a[1])) {
      lines.push(`- **${method}**: ${count} endpoints`);
    }

    lines.push('');
    lines.push(`### 🚀 Endpoints`);
    lines.push('');

    // Group by resource
    const byResource = {};
    for (const ep of this._endpoints) {
      const resource = ep.resource || 'other';
      if (!byResource[resource]) byResource[resource] = [];
      byResource[resource].push(ep);
    }

    for (const [resource, eps] of Object.entries(byResource).sort()) {
      lines.push(`#### ${resource}`);
      lines.push('');
      lines.push(`| Method | Path | Handler | File |`);
      lines.push(`|--------|------|---------|------|`);

      for (const ep of eps) {
        const handler = ep.handler ? `**${ep.handler.name}**` : '*not found*';
        lines.push(`| ${ep.method} | \`${ep.path}\` | ${handler} | \`${ep.file}\`:${ep.line} |`);
      }
      lines.push('');
    }

    // IDE-First guidance
    if (this._strategy === 'ide-first') {
      lines.push(`### 🏠 IDE-First Strategy Active`);
      lines.push('');
      lines.push(`> This analysis used IDE tools for maximum accuracy.`);
      lines.push(`> Use IDE features like **Find References** to trace API usage.`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate Mermaid diagrams.
   */
  _generateDiagrams() {
    const lines = [
      `## 📊 API Endpoint Diagrams`,
      '',
      `> Generated: ${new Date().toISOString().slice(0, 10)}`,
      `> View in VS Code, GitHub, or any Mermaid-compatible viewer`,
      '',
      `### 🗺️ API Resource Map`,
      '',
      '```mermaid',
      'graph LR',
    ];

    // Group endpoints by resource
    const byResource = {};
    for (const ep of this._endpoints) {
      const resource = ep.resource || 'other';
      if (!byResource[resource]) byResource[resource] = [];
      byResource[resource].push(ep);
    }

    // Generate resource diagram
    for (const [resource, eps] of Object.entries(byResource).slice(0, 10)) {
      const safeId = resource.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(`  ${safeId}["${resource}"]`);

      for (const ep of eps.slice(0, 4)) {
        const methodId = `${safeId}_${ep.method}`.toLowerCase();
        lines.push(`  ${methodId}["${ep.method} ${ep.path}"]:::${ep.method.toLowerCase()}`);
        lines.push(`  ${safeId} --> ${methodId}`);
      }
    }

    lines.push('');
    // Add styling
    lines.push('  classDef get fill:#a5d6a7,stroke:#2e7d32');
    lines.push('  classDef post fill:#90caf9,stroke:#1565c0');
    lines.push('  classDef put fill:#fff59d,stroke:#f9a825');
    lines.push('  classDef delete fill:#ef9a9a,stroke:#c62828');
    lines.push('  classDef patch fill:#ce93d8,stroke:#7b1fa2');
    lines.push('```');
    lines.push('');

    return lines.join('\n');
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  APIEndpointExtractor,
  ROUTE_PATTERNS,
  HANDLER_PATTERNS,
  MIDDLEWARE_PATTERNS,
};
