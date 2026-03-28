/**
 * Experience Query – Search, keyword extraction, and LLM query expansion
 *
 * Extracted from ExperienceStore to enable independent evolution of search
 * algorithms, synonym tables, and keyword expansion strategies.
 *
 * This module provides:
 *   - extractKeywords()       – stopword-aware keyword extraction
 *   - ExperienceQuery mixin   – search(), getContextBlock*(), computeMatchedIds()
 *   - LLM query expansion     – synonym table + LLM fallback
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── P0 Fix: Stopwords + Short-word Whitelist for keyword extraction ────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'have', 'will',
  'been', 'were', 'they', 'their', 'what', 'when', 'where', 'which', 'there',
  'about', 'each', 'make', 'like', 'just', 'over', 'such', 'than', 'into',
  'some', 'could', 'them', 'then', 'should', 'would', 'also', 'after', 'before',
  'more', 'most', 'only', 'other', 'these', 'those', 'does', 'done', 'using',
  'used', 'uses', 'need', 'needs', 'want', 'very', 'well', 'here',
  'implement', 'implementation', 'create', 'creating', 'please', 'ensure',
  'based', 'following', 'include', 'including', 'support', 'system', 'provide',
]);

const SHORT_WORD_WHITELIST = new Set([
  'api', 'jwt', 'sql', 'orm', 'ui', 'db', 'css', 'dom', 'url', 'xml',
  'cli', 'sdk', 'rpc', 'tcp', 'udp', 'ssl', 'tls', 'ssh', 'git', 'npm',
  'vue', 'tsx', 'jsx', 'ssr', 'spa', 'ecs', 'mvp', 'mvc', 'ddd', 'tdd',
  'bdd', 'ci', 'cd', 'io', 'ai', 'ml', 'go', 'lua', 'php', 'c++',
  'aws', 'gcp', 'k8s', 'os', 'gpu', 'cpu', 'ram', 'ssd', 'hdd',
]);

// ─── Multilingual Support: Language-specific stopwords ────────────────────

const MULTILANG_STOPWORDS = {
  en: new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'have', 'will',
    'been', 'were', 'they', 'their', 'what', 'when', 'where', 'which', 'there',
    'about', 'each', 'make', 'like', 'just', 'over', 'such', 'than', 'into',
    'some', 'could', 'them', 'then', 'should', 'would', 'also', 'after', 'before',
    'more', 'most', 'only', 'other', 'these', 'those', 'does', 'done', 'using',
    'used', 'uses', 'need', 'needs', 'want', 'very', 'well', 'here',
    'implement', 'implementation', 'create', 'creating', 'please', 'ensure',
    'based', 'following', 'include', 'including', 'support', 'system', 'provide',
  ]),
  zh: new Set([
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '那', '这些', '那些', '之', '与', '及', '等', '或', '但', '而', '因为', '所以', '如果', '虽然', '但是', '然后', '接着', '最后', '进行', '使用', '通过', '根据', '进行', '完成', '实现', '处理', '需要', '应该', '可以', '建议', '注意', '确保',
  ]),
  ja: new Set([
    'の', 'は', 'を', 'が', 'と', 'に', 'で', 'も', 'や', 'から', 'まで', 'より', 'など', 'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'ここ', 'そこ', 'あそこ', 'こと', 'もの', 'ため', 'よう', 'そう', 'ます', 'です', 'した', 'する', 'られる', 'ある', 'いる', 'なる', 'れる', 'せる', 'できる',
  ]),
  ko: new Set([
    '은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로', '와', '과', '도', '만', '까지', '부터', '처럼', '같이', '하고', '하지만', '그리고', '또는', '또', '아니면', '그래서', '그러나', '그러면', '하지만', '입니다', '입니다', '했습니다', '할', '수', '있는', '하는', '하는 것', '하다',
  ]),
};

const CODE_KEYWORDS = new Set([
  'api', 'jwt', 'sql', 'orm', 'ui', 'db', 'css', 'dom', 'url', 'xml',
  'cli', 'sdk', 'rpc', 'tcp', 'udp', 'ssl', 'tls', 'ssh', 'git', 'npm',
  'vue', 'tsx', 'jsx', 'ssr', 'spa', 'ecs', 'mvp', 'mvc', 'ddd', 'tdd',
  'bdd', 'ci', 'cd', 'io', 'ai', 'ml', 'go', 'lua', 'php', 'c++',
  'aws', 'gcp', 'k8s', 'os', 'gpu', 'cpu', 'ram', 'ssd', 'hdd', 'json',
  'yaml', 'html', 'http', 'https', 'rest', 'grpc', 'graphql', 'docker',
  'kubernetes', 'async', 'await', 'promise', 'callback', 'middleware',
  'controller', 'service', 'repository', 'model', 'entity', 'dto',
  'function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var',
  'import', 'export', 'require', 'module', 'package', 'library', 'framework',
  'frontend', 'backend', 'database', 'cache', 'queue', 'message', 'event',
  'error', 'exception', 'debug', 'log', 'test', 'mock', 'stub', 'deploy',
  'build', 'compile', 'run', 'debug', 'refactor', 'optimize', 'performance',
]);

// ─── Language Detection utilities ─────────────────────────────────────────

/**
 * Detects the primary language of text using Unicode range analysis.
 * Lightweight and fast, no ML model needed.
 *
 * @param {string} text - Input text
 * @returns {string} Language code: 'en', 'zh', 'ja', 'ko', 'mixed'
 */
