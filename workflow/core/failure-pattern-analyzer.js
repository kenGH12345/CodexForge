/**
 * Failure Pattern Analyzer
 *
 * EvoSkill 洞察吸收: 失败模式 → Skill 建议
 *
 * 核心功能：
 * 1. 从 workflow-introspection-collector 提取失败事件
 * 2. 聚类相似失败（避免重复处理）
 * 3. 生成 Skill 建议（可选 LLM 驱动）
 * 4. 评估现有 Skill 对特定模式的覆盖度
 *
 * 设计约束：
 * - 基于现有 introspectionCollector 数据，零额外存储开销
 * - 失败样本至少出现 2 次才触发 Skill 建议生成
 * - LLM 调用非必须（可选开启），单批次最多 3 个建议，控制成本
 */

'use strict';

const { introspectionCollector } = require('./workflow-introspection-collector');
const { RootCause } = require('./complaint-wall');

// ─── Failure Pattern Signature ────────────────────────────────────────────────

/**
 * Failure Pattern Signature
 *
 * 从失败事件中提取结构化 signature，用于：
 * 1. 聚类相似失败（避免重复处理）
 * 2. 匹配/创建针对性 Skill
 * 3. 评估 Skill 有效性
 */
class FailurePatternSignature {
  /**
   * @param {object} params
   * @param {string} params.failureType - 失败类型：syntax|type|test|runtime|timeout|compile|unknown
   * @param {string} params.stage - 失败发生的阶段：ANALYSE|ARCHITECT|PLAN|DEVELOP|TEST
   * @param {string} params.rootCause - 根因分类 (RootCause)
   * @param {string[]} params.errorSignatures - 错误信息特征（关键词提取）
   * @param {string[]} params.contextFingerprint - 上下文指纹（file types, tech stack）
   */
  constructor({ failureType, stage, rootCause, errorSignatures, contextFingerprint }) {
    this.failureType = failureType;
    this.stage = stage;
    this.rootCause = rootCause;
    this.errorSignatures = errorSignatures;
    this.contextFingerprint = contextFingerprint || [];
    this.compoundKey = this._generateCompoundKey();
    this.hash = this._hash();
  }

  _generateCompoundKey() {
    const sigPart = this.errorSignatures.slice(0, 2).join('|').slice(0, 50);
    return `${this.failureType}:${this.stage}:${this.rootCause}:${sigPart}`;
  }

  _hash() {
    // Simple hash for quick lookup
    let h = 0;
    const str = this.compoundKey;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36).slice(0, 8);
  }
}

// ─── Failure Pattern Analyzer ─────────────────────────────────────────────────

class FailurePatternAnalyzer {
  /**
   * @param {object} options
   * @param {Function} [options.cheapLlmCall] - 廉价 LLM 调用（如 GPT-4o-mini），可选
   * @param {number} [options.minOccurrenceThreshold=2] - 触发建议的最小出现次数
   * @param {number} [options.analysisCooldownMs=3600000] - 分析冷却时间（默认1小时）
   * @param {number} [options.patternExpiryMs=604800000] - 模式过期时间（默认7天）
   */
  constructor(options = {}) {
    this._llmCall = options.cheapLlmCall || null;
    this._minOccurrenceThreshold = options.minOccurrenceThreshold || 2;
    this._analysisCooldownMs = options.analysisCooldownMs || 60 * 60 * 1000; // 1h
    this._patternExpiryMs = options.patternExpiryMs || 7 * 24 * 60 * 60 * 1000; // 7d

    // 内存中的模式索引: compoundKey -> PatternStats
    this._patternIndex = new Map();
    this._lastAnalysisTs = 0;
    this._analysisCount = 0;
  }

