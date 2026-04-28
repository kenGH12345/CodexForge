const UnifiedSkillComposer = require('./unified-skill-composer');

class SkillHealthScorer {
  constructor(opts = {}) {
    // Thresholds for semantic similarity matching
    this.similarityThreshold = opts.similarityThreshold || 0.3;
    this.maxLevenshteinDist = opts.maxLevenshteinDist || 3;
  }

  score(skillMarkdown, requiredSections) {
    if (!skillMarkdown || typeof skillMarkdown !== 'string') {
      return this._emptyScore();
    }

    const sections = requiredSections || ['Conventions', 'Architecture', 'Components'];

    const coverageScore = this._coverage(skillMarkdown, sections);
    const densityScore = this._density(skillMarkdown, sections);
    const completenessScore = this._yamlCompleteness(skillMarkdown);
    const semanticScore = this._semanticSimilarity(skillMarkdown, sections);

    const weights = { coverage: 0.35, density: 0.25, completeness: 0.25, semantic: 0.15 };
    const overall = coverageScore * weights.coverage
                  + densityScore * weights.density
                  + completenessScore * weights.completeness
                  + semanticScore * weights.semantic;

    const warnings = [];
    if (coverageScore < 0.5) warnings.push('Low section coverage: missing one or more required sections');
    if (densityScore < 0.3) warnings.push('Low token density: sections may be placeholders or overly brief');
    if (completenessScore < 0.7) warnings.push('Incomplete YAML frontmatter: missing required metadata fields');
    if (semanticScore < 0.3) warnings.push('Low semantic match: section names differ significantly from expected keywords');

    return {
      coverage: parseFloat(coverageScore.toFixed(2)),
      density: parseFloat(densityScore.toFixed(2)),
      completeness: parseFloat(completenessScore.toFixed(2)),
      semantic: parseFloat(semanticScore.toFixed(2)),
      overall: parseFloat(overall.toFixed(2)),
      grade: this._grade(overall),
      warnings,
      matchedSections: this._extractMatchedSections(skillMarkdown, sections)
    };
  }

  _emptyScore() {
    return { coverage: 0, density: 0, completeness: 0, semantic: 0, overall: 0, grade: 'D', warnings: ['Empty or invalid input'], matchedSections: [] };
  }

  // ---------------------------------------------------------------------------
  // Coverage: supports numbered headings like "1. Architecture Understanding"
  // ---------------------------------------------------------------------------
  _coverage(markdown, sections) {
    const found = sections.filter(sec => {
      const content = this._fuzzyExtractSection(markdown, sec);
      return content && content.trim().length > 30;
    });
    return found.length / sections.length;
  }

  // ---------------------------------------------------------------------------
  // Density: same as before, but uses fuzzy extractor
  // ---------------------------------------------------------------------------
  _density(markdown, sections) {
    let totalTokens = 0;
    let sectionCount = 0;
    for (const sec of sections) {
      const content = this._fuzzyExtractSection(markdown, sec);
      if (content) {
        totalTokens += this._estimateTokens(content);
        sectionCount++;
      }
    }
    if (sectionCount === 0) return 0;
    const avgTokens = totalTokens / sectionCount;
    if (avgTokens > 600) return 1.0;
    if (avgTokens > 200) return avgTokens / 600;
    return avgTokens / 200 * 0.3;
  }

  _estimateTokens(text) {
    return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
  }

  // ---------------------------------------------------------------------------
  // YAML completeness: widened required fields for AI-generated skills
  // ---------------------------------------------------------------------------
  _yamlCompleteness(markdown) {
    const meta = UnifiedSkillComposer.parseFrontmatter(markdown);
    const requiredFields = ['name', 'version'];
    const bonusFields = ['project', 'type', 'description', 'triggers', 'tags'];
    const presentBase = requiredFields.filter(f => meta[f] !== undefined && String(meta[f]).trim().length > 0);
    const presentBonus = bonusFields.filter(f => meta[f] !== undefined && String(meta[f]).trim().length > 0);
    // Base score from required fields + bonus from extra metadata
    const baseScore = presentBase.length / requiredFields.length;
    const bonusScore = Math.min(presentBonus.length * 0.1, 0.3); // max 0.3 bonus for extra metadata
    return Math.min(baseScore + bonusScore, 1.0);
  }