function detectLanguage(text) {
  if (!text || !text.trim()) return 'en';

  const charCounts = { zh: 0, ja: 0, ko: 0, en: 0, other: 0 };

  for (const char of text) {
    const code = char.charCodeAt(0);

    // CJK Unified Ideographs (Chinese)
    if (code >= 0x4e00 && code <= 0x9fff) {
      charCounts.zh++;
    }
    // Hiragana and Katakana (Japanese)
    else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      charCounts.ja++;
    }
    // Hangul (Korean)
    else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) {
      charCounts.ko++;
    }
    // Latin (English and other European)
    else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      charCounts.en++;
    }
    else {
      charCounts.other++;
    }
  }

  const total = charCounts.zh + charCounts.ja + charCounts.ko + charCounts.en;
  if (total === 0) return 'en';

  // Find dominant language
  const threshold = 0.3;  // At least 30% to be considered primary
  const sorted = Object.entries(charCounts)
    .filter(([k, v]) => k !== 'other')
    .sort((a, b) => b[1] - a[1]);

  const [primary, count] = sorted[0];
  if (count / total >= threshold) {
    return primary;
  }

  // Check if it's a mix
  const significant = sorted.filter(([, v]) => v / total >= 0.15).length;
  return significant > 1 ? 'mixed' : primary;
}

/**
 * Tokenizes text based on detected language.
 * Uses different strategies for different languages.
 *
 * @param {string} text - Input text
 * @param {string} lang - Language code
 * @returns {string[]} Array of tokens
 */
function tokenizeByLanguage(text, lang) {
  if (!text) return [];

  switch (lang) {
    case 'zh':
    case 'ja':
      // For CJK: split by non-CJK chars, then n-gram for CJK chars
      return tokenizeCJK(text);
    case 'ko':
      // Korean has spaces, can use similar to English but with Josa removal
      return tokenizeKorean(text);
    case 'mixed':
      // Handle mixed language text
      return tokenizeMixed(text);
    case 'en':
    default:
      // English: traditional word splitting
      return text.toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
  }
}

/**
 * Tokenizes CJK (Chinese/Japanese) text.
 * Strategy: Extract full CJK words/phrases and English technical terms.
 */
function tokenizeCJK(text) {
  const tokens = [];

  // Extract CJK characters (main content words, typically 2-4 chars)
  const cjkMatches = text.match(/[\u4e00-\u9fff]{2,8}/g);
  if (cjkMatches) {
    tokens.push(...cjkMatches);
  }

  // Extract Hiragana/Katakana words
  const jaMatches = text.match(/[\u3040-\u309f\u30a0-\u30ff]{2,8}/g);
  if (jaMatches) {
    tokens.push(...jaMatches);
  }

  // Extract English technical terms and code keywords
  const codeMatches = text.match(/[a-zA-Z][a-zA-Z0-9_]*/g);
  if (codeMatches) {
    for (const word of codeMatches) {
      const lower = word.toLowerCase();
      if (lower.length >= 2) {
        tokens.push(lower);
      }
    }
  }

  return tokens;
}

