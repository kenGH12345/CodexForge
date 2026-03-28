/**
 * ProjectProfiler Helpers
 *
 * File system utilities, caching, and dependency readers for ProjectProfiler.
 * Extracted from project-profiler.js to improve maintainability.
 *
 * @module workflow/core/profiler-helpers
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── File Content Cache ──────────────────────────────────────────────────────
// Per-analysis cache to eliminate redundant disk I/O

let _fileContentCache = new Map();

/**
 * Clears the file content cache.
 * Should be called at the start of each analysis run.
 */
function clearFileContentCache() {
  _fileContentCache = new Map();
}

// ─── File System Helpers ─────────────────────────────────────────────────────

/**
 * Checks if a file exists relative to root.
 * @param {string} root - Root directory path
 * @param {string} relPath - Relative path to check
 * @returns {boolean}
 */
function fileExists(root, relPath) {
  try { return fs.existsSync(path.join(root, relPath)); } catch { return false; }
}

/**
 * Checks if a directory exists relative to root.
 * @param {string} root - Root directory path
 * @param {string} relPath - Relative path to check
 * @returns {boolean}
 */
function dirExists(root, relPath) {
  try {
    const stat = fs.statSync(path.join(root, relPath));
    return stat.isDirectory();
  } catch { return false; }
}

/**
 * Checks if any file in root has a specific extension.
 * @param {string} root - Root directory path
 * @param {string} ext - Extension to check (e.g., '.kt')
 * @returns {boolean}
 */
function hasExt(root, ext) {
  try {
    const entries = fs.readdirSync(root);
    return entries.some(e => e.endsWith(ext));
  } catch { return false; }
}

/**
 * Reads file content with per-analysis caching.
 * Eliminates redundant disk I/O when multiple rules check the same file
 * (e.g. pom.xml read by Spring Boot, Quarkus, Hibernate, MyBatis, JUnit rules).
 *
 * @param {string} root - Root directory path
 * @param {string} relPath - Relative path to file
 * @returns {string} File content or empty string if not found
 */
function readFileContent(root, relPath) {
  const fullPath = path.join(root, relPath);
  if (_fileContentCache.has(fullPath)) return _fileContentCache.get(fullPath);
  try {
    if (!fs.existsSync(fullPath)) {
      _fileContentCache.set(fullPath, '');
      return '';
    }
    const content = fs.readFileSync(fullPath, 'utf-8');
    _fileContentCache.set(fullPath, content);
    return content;
  } catch {
    _fileContentCache.set(fullPath, '');
    return '';
  }
}

// ─── Config File Content Matchers ────────────────────────────────────────────
// Language-specific package/dependency file readers

function goModContains(root, dep) {
  return readFileContent(root, 'go.mod').includes(dep);
}

function pomContains(root, dep) {
  return readFileContent(root, 'pom.xml').toLowerCase().includes(dep.toLowerCase());
}

function gradleContains(root, dep) {
  const content = readFileContent(root, 'build.gradle') + readFileContent(root, 'build.gradle.kts');
  return content.toLowerCase().includes(dep.toLowerCase());
}

function cargoContains(root, dep) {
  return readFileContent(root, 'Cargo.toml').includes(dep);
}

function csprojContains(root, dep) {
  // Check all .csproj files in root and src/
  const dirs = ['.', 'src'];
  for (const dir of dirs) {
    try {
      const dirPath = path.join(root, dir);
      if (!fs.existsSync(dirPath)) continue;
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        if (entry.endsWith('.csproj')) {
          if (readFileContent(dirPath, entry).includes(dep)) return true;
        }
      }
    } catch { /* ignore */ }
  }
  return false;
}

function pubspecContains(root, dep) {
  return readFileContent(root, 'pubspec.yaml').includes(dep);
}

function composerContains(root, dep) {
  return readFileContent(root, 'composer.json').toLowerCase().includes(dep.toLowerCase());
}

function gemfileContains(root, dep) {
  return readFileContent(root, 'Gemfile').toLowerCase().includes(dep.toLowerCase());
}

function mixExsContains(root, dep) {
  return readFileContent(root, 'mix.exs').toLowerCase().includes(dep.toLowerCase());
}

function sbtContains(root, dep) {
  return readFileContent(root, 'build.sbt').toLowerCase().includes(dep.toLowerCase());
}

// ─── Dependency Reader ────────────────────────────────────────────────────────

/**
 * Reads merged dependencies from the project's package manifest.
 * Returns a flat object { packageName: version } for quick lookups.
 *
 * @param {string} root - Root directory path
 * @returns {Object} Merged dependencies object
 */
