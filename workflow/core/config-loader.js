/**
 * Config Loader – Loads project-specific workflow configuration
 *
 * Looks for `workflow.config.js` (or `workflow.config.json`) in:
 *  1. The directory passed as argument
 *  2. The parent of the workflow/ directory (i.e. project root)
 *  3. process.cwd()
 *
 * If no config file is found, built-in defaults are used so the workflow
 * still works out-of-the-box for any project.
 *
 * Config file format (workflow.config.js):
 * ```js
 * module.exports = {
 *   // File extensions to scan for code symbols and experience generation
 *   sourceExtensions: ['.js', '.ts'],
 *
 *   // Directories to ignore during scanning
 *   ignoreDirs: ['node_modules', '.git', 'dist', 'build'],
 *
 *   // Built-in skills to register on startup
 *   builtinSkills: [
 *     { name: 'my-skill', description: '...', domains: ['domain1'] },
 *   ],
 *
 *   // Classification rules for experience generation
 *   // Each rule: { ext: '.js'|'.py'|'*', test: (path, content) => bool, result: {...} | fn }
 *   classificationRules: [...],
 *
 *   // Default skill name used when no rule matches (per extension)
 *   defaultSkills: { '.js': 'javascript-dev' },
 * };
 * ```
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { applyConfigGovernance } = require('./config-governance');

// ─── Default Configuration ────────────────────────────────────────────────────

/**
 * Minimal built-in defaults – work for any project without a config file.
 * Projects override these by providing a workflow.config.js.
 */
const DEFAULT_CONFIG = {
  sourceExtensions: ['.js', '.ts', '.py', '.go', '.java', '.cs', '.lua'],
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'output', '.vs', 'obj'],
  builtinSkills: [
    { name: 'workflow-orchestration', description: 'Multi-agent workflow orchestration SOP', domains: ['workflow', 'orchestration'] },
    { name: 'code-review',            description: 'Code review checklist and best practices', domains: ['quality', 'review'] },
    { name: 'api-design',             description: 'REST/RPC API design rules and patterns', domains: ['backend', 'api'] },
  ],
  classificationRules: [],   // No project-specific rules by default
  defaultSkills: {},         // Falls back to extension-based naming
  
  // ─── Effective Lines Counter (ADR-XX) ──────────────────────────────────────
  effectiveLines: {
    enabled: true,
    tiers: {
      'entry-point':    { maxEffectiveLines: 700, maxTotalLines: 1000 },
      'core-critical':  { maxEffectiveLines: 1000, maxTotalLines: 1500 },
      'core-standard':  { maxEffectiveLines: 800, maxTotalLines: 1200 },
      'agent':          { maxEffectiveLines: 250, maxTotalLines: 400 },
      'command':        { maxEffectiveLines: 400, maxTotalLines: 600 },
      'default':        { maxEffectiveLines: 300, maxTotalLines: 500 },
    },
    commentRatioWarning: 50,
  },

  // ─── Configuration Governance (anti-sprawl for rules/skills/hooks) ───────
  configurationGovernance: {
    enabled: true,
    limits: {
      maxGlobalSkills: 8,
      maxProjectSkills: 16,
      maxBuiltinSkills: 64,
      maxClassificationRules: 40,
      maxCustomDetectionRulesPerType: 20,
      maxSocraticUniversalRules: 16,
      maxSocraticStageRulesPerStage: 12,
      maxSocraticArtifactRules: 12,
      maxHookPolicies: 24,
      maxToolHookMetricsHistory: 5000,
    },
  },

  // ─── Runtime Policy (制度化约束: runtime-enforced) ───────────────────────
  runtimePolicy: {
    enabled: true,
    requireReadBeforeWrite: true,
    blockScopeExpansion: true,
    requireApprovalForRiskyOps: true,
    maxRequirementChars: 8000,
  },

  // ─── Independent Acceptance Gate (做事/验收分离) ────────────────────────
  acceptanceGate: {
    enabled: true,
    strict: false,
    requireArtifacts: ['requirement.md', 'architecture.md', 'execution-plan.md', 'code.diff', 'test-report.md'],
  },

  // ─── Tool Governance Pipeline (pre/post/fallback) ───────────────────────
  toolGovernance: {
    enabled: true,
    maxInputLength: 12000,
    allowFallback: true,
  },

  // ─── Context Budget Policy (产品级预算策略) ───────────────────────────────
  contextBudgetPolicy: {
    enabled: true,
    requirementMaxChars: 8000,
    stageBudgets: {
      ANALYSE: 12000,
      ARCHITECT: 14000,
      PLAN: 10000,
      CODE: 14000,
      TEST: 12000,
    },
  },

  // ─── Capability Catalog (模型可见能力清单) ───────────────────────────────
  capabilityCatalog: {
    enabled: true,
    includeRuntimeCapabilities: true,
  },

  // ─── Health Monitoring (Unified scoring + rolling trend alerts) ──────────
  healthMonitoring: {
    scoring: {
      model: 'unified-v1',
      weights: {
        completeness: 0.35,
        process: 0.20,
        delivery: 0.30,
        detection: 0.15,
      },
      penalties: {
        missingStage: 20,
        socraticMax: 20,
        metricsGatePerFailedStage: 5,
        metricsGateMax: 25,
      },
      gradeThresholds: {
        A: 90,
        B: 80,
        C: 70,
        D: 60,
      },
    },
    trend: {
      enabled: true,
      windowSize: 5,
      minSessions: 3,
      degradationThreshold: 8,
      lowScoreThreshold: 75,
      maxHistoryEntries: 200,
    },
  },
};

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Searches for a workflow config file starting from the given directory,
 * then walking up to the project root (parent of workflow/).
 *
 * @param {string} [startDir] - Directory to start searching from
 * @returns {{ config: object, configPath: string|null }}
 */