/**
 * Tokenizes Korean text with Josa (particles) removal.
 */
function tokenizeKorean(text) {
  const tokens = [];

  // Extract Korean words
  const koMatches = text.match(/[\uac00-\ud7af]{2,8}/g);
  if (koMatches) {
    tokens.push(...koMatches);
  }

  // Extract English technical terms
  const codeMatches = text.match(/[a-zA-Z][a-zA-Z0-9_]*/g);
  if (codeMatches) {
    for (const word of codeMatches) {
      const lower = word.toLowerCase();
      if (lower.length >= 2) {
        tokens.push(lower);
      }
    }
  }

  return tokens;
}

/**
 * Tokenizes mixed language text.
 */
function tokenizeMixed(text) {
  const tokens = [];

  // Split by language type
  let currentChunk = '';
  let currentType = null;

  for (const char of text) {
    const code = char.charCodeAt(0);
    let charType = 'other';

    if (code >= 0x4e00 && code <= 0x9fff) charType = 'cjk';
    else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) charType = 'cjk';
    else if ((code >= 0xac00 && code <= 0xd7af)) charType = 'ko';
    else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) charType = 'en';

    if (charType !== currentType && currentChunk) {
      // Process the chunk
      if (currentType === 'cjk') {
        tokens.push(...tokenizeCJK(currentChunk));
      } else if (currentType === 'ko') {
        tokens.push(...tokenizeKorean(currentChunk));
      } else if (currentType === 'en') {
        tokens.push(...currentChunk.toLowerCase().split(/\s+/).filter(Boolean));
      }
      currentChunk = '';
    }

    currentType = charType;
    if (charType !== 'other') {
      currentChunk += char;
    }
  }

  // Process the last chunk
  if (currentChunk) {
    if (currentType === 'cjk') {
      tokens.push(...tokenizeCJK(currentChunk));
    } else if (currentType === 'ko') {
      tokens.push(...tokenizeKorean(currentChunk));
    } else if (currentType === 'en') {
      tokens.push(...currentChunk.toLowerCase().split(/\s+/).filter(Boolean));
    }
  }

  return tokens;
}

/**
 * Enhanced keyword extraction with multilingual support and TF-IDF ranking.
 *
 * @param {string} text - Source text to extract keywords from
 * @param {number} [maxKeywords=10] - Maximum keywords to return
 * @param {object} [options] - Additional options
 * @param {boolean} [options.detectLang=true] - Enable auto language detection
 * @param {string} [options.language] - Force specific language (override auto-detect)
 * @param {boolean} [options.includeCodeTerms=true] - Include code-specific keywords
 * @param {boolean} [options.useTfIdf=true] - Enable TF-IDF weighting for ranking
 * @param {Map<string, number>} [options.idfCache] - Pre-computed IDF values
 * @returns {string[]} Deduplicated, filtered keywords sorted by importance
 */
