/**
 * Structural Fingerprint Engine – Fine-Grained Change Detection
 * 
 * ADR-XX (P0 Fingerprint System): Structural fingerprinting for precise
 * incremental build decisions. Goes beyond mtime to detect:
 *   - Formatting-only changes (skip rebuild)
 *   - Comment-only changes (skip rebuild)  
 *   - Function signature changes (trigger rebuild)
 *   - API breaking changes (trigger architecture analysis)
 * 
 * Design Principles:
 *   1. Content hash + AST hash combined fingerprint
 *   2. Multi-level granularity: file -> function -> signature
 *   3. Persistent cache with schema versioning
 *   4. Dual-mode: tree-sitter when available, regex fallback
 * 
 * @module fingerprint-engine
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Import tree-sitter adapter if available
let treeSitterAdapter = null;
try {
  treeSitterAdapter = require('./tree-sitter-adapter');
} catch (err) {
  console.log('[FingerprintEngine] Tree-sitter adapter not available, using regex fallback');
}

// Schema version for cache invalidation
const FINGERPRINT_SCHEMA_VERSION = 1;

// Change classification thresholds
const CHANGE_THRESHOLDS = {
  FORMAT_ONLY: 0,      // content hash changed, ast hash same
  SIGNATURE: 1,        // ast hash changed
  MAJOR_API: 2,        // exported public API changed
  UNKNOWN: 3,
};

/**
 * Fingerprint Engine – manages structural fingerprints for a project
 */
class FingerprintEngine {
  /**
   * @param {object} options
   * @param {string} options.projectRoot - Project root directory
   * @param {string} options.cacheDir - Directory for fingerprint cache
   * @param {boolean} [options.useTreeSitter=true] - Enable tree-sitter when available
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.cacheDir = options.cacheDir || path.join(this.projectRoot, '.workflow');
    this.useTreeSitter = options.useTreeSitter !== false && treeSitterAdapter !== null;
    
    // Runtime cache of fingerprints
    this.fingerprints = new Map(); // filepath -> fingerprint
    this.cacheLoaded = false;
    
    // Tree-sitter availability check
    this.treeSitterAvailable = this.useTreeSitter && 
      treeSitterAdapter && 
      treeSitterAdapter.testAvailability();
  }

  /**
   * Enable tree-sitter usage (lazy initialization)
   */
  enableTreeSitter() {
    if (treeSitterAdapter && treeSitterAdapter.testAvailability()) {
      this.useTreeSitter = true;
      this.treeSitterAvailable = true;
      console.log('[FingerprintEngine] Tree-sitter enabled');
    } else {
      console.warn('[FingerprintEngine] Tree-sitter not available');
    }
  }

  /**
   * Generate or retrieve fingerprint for a file
   * @param {string} filePath - Absolute file path
   * @returns {object} Fingerprint object
   */
  fingerprint(filePath) {
    const relPath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
    
    // Check runtime cache
    if (this.fingerprints.has(relPath)) {
      return this.fingerprints.get(relPath);
    }
    
    // Generate new fingerprint
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath);
      