function loadConfig(startDir) {
  const searchDirs = _buildSearchDirs(startDir);
  const candidates = ['workflow.config.js', 'workflow.config.json'];

  for (const dir of searchDirs) {
    for (const filename of candidates) {
      const fullPath = path.join(dir, filename);
      if (fs.existsSync(fullPath)) {
        try {
          // Clear require cache so hot-reload works in watch mode
          delete require.cache[require.resolve(fullPath)];
          const userConfig = require(fullPath);
          const merged = _mergeConfig(DEFAULT_CONFIG, userConfig);
          _autoRegisterSkills(merged, fullPath);
          const { config: governedConfig, report } = applyConfigGovernance(merged);
          if (report && Array.isArray(report.warnings) && report.warnings.length > 0) {
            for (const warning of report.warnings.slice(0, 10)) {
              console.warn(warning);
            }
            if (report.warnings.length > 10) {
              console.warn(`[ConfigGovernance] ${report.warnings.length - 10} additional warning(s) suppressed.`);
            }
          }
          console.log(`[ConfigLoader] Loaded config from: ${fullPath}`);
          return { config: governedConfig, configPath: fullPath };
        } catch (err) {
          console.warn(`[ConfigLoader] Failed to load config at ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  const defaultMerged = { ...DEFAULT_CONFIG };
  _autoRegisterSkills(defaultMerged, null);
  const { config: governedDefaultConfig, report } = applyConfigGovernance(defaultMerged);
  if (report && Array.isArray(report.warnings) && report.warnings.length > 0) {
    for (const warning of report.warnings.slice(0, 10)) {
      console.warn(warning);
    }
  }
  console.log(`[ConfigLoader] No workflow.config.js found. Using built-in defaults.`);
  return { config: governedDefaultConfig, configPath: null };
}

/**
 * Builds the list of directories to search for a config file.
 *
 * Priority rules:
 *  - If startDir is explicitly provided → ONLY search startDir.
 *    This prevents accidentally picking up a config from a different project
 *    when the workflow is invoked with --path pointing to another directory.
 *  - If startDir is NOT provided → search: cwd → workflow parent dir → workflow dir
 *    (covers the common case where the user runs from the project root)
 */
function _buildSearchDirs(startDir) {
  const dirs = [];

  if (startDir) {
    // Explicit project root: only look there, nowhere else
    dirs.push(path.resolve(startDir));
    return dirs;
  }

  // No explicit root: try cwd first, then the workflow's own parent (= project root
  // when workflow/ is a sub-folder of the project), then the workflow dir itself
  const cwd = process.cwd();
  const workflowParent = path.resolve(__dirname, '..', '..');
  const workflowDir    = path.resolve(__dirname, '..');

  const seen = new Set();
  for (const d of [cwd, workflowParent, workflowDir]) {
    if (!seen.has(d)) { seen.add(d); dirs.push(d); }
  }

  return dirs;
}

/**
 * Deep-merges user config on top of defaults.
 * Arrays are replaced (not concatenated) so users have full control.
 */
function _mergeConfig(defaults, user) {
  const result = { ...defaults };

  for (const key of Object.keys(user)) {
    if (user[key] === undefined || user[key] === null) continue;

    if (Array.isArray(user[key])) {
      // Arrays replace defaults entirely
      result[key] = user[key];
    } else if (typeof user[key] === 'object' && user[key] !== null && !Array.isArray(user[key])) {
      result[key] = { ...defaults[key], ...user[key] };
    } else {
      result[key] = user[key];
    }
  }

  return result;
}

// ─── Skill Auto-Discovery ─────────────────────────────────────────────────────

/**
 * Derives the skills directory paths from the loaded config file location.
 * Returns an array to support both workflow/skills/ (built-in / curated) and
 * .workflow/skills/ (runtime-generated project experts, e.g. gen-skill output).
 */
function _resolveSkillsDirs(configPath) {
  const dirs = [];
  const seen = new Set();
  const push = (p) => {
    if (!p) return;
    const norm = path.resolve(p);
    if (seen.has(norm)) return;
    if (fs.existsSync(norm) && fs.statSync(norm).isDirectory()) {
      dirs.push(norm);
      seen.add(norm);
    }
  };

  if (configPath) {
    // Strict mode: only scan the explicitly-configured project's own skill dirs.
    // Do NOT fall back to __dirname / cwd — that would leak skills across projects.
    const projectRoot = path.dirname(configPath);
    push(path.join(projectRoot, 'workflow', 'skills'));
    push(path.join(projectRoot, '.workflow', 'skills'));
    return dirs;
  }

  // No explicit config: use discovery heuristics.
  push(path.resolve(__dirname, '..', 'skills'));
  push(path.join(process.cwd(), 'workflow', 'skills'));
  push(path.join(process.cwd(), '.workflow', 'skills'));
  return dirs;
}

// Backward-compat shim: return first dir or null
function _resolveSkillsDir(configPath) {
  const dirs = _resolveSkillsDirs(configPath);
  return dirs.length > 0 ? dirs[0] : null;
}

/**
 * Extracts skill metadata from a skill markdown file.
 * Supports YAML frontmatter with fields: name, description, domains (array or string).
 * Falls back to filename-based derivation for missing fields.
 */
function _extractSkillMetadata(filePath, fallbackName) {
  const content = fs.readFileSync(filePath, 'utf8');

  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) {
    return _buildFallbackMetadata(fallbackName);
  }

  const fm = fmMatch[1];
  const name = _yamlGet(fm, 'name') || fallbackName;
  const description = _yamlGet(fm, 'description') || `Auto-discovered skill from ${fallbackName}.md`;
  const rawDomains = _yamlGet(fm, 'domains');
  const domains = _normalizeDomains(rawDomains, fallbackName);

  const meta = { name, description, domains };

  const triggers = _yamlGet(fm, 'triggers');
  if (triggers !== undefined) meta.triggers = triggers;

  const version = _yamlGet(fm, 'version');
  if (version !== undefined) meta.version = version;

  const type = _yamlGet(fm, 'type');
  if (type !== undefined) meta.type = type;

  const loadLevel = _yamlGet(fm, 'load_level');
  if (loadLevel !== undefined) meta.load_level = loadLevel;

  const maxTokens = _yamlGet(fm, 'max_tokens');
  if (maxTokens !== undefined) {
    const parsed = typeof maxTokens === 'string' ? parseInt(maxTokens, 10) : maxTokens;
    if (!isNaN(parsed)) meta.max_tokens = parsed;
  }

  return meta;
}

/**
 * YAML subset parser for skill frontmatter. Supports:
 *   1. flat scalar:      key: value
 *   2. quoted string:    key: "value" or key: 'value'
 *   3. inline array:     key: [a, b, c]
 *   4. indented list:    key:\n  - item1\n  - item2
 *   5. nested object:    key:\n  sub1: v1\n  sub2: [a, b]  (1 level deep)
 *   6. block scalar |:   key: |\n  line1\n  line2
 * Does NOT support: multi-doc, anchors, folded '>', 2+ level nesting.
 */
function _yamlGet(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const keyRe = new RegExp(`^(\\s*)${_escapeRegex(key)}\\s*:\\s*(.*)$`);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(keyRe);
    if (!m) continue;
    const keyIndent = m[1].length;
    const rawValue = m[2];

    if (rawValue.length > 0) {
      if (rawValue.trim() === '|' || rawValue.trim() === '>') {
        return _parseBlockScalar(lines, i + 1, keyIndent, rawValue.trim());
      }
      return _parseScalar(rawValue);
    }

    // Empty value — look at next indented lines for list or nested object
    return _parseNestedBlock(lines, i + 1, keyIndent);
  }
  return undefined;
}

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',')
      .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(s => s.length > 0);
  }
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function _parseBlockScalar(lines, startIdx, keyIndent, marker) {
  const collected = [];
  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') { collected.push(''); continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= keyIndent) break;
    collected.push(line.slice(keyIndent + 2));
  }
  // Trim trailing empty lines
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  const joined = marker === '>' ? collected.join(' ') : collected.join('\n');
  return joined;
}

function _parseNestedBlock(lines, startIdx, keyIndent) {
  // Detect if block is a list (starts with '- ') or nested object
  let firstChildIdx = -1;
  let childIndent = -1;
  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= keyIndent) return undefined;
    firstChildIdx = j;
    childIndent = indent;
    break;
  }
  if (firstChildIdx === -1) return undefined;

  const firstBody = lines[firstChildIdx].slice(childIndent);
  if (firstBody.startsWith('- ')) {
    return _parseList(lines, firstChildIdx, childIndent);
  }
  return _parseObject(lines, firstChildIdx, childIndent);
}

function _parseList(lines, startIdx, listIndent) {
  const items = [];
  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent < listIndent) break;
    const body = line.slice(listIndent);
    if (!body.startsWith('- ')) break;
    items.push(_parseScalar(body.slice(2).trim()));
  }
  return items;
}

function _parseObject(lines, startIdx, objIndent) {
  const obj = {};
  for (let j = startIdx; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent < objIndent) break;
    if (indent > objIndent) continue; // Child's children — handled by recursive call
    const m = line.slice(objIndent).match(/^([^:\s]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const subKey = m[1];
    const subVal = m[2];
    if (subVal.length === 0) {
      const nested = _parseNestedBlock(lines, j + 1, objIndent);
      obj[subKey] = nested;
    } else if (subVal.trim() === '|' || subVal.trim() === '>') {
      obj[subKey] = _parseBlockScalar(lines, j + 1, objIndent, subVal.trim());
    } else {
      obj[subKey] = _parseScalar(subVal);
    }
  }
  return obj;
}

/**
 * Checks whether a skill-metadata field value should be treated as empty,
 * i.e. eligible to be enriched from YFM data.
 *
 * Rules:
 *   - undefined / null → empty
 *   - "" / "Auto-discovered skill from X.md" (fallback placeholder) → empty
 *   - [] → empty; non-empty array → not empty
 *   - {} → empty; object with any keys → not empty (user intent)
 *   - all other values (including 0) → not empty (explicit value)
 */
function _isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') {
    if (v.length === 0) return true;
    if (v.startsWith('Auto-discovered skill from ')) return true;
    return false;
  }
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

/**
 * Enriches an existing skill metadata entry with fields from a YFM-parsed
 * metadata object. User-provided fields (already non-empty) are preserved;
 * only empty fields are filled from the YFM source. The `name` field is
 * never modified since it is the merge key.
 *
 * Semantics: single-direction (YFM → existing). Mutates `existing` in place.
 */
function _enrichSkillMetadata(existing, fromYfm) {
  const enrichableFields = [
    'description', 'domains', 'triggers',
    'version', 'type', 'load_level', 'max_tokens',
  ];
  for (const key of enrichableFields) {
    if (_isEmpty(existing[key]) && !_isEmpty(fromYfm[key])) {
      existing[key] = fromYfm[key];
    }
  }
}

function _normalizeDomains(rawDomains, fallbackName) {
  if (Array.isArray(rawDomains) && rawDomains.length > 0) {
    return rawDomains;
  }
  if (typeof rawDomains === 'string' && rawDomains.length > 0) {
    return [rawDomains];
  }
  return _deriveDomainsFromName(fallbackName);
}

function _deriveDomainsFromName(name) {
  const parts = name.split(/[-_]/);
  const noise = new Set(['bp', 'skill', 'dev', 'test', 'review']);
  const domains = parts.filter(p => p.length > 2 && !noise.has(p.toLowerCase()));
  if (domains.length > 0) return domains;
  const clean = name.replace(/^(bp-|skill-)/i, '');
  return clean ? [clean] : [name];
}

function _buildFallbackMetadata(name) {
  return {
    name,
    description: `Auto-discovered skill from ${name}.md`,
    domains: _deriveDomainsFromName(name),
  };
}

/**
 * Scans the skills directory and registers any skill files not already present
 * in merged.builtinSkills. User-configured skills take precedence.
 */
function _autoRegisterSkills(merged, configPath) {
  const skillsDirs = _resolveSkillsDirs(configPath);
  if (skillsDirs.length === 0) return;

  if (!Array.isArray(merged.builtinSkills)) {
    merged.builtinSkills = [];
  }

  // Map name → index so we can enrich existing entries in-place (not just skip them).
  // This lets YFM data fill fields that hard-coded config.js entries left empty,
  // while preserving any explicit user values (enrichment is single-direction: YFM → existing).
  const existingIndex = new Map();
  merged.builtinSkills.forEach((skill, idx) => {
    if (skill && skill.name) existingIndex.set(skill.name, idx);
  });

  let totalDiscovered = 0;
  let totalEnriched = 0;
  for (const skillsDir of skillsDirs) {
    let discovered = 0;
    let enriched = 0;
    try {
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        if (entry.startsWith('.')) continue;

        const fullPath = path.join(skillsDir, entry);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (_) {
          continue;
        }

        let skillName = null;
        let skillFile = null;

        if (stat.isFile() && entry.endsWith('.md')) {
          skillName = entry.slice(0, -3);
          skillFile = fullPath;
        } else if (stat.isDirectory()) {
          const candidate = path.join(fullPath, 'SKILL.md');
          if (fs.existsSync(candidate)) {
            skillName = entry;
            skillFile = candidate;
          }
        }

        if (!skillName || !skillFile) continue;

        let metadata;
        try {
          metadata = _extractSkillMetadata(skillFile, skillName);
        } catch (err) {
          console.warn(`[ConfigLoader][AutoDiscovery] Failed to parse ${entry}: ${err.message}`);
          continue;
        }
        if (!metadata || !metadata.name) continue;
        metadata.filePath = skillFile;

        const existingIdx = existingIndex.get(skillName);
        if (existingIdx !== undefined) {
          // Name already registered (usually from workflow.config.js hard-coded list).
          // Enrich the existing entry in place — user's explicit fields are preserved,
          // only empty fields get filled from YFM. filePath is runtime discovery metadata;
          // it is safe to add when missing so ContextLoader can load directory-based skills.
          _enrichSkillMetadata(merged.builtinSkills[existingIdx], metadata);
          if (!merged.builtinSkills[existingIdx].filePath) {
            merged.builtinSkills[existingIdx].filePath = skillFile;
          }
          enriched++;
        } else {
          merged.builtinSkills.push(metadata);
          existingIndex.set(metadata.name, merged.builtinSkills.length - 1);
          discovered++;
        }
      }
    } catch (err) {
      console.warn(`[ConfigLoader][AutoDiscovery] Failed to scan ${skillsDir}: ${err.message}`);
    }

    if (discovered > 0 || enriched > 0) {
      const parts = [];
      if (discovered > 0) parts.push(`${discovered} new`);
      if (enriched > 0) parts.push(`enriched ${enriched} existing`);
      console.log(`[ConfigLoader][AutoDiscovery] Registered ${parts.join(', ')} skill(s) from ${skillsDir}`);
    }
    totalDiscovered += discovered;
    totalEnriched += enriched;
  }
}

// ─── Singleton Cache ──────────────────────────────────────────────────────────

let _cachedConfig = null;
let _cachedConfigPath = null;

/**
 * Returns the cached config, loading it on first call.
 * Pass `forceReload = true` to bypass the cache (useful in tests).
 *
 * N43 fix: when a projectRoot is explicitly provided, bypass the module-level singleton
 * cache entirely and load fresh. This prevents multiple Orchestrator/MemoryManager
 * instances from racing to clear and repopulate the shared cache, which could cause
 * one instance to silently use another instance's config.
 *
 * The module-level cache is only used for the "no projectRoot" case (CLI / single-instance
 * scenarios) where sharing a cached config is safe and desirable.
 *
 * @param {string}  [projectRoot] - Project root to search from
 * @param {boolean} [forceReload] - Bypass cache (legacy parameter, still respected)
 * @returns {object} Merged configuration object
 */
function getConfig(projectRoot, forceReload = false) {
  // When a projectRoot is explicitly provided, always load fresh to avoid cross-instance
  // cache pollution. Each Orchestrator/MemoryManager gets its own isolated config.
  if (projectRoot) {
    const { config, configPath } = loadConfig(projectRoot);
    // Only update the module-level cache if it is currently empty (first caller wins).
    // This preserves backward-compatible behaviour for code that calls getConfigPath()
    // after getConfig(projectRoot) without caring about multi-instance isolation.
    if (!_cachedConfig) {
      _cachedConfig = config;
      _cachedConfigPath = configPath;
    }
    return config;
  }

  // No projectRoot: use the module-level singleton (safe for single-instance use).
  if (_cachedConfig && !forceReload) return _cachedConfig;

  const { config, configPath } = loadConfig(undefined);
  _cachedConfig = config;
  _cachedConfigPath = configPath;
  return config;
}

/**
 * Returns the path of the loaded config file, or null if using defaults.
 */
function getConfigPath() {
  return _cachedConfigPath;
}

/**
 * Clears the singleton cache (useful for testing or hot-reload scenarios).
 */
function clearConfigCache() {
  _cachedConfig = null;
  _cachedConfigPath = null;
}

module.exports = { loadConfig, getConfig, getConfigPath, clearConfigCache, DEFAULT_CONFIG };
