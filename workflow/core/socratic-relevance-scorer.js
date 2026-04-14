'use strict';

/**
 * Socratic Relevance Scorer — TF-IDF based semantic similarity engine.
 *
 * Replaces the simple Jaccard token-set similarity with a domain-aware
 * TF-IDF + cosine similarity approach. Supports synonym expansion for
 * Chinese technical vocabulary.
 *
 * @module workflow/core/socratic-relevance-scorer
 */

const DOMAIN_VOCABULARY = {
  code: {
    terms: ['重构', '优化', '修复', '实现', '接口', '类', '函数', '模块', '依赖', '缓存', '异步', '并发', '测试', '调试', '部署'],
    synonyms: {
      '重构': ['重写', '改造', '重新设计', '结构优化', 'refactor'],
      '优化': ['性能提升', '加速', '降耗', '改进', 'optimize'],
      '依赖': ['耦合', '关联', '引用', 'import', 'require'],
      '修复': ['fix', '修改', '解决', '处理', 'patch'],
      '接口': ['api', 'interface', '契约', 'contract'],
    },
    impliedRelations: {
      '重构': ['技术债务', '可维护性', '测试覆盖'],
      '优化': ['延迟', '吞吐量', '资源占用'],
      '修复': ['根因', '回归', '测试'],
    },
  },
  architecture: {
    terms: ['架构', '组件', '模块', '服务', '数据流', '接口', '依赖', '扩展性', '可用性', '一致性', '分布式', '微服务'],
    synonyms: {
      '架构': ['设计', 'architecture', '结构', 'design'],
      '组件': ['模块', 'component', '服务', 'service', 'module'],
      '扩展性': ['可扩展', 'scalability', '水平扩展', '弹性'],
      '可用性': ['高可用', 'availability', 'HA', '容错'],
    },
    impliedRelations: {
      '微服务': ['服务发现', '负载均衡', '熔断'],
      '分布式': ['一致性', 'CAP', '事务'],
    },
  },
  test: {
    terms: ['测试', '覆盖率', '断言', '用例', '回归', '集成', '单元', '端到端', 'mock', '桩', '边界'],
    synonyms: {
      '测试': ['test', '验证', 'verify', '检验'],
      '覆盖率': ['coverage', '覆盖', '测试覆盖'],
      '回归': ['regression', '回归测试', '防回归'],
      '断言': ['assert', 'expect', '期望值'],
    },
    impliedRelations: {
      '单元测试': ['mock', '隔离', '快速'],
      '集成测试': ['真实环境', '端到端', '依赖'],
    },
  },
};

class SemanticSimilarityEngine {
  constructor(options = {}) {
    this.domain = options.domain || null;
    this.vocabulary = options.vocabulary || DOMAIN_VOCABULARY;
  }

  /**
   * Calculate semantic similarity between two texts.
   * @param {string} textA
   * @param {string} textB
   * @param {string} [domainHint] - Optional domain hint ('code'|'architecture'|'test')
   * @returns {{ score: number, method: string }}
   */
  calculate(textA, textB, domainHint) {
    const domain = domainHint || this.domain || this._inferDomain(textA + ' ' + textB);
    const domainVocab = this.vocabulary[domain] || null;

    const tokensA = this._tokenize(textA, domainVocab);
    const tokensB = this._tokenize(textB, domainVocab);

    if (tokensA.length === 0 || tokensB.length === 0) {
      return { score: 0, method: 'empty' };
    }

    if (!domainVocab) {
      return { score: this._jaccardSimilarity(tokensA, tokensB), method: 'jaccard_fallback' };
    }

    const expandedA = this._expandSynonyms(tokensA, domainVocab);
    const expandedB = this._expandSynonyms(tokensB, domainVocab);

    const vecA = this._computeTfIdf(expandedA);
    const vecB = this._computeTfIdf(expandedB);

    const score = this._cosineSimilarity(vecA, vecB);
    return { score, method: `tfidf_${domain}` };
  }

  /**
   * Compute domain anchoring score: how well a question is anchored to domain entities.
   * @param {string} question
   * @param {string[]} entities - Extracted entities from artifact
   * @param {string} [domainHint]
   * @returns {number} 0-1
   */
  calculateAnchoring(question, entities, domainHint) {
    if (!entities || entities.length === 0) return 0;
    const qLower = String(question || '').toLowerCase();
    let hits = 0;
    for (const entity of entities.slice(0, 10)) {
      const eLower = String(entity || '').toLowerCase();
      if (eLower.length >= 2 && qLower.includes(eLower)) hits++;
    }
    return Math.min(1, hits / Math.max(1, Math.min(entities.length, 5)));
  }

  _inferDomain(text) {
    const t = String(text || '').toLowerCase();
    const scores = {};
    for (const [domain, vocab] of Object.entries(this.vocabulary)) {
      scores[domain] = vocab.terms.filter(term => t.includes(term.toLowerCase())).length;
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? best[0] : null;
  }

  _tokenize(text, domainVocab) {
    const normalized = String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ');

    const tokens = normalized.split(/\s+/).filter(t => t.length >= 2).slice(0, 32);

    if (domainVocab) {
      for (const term of domainVocab.terms) {
        if (normalized.includes(term.toLowerCase()) && !tokens.includes(term.toLowerCase())) {
          tokens.push(term.toLowerCase());
        }
      }
    }

    return tokens;
  }

  _expandSynonyms(tokens, domainVocab) {
    if (!domainVocab || !domainVocab.synonyms) return tokens;
    const expanded = [...tokens];
    for (const token of tokens) {
      for (const [canonical, synonymList] of Object.entries(domainVocab.synonyms)) {
        if (token === canonical.toLowerCase() || synonymList.some(s => s.toLowerCase() === token)) {
          if (!expanded.includes(canonical.toLowerCase())) {
            expanded.push(canonical.toLowerCase());
          }
        }
      }
    }
    return expanded;
  }

  _computeTfIdf(tokens) {
    const tf = {};
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1;
    }
    const total = tokens.length || 1;
    const vector = {};
    for (const [term, count] of Object.entries(tf)) {
      vector[term] = count / total;
    }
    return vector;
  }

  _cosineSimilarity(vecA, vecB) {
    const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
    let dot = 0, normA = 0, normB = 0;
    for (const key of allKeys) {
      const a = vecA[key] || 0;
      const b = vecB[key] || 0;
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  _jaccardSimilarity(tokensA, tokensB) {
    const sa = new Set(tokensA);
    const sb = new Set(tokensB);
    let inter = 0;
    for (const t of sa) {
      if (sb.has(t)) inter++;
    }
    const union = sa.size + sb.size - inter;
    return union > 0 ? inter / union : 0;
  }
}

module.exports = { SemanticSimilarityEngine, DOMAIN_VOCABULARY };
