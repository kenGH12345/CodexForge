/**
 * Expert Knowledge Injection Channel (EKIC) – Human expert knowledge → Agent context
 *
 * Combats uncertainty: Agent's ignorance of project-specific domain knowledge.
 *
 * This is the 7th knowledge production channel in WorkFlowAgent:
 *   Channels 1-6: Machine-driven (SkillDiscovery, Enrichment, Preheat, SignalDetector, ArticleScout, Evolution)
 *   Channel 7: Human-driven (this module)
 *
 * Knowledge sources:
 *   1. Expert files (.workflow/experts/*.md) — YAML frontmatter + Markdown body
 *   2. CLI injection (/inject-expert command)
 *   3. Session @expert markers (future: Phase 3)
 *   4. Auto-distillation from code analysis (init-time)
 *
 * Design principles:
 *   - Multi-source unified: all sources go through the same pipeline
 *   - Role routing: knowledge injected only to relevant roles (saves tokens)
 *   - Progressive disclosure: high-priority = full content, low-priority = summary only
 *   - Conflict detection: new knowledge vs existing skills/experiences
 *   - Zero LLM overhead: classification uses rule engine, not LLM
 *   - Expiration: knowledge can have TTL (expires field)
 *
 * Integration:
 *   - ContextLoader.resolve() calls getExpertBlock(role, taskText)
 *   - init-project.js calls loadFromDirectory() during initialization
 *   - ide-workflow-bridge.js exposes inject-expert / list-experts / expert-block commands
 *
 * @module expert-knowledge-channel
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

const EXPERT_DIR_NAME = 'experts';
const MAX_EXPERT_BLOCK_TOKENS = 2000;  // Token budget for expert knowledge in prompt
const SUMMARY_MAX_CHARS = 300;         // Max chars for low-priority summary

// ─── Knowledge Layer Classification ─────────────────────────────────────────

const KnowledgeLayer = {
  PLATFORM: 'PLATFORM',   // Framework/tool-level knowledge
  DOMAIN:   'DOMAIN',     // Business domain knowledge
  PRACTICE: 'PRACTICE',   // Team conventions and practices
};

// ─── Expert Knowledge Entry ─────────────────────────────────────────────────

/**
 * @typedef {object} ExpertKnowledge
 * @property {string} name       - Unique name identifier
 * @property {string} author     - Who created this knowledge
 * @property {string} source     - Source type: 'file' | 'cli' | 'session' | 'auto-distill'
 * @property {string[]} scope    - Target roles: ['analyst', 'architect', 'developer', 'tester']
 * @property {string} priority   - 'high' | 'medium' | 'low'
 * @property {string[]} tags     - Keyword tags for matching
 * @property {string} content    - Full Markdown content
 * @property {string} summary    - Auto-generated summary (first paragraph or truncated)
 * @property {string} layer      - Knowledge layer: PLATFORM | DOMAIN | PRACTICE
 * @property {string} [expires]  - ISO date string for expiration
 * @property {number} [confidence] - Confidence score: 1.0 (human) | 0.7 (auto-distill)
 * @property {string} filePath   - Absolute path to the source file (if file-based)
 * @property {number} loadedAt   - Timestamp when loaded into registry
 */

// ─── Expert Knowledge Channel ───────────────────────────────────────────────

