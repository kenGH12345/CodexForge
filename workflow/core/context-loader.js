/**
 * ContextLoader – Context-aware document auto-injector
 *
 * Solves the "Agent won't read skills/ or decision-log.md unless prompted" problem.
 *
 * How it works:
 *  1. Skill matching  – scans task text for domain keywords, loads matching skill files
 *  2. ADR extraction  – extracts relevant ADR entries from decision-log.md by keyword
 *  3. Role mandates   – each agent role has a fixed set of docs it MUST always receive
 *
 * Integration: called inside buildAgentPrompt() before building the dynamic suffix.
 * Zero-config: works out of the box; projects can extend via workflow.config.js.
 *
 * Token budget: total injected context is capped at MAX_INJECT_TOKENS to avoid
 * pushing the prompt over the hallucination-risk threshold.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./constants');
const { estimateTokens } = require('../tools/thin-tools');

// ─── Configuration (extracted to context-loader-config.js) ──────────────────

const {
  MAX_INJECT_TOKENS,
  MAX_SKILL_TOKENS,
  MAX_ADR_TOKENS,
  MAX_GRAPH_TOKENS,
  MAX_DEP_SKILL_TOKENS,
  MAX_DEP_DEPTH,
  RISK_SKILL_TOKEN_CAP,
  RISK_SKILL_MAX_COUNT,
  RISK_SKILL_PACKS,
  LOAD_LEVEL,
  BUILTIN_SKILL_KEYWORDS,
  ROLE_MANDATORY_DOCS,
  ROLE_CONSTRAINT_SECTIONS,
} = require('./context-loader-config');

// ─── Skill Loading (extracted to context-loader-skills.js) ──────────────────

const {
  loadSkillWithDeps,
  loadSkill,
  isPlaceholderSkill,
  validateSkillContent,
  truncateContent,
  createLazyEnrichmentTrigger,
} = require('./context-loader-skills');

// ─── BM25+Embedding Hybrid Ranking (ADR-OpenSpace) ─────────────────────────

const { SkillRanker } = require('./skill-ranker');

// ─── Expert Knowledge Channel (EKIC) ────────────────────────────────────────

const { ExpertKnowledgeChannel } = require('./expert-knowledge-channel');

// Re-export LOAD_LEVEL for backward compatibility (exported at end of file)

// ─── ContextLoader ────────────────────────────────────────────────────────────

class ContextLoader {
  /**
   * @param {object} [options]
   * @param {string}   [options.workflowRoot]    - Root of the workflow directory
   * @param {string}   [options.projectRoot]     - Root of the project being worked on
   * @param {object}   [options.skillKeywords]   - Extra keyword→skill mappings from config
   * @param {string[]} [options.alwaysLoadSkills]- Skills to always inject regardless of keywords
   * @param {object}   [options.orchestrator]    - Orchestrator instance for lazy enrichment
   */
  constructor({
    workflowRoot    = PATHS.SKILLS_DIR ? path.dirname(PATHS.SKILLS_DIR) : __dirname,
    projectRoot     = null,
    skillKeywords   = {},
    alwaysLoadSkills = [],
    globalSkills    = [],    // Level 1: always loaded for every task
    projectSkills   = [],    // Level 2: loaded for all tasks in the project
    retiredSkills   = null,  // Set<string> of retired skill names to exclude
    codeGraph       = null,  // P0: externally-provided CodeGraph instance (avoids re-creation)
    orchestrator    = null,  // ADR-45: Orchestrator reference for lazy skill enrichment
    embeddingService = null, // Plan-C: EmbeddingService instance for semantic skill matching
    expertChannel   = null,  // EKIC: ExpertKnowledgeChannel instance for expert knowledge injection
    riskProfile     = null,  // P1.5: diff risk profile (security/performance/interface)
    experienceStore = null,  // ADR-55: Prevention Rule injection (MemGPT retrieval pattern)
  } = {}) {
    this._workflowRoot     = workflowRoot;
    this._projectRoot      = projectRoot || null;
    this._skillsDir        = path.join(workflowRoot, 'skills');
    this._docsDir          = workflowRoot;  // docs/ is relative to workflowRoot
    this._skillKeywords    = { ...BUILTIN_SKILL_KEYWORDS, ...skillKeywords };
    this._alwaysLoadSkills = alwaysLoadSkills;
    this._globalSkills     = globalSkills;
    this._projectSkills    = projectSkills;
    /** @type {Set<string>} Retired skill names – excluded from matching and loading */
    this._retiredSkills    = retiredSkills instanceof Set ? retiredSkills : new Set(retiredSkills || []);
    /** @type {Set<string>} Track loaded skills to avoid duplicates across layers */
    this._loadedSkillsInResolve = new Set();
    /** @type {CodeGraph|null} Shared CodeGraph instance (avoids redundant disk I/O) */
    this._codeGraph        = codeGraph || null;
    /** @type {object|null} Orchestrator reference for lazy skill enrichment (ADR-45) */
    this._orchestrator     = orchestrator;
    /** @type {import('./embedding-service').EmbeddingService|null} Semantic matching engine (Plan-C) */
    this._embeddingService = embeddingService || null;
    /** @type {ExpertKnowledgeChannel|null} Expert knowledge injection channel (EKIC) */
    this._expertChannel = expertChannel || null;
    /** @type {{security?:number,performance?:number,interface?:number}|null} P1.5 diff risk profile */
    this._riskProfile = riskProfile && typeof riskProfile === 'object' ? riskProfile : null;
    /** @type {object|null} ExperienceStore instance for Prevention Rule injection (ADR-55) */
    this._experienceStore = experienceStore || null;
    /** @type {SkillRanker} BM25+Embedding hybrid skill ranker (ADR-OpenSpace) */
    this._skillRanker = new SkillRanker({ embeddingService: this._embeddingService });
    /** @type {boolean} Whether the skill ranker corpus needs rebuilding */
    this._skillRankerDirty = true;
    /** @type {Set<string>} Skills currently being enriched (prevent duplicate triggers) */
    this._enrichmentInProgress = new Set();

    // ── File Read Cache (D1+D3 optimisation) ──────────────────────────────────
    // Caches file contents in memory to avoid redundant disk I/O within the same
    // workflow run. Skills and docs don't change during a run, so caching is safe.
    // Key: absolute file path, Value: { content: string, mtime: number }
    // The cache is per-instance; when a new ContextLoader is created, it starts fresh.
    /** @type {Map<string, { content: string, mtime: number }>} */
    this._fileCache = new Map();

    // P1-3 fix: Maximum file cache entries to prevent unbounded memory growth.
    // 200 entries ≈ 200 skill/doc files × ~5KB avg = ~1MB max cache footprint.
    this._fileCacheMaxSize = 200;

    /**
     * Cheap LLM call for semantic ADR digest. Injected at runtime by the
     * Orchestrator via setCheapLlmCall(). When available, _extractRelevantADRs
     * uses LLM for semantic relevance scoring and concise summarisation
     * instead of keyword-count heuristics.
     * @type {Function|null}
     */
    this._cheapLlmCall = null;

    /**
     * Cache for LLM-generated ADR digests. Key: hash of (logContent + taskText),
     * Value: digest string. Prevents redundant LLM calls within the same resolve().
     * @type {Map<string, string>}
     */
    this._adrDigestCache = new Map();

    // ── Direction 3: Enrichment Section Cache ─────────────────────────────────
    // Caches the processed sections (Markdown output) for role-mandatory docs,
    // global skills, project skills, and always-load skills. These sections
    // don't depend on taskText — only on file content (mtime) and role.
    // Key: `${role}:${filePath}`, Value: { sections, sources, tokens, mtime }
    // This avoids redundant file processing, ADR extraction, code-graph
    // truncation, and token estimation across multiple buildAgentPrompt() calls.
    /** @type {Map<string, { sections: string[], sources: string[], tokens: number, mtimes: Map<string,number> }>} */
    this._enrichmentCache = new Map();
    /** @type {number} Cache hit counter for observability */
    this._enrichmentCacheHits = 0;
    /** @type {number} Cache miss counter for observability */
    this._enrichmentCacheMisses = 0;
  }

  /**
   * Reads a file with in-memory caching. Returns the cached content if the
   * file's mtime hasn't changed since last read; otherwise reads from disk
   * and updates the cache.
   *
   * @param {string} filePath - Absolute path to the file
   * @returns {string|null} File content, or null if the file doesn't exist
   * @private
   */
  _readFileCached(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const stat = fs.statSync(filePath);
      const cached = this._fileCache.get(filePath);
      if (cached && cached.mtime === stat.mtimeMs) {
        return cached.content;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      // P1-3 fix: evict oldest entries when cache exceeds max size
      if (this._fileCache.size >= this._fileCacheMaxSize) {
        const firstKey = this._fileCache.keys().next().value;
        this._fileCache.delete(firstKey);
      }
      this._fileCache.set(filePath, { content, mtime: stat.mtimeMs });
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Injects a cheap LLM call function for semantic ADR digest generation.
   * Called by the Orchestrator during initialisation.
   *
   * @param {Function} llmCall - Async function: (prompt: string) => string
   */
  setCheapLlmCall(llmCall) {
    if (typeof llmCall === 'function') {
      this._cheapLlmCall = llmCall;
      console.log(`[ContextLoader] 🤖 Cheap LLM enabled for semantic ADR digest.`);
    }
  }

  /**
   * Formats Prevention Rules from ExperienceStore into a Markdown block for injection.
   * Industry reference: MemGPT (2023) — format retrieved memories for context window.
   *
   * @param {object[]} rules - Experience records from ExperienceStore
   * @param {string|null} stage - Current workflow stage
   * @returns {string} Formatted Markdown block
   * @private
   */
  _formatPreventionRulesBlock(rules, stage) {
    const header = stage
      ? `## ⚠️ Past Prevention Rules for ${stage} Stage`
      : `## ⚠️ Past Prevention Rules`;
    const items = rules.map(r => {
      // Extract Prevention field from structured content (generated by _extractPreventionRule)
      const preventionMatch = r.content.match(/\*\*Prevention\*\*:\s*(.+?)(?:\n\n|\n\*\*|$)/s);
      const prevention = preventionMatch
        ? preventionMatch[1].trim().slice(0, 200)
        : r.title;
      // Extract Dimension from structured content (more reliable than tags array)
      const dimensionMatch = r.content.match(/\*\*Dimension\*\*:\s*(.+?)(?:\n|$)/);
      const dimension = dimensionMatch ? dimensionMatch[1].trim() : 'general';
      return `- **[${dimension}]** ${prevention}`;
    }).join('\n');
    return `${header}\n\n${items}\n\n> _Source: ExperienceStore (EvolutionLoop ADR-55) — auto-captured past blind spots_`;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Resolves all context to inject for a given task + role.
   *
   * @param {string} taskText  - The task/prompt text (used for keyword matching)
   * @param {string} role      - Agent role (analyst|architect|developer|tester|...)
   * @returns {{ sections: string[], tokenCount: number, sources: string[] }}
   *   sections  – array of Markdown strings ready to inject
   *   tokenCount – total estimated tokens of all sections
   *   sources    – list of file names that were loaded (for logging)
   */
  async resolve(taskText, role) {
    // P2: Set progressive loading context before loading skills
    // Extract task keywords for progressive skill disclosure
    const taskKeywords = taskText
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter(w => w.length > 3 && !/^(the|this|that|with|from|into|onto|upon)$/i.test(w));
    const {
      setProgressiveLoadContext,
    } = require('./context-loader-skills');
    setProgressiveLoadContext(taskKeywords);

    const sections = [];
    const sources  = [];
    let   budget   = MAX_INJECT_TOKENS;

    // P1-5 fix: Reserve minimum budget for higher-priority tiers.
    // This ensures that even if Level 1-2 skills are large, there's always
    // space left for task-matched dynamic skills (Level 3). The reserved
    // amounts are soft caps — if a tier doesn't use its reservation, the
    // surplus is available for subsequent tiers.
    const TIER_RESERVATIONS = {
      MANDATORY_DOCS: Math.floor(MAX_INJECT_TOKENS * 0.35),  // 35% for role-mandatory docs
      GLOBAL_SKILLS:  Math.floor(MAX_INJECT_TOKENS * 0.20),  // 20% for global skills
      PROJECT_SKILLS: Math.floor(MAX_INJECT_TOKENS * 0.20),  // 20% for project skills
      TASK_SKILLS:    Math.floor(MAX_INJECT_TOKENS * 0.25),  // 25% for task-matched skills
    };
    // Remaining budget after mandatory docs + global + project = reserved for task skills
    const taskSkillReserve = TIER_RESERVATIONS.TASK_SKILLS;

    // ── Direction 3: Try enrichment cache for static layers (1-4) ──────────
    // Layers 1-4 (role-mandatory docs, global/project/always-load skills) don't
    // depend on taskText. Cache their processed sections keyed by role + file mtimes.
    // Only Layer 5 (task-matched skills) and ADR digest vary with taskText.
    const staticCacheResult = this._resolveStaticLayersCached(role, taskText);
    if (staticCacheResult) {
      sections.push(...staticCacheResult.sections);
      sources.push(...staticCacheResult.sources);
      budget -= staticCacheResult.tokens;
    } else {
    // Cache miss — compute static layers the normal way

    // 1. Role-mandatory docs (always injected first, highest priority)
    const mandatoryDocs = ROLE_MANDATORY_DOCS[role] || [];
    for (const docRelPath of mandatoryDocs) {
      // For output/ files (e.g. code-graph.md): must come from projectRoot only
      // (these are project-specific artifacts, not workflow-level docs)
      const isOutputFile = docRelPath.startsWith('output/');
      let docPath;
      if (isOutputFile) {
        if (!this._projectRoot) continue;  // no project root configured, skip
        docPath = path.join(this._projectRoot, docRelPath);
      } else {
        docPath = path.join(this._workflowRoot, docRelPath);
      }

      const content = this._readFileCached(docPath);
      if (!content) continue;
      const docName = path.basename(docRelPath);

      // For decision-log.md: extract only relevant ADR entries to save tokens
      if (docName === 'decision-log.md') {
        const digest = this._extractRelevantADRs(content, taskText, MAX_ADR_TOKENS);
        if (digest) {
          const tokens = estimateTokens(digest);
          if (tokens <= budget) {
            sections.push(`## 📋 Relevant Architecture Decisions (from decision-log.md)\n\n${digest}`);
            sources.push('decision-log.md (digest)');
            budget -= tokens;
          }
        }
      } else if (docName === 'code-graph.md') {
        // For code-graph.md: use compact summary with strict token cap
        const tokenCap = Math.min(MAX_GRAPH_TOKENS, budget);
        const truncated = this._truncate(content, tokenCap);
        if (truncated) {
          sections.push(`## 🗺️ Code Graph (project symbol index)\n\n${truncated}`);
          sources.push('code-graph.md');
          budget -= estimateTokens(truncated);
        }
        // For developer/coding-agent: also inject reusable symbols digest from hotspot analysis.
        // This ensures Agents prefer existing utilities/base classes when writing new code.
        // P0 optimisation: reuse externally-provided CodeGraph instance (this._codeGraph)
        // instead of creating a new instance each time. This avoids redundant disk I/O
        // and JSON.parse of the potentially 100MB+ code-graph.json file.
        if ((role === 'developer' || role === 'coding-agent') && budget > 0) {
          try {
            let cg = this._codeGraph;
            if (!cg) {
              const { CodeGraph } = require('./code-graph');
              const outputDir = this._projectRoot
                ? path.join(this._projectRoot, 'output')
                : path.dirname(docPath);
              cg = new CodeGraph({ projectRoot: this._projectRoot || '.', outputDir });
            }
            const reusableDigest = await cg.getReusableSymbolsDigest({ maxItems: 12, minCalledBy: 3 });
            if (reusableDigest) {
              const digestTokens = estimateTokens(reusableDigest);
              if (digestTokens <= budget) {
                sections.push(reusableDigest);
                sources.push('reusable-symbols (hotspot)');
                budget -= digestTokens;
              }
            }
          } catch (_) { /* non-fatal: hotspot analysis is optional enhancement */ }
        }
      } else if (docName === 'architecture-constraints.md') {
        // Per-role section filtering: inject only the sections relevant to this role.
        // This saves ~6-9K tokens per pipeline run (architect gets full doc, others get subsets).
        const filtered = this._filterConstraintSections(content, role);
        const tokens = estimateTokens(filtered);
        const truncated = this._truncate(filtered, Math.min(tokens, budget));
        if (truncated) {
          const sectionInfo = ROLE_CONSTRAINT_SECTIONS[role];
          const suffix = (sectionInfo && sectionInfo !== '*' && Array.isArray(sectionInfo))
            ? ` (${sectionInfo.length} sections for ${role})`
            : '';
          sections.push(`## 📐 ${docName}${suffix}\n\n${truncated}`);
          sources.push(`architecture-constraints.md${suffix}`);
          budget -= estimateTokens(truncated);
        }
      } else {
        const tokens = estimateTokens(content);
        const truncated = this._truncate(content, Math.min(tokens, budget));
        if (truncated) {
          sections.push(`## 📐 ${docName}\n\n${truncated}`);
          sources.push(docName);
          budget -= estimateTokens(truncated);
        }
      }
      if (budget <= 0) break;
    }

    // Reset per-resolve dedup tracker
    this._loadedSkillsInResolve = new Set();

    // 2. Level 1 – Global skills (highest priority, always loaded)
    for (const skillName of this._globalSkills) {
      if (budget <= 0) break;
      if (this._loadedSkillsInResolve.has(skillName)) continue;
      const loaded = this._loadSkillWithDeps(skillName, budget, 0);
      if (loaded) {
        sections.push(...loaded.sections);
        sources.push(...loaded.sources);
        budget -= loaded.tokens;
      }
    }

    // 3. Level 2 – Project skills (from config, loaded for all tasks in project)
    for (const skillName of this._projectSkills) {
      if (budget <= 0) break;
      if (this._loadedSkillsInResolve.has(skillName)) continue;
      const loaded = this._loadSkillWithDeps(skillName, budget, 0);
      if (loaded) {
        sections.push(...loaded.sections);
        sources.push(...loaded.sources);
        budget -= loaded.tokens;
      }
    }

    // 4. Always-load skills (backward compat, from config)
    for (const skillName of this._alwaysLoadSkills) {
      if (budget <= 0) break;
      if (this._loadedSkillsInResolve.has(skillName)) continue;
      const loaded = this._loadSkillWithDeps(skillName, budget, 0);
      if (loaded) {
        sections.push(...loaded.sections);
        sources.push(...loaded.sources);
        budget -= loaded.tokens;
      }
    }

    // Direction 3: Store computed static layers in cache for next call
    this._storeStaticLayersCache(role, sections, sources, MAX_INJECT_TOKENS - budget);

    } // end of cache-miss block

    // 5. Level 3a – Risk-pack skills (P1.5)
    // If a diff risk profile is available, pre-load focused review skills first
    // (security/performance/interface contract) under strict token caps.
    const riskPackSkills = this._getRiskPackSkills(taskText, role);
    for (const skillName of riskPackSkills) {
      if (budget <= 0) break;
      if (this._loadedSkillsInResolve.has(skillName)) continue;
      const loaded = this._loadSkillWithDeps(skillName, Math.min(RISK_SKILL_TOKEN_CAP, budget), 0);
      if (loaded) {
        sections.push(...loaded.sections);
        sources.push(...loaded.sources);
        budget -= loaded.tokens;
      }
    }

    // 5. Level 3b – Task skills (keyword-matched from task text)
    // P1-5 fix: ensure task skills get at least `taskSkillReserve` tokens.
    // If upper tiers consumed heavily, restore budget to at least the reserve.
    if (budget < taskSkillReserve) {
      budget = Math.min(taskSkillReserve, MAX_INJECT_TOKENS);
    }
    const matchedSkills = this._matchSkills(taskText, role);
    for (const skillName of matchedSkills) {
      if (budget <= 0) break;
      if (this._loadedSkillsInResolve.has(skillName)) continue;
      const loaded = this._loadSkillWithDeps(skillName, Math.min(MAX_SKILL_TOKENS, budget), 0);
      if (loaded) {
        sections.push(...loaded.sections);
        sources.push(...loaded.sources);
        budget -= loaded.tokens;
      }
    }

    // 6. Expert Knowledge (EKIC) — inject domain-specific expert knowledge
    if (this._expertChannel && budget > 0) {
      try {
        const expertBlock = this._expertChannel.getExpertBlock(role, taskText);
        if (expertBlock) {
          const expertTokens = estimateTokens(expertBlock);
          if (expertTokens <= budget) {
            sections.push(expertBlock);
            sources.push('expert-knowledge');
            budget -= expertTokens;
          }
        }
      } catch (_) { /* non-fatal: expert knowledge is optional enhancement */ }
    }

    // 7. Stage-Aware Prevention Rules (MemGPT retrieval pattern — ADR-55)
    // Retrieves past Prevention Rules for the current stage from ExperienceStore.
    // Industry reference: MemGPT (2023) — retrieve relevant memories on demand,
    // not full injection. RAG pattern: query → retrieve → inject.
    // Token budget: MAX_PREVENTION_TOKENS (300) — ~5% of total budget.
    const MAX_PREVENTION_TOKENS = 300;
    if (this._experienceStore && budget > 0) {
      try {
        // Extract stage from taskText (workflow-stage passes stage in taskText)
        const stageMatch = taskText.match(/\b(ANALYSE|ARCHITECT|PLAN|DEVELOP|TEST|REVIEW|DEPLOY)\b/i);
        const currentStage = stageMatch ? stageMatch[1].toUpperCase() : null;

        const queryTags = ['evolution-loop', 'auto-captured'];
        if (currentStage) queryTags.push(currentStage.toLowerCase());

        const preventionRules = this._experienceStore.search({
          type: 'negative',
          tags: queryTags,
          limit: 3,
        });

        if (preventionRules.length > 0) {
          const block = this._formatPreventionRulesBlock(preventionRules, currentStage);
          const blockTokens = estimateTokens(block);
          if (blockTokens <= Math.min(MAX_PREVENTION_TOKENS, budget)) {
            sections.push(block);
            sources.push(`prevention-rules (${preventionRules.length})`);
            budget -= blockTokens;
          }
        }
      } catch (_) { /* non-fatal: prevention rules are optional enhancement */ }
    }

    const tokenCount = MAX_INJECT_TOKENS - budget;
    if (sources.length > 0) {
      console.log(`[ContextLoader] Injected ${sources.length} context doc(s) (~${tokenCount} tokens): ${sources.join(', ')}`);
    }

    return { sections, tokenCount, sources };
  }

  // ─── Direction 3: Enrichment Section Cache ─────────────────────────────

  /**
   * Attempts to resolve static layers (1-4) from the enrichment cache.
   * Returns cached result if all source files have unchanged mtimes.
   *
   * @param {string} role
   * @param {string} taskText - Only needed for ADR digest (which is NOT cached)
   * @returns {{ sections: string[], sources: string[], tokens: number }|null}
   * @private
   */
  _resolveStaticLayersCached(role, taskText) {
    // P0-3 fix: include retiredSkills count in cache key so retiring a skill
    // correctly invalidates the cached static layers. Without this, a newly
    // retired skill would continue appearing in prompts until the cache expired
    // due to a file mtime change (which might never happen).
    const retiredCount = this._retiredSkills ? this._retiredSkills.size : 0;
    const cacheKey = `static:${role}:retired=${retiredCount}`;
    const cached = this._enrichmentCache.get(cacheKey);
    if (!cached) {
      this._enrichmentCacheMisses++;
      return null;
    }

    // Validate: check if any source file has changed since cache was built
    for (const [filePath, cachedMtime] of cached.mtimes) {
      try {
        if (!fs.existsSync(filePath)) {
          this._enrichmentCacheMisses++;
          return null; // file deleted — invalidate
        }
        const currentMtime = fs.statSync(filePath).mtimeMs;
        if (currentMtime !== cachedMtime) {
          this._enrichmentCacheMisses++;
          return null; // file modified — invalidate
        }
      } catch {
        this._enrichmentCacheMisses++;
        return null;
      }
    }

    // Cache hit! Reset the per-resolve dedup tracker from cached sources
    this._loadedSkillsInResolve = new Set();
    for (const src of cached.sources) {
      const name = src.replace(/\.md.*$/, '').replace(/\s*\(.*\)$/, '');
      if (name && !name.includes('/') && !name.includes('\\')) {
        this._loadedSkillsInResolve.add(name);
      }
    }

    this._enrichmentCacheHits++;
    if (this._enrichmentCacheHits % 5 === 0) {
      console.log(
        `[ContextLoader] ⚡ Enrichment cache: ${this._enrichmentCacheHits} hits / ` +
        `${this._enrichmentCacheMisses} misses (saving ~${cached.tokens * this._enrichmentCacheHits} token estimations)`
      );
    }

    return {
      sections: [...cached.sections],
      sources: [...cached.sources],
      tokens: cached.tokens,
    };
  }

  /**
   * Stores the computed static layer results in the enrichment cache.
   *
   * @param {string}   role
   * @param {string[]} sections
   * @param {string[]} sources
   * @param {number}   tokens
   * @private
   */
  _storeStaticLayersCache(role, sections, sources, tokens) {
    const retiredCount = this._retiredSkills ? this._retiredSkills.size : 0;
    const cacheKey = `static:${role}:retired=${retiredCount}`;

    // Collect mtimes for all source files in the file cache
    const mtimes = new Map();
    for (const [filePath, entry] of this._fileCache) {
      mtimes.set(filePath, entry.mtime);
    }

    this._enrichmentCache.set(cacheKey, {
      sections: [...sections],
      sources: [...sources],
      tokens,
      mtimes,
    });
  }

  /**
   * Returns enrichment cache statistics for observability.
   * @returns {{ hits: number, misses: number, hitRate: string, cachedRoles: string[] }}
   */
  getEnrichmentCacheStats() {
    const total = this._enrichmentCacheHits + this._enrichmentCacheMisses;
    return {
      hits: this._enrichmentCacheHits,
      misses: this._enrichmentCacheMisses,
      hitRate: total > 0 ? `${(this._enrichmentCacheHits / total * 100).toFixed(0)}%` : 'n/a',
      cachedRoles: [...this._enrichmentCache.keys()].map(k => k.replace('static:', '')),
    };
  }

  // ─── Skill Matching ───────────────────────────────────────────────────────

  /**
   * Returns skill names ranked by relevance to the task text.
   *
   * ADR-OpenSpace: Replaced pure keyword-count matching with BM25+Embedding
   * hybrid ranking (inspired by OpenSpace's SkillRegistry).
   *
   * Architecture:
   *   Layer 1: BM25 (synchronous, <1ms) — proper TF-IDF scoring with document
   *            length normalisation. Handles partial matches, rare-term boosting,
   *            and multi-word queries far better than keyword counting.
   *   Layer 2: Embedding reranking (async, ~50ms) — cosine similarity on skill
   *            descriptions. Only activated when EmbeddingService is ready.
   *   Fallback: If SkillRanker corpus is not built, falls back to keyword matching.
   *
   * @param {string} taskText
   * @param {string} role
   * @returns {string[]}
   */
  _matchSkills(taskText, role) {
    // Ensure SkillRanker corpus is built (lazy, rebuilds when dirty)
    if (this._skillRankerDirty) {
      this._rebuildSkillRankerCorpus();
    }

    // Primary path: BM25+Embedding hybrid ranking
    if (this._skillRanker.isReady()) {
      // BM25 is synchronous; embedding reranking is async but we need sync here.
      // Use BM25-only for the synchronous path.
      const bm25Results = this._skillRanker.rankBM25(taskText)
        .filter(r => !this._retiredSkills.has(r.name))
        .map(r => {
          let policyWeight = 1;
          if (this._orchestrator && this._orchestrator.skillEvolution) {
            const meta = this._orchestrator.skillEvolution.registry.get(r.name);
            policyWeight = Number(meta?.policyWeight || 1);
          }
          return { ...r, weightedScore: (r.score || 0) * policyWeight };
        })
        .sort((a, b) => b.weightedScore - a.weightedScore)
        .slice(0, 3)
        .map(r => r.name);

      if (bm25Results.length > 0) {
        return bm25Results;
      }
    }

    // Fallback: keyword matching (for backward compatibility or empty corpus)
    return this._matchSkillsByKeyword(taskText, role);
  }

  /**
   * Async version of _matchSkills that uses full BM25+Embedding hybrid ranking.
   * Called from resolve() when async context is available.
   *
   * @param {string} taskText
   * @param {string} role
   * @returns {Promise<string[]>}
   */
  async _matchSkillsAsync(taskText, role) {
    if (this._skillRankerDirty) {
      this._rebuildSkillRankerCorpus();
    }

    if (this._skillRanker.isReady()) {
      const results = await this._skillRanker.rank(taskText, {
        maxResults: 3,
        excludeSkills: this._retiredSkills,
      });
      if (results.length > 0) {
        return results.map(r => r.name);
      }
    }

    return this._matchSkillsByKeyword(taskText, role);
  }

  /**
   * Rebuilds the SkillRanker BM25 corpus from available skill files.
   * Collects metadata from BUILTIN_SKILL_KEYWORDS, skill file content,
   * and the skill registry (if available via orchestrator).
   * @private
   */
  _rebuildSkillRankerCorpus() {
    const skills = [];

    for (const [skillName, keywords] of Object.entries(this._skillKeywords)) {
      if (this._retiredSkills.has(skillName)) continue;

      const skillPath = path.join(this._skillsDir, `${skillName}.md`);
      const content = this._readFileCached(skillPath);
      if (!content) continue;

      // Extract description from registry if available
      let description = '';
      if (this._orchestrator && this._orchestrator.skillEvolution) {
        const meta = this._orchestrator.skillEvolution.registry.get(skillName);
        if (meta) description = meta.description || '';
      }

      // Extract first paragraph as content snippet
      const firstParagraph = content.split('\n\n').find(p => p.trim() && !p.startsWith('---') && !p.startsWith('#')) || '';

      skills.push({
        name: skillName,
        description,
        keywords,
        contentSnippet: firstParagraph.slice(0, 300),
      });
    }

    // Also include project-specific skills from registry (custom filePath)
    if (this._orchestrator && this._orchestrator.skillEvolution) {
      for (const meta of this._orchestrator.skillEvolution.registry.values()) {
        if (this._retiredSkills.has(meta.name)) continue;
        if (skills.some(s => s.name === meta.name)) continue; // Already added

        const content = this._readFileCached(meta.filePath);
        if (!content) continue;

        const firstParagraph = content.split('\n\n').find(p => p.trim() && !p.startsWith('---') && !p.startsWith('#')) || '';

        skills.push({
          name: meta.name,
          description: meta.description || '',
          keywords: (meta.triggers && meta.triggers.keywords) || [],
          contentSnippet: firstParagraph.slice(0, 300),
        });
      }
    }

    this._skillRanker.buildCorpus(skills);
    this._skillRankerDirty = false;

    if (skills.length > 0) {
      const stats = this._skillRanker.getStats();
      console.log(`[ContextLoader] 📊 SkillRanker corpus built: ${stats.corpusSize} skills, ${stats.vocabularySize} terms, avgDocLen=${stats.avgDocLength}`);
    }
  }

  /**
   * Layer 1: Pure keyword matching (original implementation).
   * @param {string} taskText
   * @param {string} role
   * @returns {string[]}
   * @private
   */
  _matchSkillsByKeyword(taskText, role) {
    const lower = taskText.toLowerCase();
    const scores = [];

    for (const [skillName, keywords] of Object.entries(this._skillKeywords)) {
      // Gap 1 fix: skip retired skills — they should not be injected into prompts.
      // retiredAt is set by SkillEvolutionEngine.retireStaleSkills().
      if (this._retiredSkills.has(skillName)) continue;

      const skillPath = path.join(this._skillsDir, `${skillName}.md`);
      // Use _readFileCached to benefit from the cache (also pre-warms the cache
      // for _loadSkill which will be called next for matching skills).
      if (!this._readFileCached(skillPath)) continue;

      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > 0) scores.push({ skillName, score });
    }

    // Sort by score descending, return top 3 to stay within token budget
    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(s => s.skillName);
  }

  /**
   * P1.5: Build risk-driven skill pack list.
   * Priority sources:
   *   1) Explicit riskProfile from caller (preferred)
   *   2) Lightweight keyword fallback from task text
   *
   * @param {string} taskText
   * @param {string} role
   * @returns {string[]}
   * @private
   */
  _getRiskPackSkills(taskText, role) {
    const profile = this._riskProfile || {};
    const lower = (taskText || '').toLowerCase();

    const inferred = {
      security: Number(profile.security || 0),
      performance: Number(profile.performance || 0),
      interface: Number(profile.interface || 0),
    };

    if (inferred.security <= 0 && /\b(auth|xss|csrf|inject|sql|secret|token|credential|vulnerab)/i.test(lower)) {
      inferred.security = 0.6;
    }
    if (inferred.performance <= 0 && /\b(perf|latency|throughput|n\+1|memory|blocking|cache|optimi)/i.test(lower)) {
      inferred.performance = 0.6;
    }
    if (inferred.interface <= 0 && /\b(interface|contract|schema|export|signature|breaking|compatib)/i.test(lower)) {
      inferred.interface = 0.6;
    }

    const dimensions = Object.entries(inferred)
      .filter(([, score]) => score >= 0.35)
      .sort((a, b) => b[1] - a[1]);

    const riskSkills = [];
    for (const [dimension] of dimensions) {
      const packs = RISK_SKILL_PACKS[dimension] || [];
      for (const skillName of packs) {
        if (riskSkills.includes(skillName)) continue;
        if (this._retiredSkills.has(skillName)) continue;

        const skillPath = path.join(this._skillsDir, `${skillName}.md`);
        if (!this._readFileCached(skillPath)) continue;
        riskSkills.push(skillName);

        if (riskSkills.length >= RISK_SKILL_MAX_COUNT) {
          return riskSkills;
        }
      }
    }

    return riskSkills;
  }

  /**
   * Updates the EmbeddingService reference in the SkillRanker.
   * Called when EmbeddingService becomes ready after lazy init.
   *
   * @param {import('./embedding-service').EmbeddingService} embeddingService
   */
  setEmbeddingService(embeddingService) {
    this._embeddingService = embeddingService;
    this._skillRanker.setEmbeddingService(embeddingService);
  }

  /**
   * Returns the SkillRanker instance for external access (e.g. observability).
   * @returns {SkillRanker}
   */
  getSkillRanker() {
    return this._skillRanker;
  }

  /**
   * Marks the SkillRanker corpus as dirty (needs rebuild).
   * Call when skills are added, removed, or modified.
   */
  invalidateSkillRanker() {
    this._skillRankerDirty = true;
  }

  // ─── Constraint Section Filtering ────────────────────────────────────────

  /**
   * Filters architecture-constraints.md content to include only sections
   * relevant to the given role. This saves ~6-9K tokens per pipeline run
   * by not injecting the full ~3K-token document into every stage.
   *
   * Splitting strategy: the document is split at `## ` heading boundaries.
   * The preamble (content before the first ## heading, including the # title
   * and any introductory text) is always included.
   *
   * @param {string} content - Full content of architecture-constraints.md
   * @param {string} role    - Agent role (analyst|architect|developer|tester|...)
   * @returns {string} Filtered content (may be the full document if role = '*' or unknown)
   */
  _filterConstraintSections(content, role) {
    const sectionConfig = ROLE_CONSTRAINT_SECTIONS[role];

    // No config for this role, or '*' = full document
    if (!sectionConfig || sectionConfig === '*') {
      return content;
    }

    // Empty array = no sections needed (e.g. init-agent)
    if (Array.isArray(sectionConfig) && sectionConfig.length === 0) {
      return '';
    }

    // Split at ## headings, preserving the heading line in each chunk
    const chunks = content.split(/(?=^## )/m);

    // Preamble: everything before the first ## heading (title + intro)
    const preamble = chunks.length > 0 && !chunks[0].startsWith('## ')
      ? chunks[0]
      : '';

    // Filter: keep only chunks whose heading starts with a configured section name.
    // We use startsWith instead of exact match because headings may have suffixes
    // like "(P1-4)" or "(Foundational Constraint, ADR-37)".
    const allowedSections = sectionConfig.map(s => s.toLowerCase());
    const kept = chunks.filter(chunk => {
      if (!chunk.startsWith('## ')) return false; // skip preamble (handled above)
      // Extract heading text: "## File Size Limits\n..." → "file size limits"
      const headingLine = chunk.split('\n')[0];
      const headingText = headingLine.replace(/^##\s+/, '').trim().toLowerCase();
      return allowedSections.some(s => headingText.startsWith(s));
    });

    if (kept.length === 0) {
      // No matching sections found — return preamble only as a safety fallback
      return preamble.trim();
    }

    return (preamble + kept.join('\n')).trim();
  }

  // ─── ADR Extraction ───────────────────────────────────────────────────────

  /**
   * Extracts relevant ADR entries from decision-log.md content.
   * Matches ADR blocks whose title or content contains task keywords.
   * Falls back to the last 2 ADRs if no keyword match found.
   *
   * @param {string} logContent  - Full content of decision-log.md
   * @param {string} taskText    - Task text for keyword matching
   * @param {number} tokenBudget - Max tokens for the digest
   * @returns {string|null}
   */
  _extractRelevantADRs(logContent, taskText, tokenBudget) {
    // ── Check LLM digest cache first ──────────────────────────────────────
    const cacheKey = `${taskText.slice(0, 200)}::${logContent.length}`;
    if (this._adrDigestCache.has(cacheKey)) {
      const cached = this._adrDigestCache.get(cacheKey);
      console.log(`[ContextLoader] 🤖 Using cached LLM ADR digest (${cached.length} chars).`);
      return this._truncate(cached, tokenBudget);
    }

    // Split into ADR blocks (each starts with ## ADR-)
    const adrBlocks = logContent.split(/(?=^## ADR-)/m).filter(b => b.trim().startsWith('## ADR-'));
    if (adrBlocks.length === 0) return null;

    const taskLower = taskText.toLowerCase();
    const taskWords = taskLower.split(/\W+/).filter(w => w.length > 3);

    // Score each ADR block by keyword overlap
    const scored = adrBlocks.map(block => {
      const blockLower = block.toLowerCase();
      const score = taskWords.filter(w => blockLower.includes(w)).length;
      return { block, score };
    });

    // Sort by score, take top matches; always include the most recent ADR
    const sorted = scored.sort((a, b) => b.score - a.score);
    const topMatches = sorted.filter(s => s.score > 0).slice(0, 3);

    // If no keyword match, fall back to the last 2 ADRs (most recent decisions)
    const toInclude = topMatches.length > 0
      ? topMatches
      : scored.slice(-2);

    // Build digest: extract just the Status + Context + Decision lines (not full body)
    const digestParts = toInclude.map(({ block }) => {
      const lines = block.split('\n');
      const title = lines[0]; // ## ADR-xxx: title
      const statusLine = lines.find(l => l.startsWith('**Status**'));
      const contextIdx = lines.findIndex(l => l.startsWith('**Context**'));
      const decisionIdx = lines.findIndex(l => l.startsWith('**Decision**'));

      const summary = [
        title,
        statusLine || '',
        contextIdx >= 0 ? lines.slice(contextIdx, contextIdx + 3).join('\n') : '',
        decisionIdx >= 0 ? lines.slice(decisionIdx, decisionIdx + 3).join('\n') : '',
      ].filter(Boolean).join('\n');

      return summary;
    });

    const digest = digestParts.join('\n\n---\n\n');
    return this._truncate(digest, tokenBudget);
  }

  /**
   * Async LLM-enhanced ADR digest generation.
   * Selects the most relevant ADRs using semantic understanding and produces
   * a concise digest that preserves Decision + Consequences (not just first 3 lines).
   *
   * Call this BEFORE resolve() to populate the cache. resolve() remains synchronous
   * and will use the cached LLM digest if available.
   *
   * @param {string} logContent - Full content of decision-log.md
   * @param {string} taskText - The current task description
   * @param {number} tokenBudget - Max tokens for the digest
   * @returns {Promise<void>}
   */
  async preloadAdrDigest(logContent, taskText, tokenBudget) {
    if (!this._cheapLlmCall || !logContent || !taskText) return;

    const cacheKey = `${taskText.slice(0, 200)}::${logContent.length}`;
    if (this._adrDigestCache.has(cacheKey)) return; // Already cached

    const adrBlocks = logContent.split(/(?=^## ADR-)/m).filter(b => b.trim().startsWith('## ADR-'));
    if (adrBlocks.length === 0) return;

    try {
      // Prepare ADR summaries for LLM (title + first 5 lines each, to bound input)
      const adrSummaries = adrBlocks.map((block, i) => {
        const lines = block.split('\n');
        return `[ADR-${i}] ${lines.slice(0, 6).join('\n')}`;
      }).join('\n\n');

      const truncatedSummaries = adrSummaries.slice(0, 4000);
      const maxChars = Math.max(tokenBudget * 4, 600); // Rough token-to-char

      const prompt = [
        `You are an architecture decision reviewer. Given a task description and a list of Architecture Decision Records (ADRs), do two things:`,
        `1. Select the top 3 most relevant ADRs for this task (by semantic relevance, not just keyword match).`,
        `2. For each selected ADR, produce a concise digest that preserves: Title, Status, Decision, and key Consequences/Trade-offs.`,
        ``,
        `Output format: Return ONLY the digest text (Markdown), no preamble. Each ADR separated by "---".`,
        `Total output must be under ${maxChars} characters.`,
        `If the ADRs are in Chinese, output in Chinese.`,
        ``,
        `--- TASK ---`,
        taskText.slice(0, 500),
        `--- ADR LIST ---`,
        truncatedSummaries,
        `--- END ---`,
      ].join('\n');

      const response = await this._cheapLlmCall(prompt);
      if (response && typeof response === 'string' && response.trim().length > 30) {
        const digest = response.trim().slice(0, maxChars);
        this._adrDigestCache.set(cacheKey, digest);
        console.log(`[ContextLoader] 🤖 LLM ADR digest generated: ${digest.length} chars for ${adrBlocks.length} ADR(s).`);
      }
    } catch (err) {
      console.warn(`[ContextLoader] ⚠️ LLM ADR digest failed (falling back to heuristic): ${err.message}`);
    }
  }

  // ─── YAML Frontmatter Parsing ──────────────────────────────────────────────

  /**
   * Parses YAML frontmatter from a skill file.
   * Returns the parsed metadata and the body content after the frontmatter.
   *
   * @param {string} content - Full skill file content
   * @returns {{ meta: object, body: string }}
   */
  _parseFrontmatter(content) {
    if (!content || !content.startsWith('---')) {
      return { meta: {}, body: content || '' };
    }
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) {
      return { meta: {}, body: content };
    }

    const yamlBlock = content.slice(3, endIdx).trim();
    const meta = {};
    let currentKey = null;

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Handle nested keys (e.g. "  keywords: [...]")
      if (line.startsWith('  ') && currentKey) {
        const nestedMatch = trimmed.match(/^(\w+):\s*(.*)$/);
        if (nestedMatch) {
          if (typeof meta[currentKey] !== 'object' || Array.isArray(meta[currentKey])) {
            meta[currentKey] = {};
          }
          meta[currentKey][nestedMatch[1]] = this._parseYamlValue(nestedMatch[2]);
        }
        continue;
      }

      // Handle top-level keys
      const match = trimmed.match(/^(\w[\w_]*):\s*(.*)$/);
      if (match) {
        currentKey = match[1];
        const val = match[2];
        if (val === '' || val === undefined) {
          meta[currentKey] = {};
        } else {
          meta[currentKey] = this._parseYamlValue(val);
        }
      }
    }

    return { meta, body: content.slice(endIdx + 3).trim() };
  }

  /**
   * Parses a simple YAML value (string, number, array).
   * @param {string} val
   * @returns {*}
   */
  _parseYamlValue(val) {
    if (!val || val.trim() === '') return '';
    const trimmed = val.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  }

  // ─── Skill Loading (with Dependency Resolution) ─────────────────────────────

  /**
   * Loads a skill file with recursive dependency resolution.
   * Dependencies declared in YAML frontmatter are automatically loaded.
   * Circular dependencies are detected via a visited set.
   *
   * @param {string} skillName
   * @param {number} tokenBudget
   * @param {number} depth - Current recursion depth (0 = root skill)
   * @param {Set<string>} [visited] - Visited set for circular dependency detection
   * @returns {{ sections: string[], sources: string[], tokens: number }|null}
   */
_loadSkillWithDeps(skillName, tokenBudget, depth = 0, visited = null) {
    return loadSkillWithDeps({
      skillName,
      tokenBudget,
      depth,
      visited,
      loadedSkillsInResolve: this._loadedSkillsInResolve,
      loadSkill: (name, budget, isDep) => this._loadSkill(name, budget, isDep),
      skillsDir: this._skillsDir,
    });
  }

  /**
   * Loads a skill file and returns a formatted section.
   * Parses YAML frontmatter for metadata and dependencies.
   *
   * @param {string} skillName
   * @param {number} tokenBudget
   * @param {boolean} [isDep=false] - True if loaded as a dependency (uses compact format)
   * @returns {{ section: string, source: string, tokens: number, dependencies: string[] }|null}
   */
_loadSkill(skillName, tokenBudget, isDep = false) {
    // Resolve skill registry for custom filePath lookup (project-specific skills
    // stored outside workflow/skills/, e.g. <projectRoot>/.workflow/skills/)
    const skillRegistry = this._orchestrator && this._orchestrator.skillEvolution
      ? this._orchestrator.skillEvolution.registry
      : null;
    return loadSkill({
      skillName,
      tokenBudget,
      isDep,
      retiredSkills: this._retiredSkills,
      skillsDir: this._skillsDir,
      readFileCached: (p) => this._readFileCached(p),
      parseFrontmatter: (c) => this._parseFrontmatter(c),
      truncate: (c, b) => this._truncate(c, b),
      isPlaceholderSkill: (c) => this._isPlaceholderSkill(c),
      triggerLazyEnrichment: (n) => this._triggerLazyEnrichment(n),
      validateSkillContent: (c, m) => this._validateSkillContent(c, m),
      skillRegistry,
    });
  }

  /**
   * Returns true if a skill file has no real content yet (only placeholder text).
   */
_isPlaceholderSkill(content) {
    return isPlaceholderSkill(content);
  }

  /**
   * ADR-45: Triggers lazy enrichment for a placeholder skill.
   * Called when ContextLoader first detects a placeholder skill during loading.
   * The enrichment runs asynchronously in fire-and-forget mode.
   *
   * @param {string} skillName - Name of the skill to enrich
   * @private
   */
_triggerLazyEnrichment(skillName) {
    const trigger = createLazyEnrichmentTrigger({
      orchestrator: this._orchestrator,
      enrichmentInProgress: this._enrichmentInProgress,
      skillsDir: this._skillsDir,
      fileCache: this._fileCache,
    });
    trigger(skillName);
  }

  // ─── Gap 2: Skill Content Structure Validation ──────────────────────────

  /**
   * Validates that a skill file has meaningful content structure.
   * Returns true if the skill passes all quality checks.
   *
   * Checks:
   *   1. Minimum word count (at least 20 words of real content)
   *   2. At least one ## section heading
   *   3. If YAML frontmatter exists, it must have `name` field
   *
   * @param {string} content - Full skill file content
   * @param {object} meta - Parsed frontmatter metadata
   * @returns {{ valid: boolean, reason: string }}
   */
_validateSkillContent(content, meta) {
    return validateSkillContent(content, meta);
  }
  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Truncates content to fit within a token budget.
   * Truncates at paragraph boundaries when possible.
   *
   * D6 optimisation: uses a content-aware chars/token ratio instead of a fixed
   * constant. Chinese text averages ~2 chars/token (vs ~4 for English), so a
   * Chinese-heavy document with 2000 chars is ~1000 tokens, not ~500.
   * We sample the first 200 chars to estimate the CJK ratio and adjust accordingly.
   *
   * @param {string} content
   * @param {number} tokenBudget
   * @returns {string}
   */
_truncate(content, tokenBudget) {
    return truncateContent(content, tokenBudget);
  }
}

module.exports = { ContextLoader, LOAD_LEVEL };
