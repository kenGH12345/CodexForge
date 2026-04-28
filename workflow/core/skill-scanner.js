/**
 * Skill Scanner — Source code tree scanner for skill generation
 *
 * Recursively scans a project directory, classifies files by programming language,
 * and returns a structured summary suitable for downstream pattern extraction.
 *
 * Design principles:
 *   - Zero LLM calls: pure Node.js fs operations only
 *   - Safe: never reads binary files, .env, or secrets
 *   - Bounded: maxFiles cap prevents runaway scanning on large projects
 *   - Deterministic: sorted output for reproducible skill generation
 *
 * @module workflow/core/skill-scanner
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Language Detection Map
// ─────────────────────────────────────────────────────────────────────────────

const EXT_TO_LANGUAGE = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.lua': 'lua',
  '.cs': 'csharp',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.h': 'cpp',
  '.c': 'c',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.r': 'r',
  '.sql': 'sql',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.ps1': 'powershell',
  '.md': 'markdown',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'css', '.less': 'css',
};

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.svn', '.hg',
  'build', 'dist', 'out', 'target', 'bin', 'obj',
  '.next', '.nuxt', '.vuepress', '.docusaurus',
  'coverage', '.coverage', 'test-reports',
  '.idea', '.vscode', '.vs',
  '.DS_Store', 'Thumbs.db',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  'vendor', 'third_party', 'third-party', '3rdparty',
  '.env', '.env.local', '.env.*',
  '*.min.js', '*.min.css', '*.bundle.js',
  '*.log', '*.lock',
  '.github', '.gitlab', '.circleci',
  '.codebuddy', '.cursor', '.claude', '.aider', '.workflow',
  'node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
];

const DOT_HIDDEN_DIRS = new Set([
  '.git', '.hg', '.svn',
  '.next', '.nuxt',
  '__pycache__',
  '.codebuddy', '.cursor', '.claude', '.aider', '.workflow',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan a project directory and return a structured result.
 *
 * @param {string} projectRoot  - Absolute path to project root
 * @param {object} [options]
 * @param {number} [options.maxFiles=1000]     - Max files to catalog
 * @param {string[]} [options.excludePatterns] - Additional exclude globs
 * @param {string[]} [options.includeLanguages] - Only scan these languages (empty = all)
 * @returns {Promise<ScanResult>}
 */