function extractKeywords(text, maxKeywords = 10, options = {}) {
  if (!text || !text.trim()) return [];

  const {
    detectLang = true,
    language: forcedLang = null,
    includeCodeTerms = true,
    useTfIdf = true,
    idfCache = null,
  } = options;

  // Detect or use forced language
  const detectedLang = forcedLang || (detectLang ? detectLanguage(text) : 'en');

  // Get appropriate stopwords
  let stopwords;
  if (detectedLang === 'mixed') {
    // Combine all stopwords for mixed text
    stopwords = new Set([
      ...MULTILANG_STOPWORDS.en,
      ...MULTILANG_STOPWORDS.zh,
      ...MULTILANG_STOPWORDS.ja,
      ...MULTILANG_STOPWORDS.ko,
    ]);
  } else if (MULTILANG_STOPWORDS[detectedLang]) {
    stopwords = MULTILANG_STOPWORDS[detectedLang];
  } else {
    stopwords = MULTILANG_STOPWORDS.en;
  }

  // Tokenize based on language
  const tokens = tokenizeByLanguage(text, detectedLang);

  // Compute term frequencies (TF)
  const termFreq = new Map();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const isCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(token);
    const minLen = isCJK ? 2 : 3;

    if (lower.length < minLen || stopwords.has(lower)) continue;
    termFreq.set(lower, (termFreq.get(lower) || 0) + 1);
  }

  // Score terms using TF-IDF
  const totalTerms = tokens.length;
  const scored = [];

  for (const [term, freq] of termFreq) {
    // TF (normalized)
    const tf = freq / totalTerms;

    // IDF (use cache if available, otherwise assume moderate rarity)
    const idf = idfCache?.get(term) ?? Math.log(100 / (freq + 1));

    // TF-IDF score
    let score = tf * idf;

    // Boost code keywords
    if (CODE_KEYWORDS.has(term)) {
      score *= 1.5;
    }

    // Boost longer terms (more specific)
    score *= (1 + term.length / 20);

    scored.push({ term, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Deduplicate and return top keywords
  const seen = new Set();
  const result = [];

  for (const { term } of scored) {
    if (seen.has(term)) continue;
    seen.add(term);

    // Always include the original case if available
    const original = tokens.find(t => t.toLowerCase() === term) || term;
    result.push(original);

    if (result.length >= maxKeywords) break;
  }

  // Fallback: if no keywords found, include some tokens
  if (result.length === 0 && includeCodeTerms) {
    for (const token of tokens) {
      if (token.length >= 2 && !seen.has(token.toLowerCase())) {
        result.push(token);
        if (result.length >= Math.min(5, maxKeywords)) break;
      }
    }
  }

  return result.slice(0, maxKeywords);
}

/**
 * Computes IDF (Inverse Document Frequency) values for a corpus of documents.
 * Used for TF-IDF keyword extraction.
 *
 * @param {string[]} documents - Array of document texts
 * @returns {Map<string, number>} IDF values for each term
 */
function computeIdfValues(documents) {
  const docFreq = new Map(); // term -> number of documents containing it
  const totalDocs = documents.length;

  for (const doc of documents) {
    const seenInDoc = new Set();
    const tokens = tokenizeByLanguage(doc, detectLanguage(doc));

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (!seenInDoc.has(lower)) {
        seenInDoc.add(lower);
        docFreq.set(lower, (docFreq.get(lower) || 0) + 1);
      }
    }
  }

  const idf = new Map();
  for (const [term, freq] of docFreq) {
    // IDF = log(N / df)
    idf.set(term, Math.log(totalDocs / freq));
  }

  return idf;
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

    // Event-Driven: Publish retrieval event for hit tracking and evolution
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
    // P1 fix: Skill matching with fallback to category/tags when no exact match.
    // This handles the semantic mismatch between workflow stage names (e.g., 'code-development')
    // and technology stack names (e.g., 'unity-csharp') stored in experiences.
    if (skill) {
      const exactMatches = results.filter(e => e.skill === skill);
      if (exactMatches.length > 0) {
        results = exactMatches;
      } else {
        // Fallback: try category matching (architecture-design -> ARCHITECTURE category)
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
          // If category match also fails, keep all results and let keyword scoring do the filtering
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
    // P1-2 fix: Pre-compute last-activity timestamps once, outside the scoring loop.
    // Avoids creating hundreds of Date objects per search call.
    const HALF_LIFE_DAYS = 60;
    const nowMs = now; // already in ms

    if (keyword) {
      const keywords = keyword.toLowerCase().split(/\s+/).filter(Boolean);
      results = results
        .map(e => {
          let score = 0;
          const titleLower = e.title.toLowerCase();
          const contentLower = e.content.toLowerCase();
          const tagsLower = e.tags.map(t => t.toLowerCase());
          for (const kw of keywords) {
            if (titleLower.includes(kw)) score += 10;
            if (tagsLower.some(t => t.includes(kw))) score += 6;
            if (contentLower.includes(kw)) score += 2;
          }
          // P1-2 fix: use cached timestamp (or compute once per experience)
          const lastActivity = e._lastActivityTs || (e._lastActivityTs = new Date(e.updatedAt || e.createdAt).getTime());
          const daysSinceActivity = (nowMs - lastActivity) / 86400_000;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);
          const hitBoost = Math.log2(1 + (e.hitCount || 0));
          const finalScore = score * recencyMultiplier * (1 + hitBoost * 0.2);
          const isZombie = (e.retrievalCount || 0) >= ZOMBIE_RETRIEVAL_THRESHOLD && e.hitCount === 0;
          return { exp: e, score: isZombie ? finalScore * 0.1 : finalScore, rawScore: score };
        })
        .filter(({ rawScore }) => rawScore > 0);

      // Plan-C: Semantic boost for low-keyword-score results.
      // When an EmbeddingService is available, experiences with low keyword scores
      // get a semantic similarity boost based on title embedding comparison.
      // This handles cases where the user's query uses different terminology
      // than what's stored in experience titles/tags.
      if (this._embeddingService && this._embeddingService.isReady() && keyword) {
        const queryKey = keyword.trim().toLowerCase();
        const queryVec = this._embeddingService._cache.get(queryKey);
        if (queryVec) {
          for (const item of results) {
            if (item.rawScore < 5) { // Only boost low-keyword-score items
              const titleKey = item.exp.title.trim().toLowerCase();
              const titleVec = this._embeddingService._cache.get(titleKey);
              if (titleVec) {
                const semanticScore = this._embeddingService.cosineSimilarity(queryVec, titleVec);
                item.score += semanticScore * 8; // Semantic boost weight
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
          // P1-2 fix: use cached timestamp
          const lastActivity = e._lastActivityTs || (e._lastActivityTs = new Date(e.updatedAt || e.createdAt).getTime());
          const daysSinceActivity = (nowMs - lastActivity) / 86400_000;
          const recencyMultiplier = 1 / (1 + daysSinceActivity / HALF_LIFE_DAYS);
          const decayedScore = (e.hitCount || 0) * recencyMultiplier;
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
   * P1 fix: Enhanced skill matching to support both workflow stage names (e.g., 'code-development')
   * and technology stack names (e.g., 'unity-csharp'). When skill is a workflow stage name,
   * it also tries to match experiences by techStack if provided.
   *
   * @param {string} [skill] - Workflow stage skill name (e.g., 'architecture-design', 'code-development')
   * @param {string} [taskDescription]
   * @param {number} [limit=5]
   * @param {object} [options]
   * @param {string[]} [options.techStack] - Detected tech stack names for fallback matching
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

    // P1 fix: If no results found and techStack is provided, try matching by tech stack skill
    const { techStack } = options;
    if (positives.length === 0 && negatives.length === 0 && techStack && techStack.length > 0) {
      // Map tech stack names to skill names (e.g., 'Unity + C#' -> 'unity-csharp')
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
      ? raw.slice(0, MAX_CONTEXT_CHARS) + '\n\n_... (experience context truncated to stay within token budget)_'
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
   * Use this instead of calling _expandKeywordsWithLlm() directly from external modules.
   *
   * @param {string[]} keywords - Base keywords to expand
   * @param {string|null} [skill=null] - Optional skill context for domain-specific expansion
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
      // P1-10 fix: If this entry was a recent failure (<10 min), skip LLM retry
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
        // P1-10 fix: cache negative result to avoid retrying on next call
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
   * Returns the full synonym table for use by other modules (PromptBuilder, ContextLoader).
   * Used to expand queries with synonyms for better recall.
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

// ─── Content Similarity Clustering ─────────────────────────────────────────
// Detects duplicate experiences based on content similarity (not just titles)

/**
 * Computes n-gram fingerprint for text similarity comparison.
 *
 * @param {string} text - Input text
 * @param {number} [n=3] - N-gram size
 * @returns {Set<string>} Set of n-grams
 */
function computeNGramFingerprint(text, n = 3) {
  if (!text || !text.trim()) return new Set();

  // Normalize text
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const ngrams = new Set();

  // For CJK languages, use character-level n-grams
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(normalized);

  if (hasCJK) {
    // Character-level n-grams for CJK
    for (let i = 0; i <= normalized.length - n; i++) {
      ngrams.add(normalized.slice(i, i + n));
    }
  } else {
    // Word-level n-grams for English and other languages
    const words = normalized.split(' ').filter(Boolean);

    // Use adaptive n: if not enough words, use smaller n
    const effectiveN = Math.min(n, Math.max(1, words.length));

    for (let i = 0; i <= words.length - effectiveN; i++) {
      ngrams.add(words.slice(i, i + effectiveN).join('_'));
    }

    // Also add individual words as unigrams for better matching
    for (const word of words) {
      if (word.length >= 3) {
        ngrams.add(word);
      }
    }
  }

  return ngrams;
}

/**
 * Computes MinHash signature for a set.
 * Uses multiple hash functions for approximation.
 *
 * @param {Set<string>} set - Input set
 * @param {number} [numHashes=16] - Number of hash functions
 * @returns {number[]} MinHash signature
 */
function computeMinHash(set, numHashes = 16) {
  const signature = [];
  const items = Array.from(set);

  // Use simple polynomial rolling hash with different seeds
  for (let i = 0; i < numHashes; i++) {
    let minHash = Infinity;
    const seed = i + 1;

    for (const item of items) {
      let hash = 0;
      for (let j = 0; j < item.length; j++) {
        hash = ((hash * 31) + item.charCodeAt(j) + seed) & 0x7FFFFFFF;
      }
      minHash = Math.min(minHash, hash);
    }

    signature.push(minHash === Infinity ? 0 : minHash);
  }

  return signature;
}

/**
 * Computes Jaccard similarity between two MinHash signatures.
 *
 * @param {number[]} sig1 - First signature
 * @param {number[]} sig2 - Second signature
 * @returns {number} Similarity score [0, 1]
 */
function computeMinHashSimilarity(sig1, sig2) {
  if (!sig1 || !sig2 || sig1.length !== sig2.length) return 0;

  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) matches++;
  }

  return matches / sig1.length;
}

/**
 * Computes direct Jaccard similarity between two sets.
 * More accurate but slower than MinHash approximation.
 *
 * @param {Set<string>} set1 - First set
 * @param {Set<string>} set2 - Second set
 * @returns {number} Jaccard similarity [0, 1]
 */
function computeJaccardSimilarity(set1, set2) {
  if (!set1.size || !set2.size) return 0;

  let intersection = 0;
  for (const item of set1) {
    if (set2.has(item)) intersection++;
  }

  return intersection / (set1.size + set2.size - intersection);
}

/**
 * Computes weighted similarity between two experiences.
 * Combines title and content similarity with different weights.
 *
 * For small datasets, uses direct Jaccard similarity (more accurate).
 * For large datasets, MinHash can be enabled for performance.
 *
 * @param {object} exp1 - First experience
 * @param {object} exp2 - Second experience
 * @param {object} [options] - Comparison options
 * @returns {number} Weighted similarity score [0, 1]
 */
function computeExperienceSimilarity(exp1, exp2, options = {}) {
  const {
    titleWeight = 0.3,
    contentWeight = 0.7,
    useMinHash = false,  // Default to false for better accuracy on small datasets
    ngramSize = 3,
  } = options;

  // Title similarity
  const title1 = (exp1.title || '').toLowerCase().trim();
  const title2 = (exp2.title || '').toLowerCase().trim();
  let titleSim = 0;

  if (title1 === title2 && title1.length > 0) {
    titleSim = 1.0;
  } else {
    const fp1 = computeNGramFingerprint(title1, ngramSize);
    const fp2 = computeNGramFingerprint(title2, ngramSize);

    if (fp1.size === 0 && fp2.size === 0) {
      titleSim = title1 === title2 ? 1.0 : 0.0;
    } else if (fp1.size === 0 || fp2.size === 0) {
      titleSim = 0.0;
    } else if (useMinHash && fp1.size > 100) {
      // Only use MinHash for large fingerprints
      const sig1 = computeMinHash(fp1);
      const sig2 = computeMinHash(fp2);
      titleSim = computeMinHashSimilarity(sig1, sig2);
    } else {
      titleSim = computeJaccardSimilarity(fp1, fp2);
    }
  }

  // Content similarity
  const content1 = (exp1.content || '').toLowerCase().trim();
  const content2 = (exp2.content || '').toLowerCase().trim();
  let contentSim = 0;

  if (content1 === content2 && content1.length > 0) {
    contentSim = 1.0;
  } else {
    const fp1 = computeNGramFingerprint(content1, ngramSize);
    const fp2 = computeNGramFingerprint(content2, ngramSize);

    if (fp1.size === 0 && fp2.size === 0) {
      contentSim = content1 === content2 ? 1.0 : 0.0;
    } else if (fp1.size === 0 || fp2.size === 0) {
      contentSim = 0.0;
    } else if (useMinHash && fp1.size > 100) {
      // Only use MinHash for large fingerprints
      const sig1 = computeMinHash(fp1);
      const sig2 = computeMinHash(fp2);
      contentSim = computeMinHashSimilarity(sig1, sig2);
    } else {
      contentSim = computeJaccardSimilarity(fp1, fp2);
    }
  }

  return titleSim * titleWeight + contentSim * contentWeight;
}

/**
 * Experience deduplication and clustering engine.
 * Groups similar experiences and identifies potential duplicates.
 */
class ExperienceDeduplicator {
  constructor(options = {}) {
    this.options = {
      similarityThreshold: 0.75,    // Threshold for considering experiences as duplicates
      clusterThreshold: 0.50,       // Threshold for clustering (looser than duplicates)
      useMinHash: true,             // Use MinHash approximation for large datasets
      ngramSize: 3,                 // N-gram size for fingerprinting
      maxComparisons: 10000,        // Max pairwise comparisons to prevent O(n²) explosion
      ...options,
    };

    // Cache for computed signatures
    this._signatureCache = new Map();
  }

  /**
   * Groups experiences into clusters based on content similarity.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of clusters, each containing similar experiences
   */
  cluster(experiences) {
    if (!experiences || experiences.length === 0) return [];

    const clusters = [];
    const visited = new Set();

    // Pre-compute signatures for caching
    for (const exp of experiences) {
      if (!this._signatureCache.has(exp.id)) {
        this._signatureCache.set(exp.id, this._computeSignature(exp));
      }
    }

    for (let i = 0; i < experiences.length; i++) {
      const exp1 = experiences[i];
      if (visited.has(exp1.id)) continue;

      const cluster = {
        id: `cluster-${i}`,
        representative: exp1,
        members: [exp1],
        avgSimilarity: 1.0,
        type: exp1.type,
        category: exp1.category,
      };

      visited.add(exp1.id);

      for (let j = i + 1; j < experiences.length; j++) {
        const exp2 = experiences[j];
        if (visited.has(exp2.id)) continue;

        // Quick type/category filtering
        if (exp1.type !== exp2.type) continue;
        if (exp1.category !== exp2.category) continue;

        const similarity = this._computeCachedSimilarity(exp1, exp2);

        if (similarity >= this.options.clusterThreshold) {
          cluster.members.push(exp2);
          visited.add(exp2.id);
        }
      }

      if (cluster.members.length > 1) {
        cluster.avgSimilarity = this._computeAvgSimilarity(cluster.members);
      }

      clusters.push(cluster);
    }

    return clusters.sort((a, b) => b.members.length - a.members.length);
  }

  /**
   * Finds duplicate experiences based on high similarity threshold.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of duplicate groups
   */
  findDuplicates(experiences) {
    if (!experiences || experiences.length === 0) return [];

    const duplicates = [];
    const processed = new Set();

    for (let i = 0; i < experiences.length; i++) {
      const exp1 = experiences[i];
      if (processed.has(exp1.id)) continue;

      const group = {
        primary: exp1,
        duplicates: [],
        similarityScores: [],
      };

      for (let j = i + 1; j < experiences.length; j++) {
        const exp2 = experiences[j];
        if (processed.has(exp2.id)) continue;

        const similarity = computeExperienceSimilarity(exp1, exp2, this.options);

        if (similarity >= this.options.similarityThreshold) {
          group.duplicates.push(exp2);
          group.similarityScores.push({ id: exp2.id, score: similarity });
          processed.add(exp2.id);
        }
      }

      if (group.duplicates.length > 0) {
        duplicates.push(group);
        processed.add(exp1.id);
      }
    }

    return duplicates;
  }

  /**
   * Suggests merge candidates for similar experiences.
   * Lower threshold than duplicates, includes rationale.
   *
   * @param {object[]} experiences - Array of experience objects
   * @returns {object[]} Array of merge suggestions
   */
  suggestMerges(experiences) {
    const clusters = this.cluster(experiences);
    const suggestions = [];

    for (const cluster of clusters) {
      if (cluster.members.length < 2) continue;

      // Only suggest merges for high-similarity clusters
      if (cluster.avgSimilarity < 0.6) continue;

      const suggestion = {
        clusterId: cluster.id,
        type: cluster.type,
        category: cluster.category,
        memberCount: cluster.members.length,
        avgSimilarity: cluster.avgSimilarity,
        representative: {
          id: cluster.representative.id,
          title: cluster.representative.title,
        },
        mergeCandidates: cluster.members.slice(1).map(m => ({
          id: m.id,
          title: m.title,
          similarity: this._computeCachedSimilarity(cluster.representative, m),
        })),
        rationale: this._generateRationale(cluster),
      };

      suggestions.push(suggestion);
    }

    return suggestions.sort((a, b) => b.avgSimilarity - a.avgSimilarity);
  }

  /**
   * Clears the internal signature cache.
   */
  clearCache() {
    this._signatureCache.clear();
  }

  /**
   * Gets cache statistics.
   *
   * @returns {object} Cache stats
   */
  getCacheStats() {
    return {
      cacheSize: this._signatureCache.size,
    };
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  _computeSignature(exp) {
    const text = `${exp.title || ''} ${exp.content || ''}`.toLowerCase();
    const fingerprint = computeNGramFingerprint(text, this.options.ngramSize);

    return {
      fingerprint,
      minHash: this.options.useMinHash ? computeMinHash(fingerprint) : null,
      length: text.length,
    };
  }

  _computeCachedSimilarity(exp1, exp2) {
    const sig1 = this._signatureCache.get(exp1.id);
    const sig2 = this._signatureCache.get(exp2.id);

    if (!sig1 || !sig2) {
      return computeExperienceSimilarity(exp1, exp2, this.options);
    }

    if (this.options.useMinHash && sig1.minHash && sig2.minHash) {
      const titleSim = computeMinHashSimilarity(
        computeMinHash(computeNGramFingerprint((exp1.title || '').toLowerCase())),
        computeMinHash(computeNGramFingerprint((exp2.title || '').toLowerCase()))
      );
      const contentSim = computeMinHashSimilarity(sig1.minHash, sig2.minHash);
      return titleSim * 0.3 + contentSim * 0.7;
    }

    return computeJaccardSimilarity(sig1.fingerprint, sig2.fingerprint);
  }

  _computeAvgSimilarity(members) {
    if (members.length <= 1) return 1.0;

    let totalSim = 0;
    let count = 0;

    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        totalSim += this._computeCachedSimilarity(members[i], members[j]);
        count++;
      }
    }

    return count > 0 ? totalSim / count : 1.0;
  }

  _generateRationale(cluster) {
    const parts = [];

    if (cluster.avgSimilarity >= 0.85) {
      parts.push('内容高度相似，可能是重复记录');
    } else if (cluster.avgSimilarity >= 0.7) {
      parts.push('内容相似度较高，建议合并');
    } else {
      parts.push('主题相关，可以考虑合并');
    }

    if (cluster.members.length > 2) {
      parts.push(`该主题下有 ${cluster.members.length} 条相关经验`);
    }

    return parts.join('；');
  }
}

// ─── Module exports ───────────────────────────────────────────────────────

module.exports = {
  extractKeywords,
  ExperienceQueryMixin,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  // Multilingual exports
  MULTILANG_STOPWORDS,
  detectLanguage,
  tokenizeByLanguage,
  // TF-IDF exports (P4b enhancement)
  computeIdfValues,
  // Similarity clustering exports
  ExperienceDeduplicator,
  computeNGramFingerprint,
  computeMinHash,
  computeMinHashSimilarity,
  computeJaccardSimilarity,
  computeExperienceSimilarity,
};