  /**
   * 分析近期失败事件，提取模式并生成 Skill 建议
   *
   * @returns {Promise<{ patterns: PatternStats[], skillProposals: SkillProposal[] }>}
   */
  async analyzeRecentFailures() {
    // Rate limiting: 基于冷却时间
    const now = Date.now();
    if (now - this._lastAnalysisTs < this._analysisCooldownMs) {
      return { patterns: [], skillProposals: [], skipped: 'cooldown' };
    }
    this._lastAnalysisTs = now;
    this._analysisCount++;

    // 1. 从 introspectionCollector 获取失败事件
    const failedEntries = this._collectFailedEntries();

    // 2. 提取 signatures 并聚类
    const newSignatures = [];
    for (const entry of failedEntries) {
      const sig = this._extractSignature(entry);
      if (sig) {
        this._updatePatternIndex(sig);
        newSignatures.push(sig);
      }
    }

    // 3. 筛选高频且活跃的模式
    const frequentPatterns = this._getFrequentPatterns();

    // 4. 生成 Skill 建议（仅当配置了 LLM 时）
    const skillProposals = [];
    if (this._llmCall && frequentPatterns.length > 0) {
      // 每批最多 3 个，控制成本和延迟
      const candidates = frequentPatterns
        .filter(p => !p.skillGenerated) // 未生成过 Skill 的模式
        .slice(0, 3);

      for (const pattern of candidates) {
        const proposal = await this._generateSkillProposal(pattern);
        if (proposal) {
          skillProposals.push(proposal);
          pattern.skillGenerated = true;
          pattern.skillProposal = proposal;
        }
      }
    }

    return {
      patterns: frequentPatterns,
      skillProposals,
      stats: {
        totalPatterns: this._patternIndex.size,
        newSignatures: newSignatures.length,
        frequentPatterns: frequentPatterns.length,
        proposalsGenerated: skillProposals.length,
        analysisCount: this._analysisCount,
      },
    };
  }

  /**
   * 收集失败相关的事件条目
   * @private
   */
  _collectFailedEntries() {
    const entries = [];

    // 从 introspectionCollector 获取失败事件
    const failed = introspectionCollector.getByAction('failed');
    entries.push(...failed);

    // 获取高严重性扫描/审计问题
    const scanIssues = introspectionCollector.getByModule('Scan')
      .filter(e => {
        const sev = e.context?.severity;
        return sev === 'high' || sev === 'critical' || sev === 'error';
      });
    entries.push(...scanIssues);

    // 获取 Framework 分析失败
    const frameworkFails = introspectionCollector.getByModule('Framework')
      .filter(e => e.action === 'failed' || e.context?.error);
    entries.push(...frameworkFails);

    // 去重：基于 entry id
    const seen = new Set();
    return entries.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }

  /**
   * 从单个事件提取 signature
   * @private
   */
  _extractSignature(entry) {
    const ctx = entry.context || {};

    // 推断失败类型
    const failureType = this._inferFailureType(ctx);

    // 推断阶段
    const stage = entry.stage || ctx.stage || 'unknown';

    // 错误特征提取
    const errorSignatures = this._extractErrorKeywords(
      ctx.errorMessage || ctx.message || ctx.error,
      ctx.stackTrace || ctx.stack
    );

    // 上下文指纹
    const contextFingerprint = [
      ctx.fileType || ctx.language || 'unknown',
      ctx.techStack || ctx.framework || 'unknown',
      ctx.component || ctx.module || 'unknown',
    ];

    // 根因推断（启发式）
    const rootCause = this._inferRootCause(ctx, failureType, stage, errorSignatures);

    return new FailurePatternSignature({
      failureType,
      stage,
      rootCause,
      errorSignatures,
      contextFingerprint,
    });
  }

  /**
   * 推断失败类型
   * @private
   */
  _inferFailureType(ctx) {
    const msg = String(ctx.errorMessage || ctx.message || ctx.error || '').toLowerCase();
    const errorType = ctx.errorType || ctx.type || '';

    if (msg.includes('syntax') || msg.includes('unexpected token') || msg.includes('parse error')) {
      return 'syntax';
    }
    if (msg.includes('cannot find module') || msg.includes('module not found') || msg.includes('import') || msg.includes('require')) {
      return 'import';
    }
    if (msg.includes('type ') || msg.includes('typeerror') || msg.includes('cannot read propert')) {
      return 'type';
    }
    if (msg.includes('test') || msg.includes('assert') || msg.includes('expect') || msg.includes('failed')) {
      return 'test';
    }
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('timed out')) {
      return 'timeout';
    }
    if (msg.includes('memory') || msg.includes('heap') || msg.includes('out of memory')) {
      return 'runtime';
    }
    if (msg.includes('compile') || msg.includes('build') || msg.includes('webpack') || msg.includes('bundler')) {
      return 'compile';
    }

