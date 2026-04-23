/**
 * Experience Query – Search, keyword extraction, and LLM query expansion
 *
 * ADR-33 Phase 4: This module has been split into sub-modules:
 *   - experience-query-nlp.js        – Multilingual NLP, stopwords, keyword extraction
 *   - experience-query-similarity.js – Content similarity, deduplication, clustering
 *   - experience-query.js (this)     – ExperienceQueryMixin (search, context blocks, LLM expansion)
 *
 * All exports are re-exported from this file for backward compatibility.
 *
 * @module experience-query
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Import from sub-modules ────────────────────────────────────────────────

const {
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  MULTILANG_STOPWORDS,
  CODE_KEYWORDS,
  detectLanguage,
  tokenizeByLanguage,
  extractKeywords,
  computeIdfValues,
} = require('./experience-query-nlp');

const {
  ExperienceDeduplicator,
  computeNGramFingerprint,
  computeMinHash,
  computeMinHashSimilarity,
  computeJaccardSimilarity,
  computeExperienceSimilarity,
} = require('./experience-query-similarity');

const { SemanticCompressor } = require('./semantic-compressor');

const { getLayerForCategory } = require('./experience-types');

// T-4: Layer-aware freshness. Different knowledge layers age at different rates:
// PLATFORM (frameworks/APIs) = 180d, DOMAIN (business rules) = 60d, PRACTICE (pitfalls) = 14d.
// Unknown layers default to DOMAIN's 60d (matches the previous flat HALF_LIFE_DAYS).
const DEFAULT_HALF_LIFE_MAP = Object.freeze({
  platform: 180,
  domain:   60,
  practice: 14,
});

// Hit-recency boost: a recent hit on an experience suggests it is still useful,
// so temporarily raise its ranking. Decays over 30 days.
const HIT_RECENCY_HALF_LIFE_DAYS = 30;
const HIT_RECENCY_MAX_BOOST = 1.4;

// Hit-count boost: dampened by log to prevent runaway dominance by popular entries.
const HIT_COUNT_DAMPENING_FACTOR = 0.15;

/**
 * Pure function: compute a layer-aware freshness score for an experience.
 *
 * Formula:
 *   decay         = 0.5 ^ (daysSinceActivity / halfLife(layer))
 *   recencyBoost  = 1 + HIT_RECENCY_MAX_BOOST * 0.5^(daysSinceHit / HIT_RECENCY_HALF_LIFE_DAYS)
 *   countBoost    = 1 + log2(1 + hitCount) * HIT_COUNT_DAMPENING_FACTOR
 *   freshness     = decay * recencyBoost * countBoost
 *
 * If any input is malformed, returns 1.0 (neutral) — never throws, never returns NaN/Infinity.
 *
 * @param {object} exp        Experience record (needs category, updatedAt or createdAt; optional lastHitAt, hitCount)
 * @param {object} [opts]
 * @param {number} [opts.nowMs]      Current timestamp in ms (injected for testability)
 * @param {object} [opts.halfLifeMap] Override default half-life map (testing/config)
 * @returns {number} freshness score in [0, ~3.24]
 */
function calculateFreshnessScore(exp, opts = {}) {
  if (!exp || typeof exp !== 'object') return 1.0;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const halfLifeMap = opts.halfLifeMap || DEFAULT_HALF_LIFE_MAP;

  const activityRaw = exp.updatedAt || exp.createdAt;
  const activityTs = activityRaw ? new Date(activityRaw).getTime() : NaN;
  if (!Number.isFinite(activityTs)) return 1.0;

  const layer = getLayerForCategory(exp.category);
  const halfLife = halfLifeMap[layer] || halfLifeMap.domain || 60;

  const daysSinceActivity = Math.max(0, (nowMs - activityTs) / 86400_000);
  const decay = Math.pow(0.5, daysSinceActivity / halfLife);

  let recencyBoost = 1;
  const lastHitRaw = exp.lastHitAt;
  if (lastHitRaw) {
    const lastHitTs = new Date(lastHitRaw).getTime();
    if (Number.isFinite(lastHitTs)) {
      const daysSinceHit = Math.max(0, (nowMs - lastHitTs) / 86400_000);
      recencyBoost = 1 + HIT_RECENCY_MAX_BOOST * Math.pow(0.5, daysSinceHit / HIT_RECENCY_HALF_LIFE_DAYS);
    }
  }

  const hitCount = Number.isFinite(exp.hitCount) ? exp.hitCount : 0;
  const countBoost = 1 + Math.log2(1 + Math.max(0, hitCount)) * HIT_COUNT_DAMPENING_FACTOR;

  const result = decay * recencyBoost * countBoost;
  return Number.isFinite(result) ? result : 1.0;
}

