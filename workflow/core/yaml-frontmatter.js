/**
 * yaml-frontmatter.js – Shared YAML Frontmatter Parser
 *
 * Consolidates 4 duplicate _parseFrontmatter / _parseYamlValue implementations
 * from: context-loader.js, skill-evolution.js, expert-knowledge-channel.js,
 * and skill-marketplace.js.
 *
 * Superset API that covers all caller needs:
 *   - parseFrontmatter(content)  → { meta, body, bodyStart }
 *   - parseYamlValue(val)        → parsed primitive
 *
 * @module yaml-frontmatter
 */

'use strict';

/**
 * Parses a simple YAML value (string, number, boolean, array).
 *
 * Handles: arrays [a, b], quoted strings, booleans, integers, floats, bare strings.
 *
 * @param {string} val - Raw YAML value string
 * @returns {*} Parsed value
 */
function parseYamlValue(val) {
  if (!val || val.trim() === '') return '';
  const trimmed = val.trim();

  // Array: [item1, item2]
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Number (integer or float)
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  return trimmed;
}

/**
 * Parses YAML frontmatter from a Markdown file content.
 *
 * Returns an object with:
 *   - meta: parsed key-value pairs from the YAML block
 *   - body: content after the closing --- (trimmed)
 *   - bodyStart: character index where body begins (for callers that need offset)
 *
 * Supports:
 *   - Top-level key: value pairs
 *   - Nested keys (one level, indented with 2 spaces)
 *   - Comment lines (# ...) are skipped
 *   - Hyphenated keys (e.g. tech-stack)
 *
 * @param {string} content - Full file content
 * @param {object} [options]
 * @param {boolean} [options.nested=true] - Whether to parse nested (indented) keys
 * @returns {{ meta: object, body: string, bodyStart: number }}
 */
function parseFrontmatter(content, options = {}) {
  const { nested = true } = options;
  const empty = { meta: {}, body: content || '', bodyStart: 0 };

  if (!content || !content.startsWith('---')) {
    return empty;
  }

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) {
    return empty;
  }

  const yamlBlock = content.slice(3, endIdx).trim();
  const meta = {};
  let currentKey = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Handle nested keys (indented with 2+ spaces under a parent key)
    if (nested && line.startsWith('  ') && currentKey) {
      const nestedMatch = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (nestedMatch) {
        if (typeof meta[currentKey] !== 'object' || Array.isArray(meta[currentKey])) {
          meta[currentKey] = {};
        }
        meta[currentKey][nestedMatch[1]] = parseYamlValue(nestedMatch[2]);
      }
      continue;
    }

    // Handle top-level keys (supports word chars, underscores, hyphens)
    const match = trimmed.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (match) {
      currentKey = match[1];
      const val = match[2];
      if (val === '' || val === undefined) {
        meta[currentKey] = {};
      } else {
        meta[currentKey] = parseYamlValue(val);
      }
    }
  }

  const bodyStart = endIdx + 3;
  return {
    meta,
    body: content.slice(bodyStart).trim(),
    bodyStart,
  };
}

module.exports = { parseFrontmatter, parseYamlValue };