class ExpertKnowledgeChannel {
  /**
   * @param {object} [options]
   * @param {string}   [options.projectRoot]     - Project root directory
   * @param {object}   [options.experienceStore]  - ExperienceStore instance (for conflict detection)
   * @param {number}   [options.maxBlockTokens]   - Max tokens for expert block in prompt
   */
  constructor(options = {}) {
    this._projectRoot = options.projectRoot || '.';
    this._experienceStore = options.experienceStore || null;
    this._maxBlockTokens = options.maxBlockTokens || MAX_EXPERT_BLOCK_TOKENS;

    /** @type {Map<string, ExpertKnowledge>} name → ExpertKnowledge */
    this._registry = new Map();

    /** @type {string} Path to .workflow/experts/ directory */
    this._expertsDir = path.join(this._projectRoot, '.workflow', EXPERT_DIR_NAME);

    /** @type {{ loaded: number, injected: number, expired: number, conflicts: number }} */
    this._metrics = { loaded: 0, injected: 0, expired: 0, conflicts: 0 };
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Loads all expert knowledge files from .workflow/experts/ directory.
   * Called during init-project.js and _initWorkflow().
   *
   * @returns {{ loaded: number, skipped: number, expired: number, errors: string[] }}
   */
  loadFromDirectory() {
    const result = { loaded: 0, skipped: 0, expired: 0, errors: [] };

    if (!fs.existsSync(this._expertsDir)) {
      return result;
    }

    let entries;
    try {
      entries = fs.readdirSync(this._expertsDir, { withFileTypes: true });
    } catch (err) {
      result.errors.push(`Failed to read experts directory: ${err.message}`);
      return result;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(this._expertsDir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = this._parseExpertFile(content, filePath);

        if (!parsed) {
          result.skipped++;
          continue;
        }

        // Check expiration
        if (parsed.expires && new Date(parsed.expires) < new Date()) {
          result.expired++;
          this._metrics.expired++;
          console.log(`[ExpertKnowledge] ⏰ Expired: ${parsed.name} (expired ${parsed.expires})`);
          continue;
        }

        this._registry.set(parsed.name, parsed);
        result.loaded++;
        this._metrics.loaded++;
      } catch (err) {
        result.errors.push(`${entry.name}: ${err.message}`);
      }
    }

    if (result.loaded > 0) {
      console.log(`[ExpertKnowledge] 📚 Loaded ${result.loaded} expert knowledge file(s) from ${this._expertsDir}`);
    }
    if (result.expired > 0) {
      console.log(`[ExpertKnowledge] ⏰ Skipped ${result.expired} expired file(s)`);
    }

    return result;
  }

  /**
   * Injects a single expert knowledge entry (from CLI or session).
   *
   * @param {object} knowledge
   * @param {string} knowledge.name     - Unique name
   * @param {string} knowledge.content  - Markdown content
   * @param {string[]} [knowledge.scope]   - Target roles (default: all)
   * @param {string} [knowledge.priority]  - 'high' | 'medium' | 'low' (default: 'medium')
   * @param {string[]} [knowledge.tags]    - Keyword tags
   * @param {string} [knowledge.source]    - Source type (default: 'cli')
   * @param {string} [knowledge.author]    - Author name
   * @param {boolean} [knowledge.persist]  - Whether to persist to file (default: true)
   * @returns {{ success: boolean, name: string, layer: string, conflicts: string[], error?: string }}
   */
  inject(knowledge) {
    // Validate
    if (!knowledge.name || !knowledge.content) {
      return { success: false, name: '', layer: '', conflicts: [], error: 'name and content are required' };
    }

    const entry = {
      name: knowledge.name,
      author: knowledge.author || 'CLI User',
      source: knowledge.source || 'cli',
      scope: knowledge.scope || ['analyst', 'architect', 'developer', 'tester'],
      priority: knowledge.priority || 'medium',
      tags: knowledge.tags || [],
      content: knowledge.content,
      summary: this._generateSummary(knowledge.content),
      layer: this._classifyLayer(knowledge.content, knowledge.tags || []),
      expires: knowledge.expires || null,
      confidence: knowledge.source === 'auto-distill' ? 0.7 : 1.0,
      filePath: null,
      loadedAt: Date.now(),
    };

    // Conflict detection
    const conflicts = this._detectConflicts(entry);
    if (conflicts.length > 0) {
      this._metrics.conflicts += conflicts.length;
      console.log(`[ExpertKnowledge] ⚠️ Conflicts detected for "${entry.name}": ${conflicts.join(', ')}`);
    }

    // Register
    this._registry.set(entry.name, entry);
    this._metrics.loaded++;

    // Persist to file if requested
    if (knowledge.persist !== false) {
      this._persistToFile(entry);
    }

    console.log(`[ExpertKnowledge] ✅ Injected: "${entry.name}" (${entry.layer}, ${entry.priority}, scope: ${entry.scope.join(',')})`);

    return {
      success: true,
      name: entry.name,
      layer: entry.layer,
      conflicts,
    };
  }

  /**
   * Returns formatted expert knowledge block for a given role and task context.
   * Called by ContextLoader.resolve() during prompt building.
   *
   * @param {string} role       - Agent role (analyst/architect/developer/tester)
   * @param {string} [taskText] - Current task description (for tag matching)
   * @returns {string} Formatted Markdown block (empty string if no applicable knowledge)
   */
  getExpertBlock(role, taskText = '') {
    const applicable = this._getApplicableKnowledge(role, taskText);
    if (applicable.length === 0) return '';

    const sections = [];
    let tokenBudget = this._maxBlockTokens;

    // Sort by priority: high → medium → low
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    applicable.sort((a, b) => (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1));

    for (const ek of applicable) {
      const isHigh = ek.priority === 'high';
      const text = isHigh ? ek.content : ek.summary;
      const estimatedTokens = Math.ceil(text.length / 4);  // Rough estimate

      if (estimatedTokens > tokenBudget) {
        // Budget exhausted — skip remaining
        break;
      }

      const confidenceTag = ek.confidence < 1.0 ? ' _(auto-generated, review recommended)_' : '';
      if (isHigh) {
        sections.push(`### 🧠 Expert: ${ek.name}${confidenceTag}\n${ek.content}`);
      } else {
        sections.push(`### 🧠 Expert: ${ek.name} (summary)${confidenceTag}\n${ek.summary}`);
      }

      tokenBudget -= estimatedTokens;
      this._metrics.injected++;
    }

    if (sections.length === 0) return '';

    return `## Expert Knowledge (Domain-Specific)\n\n${sections.join('\n\n')}`;
  }

  /**
   * Lists all registered expert knowledge entries.
   *
   * @param {object} [filter]
   * @param {string} [filter.role]     - Filter by applicable role
   * @param {string} [filter.priority] - Filter by priority
   * @param {string} [filter.layer]    - Filter by knowledge layer
   * @returns {Array<{ name: string, priority: string, scope: string[], layer: string, source: string, tags: string[], confidence: number }>}
   */
  list(filter = {}) {
    const results = [];

    for (const [name, ek] of this._registry) {
      // Apply filters
      if (filter.role && !ek.scope.includes(filter.role)) continue;
      if (filter.priority && ek.priority !== filter.priority) continue;
      if (filter.layer && ek.layer !== filter.layer) continue;

      results.push({
        name: ek.name,
        priority: ek.priority,
        scope: ek.scope,
        layer: ek.layer,
        source: ek.source,
        tags: ek.tags,
        confidence: ek.confidence,
        author: ek.author,
        expires: ek.expires,
      });
    }

    return results;
  }

  /**
   * Returns metrics for observability.
   * @returns {{ loaded: number, injected: number, expired: number, conflicts: number, registrySize: number }}
   */
  getStats() {
    return {
      ...this._metrics,
      registrySize: this._registry.size,
    };
  }

  /**
   * Returns the registry (for external access, e.g. ContextLoader integration).
   * @returns {Map<string, ExpertKnowledge>}
   */
  getRegistry() {
    return this._registry;
  }

  // ─── Private: File Parsing ────────────────────────────────────────────────

  /**
   * Parses an expert knowledge file with YAML frontmatter + Markdown body.
   *
   * @param {string} content  - Full file content
   * @param {string} filePath - Absolute file path
   * @returns {ExpertKnowledge|null}
   */
  _parseExpertFile(content, filePath) {
    const { meta, body } = this._parseFrontmatter(content);

    if (!meta.name) {
      // Derive name from filename
      meta.name = path.basename(filePath, '.md').replace(/[-_]/g, ' ');
    }

    if (!body || body.trim().length < 10) {
      console.warn(`[ExpertKnowledge] ⚠️ Skipping ${filePath}: body too short`);
      return null;
    }

    return {
      name: meta.name,
      author: meta.author || 'Unknown',
      source: meta.source || 'file',
      scope: this._parseScope(meta.scope),
      priority: meta.priority || 'medium',
      tags: Array.isArray(meta.tags) ? meta.tags : (meta.tags ? [meta.tags] : []),
      content: body.trim(),
      summary: this._generateSummary(body.trim()),
      layer: this._classifyLayer(body, Array.isArray(meta.tags) ? meta.tags : []),
      expires: meta.expires || null,
      confidence: meta.confidence || (meta.source === 'auto-distill' ? 0.7 : 1.0),
      filePath,
      loadedAt: Date.now(),
    };
  }

  /**
   * Parses YAML frontmatter from content.
   * Delegates to shared yaml-frontmatter.js to eliminate duplication.
   * @param {string} content
   * @returns {{ meta: object, body: string }}
   */
  _parseFrontmatter(content) {
    const { parseFrontmatter } = require('./yaml-frontmatter');
    const result = parseFrontmatter(content, { nested: false });
    return { meta: result.meta, body: result.body };
  }

  /**
   * Parses scope field from various formats.
   * @param {*} scope
   * @returns {string[]}
   */
  _parseScope(scope) {
    const allRoles = ['analyst', 'architect', 'developer', 'tester', 'coding-agent'];
    if (!scope) return allRoles;
    if (Array.isArray(scope)) return scope;
    if (typeof scope === 'string') {
      return scope.split(',').map(s => s.trim()).filter(Boolean);
    }
    return allRoles;
  }

  // ─── Private: Classification ──────────────────────────────────────────────

  /**
   * Classifies knowledge into PLATFORM / DOMAIN / PRACTICE layer.
   * Uses keyword-based rules (zero LLM).
   *
   * @param {string} content
   * @param {string[]} tags
   * @returns {string}
   */
  _classifyLayer(content, tags) {
    const lower = (content + ' ' + tags.join(' ')).toLowerCase();

    // PLATFORM indicators
    const platformKeywords = ['framework', 'library', 'sdk', 'api', 'docker', 'kubernetes', 'ci/cd', 'deployment', 'infrastructure', 'database', 'orm', 'redis', 'nginx'];
    const platformScore = platformKeywords.filter(kw => lower.includes(kw)).length;

    // DOMAIN indicators
    const domainKeywords = ['business', 'domain', 'rule', 'constraint', 'requirement', 'regulation', 'compliance', 'workflow', 'process', 'policy'];
    const domainScore = domainKeywords.filter(kw => lower.includes(kw)).length;

    // PRACTICE indicators
    const practiceKeywords = ['convention', 'style', 'naming', 'pattern', 'practice', 'team', 'review', 'standard', 'guideline', 'coding'];
    const practiceScore = practiceKeywords.filter(kw => lower.includes(kw)).length;

    if (platformScore > domainScore && platformScore > practiceScore) return KnowledgeLayer.PLATFORM;
    if (domainScore > practiceScore) return KnowledgeLayer.DOMAIN;
    if (practiceScore > 0) return KnowledgeLayer.PRACTICE;
    return KnowledgeLayer.DOMAIN;  // Default to DOMAIN
  }

  /**
   * Generates a summary from content (first paragraph or truncated).
   * @param {string} content
   * @returns {string}
   */
  _generateSummary(content) {
    if (!content) return '';

    // Take first non-empty, non-heading paragraph
    const paragraphs = content.split('\n\n');
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('---') && !trimmed.startsWith('>')) {
        return trimmed.length > SUMMARY_MAX_CHARS
          ? trimmed.slice(0, SUMMARY_MAX_CHARS) + '...'
          : trimmed;
      }
    }