// Lazy SemanticCompressor for experience context block compression (P1-3).
// Mirrors enrichment-budget-guard.js lazy-singleton pattern.
let _expCompressorInstance = null;
let _expCompressorCheapLlm = null;

function _getExpCompressor() {
  if (!_expCompressorInstance) {
    _expCompressorInstance = new SemanticCompressor({ targetRatio: 0.6 });
    if (_expCompressorCheapLlm) {
      _expCompressorInstance.setCheapLlmCall(_expCompressorCheapLlm);
    }
  }
  return _expCompressorInstance;
}

function setExperienceCompressorCheapLlm(cheapLlmCall) {
  _expCompressorCheapLlm = cheapLlmCall;
  _expCompressorInstance = null;
}

async function _compressExperienceBlock(raw, maxChars) {
  if (process.env.EXPERIENCE_COMPRESS_ENABLED === 'false') {
    return raw.slice(0, maxChars) + '\n\n_... (experience context truncated to stay within token budget)_';
  }
  try {
    const compressor = _getExpCompressor();
    const result = await compressor.compress(raw, { contentType: 'text', targetRatio: 0.6 });
    if (result && result.saved > 100 && result.ratio < 0.85) {
      console.error(`[ExperienceQuery] 🗜️  compressed: ${raw.length}→${result.content.length} chars (ratio=${result.ratio.toFixed(2)}, strategy=${result.strategy})`);
      return result.content + `\n\n_[compressed via ${result.strategy}, saved ${result.saved} chars]_`;
    }
  } catch (err) {
    console.error(`[ExperienceQuery] ⚠️  compression failed (non-fatal): ${err.message}`);
  }
  return raw.slice(0, maxChars) + '\n\n_... (experience context truncated to stay within token budget)_';
}

// ─── ExperienceQuery Mixin ──────────────────────────────────────────────────
// These methods are designed to be mixed into ExperienceStore.prototype.
// They reference `this.experiences`, `this._synonymTable`, `this._llmCall`, etc.

