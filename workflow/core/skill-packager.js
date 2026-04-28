/**
 * Skill Packager — Repomix-inspired code bundler for LLM context windows.
 * Packages source code into an LLM-ready context string, grouped by module boundary,
 * with hotspot-based prioritization and token budget management.
 */

const fs = require('fs');
const path = require('path');

const CHARS_PER_TOKEN = 4;

const DEFAULT_CONFIG = {
  maxFiles: 1000,
  maxTokensTotal: 8000,
  maxTokensPerModule: 2000,
  hotspotThreshold: 0.5,
  priorityModules: [],
  extensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rb', '.php', '.lua', '.proto', '.swift']
};

async function loadContext(projectRoot) {
  const codeGraphPath = path.join(projectRoot, 'output', 'code-graph.json');
  const businessLogicPath = path.join(projectRoot, 'output', 'business-logic.json');
  const apiEndpointsPath = path.join(projectRoot, 'output', 'api-endpoints.json');

  let codeGraph = { modules: {}, hotspots: [], reusableSymbols: [], filesByModule: {} };
  let businessLogic = {};
  let apiEndpoints = [];

  try {
    if (fs.existsSync(codeGraphPath)) {
      const raw = fs.readFileSync(codeGraphPath, 'utf-8');
      codeGraph = JSON.parse(raw);
    }
  } catch (_) { /* ignore */ }

  try {
    if (fs.existsSync(businessLogicPath)) {
      const raw = fs.readFileSync(businessLogicPath, 'utf-8');
      businessLogic = JSON.parse(raw);
    }
  } catch (_) { /* ignore */ }

  try {
    if (fs.existsSync(apiEndpointsPath)) {
      const raw = fs.readFileSync(apiEndpointsPath, 'utf-8');
      apiEndpoints = JSON.parse(raw);
    }
  } catch (_) { /* ignore */ }

  return { codeGraph, businessLogic, apiEndpoints };
}

function scanFiles(projectRoot, config) {
  const files = [];
  const ignoreSet = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage', '.workflow', 'output',
    '.idea', '.vscode', '__pycache__', '.pytest_cache'
  ]);

  function walk(dir, relDir = '') {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) { return; }

    for (const entry of entries) {
      if (ignoreSet.has(entry.name)) continue;

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (config.extensions.includes(ext)) {
          files.push({
            fullPath,
            relPath,
            module: inferModule(relPath),
            size: fs.statSync(fullPath).size,
            ext
          });
        }
      }
    }
  }

  walk(projectRoot);
  return files;
}

function inferModule(relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.length >= 2) {
    const skipRoots = new Set(['src', 'lib', 'app', 'workflow', 'packages', 'components', 'core']);
    let idx = 0;
    if (skipRoots.has(parts[0])) idx = 1;
    if (idx < parts.length - 1) return parts[idx];
  }
  return parts[0] || 'root';
}

