/**
 * Observability Prompt Tracing Module
 *
 * Extracted from observability.js for maintainability (ADR-41).
 * Provides compact prompt digest storage for cross-session analysis.
 *
 * Design principle: The full prompt is NEVER stored — only a hash + head + tail + length.
 * This keeps storage bounded while enabling meaningful debugging.
 *
 * @module workflow/core/observability-prompt-tracing
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Quick non-cryptographic hash for prompt deduplication.
 * Uses simple character code sum for speed (not security).
 *
 * @param {string} str - Input string
 * @returns {string} 8-character hex hash
 */
function _quickHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, '0').slice(-8);
}

// ─── Prompt Trace Store ──────────────────────────────────────────────────────

/**
 * PromptTraceStore manages compact prompt digests for cross-session analysis.
 *
 * Each trace stores:
 *   - role: Agent role (analyst/architect/developer/tester)
 *   - ts: Timestamp
 *   - promptHash: 8-char hash for deduplication
 *   - promptHead: First 500 chars of prompt
 *   - promptTail: Last 200 chars (if prompt > 700 chars)
 *   - promptLength: Full prompt length
 *   - estimatedTokens: Token estimate
 */
class PromptTraceStore {
  constructor() {
    this._traces = [];
  }

  /**
   * Records a prompt trace with compact digest.
   *
   * @param {string} role - Agent role
   * @param {string} promptText - Full prompt text
   * @param {number} estimatedTokens - Token estimate
   * @returns {object} The created trace object
   */
  record(role, promptText, estimatedTokens = 0) {
    if (!promptText || typeof promptText !== 'string' || promptText.length === 0) {
      return null;
    }

    const ts = Date.now();
    const promptHash = _quickHash(promptText);
    const promptLength = promptText.length;
    const promptHead = promptText.slice(0, 500);
    const promptTail = promptLength > 700 ? promptText.slice(-200) : '';

    const trace = {
      role,
      ts,
      promptHash,
      promptHead,
      promptTail,
      promptLength,
      estimatedTokens,
    };

    this._traces.push(trace);
    return trace;
  }

  /**
   * Returns all recorded traces.
   * @returns {object[]}
   */
  getAll() {
    return [...this._traces];
  }

  /**
   * Returns the number of recorded traces.
   * @returns {number}
   */
  get count() {
    return this._traces.length;
  }

  /**
   * Returns unique trace count (by promptHash).
   * @returns {number}
   */
  get uniqueCount() {
    return new Set(this._traces.map(t => t.promptHash)).size;
  }

  /**
   * Returns average prompt length.
   * @returns {number|null}
   */
  get avgLength() {
    if (this._traces.length === 0) return null;
    const total = this._traces.reduce((s, t) => s + t.promptLength, 0);
    return Math.round(total / this._traces.length);
  }

  /**
   * Gets a summary of prompt traces for metrics.
   *
   * @returns {object} Summary object
   */
  getSummary() {
    if (this._traces.length === 0) {
      return { count: 0, uniqueCount: 0, avgLength: null };
    }

    const hashes = this._traces.map(t => t.promptHash);
    const uniqueHashes = new Set(hashes);

    // Find duplicate prompts (same hash, different timestamps)
    const hashCounts = {};
    for (const h of hashes) {
      hashCounts[h] = (hashCounts[h] || 0) + 1;
    }
    const duplicates = Object.entries(hashCounts)
      .filter(([_, cnt]) => cnt > 1)
      .map(([h, cnt]) => ({ hash: h, count: cnt }));

    return {
      count: this._traces.length,
      uniqueCount: uniqueHashes.size,
      avgLength: this.avgLength,
      duplicates: duplicates.length > 0 ? duplicates : null,
    };
  }

  /**
   * Groups traces by role.
   *
   * @returns {object} Map of role -> traces[]
   */
  groupByRole() {
    const groups = {};
    for (const t of this._traces) {
      if (!groups[t.role]) groups[t.role] = [];
      groups[t.role].push(t);
    }
    return groups;
  }