async function scanDirectory(projectRoot, options = {}) {
  const {
    maxFiles = 1000,
    excludePatterns = [],
    includeLanguages = [],
    fileList = null,
  } = options;

  const result = {
    projectRoot,
    primaryLanguage: null,
    secondaryLanguages: [],
    allLanguages: [],
    files: [],
    fileCount: 0,
    directoryCount: 0,
    truncated: false,
  };

  const excludedNames = new Set([...DEFAULT_EXCLUDES, ...excludePatterns]);
  const fileStats = [];

  // ── Pre-scanned file list mode (skip recursive directory walk) ───────────
  if (fileList && fileList.length > 0) {
    for (const item of fileList) {
      if (fileStats.length >= maxFiles) {
        result.truncated = true;
        break;
      }
      const filePath = typeof item === 'string' ? item : (item.filePath || item);
      const name = path.basename(filePath);
      if (_shouldSkipFile(name)) continue;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size > 5 * 1024 * 1024) continue; // Skip files > 5MB
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
        const ext = path.extname(name).toLowerCase();
        const language = EXT_TO_LANGUAGE[ext] || null;
        const lineCount = _estimateLineCount(filePath);
        fileStats.push({
          relativePath: relPath,
          absolutePath: filePath,
          language,
          size: stats.size,
          lineCount,
          mtimeMs: stats.mtimeMs,
        });
      } catch (err) {
        // Skip unreadable files silently
      }
    }
  } else {
    await _scanRecursive(projectRoot, '', 0);
  }

  if (fileStats.length > maxFiles) {
    result.truncated = true;
    // Sort by mtime desc, keep most recently modified files
    fileStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    fileStats.length = maxFiles;
  }

  // Sort by path for deterministic output
  fileStats.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const langCounts = new Map();
  for (const f of fileStats) {
    result.files.push({
      relativePath: f.relativePath,
      absolutePath: f.absolutePath,
      language: f.language,
      size: f.size,
      lineCount: f.lineCount,
    });
    if (f.language) {
      langCounts.set(f.language, (langCounts.get(f.language) || 0) + 1);
    }
  }

  result.fileCount = result.files.length;

  const sortedLangs = [...langCounts.entries()].sort((a, b) => b[1] - a[1]);
  result.allLanguages = sortedLangs.map(([lang]) => lang);

  if (sortedLangs.length > 0) {
    result.primaryLanguage = sortedLangs[0][0];
    result.secondaryLanguages = sortedLangs.slice(1).map(([lang]) => lang);
  }

  if (includeLanguages.length > 0) {
    const allowed = new Set(includeLanguages.map(l => l.toLowerCase()));
    result.files = result.files.filter(f => !f.language || allowed.has(f.language.toLowerCase()));
    result.allLanguages = result.allLanguages.filter(l => allowed.has(l.toLowerCase()));
    if (result.primaryLanguage && !allowed.has(result.primaryLanguage.toLowerCase())) {
      result.primaryLanguage = result.secondaryLanguages.find(l => allowed.has(l.toLowerCase())) || null;
    }
    result.secondaryLanguages = result.secondaryLanguages.filter(l => allowed.has(l.toLowerCase()));
    result.fileCount = result.files.length;
  }

  return result;

  // ── Recursive walker ──────────────────────────────────────────────────────
  async function _scanRecursive(absDir, relDir, depth) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[SkillScanner] ⚠️  Cannot read directory: ${absDir} — ${err.message}`);
      }
      return;
    }

    for (const entry of entries) {
      if (fileStats.length >= maxFiles) {
        result.truncated = true;
        return;
      }

      const name = entry.name;
      if (name.startsWith('.') && DOT_HIDDEN_DIRS.has(name)) continue;
      if (excludedNames.has(name)) continue;
      if (DEFAULT_EXCLUDES.some(p => _matchGlob(name, p))) continue;

      const absPath = path.join(absDir, name);
      const relPath = relDir ? path.join(relDir, name) : name;

      if (entry.isDirectory()) {
        result.directoryCount++;
        await _scanRecursive(absPath, relPath, depth + 1);
      } else if (entry.isFile()) {
        if (_shouldSkipFile(name)) continue;
        if (fs.statSync(absPath).size > 5 * 1024 * 1024) continue; // Skip files > 5MB

        const ext = path.extname(name).toLowerCase();
        const language = EXT_TO_LANGUAGE[ext] || null;
        const stats = fs.statSync(absPath);
        const lineCount = _estimateLineCount(absPath);

        fileStats.push({
          relativePath: relPath,
          absolutePath: absPath,
          language,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          lineCount,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _shouldSkipFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.env') || lower.includes('.env.')) return true;
  if (lower.endsWith('.key') || lower.endsWith('.pem') || lower.endsWith('.pfx')) return true;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return true;
  if (lower.endsWith('.lock') || lower.endsWith('-lock.json')) return true;
  if (lower.endsWith('.log')) return true;
  if (name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml') return true;
  return false;
}

function _matchGlob(name, pattern) {
  if (!pattern.includes('*')) return name === pattern;
  if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

function _estimateLineCount(filePath) {
  try {
    // Read first 64KB to estimate line count (fast heuristic)
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buffer, 0, 65536, 0);
    fs.closeSync(fd);
    const sample = buffer.toString('utf-8', 0, bytesRead);
    const newlines = sample.split('\n').length;
    if (bytesRead < 65536) return newlines;
    // Extrapolate from sample
    const fileSize = fs.statSync(filePath).size;
    return Math.round(newlines * (fileSize / bytesRead));
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  scanDirectory,
  EXT_TO_LANGUAGE,
  DEFAULT_EXCLUDES,
};
