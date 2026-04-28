/**
 * Pattern Extractor — Source code pattern extraction for skill generation
 *
 * Extracts three signal types from source files:
 *   1. apiSurface    — Exported/public APIs (functions, classes, constants)
 *   2. pattern       — Recurring design patterns (factory, singleton, event helper, etc.)
 *   3. pitfall       — TODO/FIXME/HACK/BUG comments and known traps
 *
 * Architecture:
 *   - Router by language → strategy function
 *   - Each strategy returns raw signal objects
 *   - Post-processing: deduplicate, score confidence, sort
 *
 * Design principles:
 *   - Regex-first, AST-fallback: zero new dependencies
 *   - Confidence scoring: every signal is scored 0.0-1.0
 *   - Extraction method transparency: 'ast' | 'regex'
 *   - Safe: no execution of source code, only static analysis
 *
 * @module workflow/core/pattern-extractor
 */

'use strict';

const fs = require('fs');

// ─────────────────────────────────────────────────────────────────────────────
// Confidence Scoring Weights
// ─────────────────────────────────────────────────────────────────────────────

const CONF = {
  AST_EXPORT: 0.92,
  AST_CLASS: 0.90,
  AST_METHOD: 0.88,
  AST_FIELD: 0.82,
  REGEX_EXPORT: 0.60,
  REGEX_FUNCTION: 0.55,
  REGEX_CLASS: 0.58,
  REGEX_REQUIRE: 0.50,
  REGEX_TABLE: 0.48,
  REGEX_PATTERN: 0.45,
  HEURISTIC_FREQ: 0.40,
  PITFALL_COMMENT: 0.65,
  PITFALL_KEYWORD: 0.55,
  FALLBACK: 0.35,
  MIN_CUTOFF: 0.40,
};