function readFileContent(filePath, maxLines = Infinity) {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n// ... (${lines.length - maxLines} lines truncated) ...\n`;
    }
    return content;
  } catch (_) {
    return `// Error reading file: ${filePath}\n`;
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildHotspotMap(codeGraph) {
  const map = new Map();
  if (!codeGraph.hotspots) return map;
  for (const h of codeGraph.hotspots) {
    const key = resolveHotspotKey(h, codeGraph);
    if (key) map.set(key, h.cb || h.refs || h.score || 0);
  }
  return map;
}

function resolveHotspotKey(h, codeGraph) {
  const filePath = codeGraph.filePaths && h.f !== undefined ? codeGraph.filePaths[h.f] : undefined;
  const name = h.n || h.name || h.symbol;
  const fileName = filePath ? path.basename(filePath) : h.file;
  return name ? `${fileName}:${name}` : (filePath || h.file);
}

function packageModule(moduleName, files, hotspotMap, config, usedTokens) {
  const availableTokens = Math.min(
    config.maxTokensPerModule,
    config.maxTokensTotal - usedTokens
  );

  if (availableTokens <= 0) return { context: '', usedTokens: 0, includedFiles: 0, truncated: true };

  const sortedFiles = [...files].sort((a, b) => {
    const scoreA = hotspotMap.get(a.relPath) || hotspotMap.get(path.basename(a.relPath)) || 0;
    const scoreB = hotspotMap.get(b.relPath) || hotspotMap.get(path.basename(b.relPath)) || 0;
    return scoreB - scoreA;
  });

  const lines = [];
  let tokens = 0;
  const includedFiles = [];
  let truncated = false;

  lines.push(`\n## Module: ${moduleName}\n`);

  for (const file of sortedFiles) {
    const hotspotScore = hotspotMap.get(file.relPath) || hotspotMap.get(path.basename(file.relPath)) || 0;
    const isPriority = hotspotScore >= config.hotspotThreshold ||
                       config.priorityModules.includes(moduleName);

    const content = readFileContent(file.fullPath);
    const header = `\`\`\`${file.ext.slice(1)}\n// File: ${file.relPath}\n`;
    const footer = `\n\`\`\`\n`;
    const fileText = header + content + footer;
    const fileTokens = estimateTokens(fileText);

    if (tokens + fileTokens > availableTokens && !isPriority && includedFiles.length > 0) {
      truncated = true;
      break;
    }

    lines.push(fileText);
    tokens += fileTokens;
    includedFiles.push(file.relPath);
  }

  if (truncated) {
    const remaining = sortedFiles.length - includedFiles.length;
    lines.push(`\n// (${remaining} files truncated due to token budget)\n`);
  }

  return {
    context: lines.join(''),
    usedTokens: tokens,
    includedFiles: includedFiles.length,
    totalFiles: files.length,
    truncated
  };
}

async function packageProject(projectRoot, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  const { codeGraph, businessLogic, apiEndpoints } = await loadContext(projectRoot);

  let allFiles;
  const filePaths = codeGraph.filePaths;
  if (Array.isArray(filePaths) && filePaths.length > 0) {
    // Prefer code-graph file list — already indexed, language-complete, no re-scan overhead
    const noiseRe = /\/(output|\.codebuddy|generated|docs|tests?|__tests__|node_modules|dist|build)\//;
    allFiles = filePaths
      .filter(f => !noiseRe.test(f))
      .map(f => {
        const ext = path.extname(f).toLowerCase();
        return {
          fullPath: path.join(projectRoot, f),
          relPath: f,
          module: inferModule(f),
          size: 0,
          ext
        };
      })
      .filter(f => config.extensions.includes(f.ext));
    console.error(`[SkillPackager] Using ${allFiles.length} files from code-graph (skipped file-system scan)`);
  } else {
    allFiles = scanFiles(projectRoot, config);
    console.error(`[SkillPackager] File-system scan: ${allFiles.length} files (code-graph not available)`);
  }

  if (allFiles.length > config.maxFiles) {
    console.error(`[SkillPackager] Truncating from ${allFiles.length} to ${config.maxFiles} files`);
    allFiles = allFiles.slice(0, config.maxFiles);
  }

  const moduleFiles = new Map();
  for (const f of allFiles) {
    if (!moduleFiles.has(f.module)) moduleFiles.set(f.module, []);
    moduleFiles.get(f.module).push(f);
  }

  const hotspotMap = buildHotspotMap(codeGraph);

  let totalTokens = 0;
  const totalContext = [];
  const modules = [];
  let totalIncluded = 0;
  let totalTruncated = 0;

  const sortedModules = Array.from(moduleFiles.keys()).sort((a, b) => {
    const aPriority = config.priorityModules.includes(a);
    const bPriority = config.priorityModules.includes(b);
    if (aPriority !== bPriority) return bPriority - aPriority;
    return moduleFiles.get(b).length - moduleFiles.get(a).length;
  });

  for (const moduleName of sortedModules) {
    const files = moduleFiles.get(moduleName);
    const result = packageModule(moduleName, files, hotspotMap, config, totalTokens);

    if (result.context) {
      totalContext.push(result.context);
      totalTokens += result.usedTokens;
      totalIncluded += result.includedFiles;
      if (result.truncated) totalTruncated++;

      modules.push({
        name: moduleName,
        files: result.includedFiles,
        totalFiles: result.totalFiles,
        hotspotScore: Math.max(...files.map(f => hotspotMap.get(f.relPath) || 0), 0),
        truncated: result.truncated
      });
    }

    if (totalTokens >= config.maxTokensTotal) break;
  }

  const header = [
    `# Project Context: ${path.basename(projectRoot)}`,
    `- Total files scanned: ${allFiles.length}`,
    `- Modules: ${modules.length}`,
    `- Total tokens (estimated): ${totalTokens}`,
    `- Files included: ${totalIncluded}`,
    `- Modules truncated: ${totalTruncated}`,
    '', ''
  ].join('\n');

  const symbolsSection = [];
  const hotspots = codeGraph.hotspots || [];
  if (hotspots.length > 0) {
    symbolsSection.push('\n## Reusable Symbols (High-Frequency Utilities)\n');
  const topReusableSymbols = (codeGraph.reusableSymbols && codeGraph.reusableSymbols.length > 0)
    ? codeGraph.reusableSymbols
    : hotspots.sort((a, b) => (b.cb || 0) - (a.cb || 0)).slice(0, 20);
    for (const sym of topReusableSymbols) {
      const symName = sym.n || sym.name || 'unknown';
      const symType = sym.k || sym.type || 'unknown';
      const refs = sym.cb || sym.refs || 0;
      const filePath = codeGraph.filePaths && sym.f !== undefined ? codeGraph.filePaths[sym.f] : (sym.file || 'N/A');
      const location = filePath !== 'N/A' ? `${filePath}:${sym.l || 0}` : filePath;
      symbolsSection.push(`- **${symName}** (${symType}) — ${refs} refs — ${location}`);
    }
    symbolsSection.push('');
  }

  const bizSection = [];
  if (businessLogic.entryPoints && businessLogic.entryPoints.length > 0) {
    bizSection.push('\n## Business Logic Entry Points\n');
    for (const ep of businessLogic.entryPoints) {
      bizSection.push(`- **${ep.name || ep.file}**: ${ep.description || 'No description'}`);
    }
    bizSection.push('');
  }

  const contextString = header + symbolsSection.join('\n') + bizSection.join('\n') + totalContext.join('\n');

  return {
    contextString,
    tokenEstimate: totalTokens + estimateTokens(header),
    modules: modules.map(m => ({
      name: m.name,
      files: m.files,
      hotspotScore: m.hotspotScore
    })),
    hotspots: codeGraph.hotspots || [],
    reusableSymbols: (codeGraph.hotspots || [])
      .sort((a, b) => (b.cb || 0) - (a.cb || 0))
      .slice(0, 20)
      .map(h => ({
        name: h.n || h.name || 'unknown',
        refs: h.cb || h.refs || 0,
        type: h.k || h.type || 'unknown',
        location: codeGraph.filePaths && h.f !== undefined
          ? `${codeGraph.filePaths[h.f]}:${h.l || 0}`
          : (h.file || 'N/A')
      })),
    businessLogic: businessLogic.entryPoints || [],
    apiEndpoints: apiEndpoints || [],
    truncated: totalTruncated > 0
  };
}

async function dryRun(projectRoot) {
  console.error('[SkillPackager] Running dry-run...');
  const result = await packageProject(projectRoot, { maxFiles: 50, maxTokensTotal: 2000 });
  console.error(`[SkillPackager] Dry-run complete:`);
  console.error(`  - Token estimate: ${result.tokenEstimate}`);
  console.error(`  - Modules: ${result.modules.length}`);
  console.error(`  - Files included: ${result.modules.reduce((s, m) => s + m.files, 0)}`);
  console.error(`  - Truncated: ${result.truncated}`);
  return result;
}

module.exports = {
  packageProject,
  dryRun,
  DEFAULT_CONFIG
};
