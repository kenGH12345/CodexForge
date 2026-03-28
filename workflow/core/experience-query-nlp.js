/**
 * Experience Query NLP – Multilingual keyword extraction, language detection, tokenization
 *
 * Extracted from experience-query.js (ADR-33 Phase 4) to enable independent
 * evolution of NLP algorithms, stopword tables, and language support.
 *
 * This module provides:
 *   - STOPWORDS, SHORT_WORD_WHITELIST, MULTILANG_STOPWORDS, CODE_KEYWORDS
 *   - detectLanguage()        – Unicode-range language detection
 *   - tokenizeByLanguage()    – Language-aware tokenization
 *   - extractKeywords()       – TF-IDF keyword extraction
 *   - computeIdfValues()      – Corpus-level IDF computation
 *
 * @module experience-query-nlp
 */

'use strict';

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

    if (code >= 0x4e00 && code <= 0x9fff) {
      charCounts.zh++;
    } else if ((code >= 0x3040 && code <= 0x309f) || (code >= 0x30a0 && code <= 0x30ff)) {
      charCounts.ja++;
    } else if ((code >= 0xac00 && code <= 0xd7af) || (code >= 0x1100 && code <= 0x11ff)) {
      charCounts.ko++;
    } else if ((code >= 0x0041 && code <= 0x005a) || (code >= 0x0061 && code <= 0x007a)) {
      charCounts.en++;
    } else {
      charCounts.other++;
    }
  }

  const total = charCounts.zh + charCounts.ja + charCounts.ko + charCounts.en;
  if (total === 0) return 'en';

  const threshold = 0.3;
  const sorted = Object.entries(charCounts)
    .filter(([k]) => k !== 'other')
    .sort((a, b) => b[1] - a[1]);

  const [primary, count] = sorted[0];
  if (count / total >= threshold) {
    return primary;
  }

  const significant = sorted.filter(([, v]) => v / total >= 0.15).length;
  return significant > 1 ? 'mixed' : primary;
}

/**
 * Tokenizes text based on detected language.
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
      return tokenizeCJK(text);
    case 'ko':
      return tokenizeKorean(text);
    case 'mixed':
      return tokenizeMixed(text);
    case 'en':
    default:
      return text.toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
  }
}

/**
 * Tokenizes CJK (Chinese/Japanese) text.
 */
function tokenizeCJK(text) {
  const tokens = [];

  const cjkMatches = text.match(/[\u4e00-\u9fff]{2,8}/g);
  if (cjkMatches) {
    tokens.push(...cjkMatches);
  }

  const jaMatches = text.match(/[\u3040-\u309f\u30a0-\u30ff]{2,8}/g);
  if (jaMatches) {
    tokens.push(...jaMatches);
  }

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

  const koMatches = text.match(/[\uac00-\ud7af]{2,8}/g);
  if (koMatches) {
    tokens.push(...koMatches);
  }

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

  const detectedLang = forcedLang || (detectLang ? detectLanguage(text) : 'en');

  let stopwords;
  if (detectedLang === 'mixed') {
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

  const tokens = tokenizeByLanguage(text, detectedLang);

  const termFreq = new Map();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const isCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(token);
    const minLen = isCJK ? 2 : 3;

    if (lower.length < minLen || stopwords.has(lower)) continue;
    termFreq.set(lower, (termFreq.get(lower) || 0) + 1);
  }

  const totalTerms = tokens.length;
  const scored = [];

  for (const [term, freq] of termFreq) {
    const tf = freq / totalTerms;
    const idf = idfCache?.get(term) ?? Math.log(100 / (freq + 1));
    let score = tf * idf;

    if (CODE_KEYWORDS.has(term)) {
      score *= 1.5;
    }

    score *= (1 + term.length / 20);
    scored.push({ term, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const result = [];

  for (const { term } of scored) {
    if (seen.has(term)) continue;
    seen.add(term);

    const original = tokens.find(t => t.toLowerCase() === term) || term;
    result.push(original);

    if (result.length >= maxKeywords) break;
  }

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
 *
 * @param {string[]} documents - Array of document texts
 * @returns {Map<string, number>} IDF values for each term
 */
function computeIdfValues(documents) {
  const docFreq = new Map();
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
    idf.set(term, Math.log(totalDocs / freq));
  }

  return idf;
}

// ─── Module exports ───────────────────────────────────────────────────────

module.exports = {
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  MULTILANG_STOPWORDS,
  CODE_KEYWORDS,
  detectLanguage,
  tokenizeByLanguage,
  extractKeywords,
  computeIdfValues,
};