// ─────────────────────────────────────────────────────────────────────────────
// Language → Strategy Router
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGE_STRATEGIES = {
  javascript: extractJavaScript,
  typescript: extractJavaScript,
  jsx: extractJavaScript,
  lua: extractLua,
  csharp: extractCSharp,
  java: extractJavaLike,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
  ruby: extractRuby,
  cpp: extractCpp,
  c: extractCpp,
  // Default: generic comment-based extraction only
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract patterns from a list of scanned files.
 *
 * @param {Array<{relativePath, absolutePath, language, size, lineCount}>} files
 * @param {object} [options]
 * @param {number} [options.maxSignalsPerFile=50]
 * @param {boolean} [options.includePitfalls=true]
 * @returns {Promise<PatternResult[]>}
 */
async function extractPatterns(files, options = {}) {
  const { maxSignalsPerFile = 50, includePitfalls = true } = options;
  const allSignals = [];

  for (const file of files) {
    if (!file.language) continue;

    let content;
    try {
      content = fs.readFileSync(file.absolutePath, 'utf-8');
    } catch (err) {
      console.error(`[PatternExtractor] ⚠️  Cannot read ${file.absolutePath}: ${err.message}`);
      continue;
    }

    const strategy = LANGUAGE_STRATEGIES[file.language.toLowerCase()] || extractGeneric;
    const signals = strategy(content, file.relativePath, file.language, maxSignalsPerFile);
    allSignals.push(...signals);
  }

  // Post-processing: deduplicate by (type, name, sourceFile, line)
  const seen = new Set();
  const deduped = [];
  for (const s of allSignals) {
    const key = `${s.type}::${s.name}::${s.sourceFile}::${s.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }

  // Frequency-based pattern boost: if a name appears in 3+ files, boost to 'pattern'
  const nameOccurrences = new Map();
  for (const s of deduped) {
    if (s.type === 'apiSurface') {
      const key = `${s.name}|${s.language}`;
      const existing = nameOccurrences.get(key) || new Set();
      existing.add(s.sourceFile);
      nameOccurrences.set(key, existing);
    }
  }

  for (const s of deduped) {
    const key = `${s.name}|${s.language}`;
    const occurrences = nameOccurrences.get(key);
    if (occurrences && occurrences.size >= 3 && s.type === 'apiSurface') {
      // Clone and add as a pattern signal
      deduped.push({
        ...s,
        type: 'pattern',
        confidence: Math.min(s.confidence + 0.15, 0.92),
        extractionMethod: s.extractionMethod,
        note: `Recurring across ${occurrences.size} files`,
      });
    }
  }

  // Apply min confidence cutoff
  const filtered = deduped.filter(s => s.confidence >= CONF.MIN_CUTOFF);

  // Sort by confidence desc
  filtered.sort((a, b) => b.confidence - a.confidence);

  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: JavaScript / TypeScript
// ─────────────────────────────────────────────────────────────────────────────

function extractJavaScript(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_EXPORT },
    { re: /^\s*export\s+(?:default\s+)?(?:class|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/, type: 'apiSurface', conf: CONF.REGEX_EXPORT },
    { re: /^\s*module\.exports\s*=\s*\{?\s*([A-Za-z_$][A-Za-z0-9_$,\s]*)\}?/, type: 'apiSurface', conf: CONF.REGEX_EXPORT },
    { re: /^\s*function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[{\(]/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
        for (const name of names) {
          if (name.length > 50 || name.length < 2) continue;
          signals.push({
            type: p.type,
            name,
            sourceFile,
            language,
            line: i + 1,
            confidence: p.conf,
            extractionMethod: 'regex',
          });
        }
      }
    }
  }

  // Pitfalls from comments
  const pitfallSignals = extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length);
  signals.push(...pitfallSignals);

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Lua
// ─────────────────────────────────────────────────────────────────────────────

function extractLua(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /^\s*(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*function\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*local\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{/, type: 'apiSurface', conf: CONF.REGEX_TABLE },
    { re: /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_][A-Za-z0-9_]*\s*=\s*function/, type: 'pattern', conf: CONF.REGEX_PATTERN },
    { re: /^\s*require\s*\(\s*["']([^"']+)["']\s*\)/, type: 'pattern', conf: CONF.REGEX_REQUIRE },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[1].trim();
        if (name.length > 50 || name.length < 2) continue;
        signals.push({
          type: p.type,
          name,
          sourceFile,
          language,
          line: i + 1,
          confidence: p.conf,
          extractionMethod: 'regex',
        });
      }
    }
  }

  const pitfallSignals = extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length);
  signals.push(...pitfallSignals);

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: C#
// ─────────────────────────────────────────────────────────────────────────────

function extractCSharp(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /^\s*(?:public|internal)\s+(?:static\s+)?(?:class|struct|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*(?:public|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>,\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)/, type: 'pattern', conf: CONF.REGEX_PATTERN },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[1].trim();
        if (name.length > 50 || name.length < 2) continue;
        signals.push({
          type: p.type,
          name,
          sourceFile,
          language,
          line: i + 1,
          confidence: p.conf,
          extractionMethod: 'regex',
        });
      }
    }
  }

  const pitfallSignals = extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length);
  signals.push(...pitfallSignals);

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Java
// ─────────────────────────────────────────────────────────────────────────────

function extractJavaLike(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /^\s*(?:public|protected)\s+(?:static\s+)?(?:class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*(?:public|protected)\s+(?:static\s+)?(?:[\w<>,\s]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)/, type: 'pattern', conf: CONF.REGEX_PATTERN },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[1].trim();
        if (name.length > 50 || name.length < 2) continue;
        signals.push({
          type: p.type,
          name,
          sourceFile,
          language,
          line: i + 1,
          confidence: p.conf,
          extractionMethod: 'regex',
        });
      }
    }
  }

  const pitfallSignals = extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length);
  signals.push(...pitfallSignals);

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Python
// ─────────────────────────────────────────────────────────────────────────────

function extractPython(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const patterns = [
    { re: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[\(:]/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.]*)/, type: 'pattern', conf: CONF.REGEX_REQUIRE },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[1].trim();
        if (name.length > 50 || name.length < 2) continue;
        signals.push({
          type: p.type,
          name,
          sourceFile,
          language,
          line: i + 1,
          confidence: p.conf,
          extractionMethod: 'regex',
        });
      }
    }
  }

  const pitfallSignals = extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length);
  signals.push(...pitfallSignals);

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Go
// ─────────────────────────────────────────────────────────────────────────────

function extractGo(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');
  const patterns = [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
  ];
  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        signals.push({ type: p.type, name: m[1].trim(), sourceFile, language, line: i + 1, confidence: p.conf, extractionMethod: 'regex' });
      }
    }
  }
  signals.push(...extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length));
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Rust
// ─────────────────────────────────────────────────────────────────────────────

function extractRust(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');
  const patterns = [
    { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*mod\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'pattern', conf: CONF.REGEX_PATTERN },
  ];
  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        signals.push({ type: p.type, name: m[1].trim(), sourceFile, language, line: i + 1, confidence: p.conf, extractionMethod: 'regex' });
      }
    }
  }
  signals.push(...extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length));
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: Ruby
// ─────────────────────────────────────────────────────────────────────────────

function extractRuby(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');
  const patterns = [
    { re: /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*[!?]?)/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*module\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'pattern', conf: CONF.REGEX_PATTERN },
  ];
  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        signals.push({ type: p.type, name: m[1].trim(), sourceFile, language, line: i + 1, confidence: p.conf, extractionMethod: 'regex' });
      }
    }
  }
  signals.push(...extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length));
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy: C / C++
// ─────────────────────────────────────────────────────────────────────────────

function extractCpp(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');
  const patterns = [
    { re: /^\s*(?:[\w*\s]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/, type: 'apiSurface', conf: CONF.REGEX_FUNCTION },
    { re: /^\s*(?:class|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/, type: 'apiSurface', conf: CONF.REGEX_CLASS },
    { re: /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/, type: 'pattern', conf: CONF.REGEX_PATTERN },
  ];
  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of patterns) {
      const m = line.match(p.re);
      if (m) {
        const name = m[1].trim();
        if (['if', 'for', 'while', 'switch', 'return'].includes(name)) continue;
        signals.push({ type: p.type, name, sourceFile, language, line: i + 1, confidence: p.conf, extractionMethod: 'regex' });
      }
    }
  }
  signals.push(...extractPitfallsFromComments(content, sourceFile, language, maxSignals - signals.length));
  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic Fallback Strategy
// ─────────────────────────────────────────────────────────────────────────────

function extractGeneric(content, sourceFile, language, maxSignals) {
  return extractPitfallsFromComments(content, sourceFile, language, maxSignals);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pitfall Extraction (Language-Agnostic)
// ─────────────────────────────────────────────────────────────────────────────

function extractPitfallsFromComments(content, sourceFile, language, maxSignals) {
  const signals = [];
  const lines = content.split('\n');

  const pitfallPatterns = [
    { re: /(?:\/\/|\#|;|\-\-|\/\*)\s*\b(TODO|FIXME|HACK|BUG|WARN|WARNING|DEPRECATED|XXX)\b[:\s]*(.{5,200})/i, conf: CONF.PITFALL_COMMENT },
    { re: /\*\s*\b(TODO|FIXME|HACK|BUG|WARN|WARNING|DEPRECATED|XXX)\b[:\s]*(.{5,200})/i, conf: CONF.PITFALL_COMMENT },
  ];

  for (let i = 0; i < lines.length && signals.length < maxSignals; i++) {
    const line = lines[i];
    for (const p of pitfallPatterns) {
      const m = line.match(p.re);
      if (m) {
        const keyword = m[1].toUpperCase();
        const description = (m[2] || '').trim().substring(0, 120);
        const name = `${keyword}${description ? ': ' + description : ''}`;
        signals.push({
          type: 'pitfall',
          name,
          sourceFile,
          language: language || 'generic',
          line: i + 1,
          confidence: p.conf,
          extractionMethod: 'regex',
          tag: keyword,
        });
      }
    }
  }

  return signals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  extractPatterns,
  CONF,
};