    // Fallback: truncate entire content
    return content.length > SUMMARY_MAX_CHARS
      ? content.slice(0, SUMMARY_MAX_CHARS) + '...'
      : content;
  }

  // ─── Private: Conflict Detection ──────────────────────────────────────────

  /**
   * Detects potential conflicts between new knowledge and existing skills/experiences.
   * Uses keyword overlap heuristic (zero LLM).
   *
   * @param {ExpertKnowledge} entry
   * @returns {string[]} List of conflict descriptions
   */
  _detectConflicts(entry) {
    const conflicts = [];

    // Check against existing expert knowledge
    for (const [name, existing] of this._registry) {
      if (name === entry.name) continue;

      // Check tag overlap
      const tagOverlap = entry.tags.filter(t => existing.tags.includes(t));
      if (tagOverlap.length >= 2) {
        conflicts.push(`Tag overlap with "${name}": ${tagOverlap.join(', ')}`);
      }
    }

    // Check against ExperienceStore if available
    if (this._experienceStore && typeof this._experienceStore.search === 'function') {
      try {
        const searchResults = this._experienceStore.search({
          keyword: entry.tags.join(' '),
          limit: 3,
        });
        if (searchResults && searchResults.length > 0) {
          for (const exp of searchResults) {
            if (exp.type === 'NEGATIVE' && entry.content.toLowerCase().includes(exp.title.toLowerCase())) {
              conflicts.push(`Potential conflict with negative experience: "${exp.title}"`);
            }
          }
        }
      } catch (_) {
        // Non-fatal: experience store may not be available
      }
    }

    return conflicts;
  }

  // ─── Private: Applicable Knowledge Selection ──────────────────────────────

  /**
   * Returns expert knowledge entries applicable to the given role and task.
   *
   * @param {string} role
   * @param {string} taskText
   * @returns {ExpertKnowledge[]}
   */
  _getApplicableKnowledge(role, taskText) {
    const now = new Date();
    const taskLower = (taskText || '').toLowerCase();
    const results = [];

    for (const [, ek] of this._registry) {
      // Check expiration
      if (ek.expires && new Date(ek.expires) < now) continue;

      // Check role scope
      if (!ek.scope.includes(role) && !ek.scope.includes('*')) continue;

      // For high priority: always include (regardless of task match)
      if (ek.priority === 'high') {
        results.push(ek);
        continue;
      }

      // For medium/low: check tag/keyword match with task text
      if (taskLower) {
        const hasTagMatch = ek.tags.some(tag => taskLower.includes(tag.toLowerCase()));
        const hasContentMatch = ek.name.toLowerCase().split(/\s+/).some(word =>
          word.length > 3 && taskLower.includes(word)
        );
        if (hasTagMatch || hasContentMatch) {
          results.push(ek);
        }
      } else {
        // No task text — include medium priority, skip low
        if (ek.priority === 'medium') {
          results.push(ek);
        }
      }
    }

    return results;
  }

  // ─── Private: Persistence ─────────────────────────────────────────────────

  /**
   * Persists an expert knowledge entry to .workflow/experts/ as a Markdown file.
   *
   * @param {ExpertKnowledge} entry
   */
  _persistToFile(entry) {
    try {
      // Ensure directory exists
      if (!fs.existsSync(this._expertsDir)) {
        fs.mkdirSync(this._expertsDir, { recursive: true });
      }

      const fileName = entry.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md';
      const filePath = path.join(this._expertsDir, fileName);

      const frontmatter = [
        '---',
        `name: ${entry.name}`,
        `author: ${entry.author}`,
        `source: ${entry.source}`,
        `scope: [${entry.scope.join(', ')}]`,
        `priority: ${entry.priority}`,
        `tags: [${entry.tags.join(', ')}]`,
        entry.expires ? `expires: ${entry.expires}` : null,
        entry.confidence !== 1.0 ? `confidence: ${entry.confidence}` : null,
        '---',
      ].filter(Boolean).join('\n');

      const fileContent = `${frontmatter}\n\n${entry.content}\n`;
      fs.writeFileSync(filePath, fileContent, 'utf-8');

      entry.filePath = filePath;
      console.log(`[ExpertKnowledge] 💾 Persisted: ${filePath}`);
    } catch (err) {
      console.warn(`[ExpertKnowledge] ⚠️ Failed to persist "${entry.name}": ${err.message}`);
    }
  }
}