function readDependencies(root) {
  const deps = {};

  // JavaScript / TypeScript: package.json
  const pkgContent = readFileContent(root, 'package.json');
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      Object.assign(deps, pkg.dependencies || {}, pkg.devDependencies || {});
    } catch { /* ignore */ }
  }

  // Python: requirements.txt / pyproject.toml
  const reqContent = readFileContent(root, 'requirements.txt');
  if (reqContent) {
    try {
      const lines = reqContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const name = trimmed.split(/[>=<!\[]/)[0].trim().toLowerCase();
        if (name) deps[name] = '*';
      }
    } catch { /* ignore */ }
  }

  const pyprojectContent = readFileContent(root, 'pyproject.toml');
  if (pyprojectContent) {
    try {
      // Simple extraction of dependency names from pyproject.toml
      const depSection = pyprojectContent.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (depSection) {
        const depList = depSection[1].match(/"([^"]+)"/g) || [];
        for (const d of depList) {
          const name = d.replace(/"/g, '').split(/[>=<!\[]/)[0].trim().toLowerCase();
          if (name) deps[name] = '*';
        }
      }
    } catch { /* ignore */ }
  }

  // PHP: composer.json
  const composerContent = readFileContent(root, 'composer.json');
  if (composerContent) {
    try {
      const composer = JSON.parse(composerContent);
      Object.assign(deps, composer.require || {}, composer['require-dev'] || {});
    } catch { /* ignore */ }
  }

  // Ruby: Gemfile (simple parsing)
  const gemfileContent = readFileContent(root, 'Gemfile');
  if (gemfileContent) {
    try {
      const gemMatches = gemfileContent.matchAll(/gem\s+['"]([^'"]+)['"]/g);
      for (const match of gemMatches) {
        deps[match[1].toLowerCase()] = '*';
      }
    } catch { /* ignore */ }
  }

  // Go: go.mod (simple parsing)
  const goModContent = readFileContent(root, 'go.mod');
  if (goModContent) {
    try {
      const requireMatches = goModContent.matchAll(/require\s*\(([\s\S]*?)\)/g);
      for (const blockMatch of requireMatches) {
        const lines = blockMatch[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('//')) continue;
          const parts = trimmed.split(/\s+/);
          if (parts[0]) deps[parts[0]] = parts[1] || '*';
        }
      }
      // Also handle single-line require
      const singleRequires = goModContent.matchAll(/require\s+([^\s]+)\s+([^\s]+)/g);
      for (const match of singleRequires) {
        deps[match[1]] = match[2];
      }
    } catch { /* ignore */ }
  }

  // Rust: Cargo.toml (simple parsing)
  const cargoContent = readFileContent(root, 'Cargo.toml');
  if (cargoContent) {
    try {
      const depSection = cargoContent.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
      if (depSection) {
        const lines = depSection[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const name = trimmed.split(/[=\s]/)[0];
          if (name) deps[name] = '*';
        }
      }
    } catch { /* ignore */ }
  }

  // Dart / Flutter: pubspec.yaml
  const pubspecContent = readFileContent(root, 'pubspec.yaml');
  if (pubspecContent) {
    try {
      const depSection = pubspecContent.match(/dependencies:\s*([\s\S]*?)(?:\n\S|$)/);
      if (depSection) {
        const lines = depSection[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const name = trimmed.split(':')[0].trim();
          if (name && !name.startsWith('flutter')) deps[name] = '*';
        }
      }
      const devDepSection = pubspecContent.match(/dev_dependencies:\s*([\s\S]*?)(?:\n\S|$)/);
      if (devDepSection) {
        const lines = devDepSection[1].split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const name = trimmed.split(':')[0].trim();
          if (name) deps[name] = '*';
        }
      }
    } catch { /* ignore */ }
  }

  return deps;
}

// ─── Gather Config Content ────────────────────────────────────────────────────

/**
 * Gathers content from common config files for keyword searching.
 * @param {string} root - Root directory path
 * @returns {string} Combined lowercase content
 */
function gatherConfigContent(root) {
  const configFiles = [
    '.env', '.env.example', '.env.development', '.env.local',
    'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
    'ormconfig.json', 'ormconfig.js',
    'prisma/schema.prisma',
    'knexfile.js', 'knexfile.ts',
  ];
  let content = '';
  for (const f of configFiles) {
    content += readFileContent(root, f).toLowerCase() + '\n';
  }
  return content;
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Cache management
  clearFileContentCache,

  // File system helpers
  fileExists,
  dirExists,
  hasExt,
  readFileContent,

  // Config file matchers
  goModContains,
  pomContains,
  gradleContains,
  cargoContains,
  csprojContains,
  pubspecContains,
  composerContains,
  gemfileContains,
  mixExsContains,
  sbtContains,

  // Dependency reader
  readDependencies,

  // Config gathering
  gatherConfigContent,
};