  // ---------------------------------------------------------------------------
  // Semantic similarity: how well section names match expected keywords
  // ---------------------------------------------------------------------------
  _semanticSimilarity(markdown, sections) {
    const headings = this._extractAllHeadings(markdown);
    if (headings.length === 0 || sections.length === 0) return 0;

    let totalSim = 0;
    let matches = 0;
    for (const expected of sections) {
      let bestSim = 0;
      for (const actual of headings) {
        const sim = this._headingSimilarity(expected, actual);
        if (sim > bestSim) bestSim = sim;
      }
      if (bestSim > this.similarityThreshold) {
        totalSim += bestSim;
        matches++;
      }
    }
    return matches === 0 ? 0 : totalSim / sections.length;
  }

  // ---------------------------------------------------------------------------
  // Fuzzy section extractor: matches "Architecture" to "## 1. Architecture Understanding"
  // ---------------------------------------------------------------------------
  _fuzzyExtractSection(markdown, sectionName) {
    const lines = markdown.split(/\r?\n/);
    let inSection = false;
    let buffer = [];
    const normalizedExpected = this._normalizeHeading(sectionName);

    for (const line of lines) {
      // Only H2 headings are section boundaries; H3/H4 are sub-sections
      const heading = line.match(/^##\s+(.+)$/);
      if (heading) {
        if (inSection) break;
        const currentNameRaw = heading[1].trim();
        const currentName = this._normalizeHeading(currentNameRaw);
        if (
          currentName === normalizedExpected ||
          currentName.includes(normalizedExpected) ||
          normalizedExpected.includes(currentName) ||
          this._headingSimilarity(sectionName, currentNameRaw) > 0.35
        ) {
          inSection = true;
        }
        continue;
      }
      if (inSection) buffer.push(line);
    }
    return buffer.join('\n').trim();
  }

  // ---------------------------------------------------------------------------
  // Heading similarity: combines Jaccard + Levenshtein ratio
  // ---------------------------------------------------------------------------
  _headingSimilarity(s1, s2) {
    const a = this._normalizeHeading(s1);
    const b = this._normalizeHeading(s2);
    if (a === b) return 1.0;

    const jaccard = this._bigramJaccard(a, b);
    const levRatio = this._levenshteinRatio(a, b);
    // Weighted blend: Jaccard catches word overlap, Levenshtein catches typos/variants
    return jaccard * 0.6 + levRatio * 0.4;
  }

  _normalizeHeading(str) {
    return str.toLowerCase().replace(/^\d+\.?\s*/, '').replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, ' ');
  }

  _extractAllHeadings(markdown) {
    const matches = markdown.match(/^##+\s+(.+)$/gm);
    if (!matches) return [];
    return matches.map(h => h.replace(/^##+\s+/, '').trim());
  }

  _extractMatchedSections(markdown, expectedSections) {
    const allHeadings = this._extractAllHeadings(markdown);
    // Prefer H2 headings for section mapping
    const h2Headings = allHeadings.filter(h => {
      const line = markdown.split(/\r?\n/).find(l => l.includes(h) && l.match(/^##\s+/));
      return !!line;
    });
    const result = [];
    for (const expected of expectedSections) {
      let bestMatch = null;
      let bestSim = 0;
      for (const actual of h2Headings.length > 0 ? h2Headings : allHeadings) {
        const sim = this._headingSimilarity(expected, actual);
        if (sim > bestSim) {
          bestSim = sim;
          bestMatch = actual;
        }
      }
      result.push({
        expected,
        matched: bestSim > this.similarityThreshold ? bestMatch : null,
        similarity: parseFloat(bestSim.toFixed(2))
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Bigram Jaccard similarity (lightweight, no external deps)
  // ---------------------------------------------------------------------------
  _bigrams(str) {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) {
      set.add(str.substring(i, i + 2));
    }
    return set;
  }

  _bigramJaccard(s1, s2) {
    const bg1 = this._bigrams(s1);
    const bg2 = this._bigrams(s2);
    if (bg1.size === 0 && bg2.size === 0) return 1.0;
    if (bg1.size === 0 || bg2.size === 0) return 0.0;
    let intersection = 0;
    for (const bg of bg1) {
      if (bg2.has(bg)) intersection++;
    }
    return intersection / (bg1.size + bg2.size - intersection);
  }

  // ---------------------------------------------------------------------------
  // Levenshtein distance → normalized ratio
  // ---------------------------------------------------------------------------
  _levenshteinDistance(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        matrix[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
    return matrix[b.length][a.length];
  }

  _levenshteinRatio(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    const dist = this._levenshteinDistance(a, b);
    return 1 - dist / maxLen;
  }

  _grade(overall) {
    if (overall >= 0.85) return 'A';
    if (overall >= 0.70) return 'B';
    if (overall >= 0.50) return 'C';
    return 'D';
  }
}

module.exports = SkillHealthScorer;