      const fp = this.generateFingerprint(content, ext, relPath);
      this.fingerprints.set(relPath, fp);
      return fp;
    } catch (err) {
      return this.createEmptyFingerprint(relPath, err.message);
    }
  }

  /**
   * Generate fingerprint from content
   * @param {string} content - File content
   * @param {string} ext - File extension
   * @param {string} relPath - Relative file path (for metadata)
   * @returns {object}
   */
  generateFingerprint(content, ext, relPath) {
    const contentHash = this.computeHash(content);
    
    // Try tree-sitter first if available and enabled
    if (this.treeSitterAvailable && treeSitterAdapter && treeSitterAdapter.isSupported(ext)) {
      try {
        const result = treeSitterAdapter.parseFile(content, relPath, ext);
        
        if (result.usedAST && result.fingerprint.astHash) {
          return {
            relPath,
            contentHash,
            astHash: result.fingerprint.astHash,
            structureFingerprint: result.fingerprint.structureFingerprint,
            symbols: result.symbols,
            symbolCount: result.symbols.length,
            exports: result.symbols.filter(s => this.isExportedSymbol(s, content)).map(s => s.name),
            parser: 'tree-sitter',
            timestamp: Date.now(),
          };
        }
      } catch (err) {
        console.warn(`[FingerprintEngine] Tree-sitter failed for ${relPath}: ${err.message}`);
      }
    }
    
    // Fallback: regex-based fingerprint
    return this.generateRegexFingerprint(content, ext, relPath, contentHash);
  }

  /**
   * Generate regex-based fallback fingerprint
   */
  generateRegexFingerprint(content, ext, relPath, contentHash) {
    const symbols = this.extractSymbolsWithRegex(content, ext);
    
    // Generate simple structure hash from symbol names
    const symbolNames = symbols.map(s => `${s.kind}:${s.name}`).sort().join(',');
    const astHash = this.computeHash(symbolNames);
    
    return {
      relPath,
      contentHash,
      astHash,
      structureFingerprint: `${contentHash.slice(0, 8)}:${astHash.slice(0, 8)}`,
      symbols,
      symbolCount: symbols.length,
      exports: symbols.filter(s => s.isExport).map(s => s.name),
      parser: 'regex',
      timestamp: Date.now(),
    };
  }

  /**
   * Extract symbols using regex (fallback method)
   */
  extractSymbolsWithRegex(content, ext) {
    const symbols = [];
    const lines = content.split('\n');
    
    const patterns = this.getRegexPatterns(ext);
    if (!patterns) return symbols;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (match) {
          symbols.push({
            name: match.groups?.name || match[1],
            kind: pattern.kind,
            line: i + 1,
            signature: line.trim().slice(0, 100),
            isExport: line.includes('export') || line.includes('public'),
          });
        }
      }
    }
    
    return symbols;
  }

  /**
   * Get regex patterns for a language
   */
  getRegexPatterns(ext) {
    const patterns = {
      '.js': [
        { regex: /\bfunction\s+(?<name>\w+)/, kind: 'function' },
        { regex: /\bclass\s+(?<name>\w+)/, kind: 'class' },
        { regex: /\bconst\s+(?<name>\w+)\s*=/, kind: 'const' },
      ],
      '.ts': [
        { regex: /\bfunction\s+(?<name>\w+)/, kind: 'function' },
        { regex: /\bclass\s+(?<name>\w+)/, kind: 'class' },
        { regex: /\binterface\s+(?<name>\w+)/, kind: 'interface' },
      ],
      '.py': [
        { regex: /\bdef\s+(?<name>\w+)/, kind: 'function' },
        { regex: /\bclass\s+(?<name>\w+)/, kind: 'class' },
      ],
      '.go': [
        { regex: /\bfunc\s+(?:\([^)]+\)\s+)?(?<name>\w+)/, kind: 'function' },
        { regex: /\btype\s+(?<name>\w+)\s+struct/, kind: 'class' },
      ],
      '.cs': [
        { regex: /\bclass\s+(?<name>\w+)/, kind: 'class' },
        { regex: /\binterface\s+(?<name>\w+)/, kind: 'interface' },
      ],
    };
    
    return patterns[ext] || null;
  }

  /**
   * Check if a symbol is exported (public API)
   */
  isExportedSymbol(symbol, content) {
    const lines = content.split('\n');
    const line = lines[symbol.line - 1] || '';
    return line.includes('export') || 
           line.includes('public') ||
           /^[A-Z]/.test(symbol.name); // Convention: capitalized = exported
  }

  /**
   * Compute SHA-256 hash (truncated)
   */
  computeHash(content) {
    return crypto
      .createHash('sha256')
      .update(typeof content === 'string' ? content : JSON.stringify(content))
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Create empty fingerprint for error cases
   */
  createEmptyFingerprint(relPath, error) {
    return {
      relPath,
      contentHash: '',
      astHash: null,
      structureFingerprint: '',
      symbols: [],
      symbolCount: 0,
      exports: [],
      parser: 'error',
      error,
      timestamp: Date.now(),
    };
  }

  /**
   * Classify the type of change between two fingerprints
   * @param {object} oldFp - Previous fingerprint
   * @param {object} newFp - Current fingerprint
   * @returns {string} Change type: 'unchanged' | 'format' | 'signature' | 'api_breaking'
   */
  classifyChange(oldFp, newFp) {
    if (!oldFp || !oldFp.contentHash) return 'signature';
    if (oldFp.contentHash === newFp.contentHash) return 'unchanged';
    
    // Content changed but AST same -> formatting/comment change
    if (oldFp.astHash && newFp.astHash && oldFp.astHash === newFp.astHash) {
      return 'format';
    }
    
    // AST changed - check if it's API breaking
    const oldExports = new Set(oldFp.exports || []);
    const newExports = new Set(newFp.exports || []);
    
    // Check for removed exports (API breaking)
    for (const exp of oldExports) {
      if (!newExports.has(exp)) {
        return 'api_breaking';
      }
    }
    
    // Check for signature changes in exported symbols
    const oldSymbolMap = new Map((oldFp.symbols || []).map(s => [s.name, s]));
    for (const newSym of newFp.symbols || []) {
      if (newExports.has(newSym.name)) {
        const oldSym = oldSymbolMap.get(newSym.name);
        if (oldSym && oldSym.signature !== newSym.signature) {
          return 'api_breaking';
        }
      }
    }
    
    return 'signature';
  }

  /**
   * Detect changed files with classification
   * @param {string[]} filePaths - Absolute file paths to check
   * @returns {object} Classified changes
   */
  detectChanges(filePaths) {
    const changes = {
      unchanged: [],
      format: [],      // Formatting only - can skip
      signature: [],   // Internal changes - partial rebuild
      api_breaking: [], // Public API changed - major rebuild
    };
    
    const cache = this.loadCache();
    
    for (const filePath of filePaths) {
      const relPath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
      const newFp = this.fingerprint(filePath);
      const oldFp = cache[relPath];
      
      const changeType = this.classifyChange(oldFp, newFp);
      changes[changeType].push(relPath);
    }
    
    return changes;
  }

  /**
   * Get rebuild recommendation based on changes
   * @param {object} changes - From detectChanges()
   * @returns {object} Recommendation
   */
  getRebuildRecommendation(changes) {
    const totalChanged = changes.signature.length + changes.api_breaking.length;
    const totalFiles = Object.values(changes).reduce((a, b) => a + b.length, 0);
    
    if (totalChanged === 0) {
      return {
        action: 'skip',
        reason: 'Only formatting changes detected',
        affectedFiles: [],
      };
    }
    
    if (changes.api_breaking.length > 0) {
      return {
        action: 'architecture_update',
        reason: `${changes.api_breaking.length} files have API-breaking changes`,
        affectedFiles: [...changes.api_breaking, ...changes.signature],
        apiBreakingFiles: changes.api_breaking,
      };
    }
    
    if (totalChanged > 30 || totalChanged / totalFiles > 0.5) {
      return {
        action: 'full_update',
        reason: `Major refactor detected (${totalChanged} files changed)`,
        affectedFiles: changes.signature,
      };
    }
    
    return {
      action: 'partial_update',
      reason: `${changes.signature.length} files with signature changes`,
      affectedFiles: changes.signature,
    };
  }

  /**
   * Load fingerprint cache from disk
   * @returns {object}
   */
  loadCache() {
    if (this.cacheLoaded) {
      return this._diskCache || {};
    }
    
    const cachePath = path.join(this.cacheDir, '.structural-fingerprints.json');
    
    try {
      if (fs.existsSync(cachePath)) {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        
        // Version check
        if (data.schemaVersion !== FINGERPRINT_SCHEMA_VERSION) {
          console.log('[FingerprintEngine] Cache schema mismatch, rebuilding');
          this._diskCache = {};
        } else {
          this._diskCache = data.fingerprints || {};
        }
      } else {
        this._diskCache = {};
      }
    } catch (err) {
      console.warn(`[FingerprintEngine] Failed to load cache: ${err.message}`);
      this._diskCache = {};
    }
    
    this.cacheLoaded = true;
    return this._diskCache;
  }

  /**
   * Save fingerprint cache to disk
   */
  saveCache() {
    const cachePath = path.join(this.cacheDir, '.structural-fingerprints.json');
    
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      
      const cache = this.loadCache();
      
      // Merge runtime fingerprints into cache
      for (const [relPath, fp] of this.fingerprints) {
        cache[relPath] = fp;
      }
      
      const data = {
        schemaVersion: FINGERPRINT_SCHEMA_VERSION,
        savedAt: new Date().toISOString(),
        projectRoot: this.projectRoot,
        fingerprints: cache,
      };
      
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
      console.log(`[FingerprintEngine] Cache saved: ${Object.keys(cache).length} fingerprints`);
    } catch (err) {
      console.warn(`[FingerprintEngine] Failed to save cache: ${err.message}`);
    }
  }

  /**
   * Update fingerprints for specific files (after rebuild)
   * @param {string[]} relPaths - Relative file paths
   */
  updateFingerprints(relPaths) {
    const cache = this.loadCache();
    
    for (const relPath of relPaths) {
      const filePath = path.join(this.projectRoot, relPath);
      if (fs.existsSync(filePath)) {
        const fp = this.fingerprint(filePath);
        cache[relPath] = fp;
        this.fingerprints.set(relPath, fp);
      } else {
        delete cache[relPath];
        this.fingerprints.delete(relPath);
      }
    }
    
    this.saveCache();
  }

  /**
   * Get statistics about the fingerprint coverage
   */
  getStats() {
    const cache = this.loadCache();
    const fingerprints = Object.values(cache);
    
    return {
      totalFiles: fingerprints.length,
      treeSitterFiles: fingerprints.filter(fp => fp.parser === 'tree-sitter').length,
      regexFiles: fingerprints.filter(fp => fp.parser === 'regex').length,
      totalSymbols: fingerprints.reduce((sum, fp) => sum + (fp.symbolCount || 0), 0),
      avgSymbolsPerFile: fingerprints.length > 0 
        ? Math.round(fingerprints.reduce((sum, fp) => sum + (fp.symbolCount || 0), 0) / fingerprints.length)
        : 0,
    };
  }
}

module.exports = {
  FingerprintEngine,
  CHANGE_THRESHOLDS,
};