// ─── Auto-Distillation Helper ───────────────────────────────────────────────

/**
 * Generates an auto-distilled expert knowledge file from project analysis artifacts.
 * Called during init-project.js as the final step.
 *
 * @param {object} options
 * @param {string} options.projectRoot   - Project root directory
 * @param {Function} options.cheapLlmCall - Cheap LLM call function
 * @param {string} [options.profileContent]   - Content of project-profile.md
 * @param {string} [options.codeGraphContent] - Content of code-graph.md
 * @param {string} [options.businessLogicContent] - Content of business-logic.md
 * @returns {Promise<{ success: boolean, filePath?: string, error?: string }>}
 */
async function autoDistillExpertKnowledge(options) {
  const { projectRoot, cheapLlmCall, profileContent, codeGraphContent, businessLogicContent } = options;

  if (!cheapLlmCall) {
    return { success: false, error: 'cheapLlmCall not available' };
  }

  // Collect available analysis artifacts
  const artifacts = [];
  const outputDir = path.join(projectRoot, 'output');

  const profileText = profileContent || _readFileOrNull(path.join(outputDir, 'project-profile.md'));
  const graphText = codeGraphContent || _readFileOrNull(path.join(outputDir, 'code-graph.md'));
  const bizText = businessLogicContent || _readFileOrNull(path.join(outputDir, 'business-logic.md'));

  if (profileText) artifacts.push(`## Project Profile\n${profileText.slice(0, 2000)}`);
  if (graphText) artifacts.push(`## Code Graph Summary\n${graphText.slice(0, 2000)}`);
  if (bizText) artifacts.push(`## Business Logic\n${bizText.slice(0, 2000)}`);

  if (artifacts.length === 0) {
    return { success: false, error: 'No analysis artifacts available for distillation' };
  }

  const prompt = [
    'You are a senior software architect reviewing project analysis results.',
    'Based on the following analysis, distill the key constraints, hotspots, and gotchas',
    'that an AI coding agent MUST know when modifying this project.',
    '',
    'Output format: Markdown with these sections:',
    '## Architecture Constraints',
    '## Critical Hotspots (Modify with Caution)',
    '## Business Flow Rules',
    '## Gotchas & Warnings',
    '',
    'Rules:',
    '- Each section should have 2-5 bullet points',
    '- Be specific and actionable (not generic advice)',
    '- Focus on things that would cause bugs if ignored',
    '- Total output under 1500 characters',
    '- If the analysis is in Chinese, output in Chinese',
    '',
    '--- ANALYSIS ---',
    artifacts.join('\n\n'),
    '--- END ---',
  ].join('\n');

  try {
    const response = await cheapLlmCall(prompt);
    if (!response || response.trim().length < 50) {
      return { success: false, error: 'LLM response too short' };
    }

    // Build the expert knowledge file
    const expertsDir = path.join(projectRoot, '.workflow', EXPERT_DIR_NAME);
    if (!fs.existsSync(expertsDir)) {
      fs.mkdirSync(expertsDir, { recursive: true });
    }

    const filePath = path.join(expertsDir, 'auto-distilled.md');
    const now = new Date();
    const expiresDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000); // 6 months

    const fileContent = [
      '---',
      'name: Auto-Distilled Project Knowledge',
      'author: WorkFlowAgent (auto-generated)',
      'source: auto-distill',
      'confidence: 0.7',
      'scope: [analyst, architect, developer, tester]',
      'priority: medium',
      'tags: [auto-distilled, architecture, hotspots, constraints]',
      `generated_at: ${now.toISOString()}`,
      `expires: ${expiresDate.toISOString().split('T')[0]}`,
      '---',
      '',
      response.trim(),
      '',
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    console.log(`[ExpertKnowledge] 🧪 Auto-distilled: ${filePath} (${response.trim().length} chars)`);

    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: `Auto-distillation failed: ${err.message}` };
  }
}