const ExperienceQueryMixin = {

  /**
   * Gets an experience by ID.
   * Event-Driven: Publishes EXPERIENCE_RETRIEVED for evolution tracking.
   *
   * @param {string} id – Experience ID
   * @returns {Experience|null} – Experience record or null
   */
  getById(id) {
    const exp = this._idIndex.get(id) || null;

    if (exp && this._eventBus) {
      this._eventBus.emit(this._eventBus.constructor.Events?.EXPERIENCE_RETRIEVED || 'experience:retrieved', {
        experience: exp,
        query: { type: 'id', value: id },
        timestamp: new Date().toISOString(),
      });
    }

    return exp;
  },

  /**
   * Searches experiences by keyword, type, category, skill, or tags.
   *
   * @param {object} query
   * @returns {Experience[]}
   */
  search({ keyword = null, type = null, category = null, skill = null, tags = null, sourceFile = null, moduleId = null, limit = 10, scoreSort = false } = {}) {
    const now = Date.now();
    let results = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);

    if (type) results = results.filter(e => e.type === type);
    if (category) results = results.filter(e => e.category === category);
    if (skill) {
      const exactMatches = results.filter(e => e.skill === skill);
      if (exactMatches.length > 0) {
        results = exactMatches;
      } else {
        const skillCategoryMap = {
          'architecture-design': 'architecture',
          'code-development': 'stable_pattern',
          'test-report': 'pitfall',
          'security-audit': 'performance',
        };
        const mappedCategory = skillCategoryMap[skill];
        if (mappedCategory) {
          const categoryMatches = results.filter(e => e.category === mappedCategory);
          if (categoryMatches.length > 0) {
            results = categoryMatches;
          }
        }
      }
    }
    if (sourceFile) results = results.filter(e => e.sourceFile && e.sourceFile.includes(sourceFile));
    if (moduleId) results = results.filter(e => e.moduleId === moduleId);
    if (tags && tags.length > 0) {
      results = results.filter(e =>
        tags.some(tag => e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase())))
      );
    }

    const ZOMBIE_RETRIEVAL_THRESHOLD = 5;
    const nowMs = now;

    if (keyword) {
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map(e => {
          let score = 0;
          const titleLower = (e.title || '').toLowerCase();
          const contentLower = (e.content || '').toLowerCase();
          const tagsLower = (e.tags || []).map(t => t.toLowerCase());
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 10;
            if (tagsLower.some(t => t.includes(kw))) score += 6;
            if (contentLower.includes(kw)) score += 2;
          }
          const freshness = calculateFreshnessScore(e, { nowMs });
          const finalScore = score * freshness;
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, score: isZombie ? finalScore * 0.1 : finalScore, rawScore: score };
        })
        .filter(({ rawScore }) => rawScore > 0);

      // Plan-C: Semantic boost for low-keyword-score results
      if (this._embeddingService && this._embeddingService.isReady() && keyword) {
        const queryKey = keyword.trim().toLowerCase();
        const queryVec = this._embeddingService._cache.get(queryKey);
        if (queryVec) {
          for (const item of results) {
            if (item.rawScore < 5) {
              const titleKey = item.exp.title.trim().toLowerCase();
              const titleVec = this._embeddingService._cache.get(titleKey);
              if (titleVec) {
                const semanticScore = this._embeddingService.cosineSimilarity(queryVec, titleVec);
                item.score += semanticScore * 8;
              }
            }
          }
        }
      }

      results = results
        .sort((a, b) => scoreSort ? b.score - a.score : b.exp.hitCount - a.exp.hitCount)
        .map(({ exp }) => exp);
    } else {
      results = results
        .map(e => {
          const freshness = calculateFreshnessScore(e, { nowMs });
          const decayedScore = (e.hitCount || 0) * freshness;
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, decayedScore: isZombie ? decayedScore * 0.1 : decayedScore };
        })
        .sort((a, b) => b.decayedScore - a.decayedScore)
        .map(({ exp }) => exp);
    }

    return results.slice(0, limit);
  },

  /**
   * Returns a formatted context block with experience IDs.
   *
   * @param {string} [skill]
   * @param {string} [taskDescription]
   * @param {number} [limit=5]
   * @param {object} [options]
   * @returns {Promise<{ block: string, ids: string[] }>}
   */
  async getContextBlockWithIds(skill = null, taskDescription = null, limit = 5, options = {}) {
    const ExperienceType = require('./experience-types').ExperienceType;
    if (!skill) return { block: '', ids: [] };

    let scoreSort = true;
    let keyword = null;
    if (taskDescription && taskDescription.trim().length > 0) {
      let taskKeywords = extractKeywords(taskDescription, 10);
      if (taskKeywords.length > 0) {
        try {
          taskKeywords = await this._expandKeywordsWithLlm(taskKeywords, skill);
        } catch (_) { /* Silent fallback */ }
      }
      if (taskKeywords.length > 0) {
        keyword = taskKeywords.join(' ');
        scoreSort = true;
      }
    }

    const perTypeLimit = Math.max(1, Math.ceil(limit / 2));
    let positives = this.search({ type: ExperienceType.POSITIVE, skill, keyword, limit: perTypeLimit, scoreSort });
    let negatives = this.search({ type: ExperienceType.NEGATIVE, skill, keyword, limit: perTypeLimit, scoreSort });

    const { techStack } = options;
    if (positives.length === 0 && negatives.length === 0 && techStack && techStack.length > 0) {
      const techSkillNames = techStack.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'));
      for (const techSkill of techSkillNames) {
        const techPositives = this.search({ type: ExperienceType.POSITIVE, skill: techSkill, keyword, limit: perTypeLimit, scoreSort });
        const techNegatives = this.search({ type: ExperienceType.NEGATIVE, skill: techSkill, keyword, limit: perTypeLimit, scoreSort });
        if (techPositives.length > 0 || techNegatives.length > 0) {
          positives = techPositives;
          negatives = techNegatives;
          console.log(`[ExperienceQuery] 🔄 Fallback to tech stack skill "${techSkill}" (${positives.length}+${negatives.length} experiences)`);
          break;
        }
      }
    }
    const ids = [...positives.map(e => e.id), ...negatives.map(e => e.id)];

    for (const id of ids) { this.markRetrieved(id); }

    const lines = ['## Accumulated Experience\n'];
    const { getSourceTypeLabel, DEFAULT_SOURCE_TYPE } = require('./experience-types');
    if (positives.length > 0) {
      lines.push('### ✅ Proven Patterns (use these)');
      for (const exp of positives) {
        const sourceLabel = getSourceTypeLabel(exp.sourceType || DEFAULT_SOURCE_TYPE);
        lines.push(`\n**[${sourceLabel}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) { lines.push('```'); lines.push(exp.codeExample); lines.push('```'); }
      }
    }
    if (negatives.length > 0) {
      lines.push('\n### ❌ Known Pitfalls (avoid these)');
      for (const exp of negatives) {
        const sourceLabel = getSourceTypeLabel(exp.sourceType || DEFAULT_SOURCE_TYPE);
        lines.push(`\n**[${sourceLabel}] ${exp.title}**`);
        lines.push(exp.content);
        if (exp.codeExample) { lines.push('```'); lines.push(exp.codeExample); lines.push('```'); }
      }
    }
    if (positives.length === 0 && negatives.length === 0) {
      lines.push('_No accumulated experience yet for this context._');
    }

    const MAX_CONTEXT_CHARS = 6000;
    const raw = lines.join('\n');
    const block = raw.length > MAX_CONTEXT_CHARS
      ? await _compressExperienceBlock(raw, MAX_CONTEXT_CHARS)
      : raw;

    return { block, ids };
  },

  /**
   * P1 DRY fix: getContextBlock delegates to getContextBlockWithIds.
   */
  async getContextBlock(skill = null, taskDescription = null) {
    if (!skill) return '';
    return (await this.getContextBlockWithIds(skill, taskDescription)).block;
  },

  /**
   * Computes which injected experience IDs actually matched the current task context.
   */
  computeMatchedIds(ids, errorContext = '') {
    const ExperienceType = require('./experience-types').ExperienceType;
    if (!ids || ids.length === 0) {
      return { matchedIds: [], matchedCount: 0, totalCount: 0 };
    }

    const errorLower = (errorContext || '').toLowerCase();

    const matchedIds = ids.filter(id => {
      const exp = this._idIndex.get(id);
      if (!exp) return false;
      if (exp.type === ExperienceType.POSITIVE) return true;

      let matchScore = 0;
      const MATCH_THRESHOLD = 2;
      for (const tag of (exp.tags || [])) {
        if (tag.length >= 3 && errorLower.includes(tag.toLowerCase())) matchScore++;
      }
      const categoryTokens = (exp.category || '').toLowerCase().split('_').filter(t => t.length >= 4);
      for (const token of categoryTokens) {
        if (errorLower.includes(token)) matchScore++;
      }
      const titleTokens = (exp.title || '').toLowerCase()
        .replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(t => t.length >= 5 && !STOPWORDS.has(t));
      for (const token of titleTokens) {
        if (errorLower.includes(token)) matchScore++;
      }
      return matchScore >= MATCH_THRESHOLD;
    });

    return { matchedIds, matchedCount: matchedIds.length, totalCount: ids.length };
  },

  // ─── LLM Query Expansion ──────────────────────────────────────────────────

  setLlmCall(llmCall) {
    if (typeof llmCall === 'function') {
      this._llmCall = llmCall;
      console.log(`[ExperienceStore] 🧠 LLM query expansion enabled.`);
    }
  },

  /**
   * Public API: Expand keywords using synonym table + LLM fallback.
   *
   * @param {string[]} keywords - Base keywords to expand
   * @param {string|null} [skill=null] - Optional skill context
   * @returns {Promise<string[]>} Expanded keyword list
   */
  async expandKeywords(keywords, skill = null) {
    return this._expandKeywordsWithLlm(keywords, skill);
  },

  async _expandKeywordsWithLlm(keywords, skill = null) {
    if (!keywords || keywords.length === 0) return keywords;

    // Step 1: Synonym Table Lookup (O(1), 0ms)
    const cacheKey = keywords.slice().sort().join('|');
    const tableEntry = this._synonymTable[cacheKey];
    if (tableEntry) {
      if (tableEntry._failedAt && (Date.now() - tableEntry._failedAt) < 600_000) {
        return keywords;
      }
      if (Array.isArray(tableEntry.expandedTerms) && tableEntry.expandedTerms.length > 0) {
        const merged = [...keywords, ...tableEntry.expandedTerms].slice(0, 20);
        tableEntry.hitCount = (tableEntry.hitCount || 0) + 1;
        this._synonymTableDirty = true;
        console.log(`[ExperienceStore] 📖 Synonym table HIT: [${keywords.join(', ')}] → +${tableEntry.expandedTerms.length} cached terms (hit #${tableEntry.hitCount})`);
        return merged;
      }
    }

    // Step 2: LLM Query Expansion (fallback, ~1-3s)
    if (!this._llmCall) return keywords;

    const skillHint = skill ? `\nDomain context: ${skill}` : '';
    const prompt = `You are a search query expansion engine for a software engineering experience database.

Given these search keywords: [${keywords.join(', ')}]${skillHint}

Generate 5-10 additional search terms that are:
- Synonyms (e.g. "auth" → "authentication", "login")
- Abbreviations or full forms (e.g. "k8s" → "kubernetes", "db" → "database")
- Closely related technical concepts (e.g. "cache" → "ttl", "invalidation", "memcached")

Rules:
- Only return terms highly likely to appear in software engineering experience records
- Do NOT return generic words (the, is, with, etc.)
- Do NOT repeat the original keywords
- Return ONLY a JSON array of strings, no explanation

Example: ["redis", "cache"] → ["memcached", "caching", "ttl", "invalidation", "key-value", "in-memory"]

Output:`;

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query expansion timeout')), 8000)
      );
      const response = await Promise.race([this._llmCall(prompt), timeoutPromise]);

      const cleaned = (response || '').replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const arrayMatch = cleaned.match(/\[([^\]]+)\]/);
      if (!arrayMatch) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: could not parse LLM response as JSON array.`);
        this._synonymTable[cacheKey] = {
          expandedTerms: [],
          createdAt: new Date().toISOString(),
          hitCount: 0,
          skill: skill || null,
          _failedAt: Date.now(),
        };
        this._synonymTableDirty = true;
        return keywords;
      }

      let expanded;
      try { expanded = JSON.parse(`[${arrayMatch[1]}]`); } catch (_) {
        console.warn(`[ExperienceStore] ⚠️  Query expansion: JSON parse failed.`);
        return keywords;
      }

      const originalSet = new Set(keywords.map(k => k.toLowerCase()));
      const validTerms = expanded
        .filter(term => typeof term === 'string' && term.trim().length > 0)
        .map(term => term.trim().toLowerCase())
        .filter(term => !originalSet.has(term) && !STOPWORDS.has(term));

      if (validTerms.length === 0) return keywords;

      // Step 3: Persist to Synonym Table (write-through)
      this._synonymTable[cacheKey] = {
        expandedTerms: validTerms,
        createdAt: new Date().toISOString(),
        hitCount: 0,
        skill: skill || null,
      };
      this._synonymTableDirty = true;
      this._saveSynonymTable();

      const merged = [...keywords, ...validTerms].slice(0, 20);
      console.log(`[ExperienceStore] 🧠 Query expansion (LLM→table): [${keywords.join(', ')}] → +${validTerms.length} terms: [${validTerms.join(', ')}]`);
      return merged;
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Query expansion failed (${err.message}). Using original keywords.`);
      return keywords;
    }
  },

  // ─── Synonym Table ──────────────────────────────────────────────────────────

  _loadSynonymTable() {
    try {
      if (fs.existsSync(this._synonymTablePath)) {
        const raw = JSON.parse(fs.readFileSync(this._synonymTablePath, 'utf-8'));
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          this._synonymTable = raw;
          const entryCount = Object.keys(raw).length;
          const totalHits = Object.values(raw).reduce((sum, e) => sum + (e.hitCount || 0), 0);
          console.log(`[ExperienceStore] 📖 Synonym table loaded: ${entryCount} entries, ${totalHits} total hits`);
        } else {
          console.warn(`[ExperienceStore] ⚠️  Synonym table file has unexpected format. Starting fresh.`);
          this._synonymTable = {};
        }
      } else {
        console.log(`[ExperienceStore] 📖 No synonym table found. Starting fresh (cold start).`);
      }
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Could not load synonym table: ${err.message}. Starting fresh.`);
      this._synonymTable = {};
    }
  },

  _saveSynonymTable() {
    if (!this._synonymTableDirty) return;
    try {
      const dir = path.dirname(this._synonymTablePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this._synonymTablePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this._synonymTable, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._synonymTablePath);
      this._synonymTableDirty = false;
    } catch (err) {
      console.warn(`[ExperienceStore] ⚠️  Could not save synonym table: ${err.message}`);
    }
  },

  flushSynonymTable() {
    if (this._synonymTableDirty) { this._saveSynonymTable(); }
  },

  getSynonymStats() {
    const entries = Object.entries(this._synonymTable);
    const entryCount = entries.length;
    const totalHits = entries.reduce((sum, [, e]) => sum + (e.hitCount || 0), 0);
    const topEntries = entries
      .sort((a, b) => (b[1].hitCount || 0) - (a[1].hitCount || 0))
      .slice(0, 10)
      .map(([key, val]) => ({
        keywords: key.split('|'),
        expandedTerms: val.expandedTerms,
        hitCount: val.hitCount || 0,
        skill: val.skill,
        createdAt: val.createdAt,
      }));
    const coldEntries = entries.filter(([, e]) => (e.hitCount || 0) === 0).length;
    const coldStartPct = entryCount > 0 ? Math.round((coldEntries / entryCount) * 100) : 100;
    return { entryCount, totalHits, topEntries, coldStartPct };
  },

  /**
   * Returns the full synonym table for use by other modules.
   * @returns {Object} The synonym table object
   */
  getSynonymTable() {
    return this._synonymTable || {};
  },

  importSynonymTable(externalTable) {
    if (!externalTable || typeof externalTable !== 'object' || Array.isArray(externalTable)) {
      return { imported: 0, skipped: 0, total: Object.keys(this._synonymTable).length };
    }
    let imported = 0;
    let skipped = 0;
    for (const [key, entry] of Object.entries(externalTable)) {
      if (this._synonymTable[key]) {
        const existingTerms = new Set(this._synonymTable[key].expandedTerms || []);
        const newTerms = (entry.expandedTerms || []).filter(t => !existingTerms.has(t));
        if (newTerms.length > 0) {
          this._synonymTable[key].expandedTerms.push(...newTerms);
          imported++;
        } else { skipped++; }
      } else {
        this._synonymTable[key] = {
          expandedTerms: entry.expandedTerms || [],
          createdAt: entry.createdAt || new Date().toISOString(),
          hitCount: 0,
          skill: entry.skill || null,
        };
        imported++;
      }
    }
    if (imported > 0) {
      this._synonymTableDirty = true;
      this._saveSynonymTable();
      console.log(`[ExperienceStore] 📖 Synonym table import: ${imported} entries imported, ${skipped} skipped.`);
    }
    return { imported, skipped, total: Object.keys(this._synonymTable).length };
  },
};

// ─── Module exports (backward compatible) ─────────────────────────────────

module.exports = {
  // Core mixin
  extractKeywords,
  ExperienceQueryMixin,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  // T-4: Layer-aware freshness (exported for testing/override)
  calculateFreshnessScore,
  DEFAULT_HALF_LIFE_MAP,
  // P1-3: Experience block compression (cheap-LLM injection)
  setExperienceCompressorCheapLlm,
  // Multilingual exports
  MULTILANG_STOPWORDS,
  detectLanguage,
  tokenizeByLanguage,
  // TF-IDF exports
  computeIdfValues,
  // Similarity clustering exports
  ExperienceDeduplicator,
  computeNGramFingerprint,
  computeMinHash,
  computeMinHashSimilarity,
  computeJaccardSimilarity,
  computeExperienceSimilarity,
};