    return 'unknown';
  }

  /**
   * 提取错误关键词
   * @private
   */
  _extractErrorKeywords(errorMessage, stackTrace) {
    const keywords = [];
    const text = `${errorMessage || ''} ${stackTrace || ''}`.toLowerCase();

    // 常见错误模式匹配
    const patterns = [
      /cannot find (?:module|name|variable|file)/i,
      /unexpected (?:token|identifier|end|character)/i,
      /missing (?:semicolon|bracket|parenthesis|brace)/i,
      /type (?:error|mismatch|inference|undefined)/i,
      /undefined is not a function/i,
      /cannot read propert(?:y|ies) of (?:null|undefined)/i,
      /failed to (?:load|resolve|import|compile|build)/i,
      /(?:timeout|etimedout|timed out)/i,
      /assertion (?:failed|error)/i,
      /expected.*but.*received/i,
      /(?:is|are) not defined/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && !keywords.includes(match[0])) {
        keywords.push(match[0].slice(0, 50));
      }
    }

    // 如果没有匹配到模式，取错误消息的前3个词
    if (keywords.length === 0 && errorMessage) {
      const words = String(errorMessage).split(/\s+/).slice(0, 3);
      if (words.length > 0) {
        keywords.push(words.join(' '));
      }
    }

    return keywords.slice(0, 5); // 最多5个
  }

  /**
   * 启发式推断根因
   * @private
   */
  _inferRootCause(ctx, failureType, stage, errorSignatures) {
    // 显式指定的根因优先
    if (ctx.rootCause && Object.values(RootCause).includes(ctx.rootCause)) {
      return ctx.rootCause;
    }

    // 启发式推断
    if (failureType === 'syntax' && stage === 'DEVELOP') {
      return RootCause.PATTERN_WRONG;
    }
    if (failureType === 'type' || failureType === 'import') {
      return RootCause.KNOWLEDGE_GAP;
    }
    if (stage === 'TEST' && failureType === 'test') {
      return RootCause.PROCESS_SKIP;
    }
    if (failureType === 'timeout' || failureType === 'runtime') {
      return RootCause.PROCESS_SKIP;
    }

    // 默认
    return RootCause.SPEC_MISSING;
  }

  /**
   * 更新模式索引
   * @private
   */
  _updatePatternIndex(signature) {
    const existing = this._patternIndex.get(signature.compoundKey);
    const now = Date.now();

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      existing.signatures.push(signature);
      // 保留最近10个 signatures
      if (existing.signatures.length > 10) {
        existing.signatures.shift();
      }
    } else {
      this._patternIndex.set(signature.compoundKey, {
        key: signature.compoundKey,
        hash: signature.hash,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        signatures: [signature],
        skillGenerated: false,
        skillProposal: null,
      });
    }
  }

  /**
   * 获取高频且活跃的模式
   * @private
   */
  _getFrequentPatterns() {
    const now = Date.now();
    return Array.from(this._patternIndex.values())
      .filter(p => p.count >= this._minOccurrenceThreshold)
      .filter(p => now - p.lastSeen < this._patternExpiryMs)
      .sort((a, b) => b.count - a.count); // 按频率排序
  }

  /**
   * 使用 LLM 生成 Skill 建议
   * @private
   */
  async _generateSkillProposal(pattern) {
    if (!this._llmCall) return null;

    const firstSig = pattern.signatures[0];

    const prompt = this._buildSkillProposalPrompt(pattern, firstSig);

    try {
      const result = await this._llmCall(prompt);
      const parsed = this._parseProposalResponse(result);

      if (!parsed || !parsed.recommended) {
        console.log(`[FailurePatternAnalyzer] Pattern ${pattern.hash} rejected: ${parsed?.reason || 'no recommendation'}`);
        return null;
      }

      return {
        patternKey: pattern.key,
        patternHash: pattern.hash,
        occurrenceCount: pattern.count,
        confidence: this._calculateConfidence(pattern),
        ...parsed,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      console.warn(`[FailurePatternAnalyzer] Failed to generate proposal: ${err.message}`);
      return null;
    }
  }

  /**
   * 构建 Skill 建议 Prompt
   * @private
   */
  _buildSkillProposalPrompt(pattern, signature) {
    return `You are a workflow skill designer. Based on the following failure pattern, propose a concise skill addition.

## Failure Pattern
- Type: ${signature.failureType}
- Stage: ${signature.stage}
- Root Cause: ${signature.rootCause}
- Occurrence Count: ${pattern.count}
- Error Signatures: ${signature.errorSignatures.join(', ')}
- Context: ${signature.contextFingerprint.join(', ')}

## Design Principles
1. Keep rules concise and actionable (2-4 rules)
2. Focus on prevention, not just detection
3. Use specific technical terms from error signatures
4. Consider the workflow stage context

## Output Format
Return a JSON object:
{
  "recommended": true|false,
  "reason": "Brief explanation if not recommended",
  "skillName": "pattern-specific-name",
  "description": "One-line description of what this skill addresses",
  "rules": [
    "Specific actionable rule 1",
    "Specific actionable rule 2"
  ],
  "applicableStages": ["DEVELOP", "TEST"],
  "estimatedImpact": "high|medium|low"
}

Only respond with valid JSON.`;
  }

  /**
   * 解析 Proposal 响应
   * @private
   */
  _parseProposalResponse(result) {
    try {
      // 提取 JSON 块
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : result;
      return JSON.parse(jsonStr.trim());
    } catch (err) {
      console.warn(`[FailurePatternAnalyzer] Failed to parse LLM response: ${err.message}`);
      return null;
    }
  }

  /**
   * 计算建议置信度
   * @private
   */
  _calculateConfidence(pattern) {
    // 基于出现次数和最近活跃度计算置信度
    const frequencyScore = Math.min(pattern.count / 5, 1); // 5次达到满分
    const recencyScore = Math.max(0, 1 - (Date.now() - pattern.lastSeen) / this._patternExpiryMs);
    return Math.round((frequencyScore * 0.6 + recencyScore * 0.4) * 100);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * 获取当前高频模式统计
   */
  getPatternStats() {
    const patterns = Array.from(this._patternIndex.values());
    return {
      totalPatterns: patterns.length,
      frequentPatterns: patterns
        .filter(p => p.count >= this._minOccurrenceThreshold)
        .map(p => ({
          key: p.key,
          hash: p.hash,
          count: p.count,
          lastSeen: new Date(p.lastSeen).toISOString(),
          skillGenerated: p.skillGenerated,
        })),
    };
  }

  /**
   * 检查特定失败模式是否已被覆盖
   */
  isPatternCovered(failureType, stage, errorKeyword) {
    for (const [, pattern] of this._patternIndex) {
      const sig = pattern.signatures[0];
      if (sig.failureType === failureType &&
          sig.stage === stage &&
          pattern.skillGenerated &&
          sig.errorSignatures.some(s => s.includes(errorKeyword))) {
        return true;
      }
    }
    return false;
  }

  /**
   * 导出模式数据用于技能演化
   */
  exportPatterns() {
    return {
      timestamp: new Date().toISOString(),
      patterns: Array.from(this._patternIndex.values()).map(p => ({
        key: p.key,
        hash: p.hash,
        count: p.count,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        sample: {
          failureType: p.signatures[0]?.failureType,
          stage: p.signatures[0]?.stage,
          rootCause: p.signatures[0]?.rootCause,
          errorSignatures: p.signatures[0]?.errorSignatures,
        },
        skillProposal: p.skillProposal,
      })),
    };
  }

  /**
   * 重置分析器状态
   */
  reset() {
    this._patternIndex.clear();
    this._lastAnalysisTs = 0;
    this._analysisCount = 0;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const failurePatternAnalyzer = new FailurePatternAnalyzer();

module.exports = {
  FailurePatternAnalyzer,
  failurePatternAnalyzer,
  FailurePatternSignature,
};