  /**
   * Finds traces with similar prompts (same hash).
   *
   * @param {string} hash - Prompt hash to search for
   * @returns {object[]} Matching traces
   */
  findByHash(hash) {
    return this._traces.filter(t => t.promptHash === hash);
  }

  /**
   * Clears all traces.
   */
  clear() {
    this._traces = [];
  }

  /**
   * Persists traces to a JSONL file.
   *
   * @param {string} outputDir - Output directory
   * @param {string} sessionId - Session ID for filename
   * @returns {string} Path to written file
   */
  persist(outputDir, sessionId) {
    if (this._traces.length === 0) return null;

    try {
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      const outPath = path.join(outputDir, 'prompt-traces.jsonl');
      const lines = this._traces.map(t => JSON.stringify(t));

      // Append to existing file
      const content = lines.join('\n') + '\n';
      fs.appendFileSync(outPath, content, 'utf-8');

      console.log(`[PromptTrace] 📝 Persisted ${this._traces.length} traces to ${outPath}`);
      return outPath;
    } catch (err) {
      console.warn(`[PromptTrace] Failed to persist: ${err.message}`);
      return null;
    }
  }

  /**
   * Loads traces from a JSONL file.
   *
   * @param {string} filePath - Path to JSONL file
   * @returns {PromptTraceStore} New store with loaded traces
   */
  static load(filePath) {
    const store = new PromptTraceStore();
    if (!fs.existsSync(filePath)) return store;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          store._traces.push(JSON.parse(line));
        }
      }
    } catch (err) {
      console.warn(`[PromptTrace] Failed to load: ${err.message}`);
    }

    return store;
  }
}

// ─── Prompt Drift Analyzer ───────────────────────────────────────────────────

/**
 * Analyzes prompt drift across sessions.
 * Detects when prompts for the same role change significantly.
 */
class PromptDriftAnalyzer {
  constructor() {
    this._baselineByRole = {};
  }

  /**
   * Sets baseline prompt for a role.
   *
   * @param {string} role - Agent role
   * @param {string} promptText - Baseline prompt
   */
  setBaseline(role, promptText) {
    this._baselineByRole[role] = {
      hash: _quickHash(promptText),
      length: promptText.length,
      head: promptText.slice(0, 200),
    };
  }

  /**
   * Compares a prompt against baseline.
   *
   * @param {string} role - Agent role
   * @param {string} promptText - Current prompt
   * @returns {object} Drift analysis result
   */
  analyze(role, promptText) {
    const baseline = this._baselineByRole[role];
    if (!baseline) {
      return { hasBaseline: false, drift: null };
    }

    const currentHash = _quickHash(promptText);
    const currentLength = promptText.length;
    const lengthChange = currentLength - baseline.length;
    const lengthChangePct = baseline.length > 0
      ? ((lengthChange / baseline.length) * 100).toFixed(1)
      : 0;

    const isIdentical = currentHash === baseline.hash;
    const isSignificantChange = Math.abs(lengthChangePct) > 20;

    return {
      hasBaseline: true,
      isIdentical,
      isSignificantChange,
      drift: {
        hashMatch: isIdentical,
        lengthChange,
        lengthChangePct: parseFloat(lengthChangePct),
        baselineLength: baseline.length,
        currentLength,
      },
    };
  }

  /**
   * Loads baselines from a file.
   *
   * @param {string} filePath - Path to baselines file
   */
  loadBaselines(filePath) {
    if (!fs.existsSync(filePath)) return;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this._baselineByRole = JSON.parse(content);
    } catch (err) {
      console.warn(`[PromptDrift] Failed to load baselines: ${err.message}`);
    }
  }

  /**
   * Saves baselines to a file.
   *
   * @param {string} filePath - Path to baselines file
   */
  saveBaselines(filePath) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(this._baselineByRole, null, 2), 'utf-8');
    } catch (err) {
      console.warn(`[PromptDrift] Failed to save baselines: ${err.message}`);
    }
  }
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Core classes
  PromptTraceStore,
  PromptDriftAnalyzer,

  // Helper
  quickHash: _quickHash,
};