/**
 * Generates expert knowledge from arbitrary source files.
 * User provides files, LLM extracts domain knowledge.
 *
 * @param {object} options
 * @param {string[]} options.files       - Array of file paths to analyze
 * @param {string} options.projectRoot   - Project root directory
 * @param {Function} options.cheapLlmCall - Cheap LLM call function
 * @param {string[]} [options.scope]     - Target roles
 * @param {string} [options.priority]    - Priority level
 * @returns {Promise<{ success: boolean, filePath?: string, name?: string, error?: string }>}
 */
async function generateExpertFromFiles(options) {
  const { files, projectRoot, cheapLlmCall, scope, priority } = options;

  if (!cheapLlmCall) {
    return { success: false, error: 'cheapLlmCall not available' };
  }

  if (!files || files.length === 0) {
    return { success: false, error: 'No files provided' };
  }

  // Read file contents
  const fileContents = [];
  for (const filePath of files) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    try {
      const content = fs.readFileSync(absPath, 'utf-8');
      const truncated = content.slice(0, 3000);
      fileContents.push(`### File: ${path.basename(filePath)}\n\`\`\`\n${truncated}\n\`\`\``);
    } catch (err) {
      fileContents.push(`### File: ${path.basename(filePath)}\n[Could not read: ${err.message}]`);
    }
  }

  const prompt = [
    'You are a senior software architect. Analyze the following source files and extract',
    'domain-specific expert knowledge that an AI coding agent should know.',
    '',
    'Focus on:',
    '- Architectural constraints and patterns',
    '- Critical rules and conventions',
    '- Anti-patterns to avoid',
    '- Gotchas and non-obvious behaviors',
    '',
    'Output format: Markdown with sections like ## Rules, ## Anti-Patterns, ## Gotchas',
    'Be specific and actionable. Total output under 2000 characters.',
    'If the code comments are in Chinese, output in Chinese.',
    '',
    '--- FILES ---',
    fileContents.join('\n\n'),
    '--- END ---',
  ].join('\n');

  try {
    const response = await cheapLlmCall(prompt);
    if (!response || response.trim().length < 50) {
      return { success: false, error: 'LLM response too short' };
    }

    // Derive name from file names
    const name = `Expert from ${files.map(f => path.basename(f)).join(', ')}`;
    const safeName = files.map(f => path.basename(f, path.extname(f))).join('-').slice(0, 50);

    const expertsDir = path.join(projectRoot, '.workflow', EXPERT_DIR_NAME);
    if (!fs.existsSync(expertsDir)) {
      fs.mkdirSync(expertsDir, { recursive: true });
    }

    const filePath = path.join(expertsDir, `from-${safeName}.md`);

    const fileContent = [
      '---',
      `name: ${name}`,
      'author: WorkFlowAgent (generated from files)',
      'source: file-analysis',
      'confidence: 0.8',
      `scope: [${(scope || ['analyst', 'architect', 'developer', 'tester']).join(', ')}]`,
      `priority: ${priority || 'medium'}`,
      `tags: [generated, ${files.map(f => path.basename(f, path.extname(f))).join(', ')}]`,
      `generated_at: ${new Date().toISOString()}`,
      '---',
      '',
      response.trim(),
      '',
    ].join('\n');

    fs.writeFileSync(filePath, fileContent, 'utf-8');
    console.log(`[ExpertKnowledge] 📝 Generated from files: ${filePath}`);

    return { success: true, filePath, name };
  } catch (err) {
    return { success: false, error: `Generation failed: ${err.message}` };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _readFileOrNull(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (e) { console.warn('[ExpertKnowledgeChannel] file read failed:', e.message); }
  return null;
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  ExpertKnowledgeChannel,
  autoDistillExpertKnowledge,
  generateExpertFromFiles,
  KnowledgeLayer,
  EXPERT_DIR_NAME,
  MAX_EXPERT_BLOCK_TOKENS,
};
